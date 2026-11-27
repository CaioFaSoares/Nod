// The gateway module (RF-80) against a fake Caddy admin API on a real unix socket. Run with
// `bun test host/gateway.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import {
  GATEWAY_ERROR_MAX,
  GatewayInputError,
  createGateway,
  gatewayUrl,
  renderCaddyfile,
  validateUpstream,
} from './gateway';

const servers: Array<{ stop: (f?: boolean) => unknown }> = [];
const socks: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const p of socks.splice(0)) if (existsSync(p)) unlinkSync(p);
});

type Seen = { method: string; path: string; type: string | null; body: string };
function fakeCaddy(handler: (req: Request) => Response) {
  const sock = `/tmp/nodgw-${crypto.randomUUID().slice(0, 8)}.sock`;
  socks.push(sock);
  const seen: Seen[] = [];
  const server = Bun.serve({
    unix: sock,
    async fetch(req) {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        type: req.headers.get('content-type'),
        body: await req.text(),
      });
      return handler(req);
    },
  });
  servers.push(server);
  return { sock, seen };
}

const BASE = '{\n\temail a@b.c\n}\n';
const routes = [
  { id: 'zed', upstream: 'http://app:3000' },
  { id: 'alpha', upstream: 'https://10.0.0.5:8443' },
];
const settings = (socket: string) => ({ socket, domain: 'x.duckdns.org', port: 8443, base: BASE });
const mk = (socket: string, fetchImpl?: typeof fetch) =>
  createGateway({ settings: settings(socket), routes: () => routes, now: () => '2026-01-01T00:00:00Z', log: () => {}, fetchImpl });

describe('validateUpstream', () => {
  test.each([
    ['http://app:3000', 'http://app:3000'],
    ['http://my_app-1:8080', 'http://my_app-1:8080'],
    ['http://host.docker.internal:12012', 'http://host.docker.internal:12012'],
    ['https://10.0.0.5:8443', 'https://10.0.0.5:8443'],
    ['http://192.168.1.20:80', 'http://192.168.1.20:80'],
    ['http://172.20.0.3:9000', 'http://172.20.0.3:9000'],
    ['http://100.64.1.2:81', 'http://100.64.1.2:81'],
  ])('accepts %s', (raw, out) => expect(validateUpstream(raw)).toBe(out));

  test.each([
    'http://example.com:80',
    'http://8.8.8.8:80',
    'http://127.0.0.1:80',
    'http://app',
    'http://app:3000/path',
    'http://u:p@app:3000',
    'ftp://app:21',
    'http://app:3000?x=1',
    'http://[::1]:80',
    'http://172.32.0.1:80',
    'http://a.b:80',
    'http://app:3000}',
  ])('refuses %s', (raw) => {
    expect(() => validateUpstream(raw)).toThrow(GatewayInputError);
  });
});

describe('renderCaddyfile', () => {
  test('exact output, sorted by id', () => {
    const expected =
      '{\n\temail a@b.c\n}\n\n' +
      'alpha.x.duckdns.org:8443 {\n\ttls {\n\t\tdns duckdns {$DUCKDNS_TOKEN}\n\t}\n\treverse_proxy https://10.0.0.5:8443 {\n\t\theader_up Host {upstream_hostport}\n\t}\n}\n\n' +
      'zed.x.duckdns.org:8443 {\n\ttls {\n\t\tdns duckdns {$DUCKDNS_TOKEN}\n\t}\n\treverse_proxy http://app:3000 {\n\t\theader_up Host {upstream_hostport}\n\t}\n}\n';
    expect(renderCaddyfile(BASE, routes, 'x.duckdns.org', 8443)).toBe(expected);
  });
  test('rejects a bad id', () => {
    expect(() => renderCaddyfile(BASE, [{ id: 'A b', upstream: 'http://app:1' }], 'd', 1)).toThrow(GatewayInputError);
  });
  test('gatewayUrl', () => expect(gatewayUrl('a', 'd.org', 8443)).toBe('https://a.d.org:8443'));
});

describe('apply', () => {
  test('posts the Caddyfile, then reports a Caddy error', async () => {
    let fail = false;
    const { sock, seen } = fakeCaddy(() =>
      fail ? new Response('{"error":"boom"}', { status: 400 }) : new Response('', { status: 200 }),
    );
    const gw = mk(sock);
    expect(await gw.apply()).toBe(true);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.path).toBe('/load');
    expect(seen[0]!.type).toBe('text/caddyfile');
    expect(seen[0]!.body).toBe(renderCaddyfile(BASE, routes, 'x.duckdns.org', 8443));
    expect(gw.state().lastAppliedAt).toBe('2026-01-01T00:00:00Z');
    fail = true;
    expect(await gw.apply()).toBe(false);
    const err = gw.state().lastError!;
    expect(err).toContain('400');
    expect(err).toContain('boom');
    expect(err.length).toBeLessThanOrEqual(GATEWAY_ERROR_MAX);
  });
});

describe('reconcile', () => {
  test('applies when a hostname is missing', async () => {
    const { sock, seen } = fakeCaddy((req) =>
      new URL(req.url).pathname === '/config/' ? new Response('{"apps":{}}') : new Response(''),
    );
    expect(await mk(sock).reconcile()).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(['/config/', '/load']);
  });
  test('does nothing when every hostname is present', async () => {
    const { sock, seen } = fakeCaddy(() => new Response('"alpha.x.duckdns.org zed.x.duckdns.org"'));
    expect(await mk(sock).reconcile()).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(['/config/']);
  });
  test('unreachable socket does not throw', async () => {
    const gw = mk('/tmp/nodgw-missing.sock');
    expect(await gw.reconcile()).toBe(false);
    expect(gw.state().caddyReachable).toBe(false);
    expect(gw.state().lastError).toBeTruthy();
  });
});
