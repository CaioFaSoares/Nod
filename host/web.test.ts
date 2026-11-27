// The web portal's own surface (E04 M1, RF-73–RF-76): the flag, the page and its hardening headers,
// the cookie session with the derivation the browser runs, the granted catalog, the Origin check and
// the sign-out — on the real Elysia app over a temp data dir, exactly as `auth.test.ts` runs the
// auth surface. Run with `bun test host/`.
//
// The password never travels here either: every sign-in derives `authKey` with the same
// `shared/auth.ts` the app and the page share, and only that crosses the wire (RF-75).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveKeys, randomSalt } from '../shared/auth';
import { fromBase64url, toBase64url } from '../shared/encoding';
import { GUILD_NAME_ENV } from './config';
import { issueSetupCode } from './cli/setup-code';
import { createApp } from './app';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';
import { DEFAULT_PORT, type HostConfig } from './config';

const GUILD = 'Web Test Guild';
const ADMIN_EMAIL = 'ada@nod.test';
const MEMBER_EMAIL = 'bob@nod.test';
const ADMIN_PASSWORD = 'admin-web-password-1';
const MEMBER_PASSWORD = 'member-web-password-1';
const PAGE = '<!doctype html><title>Nod</title><script src="/app.js"></script>';
const SCRIPT = 'export default 1;';
const STYLE = 'body { margin: 0 }';

type HttpApp = { handle(request: Request): Promise<Response> };

type TestHost = {
  config: HostConfig;
  db: Host['db'];
  repo: Repo;
  app: HttpApp;
  webDir: string;
  cleanup(): void;
};

const hosts: TestHost[] = [];
const dirs: string[] = [];
const webDirs: string[] = [];
let guildWas: string | undefined;

/** A host with the portal on (`WEB_UI` resolved at boot, a temp page directory of its own). */
async function startWebHost(options: { dev?: boolean; webUi?: boolean } = {}): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-web-'));
  dirs.push(dir);
  const webDir = mkdtempSync(join(tmpdir(), 'nod-web-page-'));
  webDirs.push(webDir);
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), PAGE);
  writeFileSync(join(webDir, 'app.js'), SCRIPT);
  writeFileSync(join(webDir, 'style.css'), STYLE);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: options.dev ?? false,
    ...(options.webUi === false ? {} : { webUi: true }),
  };
  const booted = await bootHost(config);
  const repo = createRepo(booted.db);
  const started: TestHost = {
    config,
    db: booted.db,
    repo,
    app: createApp({ config, db: booted.db, webDir }),
    webDir,
    cleanup: () => booted.close(),
  };
  hosts.push(started);
  return started;
}

beforeEach(() => {
  guildWas = process.env[GUILD_NAME_ENV];
  process.env[GUILD_NAME_ENV] = GUILD;
});

afterEach(() => {
  if (guildWas === undefined) delete process.env[GUILD_NAME_ENV];
  else process.env[GUILD_NAME_ENV] = guildWas;
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of webDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function url(path: string): string {
  return `http://nod.test${path}`;
}

function request(
  app: HttpApp,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return app.handle(
    new Request(url(path), {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

function post(app: HttpApp, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return request(app, path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
}

/** The salt the host answers for an email (SP02 §4: for every email, real or not). */
async function saltOf(app: HttpApp, email: string): Promise<{ salt: string; iterations: number }> {
  const response = await post(app, '/v1/auth/salt', { email });
  expect(response.status).toBe(200);
  return (await response.json()) as { salt: string; iterations: number };
}

/** `authKey` of a password over the host's salt, as the page derives it (RF-75). */
async function derivedKey(app: HttpApp, email: string, password: string): Promise<string> {
  const { salt, iterations } = await saltOf(app, email);
  const keys = await deriveKeys(password, fromBase64url(salt), iterations);
  return toBase64url(keys.authKey);
}

/** The first admin through the real setup route, with its own derived key (SP02 §3). */
async function setupAdmin(host: TestHost): Promise<{ token: string; personId: string }> {
  const issued = await issueSetupCode(host.repo, new Date().toISOString());
  if (!issued.issued) throw new Error('no setup code');
  const salt = randomSalt();
  const keys = await deriveKeys(ADMIN_PASSWORD, fromBase64url(salt), 600_000);
  const response = await post(host.app, '/v1/auth/setup', {
    email: ADMIN_EMAIL,
    name: 'Ada',
    code: issued.code,
    salt,
    authKey: toBase64url(keys.authKey),
    device: { name: 'nod-test', os: 'macos', appVersion: '1.0.0' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; personId: string };
}

/** The token of a web sign-in, from the `Set-Cookie` the login answered. */
function cookieToken(response: Response): string {
  const set = response.headers.get('set-cookie');
  expect(set).not.toBeNull();
  return (set as string).split(';')[0]?.split('=')[1] ?? '';
}

describe('the web portal (RF-73)', () => {
  test('the flag decides whether the portal exists', async () => {
    const off = await startWebHost({ webUi: false });
    const refused = await request(off.app, '/');
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'not found' });

    const on = await startWebHost();
    const page = await request(on.app, '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toBe(PAGE);
    // E04 §3's hardening, on every file the portal serves.
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toBe('no-store');

    const script = await request(on.app, '/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe(SCRIPT);
    const style = await request(on.app, '/style.css');
    expect(style.status).toBe(200);
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');
    // A path the map does not name is the host's own 404, never a file read.
    expect((await request(on.app, '/../etc/passwd')).status).toBe(404);
    expect((await request(on.app, '/nope.js')).status).toBe(404);
  });

  test('the browser signs in with the derived key and gets the cookie (RF-74/RF-75)', async () => {
    const host = await startWebHost();
    const admin = await setupAdmin(host);
    expect(admin.token).not.toBe('');

    // The page's own derivation: the salt request and PBKDF2, only the `authKey` on the wire.
    const authKey = await derivedKey(host.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const origin = { origin: 'http://nod.test' };
    const login = await post(host.app, '/web/api/login', { email: ADMIN_EMAIL, authKey }, origin);
    expect(login.status).toBe(204);
    const set = login.headers.get('set-cookie') as string;
    // RF-74: the cookie the page's JavaScript cannot read, first-party only.
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Secure'); // a production deployment serves the portal through TLS

    const token = cookieToken(login);
    const cookie = { cookie: `nod_web=${token}` };
    const me = await request(host.app, '/web/api/me', { headers: cookie });
    expect(me.status).toBe(200);
    const who = (await me.json()) as { guild: string; name: string; email: string; admin: boolean };
    expect(who).toEqual({ guild: GUILD, name: 'Ada', email: ADMIN_EMAIL, admin: true });

    // No cookie, no person — and a dead cookie answers the same 401 (SP02 §5's one answer).
    expect((await request(host.app, '/web/api/me')).status).toBe(401);
    expect((await request(host.app, '/web/api/me', { headers: { cookie: 'nod_web=dead' } })).status).toBe(401);
  });

  test('the catalog answers exactly what the roles grant, with the roster beside it', async () => {
    const host = await startWebHost();
    const admin = await setupAdmin(host);
    const bearer = { authorization: `Bearer ${admin.token}` };

    // One tool granted to `team`, one to nobody; the member joins through a real invite.
    await request(host.app, '/v1/admin/roles/team', {
      method: 'PUT',
      body: { name: 'Team', admin: false },
      headers: { 'content-type': 'application/json', ...bearer },
    });
    const tool = (id: string, roles: string[]): Promise<Response> =>
      request(host.app, `/v1/admin/tools/${id}`, {
        method: 'PUT',
        body: {
          id,
          title: id,
          url: `https://${id}.example.test`,
          icon: null,
          order: 0,
          roles,
          views: [],
          auth: null,
          active: true,
          tags: id === 'granted' ? ['docs'] : [],
          orgAccount: id === 'granted' ? 'team@guild.example' : null,
        },
        headers: { 'content-type': 'application/json', ...bearer },
      });
    expect((await tool('granted', ['team'])).status).toBe(200);
    expect((await tool('private', [])).status).toBe(200);

    const invite = await post(host.app, '/v1/admin/invites', { roles: ['team'], maxUses: null, expiresInMinutes: null }, bearer);
    expect(invite.status).toBe(200);
    const { code } = (await invite.json()) as { code: string };
    const memberSalt = randomSalt();
    const memberKeys = await deriveKeys(MEMBER_PASSWORD, fromBase64url(memberSalt), 600_000);
    const joined = await post(host.app, '/v1/auth/join', {
      email: MEMBER_EMAIL,
      name: 'Bob',
      code,
      salt: memberSalt,
      authKey: toBase64url(memberKeys.authKey),
      device: { name: 'nod-test', os: 'macos', appVersion: '1.0.0' },
    });
    expect(joined.status).toBe(200);

    // The member's web sign-in, and their catalog: the granted tool with the library's fields, the
    // private one never, and the roster + the guild's roles for the organization views (RF-79).
    const memberKey = await derivedKey(host.app, MEMBER_EMAIL, MEMBER_PASSWORD);
    const login = await post(host.app, '/web/api/login', { email: MEMBER_EMAIL, authKey: memberKey }, { origin: 'http://nod.test' });
    expect(login.status).toBe(204);
    const cookie = { cookie: `nod_web=${cookieToken(login)}` };
    const catalog = await request(host.app, '/web/api/catalog', { headers: cookie });
    expect(catalog.status).toBe(200);
    const body = (await catalog.json()) as {
      favorites: string[];
      orgTools: Array<{ id: string; tags?: string[]; orgAccount?: string | null }>;
      personalTools: unknown[];
      roles: Array<{ id: string }>;
      people: Array<{ name: string; roles: string[] }>;
    };
    expect(body.orgTools.map((entry) => entry.id)).toEqual(['granted']);
    expect(body.orgTools[0]?.tags).toEqual(['docs']);
    expect(body.orgTools[0]?.orgAccount).toBe('team@guild.example');
    expect(body.personalTools).toEqual([]);
    expect(body.favorites).toEqual([]);
    expect(body.roles.map((role) => role.id)).toContain('team');
    expect(body.people.map((person) => person.name).sort()).toEqual(['Ada', 'Bob']);

    // The admin sees both — the repo's own rule, never a second one.
    const adminKey = await derivedKey(host.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const adminLogin = await post(host.app, '/web/api/login', { email: ADMIN_EMAIL, authKey: adminKey }, { origin: 'http://nod.test' });
    const adminCatalog = await request(host.app, '/web/api/catalog', { headers: { cookie: `nod_web=${cookieToken(adminLogin)}` } });
    const adminBody = (await adminCatalog.json()) as { orgTools: Array<{ id: string }> };
    expect(adminBody.orgTools.map((entry) => entry.id).sort()).toEqual(['granted', 'private']);
  });

  test('a wrong key, a foreign origin and a disabled person are refused (RF-75/RF-76)', async () => {
    const host = await startWebHost();
    await setupAdmin(host);

    const wrong = await derivedKey(host.app, ADMIN_EMAIL, 'not-the-password');
    const refused = await post(host.app, '/web/api/login', { email: ADMIN_EMAIL, authKey: wrong }, { origin: 'http://nod.test' });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'invalid credentials' });

    // RF-76: the write of another origin never reaches the auth service.
    const authKey = await derivedKey(host.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const foreign = await post(host.app, '/web/api/login', { email: ADMIN_EMAIL, authKey }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'origin refused' });

    // Behind the TLS proxy the host's request URL is plain `http://`, but the browser's `Origin` is
    // the public `https://` address (SP07 §6): that one is the host's own, with or without a port.
    const proxied = await post(host.app, '/web/api/login', { email: ADMIN_EMAIL, authKey }, { origin: 'https://nod.example' });
    expect(proxied.status).toBe(204);
    const otherPort = await post(host.app, '/web/api/login', { email: ADMIN_EMAIL, authKey }, { origin: 'https://nod.example:12027' });
    expect(otherPort.status).toBe(403);

    // A disabled person is as dead here as in the app's routes (SP01 §2). The owner setup created is
    // never disabled (RF-64), so this one is a second person, activated the repo's own way.
    const guest = host.repo.createPerson(
      { id: crypto.randomUUID(), email: 'guest@nod.test', name: 'Guest' },
      new Date().toISOString(),
    );
    const guestSalt = randomSalt();
    const guestKeys = await deriveKeys('guest-password-1', fromBase64url(guestSalt), 600_000);
    host.repo.activatePerson(
      guest.id,
      { salt: guestSalt, authHash: await Bun.password.hash(toBase64url(guestKeys.authKey), { algorithm: 'argon2id' }) },
      new Date().toISOString(),
    );
    host.repo.setDisabled(guest.id, true, new Date().toISOString());
    const guestKey = await derivedKey(host.app, 'guest@nod.test', 'guest-password-1');
    const dead = await post(host.app, '/web/api/login', { email: 'guest@nod.test', authKey: guestKey }, { origin: 'http://nod.test' });
    expect(dead.status).toBe(401);
  });

  test('the web session is a sessions row — listed as web, revoked by the sign-out (RF-74)', async () => {
    const host = await startWebHost();
    const admin = await setupAdmin(host);
    const authKey = await derivedKey(host.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const login = await post(host.app, '/web/api/login', { email: ADMIN_EMAIL, authKey }, { origin: 'http://nod.test' });
    expect(login.status).toBe(204);
    const token = cookieToken(login);

    // The app's own device list carries the web sign-in: same table, same rows, os `web`.
    const sessions = await request(host.app, '/v1/sessions', { headers: { authorization: `Bearer ${admin.token}` } });
    expect(sessions.status).toBe(200);
    const list = (await sessions.json()) as Array<{ device: { os: string; name: string } }>;
    const web = list.find((row) => row.device.os === 'web');
    expect(web?.device.name).toBe('Web portal');

    // The portal's own sign-out revokes that row, and the browser's next request is nobody's.
    const out = await post(host.app, '/web/api/logout', {}, { origin: 'http://nod.test', cookie: `nod_web=${token}` });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await request(host.app, '/web/api/me', { headers: { cookie: `nod_web=${token}` } })).status).toBe(401);
  });

  test('dev serves the portal without the Secure cookie the TLS deployment carries', async () => {
    const dev = await startWebHost({ dev: true });
    await setupAdmin(dev);
    const authKey = await derivedKey(dev.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const login = await post(dev.app, '/web/api/login', { email: ADMIN_EMAIL, authKey }, { origin: 'http://nod.test' });
    expect(login.status).toBe(204);
    expect(login.headers.get('set-cookie')).not.toContain('Secure');
  });
});
