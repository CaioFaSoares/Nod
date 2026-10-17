// The admin surface of the host, on the real Elysia app over a temp data dir (SP03 §1–§2, SP02 §3).
// Every request goes through `app.handle(new Request(...))` and every read of the host's own data
// goes to the database the app wrote: nothing here mocks the repo, the guards or the app. Run with
// `bun test host/admin.test.ts`.
//
// The flow of the fixture is the real one: `POST /v1/auth/setup` makes the first admin, the admin
// group mints the guild invites and builds the org catalog, and the person then redeems the code
// `POST /v1/admin/people/:id/code` answered through `POST /v1/auth/activate` — so a test only ever
// passes through a route that exists. A person is seeded through the repo (0.5.0, RF-59 removed the
// route that created one), as are the fixtures no story has landed yet (a personal tool, an event
// batch, a code), and each one says so.

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
  type ErrorResponse,
} from '../shared/host-api';
import { createApp } from './app';
import { ADMIN_ONLY, INVALID_CREDENTIALS } from './auth';
import { DEFAULT_PORT, type HostConfig } from './config';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';

const DEVICE: Device = { name: 'nod-admin-test', os: 'macos', appVersion: '0.3.0' };
const ADMIN_EMAIL = 'ada@nod.test';
const MEMBER_EMAIL = 'bob@nod.test';
const PERSONAL_ID = 'p-abc1234567';
const HOUR_MS = 3_600_000;

/**
 * A share of `docs/canonico.md` §22 for the F2 case: the credential id a Nod chooses and an opaque
 * stand-in for its sealed body — base64url of the alphabet only, like `shared/seal.ts` writes, since
 * the host never looks inside it (SP06 §3).
 */
const SHARED_CREDENTIAL = '55555555-5555-4555-8555-555555555555';
const SEALED = toBase64url(new TextEncoder().encode('sealed-body-stand-in'));

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

const hosts: TestHost[] = [];
const dirs: string[] = [];

async function startHost(): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-admin-'));
  dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: false,
  };
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
const patch = (host: TestHost, path: string, body: unknown, token: string | null = null) =>
  call(host, 'PATCH', path, body, token);
const put = (host: TestHost, path: string, body: unknown, token: string | null = null) =>
  call(host, 'PUT', path, body, token);
const remove = (host: TestHost, path: string, token: string | null = null) =>
  call(host, 'DELETE', path, undefined, token);

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomAuthKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
/** SP06 §2: the raw 32 bytes of a public key, in base64url — the shape `authKey` already has. */
const randomPublicKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
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

/** The first admin, through the real setup route: the token every admin call below carries. */
async function setupAdmin(host: TestHost): Promise<{ token: string; personId: string }> {
  const code = await seedCode(host, 'setup', null);
  const response = await post(host, HOST_ROUTES.authSetup, {
    email: ADMIN_EMAIL,
    name: 'Ada',
    code,
    salt: randomSalt(),
    authKey: randomAuthKey(),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  return await body<{ token: string; personId: string }>(response);
}

/**
 * One person, and the code the `:id/code` route of SP02 §3 would issue them — seeded through the
 * repo, because 0.5.0 (RF-59) removed the admin route that created a person with an email-bound
 * code (a guild invite creates a person now), the way this file's `seedCode` does.
 */
async function createPerson(
  host: TestHost,
  input: { email?: string; name?: string; roles?: string[] } = {},
): Promise<{ personId: string; code: string; expiresAt: string }> {
  const { email = MEMBER_EMAIL, name = 'Bob', roles = [] } = input;
  const person = host.repo.createPerson({ id: crypto.randomUUID(), email, name, roles }, instant());
  const code = generateCode('access');
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('the generated code is not Crockford base32');
  const record = host.repo.issueCode(
    { id: crypto.randomUUID(), purpose: 'activate', personId: person.id, codeHash: await sha256Hex(normalized) },
    instant(),
  );
  return { personId: person.id, code, expiresAt: record.expiresAt };
}

/** Redeems the code the admin route answered, through the real activation route (SP02 §3). */
async function activate(
  host: TestHost,
  email: string,
  code: string,
): Promise<{ token: string; personId: string }> {
  const response = await post(host, HOST_ROUTES.authActivate, {
    email,
    code,
    salt: randomSalt(),
    authKey: randomAuthKey(),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  return await body<{ token: string; personId: string }>(response);
}

/**
 * The smallest live **person** route on the app: `POST /v1/events` with an empty batch (SP03 §2,
 * SP04 §5, H8's group). It is what proves a token that must be dead is dead — the admin group's
 * own routes answer 403 for a member, so they cannot tell a live token from a revoked one.
 */
function personPing(host: TestHost, token: string): Promise<Response> {
  return post(host, HOST_ROUTES.events, { events: [] }, token);
}

/** A tool body of SP03 §2 (`OrgTool` = `Entry` + views), with the fields a test wants changed. */
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
    ...overrides,
  };
}

function captureConsole() {
  const lines: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? '')).join(' '));
  };
  Object.assign(console, { log: record, info: record, warn: record, error: record });
  return { lines, restore: () => Object.assign(console, originals) };
}

// ---------------------------------------------------------------- people (SP03 §2)

describe('people', () => {
  test('lists every person without a salt or a hash', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await createPerson(host, { roles: [] });

    const response = await get(host, HOST_ROUTES.adminPeople, admin.token);
    expect(response.status).toBe(200);
    const people = await body<Array<Record<string, unknown>>>(response);
    expect(people.map((person) => person.email)).toEqual([ADMIN_EMAIL, MEMBER_EMAIL]);
    expect(people.every((person) => person.salt === undefined && person.authHash === undefined)).toBe(true);
    // The row SP01 §2 keeps out of every answer, read from the wire and from the source at once.
    const raw = JSON.stringify(people);
    for (const secret of ['salt', 'auth_hash', 'authHash', 'code', 'token']) {
      expect(raw.includes(secret)).toBe(false);
    }
    expect(people[1]).toMatchObject({ name: 'Bob', kind: 'member', activatedAt: null, disabledAt: null });
  });

  test('the reissue route answers one access code with the SP02 §3 TTL, and that code activates the person', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const person = await createPerson(host, {});
    const before = instant();
    const response = await post(
      host,
      `${HOST_ROUTES.adminPeople}/${person.personId}/code`,
      undefined,
      admin.token,
    );
    expect(response.status).toBe(200);
    const created = await body<{ code: string; expiresAt: string }>(response);

    // The code is the `XXXX-XXXX` of SP02 §3.
    expect(created.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // SP02 §3: an access code lives 72 h.
    const ttlHours = (Date.parse(created.expiresAt) - Date.parse(before)) / HOUR_MS;
    expect(ttlHours).toBeGreaterThan(71.9);
    expect(ttlHours).toBeLessThan(72.1);

    // Shown once: the list that follows carries no trace of it.
    const listed = await get(host, HOST_ROUTES.adminPeople, admin.token);
    expect((await listed.text()).includes(created.code)).toBe(false);

    // And it works: the person redeems it and gets a session (RF-33).
    const session = await activate(host, MEMBER_EMAIL, created.code);
    expect(session.personId).toBe(person.personId);
    expect((await personPing(host, session.token)).status).toBe(200);
  });

  test('a reissued code revokes the previous one', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const first = await createPerson(host, {});

    const reissued = await post(
      host,
      `${HOST_ROUTES.adminPeople}/${first.personId}/code`,
      undefined,
      admin.token,
    );
    expect(reissued.status).toBe(200);
    const second = await body<{ code: string; expiresAt: string }>(reissued);
    expect(second.code).not.toBe(first.code);
    // SP02 §3: the new code carries its own 72 h from now.
    const ttlHours = (Date.parse(second.expiresAt) - Date.parse(instant())) / HOUR_MS;
    expect(ttlHours).toBeGreaterThan(71.9);
    expect(ttlHours).toBeLessThan(72.1);

    const old = await post(host, HOST_ROUTES.authActivate, {
      email: MEMBER_EMAIL,
      code: first.code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(old.status).toBe(401);
    expect(await body<ErrorResponse>(old)).toEqual({ error: 'invalid code' });

    const session = await activate(host, MEMBER_EMAIL, second.code);
    expect(session.personId).toBe(first.personId);
  });

  test('a reissued code for an unknown person is 404', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const response = await post(
      host,
      `${HOST_ROUTES.adminPeople}/${crypto.randomUUID()}/code`,
      undefined,
      admin.token,
    );
    expect(response.status).toBe(404);
    expect(await body<ErrorResponse>(response)).toEqual({ error: 'unknown person' });
  });

  test('PATCH changes what it is sent and answers the stored person', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await put(host, '/v1/admin/roles/team', { name: 'Team', admin: false }, admin.token);
    const person = await createPerson(host, {});

    const response = await patch(
      host,
      `${HOST_ROUTES.adminPeople}/${person.personId}`,
      { name: 'Robert', roles: ['team'] },
      admin.token,
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ id: person.personId, name: 'Robert', roles: ['team'] });

    // Only what the caller sent changes: an empty body answers the same person untouched.
    const untouched = await patch(
      host,
      `${HOST_ROUTES.adminPeople}/${person.personId}`,
      {},
      admin.token,
    );
    expect(await body(untouched)).toMatchObject({ name: 'Robert', roles: ['team'], disabledAt: null });

    const missing = await patch(
      host,
      `${HOST_ROUTES.adminPeople}/${crypto.randomUUID()}`,
      { name: 'Ghost' },
      admin.token,
    );
    expect(missing.status).toBe(404);
    expect(await body<ErrorResponse>(missing)).toEqual({ error: 'unknown person' });
  });

  test('disabling a person revokes every session of theirs', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const person = await createPerson(host, {});
    const member = await activate(host, MEMBER_EMAIL, person.code);
    expect((await personPing(host, member.token)).status).toBe(200);

    const disabled = await patch(
      host,
      `${HOST_ROUTES.adminPeople}/${person.personId}`,
      { disabled: true },
      admin.token,
    );
    expect(disabled.status).toBe(200);
    const stamped = await body<{ disabledAt: string | null }>(disabled);
    expect(stamped.disabledAt).not.toBeNull();

    // RF-39 / SP02 §5: the token the person held is dead, and the same one cannot sign in again.
    expect((await personPing(host, member.token)).status).toBe(401);
    const signIn = await post(host, HOST_ROUTES.authLogin, {
      email: MEMBER_EMAIL,
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(signIn.status).toBe(401);
  });

  test('the last admin cannot be disabled nor left without an admin role (409)', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);

    const disabled = await patch(
      host,
      `${HOST_ROUTES.adminPeople}/${admin.personId}`,
      { disabled: true },
      admin.token,
    );
    expect(disabled.status).toBe(409);
    expect(await body<ErrorResponse>(disabled)).toEqual({
      error: 'the last admin cannot be removed',
    });

    const demoted = await patch(
      host,
      `${HOST_ROUTES.adminPeople}/${admin.personId}`,
      { roles: [] },
      admin.token,
    );
    expect(demoted.status).toBe(409);

    // The refusal rolled the write back: the admin is still an enabled admin (SP01 §2).
    const listed = await body<Array<{ id: string; admin: boolean; disabledAt: string | null }>>(
      await get(host, HOST_ROUTES.adminPeople, admin.token),
    );
    expect(listed).toEqual([
      expect.objectContaining({ id: admin.personId, admin: true, disabledAt: null }),
    ]);
    expect((await personPing(host, admin.token)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- sessions (SP03 §2)

describe('sessions', () => {
  test('lists a person`s live sessions and ends one by id', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const person = await createPerson(host, {});
    const member = await activate(host, MEMBER_EMAIL, person.code);

    const listed = await get(
      host,
      `${HOST_ROUTES.adminPeople}/${person.personId}/sessions`,
      admin.token,
    );
    expect(listed.status).toBe(200);
    const sessions = await body<Array<Record<string, unknown>>>(listed);
    expect(sessions).toHaveLength(1);
    expect(typeof sessions[0].id).toBe('string');
    expect(sessions[0]).toMatchObject({
      personId: person.personId,
      device: { name: DEVICE.name, os: 'macos', appVersion: DEVICE.appVersion },
    });
    expect(typeof sessions[0].createdAt).toBe('string');
    expect(typeof sessions[0].lastSeenAt).toBe('string');
    expect(typeof sessions[0].expiresAt).toBe('string');
    for (const secret of ['token', 'revokedAt']) expect(JSON.stringify(sessions).includes(secret)).toBe(false);

    const ended = await remove(
      host,
      `${HOST_ROUTES.adminSession.replace(':id', String(sessions[0].id))}`,
      admin.token,
    );
    expect(ended.status).toBe(204);
    expect((await personPing(host, member.token)).status).toBe(401);

    const gone = await remove(
      host,
      `${HOST_ROUTES.adminSession.replace(':id', String(sessions[0].id))}`,
      admin.token,
    );
    expect(gone.status).toBe(204);

    const unknown = await remove(
      host,
      `${HOST_ROUTES.adminSession.replace(':id', crypto.randomUUID())}`,
      admin.token,
    );
    expect(unknown.status).toBe(404);
    expect(await body<ErrorResponse>(unknown)).toEqual({ error: 'unknown session' });

    const person404 = await get(
      host,
      `${HOST_ROUTES.adminPeople}/${crypto.randomUUID()}/sessions`,
      admin.token,
    );
    expect(person404.status).toBe(404);
  });
});

// ---------------------------------------------------------------- roles and grants (SP03 §2)

describe('roles and grants', () => {
  test('PUT creates and updates a role; the last admin role cannot be demoted or removed', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);

    const created = await put(host, '/v1/admin/roles/team', { name: 'Team', admin: false }, admin.token);
    expect(created.status).toBe(200);
    expect(await body(created)).toEqual({ id: 'team', name: 'Team', admin: false });

    const renamed = await put(host, '/v1/admin/roles/team', { name: 'The team', admin: false }, admin.token);
    expect(await body(renamed)).toEqual({ id: 'team', name: 'The team', admin: false });
    expect(host.repo.listRoles()).toEqual([
      { id: 'admin', name: 'admin', admin: true },
      { id: 'team', name: 'The team', admin: false },
    ]);

    const demote = await put(host, '/v1/admin/roles/admin', { name: 'admin', admin: false }, admin.token);
    expect(demote.status).toBe(409);
    expect(await body<ErrorResponse>(demote)).toEqual({ error: 'the last admin cannot be removed' });

    const removed = await remove(host, '/v1/admin/roles/team', admin.token);
    expect(removed.status).toBe(204);
    expect(host.repo.listRoles().map((role) => role.id)).toEqual(['admin']);

    const lastAdmin = await remove(host, '/v1/admin/roles/admin', admin.token);
    expect(lastAdmin.status).toBe(409);
    expect(host.repo.listRoles().map((role) => role.id)).toEqual(['admin']);

    const unknown = await remove(host, '/v1/admin/roles/ghost', admin.token);
    expect(unknown.status).toBe(404);
    expect(await body<ErrorResponse>(unknown)).toEqual({ error: 'unknown role' });
  });

  test('PUT grants and revokes an org tool for a role, and refuses a personal entry', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await put(host, '/v1/admin/roles/team', { name: 'Team', admin: false }, admin.token);
    const person = await createPerson(host, { roles: ['team'] });
    await put(host, HOST_ROUTES.adminTool.replace(':id', 'kanban'), tool('kanban'), admin.token);

    const granted = await put(
      host,
      HOST_ROUTES.adminGrants,
      { roleId: 'team', entryId: 'kanban', granted: true },
      admin.token,
    );
    expect(granted.status).toBe(204);
    expect(host.repo.listOrgTools()[0].roles).toEqual(['team']);
    expect(host.repo.orgToolsFor(person.personId).map((entry) => entry.id)).toEqual(['kanban']);

    const revoked = await put(
      host,
      HOST_ROUTES.adminGrants,
      { roleId: 'team', entryId: 'kanban', granted: false },
      admin.token,
    );
    expect(revoked.status).toBe(204);
    expect(host.repo.listOrgTools()[0].roles).toEqual([]);
    expect(host.repo.orgToolsFor(person.personId)).toEqual([]);

    const unknownRole = await put(
      host,
      HOST_ROUTES.adminGrants,
      { roleId: 'ghost', entryId: 'kanban', granted: true },
      admin.token,
    );
    expect(unknownRole.status).toBe(404);
    const unknownEntry = await put(
      host,
      HOST_ROUTES.adminGrants,
      { roleId: 'team', entryId: 'ghost', granted: true },
      admin.token,
    );
    expect(unknownEntry.status).toBe(404);

    // SP01 §2: a grant references an org entry only — a personal one is 403, never a silent write.
    host.repo.savePersonalTool(
      admin.personId,
      { id: PERSONAL_ID, title: 'Notes', url: 'https://notes.example.test', icon: null, order: 0, auth: null, active: true },
      instant(),
    );
    const personal = await put(
      host,
      HOST_ROUTES.adminGrants,
      { roleId: 'team', entryId: PERSONAL_ID, granted: true },
      admin.token,
    );
    expect(personal.status).toBe(403);
    expect(await body<ErrorResponse>(personal)).toEqual({ error: 'grants apply to org tools only' });
  });
});

// ---------------------------------------------------------------- org tools (SP03 §2)

describe('org tools', () => {
  test('PUT writes the entry, its grants and its views, stamped with the host clock', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await put(host, '/v1/admin/roles/team', { name: 'Team', admin: false }, admin.token);

    const before = instant();
    const created = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'jitsi'),
      tool('jitsi', {
        title: 'Jitsi',
        order: 3,
        roles: ['team'],
        // A view the host has not created yet carries no id; one that exists carries its own.
        views: [
          { label: 'Meet', url: 'https://jitsi.example.test/meet', mode: 'window' },
          { id: crypto.randomUUID(), label: 'Rooms', url: 'https://jitsi.example.test/rooms', mode: 'navigate' },
        ],
        // SP04 §4: an org write has no `updatedAt` of the Nod's, so one sent is not the host's.
        updatedAt: '2000-01-01T00:00:00.000Z',
      }),
      admin.token,
    );
    expect(created.status).toBe(200);
    const saved = await body<{
      id: string;
      title: string;
      order: number;
      roles: string[];
      views: Array<{ id: string; label: string; url: string; mode: string }>;
      active: boolean;
      updatedAt: string;
    }>(created);
    expect(saved).toMatchObject({ id: 'jitsi', title: 'Jitsi', order: 3, roles: ['team'], active: true });
    expect(saved.views.map((view) => view.label)).toEqual(['Meet', 'Rooms']);
    expect(saved.views.every((view) => typeof view.id === 'string' && view.id !== '')).toBe(true);
    expect(saved.views.map((view) => view.mode)).toEqual(['window', 'navigate']);
    expect(saved.updatedAt >= before).toBe(true);
    expect(saved.updatedAt.endsWith('Z')).toBe(true);

    // A second write replaces grants and views exactly, and moves the timestamp forward.
    const updated = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'jitsi'),
      tool('jitsi', { title: 'Jitsi Meet', roles: [] }),
      admin.token,
    );
    const rewritten = await body<{ title: string; roles: string[]; views: unknown[]; updatedAt: string }>(
      updated,
    );
    expect(rewritten).toMatchObject({ title: 'Jitsi Meet', roles: [] });
    expect(rewritten.views).toEqual([]);
    expect(rewritten.updatedAt >= saved.updatedAt).toBe(true);
    expect(host.repo.listOrgTools()).toHaveLength(1);

    const mismatched = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'jitsi'),
      tool('kanban'),
      admin.token,
    );
    expect(mismatched.status).toBe(400);
    const failure = await body<ErrorResponse>(mismatched);
    expect(failure.error).toContain('id');
  });

  test('PUT files an org tool under a trimmed category, and refuses one longer than 40 (RF-62)', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);

    const created = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'jitsi'),
      tool('jitsi', { category: '  Support  ' }),
      admin.token,
    );
    expect(created.status).toBe(200);
    expect(await body<{ category: string | null }>(created)).toEqual(
      expect.objectContaining({ category: 'Support' }),
    );
    expect(host.repo.listOrgTools()[0]?.category).toBe('Support');

    // An empty name is no category, and the schema bounds the length of one that is sent.
    const cleared = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'jitsi'),
      tool('jitsi', { category: '   ' }),
      admin.token,
    );
    expect(await body<{ category: string | null }>(cleared)).toEqual(
      expect.objectContaining({ category: null }),
    );
    const tooLong = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'jitsi'),
      tool('jitsi', { category: 'c'.repeat(41) }),
      admin.token,
    );
    expect(tooLong.status).toBe(400);
    expect(host.repo.listOrgTools()[0]?.category).toBeNull();
  });

  test('DELETE removes an org tool and answers 404 when it is not there', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await put(host, HOST_ROUTES.adminTool.replace(':id', 'kanban'), tool('kanban'), admin.token);

    const removed = await remove(host, HOST_ROUTES.adminTool.replace(':id', 'kanban'), admin.token);
    expect(removed.status).toBe(204);
    expect(host.repo.listOrgTools()).toEqual([]);

    const again = await remove(host, HOST_ROUTES.adminTool.replace(':id', 'kanban'), admin.token);
    expect(again.status).toBe(404);
    expect(await body<ErrorResponse>(again)).toEqual({ error: 'unknown tool' });
  });

  test('DELETE refuses a tool a share still names, and removes an unshared one (F2)', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await put(
      host,
      HOST_ROUTES.adminRole.replace(':id', 'team'),
      { name: 'Team', admin: false },
      admin.token,
    );
    await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'kanban'),
      tool('kanban', { roles: ['team'] }),
      admin.token,
    );
    // A member of the granted role with keys, and one real share over the real route: that row is
    // what keeps the tool alive for the child reference of `shares.tool_id`.
    const person = await createPerson(host, { roles: ['team'] });
    const member = await activate(host, MEMBER_EMAIL, person.code);
    expect(
      (
        await put(
          host,
          HOST_ROUTES.keys,
          { x25519Public: randomPublicKey(), ed25519Public: randomPublicKey() },
          member.token,
        )
      ).status,
    ).toBe(204);
    const sent = await post(
      host,
      HOST_ROUTES.shares,
      {
        credentialId: SHARED_CREDENTIAL,
        toolId: 'kanban',
        scope: 'org',
        kind: 'send',
        items: [{ to: person.personId, sealed: SEALED }],
      },
      admin.token,
    );
    expect(sent.status).toBe(200);

    // F2: the bare parent delete would abort on the FK — `shares.tool_id` carries no `ON DELETE`, on
    // purpose — leaving the route to answer `500 internal error`. It refuses with `409` instead, and
    // the tool is still there, in the catalog and in the table.
    const refused = await remove(host, HOST_ROUTES.adminTool.replace(':id', 'kanban'), admin.token);
    expect(refused.status).toBe(409);
    expect(await body<ErrorResponse>(refused)).toEqual({
      error: 'a shared credential keeps the tool',
    });
    expect(host.repo.listOrgTools().map((saved) => saved.id)).toEqual(['kanban']);

    // A tool no share names still goes: the refusal is the row, not the route.
    await put(host, HOST_ROUTES.adminTool.replace(':id', 'jitsi'), tool('jitsi'), admin.token);
    const removed = await remove(host, HOST_ROUTES.adminTool.replace(':id', 'jitsi'), admin.token);
    expect(removed.status).toBe(204);
    expect(host.repo.listOrgTools().map((saved) => saved.id)).toEqual(['kanban']);
  });

  test('promote copies the admin`s personal tool to the org, and the owner keeps theirs', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const person = await createPerson(host, {});
    const viewId = crypto.randomUUID();
    host.repo.savePersonalTool(
      admin.personId,
      {
        id: PERSONAL_ID,
        title: 'Notes',
        url: 'https://notes.example.test',
        icon: null,
        order: 2,
        auth: { noFill: true },
        active: true,
      },
      instant(),
    );
    host.repo.savePersonalView(
      admin.personId,
      { id: viewId, entryId: PERSONAL_ID, label: 'Board', url: 'https://notes.example.test/board', mode: 'window' },
      instant(),
    );

    const promoted = await post(
      host,
      HOST_ROUTES.adminToolPromote.replace(':id', 'notes-org'),
      { personalId: PERSONAL_ID },
      admin.token,
    );
    expect(promoted.status).toBe(200);
    const copy = await body<{
      id: string;
      title: string;
      url: string;
      order: number;
      roles: string[];
      auth: { noFill?: boolean } | null;
      scope: string;
      views: Array<{ id: string; label: string }>;
    }>(promoted);
    expect(copy).toMatchObject({
      id: 'notes-org',
      title: 'Notes',
      url: 'https://notes.example.test',
      order: 2,
      roles: [],
      auth: { noFill: true },
      scope: 'org',
    });
    expect(copy.views.map((view) => view.label)).toEqual(['Board']);
    // A personal view belongs to its owner: the copy gets its own row and its own id (SP01 §2).
    expect(copy.views[0].id).not.toBe(viewId);

    // The owner keeps the original, with its own view and id.
    const personal = host.repo.personalTool(admin.personId, PERSONAL_ID);
    expect(personal).not.toBeNull();
    expect(personal?.views.map((view) => view.id)).toEqual([viewId]);
    expect(host.repo.listOrgTools().map((entry) => entry.id)).toEqual(['notes-org']);

    // A personal tool the admin does not own is invisible to them (SP03 §1: 403, never 404).
    host.repo.savePersonalTool(
      person.personId,
      { id: 'p-zzz9999999', title: 'Theirs', url: 'https://theirs.example.test', icon: null, order: 0, auth: null, active: true },
      instant(),
    );
    const theirs = await post(
      host,
      HOST_ROUTES.adminToolPromote.replace(':id', 'theirs-org'),
      { personalId: 'p-zzz9999999' },
      admin.token,
    );
    expect(theirs.status).toBe(403);
    expect(await body<ErrorResponse>(theirs)).toEqual({ error: 'not yours' });

    const unknown = await post(
      host,
      HOST_ROUTES.adminToolPromote.replace(':id', 'ghost-org'),
      { personalId: 'p-ghost00000' },
      admin.token,
    );
    expect(unknown.status).toBe(403);
  });
});

// ---------------------------------------------------------------- bootstrap (SP03 §2, B8a)

describe('bootstrap', () => {
  test('writes roles and tools once, and the second call is 409', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const input = {
      roles: [{ id: 'team', name: 'Team', admin: false }],
      tools: [
        tool('kanban', { title: 'Kanban', roles: ['team'], views: [{ label: 'Board', url: 'https://kanban.example.test/b', mode: 'navigate' }] }),
        tool('affine', { title: 'Affine', order: 1, roles: ['team'] }),
      ],
    };

    const first = await post(host, HOST_ROUTES.adminBootstrap, input, admin.token);
    expect(first.status).toBe(200);
    expect(await body(first)).toEqual({ created: 2 });
    expect(host.repo.listRoles().map((role) => role.id)).toEqual(['admin', 'team']);
    expect(host.repo.listOrgTools().map((entry) => entry.id).sort()).toEqual(['affine', 'kanban']);
    expect(host.repo.listOrgTools().find((entry) => entry.id === 'kanban')?.views).toHaveLength(1);

    const second = await post(host, HOST_ROUTES.adminBootstrap, input, admin.token);
    expect(second.status).toBe(409);
    expect(await body<ErrorResponse>(second)).toEqual({ error: 'the host already has org tools' });
    expect(host.repo.listOrgTools()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- events (SP03 §2)

describe('events', () => {
  test('lists the host`s events with the four filters and a limit', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const person = await createPerson(host, {});
    const member = await activate(host, MEMBER_EMAIL, person.code);
    const adminSession = host.repo.sessionsOfPerson(admin.personId, instant())[0].id;
    const memberSession = host.repo.sessionsOfPerson(person.personId, instant())[0].id;

    // The batch of SP04 §5, seeded through the repo: the push route is H8's, this list is H5's.
    const at = Date.parse(instant());
    const twoHoursAgo = new Date(at - 2 * HOUR_MS).toISOString();
    const oneHourAgo = new Date(at - HOUR_MS).toISOString();
    host.repo.addEvents(
      admin.personId,
      adminSession,
      [
        { id: 'e-1', at: twoHoursAgo, kind: 'tool_opened', toolId: 'kanban', url: null, result: null, detail: null },
        { id: 'e-2', at: oneHourAgo, kind: 'view_opened', toolId: 'jitsi', url: null, result: null, detail: null },
      ],
      instant(),
    );
    host.repo.addEvents(
      person.personId,
      memberSession,
      [
        { id: 'e-3', at: oneHourAgo, kind: 'login', toolId: null, url: null, result: null, detail: null },
      ],
      instant(),
    );

    const all = await get(host, HOST_ROUTES.adminEvents, admin.token);
    expect(all.status).toBe(200);
    const events = await body<Array<{ id: string; personId: string; sessionId: string; receivedAt: string }>>(all);
    expect(events.map((event) => event.id)).toEqual(['e-3', 'e-2', 'e-1']);
    expect(events[0]).toMatchObject({ personId: person.personId, sessionId: memberSession });
    expect(typeof events[0].receivedAt).toBe('string');

    const byPerson = await get(
      host,
      `${HOST_ROUTES.adminEvents}?person=${admin.personId}`,
      admin.token,
    );
    expect((await body<Array<{ id: string }>>(byPerson)).map((event) => event.id)).toEqual(['e-2', 'e-1']);

    const byTool = await get(host, `${HOST_ROUTES.adminEvents}?tool=kanban`, admin.token);
    expect((await body<Array<{ id: string }>>(byTool)).map((event) => event.id)).toEqual(['e-1']);

    const window = await get(
      host,
      `${HOST_ROUTES.adminEvents}?from=${oneHourAgo}&to=${oneHourAgo}`,
      admin.token,
    );
    expect((await body<Array<{ id: string }>>(window)).map((event) => event.id)).toEqual(['e-3', 'e-2']);

    const limited = await get(host, `${HOST_ROUTES.adminEvents}?limit=1`, admin.token);
    expect((await body<Array<{ id: string }>>(limited)).map((event) => event.id)).toEqual(['e-3']);

    // The member sees the same route only as a 403: the list is the admin's (SP03 §2).
    expect((await get(host, HOST_ROUTES.adminEvents, member.token)).status).toBe(403);
  });
});

// ---------------------------------------------------------------- SP03 §1's levels, statuses and logs

describe('access, validation and logs', () => {
  test('every admin route answers 401 without a token and 403 for a member', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const person = await createPerson(host, {});
    const member = await activate(host, MEMBER_EMAIL, person.code);
    const session = host.repo.sessionsOfPerson(person.personId, instant())[0].id;
    const toolId = 'kanban';
    await put(host, HOST_ROUTES.adminTool.replace(':id', toolId), tool(toolId), admin.token);

    // One real invite, so the DELETE row below has an id to hand (0.5.0, RF-59).
    const invite = await body<{ invite: { id: string } }>(
      await post(
        host,
        HOST_ROUTES.adminInvites,
        { roles: [], maxUses: null, expiresInMinutes: null },
        admin.token,
      ),
    );

    const routes: Array<[string, (token: string | null) => Promise<Response>]> = [
      ['GET /v1/admin/people', (token) => get(host, HOST_ROUTES.adminPeople, token)],
      [
        'GET /v1/admin/invites',
        (token) => get(host, HOST_ROUTES.adminInvites, token),
      ],
      [
        'POST /v1/admin/invites',
        (token) =>
          post(host, HOST_ROUTES.adminInvites, { roles: [], maxUses: null, expiresInMinutes: null }, token),
      ],
      [
        'DELETE /v1/admin/invites/:id',
        (token) => remove(host, `${HOST_ROUTES.adminInvites}/${invite.invite.id}`, token),
      ],
      [
        'PATCH /v1/admin/people/:id',
        (token) => patch(host, `${HOST_ROUTES.adminPeople}/${person.personId}`, { name: 'Zed' }, token),
      ],
      [
        'POST /v1/admin/people/:id/code',
        (token) => post(host, `${HOST_ROUTES.adminPeople}/${person.personId}/code`, undefined, token),
      ],
      [
        'GET /v1/admin/people/:id/sessions',
        (token) => get(host, `${HOST_ROUTES.adminPeople}/${person.personId}/sessions`, token),
      ],
      [
        'DELETE /v1/admin/sessions/:id',
        (token) => remove(host, HOST_ROUTES.adminSession.replace(':id', session), token),
      ],
      ['PUT /v1/admin/roles/:id', (token) => put(host, '/v1/admin/roles/team', { name: 'Team', admin: false }, token)],
      ['DELETE /v1/admin/roles/:id', (token) => remove(host, '/v1/admin/roles/team', token)],
      [
        'PUT /v1/admin/grants',
        (token) => put(host, HOST_ROUTES.adminGrants, { roleId: 'admin', entryId: toolId, granted: true }, token),
      ],
      [
        'PUT /v1/admin/tools/:id',
        (token) => put(host, HOST_ROUTES.adminTool.replace(':id', toolId), tool(toolId), token),
      ],
      ['DELETE /v1/admin/tools/:id', (token) => remove(host, HOST_ROUTES.adminTool.replace(':id', toolId), token)],
      [
        'POST /v1/admin/tools/:id/promote',
        (token) => post(host, HOST_ROUTES.adminToolPromote.replace(':id', 'notes-org'), { personalId: PERSONAL_ID }, token),
      ],
      [
        'POST /v1/admin/bootstrap',
        (token) => post(host, HOST_ROUTES.adminBootstrap, { roles: [], tools: [] }, token),
      ],
      ['GET /v1/admin/events', (token) => get(host, HOST_ROUTES.adminEvents, token)],
    ];

    for (const [label, request] of routes) {
      const anonymous = await request(null);
      expect([label, anonymous.status]).toEqual([label, 401]);
      expect([label, await body<ErrorResponse>(anonymous)]).toEqual([label, { error: INVALID_CREDENTIALS }]);

      const asMember = await request(member.token);
      expect([label, asMember.status]).toEqual([label, 403]);
      expect([label, await body<ErrorResponse>(asMember)]).toEqual([label, { error: ADMIN_ONLY }]);
    }
    // No route above wrote anything for a member: the tool is still the admin's, untouched.
    expect(host.repo.listOrgTools()).toHaveLength(1);
  });

  test('the admin guard does not cover the groups mounted after it', async () => {
    const host = await startHost();
    await setupAdmin(host);
    const person = await createPerson(host, {});
    const member = await activate(host, MEMBER_EMAIL, person.code);

    // The event group of H8 answers a member on its own level; a leaked admin guard would be 403.
    expect((await personPing(host, member.token)).status).toBe(200);
    // The health probe is public, and the state group is the person level of H6 (SP03 §1).
    expect((await get(host, HOST_ROUTES.health)).status).toBe(200);
    expect((await get(host, HOST_ROUTES.state, member.token)).status).not.toBe(403);
  });

  test('a body that fails its schema is a 400 that names the field', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const person = await createPerson(host, {});

    const missing = await post(
      host,
      HOST_ROUTES.adminInvites,
      { roles: [], maxUses: null, expiresInMinutes: 'soon' },
      admin.token,
    );
    expect(missing.status).toBe(400);
    expect((await body<ErrorResponse>(missing)).error).toContain('expiresInMinutes');

    const wrongRoles = await patch(
      host,
      `${HOST_ROUTES.adminPeople}/${person.personId}`,
      { roles: 'team' },
      admin.token,
    );
    expect(wrongRoles.status).toBe(400);
    expect((await body<ErrorResponse>(wrongRoles)).error).toContain('roles');

    const wrongView = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'kanban'),
      tool('kanban', { views: [{ label: 'Board', url: 'https://kanban.example.test', mode: 'popup' }] }),
      admin.token,
    );
    expect(wrongView.status).toBe(400);
    expect((await body<ErrorResponse>(wrongView)).error).toContain('mode');

    const wrongId = await put(
      host,
      HOST_ROUTES.adminTool.replace(':id', 'Kanban'),
      tool('kanban'),
      admin.token,
    );
    expect(wrongId.status).toBe(400);
    expect((await body<ErrorResponse>(wrongId)).error).toContain('id');

    const wrongLimit = await get(host, `${HOST_ROUTES.adminEvents}?limit=none`, admin.token);
    expect(wrongLimit.status).toBe(400);
    expect((await body<ErrorResponse>(wrongLimit)).error).toContain('limit');

    const wrongPromote = await post(
      host,
      HOST_ROUTES.adminToolPromote.replace(':id', 'notes-org'),
      { personalId: 'notes' },
      admin.token,
    );
    expect(wrongPromote.status).toBe(400);
    expect((await body<ErrorResponse>(wrongPromote)).error).toContain('personalId');

    // A body the parser cannot turn into an object answers the 400 of SP03 §1 with no field to name.
    const malformed = await call(host, 'POST', HOST_ROUTES.adminInvites, '{', admin.token);
    expect(malformed.status).toBe(400);
    expect((await body<ErrorResponse>(malformed)).error).toContain('invalid body');
  });

  test('no access code, token or authKey reaches the log (SP03 §4)', async () => {
    const host = await startHost();
    const captured = captureConsole();
    const setup = generateCode('setup');
    const normalized = normalizeCode(setup) as string;
    host.repo.issueCode(
      { id: crypto.randomUUID(), purpose: 'setup', personId: null, codeHash: await sha256Hex(normalized) },
      instant(),
    );
    const salt = randomSalt();
    const authKey = randomAuthKey();
    const admin = await body<{ token: string; personId: string }>(
      await post(host, HOST_ROUTES.authSetup, {
        email: ADMIN_EMAIL,
        name: 'Ada',
        code: setup,
        salt,
        authKey,
        device: DEVICE,
      }),
    );

    const person = await createPerson(host, {});
    const reissued = await body<{ code: string }>(
      await post(host, `${HOST_ROUTES.adminPeople}/${person.personId}/code`, undefined, admin.token),
    );
    await put(host, HOST_ROUTES.adminTool.replace(':id', 'kanban'), tool('kanban'), admin.token);
    await post(host, HOST_ROUTES.adminBootstrap, { roles: [], tools: [] }, admin.token);
    await get(host, `${HOST_ROUTES.adminEvents}?limit=none`, admin.token);
    captured.restore();

    const log = captured.lines.join('\n');
    for (const secret of [setup, person.code, reissued.code, admin.token, authKey, salt]) {
      expect(log.includes(secret)).toBe(false);
    }
    // Nothing at all: a request answers with a body, and no route body is ever logged.
    expect(captured.lines).toEqual([]);
  });
});
