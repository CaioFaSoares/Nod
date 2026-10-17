// RF-58's presence route on the real Elysia app over a temp data dir: who is online, who was seen
// earlier, who never appears (disabled, revoked, clients), and what an answer may carry. The fixture
// goes through the real setup and activation routes; a person is seeded through the repo (0.5.0,
// RF-59: the admin route that created one with an email-bound code is gone), and only the clock of a
// session and a person's `kind` (no route writes them yet — E04) are moved directly in the database.
// Run with `bun test host/presence.test.ts`.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  PRESENCE_WINDOW_MS,
  generateCode,
  normalizeCode,
  type Device,
  type PresenceEntry,
} from '../shared/host-api';
import { createApp } from './app';
import { loadConfig } from './config';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';

const DEVICE: Device = { name: 'nod-presence-test', os: 'macos', appVersion: '0.3.5' };

type TestHost = {
  app: { handle(request: Request): Promise<Response> };
  repo: Repo;
  db: Host['db'];
  cleanup(): void;
};
type SignedIn = { token: string; personId: string };

const hosts: TestHost[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startHost(): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-presence-'));
  dirs.push(dir);
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

function call(host: TestHost, method: string, path: string, body?: unknown, token?: string) {
  return host.app.handle(
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

const randomBytes = (n: number) => toBase64url(crypto.getRandomValues(new Uint8Array(n)));

async function setupAdmin(host: TestHost): Promise<SignedIn> {
  const code = generateCode('setup');
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('the generated code is not Crockford base32');
  host.repo.issueCode(
    { id: crypto.randomUUID(), purpose: 'setup', personId: null, codeHash: await sha256Hex(normalized) },
    new Date().toISOString(),
  );
  const response = await call(host, 'POST', HOST_ROUTES.authSetup, {
    email: 'ada@nod.test',
    name: 'Ada',
    code,
    salt: randomBytes(16),
    authKey: randomBytes(32),
    device: DEVICE,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SignedIn;
}

// 0.5.0, RF-59: the admin route that created a person with an email-bound code is gone — a guild
// invite creates a person now — so the person and the code SP02 §3 would issue are seeded here (the
// way setupAdmin seeds the setup code).
async function addPerson(host: TestHost, email: string, name: string): Promise<SignedIn> {
  const person = host.repo.createPerson({ id: crypto.randomUUID(), email, name, roles: [] }, new Date().toISOString());
  const code = generateCode('access');
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('the generated code is not Crockford base32');
  host.repo.issueCode(
    { id: crypto.randomUUID(), purpose: 'activate', personId: person.id, codeHash: await sha256Hex(normalized) },
    new Date().toISOString(),
  );
  const activated = await call(host, 'POST', HOST_ROUTES.authActivate, {
    email,
    code,
    salt: randomBytes(16),
    authKey: randomBytes(32),
    device: DEVICE,
  });
  expect(activated.status).toBe(200);
  return (await activated.json()) as SignedIn;
}

async function presence(host: TestHost, token: string): Promise<PresenceEntry[]> {
  const response = await call(host, 'GET', HOST_ROUTES.presence, undefined, token);
  expect(response.status).toBe(200);
  return (await response.json()) as PresenceEntry[];
}

/** Moves every session of a person back in time, as if their Nod stopped syncing `ms` ago. */
function lastSeen(host: TestHost, personId: string, msAgo: number): string {
  const at = new Date(Date.now() - msAgo).toISOString();
  host.db.query('UPDATE sessions SET last_seen_at = ? WHERE person_id = ?').run(at, personId);
  return at;
}

test('a fresh session is online, one past the window is listed with its last seen', async () => {
  const host = await startHost();
  const admin = await setupAdmin(host);
  const bob = await addPerson(host, 'bob@nod.test', 'Bob');
  const cara = await addPerson(host, 'cara@nod.test', 'Cara');
  const caraSeen = lastSeen(host, cara.personId, PRESENCE_WINDOW_MS + 60_000);

  const list = await presence(host, bob.token);
  const byId = new Map(list.map((entry) => [entry.personId, entry]));
  expect(byId.get(bob.personId)?.online).toBe(true);
  expect(byId.get(admin.personId)?.online).toBe(true);
  expect(byId.get(cara.personId)).toEqual({ personId: cara.personId, name: 'Cara', lastSeenAt: caraSeen, online: false });
  // Online first: everyone after the first offline entry is offline too.
  const firstOffline = list.findIndex((entry) => !entry.online);
  expect(list.slice(firstOffline).every((entry) => !entry.online)).toBe(true);
});

test('just inside the window is still online', async () => {
  const host = await startHost();
  const admin = await setupAdmin(host);
  const bob = await addPerson(host, 'bob@nod.test', 'Bob');
  lastSeen(host, bob.personId, PRESENCE_WINDOW_MS - 30_000);
  const entry = (await presence(host, admin.token)).find((e) => e.personId === bob.personId);
  expect(entry?.online).toBe(true);
});

test('a disabled person and a revoked session never appear', async () => {
  const host = await startHost();
  const admin = await setupAdmin(host);
  const bob = await addPerson(host, 'bob@nod.test', 'Bob');
  const cara = await addPerson(host, 'cara@nod.test', 'Cara');

  const disabled = await call(
    host,
    'PATCH',
    HOST_ROUTES.adminPerson.replace(':id', bob.personId),
    { disabled: true },
    admin.token,
  );
  expect(disabled.status).toBe(200);
  const logout = await call(host, 'POST', HOST_ROUTES.authLogout, undefined, cara.token);
  expect(logout.status).toBe(204);

  const ids = (await presence(host, admin.token)).map((entry) => entry.personId);
  expect(ids).toEqual([admin.personId]);
});

test('a client is never listed and cannot ask', async () => {
  const host = await startHost();
  const admin = await setupAdmin(host);
  const client = await addPerson(host, 'guest@nod.test', 'Guest');
  host.db.query("UPDATE people SET kind = 'client' WHERE id = ?").run(client.personId);

  const refused = await call(host, 'GET', HOST_ROUTES.presence, undefined, client.token);
  expect(refused.status).toBe(403);
  const ids = (await presence(host, admin.token)).map((entry) => entry.personId);
  expect(ids).not.toContain(client.personId);
});

test('an answer carries a name and an instant, never a device or a session', async () => {
  const host = await startHost();
  const admin = await setupAdmin(host);
  for (const entry of await presence(host, admin.token)) {
    expect(Object.keys(entry).sort()).toEqual(['lastSeenAt', 'name', 'online', 'personId']);
  }
});

test('without a token the route is 401', async () => {
  const host = await startHost();
  const response = await call(host, 'GET', HOST_ROUTES.presence);
  expect(response.status).toBe(401);
});
