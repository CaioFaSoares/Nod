// Host client (`backend/host-client.ts`) against a real HTTP server on loopback that signs its
// snapshots with a generated Ed25519 key: the acceptance of story B1 — the signature is checked
// over the bytes as received, a changed key is the exact error of SP04 §1, the bearer comes from
// the keychain and reaches no row of SQLite, and plain http to a real host never leaves the
// machine. The runtime is the real one (`fetch`, `crypto.subtle`); only the keychain is in memory.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  HOST_KEY_CHANGED,
  HOST_KEY_MISMATCH,
  createHostClient,
  fingerprintOf,
  hostTokenKey,
  type HostClient,
  type HostFailure,
  type PinnedHost,
} from '../backend/host-client';
import { createRepo } from '../backend/repo';
import { toBase64url } from '../shared/encoding';
import { HOST_ROUTES } from '../shared/host-api';
import { generateEd25519KeyPair, sign } from '../shared/seal';
import { memorySqlite } from './helpers/sqlite-bun';
import type { SecretStore, SqlDb } from '../shared/types';

const ISSUED = '2026-10-16T10:00:00.000Z';
const PERSON = 'uuid-person-1';

/** The body of SP04 §2, small but complete: the client reads `api`, `version` and `issuedAt`. */
function snapshotBody(version: string, issuedAt = ISSUED): string {
  return JSON.stringify({
    api: 1,
    version,
    issuedAt,
    me: { id: PERSON, email: 'ana@example.test', name: 'Ana', roles: [], admin: true, kind: 'member' },
    roles: [],
    orgTools: [],
    personalTools: [],
    personalViews: [],
    favorites: [],
  });
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

interface TestCall {
  method: string;
  path: string;
  authorization: string | null;
  ifNoneMatch: string | null;
}

/** What `/v1/state` answers next: the bytes served, the bytes signed and who signs them. */
interface Answer {
  body: string;
  signed: string;
  kid: string;
  privateKey: Uint8Array<ArrayBuffer>;
  status: number;
  etag: string;
  notModified: boolean;
}

interface TestHost {
  origin: string;
  kid: string;
  /** base64url raw public key: what the Bond pins. */
  publicKey: string;
  rawPublicKey: Uint8Array<ArrayBuffer>;
  fingerprint: string;
  calls: TestCall[];
  /** What `/v1/state` answers from now on. */
  answer(patch: Partial<Answer>): void;
  /** What `/.well-known/bond` advertises from now on. */
  discovery(patch: { kid?: string; rawPublicKey?: Uint8Array<ArrayBuffer> }): void;
  /** Where `/v1/redirect` sends the caller, or `null` for a `404` (F9). */
  redirect(url: string | null): void;
  /** Back to the key it started with and a fresh `v1` body. */
  reset(): void;
  /** Closes the loopback server. */
  stop(): void;
  /** A second pair, for the cases where the host presents another key (SP04 §1). */
  other: {
    kid: string;
    publicKey: string;
    rawPublicKey: Uint8Array<ArrayBuffer>;
    privateKey: Uint8Array<ArrayBuffer>;
  };
}

async function startHost(): Promise<TestHost> {
  const pair = await generateEd25519KeyPair();
  const other = await generateEd25519KeyPair();
  const kid = 'kid-a';
  const calls: TestCall[] = [];

  let advertises = { kid, rawPublicKey: pair.publicKey };
  let redirectsTo: string | null = null;
  const fresh = (): Answer => ({
    body: snapshotBody('v1'),
    signed: snapshotBody('v1'),
    kid,
    privateKey: pair.privateKey,
    status: 200,
    etag: 'v1',
    notModified: false,
  });
  let answer = fresh();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        ifNoneMatch: request.headers.get('if-none-match'),
      });

      if (url.pathname === HOST_ROUTES.discovery) {
        return Response.json({
          api: 1,
          guild: 'Example Guild',
          key: { kid: advertises.kid, ed25519Public: toBase64url(advertises.rawPublicKey) },
          fingerprint: await fingerprintOf(advertises.rawPublicKey),
          minAppVersion: '0.1.0',
          signIn: ['access-code'],
        });
      }

      if (url.pathname === HOST_ROUTES.state) {
        if (answer.notModified || request.headers.get('if-none-match') === `"${answer.etag}"`) {
          return new Response(null, { status: 304 });
        }
        if (answer.status !== 200) {
          return new Response(JSON.stringify({ error: 'internal: leaked value' }), { status: answer.status });
        }
        const signature = toBase64url(await sign(new TextEncoder().encode(answer.signed), answer.privateKey));
        return new Response(answer.body, {
          status: 200,
          headers: {
            ETag: `"${answer.etag}"`,
            'Bond-Signature': `kid=${answer.kid}; sig=${signature}`,
          },
        });
      }

      if (url.pathname === '/v1/redirect') {
        if (redirectsTo === null) return new Response('not found', { status: 404 });
        return new Response(null, { status: 302, headers: { location: redirectsTo } });
      }

      if (url.pathname === '/v1/ping') {
        if (request.headers.get('authorization') === null) return new Response('{}', { status: 401 });
        return Response.json({ ok: true });
      }

      if (url.pathname.startsWith('/v1/status/')) {
        const status = Number(url.pathname.slice('/v1/status/'.length));
        if (Number.isFinite(status)) {
          return new Response(JSON.stringify({ error: 'internal: leaked value' }), { status });
        }
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    kid,
    publicKey: toBase64url(pair.publicKey),
    rawPublicKey: pair.publicKey,
    fingerprint: await fingerprintOf(pair.publicKey),
    calls,
    answer: (patch) => {
      answer = { ...answer, ...patch };
    },
    discovery: (patch) => {
      advertises = { ...advertises, ...patch };
    },
    redirect: (url) => {
      redirectsTo = url;
    },
    reset: () => {
      advertises = { kid, rawPublicKey: pair.publicKey };
      answer = fresh();
    },
    stop: () => {
      server.stop(true);
    },
    other: {
      kid: 'kid-b',
      publicKey: toBase64url(other.publicKey),
      rawPublicKey: other.publicKey,
      privateKey: other.privateKey,
    },
  };
}

/** The failure of a rejected call, or a thrown expectation when it resolved. */
async function failureOfCall(work: Promise<unknown>): Promise<{ failure: HostFailure; message: string }> {
  try {
    await work;
  } catch (error) {
    const host = error as { failure?: HostFailure; message?: string };
    if (host.failure === undefined) throw error;
    return { failure: host.failure, message: host.message ?? '' };
  }
  throw new Error('expected the call to be refused');
}

/** Every row of every table, as text: what a token would have to appear in to be stored. */
function allRowsText(db: SqlDb): string {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => row.name);
  return tables.map((table) => JSON.stringify(db.all(`SELECT * FROM ${table}`))).join('\n');
}

let host: TestHost;
let client: HostClient;
let keychain: SecretStore;
let pinned: PinnedHost;

beforeAll(async () => {
  host = await startHost();
  keychain = memoryKeychain();
  client = createHostClient({ fetch, keychain });
  pinned = { address: host.origin, kid: host.kid, publicKey: host.publicKey, personId: PERSON };
});

afterAll(() => {
  host.stop();
});

describe('RF-30 — no host call without a host', () => {
  test('building a client and connecting to a pinned host reaches no network', () => {
    let reached = 0;
    const counted = createHostClient({
      fetch: async () => {
        reached += 1;
        return new Response('{}', { status: 200 });
      },
      keychain: memoryKeychain(),
    });
    const connection = counted.connect(pinned);
    // The bearer would be read from the keychain, which is empty: no header, and still no call.
    expect(connection.tokenKey()).toBe(hostTokenKey(host.kid, PERSON));
    expect(reached).toBe(0);
  });

  test('the pin names the keychain item of SP02 §5', () => {
    expect(hostTokenKey(host.kid, PERSON)).toBe(`bond.host.${host.kid}.${PERSON}`);
    expect(client.connect(pinned).tokenKey()).toBe(`bond.host.${host.kid}.${PERSON}`);
  });
});

describe('discovery (SP04 §1)', () => {
  test('the fingerprint is 10 digest bytes in Crockford base32, grouped in fours', async () => {
    // SP04 §1.1, pinned against a computation made outside this repository (executed 2026-10-16):
    //   head -c 32 /dev/zero | shasum -a 256 | cut -c1-20 | xxd -r -p | base32 \
    //     | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    // → CSM7NBFRCAYQEV4F; the same over 32 bytes of 0xff → NYB16XGFE9HNZFDM. `shasum` gives the
    // digest, `base32` the 5-bit groups, and `tr` re-labels them with the Crockford alphabet, so
    // the three parts of the formula are pinned by hand rather than by this same function.
    expect(await fingerprintOf(new Uint8Array(32))).toBe('CSM7-NBFR-CAYQ-EV4F');
    expect(await fingerprintOf(new Uint8Array(32).fill(255))).toBe('NYB1-6XGF-E9HN-ZFDM');
    // 80 bits are exactly 16 characters: the length is the 10-byte slice of SP04 §1.1.
    expect(host.fingerprint).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  test('answers the canonical address, the fingerprint and what step 5 pins', async () => {
    const found = await client.discover(`${host.origin}/a/path?q=1`);
    expect(found.address).toBe(host.origin); // SP04 §1.1: origin only, no path and no query
    expect(found.fingerprint).toBe(host.fingerprint);
    expect(found.pin).toEqual({ kid: host.kid, ed25519Public: host.publicKey });
    expect(found.document.guild).toBe('Example Guild');
    expect(found.document.signIn).toEqual(['access-code']);
  });

  test("a fingerprint that is not the invite's aborts with one error and stores nothing", async () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    const empty = memoryKeychain();
    const fresh = createHostClient({ fetch, keychain: empty });
    const before = host.calls.length;

    const refused = await failureOfCall(fresh.discover(host.origin, { fingerprint: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }));

    expect(refused.failure).toBe('key-mismatch');
    expect(refused.message).toBe(HOST_KEY_MISMATCH);
    expect(host.calls.length).toBe(before + 1); // one request, the discovery itself
    expect(repo.hostRecord()).toBeNull();
    expect(await empty.get(hostTokenKey(host.kid, PERSON))).toBeNull();
  });

  test('the invite fingerprint is compared across case and grouping', async () => {
    const typed = host.fingerprint.toLowerCase().replaceAll('-', '');
    const found = await client.discover(host.origin, { fingerprint: typed });
    expect(found.fingerprint).toBe(host.fingerprint);
  });

  test('an added host answering another key is the changed-key error', async () => {
    // The key the Bond pinned is the one the host still presents: accepted.
    const same = await client.discover(host.origin, {
      pinned: { kid: host.kid, ed25519Public: host.publicKey },
    });
    expect(same.pin.kid).toBe(host.kid);

    // The host now answers with another key: refused, whole, with the exact message of SP04 §1.
    host.discovery({ kid: host.other.kid, rawPublicKey: host.other.rawPublicKey });
    const refused = await failureOfCall(
      client.discover(host.origin, { pinned: { kid: host.kid, ed25519Public: host.publicKey } }),
    );
    expect(refused.failure).toBe('key-changed');
    expect(refused.message).toBe(HOST_KEY_CHANGED);
    host.reset();
  });

  test('plain http to a real host is refused before a byte leaves the machine', async () => {
    const before = host.calls.length;
    await expect(client.discover('http://bond.example.test')).rejects.toThrow('address must be https');
    expect(host.calls.length).toBe(before);
  });

  test('connecting to a pinned address that is real http is refused the same way', () => {
    expect(() =>
      client.connect({
        address: 'http://bond.example.test',
        kid: host.kid,
        publicKey: host.publicKey,
        personId: PERSON,
      }),
    ).toThrow('address must be https');
  });
});

describe('signed snapshot (SP04 §2)', () => {
  test('a snapshot the pinned key signed is verified and handed back verbatim', async () => {
    const result = await client.connect(pinned).snapshot();
    if (result.notModified) throw new Error('expected a body');
    expect(result.raw).toBe(snapshotBody('v1'));
    expect(result.snapshot.version).toBe('v1');
    expect(result.snapshot.issuedAt).toBe(ISSUED);
    expect(result.snapshot.me.id).toBe(PERSON);
  });

  test('one byte changed after signing fails and hands back nothing', async () => {
    const signed = snapshotBody('v2');
    host.answer({ body: signed.replace('Ana', 'Anb'), signed });
    const refused = await failureOfCall(client.connect(pinned).snapshot());
    expect(refused.failure).toBe('signature');
    host.reset();
  });

  test('a snapshot signed by another key is refused with the exact changed-key error', async () => {
    const body = snapshotBody('v3');
    host.answer({ body, signed: body, kid: host.other.kid, privateKey: host.other.privateKey });
    const refused = await failureOfCall(client.connect(pinned).snapshot());
    expect(refused.failure).toBe('key-changed');
    expect(refused.message).toBe(HOST_KEY_CHANGED);
    host.reset();
  });

  test('the same kid signing with another key is refused as a signature, not accepted as one', async () => {
    const stranger = await generateEd25519KeyPair();
    const body = snapshotBody('v4');
    host.answer({ body, signed: body, kid: host.kid, privateKey: stranger.privateKey });
    const refused = await failureOfCall(client.connect(pinned).snapshot());
    expect(refused.failure).toBe('signature');
    host.reset();
  });

  test('the bytes are verified before they are parsed', async () => {
    // Correctly signed, but not JSON at all: the signature passes and the parse is what refuses it.
    host.answer({ body: 'not json', signed: 'not json' });
    expect((await failureOfCall(client.connect(pinned).snapshot())).failure).toBe('invalid');

    // Valid JSON of another API version, correctly signed: the shape check refuses it.
    host.answer({ body: '{"api":2,"version":"v9","issuedAt":"2026-10-16T10:00:00.000Z"}', signed: '{"api":2,"version":"v9","issuedAt":"2026-10-16T10:00:00.000Z"}' });
    expect((await failureOfCall(client.connect(pinned).snapshot())).failure).toBe('invalid');

    // Valid JSON the pinned key did not sign: refused as a signature, never read as a snapshot.
    host.answer({ body: snapshotBody('v9'), signed: snapshotBody('v1') });
    expect((await failureOfCall(client.connect(pinned).snapshot())).failure).toBe('signature');
    host.reset();
  });

  test('the last accepted version asks for the 304 of SP04 §2', async () => {
    const result = await client.connect(pinned).snapshot({ version: 'v1' });
    expect(result.notModified).toBe(true);
    expect(host.calls.at(-1)?.ifNoneMatch).toBe('"v1"');
  });

  test('a snapshot older than the last accepted one is refused, an equal one is not', async () => {
    const refused = await failureOfCall(
      client.connect(pinned).snapshot({ notOlderThan: '2026-10-16T11:00:00.000Z' }),
    );
    expect(refused.failure).toBe('stale');
    const same = await client.connect(pinned).snapshot({ notOlderThan: ISSUED });
    expect(same.notModified).toBe(false);
  });

  test('an unsigned body is refused whatever its shape', async () => {
    const unsigned = new Response(snapshotBody('v5'), { status: 200 });
    const bare = createHostClient({
      fetch: async () => unsigned,
      keychain,
    });
    const refused = await failureOfCall(bare.connect(pinned).snapshot());
    expect(refused.failure).toBe('signature');
  });
});

describe('the bearer (SP02 §5)', () => {
  const TOKEN = 'token-that-must-not-reach-sqlite';

  test('it is read from the keychain and nothing stores it in SQLite', async () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    const store = memoryKeychain();
    const connection = createHostClient({ fetch, keychain: store }).connect(pinned);

    await connection.saveToken(TOKEN);
    expect(await store.get(hostTokenKey(host.kid, PERSON))).toBe(TOKEN);

    // A host row and a pending write, the two places a token could leak into (SP05 §2).
    repo.saveHost({
      address: host.origin,
      guild: 'Example Guild',
      kid: host.kid,
      publicKey: host.publicKey,
      personId: PERSON,
      salt: 'c2FsdA',
      addedAt: ISSUED,
    });
    repo.enqueueOutbox({
      method: 'PUT',
      path: '/v1/personal/tools/p-abc',
      body: '{"title":"Mine"}',
      createdAt: ISSUED,
    });

    const answer = await connection.request<{ ok: boolean }>('GET', '/v1/ping');
    expect(answer.ok).toBe(true);
    expect(host.calls.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);

    expect(allRowsText(db)).not.toContain(TOKEN);
    expect(allRowsText(db)).not.toContain('Bearer');

    // Sign-out forgets it: the keychain item goes, and the next call carries no header.
    await connection.forgetToken();
    expect(await store.get(hostTokenKey(host.kid, PERSON))).toBeNull();
    const refused = await failureOfCall(connection.request('GET', '/v1/ping'));
    expect(refused.failure).toBe('signed-out');
  });

  test('a keychain that refuses the token is its own failure, with the token stored nowhere', async () => {
    const refusing: SecretStore = {
      get: async () => null,
      set: async () => false,
      delete: async () => false,
    };
    const refused = await failureOfCall(
      createHostClient({ fetch, keychain: refusing }).connect(pinned).saveToken(TOKEN),
    );
    expect(refused.failure).toBe('keychain');
    expect(refused.message).not.toContain(TOKEN);
  });
});

describe('failures of the host (SP03 §1, SP04 §3)', () => {
  test('401 is signed out and the host body is not echoed', async () => {
    const refused = await failureOfCall(client.connect(pinned).request('GET', '/v1/status/401'));
    expect(refused.failure).toBe('signed-out');
    expect(refused.message).toBe('signed out');
    expect(refused.message).not.toContain('leaked');
  });

  test('429, 403 and 500 keep their own names and still echo nothing', async () => {
    const connection = client.connect(pinned);
    const limited = await failureOfCall(connection.request('GET', '/v1/status/429'));
    expect(limited.failure).toBe('rate-limited');
    const refused = await failureOfCall(connection.request('GET', '/v1/status/403'));
    expect(refused.failure).toBe('refused');
    const failed = await failureOfCall(connection.request('GET', '/v1/status/500'));
    expect(failed.failure).toBe('server');
    for (const each of [limited, refused, failed]) expect(each.message).not.toContain('leaked');
  });

  test('a fetch that rejects is offline, in the words of SP04 §3', async () => {
    const offline = createHostClient({
      fetch: async () => {
        throw new Error('ENOTFOUND');
      },
      keychain,
    });
    const refused = await failureOfCall(offline.connect(pinned).snapshot());
    expect(refused.failure).toBe('offline');
    expect(refused.message).toBe('could not reach the host');
  });

  test('a fetch that never answers runs into the deadline and is offline too', async () => {
    const stalled = createHostClient({
      fetch: () => new Promise<Response>(() => undefined),
      keychain,
      timeoutMs: 5,
    });
    const refused = await failureOfCall(stalled.connect(pinned).snapshot());
    expect(refused.failure).toBe('offline');
  });
});

describe('a redirect is refused, not followed (F9)', () => {
  test('the bearer never reaches the origin the host points at', async () => {
    // The origin a followed redirect would hand the bearer to (`docs/tinyjs.md` §6: the backend's
    // fetch has no CORS limit in the way, so nothing but this refuses the hop).
    const seen: (string | null)[] = [];
    const elsewhere = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        seen.push(request.headers.get('authorization'));
        return Response.json({ ok: true });
      },
    });
    try {
      const store = memoryKeychain();
      const connection = createHostClient({ fetch, keychain: store }).connect(pinned);
      await connection.saveToken('a-bearer-of-this-test');
      host.redirect(`http://127.0.0.1:${elsewhere.port}${HOST_ROUTES.state}`);

      const refused = await failureOfCall(connection.request('GET', '/v1/redirect'));

      // A host that answers a redirect is a host that did not answer, in the words of SP04 §3.
      expect(refused.failure).toBe('offline');
      expect(refused.message).toBe('could not reach the host');
      expect(seen).toEqual([]);
    } finally {
      host.redirect(null);
      elsewhere.stop(true);
    }
  });
});

describe('the client writes no row', () => {
  test('a request answers the host body and leaves every table as it was', async () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    repo.saveEntry({
      id: 'ping',
      title: 'Ping',
      url: 'https://ping.example.test',
      icon: null,
      order: 1,
      roles: [],
      views: [],
      auth: null,
      active: true,
    });
    const before = allRowsText(db);

    const store = memoryKeychain();
    const connection = createHostClient({ fetch, keychain: store }).connect(pinned);
    await connection.saveToken('a-token-of-this-test');
    const answer = await connection.request<{ ok: boolean }>('GET', '/v1/ping');
    expect(answer).toEqual({ ok: true });
    expect(allRowsText(db)).toBe(before);
  });
});
