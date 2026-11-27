// The gateway admin routes (RF-80) on the real app over a temp data dir, with a fake Caddy admin API
// on a real unix socket: the host's table, the guild tool a route creates, the `/load` it sends, the
// 404 of a deployment without the gateway and the 403 of a member. Run with
// `bun test host/gateway-routes.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, toBase64url } from '../shared/encoding';
import { HOST_ROUTES, generateCode, normalizeCode, type Device, type GatewayStatus } from '../shared/host-api';
import { createApp } from './app';
import { DEFAULT_PORT, type HostConfig } from './config';
import { createGateway } from './gateway';
import { bootHost } from './main';
import { createRepo, type Repo } from './repo';

const DEVICE: Device = { name: 'nod-gateway-test', os: 'macos', appVersion: '1.0.0' };
const DOMAIN = 'guild.duckdns.example';
const PORT = 12027;
const BASE = '{\n\tadmin unix//run/caddy/admin.sock|0666\n}\n';

type HttpApp = { handle(request: Request): Promise<Response> };
type Seen = { method: string; path: string; body: string };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A fake Caddy admin API: `/config/` answers what was last loaded, `/load` records the body. */
function fakeCaddy() {
  const sock = `/tmp/nodgw-${crypto.randomUUID().slice(0, 8)}.sock`;
  const seen: Seen[] = [];
  let loaded = '{}';
  const server = Bun.serve({
    unix: sock,
    async fetch(req) {
      const body = await req.text();
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, body });
      if (path === '/load') loaded = JSON.stringify({ caddyfile: body });
      return new Response(path === '/config/' ? loaded : '', { status: 200 });
    },
  });
  cleanups.push(() => {
    server.stop(true);
    if (existsSync(sock)) unlinkSync(sock);
  });
  return { sock, seen };
}

async function startHost(withGateway: boolean): Promise<{ app: HttpApp; repo: Repo; seen: Seen[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-gateway-'));
  const caddy = fakeCaddy();
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: `https://${DOMAIN}:${PORT}`,
    port: DEFAULT_PORT,
    dev: false,
    gateway: withGateway ? { socket: caddy.sock, domain: DOMAIN, port: PORT, basePath: '/unused' } : null,
  };
  const host = await bootHost(config);
  const repo = createRepo(host.db);
  const gateway = withGateway
    ? createGateway({
        settings: { socket: caddy.sock, domain: DOMAIN, port: PORT, base: BASE },
        routes: () => repo.listGatewayRoutes(),
        now: () => new Date().toISOString(),
        log: () => undefined,
      })
    : null;
  cleanups.push(() => {
    host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app: createApp({ config, db: host.db, gateway }), repo, seen: caddy.seen };
}

function call(app: HttpApp, method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  return app.handle(
    new Request(`http://nod.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const randomKey = (bytes: number): string => toBase64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function codeHash(code: string): Promise<string> {
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('the generated code is not Crockford base32');
  return await sha256Hex(normalized);
}

/** The first admin, through the real setup route. */
async function setupAdmin(app: HttpApp, repo: Repo): Promise<string> {
  const code = generateCode('setup');
  repo.issueCode({ id: crypto.randomUUID(), purpose: 'setup', personId: null, codeHash: await codeHash(code) }, new Date().toISOString());
  const response = await call(app, 'POST', HOST_ROUTES.authSetup, {
    email: 'ada@nod.test',
    name: 'Ada',
    code,
    salt: randomKey(16),
    authKey: randomKey(32),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

/** A member without an admin role, activated through the real route. */
async function member(app: HttpApp, repo: Repo): Promise<string> {
  const person = repo.createPerson({ id: crypto.randomUUID(), email: 'bob@nod.test', name: 'Bob', roles: [] }, new Date().toISOString());
  const code = generateCode('access');
  repo.issueCode({ id: crypto.randomUUID(), purpose: 'activate', personId: person.id, codeHash: await codeHash(code) }, new Date().toISOString());
  const response = await call(app, 'POST', HOST_ROUTES.authActivate, {
    email: 'bob@nod.test',
    code,
    salt: randomKey(16),
    authKey: randomKey(32),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

const routePath = (id: string): string => HOST_ROUTES.adminGatewayRoute.replace(':id', id);

describe('gateway routes (RF-80)', () => {
  test('a route is stored, loaded into Caddy, creates its guild tool and is removed', async () => {
    const host = await startHost(true);
    const token = await setupAdmin(host.app, host.repo);
    await call(host.app, 'PUT', HOST_ROUTES.adminRole.replace(':id', 'team'), { name: 'Team', admin: false }, token);

    const saved = await call(
      host.app,
      'PUT',
      routePath('board'),
      { upstream: 'http://host.docker.internal:12012', tool: { title: 'Board', roles: ['team'] } },
      token,
    );
    expect(saved.status).toBe(200);
    const status = (await saved.json()) as GatewayStatus;
    if (!status.enabled) throw new Error('the gateway answered off');
    expect(status.lastError).toBeNull();
    expect(status.caddyReachable).toBe(true);
    expect(status.routes).toEqual([
      expect.objectContaining({
        id: 'board',
        upstream: 'http://host.docker.internal:12012',
        url: `https://board.${DOMAIN}:${PORT}`,
        entryId: 'board',
      }),
    ]);

    // Caddy received the base plus one block for the route, with the token left as its placeholder.
    const load = host.seen.filter((seen) => seen.method === 'POST' && seen.path === '/load').at(-1);
    expect(load?.body.startsWith(BASE.trimEnd())).toBe(true);
    expect(load?.body).toContain(`board.${DOMAIN}:${PORT} {`);
    expect(load?.body).toContain('reverse_proxy http://host.docker.internal:12012');
    expect(load?.body).toContain('{$DUCKDNS_TOKEN}');

    // The guild tool of the same id carries the HTTPS name and the roles.
    const tool = host.repo.listOrgTools().find((row) => row.id === 'board');
    expect(tool?.url).toBe(`https://board.${DOMAIN}:${PORT}`);
    expect(tool?.title).toBe('Board');
    expect(tool?.roles).toEqual(['team']);

    // The write is in the guild's log, without the file the host sent.
    const events = host.repo.listEvents({});
    expect(events.map((event) => event.kind)).toContain('gateway_applied');

    const removed = await call(host.app, 'DELETE', routePath('board'), undefined, token);
    expect(removed.status).toBe(204);
    expect(host.repo.listGatewayRoutes()).toEqual([]);
    // The tool stays: the admin removes it in Tools if they want.
    expect(host.repo.listOrgTools().some((row) => row.id === 'board')).toBe(true);
    const last = host.seen.filter((seen) => seen.path === '/load').at(-1);
    expect(last?.body).not.toContain(`board.${DOMAIN}`);
  });

  test('a public or malformed upstream is refused and nothing is stored', async () => {
    const host = await startHost(true);
    const token = await setupAdmin(host.app, host.repo);
    for (const upstream of ['http://example.com:80', 'http://8.8.8.8:80', 'http://app:3000/path', 'http://u:p@app:3000']) {
      const response = await call(host.app, 'PUT', routePath('board'), { upstream }, token);
      expect([upstream, response.status]).toEqual([upstream, 400]);
    }
    expect(host.repo.listGatewayRoutes()).toEqual([]);
  });

  test('the read reconciles: a Caddy without the route gets it loaded again', async () => {
    const host = await startHost(true);
    const token = await setupAdmin(host.app, host.repo);
    host.repo.saveGatewayRoute({ id: 'board', upstream: 'http://app:3000', entryId: null }, new Date().toISOString());
    const response = await call(host.app, 'GET', HOST_ROUTES.adminGateway, undefined, token);
    expect(response.status).toBe(200);
    expect(host.seen.some((seen) => seen.path === '/load' && seen.body.includes(`board.${DOMAIN}`))).toBe(true);
  });

  test('without GATEWAY the read says off and every write is 404', async () => {
    const host = await startHost(false);
    const token = await setupAdmin(host.app, host.repo);
    const read = await call(host.app, 'GET', HOST_ROUTES.adminGateway, undefined, token);
    expect(await read.json()).toEqual({ enabled: false });
    expect((await call(host.app, 'PUT', routePath('board'), { upstream: 'http://app:3000' }, token)).status).toBe(404);
    expect((await call(host.app, 'DELETE', routePath('board'), undefined, token)).status).toBe(404);
  });

  test('a member is refused every gateway route', async () => {
    const host = await startHost(true);
    await setupAdmin(host.app, host.repo);
    const token = await member(host.app, host.repo);
    expect((await call(host.app, 'GET', HOST_ROUTES.adminGateway, undefined, token)).status).toBe(403);
    expect((await call(host.app, 'PUT', routePath('board'), { upstream: 'http://app:3000' }, token)).status).toBe(403);
    expect((await call(host.app, 'DELETE', routePath('board'), undefined, token)).status).toBe(403);
  });
});
