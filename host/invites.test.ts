// Guild invites (0.5.0, RF-59) on the real Elysia app over a temp data dir: the admin's
// create/list/revoke, the public preview a stranger reads, and the join that creates the account the
// person chooses with the invite's roles. Every request goes through `app.handle(new Request(...))`
// and every read of the host's own data goes to the database the app wrote: nothing here mocks the
// repo, the guards or the app. Run with `bun test host/invites.test.ts`.
//
// The fixture is the real one: `POST /v1/auth/setup` makes the first admin (the setup code is seeded
// through the repo, the way `host/auth.test.ts` does it), the admin creates the roles and the invites
// through the routes of SP03 §2, and the person then joins through `POST /v1/auth/join` with the code
// the create answered. Only the two moves no route can make — an invite that expired in the past and
// one created earlier than this request — go to the repo or the database directly, and each one says
// so.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { sha256Hex, toBase64url } from '../shared/encoding';
import {
  CODE_LENGTH,
  HOST_ROUTES,
  generateCode,
  normalizeCode,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type Device,
  type ErrorResponse,
  type GuildInvite,
  type HostEvent,
  type InvitePreview,
  type TokenResponse,
} from '../shared/host-api';
import { createApp } from './app';
import { INVALID_INVITE, JOIN_EMAIL_TAKEN, TOO_MANY_ATTEMPTS } from './auth';
import { DEFAULT_PORT, type HostConfig } from './config';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';
import { GUILD_NAME_ENV } from './routes/state';

const DEVICE: Device = { name: 'nod-invite-test', os: 'macos', appVersion: '0.5.0' };
const ADMIN_EMAIL = 'ada@nod.test';
const MEMBER_EMAIL = 'bob@nod.test';
const GUILD = 'Nod test guild';
const ROLE = 'team';

/** The eight bytes of `PNG_SIGNATURE` plus a body: the only icon check the route makes (SP03 §2). */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** What a test needs from an app: Elysia's answer to one `Request`. */
type HttpApp = { handle(request: Request): Promise<Response> };

type TestHost = {
  app: HttpApp;
  repo: Repo;
  /** The connection `bootHost` opened: its type comes from the boot, never from `bun:sqlite` here. */
  db: Host['db'];
  cleanup(): void;
};

const hosts: TestHost[] = [];
const dirs: string[] = [];

async function startHost(): Promise<TestHost> {
  const dir = mkdtempSync(joinPath(tmpdir(), 'nod-invites-'));
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

// ---------------------------------------------------------------- request helpers

function call(
  host: TestHost,
  method: string,
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined && token !== null) headers.authorization = `Bearer ${token}`;
  return host.app.handle(
    new Request(`http://nod.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const post = (host: TestHost, path: string, body?: unknown, token?: string | null) =>
  call(host, 'POST', path, body, token);
const get = (host: TestHost, path: string, token?: string | null) =>
  call(host, 'GET', path, undefined, token);
const put = (host: TestHost, path: string, body: unknown, token?: string | null) =>
  call(host, 'PUT', path, body, token);
const remove = (host: TestHost, path: string, token?: string | null) =>
  call(host, 'DELETE', path, undefined, token);

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomAuthKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
const instant = (): string => new Date().toISOString();

// ---------------------------------------------------------------- fixture

/** The first admin, through the real setup route (the setup code is seeded through the repo). */
async function setupAdmin(host: TestHost): Promise<{ token: string; personId: string }> {
  const code = generateCode('setup');
  const normalized = normalizeCode(code) as string;
  host.repo.issueCode(
    { id: crypto.randomUUID(), purpose: 'setup', personId: null, codeHash: await sha256Hex(normalized) },
    instant(),
  );
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

/** A role of the guild, through the admin route (`admin` stays false: `admin` exists already). */
async function putRole(host: TestHost, token: string, id = ROLE): Promise<void> {
  const response = await put(host, HOST_ROUTES.adminRole.replace(':id', id), { name: 'Team', admin: false }, token);
  expect(response.status).toBe(200);
}

async function createInvite(
  host: TestHost,
  token: string,
  request: CreateInviteRequest,
): Promise<CreateInviteResponse> {
  const response = await post(host, HOST_ROUTES.adminInvites, request, token);
  expect(response.status).toBe(200);
  return await body<CreateInviteResponse>(response);
}

/** One `POST /v1/auth/join` with a fresh password: the account the person chooses (RF-59). */
function join(host: TestHost, code: string, email = MEMBER_EMAIL, name = 'Bob'): Promise<Response> {
  return post(host, HOST_ROUTES.authJoin, {
    email,
    name,
    code,
    salt: randomSalt(),
    authKey: randomAuthKey(),
    device: DEVICE,
  });
}

function listInvites(host: TestHost, token: string): Promise<Response> {
  return get(host, HOST_ROUTES.adminInvites, token);
}

// ---------------------------------------------------------------- admin: create, list, revoke

describe('admin invites', () => {
  test('creates an invite, lists it without the code, and revokes it once with 204', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await putRole(host, admin.token);

    const before = instant();
    const created = await createInvite(host, admin.token, {
      roles: [ROLE],
      maxUses: 5,
      expiresInMinutes: 60,
    });

    // SP02 §3: the invite code is the longest of the three kinds, grouped in fours (24 characters).
    expect(created.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    expect(normalizeCode(created.code)).toHaveLength(CODE_LENGTH.invite);
    expect(created.invite).toMatchObject({
      roles: [ROLE],
      maxUses: 5,
      uses: 0,
      createdBy: admin.personId,
      revokedAt: null,
    });
    const ttlMinutes = (Date.parse(created.invite.expiresAt as string) - Date.parse(before)) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(59);
    expect(ttlMinutes).toBeLessThan(61);

    // Newest first, and the code is never listed: the second invite is seeded an hour in the past
    // because two requests can share a millisecond (the ordering of the query is what is pinned).
    const older = host.repo.createInvite(
      {
        id: crypto.randomUUID(),
        codeHash: 'f'.repeat(64),
        roles: [],
        maxUses: null,
        createdBy: admin.personId,
        expiresInMinutes: null,
      },
      new Date(Date.parse(before) - 3_600_000).toISOString(),
    );
    const listed = await listInvites(host, admin.token);
    expect(listed.status).toBe(200);
    // Read the bytes once: the code must not appear in them, and the parsed list is the same answer.
    const rawList = await listed.text();
    const invites = JSON.parse(rawList) as GuildInvite[];
    expect(invites.map((invite) => invite.id)).toEqual([created.invite.id, older.id]);
    expect(rawList).not.toContain(created.code);
    expect(rawList).not.toContain('codeHash');

    // The guild's own log records the invite without its code (RF-59, `invite_issued`).
    const events = await body<HostEvent[]>(await get(host, `${HOST_ROUTES.adminEvents}?limit=10`, admin.token));
    const recorded = events.filter((event) => event.kind === 'invite_issued');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].personId).toBe(admin.personId);
    expect(recorded[0].detail).toContain(ROLE);
    expect(recorded[0].detail).not.toContain(created.code);

    // Revoking: 204, then 204 again (a second revoke is a no-op), and an id nobody holds is 404.
    const revoked = await remove(host, HOST_ROUTES.adminInvite.replace(':id', created.invite.id), admin.token);
    expect(revoked.status).toBe(204);
    const again = await remove(host, HOST_ROUTES.adminInvite.replace(':id', created.invite.id), admin.token);
    expect(again.status).toBe(204);
    const unknown = await remove(host, HOST_ROUTES.adminInvite.replace(':id', crypto.randomUUID()), admin.token);
    expect(unknown.status).toBe(404);
    expect(await body<ErrorResponse>(unknown)).toEqual({ error: 'unknown invite' });

    const afterRevoke = await body<GuildInvite[]>(await listInvites(host, admin.token));
    expect(afterRevoke[0].revokedAt).not.toBeNull();
    expect(afterRevoke[0].uses).toBe(0);
  });

  test('the invite bodies are validated, and an unknown role stores nothing', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await putRole(host, admin.token);

    const noUses = await post(
      host,
      HOST_ROUTES.adminInvites,
      { roles: [], maxUses: 0, expiresInMinutes: null },
      admin.token,
    );
    expect(noUses.status).toBe(400);
    expect((await body<ErrorResponse>(noUses)).error).toContain('maxUses');

    const longExpiry = await post(
      host,
      HOST_ROUTES.adminInvites,
      { roles: [], maxUses: null, expiresInMinutes: 60 * 24 * 30 + 1 },
      admin.token,
    );
    expect(longExpiry.status).toBe(400);
    expect((await body<ErrorResponse>(longExpiry)).error).toContain('expiresInMinutes');

    const unknownRole = await post(
      host,
      HOST_ROUTES.adminInvites,
      { roles: ['ghost'], maxUses: null, expiresInMinutes: null },
      admin.token,
    );
    expect(unknownRole.status).toBe(404);
    expect(await body<ErrorResponse>(unknownRole)).toEqual({ error: 'unknown role' });
    expect(await body<GuildInvite[]>(await listInvites(host, admin.token))).toHaveLength(0);

    // Both nulls are a value, not an absence (SP03 §2): never expires, no limit.
    const forever = await createInvite(host, admin.token, {
      roles: [],
      maxUses: null,
      expiresInMinutes: null,
    });
    expect(forever.invite).toMatchObject({ maxUses: null, expiresAt: null });
    expect(host.repo.listInvites()).toHaveLength(1);
  });

  test('an invite may never grant an admin role', async () => {
    const host = await startHost();
    // `setup` creates the role `admin` with `admin = 1` (SP03 §2); an invite may not carry it.
    const admin = await setupAdmin(host);

    const refused = await post(
      host,
      HOST_ROUTES.adminInvites,
      { roles: ['admin'], maxUses: null, expiresInMinutes: null },
      admin.token,
    );
    expect(refused.status).toBe(400);
    expect(await body<ErrorResponse>(refused)).toEqual({
      error: 'an invite cannot grant an admin role',
    });
    // Refused whole: no invite row, no code, nothing to hand over.
    expect(host.repo.listInvites()).toHaveLength(0);

    // A member role is what an invite carries: the flag is the difference (`putRole` writes `admin: false`).
    await putRole(host, admin.token);
    const allowed = await createInvite(host, admin.token, {
      roles: [ROLE],
      maxUses: null,
      expiresInMinutes: null,
    });
    expect(allowed.invite.roles).toEqual([ROLE]);
  });

  test('every invite route answers 401 without a token and 403 for a member', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const invite = await createInvite(host, admin.token, {
      roles: [],
      maxUses: 1,
      expiresInMinutes: null,
    });
    const joined = await body<TokenResponse>(await join(host, invite.code));
    const member = joined.token;

    const routes: Array<[string, (token: string | null) => Promise<Response>]> = [
      ['GET /v1/admin/invites', (token) => listInvites(host, token as string)],
      [
        'POST /v1/admin/invites',
        (token) => post(host, HOST_ROUTES.adminInvites, { roles: [], maxUses: null, expiresInMinutes: null }, token),
      ],
      [
        'DELETE /v1/admin/invites/:id',
        (token) => remove(host, HOST_ROUTES.adminInvite.replace(':id', invite.invite.id), token),
      ],
    ];

    for (const [label, request] of routes) {
      expect([label, (await request(null)).status]).toEqual([label, 401]);
      const asMember = await request(member);
      expect([label, asMember.status]).toEqual([label, 403]);
      expect([label, await body<ErrorResponse>(asMember)]).toEqual([label, { error: 'admin only' }]);
    }
    // Nothing above changed the invite: the member cannot revoke what they joined with.
    expect(host.repo.listInvites()[0].revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------- public: preview

describe('invite preview', () => {
  test('shows the guild, the icon and the roles, and spends nothing', async () => {
    const host = await startHost();
    const previousGuild = process.env[GUILD_NAME_ENV];
    process.env[GUILD_NAME_ENV] = GUILD;
    try {
      const admin = await setupAdmin(host);
      await putRole(host, admin.token);
      const created = await createInvite(host, admin.token, {
        roles: [ROLE],
        maxUses: 2,
        expiresInMinutes: 60,
      });

      // No icon yet: null is a value (RF-59), not an absence.
      const bare = await post(host, HOST_ROUTES.authInvite, { code: created.code });
      expect(bare.status).toBe(200);
      const barePreview = await body<InvitePreview>(bare);
      expect(barePreview).toEqual({
        guild: GUILD,
        roles: [{ id: ROLE, name: 'Team' }],
        expiresAt: created.invite.expiresAt,
        usesLeft: 2,
        icon: null,
      });

      // The admin uploads the guild icon; the preview serves its bytes, base64url (README §Encoding).
      const uploaded = await put(host, HOST_ROUTES.adminGuildIcon, { png: toBase64url(PNG_BYTES) }, admin.token);
      expect(uploaded.status).toBe(200);
      const withIcon = await body<InvitePreview>(await post(host, HOST_ROUTES.authInvite, { code: created.code }));
      expect(withIcon.icon).toBe(toBase64url(PNG_BYTES));

      // A preview reads only: the invite is still unused, and the person is not in the guild.
      expect(host.repo.listInvites()[0].uses).toBe(0);
      expect(host.repo.personByEmail(MEMBER_EMAIL)).toBeNull();
    } finally {
      if (previousGuild === undefined) delete process.env[GUILD_NAME_ENV];
      else process.env[GUILD_NAME_ENV] = previousGuild;
    }
  });

  test('an invite that is not live is 404 invalid invite, whatever killed it', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);

    // Unknown, a code of another kind, and a string that is no code at all: one answer for all.
    for (const code of [generateCode('invite'), generateCode('setup'), 'not-a-code']) {
      const response = await post(host, HOST_ROUTES.authInvite, { code });
      expect(response.status).toBe(404);
      expect(await body<ErrorResponse>(response)).toEqual({ error: INVALID_INVITE });
    }

    const limit = await createInvite(host, admin.token, {
      roles: [],
      maxUses: 1,
      expiresInMinutes: null,
    });
    const expiring = await createInvite(host, admin.token, {
      roles: [],
      maxUses: null,
      expiresInMinutes: 30,
    });
    const revoked = await createInvite(host, admin.token, {
      roles: [],
      maxUses: null,
      expiresInMinutes: null,
    });

    // Expired and revoked: the row is moved/revoked directly, because the app's clock is the real one
    // and no route can push an invite into the past (`host/repo.ts` owns both writes).
    host.db
      .query('UPDATE guild_invites SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), expiring.invite.id);
    expect((await remove(host, HOST_ROUTES.adminInvite.replace(':id', revoked.invite.id), admin.token)).status).toBe(204);

    // Used up: the one use goes to the join below.
    expect((await join(host, limit.code)).status).toBe(200);

    for (const code of [limit.code, expiring.code, revoked.code]) {
      const response = await post(host, HOST_ROUTES.authInvite, { code });
      expect(response.status).toBe(404);
      expect(await body<ErrorResponse>(response)).toEqual({ error: INVALID_INVITE });
    }
  });
});

// ---------------------------------------------------------------- public: join

describe('join', () => {
  test('creates the account the person chooses, with the invite’s roles, and spends one use', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await putRole(host, admin.token);
    const created = await createInvite(host, admin.token, {
      roles: [ROLE],
      maxUses: 5,
      expiresInMinutes: null,
    });

    const response = await join(host, created.code, MEMBER_EMAIL, 'Bob');
    expect(response.status).toBe(200);
    const opened = await body<TokenResponse>(response);

    // The person the host created: the invite's roles, `member`, and activated by this join.
    const person = host.repo.personById(opened.personId);
    expect(person).toMatchObject({ email: MEMBER_EMAIL, name: 'Bob', kind: 'member', roles: [ROLE] });
    expect(person?.activatedAt).not.toBeNull();
    // The session is real: the person reads their own snapshot with the token the join answered.
    expect((await get(host, HOST_ROUTES.state, opened.token)).status).toBe(200);

    // One use spent, and the same person twice is one account (SP01 §2's unique email).
    expect(host.repo.listInvites()[0].uses).toBe(1);

    // A second person joining the same invite: another account, another use.
    const second = await join(host, created.code, 'cara@nod.test', 'Cara');
    expect(second.status).toBe(200);
    expect(host.repo.listInvites()[0].uses).toBe(2);
    expect((await body<TokenResponse>(second)).personId).not.toBe(opened.personId);
  });

  test('a used-up invite answers 401 and creates nobody', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const created = await createInvite(host, admin.token, {
      roles: [],
      maxUses: 1,
      expiresInMinutes: null,
    });

    expect((await join(host, created.code)).status).toBe(200);
    const exhausted = await join(host, created.code, 'cara@nod.test', 'Cara');
    expect(exhausted.status).toBe(401);
    expect(await body<ErrorResponse>(exhausted)).toEqual({ error: INVALID_INVITE });
    expect(host.repo.personByEmail('cara@nod.test')).toBeNull();
    expect(host.repo.listInvites()[0].uses).toBe(1);
  });

  test('an expired or revoked invite answers 401 invalid invite', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const expiring = await createInvite(host, admin.token, {
      roles: [],
      maxUses: null,
      expiresInMinutes: 30,
    });
    const revoked = await createInvite(host, admin.token, {
      roles: [],
      maxUses: null,
      expiresInMinutes: null,
    });
    host.db
      .query('UPDATE guild_invites SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), expiring.invite.id);
    expect((await remove(host, HOST_ROUTES.adminInvite.replace(':id', revoked.invite.id), admin.token)).status).toBe(204);

    for (const code of [expiring.code, revoked.code, generateCode('invite'), generateCode('access')]) {
      const response = await join(host, code);
      expect(response.status).toBe(401);
      expect(await body<ErrorResponse>(response)).toEqual({ error: INVALID_INVITE });
    }
    expect(host.repo.personByEmail(MEMBER_EMAIL)).toBeNull();
    expect(host.repo.listInvites().every((invite) => invite.uses === 0)).toBe(true);
  });

  test('an invite whose role was promoted to admin answers 401 and spends nothing', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await putRole(host, admin.token);
    // Created while `team` is a member role, so the create route allows it (RF-59).
    const created = await createInvite(host, admin.token, {
      roles: [ROLE],
      maxUses: 2,
      expiresInMinutes: null,
    });

    // The promotion the create route cannot know about: the same invite would now make an admin.
    const promoted = await put(
      host,
      HOST_ROUTES.adminRole.replace(':id', ROLE),
      { name: 'Team', admin: true },
      admin.token,
    );
    expect(promoted.status).toBe(200);

    const refused = await join(host, created.code);
    expect(refused.status).toBe(401);
    expect(await body<ErrorResponse>(refused)).toEqual({ error: INVALID_INVITE });
    expect(host.repo.personByEmail(MEMBER_EMAIL)).toBeNull();
    expect(host.repo.listInvites()[0].uses).toBe(0);

    // The invite is not burned: demoting the role makes it redeem again, with its own role.
    const demoted = await put(
      host,
      HOST_ROUTES.adminRole.replace(':id', ROLE),
      { name: 'Team', admin: false },
      admin.token,
    );
    expect(demoted.status).toBe(200);
    const rejoined = await join(host, created.code);
    expect(rejoined.status).toBe(200);
    const opened = await body<TokenResponse>(rejoined);
    expect(host.repo.personById(opened.personId)?.admin).toBe(false);
    expect(host.repo.personById(opened.personId)?.roles).toEqual([ROLE]);
    expect(host.repo.listInvites()[0].uses).toBe(1);
  });

  test('an email the guild already holds is 409 and spends no use', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    await putRole(host, admin.token);
    const created = await createInvite(host, admin.token, {
      roles: [ROLE],
      maxUses: 3,
      expiresInMinutes: null,
    });

    expect((await join(host, created.code, MEMBER_EMAIL, 'Bob')).status).toBe(200);
    expect(host.repo.listInvites()[0].uses).toBe(1);

    const taken = await join(host, created.code, MEMBER_EMAIL, 'Someone else');
    expect(taken.status).toBe(409);
    expect(await body<ErrorResponse>(taken)).toEqual({ error: JOIN_EMAIL_TAKEN });

    // The use the refused join would have spent is still there, the account is unchanged and the
    // session count is the join's own (SP01 §2: one person per email, whatever the invite says).
    expect(host.repo.listInvites()[0].uses).toBe(1);
    expect(host.repo.personByEmail(MEMBER_EMAIL)?.name).toBe('Bob');
    expect(host.repo.listPeople()).toHaveLength(2);

    // The same invite still works for somebody else.
    expect((await join(host, created.code, 'cara@nod.test', 'Cara')).status).toBe(200);
    expect(host.repo.listInvites()[0].uses).toBe(2);
  });

  test('a join without a name is a 400 that names the field', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const created = await createInvite(host, admin.token, { roles: [], maxUses: null, expiresInMinutes: null });

    const response = await post(host, HOST_ROUTES.authJoin, {
      email: MEMBER_EMAIL,
      code: created.code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(response.status).toBe(400);
    expect((await body<ErrorResponse>(response)).error).toContain('name');
  });

  test('ten failed joins per email per fifteen minutes, then 429 — valid invite included', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const created = await createInvite(host, admin.token, {
      roles: [],
      maxUses: null,
      expiresInMinutes: null,
    });

    // A code of the invite kind that no row holds: every attempt is the one 401 (SP02 §5's budget).
    for (let attempt = 1; attempt <= 10; attempt++) {
      const response = await join(host, generateCode('invite'));
      expect(response.status).toBe(401);
      expect(await body<ErrorResponse>(response)).toEqual({ error: INVALID_INVITE });
    }

    const limited = await join(host, created.code);
    expect(limited.status).toBe(429);
    expect(await body<ErrorResponse>(limited)).toEqual({ error: TOO_MANY_ATTEMPTS });
    expect(host.repo.personByEmail(MEMBER_EMAIL)).toBeNull();
    expect(host.repo.listInvites()[0].uses).toBe(0);

    // The budget belongs to the email: another one is still answered, and joins for real.
    expect((await join(host, created.code, 'cara@nod.test', 'Cara')).status).toBe(200);
  });
});
