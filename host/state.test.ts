// The two documents of SP04 §1–§2 on the real surface: the real Elysia app over a temp data dir and
// the real key files `bootHost` writes (`app.handle`), the signature checked with `crypto.subtle`
// over the bytes as received, and one snapshot taken end to end through `backend/host-client.ts`
// against a real `Bun.serve` — which is what proves the two sides agree byte for byte.
//
// Nothing is mocked: the database is the booted SQLite file, the repo is the real one, and people,
// roles and grants are seeded through `repo` because the admin routes are H5's. Run with
// `bun test host/state.test.ts`.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostClient, fingerprintOf as bondFingerprintOf } from '../backend/host-client';
import { fromBase64url, sha256Hex, toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  SNAPSHOT_ETAG_HEADER,
  SNAPSHOT_SIGNATURE_HEADER,
  type Device,
  type Discovery,
  type Snapshot,
} from '../shared/host-api';
import type { SecretStore } from '../shared/types';
import { createApp } from './app';
import { DEFAULT_PORT, type HostConfig } from './config';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';
import {
  DEFAULT_MIN_APP_VERSION,
  GUILD_NAME_ENV,
  MIN_APP_VERSION_ENV,
  stateRoutes,
} from './routes/state';
import { fingerprintOf, publicKeyOf, serializeSnapshot, snapshotVersion } from './snapshot';

/** SP07 §2's deployment value the discovery reads; any guild name would do. */
const GUILD = 'Testguild';
const MIN_APP_VERSION = '0.4.0';
const DEVICE: Device = { name: 'bond-test', os: 'macos', appVersion: MIN_APP_VERSION };
const NOW = new Date().toISOString();

/** SP03 §2's personal tool id: the Bond generates them, and the repo stores what it is given. */
const BOB_TOOL = 'p-bobnotes01';
const CARA_TOOL = 'p-caranotes01';

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

async function startHost(): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'bond-state-'));
  dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://bond.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  const booted = await bootHost(config);
  const app = createApp({ config, db: booted.db });
  // `host/app.ts` mounts this group (H5); until that line lands the test app mounts it itself. The
  // check keeps it to one mount either way: an app that already serves the route would register the
  // same two routes twice.
  const started: TestHost = {
    config,
    booted,
    repo: createRepo(booted.db),
    app: app.routes.some((route) => route.path === HOST_ROUTES.state) ? app : app.use(stateRoutes),
    cleanup: () => booted.close(),
  };
  hosts.push(started);
  return started;
}

const savedEnv: Record<string, string | undefined> = {
  [GUILD_NAME_ENV]: process.env[GUILD_NAME_ENV],
  [MIN_APP_VERSION_ENV]: process.env[MIN_APP_VERSION_ENV],
};

beforeAll(() => {
  process.env[GUILD_NAME_ENV] = GUILD;
  delete process.env[MIN_APP_VERSION_ENV];
});

afterAll(() => {
  for (const name of [GUILD_NAME_ENV, MIN_APP_VERSION_ENV]) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- requests

function url(path: string): string {
  return `http://bond.test${path}`;
}

async function get(
  host: TestHost,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await host.app.handle(new Request(url(path), { headers }));
}

async function discovery(host: TestHost): Promise<Discovery> {
  const response = await get(host, HOST_ROUTES.discovery);
  expect(response.status).toBe(200);
  return (await response.json()) as Discovery;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function stateResponse(
  host: TestHost,
  token: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await get(host, HOST_ROUTES.state, { ...bearer(token), ...headers });
}

/** The snapshot the host signs for that token, parsed from the bytes it returned. */
async function stateSnapshot(host: TestHost, token: string): Promise<Snapshot> {
  const response = await stateResponse(host, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Snapshot;
}

/** SP04 §2's header, exactly as `backend/host-client.ts` reads it. */
function parseSignature(header: string | null): { kid: string; sig: string } {
  const match = /^kid=([^;]+); sig=([A-Za-z0-9_-]+)$/.exec(header ?? '');
  if (match === null) throw new Error('the state answer carries no Bond-Signature');
  return { kid: match[1] as string, sig: match[2] as string };
}

// ---------------------------------------------------------------- fixture (the admin routes are H5's)

/** Roles, two org tools and three people, seeded through the real repo. */
function seedGuild(host: TestHost) {
  const repo = host.repo;
  repo.saveRole({ id: 'admin', name: 'Admin', admin: true });
  repo.saveRole({ id: 'team', name: 'Team', admin: false });
  repo.saveRole({ id: 'other', name: 'Other', admin: false });

  repo.saveOrgTool(
    {
      id: 'jitsi',
      title: 'Jitsi',
      url: 'https://jitsi.example',
      icon: null,
      order: 1,
      auth: null,
      active: true,
      roles: ['team'],
      views: [
        { id: 'view-jitsi-room', label: 'Room', url: 'https://jitsi.example/room', mode: 'window' },
      ],
    },
    NOW,
  );
  repo.saveOrgTool(
    {
      id: 'figma',
      title: 'Figma',
      url: 'https://figma.example',
      icon: null,
      order: 2,
      auth: { noFill: true },
      active: true,
      roles: ['other'],
      views: [],
    },
    NOW,
  );

  return {
    ada: repo.createPerson(
      { id: crypto.randomUUID(), email: 'ada@bond.test', name: 'Ada', roles: ['admin'] },
      NOW,
    ),
    bob: repo.createPerson(
      { id: crypto.randomUUID(), email: 'bob@bond.test', name: 'Bob', roles: ['team'] },
      NOW,
    ),
    cara: repo.createPerson(
      { id: crypto.randomUUID(), email: 'cara@bond.test', name: 'Cara', roles: ['other'] },
      NOW,
    ),
  };
}

/**
 * One person's own data: a personal tool, a personal view and one favorite. `visible` is an entry that
 * person can see (SP01 §2: a personal view and a favorite only hang on an entry its owner sees).
 */
function seedPersonal(
  host: TestHost,
  personId: string,
  toolId: string,
  viewId: string,
  visible: string,
): void {
  const repo = host.repo;
  repo.savePersonalTool(
    personId,
    {
      id: toolId,
      title: 'Notes',
      url: 'https://notes.example',
      icon: null,
      order: 1,
      auth: null,
      active: true,
    },
    NOW,
  );
  repo.savePersonalView(
    personId,
    {
      id: viewId,
      entryId: visible,
      label: 'Room notes',
      url: 'https://notes.example/room',
      mode: 'navigate',
    },
    NOW,
  );
  repo.replaceFavorites(personId, [visible], NOW);
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

/** `app.secrets` in memory: the same surface, no keychain of the machine. */
function memoryKeychain(): SecretStore {
  const items = new Map<string, string>();
  return {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      items.set(key, value);
      return true;
    },
    delete: async (key) => items.delete(key),
  };
}

const toolIds = (snapshot: Snapshot): string[] => snapshot.orgTools.map((entry) => entry.id);

// ---------------------------------------------------------------- discovery (SP04 §1)

describe('GET /.well-known/bond (SP04 §1)', () => {
  test('answers the guild, the pinned key, the fingerprint and the minimum app version', async () => {
    const host = await startHost();
    process.env[MIN_APP_VERSION_ENV] = MIN_APP_VERSION;
    try {
      const document = await discovery(host);
      expect(document.api).toBe(1);
      expect(document.guild).toBe(GUILD);
      expect(document.minAppVersion).toBe(MIN_APP_VERSION);
      expect(document.signIn).toEqual(['access-code']);
      expect(document.key.kid).toBe(host.booted.signingKey.kid);
      expect(document.key.ed25519Public).toBe(publicKeyOf(host.booted.signingKey));
      expect(document.fingerprint).toBe(
        await fingerprintOf(fromBase64url(document.key.ed25519Public)),
      );
    } finally {
      delete process.env[MIN_APP_VERSION_ENV];
    }
  });

  test('the fingerprint is the Bond’s own fingerprintOf for the same key', async () => {
    const host = await startHost();
    const document = await discovery(host);
    const raw = fromBase64url(document.key.ed25519Public);
    // SP04 §1.1's shape: 16 Crockford characters in four groups (`U`, `I`, `L` and `O` are not in it).
    expect(document.fingerprint).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    // The host's copy and `backend/host-client.ts`'s must answer one string for one key.
    expect(await fingerprintOf(raw)).toBe(await bondFingerprintOf(raw));
    expect(document.fingerprint).toBe(await bondFingerprintOf(raw));
  });

  test('applies the SP07 §2 default when the deployment sets no minimum version', async () => {
    const host = await startHost();
    const document = await discovery(host);
    expect(document.minAppVersion).toBe(DEFAULT_MIN_APP_VERSION);
  });
});

// ---------------------------------------------------------------- signed state (SP04 §2)

describe('GET /v1/state (SP04 §2)', () => {
  test('signs the exact bytes it returns and answers the version as the ETag', async () => {
    const host = await startHost();
    const { bob } = seedGuild(host);
    seedPersonal(host, bob.id, BOB_TOOL, 'view-bob-room', 'jitsi');
    const token = await openSession(host, bob.id);

    const response = await stateResponse(host, token);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const bytes = new Uint8Array(await response.arrayBuffer());
    const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Snapshot;
    const signature = parseSignature(response.headers.get(SNAPSHOT_SIGNATURE_HEADER));
    expect(signature.kid).toBe(host.booted.signingKey.kid);
    expect(response.headers.get(SNAPSHOT_ETAG_HEADER)).toBe(`"${snapshot.version}"`);

    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64url(publicKeyOf(host.booted.signingKey)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const signatureBytes = fromBase64url(signature.sig);
    expect(await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, bytes)).toBe(true);
    // SP04 §2: over the bytes as received — one changed byte is not the body that was signed.
    const tampered = Uint8Array.from(bytes);
    tampered[Math.floor(bytes.length / 2)] ^= 0x20;
    expect(await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, tampered)).toBe(false);

    // SP04 §2: the version is the digest of the body with its own `version` empty.
    expect(await snapshotVersion(serializeSnapshot({ ...snapshot, version: '' }))).toBe(
      snapshot.version,
    );

    // The host's private columns of a person row never travel in `me` (SP02 §2), nor does their name
    // appear anywhere in the body.
    expect(Object.keys(snapshot.me).sort()).toEqual([
      'admin',
      'email',
      'id',
      'kind',
      'name',
      'roles',
    ]);
    expect(new TextDecoder().decode(bytes)).not.toMatch(/salt|auth_hash|token_hash|password/);
  });

  test('answers 304 on If-None-Match, 200 for another version, and holds the version while the state holds', async () => {
    const host = await startHost();
    const { bob } = seedGuild(host);
    const token = await openSession(host, bob.id);

    const first = await stateSnapshot(host, token);
    // The same state answers the same version and the same instant: `issuedAt` is part of the body.
    const second = await stateSnapshot(host, token);
    expect(second.version).toBe(first.version);
    expect(second.issuedAt).toBe(first.issuedAt);

    const hit = await stateResponse(host, token, { 'if-none-match': `"${first.version}"` });
    expect(hit.status).toBe(304);
    expect(hit.headers.get(SNAPSHOT_ETAG_HEADER)).toBe(`"${first.version}"`);
    expect((await hit.arrayBuffer()).byteLength).toBe(0);

    const miss = await stateResponse(host, token, { 'if-none-match': '"another-version"' });
    expect(miss.status).toBe(200);

    // The bare version another client may send, and `*`, which means "any state" (RFC 9110 §13.1.2).
    expect((await stateResponse(host, token, { 'if-none-match': first.version })).status).toBe(304);
    expect((await stateResponse(host, token, { 'if-none-match': '*' })).status).toBe(304);
    expect((await stateResponse(host, token, { 'if-none-match': '"v1", "v2"' })).status).toBe(200);

    // A write moves the state, so it moves the version — and the old ETag is a miss again.
    host.repo.savePersonalTool(
      bob.id,
      {
        id: 'p-bobnotes02',
        title: 'Notes 2',
        url: 'https://notes.example/two',
        icon: null,
        order: 2,
        auth: null,
        active: true,
      },
      new Date().toISOString(),
    );
    const afterWrite = await stateSnapshot(host, token);
    expect(afterWrite.version).not.toBe(first.version);
    expect(afterWrite.issuedAt >= first.issuedAt).toBe(true);
    const stale = await stateResponse(host, token, { 'if-none-match': `"${first.version}"` });
    expect(stale.status).toBe(200);
  });

  test('a person sees only the org tools granted to their roles; an admin sees all of them', async () => {
    const host = await startHost();
    const { ada, bob, cara } = seedGuild(host);

    const bobSnapshot = await stateSnapshot(host, await openSession(host, bob.id));
    expect(toolIds(bobSnapshot)).toEqual(['jitsi']);
    expect(bobSnapshot.me).toEqual({
      id: bob.id,
      email: 'bob@bond.test',
      name: 'Bob',
      roles: ['team'],
      admin: false,
      kind: 'member',
    });
    // SP04 §2: every role of the guild travels — names are not secret inside it.
    expect(bobSnapshot.roles.map((role) => role.id).sort()).toEqual(['admin', 'other', 'team']);
    // The granted tool carries its org views, in order, with `roles` filled.
    expect(bobSnapshot.orgTools[0]?.views).toEqual([
      {
        id: 'view-jitsi-room',
        label: 'Room',
        url: 'https://jitsi.example/room',
        mode: 'window',
        scope: 'org',
        ownerId: null,
      },
    ]);
    expect(bobSnapshot.orgTools[0]?.roles).toEqual(['team']);

    const caraSnapshot = await stateSnapshot(host, await openSession(host, cara.id));
    expect(toolIds(caraSnapshot)).toEqual(['figma']);

    const adaSnapshot = await stateSnapshot(host, await openSession(host, ada.id));
    expect(toolIds(adaSnapshot)).toEqual(['jitsi', 'figma']);
    expect(adaSnapshot.me.admin).toBe(true);
  });

  test('a person sees their own personal data only, admin included', async () => {
    const host = await startHost();
    const { ada, bob, cara } = seedGuild(host);
    seedPersonal(host, bob.id, BOB_TOOL, 'view-bob-room', 'jitsi');
    seedPersonal(host, cara.id, CARA_TOOL, 'view-cara-room', CARA_TOOL);

    const bobSnapshot = await stateSnapshot(host, await openSession(host, bob.id));
    expect(bobSnapshot.personalTools.map((entry) => entry.id)).toEqual([BOB_TOOL]);
    expect(bobSnapshot.personalTools[0]?.scope).toBe('personal');
    expect(bobSnapshot.personalTools[0]?.ownerId).toBe(bob.id);
    expect(bobSnapshot.personalViews).toEqual([
      {
        id: 'view-bob-room',
        entryId: 'jitsi',
        label: 'Room notes',
        url: 'https://notes.example/room',
        mode: 'navigate',
        scope: 'personal',
        ownerId: bob.id,
        updatedAt: NOW,
      },
    ]);
    expect(bobSnapshot.favorites).toEqual(['jitsi']);

    // Another person's snapshot carries their own data and none of Bob's; the admin sees neither.
    const caraSnapshot = await stateSnapshot(host, await openSession(host, cara.id));
    expect(caraSnapshot.personalTools.map((entry) => entry.id)).toEqual([CARA_TOOL]);
    expect(caraSnapshot.personalViews.map((view) => view.id)).toEqual(['view-cara-room']);
    expect(caraSnapshot.favorites).toEqual([CARA_TOOL]);

    const adaSnapshot = await stateSnapshot(host, await openSession(host, ada.id));
    expect(adaSnapshot.personalTools).toEqual([]);
    expect(adaSnapshot.personalViews).toEqual([]);
    expect(adaSnapshot.favorites).toEqual([]);
  });

  test('a disabled person answers 401, and so does an unknown token', async () => {
    const host = await startHost();
    const { bob } = seedGuild(host);
    const token = await openSession(host, bob.id);
    expect((await stateResponse(host, token)).status).toBe(200);

    // SP01 §2: disabling revokes the sessions, so the guard refuses the token that worked.
    host.repo.setDisabled(bob.id, true, new Date().toISOString());
    const disabled = await stateResponse(host, token);
    expect(disabled.status).toBe(401);
    expect(await disabled.json()).toEqual({ error: 'invalid credentials' });

    expect((await stateResponse(host, 'not-a-token-that-exists')).status).toBe(401);
    expect((await get(host, HOST_ROUTES.state)).status).toBe(401);
  });
});

// ---------------------------------------------------------------- the two sides together (SP04 §1–§2)

describe('the Bond side against the real app (SP04 §1–§2)', () => {
  test('discovers, pins, verifies the signature and 304s on the version it accepted', async () => {
    const host = await startHost();
    const { bob } = seedGuild(host);
    seedPersonal(host, bob.id, BOB_TOOL, 'view-bob-room', 'jitsi');
    const token = await openSession(host, bob.id);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => host.app.handle(request),
    });
    try {
      const client = createHostClient({ fetch, keychain: memoryKeychain() });
      // SP04 §1: the Bond recomputes the fingerprint and refuses a document that disagrees with it.
      const found = await client.discover(`http://127.0.0.1:${server.port}`);
      expect(found.document.guild).toBe(GUILD);
      expect(found.fingerprint).toBe(found.document.fingerprint);
      expect(found.pin.ed25519Public).toBe(publicKeyOf(host.booted.signingKey));

      const connection = client.connect({
        address: found.address,
        kid: found.pin.kid,
        publicKey: found.pin.ed25519Public,
        personId: bob.id,
      });
      await connection.saveToken(token);

      // SP04 §2: the client verifies the signature over the bytes as received, then parses them.
      const first = await connection.snapshot();
      if (first.notModified) throw new Error('the Bond had never seen this state');
      expect(first.snapshot.me.email).toBe('bob@bond.test');
      expect(first.snapshot.favorites).toEqual(['jitsi']);
      expect(first.snapshot.personalTools.map((entry) => entry.id)).toEqual([BOB_TOOL]);

      // The version the Bond accepted is the one the host answers `304` for.
      expect(await connection.snapshot({ version: first.snapshot.version })).toEqual({
        notModified: true,
      });
    } finally {
      server.stop(true);
    }
  });
});
