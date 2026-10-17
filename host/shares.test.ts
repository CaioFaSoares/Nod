// The block 2 host surface of E02 on the real app over a temp data dir (SP03 §3, SP06): the public
// keys, the shares and their lifecycle (`send`, accept, decline, expiry, update, revocation), the
// holders of a credential and the admin's assignments. Every request goes through
// `app.handle(new Request(...))` and every read of the host's own data goes to the database the app
// wrote — nothing here mocks the app, the repo, the guards or SQLite (`host/context.md`).
//
// The fixture is the real flow: the setup code makes the first admin, the admin group creates the
// people, the roles and the org tools, and each person redeems their code through
// `POST /v1/auth/activate` and puts their public keys on the host through `PUT /v1/keys`. Only the
// two rows no route can write yet — a `client` person (E04) and a `blocked` holder row (no route
// sets that scope) — are seeded through the repo or the database, and each one says so.
//
// Run with `bun test host/shares.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromBase64url, sha256Hex, toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  SNAPSHOT_SIGNATURE_HEADER,
  generateCode,
  normalizeCode,
  type Device,
  type ErrorResponse,
  type Holder,
  type MissingCopy,
  type PublicKeys,
  type ShareRequest,
  type Snapshot,
} from '../shared/host-api';
import { createApp } from './app';
import { DEFAULT_PORT, type HostConfig } from './config';
import { bootHost, type Host } from './main';
import { SHARE_TTL_MS, createRepo, type Repo } from './repo';

const DEVICE: Device = { name: 'nod-shares-test', os: 'macos', appVersion: '0.3.5' };

const ADMIN_EMAIL = 'ada@nod.test';
const ALICE_EMAIL = 'alice@nod.test';
const BOB_EMAIL = 'bob@nod.test';
const DANA_EMAIL = 'dana@nod.test';
const CARA_EMAIL = 'cara@nod.test';
const EVE_EMAIL = 'eve@nod.test';
const CLIENT_EMAIL = 'clint@nod.test';

const TEAM = 'team';
const OTHER_ROLE = 'other';

/** The org tool of the fixture. Apples to `team` and `other`; `kalendar` to `other` only. */
const TOOL = 'figma';
const OTHER_TOOL = 'kalendar';

const CREDENTIAL = '11111111-1111-4111-8111-111111111111';
const BLOCKED_CREDENTIAL = '22222222-2222-4222-8222-222222222222';

/** What a Nod would put inside the seal. The host must never hold either of them (RF-44). */
const USERNAME = 'alice@figma.test';
const SECRET = 'figma-password-do-not-store';

/** An opaque stand-in for SP06 §3's `body || sig`: the host never looks inside it. */
const SEALED = toBase64url(new TextEncoder().encode(`${USERNAME}:${SECRET}/for-bob`));
const UPDATED_SEALED = toBase64url(new TextEncoder().encode(`${USERNAME}:rotated/for-bob`));

// ---------------------------------------------------------------- the app under test

type HttpApp = { handle(request: Request): Promise<Response> };

type TestHost = {
  /** The real app of `host/app.ts`: every group, and the real guards on every route. */
  app: HttpApp;
  repo: Repo;
  /** The connection `bootHost` opened: its type comes from the boot, never from `bun:sqlite` here. */
  db: Host['db'];
  cleanup(): void;
};

const hosts: TestHost[] = [];
const dirs: string[] = [];

async function startHost(): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-shares-'));
  dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  const booted = await bootHost(config);
  const started: TestHost = {
    app: createApp({ config, db: booted.db }),
    repo: createRepo(booted.db),
    db: booted.db,
    cleanup: () => booted.close(),
  };
  hosts.push(started);
  return started;
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- requests

function call(
  host: TestHost,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = null,
): Promise<Response> {
  return host.app.handle(
    new Request(`http://nod.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const get = (host: TestHost, path: string, token: string | null = null) =>
  call(host, 'GET', path, undefined, token);
const post = (host: TestHost, path: string, body?: unknown, token: string | null = null) =>
  call(host, 'POST', path, body, token);
const put = (host: TestHost, path: string, body: unknown, token: string | null = null) =>
  call(host, 'PUT', path, body, token);
const patch = (host: TestHost, path: string, body: unknown, token: string | null = null) =>
  call(host, 'PATCH', path, body, token);
const del = (host: TestHost, path: string, token: string | null = null) =>
  call(host, 'DELETE', path, undefined, token);

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The `{ error }` body of SP03 §1, which is what every refusal below is asserted on. */
async function failure(response: Response): Promise<string> {
  return (await json<ErrorResponse>(response)).error;
}

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomBase64url = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
const instant = (): string => new Date().toISOString();

/** SP02 §3: a code the host would issue, seeded through the real repo (the admin route is H5's). */
async function seedCode(host: TestHost, kind: 'activate' | 'setup', personId: string | null) {
  const code = generateCode(kind === 'setup' ? 'setup' : 'access');
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('the generated code is not Crockford base32');
  host.repo.issueCode(
    { id: crypto.randomUUID(), purpose: kind, personId, codeHash: await sha256Hex(normalized) },
    instant(),
  );
  return code;
}

// ---------------------------------------------------------------- the fixture

/** One signed-in person with keys on the host: the token every request below carries. */
type Member = { personId: string; token: string; keys: PublicKeys };

type Guild = {
  host: TestHost;
  admin: Member;
  /** Owns the credential: the sender of every share below. */
  alice: Member;
  bob: Member;
  dana: Member;
  /** In `other` only: no role in common with Alice, and the tool is granted to her role. */
  cara: Member;
  /** `kind = 'client'` (E04), in `other`: the person SP06 §5 refuses an `org` share to. */
  client: Member;
};

async function activate(host: TestHost, email: string, code: string): Promise<Member> {
  const response = await post(host, HOST_ROUTES.authActivate, {
    email,
    code,
    salt: randomSalt(),
    authKey: randomBase64url(),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  const { token, personId } = await json<{ token: string; personId: string }>(response);
  const keys: PublicKeys = { x25519Public: randomBase64url(), ed25519Public: randomBase64url() };
  const stored = await put(host, HOST_ROUTES.keys, keys, token);
  expect(stored.status).toBe(204);
  return { personId, token, keys };
}

/** The first admin through the real setup route (SP03 §2), with keys of their own. */
async function setupAdmin(host: TestHost): Promise<Member> {
  const code = await seedCode(host, 'setup', null);
  const response = await post(host, HOST_ROUTES.authSetup, {
    email: ADMIN_EMAIL,
    name: 'Ada',
    code,
    salt: randomSalt(),
    authKey: randomBase64url(),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  const { token, personId } = await json<{ token: string; personId: string }>(response);
  const keys: PublicKeys = { x25519Public: randomBase64url(), ed25519Public: randomBase64url() };
  expect((await put(host, HOST_ROUTES.keys, keys, token)).status).toBe(204);
  return { personId, token, keys };
}

/** The admin creates the person; the code it answers is redeemed through the activation route. */
async function createPerson(
  host: TestHost,
  adminToken: string,
  input: { email: string; name: string; roles: string[] },
): Promise<{ personId: string; code: string }> {
  const response = await post(host, HOST_ROUTES.adminPeople, input, adminToken);
  expect(response.status).toBe(200);
  const created = await json<{ person: { id: string }; code: string }>(response);
  return { personId: created.person.id, code: created.code };
}

async function joinGuild(
  host: TestHost,
  adminToken: string,
  input: { email: string; name: string; roles: string[] },
): Promise<Member> {
  const created = await createPerson(host, adminToken, input);
  return await activate(host, input.email, created.code);
}

/** A client of E04: no admin route creates one, so the row is seeded through the repo (SP01 §2). */
async function joinClient(host: TestHost, roles: string[]): Promise<Member> {
  const person = host.repo.createPerson(
    { id: crypto.randomUUID(), email: CLIENT_EMAIL, name: 'Clint', kind: 'client', roles },
    instant(),
  );
  const code = await seedCode(host, 'activate', person.id);
  return await activate(host, CLIENT_EMAIL, code);
}

async function putRole(host: TestHost, adminToken: string, id: string): Promise<void> {
  const response = await put(
    host,
    HOST_ROUTES.adminRole.replace(':id', id),
    { name: id, admin: false },
    adminToken,
  );
  expect(response.status).toBe(200);
}

/** One org tool with its grants: `roles` is the entry's grant list (SP01 §2). */
async function putTool(
  host: TestHost,
  adminToken: string,
  id: string,
  roles: string[],
): Promise<void> {
  const response = await put(
    host,
    HOST_ROUTES.adminTool.replace(':id', id),
    {
      id,
      title: id,
      url: `https://${id}.example.test`,
      icon: null,
      order: 0,
      roles,
      views: [],
      auth: null,
      active: true,
    },
    adminToken,
  );
  expect(response.status).toBe(200);
}

/** Ada, the two `team` roles of the fixture and every person: five activations, all through routes. */
async function guild(): Promise<Guild> {
  const host = await startHost();
  const admin = await setupAdmin(host);
  await putRole(host, admin.token, TEAM);
  await putRole(host, admin.token, OTHER_ROLE);
  await putTool(host, admin.token, TOOL, [TEAM, OTHER_ROLE]);
  await putTool(host, admin.token, OTHER_TOOL, [OTHER_ROLE]);
  const alice = await joinGuild(host, admin.token, { email: ALICE_EMAIL, name: 'Alice', roles: [TEAM] });
  const bob = await joinGuild(host, admin.token, { email: BOB_EMAIL, name: 'Bob', roles: [TEAM] });
  const dana = await joinGuild(host, admin.token, { email: DANA_EMAIL, name: 'Dana', roles: [TEAM] });
  const cara = await joinGuild(host, admin.token, { email: CARA_EMAIL, name: 'Cara', roles: [OTHER_ROLE] });
  const client = await joinClient(host, [OTHER_ROLE]);
  return { host, admin, alice, bob, dana, cara, client };
}

// ---------------------------------------------------------------- shares

/** SP03 §3's body with the fixture's credential and tool; `overrides` change what a test is about. */
function shareBody(overrides: Partial<ShareRequest> = {}): ShareRequest {
  return {
    credentialId: CREDENTIAL,
    toolId: TOOL,
    scope: 'role',
    kind: 'send',
    items: [],
    ...overrides,
  };
}

const send = (host: TestHost, token: string, body: ShareRequest) =>
  post(host, HOST_ROUTES.shares, body, token);

const acceptPath = (id: string) => HOST_ROUTES.shareAccept.replace(':id', id);
const declinePath = (id: string) => HOST_ROUTES.shareDecline.replace(':id', id);
const holdersPath = (credentialId: string) => HOST_ROUTES.holders.replace(':id', credentialId);
const holderPath = (credentialId: string, personId: string) =>
  HOST_ROUTES.holder.replace(':id', credentialId).replace(':personId', personId);

/** The full happy path: the owner sends one sealed copy and the recipient accepts it (SP06 §4). */
async function sendAndAccept(
  host: TestHost,
  sender: Member,
  recipient: Member,
  sealed = SEALED,
): Promise<string> {
  const sent = await send(
    host,
    sender.token,
    shareBody({ items: [{ to: recipient.personId, sealed }] }),
  );
  expect(sent.status).toBe(200);
  const { ids } = await json<{ ids: string[] }>(sent);
  const accepted = await post(host, acceptPath(ids[0]), undefined, recipient.token);
  expect(accepted.status).toBe(204);
  return ids[0];
}

async function state(host: TestHost, token: string): Promise<Snapshot> {
  const response = await get(host, HOST_ROUTES.state, token);
  expect(response.status).toBe(200);
  return await json<Snapshot>(response);
}

// ---------------------------------------------------------------- database reads

type ShareRow = {
  id: string;
  credentialId: string;
  fromId: string;
  toId: string;
  toolId: string;
  scope: string;
  kind: string;
  sealed: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  purgedAt: string | null;
};

type HolderRow = {
  credentialId: string;
  personId: string;
  owner: number;
  scope: string;
  since: string;
  removedAt: string | null;
};

function shareRows(host: TestHost): ShareRow[] {
  return host.db
    .query<ShareRow, []>(
      `SELECT id, credential_id AS credentialId, from_id AS fromId, to_id AS toId,
              tool_id AS toolId, scope, kind, sealed, created_at AS createdAt,
              expires_at AS expiresAt, accepted_at AS acceptedAt, declined_at AS declinedAt,
              purged_at AS purgedAt
         FROM shares ORDER BY created_at, id`,
    )
    .all();
}

function holderRows(host: TestHost, credentialId: string): HolderRow[] {
  return host.db
    .query<HolderRow, [string]>(
      `SELECT credential_id AS credentialId, person_id AS personId, owner, scope, since,
              removed_at AS removedAt
         FROM credential_holders WHERE credential_id = ? ORDER BY owner DESC, since, person_id`,
    )
    .all(credentialId);
}

/**
 * A `blocked` holder row. No route writes that scope — a `blocked` share is refused whole (SP06 §5),
 * so the row exists to prove the host refuses a later share for that credential any way it got there.
 */
function seedBlockedOwner(host: TestHost, credentialId: string, personId: string): void {
  host.db
    .query(
      `INSERT INTO credential_holders
         (credential_id, person_id, tool_id, owner, scope, via_share_id, since)
       VALUES (?, ?, ?, 1, 'blocked', NULL, ?)`,
    )
    .run(credentialId, personId, TOOL, instant());
}

/** Every text value of every table of `host.db`: what a dump of the file would show (RF-44). */
function dump(host: TestHost): string[] {
  const values: string[] = [];
  const tables = host.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  for (const table of tables) {
    for (const row of host.db.query<Record<string, unknown>, []>(`SELECT * FROM "${table.name}"`).all()) {
      for (const value of Object.values(row)) if (typeof value === 'string') values.push(value);
    }
  }
  return values;
}

function captureConsole() {
  const lines: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? '')).join(' '));
  };
  Object.assign(console, { log: record, info: record, warn: record, error: record });
  return { lines, restore: () => Object.assign(console, originals) };
}

// ---------------------------------------------------------------- keys (SP03 §3, SP06 §2)

describe('PUT /v1/keys', () => {
  test('stores the pair, replaces it on a second call, and needs a session', async () => {
    const { host, alice } = await guild();

    expect(host.repo.personKeys(alice.personId)).toEqual(alice.keys);

    // SP06 §2: a reset generates new pairs and replaces what the host holds.
    const replacement: PublicKeys = {
      x25519Public: randomBase64url(),
      ed25519Public: randomBase64url(),
    };
    expect((await put(host, HOST_ROUTES.keys, replacement, alice.token)).status).toBe(204);
    expect(host.repo.personKeys(alice.personId)).toEqual(replacement);

    // The keys travel in the snapshot's roster, which is how a sender seals to somebody (SP06 §3).
    const roster = (await state(host, alice.token)).people ?? [];
    const mine = roster.find((person) => person.id === alice.personId);
    expect(mine?.x25519Public).toBe(replacement.x25519Public);
    expect(mine?.ed25519Public).toBe(replacement.ed25519Public);

    // A key that is not 32 bytes in base64url fails the schema (SP03 §1's 400), and 401 without a token.
    expect(
      (await put(host, HOST_ROUTES.keys, { x25519Public: 'short', ed25519Public: 'short' }, alice.token))
        .status,
    ).toBe(400);
    expect((await put(host, HOST_ROUTES.keys, replacement)).status).toBe(401);
  });
});

// ---------------------------------------------------------------- send (SP03 §3, SP06 §4)

describe('POST /v1/shares', () => {
  test('stores one sealed row per recipient and makes the sender the owner holder', async () => {
    const { host, alice, bob } = await guild();
    const response = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: bob.personId, sealed: SEALED }] }),
    );

    expect(response.status).toBe(200);
    const { ids } = await json<{ ids: string[] }>(response);
    expect(ids).toHaveLength(1);

    const [row] = shareRows(host);
    expect(row.id).toBe(ids[0]);
    expect(row.fromId).toBe(alice.personId);
    expect(row.toId).toBe(bob.personId);
    expect(row.toolId).toBe(TOOL);
    expect(row.scope).toBe('role');
    expect(row.kind).toBe('send');
    // SP06 §3: the host stores the sealed string it was handed, byte for byte.
    expect(row.sealed).toBe(SEALED);
    // SP01 §3: `expires_at = created_at + 14 days`, and nothing is accepted or purged yet.
    expect(row.expiresAt).toBe(new Date(Date.parse(row.createdAt) + SHARE_TTL_MS).toISOString());
    expect(row.acceptedAt).toBeNull();
    expect(row.declinedAt).toBeNull();
    expect(row.purgedAt).toBeNull();

    // SP06 §4: the sender becomes the owner holder, once, with the scope of the share.
    const holders = holderRows(host, CREDENTIAL);
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({
      personId: alice.personId,
      owner: 1,
      scope: 'role',
      since: row.createdAt,
      removedAt: null,
    });
    // The recipient's snapshot carries the share, and only the recipient's does (SP04 §2).
    const inbox = await state(host, bob.token);
    expect(inbox.incomingShares).toEqual([
      {
        id: ids[0],
        credentialId: CREDENTIAL,
        toolId: TOOL,
        from: alice.personId,
        scope: 'role',
        kind: 'send',
        sealed: SEALED,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      },
    ]);
    expect((await state(host, alice.token)).incomingShares).toEqual([]);

    // A second send to the same credential does not write a second owner row.
    expect(
      (
        await send(host, alice.token, shareBody({ items: [{ to: bob.personId, sealed: SEALED }] }))
      ).status,
    ).toBe(200);
    expect(holderRows(host, CREDENTIAL)).toHaveLength(1);
  });

  test('a dump of the database holds the sealed copy and no username or secret', async () => {
    const { host, alice, bob } = await guild();
    expect(
      (await send(host, alice.token, shareBody({ items: [{ to: bob.personId, sealed: SEALED }] })))
        .status,
    ).toBe(200);

    const values = dump(host);
    // The control: the scan really sees what the host wrote.
    expect(values).toContain(SEALED);
    // RF-44: neither the username nor the secret of the credential is anywhere in the file.
    expect(values.filter((value) => value.includes(USERNAME))).toEqual([]);
    expect(values.filter((value) => value.includes(SECRET))).toEqual([]);
  });

  test('refuses a role share with no role in common, and a tool the recipient cannot see', async () => {
    const { host, alice, bob, cara } = await guild();

    expect(
      (await send(host, alice.token, shareBody({ items: [{ to: bob.personId, sealed: SEALED }] })))
        .status,
    ).toBe(200);

    // Cara is in `other`: the tool is granted to her role, but she shares no role with Alice.
    const noCommon = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: cara.personId, sealed: SEALED }] }),
    );
    expect(noCommon.status).toBe(403);
    expect(await failure(noCommon)).toBe('no role in common');

    // `kalendar` is granted to `other` only: Bob cannot see it, so nothing may be sealed for him.
    const invisible = await send(
      host,
      alice.token,
      shareBody({ toolId: OTHER_TOOL, items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    expect(invisible.status).toBe(403);
    expect(await failure(invisible)).toBe('tool not visible to recipient');

    // An unknown tool is a 404, and none of the three refusals wrote a row.
    const unknown = await send(
      host,
      alice.token,
      shareBody({ toolId: 'nothing-here', items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    expect(unknown.status).toBe(404);
    expect(await failure(unknown)).toBe('unknown tool');
    expect(shareRows(host)).toHaveLength(1);
  });

  test('an org share reaches a granted member and never a client', async () => {
    const { host, alice, cara, client } = await guild();

    const member = await send(
      host,
      alice.token,
      shareBody({ scope: 'org', items: [{ to: cara.personId, sealed: SEALED }] }),
    );
    expect(member.status).toBe(200);

    // SP06 §5: a client never receives an `org` share (E04), even with the tool granted.
    const forClient = await send(
      host,
      alice.token,
      shareBody({ scope: 'org', items: [{ to: client.personId, sealed: SEALED }] }),
    );
    expect(forClient.status).toBe(403);
    expect(await failure(forClient)).toBe('org shares go to members only');
    expect(shareRows(host)).toHaveLength(1);
  });

  test('a blocked credential accepts no share at all', async () => {
    const { host, alice, bob } = await guild();

    const claimed = await send(
      host,
      alice.token,
      shareBody({ scope: 'blocked', items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    expect(claimed.status).toBe(403);
    expect(await failure(claimed)).toBe('the credential is blocked');

    seedBlockedOwner(host, BLOCKED_CREDENTIAL, alice.personId);
    const later = await send(
      host,
      alice.token,
      shareBody({ credentialId: BLOCKED_CREDENTIAL, items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    expect(later.status).toBe(403);
    expect(await failure(later)).toBe('the credential is blocked');
    expect(shareRows(host)).toHaveLength(0);
  });

  test('refuses an unknown, a disabled and a keyless recipient', async () => {
    const { host, admin, alice, bob } = await guild();

    const unknown = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: crypto.randomUUID(), sealed: SEALED }] }),
    );
    expect(unknown.status).toBe(404);
    expect(await failure(unknown)).toBe('unknown person');

    // Created but never activated: no keys, so there is nothing to seal a copy to (SP06 §2).
    const eve = await createPerson(host, admin.token, {
      email: EVE_EMAIL,
      name: 'Eve',
      roles: [TEAM],
    });
    const keyless = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: eve.personId, sealed: SEALED }] }),
    );
    expect(keyless.status).toBe(409);
    expect(await failure(keyless)).toBe('recipient has no keys');

    // Disabling takes the person out of the roster and kills their sessions (SP01 §2).
    expect(
      (
        await patch(
          host,
          HOST_ROUTES.adminPerson.replace(':id', bob.personId),
          { disabled: true },
          admin.token,
        )
      ).status,
    ).toBe(200);
    const toDisabled = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    expect(toDisabled.status).toBe(403);
    expect(await failure(toDisabled)).toBe('recipient is disabled');
    expect(shareRows(host)).toHaveLength(0);
  });

  test('an assignment belongs to an admin, and so does the missing list', async () => {
    const { host, bob } = await guild();
    const body = { credentialId: CREDENTIAL, roleId: TEAM, toolId: TOOL, assigned: true };

    const member = await put(host, HOST_ROUTES.adminAssignments, body, bob.token);
    expect(member.status).toBe(403);
    expect(await failure(member)).toBe('admin only');
    expect((await put(host, HOST_ROUTES.adminAssignments, body)).status).toBe(401);
    expect((await get(host, HOST_ROUTES.adminAssignmentsMissing, bob.token)).status).toBe(403);
  });
});

// ---------------------------------------------------------------- accept and decline (SP06 §4)

describe('answer a share', () => {
  test('accept purges the ciphertext, writes the holder row, and only its recipient may', async () => {
    const { host, alice, bob, cara } = await guild();
    const sent = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    const { ids } = await json<{ ids: string[] }>(sent);

    // Someone else's share: `403`, and the row keeps its ciphertext.
    const stolen = await post(host, acceptPath(ids[0]), undefined, cara.token);
    expect(stolen.status).toBe(403);
    expect(await failure(stolen)).toBe('not yours');
    expect(shareRows(host)[0].sealed).toBe(SEALED);

    const accepted = await post(host, acceptPath(ids[0]), undefined, bob.token);
    expect(accepted.status).toBe(204);

    const [row] = shareRows(host);
    expect(row.sealed).toBe('');
    expect(row.acceptedAt).not.toBeNull();
    expect(row.purgedAt).toBe(row.acceptedAt);

    // Both sides now list both people, with the date and the scope (RF-54).
    const expectedHolders: Holder[] = [
      expect.objectContaining({ personId: alice.personId, name: 'Alice', owner: true, scope: 'role' }),
      expect.objectContaining({ personId: bob.personId, name: 'Bob', owner: false, scope: 'role' }),
    ];
    const bobState = await state(host, bob.token);
    expect(bobState.incomingShares).toEqual([]);
    expect(bobState.holders?.[CREDENTIAL]).toEqual(expectedHolders);
    expect((await state(host, alice.token)).holders?.[CREDENTIAL]).toHaveLength(2);

    // The same share cannot be accepted twice.
    const again = await post(host, acceptPath(ids[0]), undefined, bob.token);
    expect(again.status).toBe(409);
    expect(await failure(again)).toBe('share is not open');
  });

  test('decline purges the ciphertext and leaves the credential without a holder', async () => {
    const { host, alice, bob } = await guild();
    const sent = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    const { ids } = await json<{ ids: string[] }>(sent);

    expect((await post(host, declinePath(ids[0]), undefined, bob.token)).status).toBe(204);

    const [row] = shareRows(host);
    expect(row.sealed).toBe('');
    expect(row.declinedAt).not.toBeNull();
    expect(row.purgedAt).toBe(row.declinedAt);
    expect(row.acceptedAt).toBeNull();

    const bobState = await state(host, bob.token);
    expect(bobState.incomingShares).toEqual([]);
    expect(bobState.holders).toEqual({});
    expect(bobState.rotationPending).toEqual([]);
    // The owner keeps their own row, and has nothing to rotate.
    expect((await state(host, alice.token)).rotationPending).toEqual([]);

    const again = await post(host, declinePath(ids[0]), undefined, bob.token);
    expect(again.status).toBe(409);
  });

  test('an expired share is purged by a read and never travels', async () => {
    const { host, alice, bob } = await guild();
    const sent = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    const { ids } = await json<{ ids: string[] }>(sent);

    // SP06 §4's 14 days, moved back: no test waits for them.
    host.db
      .query('UPDATE shares SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), ids[0]);

    const inbox = await state(host, bob.token);
    expect(inbox.incomingShares).toEqual([]);
    const [row] = shareRows(host);
    expect(row.sealed).toBe('');
    expect(row.purgedAt).not.toBeNull();
    expect(row.acceptedAt).toBeNull();

    // Accepting it afterwards is the conflict of a share that is not open.
    const late = await post(host, acceptPath(ids[0]), undefined, bob.token);
    expect(late.status).toBe(409);
    expect(await failure(late)).toBe('share is not open');
  });

  test('an update comes from the owner holder to current holders only', async () => {
    const { host, alice, bob, dana, cara } = await guild();
    await sendAndAccept(host, alice, bob);
    await sendAndAccept(host, alice, dana, UPDATED_SEALED);

    // A holder who is not the owner cannot re-share the credential as an update.
    const fromBob = await send(
      host,
      bob.token,
      shareBody({ kind: 'update', items: [{ to: dana.personId, sealed: SEALED }] }),
    );
    expect(fromBob.status).toBe(403);
    expect(await failure(fromBob)).toBe('not the owner');

    // A recipient who never held it: the scope check passes, the holder check does not.
    const toStranger = await send(
      host,
      alice.token,
      shareBody({ kind: 'update', scope: 'org', items: [{ to: cara.personId, sealed: SEALED }] }),
    );
    expect(toStranger.status).toBe(403);
    expect(await failure(toStranger)).toBe('not a holder');

    // SP06 §4: the owner re-seals to the holders, who find it in their next snapshot.
    const rotated = toBase64url(new TextEncoder().encode(`${USERNAME}:rotated-again/for-bob`));
    const update = await send(
      host,
      alice.token,
      shareBody({ kind: 'update', items: [{ to: bob.personId, sealed: rotated }] }),
    );
    expect(update.status).toBe(200);
    const inbox = await state(host, bob.token);
    expect(inbox.incomingShares).toHaveLength(1);
    expect(inbox.incomingShares?.[0]).toMatchObject({
      credentialId: CREDENTIAL,
      kind: 'update',
      from: alice.personId,
      sealed: rotated,
    });
  });
});

// ---------------------------------------------------------------- holders (SP03 §3, RF-54)

describe('holders of a credential', () => {
  test('are visible to a holder and to the admin, refused to anyone else', async () => {
    const { host, admin, alice, bob, cara } = await guild();
    await sendAndAccept(host, alice, bob);

    const byOwner = await get(host, holdersPath(CREDENTIAL), alice.token);
    expect(byOwner.status).toBe(200);
    expect(await json<Holder[]>(byOwner)).toEqual([
      expect.objectContaining({ personId: alice.personId, owner: true }),
      expect.objectContaining({ personId: bob.personId, owner: false }),
    ]);

    // The holder sees the same list (RF-54), and the admin sees every credential of the guild.
    expect((await get(host, holdersPath(CREDENTIAL), bob.token)).status).toBe(200);
    expect((await get(host, holdersPath(CREDENTIAL), admin.token)).status).toBe(200);

    // Someone who neither holds it nor administers it: 403, and 401 without a session.
    const outsider = await get(host, holdersPath(CREDENTIAL), cara.token);
    expect(outsider.status).toBe(403);
    expect(await failure(outsider)).toBe('not yours');
    expect((await get(host, holdersPath(CREDENTIAL))).status).toBe(401);

    // An admin asking about a credential nobody holds gets the 404 of SP03 §1.
    const unknown = await get(host, holdersPath(crypto.randomUUID()), admin.token);
    expect(unknown.status).toBe(404);
    expect(await failure(unknown)).toBe('unknown credential');
  });

  test('removing one marks the credential rotation pending until the remaining holders get an update', async () => {
    const { host, admin, alice, bob, dana } = await guild();
    await sendAndAccept(host, alice, bob);
    await sendAndAccept(host, alice, dana, UPDATED_SEALED);

    // A holder who is not the owner cannot revoke anybody.
    const byBob = await del(host, holderPath(CREDENTIAL, dana.personId), bob.token);
    expect(byBob.status).toBe(403);
    expect(await failure(byBob)).toBe('not yours');
    // Nor can anyone remove the owner row: that is the credential's anchor (SP06 §4).
    const owner = await del(host, holderPath(CREDENTIAL, alice.personId), alice.token);
    expect(owner.status).toBe(409);
    expect(await failure(owner)).toBe('the owner cannot be removed');
    expect((await del(host, holderPath(CREDENTIAL, crypto.randomUUID()), admin.token)).status).toBe(
      404,
    );

    // RF-48: the owner revokes Bob, and the credential turns rotation pending for them.
    expect((await del(host, holderPath(CREDENTIAL, bob.personId), alice.token)).status).toBe(204);
    const revoked = await state(host, alice.token);
    expect(revoked.rotationPending).toEqual([CREDENTIAL]);
    // The row stays, with its date: that is what the holders list shows as removed.
    const listed = await json<Holder[]>(await get(host, holdersPath(CREDENTIAL), alice.token));
    expect(listed.find((holder) => holder.personId === bob.personId)?.removedAt).not.toBeNull();
    // Bob no longer holds it, so his snapshot carries no holders and no incoming share.
    expect((await state(host, bob.token)).holders).toEqual({});
    // A second removal of the same row is a conflict, and a removed holder receives no update.
    expect((await del(host, holderPath(CREDENTIAL, bob.personId), alice.token)).status).toBe(409);
    expect(
      (
        await send(
          host,
          alice.token,
          shareBody({ kind: 'update', items: [{ to: bob.personId, sealed: SEALED }] }),
        )
      ).status,
    ).toBe(403);

    // An admin may revoke as well; the credential is still pending, nobody having updated it.
    expect((await del(host, holderPath(CREDENTIAL, dana.personId), admin.token)).status).toBe(204);
    expect((await state(host, alice.token)).rotationPending).toEqual([CREDENTIAL]);

    // SP06 §4: the owner saves a new secret — a fresh copy to Dana, then the update to every holder —
    // and the state clears once that update exists.
    const fresh = await send(
      host,
      alice.token,
      shareBody({ items: [{ to: dana.personId, sealed: SEALED }] }),
    );
    expect(fresh.status).toBe(200);
    const { ids } = await json<{ ids: string[] }>(fresh);
    expect((await post(host, acceptPath(ids[0]), undefined, dana.token)).status).toBe(204);
    expect((await state(host, alice.token)).rotationPending).toEqual([CREDENTIAL]);

    const update = await send(
      host,
      alice.token,
      shareBody({ kind: 'update', items: [{ to: dana.personId, sealed: UPDATED_SEALED }] }),
    );
    expect(update.status).toBe(200);
    expect((await state(host, alice.token)).rotationPending).toEqual([]);
  });
});

// ---------------------------------------------------------------- assignments (SP03 §3, RF-47)

describe('assignments', () => {
  test('a role assignment lists its members until each of them holds a copy', async () => {
    const { host, admin, alice, bob, dana } = await guild();
    const assignment = {
      credentialId: CREDENTIAL,
      roleId: TEAM,
      toolId: TOOL,
      assigned: true,
    };
    expect((await put(host, HOST_ROUTES.adminAssignments, assignment, admin.token)).status).toBe(204);
    // Upsert: the same assignment twice leaves one row and one line per member.
    expect((await put(host, HOST_ROUTES.adminAssignments, assignment, admin.token)).status).toBe(204);

    const missing = await json<MissingCopy[]>(
      await get(host, HOST_ROUTES.adminAssignmentsMissing, admin.token),
    );
    // One line per member of the role — the order is the query's, so the ids are compared as a set.
    expect(missing.map((row) => row.personId).sort()).toEqual(
      [alice.personId, bob.personId, dana.personId].sort(),
    );
    expect(missing).toContainEqual({
      credentialId: CREDENTIAL,
      toolId: TOOL,
      roleId: TEAM,
      personId: bob.personId,
    });

    // The admin's Bond seals one copy to Bob with `kind: 'assign'` (SP06 §4), and he accepts it.
    //
    // The scope is the admin's choice (SP06 §5) and the host checks it per item like any other
    // share: Ada is not in `team`, so a `role` scope would need a role the admin and Bob share and
    // would be refused with `no role in common`. An assignment of a whole role therefore travels as
    // `org` — a reading of SP06 §4–§5 reported in `docs/handovers/k3-host-shares.md`.
    const assigned = await send(
      host,
      admin.token,
      shareBody({ kind: 'assign', scope: 'org', items: [{ to: bob.personId, sealed: SEALED }] }),
    );
    expect(assigned.status).toBe(200);
    const { ids } = await json<{ ids: string[] }>(assigned);
    expect((await post(host, acceptPath(ids[0]), undefined, bob.token)).status).toBe(204);

    // A new member of `team` appears once they have keys on the host, and leaves when disabled.
    const eve = await createPerson(host, admin.token, {
      email: EVE_EMAIL,
      name: 'Eve',
      roles: [TEAM],
    });
    const listOf = async (): Promise<string[]> =>
      (
        await json<MissingCopy[]>(
          await get(host, HOST_ROUTES.adminAssignmentsMissing, admin.token),
        )
      )
        .map((row) => row.personId)
        .sort();
    expect(await listOf()).toEqual([alice.personId, dana.personId].sort());
    await activate(host, EVE_EMAIL, eve.code);
    expect(await listOf()).toEqual([alice.personId, dana.personId, eve.personId].sort());
    expect(
      (
        await patch(
          host,
          HOST_ROUTES.adminPerson.replace(':id', eve.personId),
          { disabled: true },
          admin.token,
        )
      ).status,
    ).toBe(200);
    expect(await listOf()).toEqual([alice.personId, dana.personId].sort());

    // `assigned: false` takes the role out of the list entirely.
    expect(
      (
        await put(
          host,
          HOST_ROUTES.adminAssignments,
          { ...assignment, assigned: false },
          admin.token,
        )
      ).status,
    ).toBe(204);
    expect(await listOf()).toEqual([]);
  });
});

// ---------------------------------------------------------------- snapshot (SP04 §2)

describe('the snapshot of block 2 (SP04 §2)', () => {
  test('carries the roster, the inbox and the holders inside the signed bytes', async () => {
    const { host, alice, bob } = await guild();
    await sendAndAccept(host, alice, bob);

    const response = await get(host, HOST_ROUTES.state, bob.token);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Snapshot;

    // The roster is the whole guild, with the keys of everybody who has them.
    const ids = (snapshot.people ?? []).map((person) => person.id);
    expect(ids).toContain(alice.personId);
    expect(ids).toContain(bob.personId);
    expect((snapshot.people ?? []).every((person) => person.x25519Public !== undefined)).toBe(true);
    expect(snapshot.holders?.[CREDENTIAL]).toHaveLength(2);
    expect(snapshot.incomingShares).toEqual([]);
    expect(snapshot.rotationPending).toEqual([]);

    // SP04 §2: the whole body is signed, so these four fields are as signed as `me` is.
    const discovery = await json<{ key: { kid: string; ed25519Public: string } }>(
      await get(host, HOST_ROUTES.discovery),
    );
    const header = response.headers.get(SNAPSHOT_SIGNATURE_HEADER) ?? '';
    const signature = /kid=(?<kid>[^;]+); sig=(?<sig>.+)/.exec(header)?.groups ?? {};
    expect(signature.kid).toBe(discovery.key.kid);
    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64url(discovery.key.ed25519Public),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        fromBase64url(String(signature.sig)),
        bytes,
      ),
    ).toBe(true);
  });

  test('never logs a value of a body', async () => {
    const { host, alice, bob } = await guild();
    const captured = captureConsole();
    try {
      expect(
        (await send(host, alice.token, shareBody({ items: [{ to: bob.personId, sealed: SEALED }] })))
          .status,
      ).toBe(200);
      expect(
        (
          await send(
            host,
            alice.token,
            shareBody({ scope: 'blocked', items: [{ to: bob.personId, sealed: SEALED }] }),
          )
        ).status,
      ).toBe(403);
    } finally {
      captured.restore();
    }
    const logged = captured.lines.join('\n');
    expect(logged).not.toContain(SEALED);
    expect(logged).not.toContain(USERNAME);
    expect(logged).not.toContain(SECRET);
  });
});
