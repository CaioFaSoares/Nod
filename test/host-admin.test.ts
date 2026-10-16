// `backend/host-admin.ts` — the admin RPCs of SP05 §3–§4 — against the **real** host: the Elysia app
// of `host/app.ts` booted on a temp data dir and served on loopback by `Bun.serve`, with the real
// `backend/host-client.ts` (`fetch`, `crypto.subtle`, the keychain in memory) and the real
// `backend/sync.ts` for the one case that has to prove a sync.
//
// Nothing here mocks the host, the guards, the routes or the client: the setup code is issued by the
// real command (`host/cli/setup-code.ts`), the first admin is made through `POST /v1/auth/setup`,
// every admin write goes through this slice's module and every read comes back over the wire —
// snapshots included, whose signature the client verifies before a test reads a field.
//
// Acceptance covered: B6's RF-34 (a tool granted to `team` reaches a `team` member's snapshot and
// nobody else's), RF-33 (a created person's code is shown once and activates them), the Activity read
// and the People read, and B8a's bootstrap (published once, refused the second time, and present in
// the member's Nod after a sync). The last test pins the local half: with no `host` row the seam is
// `null` and a local admin write leaves this machine.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostAdmin, hostAdminFor, type HostAdmin } from '../backend/host-admin';
import { createHostClient, hostTokenKey, type HostClient, type HostConnection } from '../backend/host-client';
import { createConnectedCatalog } from '../backend/connected-catalog';
import { createRepo as createNodRepo } from '../backend/repo';
import { createSession, type Session } from '../backend/session';
import { createSync } from '../backend/sync';
import { createVault, type Vault } from '../backend/vault';
import { toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  type ClientEvent,
  type ErrorResponse,
  type SaltResponse,
  type Snapshot,
  type TokenResponse,
} from '../shared/host-api';
import type { Device } from '../shared/host-api';
import type { Entry, HostState, Id, Role, SecretStore } from '../shared/types';
import { createApp } from '../host/app';
import { createRepo as createHostRepo, type Repo } from '../host/repo';
import { issueSetupCode } from '../host/cli/setup-code';
import { DEFAULT_PORT, type HostConfig } from '../host/config';
import { bootHost, type Host } from '../host/main';
import { GUILD_NAME_ENV } from '../host/routes/state';
import { memorySqlite } from './helpers/sqlite-bun';

const DEVICE: Device = { name: 'nod-host-admin-test', os: 'macos', appVersion: '0.3.0' };
const ADMIN_EMAIL = 'ada@nod.test';
const HOUR_MS = 3_600_000;
const AT = '2026-10-16T10:00:00.000Z';

/** A person as the test passes them around: their host id and the bearer the keychain holds. */
interface Session {
  id: string;
  token: string;
}

interface Running {
  address: string;
  repo: Repo;
  /** The pinned half of the host, as `host.discover` answered it. */
  pin: { kid: string; ed25519Public: string };
  client: HostClient;
  keychain: SecretStore;
  /** Every request the serving process answered, in order (`METHOD /path`). */
  requests: string[];
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<Response>;
  close(): void;
}

const runningHosts: Running[] = [];
const dirs: string[] = [];

/** `app.secrets` in memory: the same surface, no keychain of the machine. */
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

/** The real host: boot on a temp dir, the real app, one loopback server in front of it. */
async function startHost(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-host-admin-'));
  dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  // SP07 §2's deployment value: the discovery route reads the guild name from the environment, and a
  // Nod refuses a discovery with no guild (SP04 §1). Restored when the host closes.
  const previousGuild = process.env[GUILD_NAME_ENV];
  process.env[GUILD_NAME_ENV] = 'Nod test guild';
  const booted: Host = await bootHost(config);
  const app = createApp({ config, db: booted.db });
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request: Request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      return app.handle(request);
    },
  });
  const address = `http://127.0.0.1:${server.port}`;
  const keychain = memoryKeychain();
  const client = createHostClient({ fetch, keychain });
  const pin = (await client.discover(address)).pin;
  const running: Running = {
    address,
    repo: createHostRepo(booted.db),
    pin,
    client,
    keychain,
    requests,
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

// ---------------------------------------------------------------- fixtures

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomAuthKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** An org tool of SP03 §2 (`Entry` + views): what `catalog.save` sends and the host answers. */
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

/** The first admin, through the real command and the real setup route (SP02 §3, RF-32). */
async function setupAdmin(running: Running): Promise<Session> {
  const issued = await issueSetupCode(running.repo, new Date().toISOString());
  if (!issued.issued) throw new Error('the setup command refused to issue a code');
  const response = await running.call('POST', HOST_ROUTES.authSetup, {
    email: ADMIN_EMAIL,
    name: 'Ada',
    code: issued.code,
    salt: randomSalt(),
    authKey: randomAuthKey(),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  const opened = await body<TokenResponse>(response);
  return { id: opened.personId, token: opened.token };
}

/** A connection of one person, pinned by the discovery and carrying their bearer (SP02 §5). */
async function connectionFor(running: Running, person: Session): Promise<HostConnection> {
  const found = await running.client.discover(running.address);
  const connection = running.client.connect({
    address: found.address,
    kid: found.pin.kid,
    publicKey: found.pin.ed25519Public,
    personId: person.id,
  });
  await connection.saveToken(person.token);
  return connection;
}

/** The admin module of one person, exactly as `backend/main.ts` builds it. */
async function adminOf(running: Running): Promise<{ admin: HostAdmin; person: Session }> {
  const person = await setupAdmin(running);
  return { admin: createHostAdmin(await connectionFor(running, person)), person };
}

/** Redeems an access code through the real activation route (SP02 §3, RF-33). */
async function activate(running: Running, email: string, code: string): Promise<Session> {
  const response = await running.call('POST', HOST_ROUTES.authActivate, {
    email,
    code,
    salt: randomSalt(),
    authKey: randomAuthKey(),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  const opened = await body<TokenResponse>(response);
  return { id: opened.personId, token: opened.token };
}

/** The admin creates the person, and the person redeems the code the answer carried. */
async function member(
  running: Running,
  admin: HostAdmin,
  input: { email: string; name: string; roles: Id[] },
): Promise<Session & { code: string; expiresAt: string }> {
  const created = await admin.createPerson(input);
  const session = await activate(running, created.person.email, created.code);
  expect(session.id).toBe(created.person.id);
  return { ...session, code: created.code, expiresAt: created.expiresAt };
}

/** What one person sees (`GET /v1/state`), verified by the client over the bytes received (SP04 §2). */
async function snapshotOf(running: Running, person: Session): Promise<Snapshot> {
  const result = await (await connectionFor(running, person)).snapshot();
  if (result.notModified) throw new Error('the host answered 304 to a Nod with no cached version');
  return result.snapshot;
}

// ---------------------------------------------------------------- catalog, roles, grants (RF-34)

describe('the admin writes reach the host (SP05 §3, RF-34)', () => {
  test('a tool granted to team reaches a team member and nobody else', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    await admin.saveRole({ id: 'team', name: 'Team', admin: false });
    await admin.saveRole({ id: 'finance', name: 'Finance', admin: false });

    // The Tools tab's save: PUT /v1/admin/tools/jitsi, grants and views included.
    const saved = await admin.saveTool(
      tool('jitsi', {
        title: 'Jitsi',
        roles: ['team'],
        views: [{ label: 'Meet', url: 'https://jitsi.example.test/meet', mode: 'window' }],
      }),
    );
    expect(saved.roles).toEqual(['team']);
    expect(saved.views.map((view) => view.label)).toEqual(['Meet']);
    // SP04 §2: the host creates the view id; the Nod never sends one for a new view.
    expect(saved.views[0]?.id).toBeTruthy();

    const ana = await member(running, admin, { email: 'ana@nod.test', name: 'Ana', roles: ['team'] });
    const bob = await member(running, admin, { email: 'bob@nod.test', name: 'Bob', roles: ['finance'] });

    expect((await snapshotOf(running, ana)).orgTools.map((entry) => entry.id)).toEqual(['jitsi']);
    expect((await snapshotOf(running, bob)).orgTools).toEqual([]);

    // The Roles tab's toggle: revoking the grant takes the tool from the member's snapshot.
    await admin.grant('team', 'jitsi', false);
    expect((await snapshotOf(running, ana)).orgTools).toEqual([]);
    await admin.grant('team', 'jitsi', true);
    expect((await snapshotOf(running, ana)).orgTools.map((entry) => entry.id)).toEqual(['jitsi']);

    // A role the guild no longer has leaves the snapshot with it (the Roles tab's remove).
    await admin.saveRole({ id: 'temp', name: 'Temp', admin: false });
    expect((await snapshotOf(running, ana)).roles.map((role) => role.id)).toContain('temp');
    await admin.removeRole('temp');
    expect((await snapshotOf(running, ana)).roles.map((role) => role.id)).not.toContain('temp');

    // The catalog entry leaves the guild too.
    await admin.removeTool('jitsi');
    expect((await snapshotOf(running, ana)).orgTools).toEqual([]);
  });

  test('editing a tool replaces its views and its grants on the host', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    await admin.saveRole({ id: 'team', name: 'Team', admin: false });
    await admin.saveTool(tool('notes', { roles: ['team'], views: [{ label: 'A', url: 'https://notes.example.test/a', mode: 'window' }] }));

    const edited = await admin.saveTool(
      tool('notes', {
        title: 'Notes',
        url: 'https://notes.example.test/app',
        roles: [],
        views: [{ label: 'B', url: 'https://notes.example.test/b', mode: 'navigate' }],
        auth: { noFill: true },
        active: false,
      }),
    );
    expect(edited).toMatchObject({ title: 'Notes', active: false, auth: { noFill: true }, roles: [] });
    expect(edited.views.map((view) => view.label)).toEqual(['B']);

    // A view the person owns never travels on an admin route: B5 hangs them under the entry for the
    // screens that open them (SP04 §2), and the org tool is not where they live.
    const guarded = await admin.saveTool(
      tool('notes', {
        views: [
          { label: 'Org', url: 'https://notes.example.test/a', mode: 'window', scope: 'org' },
          { label: 'Mine', url: 'https://notes.example.test/b', mode: 'window', scope: 'personal', ownerId: 'me' },
        ],
      }),
    );
    expect(guarded.views.map((view) => view.label)).toEqual(['Org']);
  });
});

// ---------------------------------------------------------------- people and codes (RF-33)

describe('the People tab (SP05 §4, RF-33)', () => {
  test('a created person gets one code, shown once, and that code activates them', async () => {
    const running = await startHost();
    const { admin, person: adminPerson } = await adminOf(running);
    await admin.saveRole({ id: 'team', name: 'Team', admin: false });

    const before = Date.now();
    const created = await admin.createPerson({ email: ' bob@nod.test ', name: 'Bob', roles: ['team'] });
    expect(created.person).toMatchObject({ email: 'bob@nod.test', name: 'Bob', roles: ['team'], admin: false });
    expect(created.person.activatedAt).toBeNull();
    expect(created.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // SP02 §3: 72 h from the request.
    const ttlHours = (Date.parse(created.expiresAt) - before) / HOUR_MS;
    expect(ttlHours).toBeGreaterThan(71.9);
    expect(ttlHours).toBeLessThan(72.1);

    // Shown once: the list the People tab renders carries no trace of the code or of a hash.
    const listed = await admin.listPeople();
    expect(listed.map((item) => item.email)).toEqual([ADMIN_EMAIL, 'bob@nod.test']);
    const wire = JSON.stringify(listed);
    for (const secret of ['code', 'salt', 'authHash', 'token']) expect(wire.includes(secret)).toBe(false);
    expect(wire.includes(created.code)).toBe(false);
    expect(listed[1]).toMatchObject({ disabledAt: null, activatedAt: null });

    // The code activates: the person redeems it and their own session reads a snapshot.
    const bob = await activate(running, 'bob@nod.test', created.code);
    expect(bob.id).toBe(created.person.id);
    expect((await snapshotOf(running, bob)).me.id).toBe(bob.id);

    // A reissued code replaces the previous one (SP02 §3): the old one is dead, the new one works.
    const reissued = await admin.issueCode(created.person.id);
    expect(reissued.code).not.toBe(created.code);
    const dead = await running.call('POST', HOST_ROUTES.authActivate, {
      email: 'bob@nod.test',
      code: created.code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(dead.status).toBe(401);
    expect((await activate(running, 'bob@nod.test', reissued.code)).id).toBe(created.person.id);

    // The roles toggle and the revoke the People tab sends.
    const updated = await admin.setRoles(created.person.id, ['team']);
    expect(updated.roles).toEqual(['team']);
    const disabled = await admin.disable(created.person.id);
    expect(disabled.disabledAt).not.toBeNull();
    // SP03 §2: disabling revokes the sessions — the member's token is dead at once (RF-39).
    const ping = await running.call('POST', HOST_ROUTES.events, { events: [] }, bob.token);
    expect(ping.status).toBe(401);

    // A person the admin cannot touch is refused, not silently written.
    await expect(admin.disable(adminPerson.id)).rejects.toThrow();
  });

  test('a taken email and an unknown role answer the message of the screen, not of the host', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    await admin.createPerson({ email: 'bob@nod.test', name: 'Bob', roles: [] });

    await expect(admin.createPerson({ email: 'bob@nod.test', name: 'Other', roles: [] })).rejects.toThrow(
      'email taken',
    );
    await expect(admin.createPerson({ email: 'carol@nod.test', name: 'Carol', roles: ['ghost'] })).rejects.toThrow(
      'the guild has no such role',
    );
    await expect(admin.issueCode('nobody')).rejects.toThrow('not found on the host');
    expect(await admin.listPeople()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- activity

describe('the Activity tab (SP05 §4)', () => {
  test('reads the guild log and filters it the way the screen asks', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    const ana = await member(running, admin, { email: 'ana@nod.test', name: 'Ana', roles: [] });

    const opened: ClientEvent = {
      id: crypto.randomUUID(),
      at: AT,
      kind: 'tool_opened',
      toolId: 'alpha',
      url: 'https://alpha.example.test/app',
      result: null,
      detail: null,
    };
    const filled: ClientEvent = { ...opened, id: crypto.randomUUID(), kind: 'login', result: 'filled' };
    const pushed = await running.call('POST', HOST_ROUTES.events, { events: [opened, filled] }, ana.token);
    expect(pushed.status).toBe(200);

    const alpha = await admin.listEvents({ toolId: 'alpha' });
    expect(alpha).toHaveLength(2);
    expect([...alpha.map((row) => row.type)].sort()).toEqual(['login', 'tool_opened']);
    expect([...alpha.map((row) => row.id)].sort()).toEqual([opened.id, filled.id].sort());
    // The whole row the Activity tab renders, out of the host's own answer.
    const row = alpha.find((event) => event.id === opened.id);
    expect(row).toMatchObject({
      at: AT,
      personId: ana.id,
      toolId: 'alpha',
      url: 'https://alpha.example.test/app',
      result: null,
    });
    // SP03 §2: a row read from the host is one it received — the Activity tab's "Sent" column.
    expect(typeof row?.sentAt).toBe('string');

    // The screen's own filters: the person and the tool go to the host, `result` is applied here.
    expect(await admin.listEvents({ personId: 'nobody' })).toEqual([]);
    const byResult = await admin.listEvents({ result: 'filled' });
    expect(byResult.every((row) => row.result === 'filled')).toBe(true);
    expect(byResult.some((row) => row.toolId === 'alpha')).toBe(true);
  });
});

// ---------------------------------------------------------------- bootstrap (B8a)

describe('B8a — the first admin publishes the local catalog once', () => {
  test('the host takes the first bootstrap and refuses the second', async () => {
    const running = await startHost();
    const { admin, person } = await adminOf(running);

    const tools: Entry[] = [
      tool('jitsi', { roles: ['team'], views: [{ label: 'Meet', url: 'https://jitsi.example.test/meet', mode: 'window' }] }),
      tool('notes', { order: 2 }),
    ];
    const roles: Role[] = [{ id: 'team', name: 'Team', admin: false }];

    const first = await admin.bootstrap(tools, roles);
    expect(first).toEqual({ created: 2, refused: false });

    const second = await admin.bootstrap(tools, roles);
    expect(second).toEqual({ created: 0, refused: true });

    // The route itself is the one that refuses (SP03 §2): `409` with the host's own body.
    const raw = await running.call('POST', HOST_ROUTES.adminBootstrap, { tools: [], roles: [] }, person.token);
    expect(raw.status).toBe(409);
    expect(await body<ErrorResponse>(raw)).toEqual({ error: 'the host already has org tools' });

    // The published tool and the published role are the host's now: a person the admin creates with
    // `team` sees the tool in their snapshot (B8a's second acceptance item). `admin` is the role the
    // setup created (SP02 §3).
    const ana = await member(running, admin, { email: 'ana@nod.test', name: 'Ana', roles: ['team'] });
    const snapshot = await snapshotOf(running, ana);
    expect(snapshot.orgTools.map((entry) => entry.id)).toEqual(['jitsi']);
    expect([...snapshot.roles.map((role) => role.id)].sort()).toEqual(['admin', 'team']);
  });

  test('after a sync the published tool is in the Nod that holds the granted role', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    await admin.bootstrap(
      [tool('jitsi', { roles: ['team'] })],
      [{ id: 'team', name: 'Team', admin: false }],
    );
    const ana = await member(running, admin, { email: 'ana@nod.test', name: 'Ana', roles: ['team'] });

    // Ana's Nod: a real repository, the host row and the bearer in her own keychain (SP05 §2).
    const repo = createNodRepo(memorySqlite());
    repo.migrate();
    repo.saveHost({
      address: running.address,
      guild: 'Guild',
      kid: running.pin.kid,
      publicKey: running.pin.ed25519Public,
      personId: ana.id,
      salt: 'c2FsdA',
      addedAt: AT,
    });
    const keychain = memoryKeychain();
    await keychain.set(hostTokenKey(running.pin.kid, ana.id), ana.token);
    const client = createHostClient({ fetch, keychain });
    const sync = createSync({
      repo,
      connection: () =>
        client.connect({
          address: running.address,
          kid: running.pin.kid,
          publicKey: running.pin.ed25519Public,
          personId: ana.id,
        }),
      now: () => Date.parse(AT),
      onState: () => {},
      onSignedOut: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    });

    const state = await sync.syncNow();
    expect(state.status).toBe('connected');

    // The verified body landed in the row verbatim (SP04 §2): the published tool is in it.
    const raw = repo.hostRecord()?.snapshot ?? '';
    expect(raw).not.toBe('');
    const landed = JSON.parse(raw) as Snapshot;
    expect(landed.me.id).toBe(ana.id);
    expect(landed.orgTools.map((entry) => entry.id)).toEqual(['jitsi']);
  });
});

// ---------------------------------------------------------------- local mode

describe('local mode never reaches a host (RF-30, SP05 §3)', () => {
  test('without a host row the admin seam is null and a local write stays on the machine', async () => {
    const running = await startHost();
    // `backend/main.ts` asks for this on every admin write: a `null` connection — no `host` row —
    // means no host admin, and the handler keeps its local branch.
    expect(hostAdminFor(null)).toBeNull();

    const repo = createNodRepo(memorySqlite());
    repo.migrate();
    repo.ensureAdminRole();
    const repoRole = repo.saveRole({ id: 'team', name: 'Team', admin: false });
    const repoPerson = repo.createPerson({
      email: 'local@nod.test',
      name: 'Local',
      roles: [],
      password: { algorithm: 'PBKDF2-SHA256', hash: 'aGFzaA', salt: 'c2FsdA', iterations: 1 },
    });
    repo.setRoles(repoPerson.id, [repoRole.id]);
    const before = running.requests.length;

    // What the local branch of `catalog.save` and `roles.grant` writes.
    const saved = repo.saveEntry(tool('local-tool'));
    repo.grant(repoRole.id, saved.id, true);

    expect(repo.entry('local-tool')).toMatchObject({ title: 'Tool local-tool', roles: ['team'] });
    expect(repo.listPeople().map((item) => item.email)).toEqual(['local@nod.test']);
    expect(repo.listRoles().map((item) => item.id).sort()).toEqual(['admin', 'team']);
    // The host was up and reachable the whole time, and heard nothing.
    expect(running.requests.length).toBe(before);
  });
});

// ---------------------------------------------------------------- F1/F2/F3/F7 — the join of a Nod

/** PBKDF2 with 600 000 iterations costs hundreds of ms; the Nod side of these tests uses 1000. */
const ITERATIONS = 1000;
const NOD_PASSWORD = 'nod-password';
const LOCAL_EMAIL = 'bob@nod.test';

/** `app.store` in memory: the same surface, nothing on disk. */
function memoryStore(): { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<boolean> } {
  const items = new Map<string, unknown>();
  return {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      items.set(key, value);
      return true;
    },
  };
}

/** The Nod side of one machine: the real repository, session and vault over its keychain. */
interface Nod {
  repo: ReturnType<typeof createNodRepo>;
  session: Session;
  vault: Vault;
  secrets: SecretStore;
}

function newNod(): Nod {
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
  return { repo, session, vault: createVault({ repo, keychain: secrets, iterations: ITERATIONS }), secrets };
}

async function messageOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'did not throw';
}

/** What one activation of the Nod side answers: what `backend/main.ts`'s handler would return. */
type JoinAnswer =
  | { kind: 'local-account'; personId: string; email: string; name: string; requests: number }
  | { kind: 'session'; personId: string; token: string; admin: boolean; requests: number };

/**
 * One activation, the way `backend/main.ts`'s `host.activate` runs it: the session's local gate
 * first — nothing about this Nod's accounts is decided by the host, and no request is made before
 * the gate allows it — then the discovery and the two auth calls over the real client, then the
 * adoption of the host's answer. `requests` is what the host's own log grew by, so "no request was
 * made" is the host's word and not this test's.
 */
async function activateAs(
  running: Running,
  nod: Nod,
  input: { email: string; code: string; password: string; name?: string; adoptLocal?: boolean },
): Promise<JoinAnswer> {
  const before = running.requests.length;
  const setup = input.name !== undefined;
  const gate = await nod.session.joinGate({
    email: input.email,
    adoptLocal: input.adoptLocal ?? false,
    hostPinned: false,
    signIn: false,
    host: async () => {
      const found = await running.client.discover(running.address);
      const pre = running.client.connect({
        address: found.address,
        kid: found.pin.kid,
        publicKey: found.pin.ed25519Public,
        personId: '',
      });
      const published = await pre.request<SaltResponse>('POST', HOST_ROUTES.authSalt, { email: input.email });
      const salt = randomSalt();
      const keys = await nod.session.deriveFor(input.password, salt, published.iterations);
      const body = {
        email: input.email,
        code: input.code,
        salt,
        authKey: toBase64url(keys.authKey),
        device: DEVICE,
      };
      const opened = await pre.request<TokenResponse>(
        'POST',
        setup ? HOST_ROUTES.authSetup : HOST_ROUTES.authActivate,
        setup ? { ...body, name: input.name } : body,
      );
      return { found, published, salt, opened };
    },
  });
  if (gate.kind === 'choose') {
    return {
      kind: 'local-account',
      personId: gate.person.id,
      email: gate.person.email,
      name: gate.person.name,
      requests: running.requests.length - before,
    };
  }
  const { found, published, salt, opened } = gate.answer;
  const state = await nod.session.adoptConnectedAccount({
    personId: opened.personId,
    email: input.email,
    name: input.name ?? gate.local?.name ?? input.email,
    password: input.password,
    salt,
    iterations: published.iterations,
    admin: setup,
    ...(gate.local === null ? {} : { adoptLocalId: gate.local.id }),
  });
  nod.repo.saveHost({
    address: found.address,
    guild: 'Nod test guild',
    kid: found.pin.kid,
    publicKey: found.pin.ed25519Public,
    personId: opened.personId,
    salt,
    addedAt: AT,
  });
  return {
    kind: 'session',
    personId: opened.personId,
    token: opened.token,
    admin: state.person !== null && state.person.admin,
    requests: running.requests.length - before,
  };
}

/**
 * One sync of a joined Nod, wired the way `backend/main.ts` wires it (SP05 §2): the client over the
 * `host` row, the effective catalog re-derived on every published state — and F2's reconcile, which
 * is the line under test here.
 */
async function syncNod(running: Running, nod: Nod, person: { id: string; token: string }): Promise<HostState> {
  const catalog = createConnectedCatalog({ now: () => Date.parse(AT) });
  const connection = () =>
    running.client.connect({
      address: running.address,
      kid: running.pin.kid,
      publicKey: running.pin.ed25519Public,
      personId: person.id,
    });
  await connection().saveToken(person.token);
  const sync = createSync({
    repo: nod.repo,
    connection,
    now: () => Date.parse(AT),
    onState: () => {
      // `backend/main.ts`: the catalog follows the snapshot, and so does the connected person (F2).
      catalog.refresh(nod.repo.hostRecord());
      const me = catalog.current()?.me ?? null;
      if (me !== null) {
        nod.session.reconcileConnectedIdentity({ id: me.id, name: me.name, admin: me.admin });
      }
    },
    onSignedOut: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  });
  return await sync.syncNow();
}

describe('F1 — a join whose email is already an account of this Nod', () => {
  test('the choice is answered before any host call, and the code is still redeemable', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    const created = await admin.createPerson({ email: LOCAL_EMAIL, name: 'Bob Guild', roles: [] });
    const nod = newNod();
    const localId = (await nod.session.createAccount({ email: LOCAL_EMAIL, name: 'Bob Local', password: NOD_PASSWORD })).person?.id ?? '';
    const settled = running.requests.slice();

    const choice = await activateAs(running, nod, { email: LOCAL_EMAIL, code: created.code, password: NOD_PASSWORD });

    expect(choice).toEqual({
      kind: 'local-account',
      personId: localId,
      email: LOCAL_EMAIL,
      name: 'Bob Local',
      requests: 0,
    });
    // The host's own log says it too: discovery, salt and the redemption were never made, so the
    // single-use code is whole.
    expect(running.requests).toEqual(settled);

    // The decision the page sends back: the same code still redeems it.
    const joined = await activateAs(running, nod, {
      email: LOCAL_EMAIL,
      code: created.code,
      password: NOD_PASSWORD,
      adoptLocal: true,
    });
    expect(joined).toMatchObject({ kind: 'session', personId: created.person.id });
    expect(joined.requests).toBeGreaterThan(0);
  });

  test('with the choice made and the account unlocked, the join adopts it and the credential comes along', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    const created = await admin.createPerson({ email: LOCAL_EMAIL, name: 'Bob Guild', roles: [] });
    const nod = newNod();
    const localId = (await nod.session.createAccount({ email: LOCAL_EMAIL, name: 'Bob Local', password: NOD_PASSWORD })).person?.id ?? '';
    // A local role of that account, and a credential saved before the join.
    nod.repo.saveRole({ id: 'team', name: 'Team', admin: false });
    nod.repo.setRoles(localId, ['admin', 'team']);
    nod.repo.saveEntry(tool('kanban'));
    await nod.vault.save(localId, { toolId: 'kanban', username: 'bob', secret: 'kanban-secret' });
    expect(await nod.vault.read(localId, 'kanban')).toEqual({ username: 'bob', secret: 'kanban-secret' });

    const joined = await activateAs(running, nod, {
      email: LOCAL_EMAIL,
      code: created.code,
      password: NOD_PASSWORD,
      adoptLocal: true,
    });

    expect(joined).toMatchObject({ kind: 'session', personId: created.person.id, admin: false });
    // The row is the host's person, with the roles the local account had (the host decides only the
    // admin flag) and the name the person typed on this machine.
    expect(nod.repo.personById(localId)).toBeNull();
    expect(nod.repo.personById(created.person.id)).toMatchObject({
      email: LOCAL_EMAIL,
      name: 'Bob Local',
      roles: ['team'],
    });
    expect(nod.session.current()?.id).toBe(created.person.id);
    // The credential is readable under the new id, the index moved with it and the old keychain key
    // is gone: the item was renamed, not copied.
    expect(await nod.vault.read(created.person.id, 'kanban')).toEqual({ username: 'bob', secret: 'kanban-secret' });
    expect(await nod.secrets.get(`nod.cred.${localId}.kanban`)).toBeNull();
    expect(nod.repo.listVault(created.person.id).map((item) => item.keychainKey)).toEqual([
      `nod.cred.${created.person.id}.kanban`,
    ]);
    // The host holds that person under the very id this machine now uses (SP05 §2).
    expect(running.repo.personById(created.person.id)).toMatchObject({ email: LOCAL_EMAIL, name: 'Bob Guild' });
  });

  test('a locked Nod that already has an account refuses the join, and no request leaves (F1, F3)', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    const created = await admin.createPerson({ email: LOCAL_EMAIL, name: 'Bob Guild', roles: [] });
    const nod = newNod();
    await nod.session.createAccount({ email: LOCAL_EMAIL, name: 'Bob Local', password: NOD_PASSWORD });
    nod.session.lock();
    const settled = running.requests.length;

    expect(
      await messageOf(() => activateAs(running, nod, { email: LOCAL_EMAIL, code: created.code, password: NOD_PASSWORD })),
    ).toBe('unlock this Nod first, then join the guild');
    // Nothing left the machine, with the collision or without it.
    expect(running.requests.length).toBe(settled);
    expect(await messageOf(() => activateAs(running, nod, { email: 'other@nod.test', code: created.code, password: NOD_PASSWORD }))).toBe(
      'unlock this Nod first, then join the guild',
    );
    expect(running.requests.length).toBe(settled);

    // The code is whole: the unlocked session redeems it.
    await nod.session.unlock({ email: LOCAL_EMAIL, password: NOD_PASSWORD });
    const joined = await activateAs(running, nod, {
      email: LOCAL_EMAIL,
      code: created.code,
      password: NOD_PASSWORD,
      adoptLocal: true,
    });
    expect(joined).toMatchObject({ kind: 'session', personId: created.person.id });
  });

  test('the first run of a Nod with no account joins with no session (F3)', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    const created = await admin.createPerson({ email: LOCAL_EMAIL, name: 'Bob Guild', roles: [] });
    const nod = newNod();
    expect((await nod.session.state()).hasAccount).toBe(false);

    const joined = await activateAs(running, nod, { email: LOCAL_EMAIL, code: created.code, password: NOD_PASSWORD });

    expect(joined).toMatchObject({ kind: 'session', personId: created.person.id, admin: false });
    expect(nod.repo.personById(created.person.id)?.name).toBe(LOCAL_EMAIL);
  });

  test('a wrong code is the join\'s one sentence, not a signed-out session (F7)', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    await admin.createPerson({ email: LOCAL_EMAIL, name: 'Bob Guild', roles: [] });
    const nod = newNod();

    // The cause, without the join around it: the host answers 401 (SP02 §5) and the client reads
    // every 401 as `signed-out` — a sentence about a session that was revoked.
    const pre = running.client.connect({
      address: running.address,
      kid: running.pin.kid,
      publicKey: running.pin.ed25519Public,
      personId: '',
    });
    expect(
      await messageOf(() =>
        pre.request('POST', HOST_ROUTES.authActivate, {
          email: LOCAL_EMAIL,
          code: 'ZZZZ-ZZZZ',
          salt: randomSalt(),
          authKey: randomAuthKey(),
          device: DEVICE,
        }),
      ),
    ).toBe('signed out');

    expect(
      await messageOf(() => activateAs(running, nod, { email: LOCAL_EMAIL, code: 'ZZZZ-ZZZZ', password: NOD_PASSWORD })),
    ).toBe('invalid code or password');
    expect(running.requests.at(-1)).toBe('POST /v1/auth/activate');
    // Neither a host row nor an account was written on the back of a refused join.
    expect(nod.repo.hostRecord()).toBeNull();
    expect((await nod.session.state()).hasAccount).toBe(false);
  });
});

describe('F2 — the snapshot decides the connected person\'s name and admin flag', () => {
  test('the first sync promotes the person the snapshot calls an admin, and a demotion takes it back', async () => {
    const running = await startHost();
    const { admin } = await adminOf(running);
    const created = await admin.createPerson({ email: LOCAL_EMAIL, name: 'Bob Guild', roles: ['admin'] });
    const nod = newNod();
    const joined = await activateAs(running, nod, { email: LOCAL_EMAIL, code: created.code, password: NOD_PASSWORD });

    // An access-code activation says nothing about the roles: the local row of a connected admin
    // starts without the flag, which is the state this finding is about.
    expect(joined).toMatchObject({ kind: 'session', personId: created.person.id, admin: false });
    expect(nod.session.current()?.admin).toBe(false);

    const state = await syncNod(running, nod, { id: created.person.id, token: joined.kind === 'session' ? joined.token : '' });
    expect(state.status).toBe('connected');
    // F2: the sync's own publish ran the reconcile — the admin screens are on.
    expect(nod.session.current()).toMatchObject({ id: created.person.id, name: 'Bob Guild', admin: true });

    // Demoted on the host: the next snapshot takes the flag back.
    await admin.setRoles(created.person.id, []);
    const after = await syncNod(running, nod, { id: created.person.id, token: joined.kind === 'session' ? joined.token : '' });
    expect(after.status).toBe('connected');
    expect(nod.session.current()).toMatchObject({ id: created.person.id, admin: false });
  });
});
