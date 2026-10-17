// `backend/keys.ts` — K1 and K2 of `docs/specs/SP06-credential-sharing.md` §2 — against a real
// in-memory SQLite and an in-memory keychain: the person fingerprint, the pin decision as a pure
// function, the key pairs of an activation (sealed private halves, published public ones, the
// regeneration a reset forces) and the pin table (first sight pins, a different pair marks the peer
// changed until it is confirmed).
import { describe, expect, test } from 'bun:test';

import { createKeys, keysKey, privateKeysAad, pinAction } from '../backend/keys';
import type { Keys, KeysDeps, PublicPair } from '../backend/keys';
import { createRepo } from '../backend/repo';
import type { Repo } from '../backend/repo';
import { fromBase64url, toBase64url } from '../shared/encoding';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  importEd25519PrivateKey,
  importX25519PrivateKey,
  personFingerprint,
} from '../shared/seal';
import { VAULT_VALUE_PREFIX, decryptVaultBytes, encryptVaultBytes } from '../shared/vault-crypto';
import { memorySqlite } from './helpers/sqlite-bun';
import type { HostConnection } from '../backend/host-client';
import type { OwnKeys, PublicKeys } from '../shared/host-api';
import type { Id, PasswordHash, Person, SecretStore } from '../shared/types';

/** SP06 §2 pinned vectors: `x` is the bytes 0…31, `ed` the bytes 32…63. */
const VECTOR_X = new Uint8Array(32).map((_, index) => index);
const VECTOR_ED = new Uint8Array(32).map((_, index) => 32 + index);
const VECTOR_FINGERPRINT = 'ZQNB-KB7K-E41P-5F96';
const VECTOR_ZERO_FINGERPRINT = 'YPJZ-TGPH-D8G3-09WR';

/** The `vaultKey` of the unlocked session these tests drive (SP02 §8). */
const VAULT_KEY = new Uint8Array(32).fill(7);
/** The `vaultKey` of an account that was activated again elsewhere (SP02 §7). */
const RESET_VAULT_KEY = new Uint8Array(32).fill(9);
const NOW = new Date('2026-10-17T12:00:00.000Z');
/** The one shape every fingerprint of these tests has (`XXXX-XXXX-XXXX-XXXX`, SP06 §2). */
const FINGERPRINT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

const PASSWORD: PasswordHash = {
  algorithm: 'PBKDF2-SHA256',
  hash: 'aGFzaC1ub3QtdXNlZA==',
  salt: 'c2FsdC1ub3QtdXNlZA==',
  iterations: 1000,
};

describe('person fingerprint (SP06 §2)', () => {
  test('is the first 10 digest bytes of x || ed in Crockford base32, grouped in fours', async () => {
    expect(await personFingerprint(VECTOR_X, VECTOR_ED)).toBe(VECTOR_FINGERPRINT);
    expect(await personFingerprint(new Uint8Array(32), new Uint8Array(32))).toBe(
      VECTOR_ZERO_FINGERPRINT,
    );
    expect(await personFingerprint(VECTOR_X, VECTOR_ED)).toMatch(FINGERPRINT);
  });

  test('reads the two keys in the order it was given them', async () => {
    // The same 64 bytes, the other half first: another pair, so another string.
    expect(await personFingerprint(VECTOR_ED, VECTOR_X)).toBe('GKJB-TV52-NYB4-2BYW');
  });

  test('is the same string for the same pair, call after call', async () => {
    const pair = await keyPairOf();
    const x = fromBase64url(pair.x25519);
    const ed = fromBase64url(pair.ed25519);
    expect(await personFingerprint(x, ed)).toBe(await personFingerprint(x, ed));
  });
});

describe('pin decision (SP06 §2)', () => {
  const pinned: PublicPair = { x25519: 'x1', ed25519: 'e1' };
  const other: PublicPair = { x25519: 'x2', ed25519: 'e2' };

  test('pins what it sees for the first time', () => {
    expect(pinAction(null, pinned)).toBe('pin');
  });

  test('does nothing while the snapshot shows the pinned pair', () => {
    expect(pinAction({ ...pinned, pending: null }, pinned)).toBe('none');
  });

  test('calls a different pair a change, and keeps it as the pending one', () => {
    expect(pinAction({ ...pinned, pending: null }, other)).toBe('changed');
    expect(pinAction({ ...pinned, pending: other }, other)).toBe('none');
    // A third pair is another change, and it replaces the pending one.
    expect(pinAction({ ...pinned, pending: other }, { x25519: 'x3', ed25519: 'e3' })).toBe('changed');
  });

  test('drops a pending change the host no longer publishes', () => {
    expect(pinAction({ ...pinned, pending: other }, pinned)).toBe('clear');
  });
});

// ---------------------------------------------------------------- harness

/** An in-memory keychain: `app.secrets` at runtime, a map in the tests. */
function memoryKeychain() {
  const items = new Map<string, string>();
  let refused = false;
  const keychain: SecretStore = {
    async get(key) {
      return items.get(key) ?? null;
    },
    async set(key, value) {
      if (refused) return false;
      items.set(key, value);
      return true;
    },
    async delete(key) {
      return items.delete(key);
    },
  };
  return {
    keychain,
    items,
    refuse: (): void => {
      refused = true;
    },
  };
}

/** A fresh pair of raw public keys, base64url, as the snapshot and the pin table carry them. */
async function keyPairOf(): Promise<PublicPair> {
  const x25519 = await generateX25519KeyPair();
  const ed25519 = await generateEd25519KeyPair();
  return { x25519: toBase64url(x25519.publicKey), ed25519: toBase64url(ed25519.publicKey) };
}

/** One person of `Snapshot.people` (SP04 §2); without keys, one who has not activated. */
function rosterPerson(id: Id, name: string, keys?: PublicPair): Record<string, unknown> {
  return {
    id,
    name,
    roles: ['team'],
    kind: 'member',
    ...(keys === undefined ? {} : { x25519Public: keys.x25519, ed25519Public: keys.ed25519 }),
  };
}

/** The `{ x25519, ed25519 }` of a JSON value this module wrote, for the assertions on it. */
function pairOf(value: unknown): PublicPair | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('x25519' in value) || !('ed25519' in value)) return null;
  const { x25519, ed25519 } = value;
  if (typeof x25519 !== 'string' || typeof ed25519 !== 'string') return null;
  return { x25519, ed25519 };
}

/** One pair of bytes, both halves, as the blob of `docs/canonico.md` §22 carries them. */
interface FullPair {
  x25519Public: Uint8Array<ArrayBuffer>;
  ed25519Public: Uint8Array<ArrayBuffer>;
  x25519Private: Uint8Array<ArrayBuffer>;
  ed25519Private: Uint8Array<ArrayBuffer>;
}

async function fullKeyPair(): Promise<FullPair> {
  const x25519 = await generateX25519KeyPair();
  const ed25519 = await generateEd25519KeyPair();
  return {
    x25519Public: x25519.publicKey,
    ed25519Public: ed25519.publicKey,
    x25519Private: x25519.privateKey,
    ed25519Private: ed25519.privateKey,
  };
}

function publicsOf(pair: FullPair): PublicPair {
  return { x25519: toBase64url(pair.x25519Public), ed25519: toBase64url(pair.ed25519Public) };
}

/** The two PKCS#8 halves as the keychain value carries them — what `privateKeys` reads back. */
function privatesOf(pair: FullPair): PublicPair {
  return { x25519: toBase64url(pair.x25519Private), ed25519: toBase64url(pair.ed25519Private) };
}

/** The host's own row for a pair, as `PUT /v1/keys` + `GET /v1/keys/private` leave it. */
async function hostRowFor(
  personId: Id,
  vaultKey: Uint8Array<ArrayBuffer>,
  pair: FullPair,
): Promise<OwnKeys> {
  return {
    x25519Public: toBase64url(pair.x25519Public),
    ed25519Public: toBase64url(pair.ed25519Public),
    privateSealed: await hostBlob(personId, vaultKey, pair),
  };
}

/**
 * The `bv1.` blob over a pair, written exactly as `docs/canonico.md` §22 documents it — the field
 * names and the AAD `nod.keys.private/v1|<person>`. The test pins the format here instead of asking
 * `backend/keys.ts` to produce it, so a drift between the two shows up as a failure.
 */
async function hostBlob(
  personId: Id,
  vaultKey: Uint8Array<ArrayBuffer>,
  pair: FullPair,
): Promise<string> {
  return await encryptVaultBytes(
    vaultKey,
    privateKeysAad(personId),
    new TextEncoder().encode(
      JSON.stringify({
        x25519Pkcs8: toBase64url(pair.x25519Private),
        ed25519Pkcs8: toBase64url(pair.ed25519Private),
        x25519Public: toBase64url(pair.x25519Public),
        ed25519Public: toBase64url(pair.ed25519Public),
      }),
    ),
  );
}

/** The public halves inside a host blob; `null` when this key, person or format does not open it. */
async function openBlobFields(
  vaultKey: Uint8Array<ArrayBuffer>,
  personId: Id,
  blob: string,
): Promise<PublicPair | null> {
  const bytes = await decryptVaultBytes(vaultKey, privateKeysAad(personId), blob);
  if (bytes === null) return null;
  try {
    const fields = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const { x25519Public, ed25519Public } = fields;
    if (typeof x25519Public !== 'string' || typeof ed25519Public !== 'string') return null;
    return { x25519: x25519Public, ed25519: ed25519Public };
  } catch {
    return null;
  }
}

interface Harness {
  repo: Repo;
  keys: Keys;
  person: Person;
  keychain: Map<string, string>;
  /** Every `PUT /v1/keys` the fake host took, in order. */
  sent: PublicKeys[];
  connection: HostConnection;
  /** The keys of the last request, or a failure when the host took none. */
  published: () => PublicKeys;
  /** The `bv1.` value the keychain holds for this person, or `null`. */
  storedKeys: () => string | null;
  /**
   * What `session.changePassword`'s own batch does (SP02 §7/M1): the keychain value moves to
   * `vaultKey`, and nothing else — the host's blob is left for `reSeal`/`ensure`.
   */
  resealLocal: (vaultKey: Uint8Array<ArrayBuffer>) => Promise<void>;
  /** The private halves inside a stored value, read the way the opener reads them. */
  privateKeys: (vaultKey: Uint8Array<ArrayBuffer>) => Promise<PublicPair | null>;
  mine: () => PublicPair | null;
  /** The host's own row, as `GET /v1/keys/private` answers it: `null` is the host's 404. */
  hostKeys: () => OwnKeys | null;
  setHostKeys: (keys: OwnKeys | null) => void;
  /** The pair inside the last published blob, read the way a second machine reads it. */
  openPublishedBlob: (vaultKey: Uint8Array<ArrayBuffer>) => Promise<PublicPair | null>;
  /** SP02 §6: the session locked again — no `vaultKey` in memory. */
  lock: () => void;
  /** SP02 §7: the account was activated again, so its `vaultKey` moved. */
  setVaultKey: (key: Uint8Array<ArrayBuffer>) => void;
  refuseKeychain: () => void;
  refuseHost: () => void;
  /**
   * The host answers `GET /v1/keys/private` and refuses every write — the case M1 is about: the
   * password moved, the local re-seal worked and `PUT /v1/keys` did not land.
   */
  refusePut: () => void;
  /** The host answers again: the next `ensure`/`reSeal` can publish. */
  acceptHost: () => void;
  /** Forgets the keychain item and the `meta` row: the state of a machine that never had the pair. */
  forgetLocal: () => void;
  /** Stores one verified snapshot body, as `backend/sync.ts` does (SP04 §2). */
  setRoster: (people: unknown[]) => void;
}

function harness(): Harness {
  const sqlite = memorySqlite();
  const repo = createRepo(sqlite);
  repo.migrate();
  const person = repo.createPerson({
    email: 'ana@example.test',
    name: 'Ana',
    password: PASSWORD,
    roles: [],
  });
  repo.saveHost({
    address: 'https://guild.example.test',
    guild: 'Guild',
    kid: 'kid-1',
    publicKey: 'A'.repeat(43),
    personId: person.id,
    salt: 'c2FsdA',
    addedAt: '2026-10-01T00:00:00.000Z',
  });

  const memory = memoryKeychain();
  const sent: PublicKeys[] = [];
  let hostRefused = false;
  let putRefused = false;
  let hostRow: OwnKeys | null = null;
  let vaultKey: Uint8Array<ArrayBuffer> | null = VAULT_KEY;
  const connection: HostConnection = {
    host: {
      address: 'https://guild.example.test',
      kid: 'kid-1',
      publicKey: 'A'.repeat(43),
      personId: person.id,
    },
    tokenKey: () => `nod.host.kid-1.${person.id}`,
    saveToken: async () => undefined,
    forgetToken: async () => undefined,
    request: async () => undefined,
    getBytes: async () => new Uint8Array(),
    snapshot: async () => ({ notModified: true }),
    sessions: async () => [],
    revokeSession: async () => true,
    putKeys: async (publicKeys) => {
      if (hostRefused || putRefused) throw new Error('could not reach the host');
      sent.push(publicKeys);
      // The host's own upsert, in the same two rules `host/repo.ts` applies: the same public keys
      // move the blob alone (a `null` blob keeps the stored one), new public keys replace the row.
      const same =
        hostRow !== null &&
        hostRow.x25519Public === publicKeys.x25519Public &&
        hostRow.ed25519Public === publicKeys.ed25519Public;
      hostRow = {
        x25519Public: publicKeys.x25519Public,
        ed25519Public: publicKeys.ed25519Public,
        privateSealed:
          publicKeys.privateSealed ?? (same && hostRow !== null ? hostRow.privateSealed : null),
      };
    },
    // `docs/canonico.md` §22: the person's own row. `null` is the host's 404 — nothing published.
    getOwnKeys: async () => {
      if (hostRefused) throw new Error('could not reach the host');
      return hostRow;
    },
    // K4: `backend/shares.ts` owns the share flows; this stub only ever publishes keys.
    sendShares: async () => ({ ids: [] }),
    acceptShare: async () => true,
    declineShare: async () => true,
    removeHolder: async () => true,
    markRotated: async () => true,
    setCredentialScope: async () => true,
    // K2's own flows reach the host through `backend/shares.ts` too; nothing here asks for these.
    presence: async () => [],
    putAssignment: async () => true,
    missingCopies: async () => [],
    appMeta: async () => ({ minAppVersion: '0.0.0', update: null }),
  };

  const aad = keysKey(person.id);
  const deps: KeysDeps = {
    repo,
    keychain: memory.keychain,
    session: {
      current: () => repo.personById(person.id),
      vaultKey: () => vaultKey,
    },
    now: () => NOW,
  };

  return {
    repo,
    person,
    keys: createKeys(deps),
    sent,
    connection,
    keychain: memory.items,
    refuseKeychain: memory.refuse,
    refuseHost: (): void => {
      hostRefused = true;
    },
    refusePut: (): void => {
      putRefused = true;
    },
    acceptHost: (): void => {
      hostRefused = false;
      putRefused = false;
    },
    lock: (): void => {
      vaultKey = null;
    },
    setVaultKey: (key: Uint8Array<ArrayBuffer>): void => {
      vaultKey = key;
    },
    published: (): PublicKeys => {
      const last = sent[sent.length - 1];
      if (last === undefined) throw new Error('the host took no keys');
      return last;
    },
    storedKeys: () => memory.items.get(aad) ?? null,
    resealLocal: async (key: Uint8Array<ArrayBuffer>): Promise<void> => {
      const stored = memory.items.get(aad);
      if (stored === undefined) throw new Error('no keychain value to re-seal');
      const bytes = await decryptVaultBytes(VAULT_KEY, aad, stored);
      if (bytes === null) throw new Error('the stored value does not open with the old key');
      memory.items.set(aad, await encryptVaultBytes(key, aad, bytes));
    },
    mine: (): PublicPair | null => pairOf(JSON.parse(repo.meta(`keys.public.${person.id}`) ?? 'null') as unknown),
    hostKeys: () => hostRow,
    setHostKeys: (keys: OwnKeys | null): void => {
      hostRow = keys;
    },
    openPublishedBlob: async (key: Uint8Array<ArrayBuffer>): Promise<PublicPair | null> => {
      const last = sent[sent.length - 1];
      if (last?.privateSealed === undefined) return null;
      return await openBlobFields(key, person.id, last.privateSealed);
    },
    forgetLocal: (): void => {
      memory.items.delete(aad);
      sqlite.run('DELETE FROM meta WHERE key = ?', [`keys.public.${person.id}`]);
    },
    privateKeys: async (key: Uint8Array<ArrayBuffer>): Promise<PublicPair | null> => {
      const stored = memory.items.get(aad);
      if (stored === undefined) return null;
      const bytes = await decryptVaultBytes(key, aad, stored);
      if (bytes === null) return null;
      try {
        return pairOf(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      } catch {
        return null;
      }
    },
    setRoster: (people: unknown[]): void => {
      repo.saveHostSnapshot({
        snapshot: JSON.stringify({ api: 1, people }),
        version: 'v1',
        issuedAt: '2026-10-17T10:00:00.000Z',
        syncedAt: '2026-10-17T10:00:01.000Z',
      });
    },
  };
}

describe('the pair of this machine (K1)', () => {
  test('an activation generates both pairs, seals the private halves and publishes the public ones', async () => {
    const h = harness();
    const status = await h.keys.ensure(h.connection);

    expect(status.created).toBe(true);
    expect(status.published).toBe(true);
    expect(status.error).toBeNull();
    expect(status.fingerprint).toMatch(FINGERPRINT);

    // SP06 §2: the private halves are a `bv1.` value under `nod.keys.<person>`, whose AAD is the
    // keychain key itself (SP02 §8).
    const stored = h.storedKeys();
    expect(stored?.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
    expect(h.keychain.has(keysKey(h.person.id))).toBe(true);
    const privates = await h.privateKeys(VAULT_KEY);
    expect(privates).not.toBeNull();
    // Not one byte of a private key is in clear in what the keychain holds…
    expect(stored).not.toContain(privates?.x25519 ?? '?');
    expect(stored).not.toContain(privates?.ed25519 ?? '?');
    // …and what came out are two PKCS#8 keys this runtime accepts.
    await importX25519PrivateKey(fromBase64url(privates?.x25519 ?? ''));
    await importEd25519PrivateKey(fromBase64url(privates?.ed25519 ?? ''));

    // The public halves are what went to `PUT /v1/keys` and what `meta` holds for the opener.
    const mine = h.mine();
    expect(mine).toEqual({
      x25519: h.published().x25519Public,
      ed25519: h.published().ed25519Public,
    });
    expect(fromBase64url(mine?.x25519 ?? '').length).toBe(32);
    expect(fromBase64url(mine?.ed25519 ?? '').length).toBe(32);

    // The fingerprint of the pair this machine holds is the one the screen shows, with the pair in
    // place and published.
    expect(await h.keys.mine()).toEqual({
      fingerprint: status.fingerprint,
      status: 'ok',
      message: null,
    });
    expect((await h.keys.mine()).fingerprint).toBe(
      await personFingerprint(fromBase64url(mine?.x25519 ?? ''), fromBase64url(mine?.ed25519 ?? '')),
    );
  });

  test('a second ensure writes nothing and publishes nothing while the host has the pair', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    expect(first.created).toBe(true);
    // SP04 §2: the host that took the pair publishes it back in the next snapshot's roster.
    h.setRoster([
      {
        id: h.person.id,
        name: 'Ana',
        roles: ['team'],
        kind: 'member',
        x25519Public: h.published().x25519Public,
        ed25519Public: h.published().ed25519Public,
      },
    ]);
    h.sent.length = 0;

    const second = await h.keys.ensure(h.connection);
    expect(second.created).toBe(false);
    expect(second.published).toBe(false);
    expect(second.error).toBeNull();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(h.sent).toEqual([]);
  });

  test('a snapshot that does not carry this person yet is published to', async () => {
    const h = harness();
    h.setRoster([rosterPerson('p-bea', 'Bea', await keyPairOf())]);
    const status = await h.keys.ensure(h.connection);
    expect(status.published).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  test('a value the current vaultKey cannot open writes nothing and asks for a sign-in', async () => {
    const h = harness();
    await h.keys.ensure(h.connection);
    // SP02 §7: the account was activated again elsewhere, so the salt — and the `vaultKey` — moved.
    h.setVaultKey(RESET_VAULT_KEY);

    // `docs/canonico.md` §22: neither this machine's value nor the host's blob opens with the new
    // key, so nothing is written. Generating here would publish a competing pair; the sign-in that
    // follows is what tells the session this was a reset.
    const second = await h.keys.ensure(h.connection);
    expect(second.error).toBe('keys unavailable — sign in again');
    expect(second.created).toBe(false);
    expect(second.published).toBe(false);
    expect(h.sent).toHaveLength(1);
    // The `meta` row still names the old pair, but its keychain value does not open with the moved
    // `vaultKey`: the card must say the keys are unavailable, never show a fingerprint nothing can
    // decipher (K1 finding 4).
    expect(await h.keys.mine()).toEqual({
      fingerprint: null,
      status: 'unavailable',
      message: 'keys unavailable — sign in again',
    });
    expect(await h.privateKeys(RESET_VAULT_KEY)).toBeNull();
    expect(await h.privateKeys(VAULT_KEY)).not.toBeNull();
  });

  test('a reported reset replaces the pair the key cannot open (SP02 §7)', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    h.setVaultKey(RESET_VAULT_KEY);
    h.sent.length = 0;

    const second = await h.keys.ensure(h.connection, { regenerate: true });
    expect(second.created).toBe(true);
    expect(second.published).toBe(true);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // The stored value opens with the new key now, and no longer with the old one.
    expect(await h.privateKeys(RESET_VAULT_KEY)).not.toBeNull();
    expect(await h.privateKeys(VAULT_KEY)).toBeNull();
    expect((await h.keys.mine()).fingerprint).toBe(second.fingerprint);
    // Both halves reached the host, and the blob that went out is the new pair's.
    expect(h.sent).toHaveLength(1);
    expect(await h.openPublishedBlob(RESET_VAULT_KEY)).toEqual(h.mine());
  });

  test('a reported reset adopts the pair the host already holds under this vaultKey', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    h.sent.length = 0;

    // The vault moved (a password change elsewhere, or a reset on another machine that published
    // the new pair): the host's blob opens with the key this session now holds, so it is the
    // account's pair — adopting it is what keeps the two machines from fighting over the key.
    const second = await h.keys.ensure(h.connection, { regenerate: true });
    expect(second.created).toBe(false);
    expect(second.published).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(h.sent).toEqual([]);
  });

  test('a host that refuses writes nothing, and a pair already here stays here', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    h.refuseHost();

    // `docs/canonico.md` §22: a host that cannot be asked is not a host without a pair, so no pair
    // is generated — generating one is what starts the fight over the account's keys.
    const refusedCall = await h.keys.ensure(h.connection);
    expect(refusedCall.error).toBe('could not reach the host');
    expect(refusedCall.created).toBe(false);
    expect(refusedCall.published).toBe(false);
    expect(h.sent).toHaveLength(1);
    // What this machine already holds is untouched and still readable.
    expect((await h.keys.mine()).fingerprint).toBe(first.fingerprint);
    expect(h.storedKeys()?.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
    expect(await h.privateKeys(VAULT_KEY)).not.toBeNull();
  });

  test('a keychain that refuses leaves no pair and no `meta` row behind', async () => {
    const h = harness();
    h.refuseKeychain();

    const status = await h.keys.ensure(h.connection);
    expect(status.error).toBe('the system keychain refused the key pair');
    expect(status.fingerprint).toBeNull();
    expect(h.storedKeys()).toBeNull();
    expect(h.mine()).toBeNull();
    expect(h.sent).toEqual([]);
    expect(await h.keys.mine()).toEqual({
      fingerprint: null,
      status: 'unavailable',
      message: 'keys unavailable — sign in again',
    });
  });

  test('a locked session stores nothing and publishes nothing', async () => {
    const h = harness();
    h.lock();

    const status = await h.keys.ensure(h.connection);
    expect(status.error).toBe('the session is locked');
    expect(status.fingerprint).toBeNull();
    expect(h.storedKeys()).toBeNull();
    expect(h.sent).toEqual([]);
    expect(await h.keys.mine()).toEqual({
      fingerprint: null,
      status: 'unavailable',
      message: 'the session is locked',
    });
  });

  test('without a connection the pair is made and kept on this machine (the O2 gate)', async () => {
    const h = harness();
    const status = await h.keys.ensure(null);
    expect(status.created).toBe(true);
    expect(status.published).toBe(false);
    expect(status.error).toBeNull();
    expect(h.sent).toEqual([]);
    // K1/SP06 §2: the pair is made and usable, but the host has not taken it — the card says so and
    // still shows the fingerprint, because this machine can read its own key.
    expect(await h.keys.mine()).toEqual({
      fingerprint: status.fingerprint,
      status: 'pending',
      message: 'your key is not on the guild yet — it goes out at the next sync',
    });
  });

  test('the pair leaves the pending state once the host takes it', async () => {
    const h = harness();
    const pending = await h.keys.ensure(null);
    expect((await h.keys.mine()).status).toBe('pending');

    // The next `ensure` with a connection publishes the pair it made (`keys.pending.<person>`), and
    // the mark clears with the `PUT /v1/keys` (SP06 §2).
    const published = await h.keys.ensure(h.connection);
    expect(published.published).toBe(true);
    expect(published.fingerprint).toBe(pending.fingerprint);
    expect(await h.keys.mine()).toEqual({
      fingerprint: pending.fingerprint,
      status: 'ok',
      message: null,
    });
  });

  test('adopting the host’s pair clears a pending mark left by a pair this machine made', async () => {
    const h = harness();
    // This machine made a pair with no host to publish it to (the O2 gate, a reset): it is pending.
    const pending = await h.keys.ensure(null);
    expect((await h.keys.mine()).status).toBe('pending');

    // The host holds another pair a second machine published under the same `vaultKey`; adopting it
    // means this machine no longer holds an unpublished pair, so the mark must go.
    const other = await fullKeyPair();
    h.setHostKeys(await hostRowFor(h.person.id, VAULT_KEY, other));
    const status = await h.keys.ensure(h.connection);
    expect(status.published).toBe(false);
    expect(status.fingerprint).not.toBe(pending.fingerprint);
    expect(h.mine()).toEqual(publicsOf(other));
    expect(await h.keys.mine()).toEqual({
      fingerprint: status.fingerprint,
      status: 'ok',
      message: null,
    });
  });
});

describe('one pair per person across machines (canonico §22)', () => {
  test('(a) the host holds the pair without the blob: only the blob is uploaded', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    const mine = h.mine();
    expect(mine).not.toBeNull();
    // The row a host of the previous rule carries: the public keys and no blob.
    h.setHostKeys({
      x25519Public: mine?.x25519 ?? '',
      ed25519Public: mine?.ed25519 ?? '',
      privateSealed: null,
    });
    h.sent.length = 0;

    const status = await h.keys.ensure(h.connection);
    expect(status.created).toBe(false);
    expect(status.fingerprint).toBe(first.fingerprint);
    expect(status.published).toBe(true);
    expect(h.sent).toHaveLength(1);
    // Both halves went out together, and the blob is this pair's, sealed under this `vaultKey`.
    expect(h.published().x25519Public).toBe(mine?.x25519);
    expect(await h.openPublishedBlob(VAULT_KEY)).toEqual(mine);
  });

  test('(b) a machine without keys adopts the host’s pair instead of publishing one', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    const roster = h.hostKeys();
    expect(roster).not.toBeNull();
    expect(roster?.privateSealed?.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
    // The same machine after a keychain wipe: nothing local, the host's row untouched.
    h.forgetLocal();
    h.sent.length = 0;

    const status = await h.keys.ensure(h.connection);
    expect(status.created).toBe(false);
    expect(status.published).toBe(false);
    expect(status.error).toBeNull();
    expect(status.fingerprint).toBe(first.fingerprint);
    expect(h.sent).toEqual([]);
    // The pair is stored here, sealed with this machine's own `vaultKey`, and the host's row is
    // exactly what it was — nothing was published, so nothing can have moved.
    expect(h.storedKeys()?.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
    expect(h.mine()).toEqual({ x25519: roster?.x25519Public, ed25519: roster?.ed25519Public });
    expect(h.hostKeys()).toEqual(roster);
  });

  test('(c) a local pair the host superseded is adopted, never re-published', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    // Another machine published a pair of its own: the host's row is that pair, with its blob.
    const other = await fullKeyPair();
    h.setHostKeys(await hostRowFor(h.person.id, VAULT_KEY, other));
    h.sent.length = 0;

    const status = await h.keys.ensure(h.connection);
    expect(status.created).toBe(false);
    expect(status.published).toBe(false);
    expect(status.error).toBeNull();
    expect(h.sent).toEqual([]);
    expect(status.fingerprint).not.toBe(first.fingerprint);
    // The local pair was replaced — both halves, the keychain value included.
    expect(h.mine()).toEqual(publicsOf(other));
    expect(await h.privateKeys(VAULT_KEY)).toEqual(privatesOf(other));
  });

  test('(e) a blob that does not open leaves the local pair alone and says so', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    // The other machine's pair, sealed under a key this session does not hold: the password moved
    // elsewhere and this machine is still unlocked with the old `vaultKey`.
    const other = await fullKeyPair();
    h.setHostKeys(await hostRowFor(h.person.id, RESET_VAULT_KEY, other));
    h.sent.length = 0;

    const status = await h.keys.ensure(h.connection);
    expect(status.error).toBe('keys unavailable — sign in again');
    expect(status.created).toBe(false);
    expect(status.published).toBe(false);
    expect(h.sent).toEqual([]);
    // The local pair is superseded on the host but this machine can still read it, so the card shows
    // its fingerprint — the `ensure` error is about the host's blob, not about this key.
    expect((await h.keys.mine()).fingerprint).toBe(first.fingerprint);
    expect(await h.privateKeys(VAULT_KEY)).not.toBeNull();
  });

  test('(e) a machine without keys never generates a competing pair', async () => {
    const h = harness();
    const other = await fullKeyPair();
    h.setHostKeys(await hostRowFor(h.person.id, RESET_VAULT_KEY, other));
    h.sent.length = 0;

    const status = await h.keys.ensure(h.connection);
    expect(status.error).toBe('keys unavailable — sign in again');
    expect(status.created).toBe(false);
    expect(status.published).toBe(false);
    expect(h.storedKeys()).toBeNull();
    expect(h.mine()).toBeNull();
    expect(h.sent).toEqual([]);
  });

  test('a pair generated while the host could not be asked is published by the next ensure', async () => {
    // The reset path with no connection to publish on (the activation writes the `host` row right
    // after signing the keys): the host still holds the pair this reset replaced, and its blob does
    // not open here — so the pair this machine made is what goes out, not an adoption.
    const h = harness();
    const first = await h.keys.ensure(null);
    expect(first.created).toBe(true);
    expect(first.published).toBe(false);

    const replaced = await fullKeyPair();
    h.setHostKeys(await hostRowFor(h.person.id, RESET_VAULT_KEY, replaced));
    h.sent.length = 0;

    const status = await h.keys.ensure(h.connection);
    expect(status.fingerprint).toBe(first.fingerprint);
    expect(status.created).toBe(false);
    expect(status.published).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.hostKeys()?.x25519Public).toBe(h.mine()?.x25519);
    expect(await h.openPublishedBlob(VAULT_KEY)).toEqual(h.mine());
  });

  test('reSeal re-seals the pair under the moved key and republishes the blob', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    const mine = h.mine();
    expect(mine).not.toBeNull();
    // SP02 §7: the vault just moved (a password change). The pair does not move with it.
    h.setVaultKey(RESET_VAULT_KEY);
    h.sent.length = 0;

    const status = await h.keys.reSeal(VAULT_KEY, h.connection);
    expect(status.fingerprint).toBe(first.fingerprint);
    expect(status.created).toBe(false);
    expect(status.published).toBe(true);
    // The value opens with the new key now, and no longer with the old one; the pair is the same.
    expect(await h.privateKeys(RESET_VAULT_KEY)).not.toBeNull();
    expect(await h.privateKeys(VAULT_KEY)).toBeNull();
    expect(h.mine()).toEqual(mine);
    // The public keys did not move, so no colleague is asked to confirm a change; the blob did.
    expect(h.published().x25519Public).toBe(mine?.x25519);
    expect(await h.openPublishedBlob(RESET_VAULT_KEY)).toEqual(mine);
  });

  test('a re-seal the host refused is repaired by the next ensure (M1)', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    const mine = h.mine();
    expect(mine).not.toBeNull();
    // SP02 §7: the vault is about to move, so the mark goes down first (that is what
    // `session.changePassword` does); the local re-seal works, and the host refuses the blob.
    h.keys.beginReseal();
    h.setVaultKey(RESET_VAULT_KEY);
    h.refusePut();
    h.sent.length = 0;

    const failed = await h.keys.reSeal(VAULT_KEY, h.connection);
    expect(failed.published).toBe(false);
    expect(failed.error).not.toBeNull();
    expect(h.sent).toEqual([]);
    expect(await h.privateKeys(RESET_VAULT_KEY)).not.toBeNull();
    // The host still holds the blob under the key the change moved away from, and the card says
    // the pair is not on the guild yet instead of calling it done.
    expect((await h.keys.mine()).status).toBe('pending');

    // The host is back: `ensure` republishes the blob even though the public keys already match.
    // Without the mark it would stop at them and the stale blob would stay there forever — a second
    // machine signing in with the new password would read `keys unavailable — sign in again`.
    h.acceptHost();
    const status = await h.keys.ensure(h.connection);
    expect(status.created).toBe(false);
    expect(status.fingerprint).toBe(first.fingerprint);
    expect(status.published).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.published().x25519Public).toBe(mine?.x25519);
    expect(await h.openPublishedBlob(RESET_VAULT_KEY)).toEqual(mine);
    // With the host holding this very blob there is nothing left to republish.
    expect((await h.keys.mine()).status).toBe('ok');
  });

  test('a pair that is in step is not republished, mark or no mark (M1)', async () => {
    const h = harness();
    await h.keys.ensure(h.connection);
    h.sent.length = 0;

    // (a)'s early answer: the host holds these public keys and a blob, so there is nothing to send.
    const status = await h.keys.ensure(h.connection);
    expect(status.published).toBe(false);
    expect(h.sent).toEqual([]);
    expect((await h.keys.mine()).status).toBe('ok');
  });

  test('a value the session already moved is published without a second write (M1)', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    const mine = h.mine();
    expect(mine).not.toBeNull();
    // `session.changePassword` re-seals the keychain value in its own batch beside the vault items,
    // so by the time `reSeal` runs the value is already under the new key: this call owes the host
    // nothing but the blob. The host refuses that, which is all that can still fail.
    h.keys.beginReseal();
    await h.resealLocal(RESET_VAULT_KEY);
    h.setVaultKey(RESET_VAULT_KEY);
    h.refusePut();
    h.sent.length = 0;
    const stored = h.storedKeys();

    const failed = await h.keys.reSeal(VAULT_KEY, h.connection);
    expect(failed.published).toBe(false);
    // The only thing that can fail here is the host: the value is already under the new key, so
    // `reSeal` must not call the pair unreadable — before this fix it opened with the old key only,
    // and a password change answered `keys unavailable — sign in again` on itself.
    expect(failed.error).toBe('could not reach the host');
    expect(h.sent).toEqual([]);
    // The pair opens with the new key (the batch wrote it) and this call did not write it a second
    // time; the card says the host is still owed the blob.
    expect(await h.privateKeys(RESET_VAULT_KEY)).not.toBeNull();
    expect(h.storedKeys()).toBe(stored);
    expect((await h.keys.mine()).status).toBe('pending');

    h.acceptHost();
    const status = await h.keys.ensure(h.connection);
    expect(status.created).toBe(false);
    expect(status.fingerprint).toBe(first.fingerprint);
    expect(status.published).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(await h.openPublishedBlob(RESET_VAULT_KEY)).toEqual(mine);
    expect((await h.keys.mine()).status).toBe('ok');
  });

  test('reSeal leaves the keys alone when the key it is given does not open them', async () => {
    const h = harness();
    await h.keys.ensure(h.connection);
    h.setVaultKey(RESET_VAULT_KEY);
    h.sent.length = 0;

    const status = await h.keys.reSeal(new Uint8Array(32).fill(3), h.connection);
    expect(status.error).toBe('keys unavailable — sign in again');
    expect(status.published).toBe(false);
    expect(h.sent).toEqual([]);
    expect(await h.privateKeys(RESET_VAULT_KEY)).toBeNull();
  });

  test('reSeal on a locked session writes nothing', async () => {
    const h = harness();
    await h.keys.ensure(h.connection);
    h.sent.length = 0;
    h.lock();

    const status = await h.keys.reSeal(VAULT_KEY, h.connection);
    expect(status.error).toBe('the session is locked');
    expect(status.fingerprint).toBeNull();
    expect(h.sent).toEqual([]);
  });

  test('a refused password change clears the stale mark, so `mine` stays ok (F3)', async () => {
    const h = harness();
    await h.keys.ensure(h.connection);
    h.sent.length = 0;
    expect((await h.keys.mine()).status).toBe('ok');

    // M1/SP02 §7: `session.changePassword` marks the host's blob stale **before** the vault moves,
    // so a process that dies between the two is still recoverable.
    h.keys.beginReseal();
    expect((await h.keys.mine()).status).toBe('pending');

    // F3: the change was refused — a wrong current password, or a host that would not take the new
    // `authKey` — so the vault never moved and the blob is not stale. The handler clears the mark;
    // before the fix it stayed, and the card answered `pending` until the next unlock.
    h.keys.clearReseal(h.person.id);
    expect((await h.keys.mine()).status).toBe('ok');
    // Clearing the mark is all that happened: the blob was not republished.
    expect(h.sent).toEqual([]);
  });
});

describe('the pin table (K2)', () => {
  test('first sight pins every colleague of the roster and leaves this person out', async () => {
    const h = harness();
    const bea = await keyPairOf();
    h.setRoster([
      rosterPerson(h.person.id, 'Ana', await keyPairOf()),
      rosterPerson('p-bea', 'Bea', bea),
      rosterPerson('p-caio', 'Caio', await keyPairOf()),
    ]);

    expect(await h.keys.observe()).toBe(true);
    const peers = await h.keys.peers();
    expect(peers.map((peer) => peer.personId)).toEqual(['p-bea', 'p-caio']);
    expect(peers.map((peer) => peer.name)).toEqual(['Bea', 'Caio']);
    expect(peers.every((peer) => peer.status === 'pinned')).toBe(true);
    expect(peers[0]?.firstSeen).toBe(NOW.toISOString());
    expect(peers[0]?.confirmedAt).toBe(NOW.toISOString());
    expect(peers[0]?.fingerprint).toBe(
      await personFingerprint(fromBase64url(bea.x25519), fromBase64url(bea.ed25519)),
    );
    // This machine's own pair is not a pin (SP06 §2 pins the colleagues).
    expect(h.repo.peerKey(h.person.id)).toBeNull();
  });

  test('a second observation of the same roster writes nothing', async () => {
    const h = harness();
    h.setRoster([rosterPerson('p-bea', 'Bea', await keyPairOf())]);
    expect(await h.keys.observe()).toBe(true);
    expect(await h.keys.observe()).toBe(false);
  });

  test('a different pair marks the peer changed, keeps the pinned pair and reports it', async () => {
    const h = harness();
    const before = await keyPairOf();
    const after = await keyPairOf();
    h.setRoster([rosterPerson('p-bea', 'Bea', before)]);
    await h.keys.observe();

    h.setRoster([rosterPerson('p-bea', 'Bea', after)]);
    expect(await h.keys.observe()).toBe(true);

    const pinned = h.keys.peerKeyFor('p-bea');
    expect(pinned?.status).toBe('changed');
    // SP06 §2: the pinned pair stays, and it is what an incoming share is verified with
    // (SP06 §3 step 2) — the Ed25519 half the sender's signature is checked against included.
    expect(pinned?.x25519).toBe(before.x25519);
    expect(pinned?.ed25519).toBe(before.ed25519);
    expect(pinned?.fingerprint).toBe(
      await personFingerprint(fromBase64url(before.x25519), fromBase64url(before.ed25519)),
    );

    // The screen shows the fingerprint that changed — the one to read out loud — and the warning.
    const peers = await h.keys.peers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.status).toBe('changed');
    expect(peers[0]?.fingerprint).toBe(
      await personFingerprint(fromBase64url(after.x25519), fromBase64url(after.ed25519)),
    );
  });

  test('confirm promotes the pending pair, and the peer is pinned again', async () => {
    const h = harness();
    const after = await keyPairOf();
    h.setRoster([rosterPerson('p-bea', 'Bea', await keyPairOf())]);
    await h.keys.observe();
    h.setRoster([rosterPerson('p-bea', 'Bea', after)]);
    await h.keys.observe();
    // The fingerprint the list shows: the pending pair, the one the person reads out loud.
    const shown = (await h.keys.peers())[0]?.fingerprint ?? '';

    expect(h.keys.confirm('p-bea', shown)).toBe(true);
    const pinned = h.keys.peerKeyFor('p-bea');
    expect(pinned?.status).toBe('pinned');
    expect(pinned?.x25519).toBe(after.x25519);
    expect(pinned?.ed25519).toBe(after.ed25519);
    expect(pinned?.fingerprint).toBe(
      await personFingerprint(fromBase64url(after.x25519), fromBase64url(after.ed25519)),
    );
    expect(h.repo.peerKey('p-bea')?.confirmedAt).toBe(NOW.toISOString());
    const peers = await h.keys.peers();
    expect(peers[0]?.status).toBe('pinned');
    expect(peers[0]?.confirmedAt).toBe(NOW.toISOString());
    // Nothing is pending now, so the same confirmation has nothing to promote (L2): a call that
    // arrives after the pair moved is refused instead of promoting something nobody looked at.
    expect(() => h.keys.confirm('p-bea', shown)).toThrow('the key changed since this list was drawn — check the fingerprint again');
    expect(() => h.keys.confirm('p-nobody', shown)).toThrow('the key changed since this list was drawn — check the fingerprint again');
  });

  test('confirm refuses a fingerprint the list is not showing (L2)', async () => {
    const h = harness();
    h.setRoster([rosterPerson('p-bea', 'Bea', await keyPairOf())]);
    await h.keys.observe();
    // A third pair arrived while the person was reading the second one out loud: the list on screen
    // still shows the second, and confirming it must not promote the third.
    const onScreen = await keyPairOf();
    const newer = await keyPairOf();
    h.setRoster([rosterPerson('p-bea', 'Bea', onScreen)]);
    await h.keys.observe();
    const shown = (await h.keys.peers())[0]?.fingerprint ?? '';

    h.setRoster([rosterPerson('p-bea', 'Bea', newer)]);
    await h.keys.observe();

    expect(() => h.keys.confirm('p-bea', shown)).toThrow('the key changed since this list was drawn — check the fingerprint again');
    // The table did not move: the pinned pair is still the first one and what the host publishes
    // last is still only pending.
    const pinned = h.keys.peerKeyFor('p-bea');
    expect(pinned?.status).toBe('changed');
    expect(pinned?.fingerprint).not.toBe(shown);
    // The fingerprint the newest list shows is the one that goes through.
    expect(h.keys.confirm('p-bea', (await h.keys.peers())[0]?.fingerprint ?? '')).toBe(true);
    expect(h.keys.peerKeyFor('p-bea')?.ed25519).toBe(newer.ed25519);
  });

  test('a colleague without keys is unknown, and nothing is pinned for them', async () => {
    const h = harness();
    h.setRoster([rosterPerson('p-nina', 'Nina')]);

    expect(await h.keys.observe()).toBe(false);
    expect(h.repo.peerKey('p-nina')).toBeNull();
    expect(h.keys.peerKeyFor('p-nina')).toBeNull();
    expect(await h.keys.peers()).toEqual([
      {
        personId: 'p-nina',
        name: 'Nina',
        fingerprint: null,
        status: 'unknown',
        firstSeen: null,
        confirmedAt: null,
      },
    ]);
  });

  test('a roster that goes back to the pinned pair drops the pending change', async () => {
    const h = harness();
    const before = await keyPairOf();
    h.setRoster([rosterPerson('p-bea', 'Bea', before)]);
    await h.keys.observe();
    h.setRoster([rosterPerson('p-bea', 'Bea', await keyPairOf())]);
    await h.keys.observe();
    expect(h.keys.peerKeyFor('p-bea')?.status).toBe('changed');

    h.setRoster([rosterPerson('p-bea', 'Bea', before)]);
    expect(await h.keys.observe()).toBe(true);
    expect(h.keys.peerKeyFor('p-bea')?.status).toBe('pinned');
    expect(h.repo.peerKey('p-bea')?.pendingX25519).toBeNull();
    expect(await h.keys.observe()).toBe(false);
  });

  test('without a snapshot there is nothing to pin and nothing to list', async () => {
    const h = harness();
    expect(await h.keys.observe()).toBe(false);
    expect(await h.keys.peers()).toEqual([]);
  });

  test('a snapshot of an older host without `people` pins nothing and lists nothing', async () => {
    const h = harness();
    h.repo.saveHostSnapshot({
      snapshot: JSON.stringify({ api: 1, roles: [], orgTools: [] }),
      version: 'v1',
      issuedAt: '2026-10-17T10:00:00.000Z',
      syncedAt: '2026-10-17T10:00:01.000Z',
    });
    expect(await h.keys.observe()).toBe(false);
    expect(await h.keys.peers()).toEqual([]);
  });

  test('a pin is only ever made once: a second sight of another pair is a change', () => {
    const repo = createRepo(memorySqlite());
    repo.migrate();
    expect(
      repo.pinPeerKey({
        personId: 'p-bea',
        x25519: 'x1',
        ed25519: 'e1',
        fingerprint: 'F1',
        firstSeen: 'at-1',
        confirmedAt: 'at-1',
      }),
    ).toBe(true);
    expect(
      repo.pinPeerKey({
        personId: 'p-bea',
        x25519: 'x2',
        ed25519: 'e2',
        fingerprint: 'F2',
        firstSeen: 'at-2',
        confirmedAt: 'at-2',
      }),
    ).toBe(false);
    expect(repo.peerKey('p-bea')).toEqual({
      personId: 'p-bea',
      x25519: 'x1',
      ed25519: 'e1',
      fingerprint: 'F1',
      firstSeen: 'at-1',
      confirmedAt: 'at-1',
      pendingX25519: null,
      pendingEd25519: null,
      pendingFingerprint: null,
      pendingSince: null,
    });
  });
});
