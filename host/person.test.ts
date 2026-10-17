// H7 and O1's person surface on the real Elysia app over a temp data dir (SP03 §1–§2, SP04 §4): the
// caller's own device sessions, their personal tools, their personal views and their favorites.
// Every request goes through `app.handle(new Request(...))` and every read of what the host holds
// goes to the database the app wrote: nothing here mocks the repo, the guards or the app. Run with
// `bun test host/person.test.ts`.
//
// The flow of the fixture is the real one: `POST /v1/auth/setup` makes the first admin, the admin
// group creates the people, and each person redeems the code through `POST /v1/auth/activate` (and
// signs in again through `POST /v1/auth/login` for a second device) — so a test only ever passes
// through a route that exists. Only the org catalog this group does not write is seeded through the
// repo, and each seeding says so.
//
// What the file proves, beyond the statuses: no answer of this group carries a session token hash,
// and no answer anywhere carries another person's personal data — the admin's snapshot is empty of
// it even while the person's own is full.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  generateCode,
  normalizeCode,
  type Device,
  type DeviceSession,
  type ErrorResponse,
  type PersonalTool,
  type PersonalView,
  type Snapshot,
} from '../shared/host-api';
import { createApp } from './app';
import { INVALID_CREDENTIALS } from './auth';
import { loadConfig } from './config';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';

const DEVICE: Device = { name: 'nod-person-test', os: 'macos', appVersion: '0.3.5' };
const SECOND_DEVICE: Device = { name: 'nod-person-test-2', os: 'linux', appVersion: '0.3.5' };
const ADMIN_EMAIL = 'ada@nod.test';
const MEMBER_EMAIL = 'bob@nod.test';
const OTHER_EMAIL = 'cara@nod.test';
const BOB_TOOL = 'p-bobnotes01';
const CARA_TOOL = 'p-caranote01';
const SECOND_MS = 1000;

/** What a test needs from an app: Elysia's answer to one `Request`. */
type HttpApp = { handle(request: Request): Promise<Response> };

type TestHost = {
  /** The real app of `host/app.ts`: every group mounted, the real guards on every route. */
  app: HttpApp;
  repo: Repo;
  /** The connection `bootHost` opened: its type comes from the boot, never from `bun:sqlite` here. */
  db: Host['db'];
  cleanup(): void;
};

/** One signed-in device: the token, the person, and the two values a second sign-in needs. */
type SignedIn = { token: string; personId: string; email: string; salt: string; authKey: string };

const hosts: TestHost[] = [];
const dirs: string[] = [];

async function startHost(): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-person-'));
  dirs.push(dir);
  // The environment of a real boot, minus the two deployment values nothing here reads: the point of
  // this file is the person surface, and `host/meta.test.ts` covers `NOD_MIN_APP_VERSION`.
  const config = loadConfig({ NOD_DATA: dir, NOD_PUBLIC_URL: 'https://nod.example' });
  const host = await bootHost(config);
  const started: TestHost = {
    app: createApp({ config, db: host.db }),
    repo: createRepo(host.db),
    db: host.db,
    cleanup: () => host.close(),
  };
  hosts.push(started);
  return started;
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

/** One request of any method; a body is JSON, the token goes in `Authorization` (SP02 §5). */
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
const post = (host: TestHost, path: string, body: unknown, token: string | null = null) =>
  call(host, 'POST', path, body, token);
const put = (host: TestHost, path: string, body: unknown, token: string | null = null) =>
  call(host, 'PUT', path, body, token);
const remove = (host: TestHost, path: string, body?: unknown, token: string | null = null) =>
  call(host, 'DELETE', path, body, token);

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomAuthKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
const instant = (): string => new Date().toISOString();
/** A write time `ms` after now: what a replay of SP04 §4 carries. */
const after = (ms: number): string => new Date(Date.now() + ms).toISOString();

const toolPath = (id: string): string => HOST_ROUTES.personalTool.replace(':id', id);
const viewPath = (id: string): string => HOST_ROUTES.personalView.replace(':id', id);
const sessionPath = (id: string): string => HOST_ROUTES.session.replace(':id', id);

/** SP03 §2's `PersonalTool` body = `Entry` + `updatedAt`, with the fields a test wants changed. */
function tool(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: id,
    url: `https://${id}.example.test`,
    icon: null,
    order: 0,
    roles: [],
    views: [],
    auth: null,
    active: true,
    updatedAt: instant(),
    ...overrides,
  };
}

/** SP03 §2's `PersonalView` body, with the fields a test wants changed. */
function view(
  id: string,
  entryId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    entryId,
    label: 'Board',
    url: `https://${entryId}.example.test/board`,
    mode: 'window',
    updatedAt: instant(),
    ...overrides,
  };
}

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

/** The first admin, through the real setup route: the token every admin call below carries. */
async function setupAdmin(host: TestHost): Promise<SignedIn> {
  const code = await seedCode(host, 'setup', null);
  const email = ADMIN_EMAIL;
  const salt = randomSalt();
  const authKey = randomAuthKey();
  const response = await post(host, HOST_ROUTES.authSetup, {
    email,
    name: 'Ada',
    code,
    salt,
    authKey,
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  const { token, personId } = await body<{ token: string; personId: string }>(response);
  return { token, personId, email, salt, authKey };
}

/** One person created by the admin route, and the code that came with them (SP02 §3). */
async function createPerson(
  host: TestHost,
  adminToken: string,
  email: string,
  name: string,
): Promise<string> {
  const response = await post(host, HOST_ROUTES.adminPeople, { email, name, roles: [] }, adminToken);
  expect(response.status).toBe(200);
  const created = await body<{ person: { id: string }; code: string }>(response);
  return created.code;
}

/** Redeems a code through the real activation route, and signs in a second device (SP02 §5). */
async function signIn(host: TestHost, email: string, code: string): Promise<SignedIn> {
  const salt = randomSalt();
  const authKey = randomAuthKey();
  const activated = await post(host, HOST_ROUTES.authActivate, {
    email,
    code,
    salt,
    authKey,
    device: DEVICE,
  });
  expect(activated.status).toBe(200);
  const first = await body<{ token: string; personId: string }>(activated);

  const loggedIn = await post(host, HOST_ROUTES.authLogin, { email, authKey, device: SECOND_DEVICE });
  expect(loggedIn.status).toBe(200);
  const second = await body<{ token: string; personId: string }>(loggedIn);
  expect(second.personId).toBe(first.personId);
  // The token of the second device: the tests below revoke the first and keep this one, which is
  // what makes "the revoked device answers 401 while the other still works" one assertion.
  return { token: second.token, personId: first.personId, email, salt, authKey };
}

/** The token of the first device, for the revoke tests (`signIn` answers the second one). */
async function firstDeviceToken(host: TestHost, me: SignedIn): Promise<string> {
  const again = await post(host, HOST_ROUTES.authLogin, {
    email: me.email,
    authKey: me.authKey,
    device: { ...SECOND_DEVICE, name: 'nod-person-test-3' },
  });
  expect(again.status).toBe(200);
  return (await body<{ token: string }>(again)).token;
}

/** The caller's own snapshot (`GET /v1/state`, SP04 §2): what travels to their Nod alone. */
async function snapshot(host: TestHost, token: string): Promise<Snapshot> {
  const response = await get(host, HOST_ROUTES.state, token);
  expect(response.status).toBe(200);
  return await body<Snapshot>(response);
}

// ---------------------------------------------------------------- sessions (O1)

describe('device sessions', () => {
  test('lists the caller’s own live sessions and never their token hashes', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const code = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, code);

    const response = await get(host, HOST_ROUTES.sessions, bob.token);
    expect(response.status).toBe(200);
    const sessions = await body<DeviceSession[]>(response);
    // Two devices: the activation and the sign-in (SP02 §5).
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.personId === bob.personId)).toBe(true);
    expect(sessions.map((session) => session.device.name).sort()).toEqual([
      DEVICE.name,
      SECOND_DEVICE.name,
    ]);
    // SP02 §5: the row keeps the token hash; the wire shape has no field for it.
    const raw = JSON.stringify(sessions);
    for (const secret of ['token', 'hash']) expect(raw.includes(secret)).toBe(false);

    // The admin's own list is their own: nobody's sessions travel in another person's answer.
    const adminList = await body<DeviceSession[]>(await get(host, HOST_ROUTES.sessions, admin.token));
    expect(adminList.map((session) => session.device.name)).toEqual([DEVICE.name]);
    expect(adminList.every((session) => session.personId === admin.personId)).toBe(true);

    // SP03 §1: the person level is the guard, so no token is a 401 like any other.
    const anonymous = await get(host, HOST_ROUTES.sessions);
    expect(anonymous.status).toBe(401);
    expect(await body<ErrorResponse>(anonymous)).toEqual({ error: INVALID_CREDENTIALS });
  });

  test('revokes the caller’s own session, and that device answers 401 at its next request', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const code = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, code);
    const doomed = await firstDeviceToken(host, bob);

    const sessions = await body<DeviceSession[]>(await get(host, HOST_ROUTES.sessions, bob.token));
    const target = sessions.find((session) => session.device.name === 'nod-person-test-3');
    expect(target).toBeDefined();

    const revoked = await remove(host, sessionPath(target!.id), undefined, bob.token);
    expect(revoked.status).toBe(204);
    // The device is signed out: the token no longer resolves (SP02 §5), and the other one still does.
    const dead = await get(host, HOST_ROUTES.sessions, doomed);
    expect(dead.status).toBe(401);
    expect(await body<ErrorResponse>(dead)).toEqual({ error: INVALID_CREDENTIALS });
    expect((await get(host, HOST_ROUTES.sessions, bob.token)).status).toBe(200);
    // Already revoked: a no-op 204, never an error (the admin route treats it the same way).
    expect((await remove(host, sessionPath(target!.id), undefined, bob.token)).status).toBe(204);
    expect(await body<DeviceSession[]>(await get(host, HOST_ROUTES.sessions, bob.token))).toHaveLength(2);
  });

  test('refuses another person’s session with 403 and an unknown one with 404', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const bobCode = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, bobCode);
    const caraCode = await createPerson(host, admin.token, OTHER_EMAIL, 'Cara');
    await signIn(host, OTHER_EMAIL, caraCode);

    const caraId = (await body<Array<{ id: string; email: string }>>(
      await get(host, HOST_ROUTES.adminPeople, admin.token),
    )).find((person) => person.email === OTHER_EMAIL)!.id;
    const caraSessions = await body<DeviceSession[]>(
      await get(host, HOST_ROUTES.adminPersonSessions.replace(':id', caraId), admin.token),
    );
    expect(caraSessions.length).toBeGreaterThan(0);

    const forbidden = await remove(host, sessionPath(caraSessions[0]!.id), undefined, bob.token);
    expect(forbidden.status).toBe(403);
    expect(await body<ErrorResponse>(forbidden)).toEqual({ error: 'not yours' });
    // The other person's session is untouched by the refused call.
    expect(
      await body<DeviceSession[]>(
        await get(host, HOST_ROUTES.adminPersonSessions.replace(':id', caraId), admin.token),
      ),
    ).toHaveLength(caraSessions.length);

    const unknown = await remove(host, sessionPath(crypto.randomUUID()), undefined, bob.token);
    expect(unknown.status).toBe(404);
    expect(await body<ErrorResponse>(unknown)).toEqual({ error: 'unknown session' });
  });
});

// ---------------------------------------------------------------- personal tools (H7)

describe('personal tools', () => {
  test('upserts one the caller owns, keeps the newest write and refuses a stale one', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const code = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, code);

    const created = await put(host, toolPath(BOB_TOOL), tool(BOB_TOOL, { title: 'Notes' }), bob.token);
    expect(created.status).toBe(200);
    const stored = await body<PersonalTool>(created);
    expect(stored).toMatchObject({
      id: BOB_TOOL,
      scope: 'personal',
      ownerId: bob.personId,
      title: 'Notes',
      order: 0,
      roles: [],
      views: [],
      active: true,
    });
    expect(Number.isNaN(Date.parse(stored.updatedAt))).toBe(false);

    // SP04 §4: an older write loses to the stored row (409) and never reaches the database.
    const stale = await put(
      host,
      toolPath(BOB_TOOL),
      tool(BOB_TOOL, { title: 'Older', updatedAt: after(-10_000) }),
      bob.token,
    );
    expect(stale.status).toBe(409);
    expect(await body<ErrorResponse>(stale)).toEqual({ error: 'stale updatedAt' });
    const unchanged = await snapshot(host, bob.token);
    expect(unchanged.personalTools[0]?.title).toBe('Notes');

    // A newer one wins, and the answer is the stored row.
    const newer = await put(
      host,
      toolPath(BOB_TOOL),
      tool(BOB_TOOL, { title: 'Newer', order: 3, updatedAt: after(SECOND_MS) }),
      bob.token,
    );
    expect(newer.status).toBe(200);
    const updated = await body<PersonalTool>(newer);
    expect(updated).toMatchObject({ title: 'Newer', order: 3 });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(stored.updatedAt));
  });

  test('answers 400 for an id the Nod cannot generate', async () => {
    const host = await startHost();
    const code = await createPerson(host, (await setupAdmin(host)).token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, code);

    for (const bad of ['p-short', 'p-ABC1234567', 'notes', 'p-bobnotes01x']) {
      const response = await put(host, toolPath(bad), tool(BOB_TOOL), bob.token);
      expect(response.status).toBe(400);
      // SP03 §1: the message names the field — and never the value that failed.
      expect((await body<ErrorResponse>(response)).error).toContain('id');
    }
    // The path is what decides: a body naming another id is a body that fails its contract.
    const mismatch = await put(host, toolPath(BOB_TOOL), tool(CARA_TOOL), bob.token);
    expect(mismatch.status).toBe(400);
    expect(await body<ErrorResponse>(mismatch)).toEqual({
      error: 'invalid body: id must match the path id',
    });
  });

  test('refuses the id of another person with 403, and removes the owner’s own with 204', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const bobCode = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, bobCode);
    const caraCode = await createPerson(host, admin.token, OTHER_EMAIL, 'Cara');
    const cara = await signIn(host, OTHER_EMAIL, caraCode);

    // Cara's tool exists because Cara wrote it: the owner is the caller, never a body field.
    expect(
      (await put(host, toolPath(CARA_TOOL), tool(CARA_TOOL, { title: 'Cara only' }), cara.token)).status,
    ).toBe(200);

    const refused = await put(host, toolPath(CARA_TOOL), tool(CARA_TOOL, { title: 'Mine now' }), bob.token);
    expect(refused.status).toBe(403);
    expect(await body<ErrorResponse>(refused)).toEqual({ error: 'not yours' });
    const refusedDelete = await remove(
      host,
      toolPath(CARA_TOOL),
      { updatedAt: after(SECOND_MS) },
      bob.token,
    );
    expect(refusedDelete.status).toBe(403);
    expect((await snapshot(host, cara.token)).personalTools[0]?.title).toBe('Cara only');

    // An id no query ever sees is 404 (SP03 §1, `host/context.md`).
    const unknown = await remove(
      host,
      toolPath(BOB_TOOL),
      { updatedAt: after(SECOND_MS) },
      bob.token,
    );
    expect(unknown.status).toBe(404);
    expect(await body<ErrorResponse>(unknown)).toEqual({ error: 'unknown tool' });

    // Written first, then removed: the older body is the 409 of a stale write, the newest the 204.
    const own = await put(host, toolPath(BOB_TOOL), tool(BOB_TOOL), bob.token);
    expect(own.status).toBe(200);
    // SP03 §1: the delete's body carries the write time, and a body that is not one is a 400 — the
    // schema is validated on `DELETE` too, never a handler reading `undefined`.
    const noBody = await remove(host, toolPath(BOB_TOOL), undefined, bob.token);
    expect(noBody.status).toBe(400);
    expect(await body<ErrorResponse>(noBody)).toEqual({ error: 'invalid body: must be object' });
    const noTime = await remove(host, toolPath(BOB_TOOL), {}, bob.token);
    expect(noTime.status).toBe(400);
    expect((await body<ErrorResponse>(noTime)).error).toContain('updatedAt');
    const stale = await remove(host, toolPath(BOB_TOOL), { updatedAt: after(-10_000) }, bob.token);
    expect(stale.status).toBe(409);
    const removed = await remove(host, toolPath(BOB_TOOL), { updatedAt: after(SECOND_MS) }, bob.token);
    expect(removed.status).toBe(204);
    expect((await snapshot(host, bob.token)).personalTools).toEqual([]);
  });
});

// ---------------------------------------------------------------- personal views and favorites (H7)

describe('personal views and favorites', () => {
  test('hangs a view under an entry the owner can see, and refuses one they cannot', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const bobCode = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, bobCode);
    const caraCode = await createPerson(host, admin.token, OTHER_EMAIL, 'Cara');
    const cara = await signIn(host, OTHER_EMAIL, caraCode);
    await put(host, toolPath(CARA_TOOL), tool(CARA_TOOL), cara.token);
    await put(host, toolPath(BOB_TOOL), tool(BOB_TOOL), bob.token);

    const viewId = crypto.randomUUID();
    const created = await put(host, viewPath(viewId), view(viewId, BOB_TOOL), bob.token);
    expect(created.status).toBe(200);
    const stored = await body<PersonalView>(created);
    expect(stored).toMatchObject({ id: viewId, entryId: BOB_TOOL, label: 'Board', mode: 'window' });
    expect(Number.isNaN(Date.parse(stored.updatedAt))).toBe(false);

    // The view a write carries has to name the path: the route answers the 400 of SP03 §1.
    const mismatch = await put(host, viewPath(viewId), view(crypto.randomUUID(), BOB_TOOL), bob.token);
    expect(mismatch.status).toBe(400);

    // SP01 §2: a personal view only hangs under an entry its owner can see.
    const invisibleId = crypto.randomUUID();
    const invisible = await put(
      host,
      viewPath(invisibleId),
      view(invisibleId, CARA_TOOL),
      bob.token,
    );
    expect(invisible.status).toBe(403);
    expect(await body<ErrorResponse>(invisible)).toEqual({ error: 'not yours' });

    const stale = await put(
      host,
      viewPath(viewId),
      view(viewId, BOB_TOOL, { updatedAt: after(-10_000) }),
      bob.token,
    );
    expect(stale.status).toBe(409);

    // The snapshot carries the view under its entry, then without it after the delete (SP04 §2).
    const withView = await snapshot(host, bob.token);
    expect(withView.personalViews.map((entry) => entry.id)).toEqual([viewId]);
    expect(withView.personalTools[0]?.views.map((entry) => entry.id)).toEqual([viewId]);

    const removed = await remove(
      host,
      viewPath(viewId),
      { updatedAt: after(SECOND_MS) },
      bob.token,
    );
    expect(removed.status).toBe(204);
    expect((await snapshot(host, bob.token)).personalViews).toEqual([]);
    // An id no query ever sees is 404 here too.
    const gone = await remove(host, viewPath(viewId), { updatedAt: after(2 * SECOND_MS) }, bob.token);
    expect(gone.status).toBe(404);
  });

  test('replaces the ordered list whole, with the 409 and the 403 of SP04 §4 and SP01 §2', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const bobCode = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, bobCode);
    const caraCode = await createPerson(host, admin.token, OTHER_EMAIL, 'Cara');
    const cara = await signIn(host, OTHER_EMAIL, caraCode);
    await put(host, toolPath(CARA_TOOL), tool(CARA_TOOL), cara.token);
    // A second personal tool of Bob's, so the order is a list and not one element.
    await put(host, toolPath(BOB_TOOL), tool(BOB_TOOL), bob.token);
    await put(host, toolPath('p-bobnotes02'), tool('p-bobnotes02'), bob.token);

    const first = await put(
      host,
      HOST_ROUTES.favorites,
      { entries: ['p-bobnotes02', BOB_TOOL], updatedAt: instant() },
      bob.token,
    );
    expect(first.status).toBe(204);
    expect((await snapshot(host, bob.token)).favorites).toEqual(['p-bobnotes02', BOB_TOOL]);

    // Newer write, replaced whole — and a duplicate the repo drops (SP01 §2).
    const second = await put(
      host,
      HOST_ROUTES.favorites,
      { entries: [BOB_TOOL, BOB_TOOL], updatedAt: after(SECOND_MS) },
      bob.token,
    );
    expect(second.status).toBe(204);
    expect((await snapshot(host, bob.token)).favorites).toEqual([BOB_TOOL]);

    // An older write is the 409 of a stale write; an entry the person cannot see is a 403.
    const stale = await put(
      host,
      HOST_ROUTES.favorites,
      { entries: [], updatedAt: after(-10_000) },
      bob.token,
    );
    expect(stale.status).toBe(409);
    expect(await body<ErrorResponse>(stale)).toEqual({ error: 'stale updatedAt' });
    const invisible = await put(
      host,
      HOST_ROUTES.favorites,
      { entries: [CARA_TOOL], updatedAt: after(2 * SECOND_MS) },
      bob.token,
    );
    expect(invisible.status).toBe(403);
    expect(await body<ErrorResponse>(invisible)).toEqual({ error: 'not yours' });
    expect((await snapshot(host, bob.token)).favorites).toEqual([BOB_TOOL]);
  });
});

// ---------------------------------------------------------------- ownership (H7's second acceptance)

describe('personal data stays with its owner', () => {
  test('an admin’s snapshot and people list carry no other person’s personal data', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const bobCode = await createPerson(host, admin.token, MEMBER_EMAIL, 'Bob');
    const bob = await signIn(host, MEMBER_EMAIL, bobCode);

    const viewId = crypto.randomUUID();
    expect((await put(host, toolPath(BOB_TOOL), tool(BOB_TOOL), bob.token)).status).toBe(200);
    expect((await put(host, viewPath(viewId), view(viewId, BOB_TOOL), bob.token)).status).toBe(200);
    expect(
      (
        await put(
          host,
          HOST_ROUTES.favorites,
          { entries: [BOB_TOOL], updatedAt: instant() },
          bob.token,
        )
      ).status,
    ).toBe(204);

    // Bob's own snapshot carries them; the admin's carries none of them, in any field.
    const mine = await snapshot(host, bob.token);
    expect(mine.personalTools.map((entry) => entry.id)).toEqual([BOB_TOOL]);
    expect(mine.personalViews.map((entry) => entry.id)).toEqual([viewId]);
    expect(mine.favorites).toEqual([BOB_TOOL]);

    const admins = await snapshot(host, admin.token);
    expect(admins.personalTools).toEqual([]);
    expect(admins.personalViews).toEqual([]);
    expect(admins.favorites).toEqual([]);
    const raw = JSON.stringify(admins);
    for (const secret of [BOB_TOOL, viewId, BOB_TOOL]) expect(raw.includes(secret)).toBe(false);

    // And no other admin response mentions an id or a title of Bob's rows either.
    const people = await get(host, HOST_ROUTES.adminPeople, admin.token);
    const peopleRaw = await people.text();
    expect(peopleRaw.includes(BOB_TOOL)).toBe(false);
    const events = await get(host, HOST_ROUTES.adminEvents, admin.token);
    expect((await events.text()).includes(BOB_TOOL)).toBe(false);
  });
});
