// The guild icon of SP03 §2 and its digest inside the signed snapshot of SP04 §2, on the real
// surface: the real Elysia app over a temp data dir, every request through `app.handle(new
// Request(...))`, and the signature checked with `crypto.subtle` over the bytes as received.
//
// Nothing is mocked: the database is the booted SQLite file and the repo is the real one. The people,
// the roles and their sessions are seeded through `repo` — the admin routes are H5's and the auth
// routes are H4's — which is the same footing `host/state.test.ts` uses. Run with
// `bun test host/guild-icon.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromBase64url, sha256Hex, toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  PNG_SIGNATURE,
  SNAPSHOT_ETAG_HEADER,
  SNAPSHOT_SIGNATURE_HEADER,
  type Device,
  type GuildIconResponse,
  type Snapshot,
} from '../shared/host-api';
import { MAX_ICON_BODY_BYTES, createApp } from './app';
import { DEFAULT_PORT, type HostConfig } from './config';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';
import { publicKeyOf } from './snapshot';

const DEVICE: Device = { name: 'nod-test', os: 'macos', appVersion: '0.3.0' };
const NOW = new Date().toISOString();

/** A PNG is its signature plus whatever follows it; the host decodes no image (SP03 §2). */
const ICON = Uint8Array.from([...PNG_SIGNATURE, 0x01, 0x02, 0x03, 0x04]);
const OTHER_ICON = Uint8Array.from([...PNG_SIGNATURE, 0x0a, 0x0b, 0x0c]);
const NOT_A_PNG = new TextEncoder().encode('a text file, never an icon');

/** What a test needs from an app: Elysia's answer to one `Request`. */
type HttpApp = { handle(request: Request): Promise<Response> };

type TestHost = {
  config: HostConfig;
  /** What `bootHost` returned: the migrated connection and the signing pair of SP01 §1. */
  booted: Host;
  repo: Repo;
  app: HttpApp;
  cleanup(): void;
};

const hosts: TestHost[] = [];
const dirs: string[] = [];

/** A booted host over a fresh temp data dir — or over `dataDir`, for the restart test. */
async function startHost(dataDir?: string): Promise<TestHost> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'nod-guild-icon-'));
  if (dataDir === undefined) dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  const booted = await bootHost(config);
  const started: TestHost = {
    config,
    booted,
    repo: createRepo(booted.db),
    app: createApp({ config, db: booted.db }),
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

function url(path: string): string {
  return `http://nod.test${path}`;
}

function request(
  host: TestHost,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return host.app.handle(
    new Request(url(path), {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body:
        body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * The JSON body of an answer, in the caller's type: the route under test is the only producer, and
 * every caller here asserts the shape it asked for on the next line (a body that is not JSON throws).
 */
function jsonOf<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

/** The stored icon as the person route answers it: the bytes, the media type and the `ETag`. */
async function iconResponse(host: TestHost, token: string): Promise<{
  response: Response;
  bytes: Uint8Array<ArrayBuffer>;
}> {
  const response = await request(host, 'GET', HOST_ROUTES.guildIcon, undefined, bearer(token));
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** SP04 §2's header, exactly the `kid=<kid>; sig=<base64url>` spelling of `shared/host-api.ts`. */
function parseSignature(header: string | null): { kid: string; sig: string } {
  const match = /^kid=([^;]+); sig=([A-Za-z0-9_-]+)$/.exec(header ?? '');
  if (match === null) throw new Error('the state answer carries no Nod-Signature');
  return { kid: match[1] as string, sig: match[2] as string };
}

/** The snapshot the host signs for that token, parsed from the bytes it returned — and those bytes. */
async function snapshotOf(
  host: TestHost,
  token: string,
): Promise<{
  snapshot: Snapshot;
  bytes: Uint8Array<ArrayBuffer>;
  signature: { kid: string; sig: string };
}> {
  const response = await request(host, 'GET', HOST_ROUTES.state, undefined, bearer(token));
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    snapshot: JSON.parse(new TextDecoder().decode(bytes)) as Snapshot,
    bytes,
    signature: parseSignature(response.headers.get(SNAPSHOT_SIGNATURE_HEADER)),
  };
}

// ---------------------------------------------------------------- fixture

/** One admin role, one member role and one person each — the routes under test are not the admin's. */
function seedGuild(host: TestHost): { admin: string; member: string } {
  const repo = host.repo;
  repo.saveRole({ id: 'admin', name: 'Admin', admin: true });
  repo.saveRole({ id: 'team', name: 'Team', admin: false });
  const admin = repo.createPerson(
    { id: crypto.randomUUID(), email: 'ada@nod.test', name: 'Ada', roles: ['admin'] },
    NOW,
  );
  const member = repo.createPerson(
    { id: crypto.randomUUID(), email: 'bob@nod.test', name: 'Bob', roles: ['team'] },
    NOW,
  );
  return { admin: admin.id, member: member.id };
}

/** A live session of that person, through the repo the auth routes use (H4's surface is theirs). */
async function openSession(host: TestHost, personId: string): Promise<string> {
  const token = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  host.repo.createSession(
    { id: crypto.randomUUID(), personId, tokenHash: await sha256Hex(token), device: DEVICE },
    NOW,
  );
  return token;
}

// ---------------------------------------------------------------- the admin's upload (SP03 §2)

describe('PUT /v1/admin/guild/icon (SP03 §2)', () => {
  test('stores the PNG, answers its hex SHA-256, and the data dir keeps it', async () => {
    const host = await startHost();
    const { admin, member } = seedGuild(host);
    const adminToken = await openSession(host, admin);
    const memberToken = await openSession(host, member);

    const saved = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(adminToken));
    expect(saved.status).toBe(200);
    const digest = await sha256Hex(ICON);
    expect(await jsonOf<GuildIconResponse>(saved)).toEqual({ sha256: digest });

    // The answer is the digest of exactly the bytes `GET /v1/guild/icon` returns (SP03 §2).
    const stored = await iconResponse(host, memberToken);
    expect(stored.response.status).toBe(200);
    expect(Array.from(stored.bytes)).toEqual(Array.from(ICON));
    expect(stored.response.headers.get('content-type')).toBe('image/png');
    expect(stored.response.headers.get(SNAPSHOT_ETAG_HEADER)).toBe(`"${digest}"`);
    expect(await sha256Hex(stored.bytes)).toBe(digest);

    // SP01 §1: the icon is data of the single file, not of the process — a second boot over the
    // same data dir answers the same bytes and the same `ETag`.
    const rebooted = await startHost(host.config.dataDir);
    const again = await iconResponse(rebooted, await openSession(rebooted, member));
    expect(again.response.status).toBe(200);
    expect(again.response.headers.get(SNAPSHOT_ETAG_HEADER)).toBe(`"${digest}"`);
    expect(Array.from(again.bytes)).toEqual(Array.from(ICON));
  });

  test('replaces the icon whole, and the ETag moves with it', async () => {
    const host = await startHost();
    const { admin, member } = seedGuild(host);
    const adminToken = await openSession(host, admin);
    const memberToken = await openSession(host, member);

    await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(adminToken));
    const other = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(OTHER_ICON) }, bearer(adminToken));
    const digest = await sha256Hex(OTHER_ICON);
    expect(await other.json()).toEqual({ sha256: digest });

    const stored = await iconResponse(host, memberToken);
    expect(Array.from(stored.bytes)).toEqual(Array.from(OTHER_ICON));
    expect(stored.response.headers.get('etag')).toBe(`"${digest}"`);
    expect(host.repo.guildIcon()?.sha256).toBe(digest);
  });

  test('accepts an icon over the 256 KB default: this path is in the body-limit exception', async () => {
    const host = await startHost();
    const { admin } = seedGuild(host);
    const adminToken = await openSession(host, admin);

    // 300 KB of PNG: over `MAX_BODY_BYTES`, under the icon exception of `host/app.ts`.
    const big = new Uint8Array(300 * 1024);
    big.set(PNG_SIGNATURE);
    const response = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(big) }, bearer(adminToken));
    expect(response.status).toBe(200);
    expect((await response.json()) as GuildIconResponse).toEqual({ sha256: await sha256Hex(big) });
  });

  test('refuses bytes that are not a PNG with 400, and stores nothing', async () => {
    const host = await startHost();
    const { admin, member } = seedGuild(host);
    const adminToken = await openSession(host, admin);

    const refused = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(NOT_A_PNG) }, bearer(adminToken));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid body: png must be a PNG' });
    // The body is never echoed back (SP03 §1), and nothing landed in the repo.
    expect(host.repo.guildIcon()).toBeNull();
    expect((await iconResponse(host, await openSession(host, member))).response.status).toBe(404);
  });

  test('refuses a body that is not base64url with 400 wanting the field', async () => {
    const host = await startHost();
    const { admin } = seedGuild(host);
    const adminToken = await openSession(host, admin);

    for (const png of ['not base64url!', 'AAAA=', '']) {
      const refused = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png }, bearer(adminToken));
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('png');
    }
    expect(host.repo.guildIcon()).toBeNull();
  });

  test('refuses an icon over 512 KB with 413', async () => {
    const host = await startHost();
    const { admin } = seedGuild(host);
    const adminToken = await openSession(host, admin);

    const huge = new Uint8Array(MAX_ICON_BODY_BYTES + 1);
    huge.set(PNG_SIGNATURE);
    const refused = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(huge) }, bearer(adminToken));
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: 'body too large' });
    expect(host.repo.guildIcon()).toBeNull();
  });

  test('answers 403 to a member and 401 without a token', async () => {
    const host = await startHost();
    const { member } = seedGuild(host);
    const memberToken = await openSession(host, member);

    const memberWrite = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(memberToken));
    expect(memberWrite.status).toBe(403);
    expect(await memberWrite.json()).toEqual({ error: 'admin only' });

    const anonymous = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'invalid credentials' });
    expect(host.repo.guildIcon()).toBeNull();
  });
});

// ---------------------------------------------------------------- the person's download (SP03 §2)

describe('GET /v1/guild/icon (SP03 §2)', () => {
  test('answers the stored bytes with the digest as the ETag', async () => {
    const host = await startHost();
    const { admin, member } = seedGuild(host);
    await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(await openSession(host, admin)));

    const stored = await iconResponse(host, await openSession(host, member));
    expect(stored.response.status).toBe(200);
    expect(stored.response.headers.get('content-type')).toBe('image/png');
    expect(stored.response.headers.get('etag')).toBe(`"${await sha256Hex(ICON)}"`);
    expect(Array.from(stored.bytes)).toEqual(Array.from(ICON));
  });

  test('answers 404 while the guild has none, and 401 without a live session', async () => {
    const host = await startHost();
    const { member } = seedGuild(host);

    const none = await request(host, 'GET', HOST_ROUTES.guildIcon, undefined, bearer(await openSession(host, member)));
    expect(none.status).toBe(404);
    expect(await jsonOf<{ error: string }>(none)).toEqual({ error: 'unknown guild icon' });

    expect((await request(host, 'GET', HOST_ROUTES.guildIcon)).status).toBe(401);
    expect((await request(host, 'GET', HOST_ROUTES.guildIcon, undefined, bearer('not-a-token'))).status).toBe(401);
  });
});

// ---------------------------------------------------------------- the admin's delete (SP03 §2)

describe('DELETE /v1/admin/guild/icon (SP03 §2)', () => {
  test('clears the icon with 204, twice, and the next GET is a 404', async () => {
    const host = await startHost();
    const { admin, member } = seedGuild(host);
    const adminToken = await openSession(host, admin);
    const memberToken = await openSession(host, member);

    await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(adminToken));
    expect((await iconResponse(host, memberToken)).response.status).toBe(200);

    const cleared = await request(host, 'DELETE', HOST_ROUTES.adminGuildIcon, undefined, bearer(adminToken));
    expect(cleared.status).toBe(204);
    expect((await cleared.arrayBuffer()).byteLength).toBe(0);
    expect(host.repo.guildIcon()).toBeNull();
    expect((await iconResponse(host, memberToken)).response.status).toBe(404);

    // A second delete has nothing to remove and answers the same 204.
    expect((await request(host, 'DELETE', HOST_ROUTES.adminGuildIcon, undefined, bearer(adminToken))).status).toBe(204);
    expect((await request(host, 'DELETE', HOST_ROUTES.adminGuildIcon, undefined, bearer(memberToken))).status).toBe(403);
  });
});

// ---------------------------------------------------------------- the signed snapshot (SP04 §2)

describe('the icon inside the signed snapshot (SP04 §2)', () => {
  test('carries the digest of the bytes GET returns, moves the version, and still verifies', async () => {
    const host = await startHost();
    const { admin, member } = seedGuild(host);
    const adminToken = await openSession(host, admin);
    const memberToken = await openSession(host, member);

    const before = await snapshotOf(host, memberToken);
    expect(before.snapshot.guildIcon).toBeNull();

    const first = await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(adminToken));
    const digest = ((await first.json()) as GuildIconResponse).sha256;

    const withIcon = await snapshotOf(host, memberToken);
    // The digest travels; the bytes never do (`personalViews` and company are the only entries).
    expect(withIcon.snapshot.guildIcon).toBe(digest);
    expect(await sha256Hex((await iconResponse(host, memberToken)).bytes)).toBe(
      withIcon.snapshot.guildIcon as string,
    );
    expect(withIcon.snapshot.version).not.toBe(before.snapshot.version);
    expect(withIcon.snapshot.issuedAt >= before.snapshot.issuedAt).toBe(true);

    // SP04 §2: the digest is inside the bytes the signature covers, so the icon is tamper-proof.
    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64url(publicKeyOf(host.booted.signingKey)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    expect(withIcon.signature.kid).toBe(host.booted.signingKey.kid);
    const signatureBytes = fromBase64url(withIcon.signature.sig);
    expect(await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, withIcon.bytes)).toBe(true);
    const tampered = Uint8Array.from(withIcon.bytes);
    tampered[tampered.length - 4] ^= 0x01;
    expect(await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, tampered)).toBe(false);

    // Swapping the icon moves the version again: the snapshot is how a Nod learns the icon changed.
    await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(OTHER_ICON) }, bearer(adminToken));
    const swapped = await snapshotOf(host, memberToken);
    expect(swapped.snapshot.guildIcon).toBe(await sha256Hex(OTHER_ICON));
    expect(swapped.snapshot.version).not.toBe(withIcon.snapshot.version);

    // Removing it leaves `null`, which is what makes a Nod drop its cached file (SP04 §2).
    await request(host, 'DELETE', HOST_ROUTES.adminGuildIcon, undefined, bearer(adminToken));
    const cleared = await snapshotOf(host, memberToken);
    expect(cleared.snapshot.guildIcon).toBeNull();
    expect(cleared.snapshot.version).not.toBe(swapped.snapshot.version);
    expect(await crypto.subtle.verify('Ed25519', publicKey, fromBase64url(cleared.signature.sig), cleared.bytes)).toBe(true);
  });

  test('holds the version while the icon holds', async () => {
    const host = await startHost();
    const { admin, member } = seedGuild(host);
    const adminToken = await openSession(host, admin);
    const memberToken = await openSession(host, member);

    await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(adminToken));
    const first = await snapshotOf(host, memberToken);
    // Writing the identical bytes is a new row with the same digest, so the state itself did not move.
    await request(host, 'PUT', HOST_ROUTES.adminGuildIcon, { png: toBase64url(ICON) }, bearer(adminToken));
    const second = await snapshotOf(host, memberToken);
    expect(second.snapshot.version).toBe(first.snapshot.version);
    expect(second.snapshot.issuedAt).toBe(first.snapshot.issuedAt);
  });
});
