// `backend/shares.ts`'s K8 section (SP06 §4, RF-47) against the **real** host app: the admin's Nod
// assigns a credential to a role and seals a copy to every current member, and a member who joins
// the role later shows up in the missing-copy list until the admin's Nod seals their copy after the
// gate.
//
// The host is `host/app.ts` booted on a temp data dir and served by `Bun.serve`; the Nods are the
// real `backend/host-client.ts`, `backend/vault.ts`, `backend/keys.ts` and `backend/shares.ts`, over
// `backend/repo.ts` on an in-memory SQLite. Nothing is mocked where the product has a real seam —
// the host's guards, the scope rules of `host/repo.ts::createShares`, the sealed payload of
// `shared/seal.ts` and the accept path of K4 all run as shipped. The gate is the one seam a test
// supplies, and it is the only thing `test/assign.test.ts` records.
//
// The two acceptance criteria of issue #36 are the two tests below.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConnectedCatalog, type ConnectedCatalog } from '../backend/connected-catalog';
import { createKeys, type Keys } from '../backend/keys';
import { createHostClient, type HostClient, type HostConnection } from '../backend/host-client';
import { createHostAdmin, type HostAdmin } from '../backend/host-admin';
import { createRepo as createNodRepo, type Repo as NodRepo } from '../backend/repo';
import { createSession, type Session } from '../backend/session';
import { createShares, type Shares } from '../backend/shares';
import { createVault, type Vault } from '../backend/vault';
import { toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  type Device,
  type SaltResponse,
  type Snapshot,
  type TokenResponse,
} from '../shared/host-api';
import type { Entry, Id, SecretStore, VaultItem } from '../shared/types';
import { createApp } from '../host/app';
import { createRepo as createHostRepo, type Repo as HostRepo } from '../host/repo';
import { issueSetupCode } from '../host/cli/setup-code';
import { DEFAULT_PORT, type HostConfig } from '../host/config';
import { bootHost, type Host } from '../host/main';
import { GUILD_NAME_ENV } from '../host/routes/state';
import { memorySqlite } from './helpers/sqlite-bun';

const AT = '2026-10-17T10:00:00.000Z';
const PASSWORD = 'nod-password-123';
const ITERATIONS = 1_000;
const DEVICE: Device = { name: 'nod-assign-test', os: 'macos', appVersion: '0.3.5' };
const TOOL_ORIGIN = 'https://figma.example.test';
const KALENDAR_ORIGIN = 'https://kalendar.example.test';
const CREDENTIAL_USER = 'credentialuserzq7';
const CREDENTIAL_SECRET = 'secretvaluezq7';

/** The reason `backend/shares.ts` shows in the gate of the assignment (K8). */
const ASSIGN_GATE_REASON = 'Authenticate to send the assigned copies';

// ---------------------------------------------------------------- fixtures

function memoryKeychain(): SecretStore {
  const items = new Map<string, string>();
  return {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      items.set(key, value);
      return true;
    },
    delete: async (key) => items.delete(key),
  };
}

function memoryStore(): {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<boolean>;
} {
  const items = new Map<string, unknown>();
  return {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      items.set(key, value);
      return true;
    },
  };
}

function tool(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `Tool ${id}`,
    url: `https://${id}.example.test`,
    icon: null,
    order: 1,
    roles: [],
    views: [],
    auth: null,
    active: true,
    ...overrides,
  };
}

/** One Nod's backend: repository, session, vault, key pairs, catalog and the share flow. */
interface Nod {
  repo: NodRepo;
  session: Session;
  vault: Vault;
  keys: Keys;
  secrets: SecretStore;
  catalog: ConnectedCatalog;
  entry: (id: Id) => Entry | null;
  /** The pinned connection, set by a test or by the join helper (`null` until then). */
  link: { current: HostConnection | null };
  shares: Shares;
}

function newNod(gate: (reason: string, password?: string) => Promise<void> = async () => {}): Nod {
  const secrets = memoryKeychain();
  const repo = createNodRepo(memorySqlite());
  repo.migrate();
  repo.ensureAdminRole();
  const session = createSession({
    repo,
    keychain: secrets,
    store: memoryStore(),
    authenticate: async () => true,
    biometricAvailable: false,
    iterations: ITERATIONS,
  });
  const catalog = createConnectedCatalog({ now: () => Date.parse(AT) });
  const entry = (id: Id): Entry | null =>
    catalog.entries().find((item) => item.id === id) ?? repo.entry(id);
  const vault = createVault({
    repo: { ...repo, entry },
    keychain: secrets,
    iterations: ITERATIONS,
    vaultKey: () => session.vaultKey(),
  });
  const keys = createKeys({
    repo,
    keychain: secrets,
    session: { current: () => session.current(), vaultKey: () => session.vaultKey() },
  });
  const link: { current: HostConnection | null } = { current: null };
  const shares = createShares({
    repo,
    session: { current: () => session.current() },
    vault,
    keys,
    entry,
    connection: () => link.current,
    gate,
    onChanged: () => {},
  });
  return { repo, session, vault, keys, secrets, catalog, entry, link, shares };
}

// ---------------------------------------------------------------- the host under test

interface Running {
  address: string;
  db: Database;
  repo: HostRepo;
  pin: { kid: string; ed25519Public: string };
  client: HostClient;
  keychain: SecretStore;
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<Response>;
  close(): void;
}

const runningHosts: Running[] = [];
const dirs: string[] = [];

async function startHost(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-assign-'));
  dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  const previousGuild = process.env[GUILD_NAME_ENV];
  process.env[GUILD_NAME_ENV] = 'Nod test guild';
  const booted: Host = await bootHost(config);
  const app = createApp({ config, db: booted.db });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request: Request) => app.handle(request),
  });
  const address = `http://127.0.0.1:${server.port}`;
  const keychain = memoryKeychain();
  const client = createHostClient({ fetch, keychain });
  const pin = (await client.discover(address)).pin;
  const running: Running = {
    address,
    db: booted.db,
    repo: createHostRepo(booted.db),
    pin,
    client,
    keychain,
    call: async (method, path, body, token = null) =>
      await fetch(`${address}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => {
      server.stop(true);
      booted.close();
      if (previousGuild === undefined) delete process.env[GUILD_NAME_ENV];
      else process.env[GUILD_NAME_ENV] = previousGuild;
    },
  };
  runningHosts.push(running);
  return running;
}

afterEach(() => {
  for (const running of runningHosts.splice(0)) running.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomAuthKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function connectionFor(running: Running, person: { id: string }): HostConnection {
  return running.client.connect({
    address: running.address,
    kid: running.pin.kid,
    publicKey: running.pin.ed25519Public,
    personId: person.id,
  });
}

/** The host's setup admin, activated through the real command and the real setup route. */
async function adminOf(running: Running): Promise<HostAdmin> {
  const issued = await issueSetupCode(running.repo, new Date().toISOString());
  if (!issued.issued) throw new Error('the setup command refused to issue a code');
  const response = await running.call('POST', HOST_ROUTES.authSetup, {
    email: 'ada@nod.test',
    name: 'Ada',
    code: issued.code,
    salt: randomSalt(),
    authKey: randomAuthKey(),
    device: DEVICE,
  });
  const opened = await body<TokenResponse>(response);
  const connection = connectionFor(running, { id: opened.personId });
  await connection.saveToken(opened.token);
  return createHostAdmin(connection);
}

/**
 * A person of the guild with an access code for them (0.5.0, RF-59): they join through a guild
 * invite — the People tab's create route is an invite now — and the code is the reissue for a person
 * who already exists (`POST /v1/admin/people/:id/code`, SP02 §3).
 */
async function memberWithCode(
  running: Running,
  admin: HostAdmin,
  input: { email: string; name: string; roles: Id[] },
): Promise<{ id: string; code: string; expiresAt: string }> {
  const adminRoles = input.roles.filter((role) => role === 'admin');
  const invited = await admin.createInvite(
    {
      roles: input.roles.filter((role) => role !== 'admin'),
      maxUses: 1,
      expiresInMinutes: 60,
    },
    input.roles.filter((role) => role !== 'admin'),
  );
  const authKey = randomAuthKey();
  const joined = await running.call('POST', HOST_ROUTES.authJoin, {
    email: input.email,
    name: input.name,
    code: invited.code,
    salt: randomSalt(),
    authKey,
    device: DEVICE,
  });
  if (joined.status !== 200) throw new Error(`the join answered ${joined.status}`);
  const opened = (await joined.json()) as TokenResponse;
  // RF-59: an invite never grants an admin role, so an admin joins with the member roles and is
  // promoted afterwards — the documented path (`PATCH /v1/admin/people/:id`).
  if (adminRoles.length > 0) await admin.setRoles(opened.personId, input.roles);
  const issued = await admin.issueCode(opened.personId);
  return { id: opened.personId, code: issued.code, expiresAt: issued.expiresAt };
}

/** One person activated on the host and adopted into a Nod, with their key pair published. */
async function joinNod(
  running: Running,
  nod: Nod,
  input: { email: string; name: string; code: string; password: string },
): Promise<{ id: Id; token: string }> {
  const pre = running.client.connect({
    address: running.address,
    kid: running.pin.kid,
    publicKey: running.pin.ed25519Public,
    personId: '',
  });
  const published = await pre.request<SaltResponse>('POST', HOST_ROUTES.authSalt, {
    email: input.email,
  });
  const salt = randomSalt();
  const derived = await nod.session.deriveFor(input.password, salt, published.iterations);
  const opened = await pre.request<TokenResponse>('POST', HOST_ROUTES.authActivate, {
    email: input.email,
    code: input.code,
    salt,
    authKey: toBase64url(derived.authKey),
    device: DEVICE,
  });
  await nod.session.adoptConnectedAccount({
    personId: opened.personId,
    email: input.email,
    name: input.name,
    password: input.password,
    salt,
    iterations: published.iterations,
    admin: false,
  });
  nod.repo.saveHost({
    address: running.address,
    guild: 'Nod test guild',
    kid: running.pin.kid,
    publicKey: running.pin.ed25519Public,
    personId: opened.personId,
    salt,
    addedAt: AT,
  });
  const connection = connectionFor(running, { id: opened.personId });
  await connection.saveToken(opened.token);
  nod.link.current = connection;
  await nod.keys.ensure(connection);
  return { id: opened.personId, token: opened.token };
}

/** One verified snapshot (real signature check, real body), stored and applied as a sync would. */
async function syncNod(nod: Nod): Promise<Snapshot> {
  const connection = nod.link.current;
  if (connection === null) throw new Error('the Nod is not connected');
  const result = await connection.snapshot();
  if (result.notModified) throw new Error('the host answered 304 to a Nod with no cached version');
  nod.repo.saveHostSnapshot({
    snapshot: result.raw,
    version: result.snapshot.version,
    issuedAt: result.snapshot.issuedAt,
    syncedAt: AT,
  });
  nod.catalog.refresh(nod.repo.hostRecord());
  await nod.keys.observe();
  return result.snapshot;
}

/** Every table of the host's database, as text: what a dump of `host.db` would show (RF-44). */
function dumpHost(db: Database): string {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return tables
    .map(({ name }) => JSON.stringify(db.query(`SELECT * FROM "${name}"`).all()))
    .join('\n');
}

// ---------------------------------------------------------------- the fixture

interface Member {
  id: Id;
  token: string;
  nod: Nod;
}

interface Guild {
  running: Running;
  admin: HostAdmin;
  /** The assigning admin's own Nod: `roles: ['admin']`, and the credential's owner holder. */
  root: Member;
  /** The two members of `team` at the first assignment. */
  alice: Member;
  bob: Member;
}

/**
 * A guild with the `team` and `finance` roles, the org tool `figma` granted to `team`, an admin
 * whose own Nod is the one that assigns, the two `team` members, and every Nod synced once so the
 * roster, the tool and the pin table are what a real sync would have left.
 */
async function guild(onGate: (reason: string) => void = () => {}): Promise<Guild> {
  const running = await startHost();
  const admin = await adminOf(running);
  await admin.saveRole({ id: 'team', name: 'Team', admin: false });
  await admin.saveRole({ id: 'finance', name: 'Finance', admin: false });
  await admin.saveTool(
    tool('figma', { title: 'Figma', url: `${TOOL_ORIGIN}/app`, roles: ['team'] }),
  );
  await admin.grant('team', 'figma', true);

  const rootCreated = await memberWithCode(running, admin, {
    email: 'root@nod.test',
    name: 'Root',
    roles: ['admin'],
  });
  const aliceCreated = await memberWithCode(running, admin, {
    email: 'alice@nod.test',
    name: 'Alice',
    roles: ['team'],
  });
  const bobCreated = await memberWithCode(running, admin, {
    email: 'bob@nod.test',
    name: 'Bob',
    roles: ['team'],
  });

  const rootNod = newNod(async (reason) => onGate(reason));
  const aliceNod = newNod();
  const bobNod = newNod();
  const rootOpened = await joinNod(running, rootNod, {
    email: 'root@nod.test',
    name: 'Root',
    code: rootCreated.code,
    password: PASSWORD,
  });
  const aliceOpened = await joinNod(running, aliceNod, {
    email: 'alice@nod.test',
    name: 'Alice',
    code: aliceCreated.code,
    password: PASSWORD,
  });
  const bobOpened = await joinNod(running, bobNod, {
    email: 'bob@nod.test',
    name: 'Bob',
    code: bobCreated.code,
    password: PASSWORD,
  });

  // The roster, the tool and the pinned pairs reach every Nod exactly as a sync would deliver them.
  for (const nod of [rootNod, aliceNod, bobNod]) await syncNod(nod);
  return {
    running,
    admin,
    root: { id: rootOpened.id, token: rootOpened.token, nod: rootNod },
    alice: { id: aliceOpened.id, token: aliceOpened.token, nod: aliceNod },
    bob: { id: bobOpened.id, token: bobOpened.token, nod: bobNod },
  };
}

/** The admin's credential of one guild tool, saved on the Nod that owns it. */
async function saveCredential(
  member: Member,
  toolId: Id,
  username: string,
  secret: string,
): Promise<VaultItem> {
  return await member.nod.vault.save(member.id, { toolId, username, secret, label: tool(toolId).title });
}

/** The inbox of one member, synced: what arrived, with the kind the host recorded. */
async function inboxOf(member: Member): Promise<{ id: Id; kind: string; toolId: Id }[]> {
  await syncNod(member.nod);
  const items = member.nod.shares.inbox().map((share) => ({
    id: share.id,
    kind: share.kind as string,
    toolId: share.toolId,
  }));
  return items;
}

/** The value of the tool's default credential on that Nod — what a reveal of it would return. */
async function credentialOf(
  member: Member,
  toolId: Id,
): Promise<{ username: string; secret: string } | null> {
  const item = member.nod.repo.defaultVaultItem(member.id, toolId);
  return item === null ? null : await member.nod.vault.read(member.id, item.id);
}

// ---------------------------------------------------------------- #36 acceptance

describe('assignment to a role (K8, SP06 §4)', () => {
  test('the admin assigns to `team` and every current member receives the copy', async () => {
    const gateCalls: string[] = [];
    const { running, root, alice, bob } = await guild((reason) => gateCalls.push(reason));

    const figma = await saveCredential(root, 'figma', CREDENTIAL_USER, CREDENTIAL_SECRET);
    // K8/SP06 §4: the assignment writes the host's row and, in the same gated action, seals one
    // copy to every member the host lists as missing. The admin is not in `team`, and the host no
    // longer asks for a role in common of an assignment (SP06 §5 applies to a member's send).
    // M6: the answer reports the two copies sealed to the two `team` members.
    expect(
      await root.nod.shares.assign({ itemId: figma.id, roleId: 'team', personId: null, assigned: true }),
    ).toEqual({ sent: 2, skipped: 0 });
    expect(gateCalls).toEqual([ASSIGN_GATE_REASON]);

    const credentialId = root.nod.repo.vaultItemById(root.id, figma.id)?.credentialId ?? '';
    expect(credentialId).not.toBe('');
    // SP06 §4: the sender of the first copy of a credential becomes its owner holder.
    expect(running.repo.holdersOf(credentialId).map((holder) => [holder.name, holder.owner])).toEqual([
      ['Root', true],
    ]);
    expect(
      running.db
        .query<{ assigned_by: string }, []>('SELECT assigned_by FROM assignments')
        .all()
        .map((row) => row.assigned_by),
    ).toEqual([root.id]);

    for (const member of [alice, bob]) {
      const inbox = await inboxOf(member);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ kind: 'assign', toolId: 'figma' });
      const accepted = await member.nod.shares.accept(inbox[0].id);
      expect(accepted).toMatchObject({ toolId: 'figma', credentialId, scope: 'role' });
      expect(await credentialOf(member, 'figma')).toEqual({
        username: CREDENTIAL_USER,
        secret: CREDENTIAL_SECRET,
      });
    }

    // RF-54: the host lists the three holders, and the missing list is empty again. RF-44: the host
    // holds the sealed copies and neither the username nor the secret.
    expect(running.repo.holdersOf(credentialId).map((holder) => holder.name).sort()).toEqual([
      'Alice',
      'Bob',
      'Root',
    ]);
    await root.nod.shares.refreshAssignments();
    expect(root.nod.shares.missing()).toEqual([]);
    expect(root.nod.shares.missingCount()).toBe(0);
    const dump = dumpHost(running.db);
    expect(dump).not.toContain(CREDENTIAL_USER);
    expect(dump).not.toContain(CREDENTIAL_SECRET);
  });

  test('a member who joins `team` later is missing until the admin seals their copy after the gate', async () => {
    const gateCalls: string[] = [];
    const { running, admin, root, alice, bob } = await guild((reason) => gateCalls.push(reason));
    const figma = await saveCredential(root, 'figma', CREDENTIAL_USER, CREDENTIAL_SECRET);
    await root.nod.shares.assign({ itemId: figma.id, roleId: 'team', personId: null, assigned: true });
    const credentialId = root.nod.repo.vaultItemById(root.id, figma.id)?.credentialId ?? '';
    for (const member of [alice, bob]) {
      const inbox = await inboxOf(member);
      await member.nod.shares.accept(inbox[0].id);
    }
    await root.nod.shares.refreshAssignments();
    expect(root.nod.shares.missing()).toEqual([]);

    // The new member: created in `team`, activated and publishing a pair on the host.
    const daveCreated = await memberWithCode(running, admin, {
      email: 'dave@nod.test',
      name: 'Dave',
      roles: ['team'],
    });
    const dave: Member = { id: '', token: '', nod: newNod() };
    const daveOpened = await joinNod(running, dave.nod, {
      email: 'dave@nod.test',
      name: 'Dave',
      code: daveCreated.code,
      password: PASSWORD,
    });
    dave.id = daveOpened.id;
    dave.token = daveOpened.token;

    // The admin's Nod sees him (the roster and his pinned key) and the host lists him as missing.
    await syncNod(root.nod);
    await root.nod.shares.refreshAssignments();
    expect(root.nod.shares.missing()).toEqual([
      {
        credentialId,
        toolId: 'figma',
        toolTitle: 'Figma',
        roleId: 'team',
        personId: dave.id,
        personName: 'Dave',
        keyStatus: 'pinned',
      },
    ]);
    expect(root.nod.shares.missingCount()).toBe(1);
    // Nobody was sealed to yet: one gated action, and the list is unchanged.
    gateCalls.length = 0;

    // K8/SP06 §4: the admin's one gated action seals the copy to the member still missing it.
    expect(await root.nod.shares.sealMissing()).toEqual({ sent: 1, skipped: 0 });
    expect(gateCalls).toEqual([ASSIGN_GATE_REASON]);

    // The member receives it as an assignment and accepts it like any other share (K4). The host
    // derives its list from the holder rows, so it is Dave's accept that clears him — between the
    // seal and the accept the copy is only in his inbox.
    const inbox = await inboxOf(dave);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'assign', toolId: 'figma' });
    const accepted = await dave.nod.shares.accept(inbox[0].id);
    expect(accepted).toMatchObject({ credentialId, scope: 'role' });
    expect(await credentialOf(dave, 'figma')).toEqual({
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
    });

    // Nobody is missing a copy again, and the host holds the four holders.
    await root.nod.shares.refreshAssignments();
    expect(root.nod.shares.missing()).toEqual([]);
    expect(root.nod.shares.missingCount()).toBe(0);
    expect(running.repo.holdersOf(credentialId).map((holder) => holder.name).sort()).toEqual([
      'Alice',
      'Bob',
      'Dave',
      'Root',
    ]);
  });

  test('the direct person assignment needs no role and reaches exactly that person', async () => {
    const { running, admin, root, alice, bob } = await guild();
    await admin.saveTool(
      tool('kalendar', { title: 'Kalendar', url: `${KALENDAR_ORIGIN}/app`, roles: ['team'] }),
    );
    await admin.grant('team', 'kalendar', true);
    await syncNod(root.nod);
    const kalendar = await saveCredential(root, 'kalendar', 'kalendar-user', 'kalendar-secret');

    // K8: a `personId` with no assignment row at all — the admin addressing one person.
    expect(
      await root.nod.shares.assign({
        itemId: kalendar.id,
        roleId: null,
        personId: alice.id,
        assigned: true,
      }),
    ).toEqual({ sent: 1, skipped: 0 });
    const credentialId = root.nod.repo.vaultItemById(root.id, kalendar.id)?.credentialId ?? '';
    expect(running.db.query<{ one: number }, []>('SELECT 1 AS one FROM assignments').all()).toEqual([]);

    const inbox = await inboxOf(alice);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'assign', toolId: 'kalendar' });
    await alice.nod.shares.accept(inbox[0].id);
    expect(await credentialOf(alice, 'kalendar')).toEqual({
      username: 'kalendar-user',
      secret: 'kalendar-secret',
    });

    // Only the person the admin named: no assignment row, so nobody else appears in any list.
    expect(running.repo.holdersOf(credentialId).map((holder) => holder.name).sort()).toEqual([
      'Alice',
      'Root',
    ]);
    await root.nod.shares.refreshAssignments();
    expect(root.nod.shares.missing()).toEqual([]);
    const bobInbox = await inboxOf(bob);
    expect(bobInbox).toEqual([]);
  });

  test('a direct person assignment with no pinned key raises the reason and persists no id (M6/L6)', async () => {
    const { running, admin, root } = await guild();
    const figma = await saveCredential(root, 'figma', CREDENTIAL_USER, CREDENTIAL_SECRET);

    // A `team` member who never activated a Nod: he is in the roster but has published no keys.
    const nobodyCreated = await memberWithCode(running, admin, {
      email: 'nobody@nod.test',
      name: 'Nobody',
      roles: ['team'],
    });
    await syncNod(root.nod);

    await expect(
      root.nod.shares.assign({
        itemId: figma.id,
        roleId: null,
        personId: nobodyCreated.id,
        assigned: true,
      }),
    ).rejects.toThrow('recipient has no pinned key');

    // M6: nothing was sent, so the action is not reported as a success; L6: no orphan credentialId.
    expect(root.nod.repo.vaultItemById(root.id, figma.id)?.credentialId).toBeNull();
  });
});
