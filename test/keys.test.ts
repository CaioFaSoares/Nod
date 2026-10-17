// `backend/keys.ts` — K1 and K2 of `docs/specs/SP06-credential-sharing.md` §2 — against a real
// in-memory SQLite and an in-memory keychain: the person fingerprint, the pin decision as a pure
// function, the key pairs of an activation (sealed private halves, published public ones, the
// regeneration a reset forces) and the pin table (first sight pins, a different pair marks the peer
// changed until it is confirmed).
import { describe, expect, test } from 'bun:test';

import { createKeys, keysKey, pinAction } from '../backend/keys';
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
import { VAULT_VALUE_PREFIX, decryptVaultBytes } from '../shared/vault-crypto';
import { memorySqlite } from './helpers/sqlite-bun';
import type { HostConnection } from '../backend/host-client';
import type { PublicKeys } from '../shared/host-api';
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
  /** The private halves inside a stored value, read the way the opener reads them. */
  privateKeys: (vaultKey: Uint8Array<ArrayBuffer>) => Promise<PublicPair | null>;
  mine: () => PublicPair | null;
  /** SP02 §6: the session locked again — no `vaultKey` in memory. */
  lock: () => void;
  /** SP02 §7: the account was activated again, so its `vaultKey` moved. */
  setVaultKey: (key: Uint8Array<ArrayBuffer>) => void;
  refuseKeychain: () => void;
  refuseHost: () => void;
  /** Stores one verified snapshot body, as `backend/sync.ts` does (SP04 §2). */
  setRoster: (people: unknown[]) => void;
}

function harness(): Harness {
  const repo = createRepo(memorySqlite());
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
      if (hostRefused) throw new Error('could not reach the host');
      sent.push(publicKeys);
    },
    // K4: `backend/shares.ts` owns the share flows; this stub only ever publishes keys.
    sendShares: async () => ({ ids: [] }),
    acceptShare: async () => true,
    declineShare: async () => true,
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
    mine: (): PublicPair | null => pairOf(JSON.parse(repo.meta(`keys.public.${person.id}`) ?? 'null') as unknown),
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

    // The fingerprint of the pair this machine holds is the one the screen shows.
    expect(await h.keys.mine()).toBe(status.fingerprint);
    expect(await h.keys.mine()).toBe(
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

  test('a value the current vaultKey cannot open is replaced, and the new pair is published', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    // SP02 §7: the account was activated again elsewhere, so the salt — and the `vaultKey` — moved.
    h.setVaultKey(RESET_VAULT_KEY);

    const second = await h.keys.ensure(h.connection);
    expect(second.created).toBe(true);
    expect(second.published).toBe(true);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // The stored value opens with the new key now, and no longer with the old one.
    expect(await h.privateKeys(RESET_VAULT_KEY)).not.toBeNull();
    expect(await h.privateKeys(VAULT_KEY)).toBeNull();
    expect(await h.keys.mine()).toBe(second.fingerprint);
  });

  test('regenerate replaces a pair that still opens (the reset an activation reports)', async () => {
    const h = harness();
    const first = await h.keys.ensure(h.connection);
    h.sent.length = 0;

    const second = await h.keys.ensure(h.connection, { regenerate: true });
    expect(second.created).toBe(true);
    expect(second.published).toBe(true);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(h.sent).toHaveLength(1);
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
    expect(await h.keys.mine()).toBeNull();
  });

  test('a locked session stores nothing and publishes nothing', async () => {
    const h = harness();
    h.lock();

    const status = await h.keys.ensure(h.connection);
    expect(status.error).toBe('the session is locked');
    expect(status.fingerprint).toBeNull();
    expect(h.storedKeys()).toBeNull();
    expect(h.sent).toEqual([]);
    expect(await h.keys.mine()).toBeNull();
  });

  test('a host that refuses leaves the local pair in place and says why', async () => {
    const h = harness();
    h.refuseHost();

    const status = await h.keys.ensure(h.connection);
    expect(status.created).toBe(true);
    expect(status.published).toBe(false);
    expect(status.error).toBe('could not reach the host');
    // The pair is usable on this machine, and the next unlock publishes it.
    expect(status.fingerprint).toMatch(FINGERPRINT);
    expect(h.storedKeys()?.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
  });

  test('without a connection the pair is made and kept on this machine (the O2 gate)', async () => {
    const h = harness();
    const status = await h.keys.ensure(null);
    expect(status.created).toBe(true);
    expect(status.published).toBe(false);
    expect(status.error).toBeNull();
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

    expect(h.keys.confirm('p-bea')).toBe(true);
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
    // Confirming with nothing pending, or somebody this machine never pinned, still answers `true`.
    expect(h.keys.confirm('p-bea')).toBe(true);
    expect(h.keys.confirm('p-nobody')).toBe(true);
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
