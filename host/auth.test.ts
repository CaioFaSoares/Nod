// The auth surface of the host, on the real Elysia app over a temp data dir (SP02 §2–§5, SP03 §1–§2,
// SP07 §3). Every request goes through `app.handle(new Request(...))`; nothing here mocks the
// database, the repo or the app. Run with `bun test host/`.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { sha256Hex, toBase64url } from '../shared/encoding';
import {
  CODE_LENGTH,
  HOST_ROUTES,
  generateCode,
  normalizeCode,
  type Device,
} from '../shared/host-api';
import { createApp } from './app';
import {
  ADMIN_ONLY,
  INVALID_CODE,
  INVALID_CREDENTIALS,
  TOO_MANY_ATTEMPTS,
  adminAuth,
  callerOf,
  createAuthService,
  createRateLimiter,
  personAuth,
  type AuthService,
} from './auth';
import { ADMIN_EXISTS, issueSetupCode } from './cli/setup-code';
import { DEFAULT_PORT, type HostConfig } from './config';
import { hostSecretPath } from './keys';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';
import { authRoutes } from './routes/auth';

const DEVICE: Device = { name: 'nod-test', os: 'macos', appVersion: '0.3.0' };
const ADMIN_EMAIL = 'ada@nod.test';
const MEMBER_EMAIL = 'bob@nod.test';
const DAY_MS = 24 * 3_600_000;

/** What a test needs from an app: Elysia's answer to one `Request`. */
type HttpApp = { handle(request: Request): Promise<Response> };

type TestHost = {
  config: HostConfig;
  /** The connection `bootHost` opened: its type comes from the boot, never from `bun:sqlite` here. */
  db: Host['db'];
  repo: Repo;
  /** The auth service the probes run with (probeClock); the app builds its own. */
  auth: AuthService;
  /** The real app: `createApp` over the booted data dir. */
  app: HttpApp;
  /** The real guards on a two-route app, for the levels and the sliding session (SP03 §1). */
  probes: HttpApp;
  /** The probes' clock: an ISO instant a test moves instead of waiting (SP02 §5). */
  probeClock: { at: string };
  cleanup(): void;
};

const hosts: TestHost[] = [];
const dirs: string[] = [];

async function startHost(dataDir?: string): Promise<TestHost> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'nod-auth-'));
  if (dataDir === undefined) dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  const host = await bootHost(config);
  const repo = createRepo(host.db);
  const probeClock = { at: new Date().toISOString() };
  const auth = createAuthService({
    repo,
    hostSecret: new Uint8Array(readFileSync(hostSecretPath(dir))),
    now: () => probeClock.at,
  });
  const started: TestHost = {
    config,
    db: host.db,
    repo,
    auth,
    app: createApp({ config, db: host.db }),
    probes: new Elysia()
      .decorate({ repo, auth })
      .use(personAuth)
      .get('/probe/person', (ctx) => {
        const { person } = callerOf(ctx);
        return { id: person.id, admin: person.admin };
      })
      .use(adminAuth)
      .get('/probe/admin', () => 'admin'),
    probeClock,
    cleanup: () => host.close(),
  };
  hosts.push(started);
  return started;
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function url(path: string): string {
  return `http://nod.test${path}`;
}

function post(
  app: HttpApp,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

function withToken(token: string | null, headers: Record<string, string> = {}) {
  return token === null ? headers : { ...headers, authorization: `Bearer ${token}` };
}

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomAuthKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
const instant = (): string => new Date().toISOString();

/** SP02 §3: a code the host would issue, seeded through the real repo (the admin routes are H5's). */
async function seedCode(
  host: TestHost,
  kind: 'activate' | 'setup',
  personId: string | null,
  at = instant(),
) {
  const code = generateCode(kind === 'setup' ? 'setup' : 'access');
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('the generated code is not Crockford base32');
  const record = host.repo.issueCode(
    { id: crypto.randomUUID(), purpose: kind, personId, codeHash: await sha256Hex(normalized) },
    at,
  );
  return { code, record };
}

/** A member of the guild, as the admin API of H5 will create them: email, name, no roles. */
function seedMember(host: TestHost, email = MEMBER_EMAIL) {
  return host.repo.createPerson({ id: crypto.randomUUID(), email, name: 'Bob' }, instant());
}

async function signIn(host: TestHost, email: string, authKey: string): Promise<Response> {
  return post(host.app, HOST_ROUTES.authLogin, { email, authKey, device: DEVICE });
}

/** A person activated through the real route: their salt, their key, and the code that got them in. */
async function activate(host: TestHost, email = MEMBER_EMAIL) {
  const person = seedMember(host, email);
  const { code } = await seedCode(host, 'activate', person.id);
  const salt = randomSalt();
  const authKey = randomAuthKey();
  const response = await post(host.app, HOST_ROUTES.authActivate, {
    email,
    code,
    salt,
    authKey,
    device: DEVICE,
  });
  return { person, code, salt, authKey, response };
}

/** The first admin, through the real setup route. */
async function setupAdmin(host: TestHost, email = ADMIN_EMAIL) {
  const { code } = await seedCode(host, 'setup', null);
  const salt = randomSalt();
  const authKey = randomAuthKey();
  const response = await post(host.app, HOST_ROUTES.authSetup, {
    email,
    name: 'Ada',
    code,
    salt,
    authKey,
    device: DEVICE,
  });
  const body = (await response.json()) as { token: string; personId: string };
  return { code, salt, authKey, response, ...body };
}

/** The sessions the host holds, live or not: a sign-in adds one, `activate`/`setup` add one too. */
function countSessions(host: TestHost): number {
  return host.db.query<{ n: number }, []>('SELECT count(*) AS n FROM sessions').all()[0].n;
}

/** Runs the command of SP07 §3 the way the container does: a fresh process per run. */
function runCommand(dataDir: string) {
  return Bun.spawnSync([process.execPath, 'cli/setup-code.ts'], {
    cwd: import.meta.dir,
    env: { ...process.env, NOD_DATA: dataDir, NOD_PUBLIC_URL: 'https://nod.example' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/** The bytes of every file of a data dir, for "no secret in clear" (SP01 §1). */
function dataDirBytes(dir: string): string {
  let bytes = '';
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${dir}/host.db${suffix}`;
    if (existsSync(path)) bytes += readFileSync(path, 'utf8');
  }
  return bytes;
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

/**
 * F4 of the block 1 review: the real auth routes of `routes/auth.ts` over the booted repo, with the
 * service's argon2 hash counted. The routes read `auth` off the request context, so the same plugin
 * runs unchanged over a service that counts `hashAuthKey` and delegates to the real one — no mock of
 * the database, the repo or the app, only an observation of how often argon2id is asked for.
 */
function countHashes(auth: AuthService): { auth: AuthService; hashes(): number } {
  let calls = 0;
  return {
    auth: {
      ...auth,
      hashAuthKey: async (authKey: string) => {
        calls += 1;
        return await auth.hashAuthKey(authKey);
      },
    },
    hashes: () => calls,
  };
}

// ---------------------------------------------------------------- setup code (SP07 §3, SP02 §3)

describe('setup code', () => {
  test('the command prints one code, keeps only its hash, and reissues on a second run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nod-auth-'));
    dirs.push(dir);
    const first = runCommand(dir);
    expect(first.exitCode).toBe(0);
    // SP07 §3: stdout is the code and nothing else; the note about its life goes to stderr.
    const code = first.stdout.toString().trim();
    expect(first.stdout.toString()).toBe(`${code}\n`);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(first.stderr.toString()).toContain('expires at');

    const host = await startHost(dir);
    const normalized = normalizeCode(code) as string;
    expect(normalized.length).toBe(CODE_LENGTH.setup);
    const stored = host.db
      .query<{ codeHash: string; expiresAt: string }, []>(
        'SELECT code_hash AS codeHash, expires_at AS expiresAt FROM access_codes',
      )
      .all();
    expect(stored).toHaveLength(1);
    expect(stored[0].codeHash).toBe(await sha256Hex(normalized));
    // SP02 §3: 24 h, and the code itself is nowhere in clear — not in the code's own row, not in the
    // bytes of the database.
    expect(Date.parse(stored[0].expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(Date.parse(stored[0].expiresAt) - Date.now()).toBeLessThanOrEqual(DAY_MS);
    expect(dataDirBytes(dir).includes(code)).toBe(false);
    expect(dataDirBytes(dir).includes(normalized)).toBe(false);

    // Running it again revokes the previous one (SP02 §3).
    const second = runCommand(dir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString().trim()).not.toBe(code);
    const after = host.db
      .query<{ revokedAt: string | null }, []>(
        'SELECT revoked_at AS revokedAt FROM access_codes ORDER BY created_at',
      )
      .all();
    expect(after).toHaveLength(2);
    expect(after[0].revokedAt).not.toBeNull();
    expect(after[1].revokedAt).toBeNull();
  });

  test('redeeming the code of the command creates the first admin, and the command then refuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nod-auth-'));
    dirs.push(dir);
    const command = runCommand(dir);
    const code = command.stdout.toString().trim();

    const host = await startHost(dir);
    const redeemed = await post(host.app, HOST_ROUTES.authSetup, {
      email: ADMIN_EMAIL,
      name: 'Ada',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(redeemed.status).toBe(200);
    const body = (await redeemed.json()) as { token: string; personId: string };
    const person = host.repo.personById(body.personId);
    expect(person?.admin).toBe(true);
    expect(person?.roles).toEqual(['admin']);
    expect(person?.email).toBe(ADMIN_EMAIL);

    const refused = runCommand(dir);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toBe('');
    expect(refused.stderr.toString()).toContain(ADMIN_EXISTS);

    // RF-32: the code worked once.
    const again = await post(host.app, HOST_ROUTES.authSetup, {
      email: 'second@nod.test',
      name: 'Second',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: INVALID_CODE });

    // SP02 §5: the token came back once and the row keeps its hash, never the token.
    const tokens = host.db
      .query<{ tokenHash: string }, []>('SELECT token_hash AS tokenHash FROM sessions')
      .all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toBe(await sha256Hex(body.token));
    expect(dataDirBytes(dir).includes(body.token)).toBe(false);
  });

  test('issueSetupCode refuses once an admin exists and is one 24 h code otherwise', async () => {
    const host = await startHost();
    const issued = await issueSetupCode(host.repo, instant());
    expect(issued.issued).toBe(true);
    if (!issued.issued) throw new Error('unreachable');
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    const admin = await setupAdmin(host);
    expect(admin.response.status).toBe(200);
    expect(await issueSetupCode(host.repo, instant())).toEqual({ issued: false });
  });
});

// ---------------------------------------------------------------- setup route (SP03 §2)

describe('POST /v1/auth/setup', () => {
  test('creates the first admin, its role and a session, once', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    expect(admin.response.status).toBe(200);
    expect(admin.response.headers.get('set-cookie')).toBeNull();

    const person = host.repo.personById(admin.personId);
    expect(person?.admin).toBe(true);
    expect(person?.kind).toBe('member');
    expect(person?.roles).toEqual(['admin']);
    expect(person?.disabledAt).toBeNull();
    expect(host.repo.listRoles()).toEqual([{ id: 'admin', name: 'admin', admin: true }]);

    const record = host.repo.personAuthByEmail(ADMIN_EMAIL);
    expect(record?.salt).toBe(admin.salt);
    expect(record?.authHash?.startsWith('$argon2id$')).toBe(true);
    // RF-42: what was hashed is the `authKey` the Nod derived, and the password never travelled.
    expect(await Bun.password.verify(admin.authKey, record?.authHash as string)).toBe(true);
  });

  test('answers 409 on a taken email and leaves the setup code unspent', async () => {
    const host = await startHost();
    seedMember(host, 'taken@nod.test');
    const { code } = await seedCode(host, 'setup', null);

    const conflict = await post(host.app, HOST_ROUTES.authSetup, {
      email: 'taken@nod.test',
      name: 'Nobody',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'email taken' });
    expect(host.repo.personByEmail('taken@nod.test')?.name).toBe('Bob');

    // The transaction rolled back with the code: the same code still creates the admin.
    const admin = await post(host.app, HOST_ROUTES.authSetup, {
      email: ADMIN_EMAIL,
      name: 'Ada',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(admin.status).toBe(200);
    expect(host.repo.adminCount()).toBe(1);
  });

  // F4 of the block 1 review: the same shape as `activate` — a malformed code used to answer before
  // any argon2id work, while a well-formed code paid the hash `redeemCode` needed. Both cost one now.
  test('a malformed code and a real redemption pay one argon2id hash each', async () => {
    const host = await startHost();
    const counted = countHashes(host.auth);
    const app = new Elysia().decorate({ repo: host.repo, auth: counted.auth }).use(authRoutes);

    const beforeMalformed = counted.hashes();
    const malformed = await post(app, HOST_ROUTES.authSetup, {
      email: ADMIN_EMAIL,
      name: 'Ada',
      code: 'nope',
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({ error: INVALID_CODE });
    expect(counted.hashes() - beforeMalformed).toBe(1);

    const { code } = await seedCode(host, 'setup', null);
    const beforeRedeem = counted.hashes();
    const admin = await post(app, HOST_ROUTES.authSetup, {
      email: ADMIN_EMAIL,
      name: 'Ada',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(admin.status).toBe(200);
    expect(counted.hashes() - beforeRedeem).toBe(1);
  });
});

// ---------------------------------------------------------------- activate (SP02 §3, RF-33)

describe('POST /v1/auth/activate', () => {
  test('redeems a code bound to the email and stores salt and argon2id(authKey)', async () => {
    const host = await startHost();
    const activated = await activate(host);
    expect(activated.response.status).toBe(200);
    const body = (await activated.response.json()) as { token: string; personId: string };
    expect(body.personId).toBe(activated.person.id);

    const record = host.repo.personAuthByEmail(MEMBER_EMAIL);
    expect(record?.salt).toBe(activated.salt);
    expect(record?.authHash?.startsWith('$argon2id$')).toBe(true);
    expect(await Bun.password.verify(activated.authKey, record?.authHash as string)).toBe(true);
    expect(host.repo.personById(activated.person.id)?.activatedAt).not.toBeNull();

    // SP02 §3: the code works once.
    const again = await post(host.app, HOST_ROUTES.authActivate, {
      email: MEMBER_EMAIL,
      code: activated.code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: INVALID_CODE });

    // The token the route returned signs the person in on the person level.
    const probe = await host.probes.handle(
      new Request(url('/probe/person'), { headers: withToken(body.token) }),
    );
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ id: activated.person.id, admin: false });
  });

  test('a code of another email, and an email nobody holds, are the same single failure', async () => {
    const host = await startHost();
    const first = seedMember(host, 'first@nod.test');
    seedMember(host, 'second@nod.test');
    const { code } = await seedCode(host, 'activate', first.id);

    const wrongEmail = await post(host.app, HOST_ROUTES.authActivate, {
      email: 'second@nod.test',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    const unknownEmail = await post(host.app, HOST_ROUTES.authActivate, {
      email: 'ghost@nod.test',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(wrongEmail.status).toBe(401);
    const wrongText = await wrongEmail.text();
    expect(wrongText).toBe(await unknownEmail.text());
    expect(JSON.parse(wrongText)).toEqual({ error: INVALID_CODE });

    // Neither attempt touched a row, and the code still activates the person it belongs to.
    expect(host.repo.personById(first.id)?.activatedAt).toBeNull();
    expect(host.repo.personAuthByEmail('second@nod.test')?.authHash).toBeNull();
    const right = await post(host.app, HOST_ROUTES.authActivate, {
      email: 'first@nod.test',
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(right.status).toBe(200);
  });

  test('the code dies after five wrong tries', async () => {
    const host = await startHost();
    const person = seedMember(host);
    const { code } = await seedCode(host, 'activate', person.id);

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await post(host.app, HOST_ROUTES.authActivate, {
        email: MEMBER_EMAIL,
        code: 'ZZZZ-ZZZZ',
        salt: randomSalt(),
        authKey: randomAuthKey(),
        device: DEVICE,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: INVALID_CODE });
    }
    expect(host.repo.personById(person.id)?.activatedAt).toBeNull();

    // The sixth request already carries the right code: the fifth miss revoked it.
    const sixth = await post(host.app, HOST_ROUTES.authActivate, {
      email: MEMBER_EMAIL,
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(sixth.status).toBe(401);
    expect(await sixth.json()).toEqual({ error: INVALID_CODE });
  });

  test('the code dies after 72 h', async () => {
    const host = await startHost();
    const person = seedMember(host);
    const { code } = await seedCode(
      host,
      'activate',
      person.id,
      new Date(Date.now() - 73 * 3_600_000).toISOString(),
    );

    const response = await post(host.app, HOST_ROUTES.authActivate, {
      email: MEMBER_EMAIL,
      code,
      salt: randomSalt(),
      authKey: randomAuthKey(),
      device: DEVICE,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: INVALID_CODE });
    expect(host.repo.personById(person.id)?.activatedAt).toBeNull();
  });

  // F4 of the block 1 review: the timing oracle. An unknown email and a malformed code used to return
  // before `hashAuthKey`, while a known email with a wrong code paid the argon2id hash — one
  // `invalid code`, told apart by the clock and so a way to ask who exists. Every branch pays it now.
  test('an unknown email, a malformed code and a wrong code each pay one argon2id hash', async () => {
    const host = await startHost();
    const counted = countHashes(host.auth);
    const app = new Elysia().decorate({ repo: host.repo, auth: counted.auth }).use(authRoutes);

    async function attempt(
      email: string,
      code: string,
    ): Promise<{ status: number; cost: number; text: string }> {
      const before = counted.hashes();
      const response = await post(app, HOST_ROUTES.authActivate, {
        email,
        code,
        salt: randomSalt(),
        authKey: randomAuthKey(),
        device: DEVICE,
      });
      return { status: response.status, cost: counted.hashes() - before, text: await response.text() };
    }

    // The reference: the success path hashes the `authKey` it is about to store.
    const person = seedMember(host);
    const { code } = await seedCode(host, 'activate', person.id);
    const success = await attempt(MEMBER_EMAIL, code);
    expect(success.status).toBe(200);
    expect(success.cost).toBe(1);
    expect(host.repo.personById(person.id)?.activatedAt).not.toBeNull();

    // An email nobody holds, with a code of the right shape the host never issued.
    const unknown = await attempt('ghost@nod.test', generateCode('access'));
    // A malformed code on an email that does exist: the normalizer refuses before any lookup.
    const malformed = await attempt(MEMBER_EMAIL, 'nope');
    // A well-formed code of another person: `redeemCode` finds no live row with that hash.
    const other = seedMember(host, 'other@nod.test');
    await seedCode(host, 'activate', other.id);
    const wrongCode = await attempt('other@nod.test', generateCode('access'));

    // One status, one body, one argon2id hash: nothing separates the three failures.
    expect([unknown.status, malformed.status, wrongCode.status]).toEqual([401, 401, 401]);
    expect(unknown.text).toBe(malformed.text);
    expect(malformed.text).toBe(wrongCode.text);
    expect(JSON.parse(unknown.text)).toEqual({ error: INVALID_CODE });
    expect([unknown.cost, malformed.cost, wrongCode.cost]).toEqual([1, 1, 1]);

    // Neither failure wrote anything: no person was invented, no code was spent.
    expect(host.repo.personAuthByEmail('ghost@nod.test')).toBeNull();
    expect(host.repo.personById(other.id)?.activatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------- salt (SP02 §4)

describe('POST /v1/auth/salt', () => {
  test('answers the stored salt of an activated person, with the same iterations for everyone', async () => {
    const host = await startHost();
    const activated = await activate(host);
    expect(activated.response.status).toBe(200);

    const known = await post(host.app, HOST_ROUTES.authSalt, { email: MEMBER_EMAIL });
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ salt: activated.salt, iterations: 600_000 });

    const unknown = await post(host.app, HOST_ROUTES.authSalt, { email: 'ghost@nod.test' });
    expect(unknown.status).toBe(200);
    const unknownBody = (await unknown.json()) as { salt: string; iterations: number };
    expect(unknownBody.iterations).toBe(600_000);
    expect(unknownBody.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(unknownBody.salt).not.toBe(activated.salt);
  });

  test('answers a stable fake salt for an unknown email, derived from host-secret', async () => {
    const host = await startHost();
    const first = await post(host.app, HOST_ROUTES.authSalt, { email: ' Ghost@Nod.test ' });
    const second = await post(host.app, HOST_ROUTES.authSalt, { email: 'ghost@nod.test' });
    const other = await post(host.app, HOST_ROUTES.authSalt, { email: 'other@nod.test' });

    const firstBody = (await first.json()) as { salt: string };
    const secondBody = (await second.json()) as { salt: string };
    const otherBody = (await other.json()) as { salt: string };
    const salt = firstBody.salt;
    expect(secondBody.salt).toBe(salt);
    expect(otherBody.salt).not.toBe(salt);
    expect(salt).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // SP02 §4's derivation, recomputed from the file `keys.ts` wrote.
    const secret = new Uint8Array(readFileSync(hostSecretPath(host.config.dataDir)));
    const key = await crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('fake-salt/ghost@nod.test')),
    );
    expect(salt).toBe(toBase64url(mac.subarray(0, 16)));

    // The lookup never creates anybody.
    expect(host.repo.personByEmail('ghost@nod.test')).toBeNull();
  });
});

// ---------------------------------------------------------------- login (SP02 §5)

describe('POST /v1/auth/login', () => {
  test('a wrong key and an unknown email answer byte-identical bodies', async () => {
    const host = await startHost();
    const activated = await activate(host);
    expect(activated.response.status).toBe(200);

    const wrongKey = await signIn(host, MEMBER_EMAIL, randomAuthKey());
    const unknownEmail = await signIn(host, 'ghost@nod.test', randomAuthKey());
    expect(wrongKey.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongKey.headers.get('content-type')).toBe(unknownEmail.headers.get('content-type'));
    expect(await wrongKey.text()).toBe(await unknownEmail.text());
    const body = await signIn(host, MEMBER_EMAIL, randomAuthKey());
    expect(await body.json()).toEqual({ error: INVALID_CREDENTIALS });
    // No failed sign-in left anything behind: the only session is the one activation opened.
    expect(countSessions(host)).toBe(1);
  });

  test('signs in with the key of activation, on as many devices as asked', async () => {
    const host = await startHost();
    const activated = await activate(host);

    const first = await signIn(host, MEMBER_EMAIL, activated.authKey);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { token: string; personId: string };
    expect(firstBody.personId).toBe(activated.person.id);
    expect(firstBody.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const second = await signIn(host, MEMBER_EMAIL, activated.authKey);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { token: string };
    expect(secondBody.token).not.toBe(firstBody.token);
    // Two sign-ins on top of the one activation opened (SP02 §5: one row per device).
    expect(countSessions(host)).toBe(3);
    expect(host.repo.sessionsOfPerson(activated.person.id, instant())).toHaveLength(3);

    for (const token of [firstBody.token, secondBody.token]) {
      const probe = await host.probes.handle(
        new Request(url('/probe/person'), { headers: withToken(token) }),
      );
      expect(probe.status).toBe(200);
    }
  });

  test('a disabled person cannot sign in', async () => {
    const host = await startHost();
    const activated = await activate(host);
    const admin = await setupAdmin(host);
    expect(admin.response.status).toBe(200);

    host.repo.setDisabled(activated.person.id, true, instant());
    const response = await signIn(host, MEMBER_EMAIL, activated.authKey);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: INVALID_CREDENTIALS });
  });

  test('every authenticated request slides the session fourteen days', async () => {
    const host = await startHost();
    const activated = await activate(host);
    const login = await signIn(host, MEMBER_EMAIL, activated.authKey);
    const { token } = (await login.json()) as { token: string };
    const session = host.repo.sessionsOfPerson(activated.person.id, instant())[0];
    const before = host.repo.sessionById(session.id) as { lastSeenAt: string; expiresAt: string };
    expect(Date.parse(before.expiresAt) - Date.parse(before.lastSeenAt)).toBe(14 * DAY_MS);

    // The probes' clock moves an hour instead of the test waiting for one (SP02 §5).
    const later = new Date(Date.parse(before.lastSeenAt) + 3_600_000).toISOString();
    host.probeClock.at = later;
    const probe = await host.probes.handle(
      new Request(url('/probe/person'), { headers: withToken(token) }),
    );
    expect(probe.status).toBe(200);

    const after = host.repo.sessionById(session.id) as { lastSeenAt: string; expiresAt: string };
    expect(after.lastSeenAt).toBe(later);
    expect(Date.parse(after.expiresAt) - Date.parse(after.lastSeenAt)).toBe(14 * DAY_MS);
  });
});

// ---------------------------------------------------------------- logout and password (SP03 §2)

describe('POST /v1/auth/logout and /v1/auth/password', () => {
  test('no token, a bogus token and a malformed header are the same 401 with no cookie', async () => {
    const host = await startHost();
    await activate(host);

    const headers = [
      {},
      withToken(randomAuthKey()),
      { authorization: 'Bearer' },
      { authorization: 'Basic abc' },
    ];
    for (const header of headers) {
      const response = await post(host.app, HOST_ROUTES.authLogout, undefined, header);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: INVALID_CREDENTIALS });
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  test('logout answers 204 and revokes the token it was called with', async () => {
    const host = await startHost();
    const activated = await activate(host);
    const login = await signIn(host, MEMBER_EMAIL, activated.authKey);
    const { token } = (await login.json()) as { token: string };

    const response = await post(host.app, HOST_ROUTES.authLogout, undefined, withToken(token));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');

    const again = await post(host.app, HOST_ROUTES.authLogout, undefined, withToken(token));
    expect(again.status).toBe(401);
    // Only that session died: the one activation opened is still live (SP02 §5).
    expect(countSessions(host)).toBe(2);
    expect(host.repo.sessionsOfPerson(activated.person.id, instant())).toHaveLength(1);
  });

  test('a password change keeps the session and swaps the salt and the hash', async () => {
    const host = await startHost();
    const activated = await activate(host);
    const login = await signIn(host, MEMBER_EMAIL, activated.authKey);
    const { token } = (await login.json()) as { token: string };

    const wrongCurrent = await post(
      host.app,
      HOST_ROUTES.authPassword,
      { currentAuthKey: randomAuthKey(), newSalt: randomSalt(), newAuthKey: randomAuthKey() },
      withToken(token),
    );
    expect(wrongCurrent.status).toBe(401);
    expect(await wrongCurrent.json()).toEqual({ error: INVALID_CREDENTIALS });
    expect(host.repo.personAuthByEmail(MEMBER_EMAIL)?.salt).toBe(activated.salt);

    const newSalt = randomSalt();
    const newAuthKey = randomAuthKey();
    const changed = await post(
      host.app,
      HOST_ROUTES.authPassword,
      { currentAuthKey: activated.authKey, newSalt, newAuthKey },
      withToken(token),
    );
    expect(changed.status).toBe(204);

    const record = host.repo.personAuthByEmail(MEMBER_EMAIL);
    expect(record?.salt).toBe(newSalt);
    expect(await Bun.password.verify(newAuthKey, record?.authHash as string)).toBe(true);
    expect(await Bun.password.verify(activated.authKey, record?.authHash as string)).toBe(false);

    // SP02 §7: the session survives the change, and the new key is the one that signs in.
    const probe = await host.probes.handle(
      new Request(url('/probe/person'), { headers: withToken(token) }),
    );
    expect(probe.status).toBe(200);
    expect((await signIn(host, MEMBER_EMAIL, newAuthKey)).status).toBe(200);
    expect((await signIn(host, MEMBER_EMAIL, activated.authKey)).status).toBe(401);
  });
});

// ---------------------------------------------------------------- guards (SP03 §1)

describe('auth levels', () => {
  test('the admin level answers 401 without a session, 403 for a member and 200 for an admin', async () => {
    const host = await startHost();
    const member = await activate(host);
    const admin = await setupAdmin(host);
    const memberLogin = await signIn(host, MEMBER_EMAIL, member.authKey);
    const memberLoginBody = (await memberLogin.json()) as { token: string };

    const anonymous = await host.probes.handle(new Request(url('/probe/admin')));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: INVALID_CREDENTIALS });

    const forbidden = await host.probes.handle(
      new Request(url('/probe/admin'), { headers: withToken(memberLoginBody.token) }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: ADMIN_ONLY });

    const allowed = await host.probes.handle(
      new Request(url('/probe/admin'), { headers: withToken(admin.token) }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('admin');
  });

  test('a live session of a person the host disabled is refused', async () => {
    const host = await startHost();
    const activated = await activate(host);
    const login = await signIn(host, MEMBER_EMAIL, activated.authKey);
    const { token } = (await login.json()) as { token: string };

    const before = await host.probes.handle(
      new Request(url('/probe/person'), { headers: withToken(token) }),
    );
    expect(before.status).toBe(200);

    // SP03 §1: the person level is "a valid session, person not disabled". Disabling already
    // revokes the sessions (SP02 §5), so the session is written back to life here to prove the guard
    // itself refuses a disabled person.
    host.db.query('UPDATE people SET disabled_at = ? WHERE id = ?').run(instant(), activated.person.id);
    const after = await host.probes.handle(
      new Request(url('/probe/person'), { headers: withToken(token) }),
    );
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: INVALID_CREDENTIALS });
  });
});

// ---------------------------------------------------------------- rate limits (SP02 §5)

describe('rate limits', () => {
  test('thirty auth requests per address per minute, then 429', async () => {
    const host = await startHost();
    const address = { 'x-forwarded-for': '203.0.113.7' };

    for (let request = 1; request <= 30; request++) {
      const response = await post(
        host.app,
        HOST_ROUTES.authSalt,
        { email: `person${request}@nod.test` },
        address,
      );
      expect(response.status).toBe(200);
    }
    const limited = await post(
      host.app,
      HOST_ROUTES.authSalt,
      { email: 'person31@nod.test' },
      address,
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: TOO_MANY_ATTEMPTS });

    // The budget belongs to the address: another one is still answered.
    const other = await post(
      host.app,
      HOST_ROUTES.authSalt,
      { email: 'person@nod.test' },
      { 'x-forwarded-for': '203.0.113.8' },
    );
    expect(other.status).toBe(200);
  });

  test('ten failed sign-ins per email per fifteen minutes, then 429', async () => {
    const host = await startHost();
    const activated = await activate(host);

    for (let attempt = 1; attempt <= 10; attempt++) {
      const response = await signIn(host, MEMBER_EMAIL, randomAuthKey());
      expect(response.status).toBe(401);
    }
    const limited = await signIn(host, MEMBER_EMAIL, activated.authKey);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: TOO_MANY_ATTEMPTS });

    // Another email is not punished for it.
    expect((await signIn(host, 'ghost@nod.test', randomAuthKey())).status).toBe(401);
  });

  test('the budget and the guard of the auth plugin stay inside it', async () => {
    const host = await startHost();
    // A group mounted after the auth plugin, exactly as H5, H6 and H8 will mount theirs.
    const after = new Elysia()
      .decorate({ repo: host.repo, auth: host.auth })
      .use(authRoutes)
      .get('/probe/after', () => 'after');

    for (let request = 1; request <= 30; request++) {
      const response = await post(
        after,
        HOST_ROUTES.authSalt,
        { email: `person${request}@nod.test` },
        { 'x-forwarded-for': '192.0.2.5' },
      );
      expect(response.status).toBe(200);
    }
    const limited = await post(
      after,
      HOST_ROUTES.authSalt,
      { email: 'person31@nod.test' },
      { 'x-forwarded-for': '192.0.2.5' },
    );
    expect(limited.status).toBe(429);

    // The route of the next group answers: neither the address budget nor the person guard leaked.
    const next = await after.handle(new Request(url('/probe/after')));
    expect(next.status).toBe(200);
    expect(await next.text()).toBe('after');
  });

  test('both windows end: the address after a minute, the email after fifteen', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter(() => clock);

    for (let request = 1; request <= 30; request++) expect(limiter.allowAddress('a')).toBe(true);
    expect(limiter.allowAddress('a')).toBe(false);
    clock += 60_000;
    expect(limiter.allowAddress('a')).toBe(true);
    // A different address never shared the budget.
    expect(limiter.allowAddress('b')).toBe(true);

    for (let attempt = 1; attempt <= 10; attempt++) limiter.failEmail(' Person@Nod.test ');
    expect(limiter.allowEmail('person@nod.test')).toBe(false);
    expect(limiter.allowEmail('other@nod.test')).toBe(true);
    clock += 15 * 60_000;
    expect(limiter.allowEmail('person@nod.test')).toBe(true);
  });
});

// ---------------------------------------------------------------- SP03 §1's shape

describe('errors, sizes and logs', () => {
  test('a body that fails its schema is a 400 that names the field', async () => {
    const host = await startHost();
    const missing = await post(host.app, HOST_ROUTES.authLogin, { email: MEMBER_EMAIL });
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as { error: string };
    expect(missingBody.error).toContain('authKey');

    const shortKey = await post(host.app, HOST_ROUTES.authLogin, {
      email: MEMBER_EMAIL,
      authKey: 'x'.repeat(40),
      device: DEVICE,
    });
    expect(shortKey.status).toBe(400);
    const shortKeyBody = (await shortKey.json()) as { error: string };
    expect(shortKeyBody.error).toContain('authKey');

    const badOs = await post(host.app, HOST_ROUTES.authLogin, {
      email: MEMBER_EMAIL,
      authKey: randomAuthKey(),
      device: { ...DEVICE, os: 'plan9' },
    });
    expect(badOs.status).toBe(400);
    const badOsBody = (await badOs.json()) as { error: string };
    expect(badOsBody.error).toContain('device.os');

    const notJson = await post(host.app, HOST_ROUTES.authSalt, '{not json');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'invalid body' });
  });

  test('an unknown path is a 404 in the same shape', async () => {
    const host = await startHost();
    const response = await host.app.handle(new Request(url('/v1/nope')));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });

  test('a body over 256 KB is refused, and a tool body may reach 512 KB', async () => {
    const host = await startHost();
    const big = JSON.stringify({ email: `${'x'.repeat(300_000)}@nod.test` });
    const tooBig = await post(host.app, HOST_ROUTES.authSalt, big);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ error: 'body too large' });

    // SP03 §1's exception: the tool routes may carry an icon of up to 512 KB, so their body is not
    // refused at 256 KB — it lands on the 404 of the route H5 has not written yet.
    const toolBody = await post(host.app, '/v1/admin/tools/tool-1', big);
    expect(toolBody.status).toBe(404);
    const overIcon = await post(
      host.app,
      '/v1/admin/tools/tool-1',
      JSON.stringify({ icon: 'x'.repeat(600_000) }),
    );
    expect(overIcon.status).toBe(413);
  });

  test('no authKey, code or token reaches a log', async () => {
    const host = await startHost();
    const admin = await setupAdmin(host);
    const member = await activate(host);

    const captured = captureConsole();
    try {
      const login = await signIn(host, MEMBER_EMAIL, member.authKey);
      const { token } = (await login.json()) as { token: string };
      await signIn(host, MEMBER_EMAIL, randomAuthKey());
      await signIn(host, 'ghost@nod.test', randomAuthKey());
      await post(host.app, HOST_ROUTES.authSalt, { email: MEMBER_EMAIL });
      await post(host.app, HOST_ROUTES.authLogout, undefined, withToken(token));
      await post(host.app, HOST_ROUTES.authLogin, { email: MEMBER_EMAIL });
      await post(host.app, HOST_ROUTES.authActivate, { email: MEMBER_EMAIL, code: member.code });

      const logged = captured.lines.join('\n');
      expect(logged).not.toContain(member.authKey);
      expect(logged).not.toContain(member.code);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(admin.authKey);
      expect(logged).not.toContain(admin.code);
      expect(logged).not.toContain(admin.token);
      // Nothing was written at all: a failing request answers with a body, not with a log line.
      expect(captured.lines).toEqual([]);
    } finally {
      captured.restore();
    }
  });
});
