// The E02 key pairs of this Nod: generated here, sealed with the session's `vaultKey`, published to
// the host, plus the pinned keys of the guild's colleagues — story K1 and K2 of
// `docs/specs/SP06-credential-sharing.md` §2.
//
//   every machine        nod.keys.<person>          bv1. value, AAD = the same string, private halves
//   every machine        meta.keys.public.<person>  JSON { x25519, ed25519 }, the raw public halves
//   the host             PUT /v1/keys               { x25519Public, ed25519Public, privateSealed? }
//   the host             GET /v1/keys/private       the same pair back, the sealed blob included
//   the local database   peer_keys                  one row per colleague, pinned / changed
//
// One key pair per person across machines (`docs/canonico.md` §22): the first machine to activate
// seals the private halves a second time — the host blob, `bv1.` under AAD
// `nod.keys.private/v1|<person>`, carrying both PKCS#8 keys and both public ones — and publishes it
// with the public keys. Every other machine of that person downloads and opens it instead of
// generating a pair of its own, so a colleague stops seeing `changed`. The host stores ciphertext
// and never opens it.
//
// The public halves live in `meta` and not inside the sealed value because the opener needs its own
// x25519 public key besides the private one (SP06 §3 step 3) and a PKCS#8 private key cannot yield it
// (s0): one read from the repository is what `ensure`, `mine` and the future sender all need. They
// are public keys — the host holds them too — so nothing here is a secret at rest; the private halves
// only ever exist inside a `bv1.` value and in this process's memory.
//
// Nothing here imports `tjs` or `tiny`: the repository, the keychain and the session arrive through
// `deps`, so `bun test` drives the whole module against a real temp SQLite and an in-memory keychain.
// No key material reaches a log, an event, an error message, `store.json` or the page.
import { fromBase64url, toBase64url } from '../shared/encoding';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  importEd25519PrivateKey,
  importX25519PrivateKey,
  personFingerprint,
} from '../shared/seal';
import { decryptVaultBytes, encryptVaultBytes } from '../shared/vault-crypto';
import type { OwnKeys, PublicKeys } from '../shared/host-api';
import type { Id, MineKeys, PeerKey, Person, SecretStore } from '../shared/types';
import type { HostConnection } from './host-client';
import type { PeerKeyRecord, Repo } from './repo';

/** SP06 §2: the keychain key of a person's sealed private keys, and the AAD that binds the value. */
export function keysKey(personId: Id): string {
  return `nod.keys.${personId}`;
}

/**
 * `docs/canonico.md` §22: the AAD of the blob the host stores — a second envelope over the same
 * private halves, under a different string, so a value moved between the keychain and the host does
 * not open (`SP02 §8` binds a `bv1.` value to the AAD it was written for).
 */
export function privateKeysAad(personId: Id): string {
  return `nod.keys.private/v1|${personId}`;
}

/**
 * `meta` key of a person's own public halves: the pair this machine generated, as JSON
 * `{ "x25519": "…", "ed25519": "…" }` of the raw 32-byte keys. One key per person, because this
 * database can hold more than one account.
 */
const MINE_PREFIX = 'keys.public.';
/**
 * `meta` mark of a pair this machine generated but has not published: `1` while the host has not
 * taken it. A reset whose `PUT /v1/keys` did not go out (no connection, the O2 gate, a refusal) is
 * the case it exists for (`docs/canonico.md` §22): the next `ensure` publishes *this* pair instead
 * of adopting the one the reset replaced, and the mark goes as soon as the host takes it.
 */
const PENDING_PREFIX = 'keys.pending.';
/**
 * `meta` mark of a pair whose **host blob** is still sealed under the key the session held before a
 * password change (`reSeal`): `1` from the moment the vault moves until `PUT /v1/keys` takes the blob
 * again — a host that refuses, or a process that dies in between, leaves it set. The keychain value
 * itself is moved by `session.changePassword`'s own batch (`reencryptVaultItems`, M1), so the blob is
 * the only thing a change can still owe the host. SP02 §7/M1: the public keys may well match what the
 * host holds, so this mark is what tells `ensure` that the blob itself has to go out again, and it is
 * what `mine` reports as `pending` meanwhile. A blob under a key nobody holds is not a pair another
 * machine can adopt.
 */
const RESEAL_PREFIX = 'keys.reseal.pending.';
/** SP06 §2: the raw public key is 32 bytes, so anything else is not one of these keys. */
const PUBLIC_KEY_LENGTH = 32;
/** No `vaultKey` in memory: a locked session can neither seal the private halves nor open them. */
const LOCKED = 'the session is locked';
const KEYCHAIN_REFUSED = 'the system keychain refused the key pair';
const HOST_REFUSED = 'the host refused the public keys';
/**
 * `docs/canonico.md` §22: this session's `vaultKey` does not open the pair the host holds (the
 * password moved elsewhere and this machine is still unlocked with the old key). Nothing is written
 * and no pair is generated — the person signs in again, and the next `ensure` adopts the host's.
 */
const KEYS_UNAVAILABLE = 'keys unavailable — sign in again';
/**
 * K1/SP06 §2: what the Account card says while this machine holds a pair the host has not taken yet
 * (the O2 gate, a reset that could not publish). The mark clears as soon as `PUT /v1/keys` lands.
 */
const PENDING_PUBLISH = 'your key is not on the guild yet — it goes out at the next sync';
/**
 * L2/K2: the confirmation arrived for a fingerprint this machine is not showing as pending — the
 * host published again between the list and the click (or nothing was pending at all). Nothing is
 * promoted: the person looks at the list again and confirms the pair actually on it.
 */
const PEER_KEY_MOVED = 'the key changed since this list was drawn — check the fingerprint again';

/** One pair of raw public keys, base64url (SP06 §2), as a snapshot and the pin table carry it. */
export interface PublicPair {
  x25519: string;
  ed25519: string;
}

/** What this machine knows of a colleague's pair: the pinned one and, while `changed`, the new one. */
export interface PinnedPair extends PublicPair {
  pending: PublicPair | null;
}

/** SP06 §2's decision on one observation, as a pure function so it is testable on its own. */
export type PinAction =
  /** No row yet: first sight, pin it. */
  | 'pin'
  /** The pinned pair, and nothing pending: nothing to do. */
  | 'none'
  /** A pair that is neither the pinned one nor the pending one: mark the peer `changed`. */
  | 'changed'
  /** The pinned pair again while a change was pending: the change is gone, forget it. */
  | 'clear';

/**
 * SP06 §2 for one colleague: what a snapshot showing `seen` does to what this machine already knows
 * (`previous`, or `null` when it never saw a pair). The pinned pair is never touched here — a
 * difference is a pending pair waiting for the person's confirmation (RF-45).
 */
export function pinAction(previous: PinnedPair | null, seen: PublicPair): PinAction {
  if (previous === null) return 'pin';
  if (previous.x25519 === seen.x25519 && previous.ed25519 === seen.ed25519) {
    return previous.pending === null ? 'none' : 'clear';
  }
  const pending = previous.pending;
  if (pending !== null && pending.x25519 === seen.x25519 && pending.ed25519 === seen.ed25519) {
    return 'none';
  }
  return 'changed';
}

/** The pinned pair of one colleague, as the seal's opener and a future sender read it. */
export interface PinnedPeerKey {
  /** The pair this machine pinned: the one an incoming share's signature is verified against. */
  x25519: string;
  ed25519: string;
  fingerprint: string;
  /**
   * `changed` while the host publishes a different pair and the person has not confirmed it: sending
   * to that colleague must be refused until `confirm` promotes the new pair (RF-45).
   */
  status: 'pinned' | 'changed';
}

/** What one `ensure`/`reSeal` did, for the caller that wants to know and for the tests. */
export interface KeyStatus {
  /** The fingerprint of this machine's own pair (SP06 §2), `null` while there is none. */
  fingerprint: string | null;
  /**
   * This call generated a fresh pair — an activation, a sign-in on a machine without one, a reset.
   * `false` when the pair came from the host instead (a second machine adopting it).
   */
  created: boolean;
  /** `PUT /v1/keys` went out with these public halves and the sealed blob. */
  published: boolean;
  /**
   * Why nothing was written, in English; `null` when the pair is in place. The one the screen shows
   * as an instruction is `keys unavailable — sign in again` (`docs/canonico.md` §22): the host's
   * blob is not one this session's `vaultKey` opens.
   */
  error: string | null;
}

/**
 * K4/SP06 §3: this machine's own pair with the private halves opened — the sender signs with the
 * Ed25519 one and the opener derives with the X25519 one, and the public halves are what the salt
 * and the host's roster need (a PKCS#8 key does not yield its public half, s0).
 */
export interface OwnPrivatePair {
  x25519Public: Uint8Array<ArrayBuffer>;
  ed25519Public: Uint8Array<ArrayBuffer>;
  x25519Private: Uint8Array<ArrayBuffer>;
  ed25519Private: Uint8Array<ArrayBuffer>;
}

export interface KeysDeps {
  repo: Repo;
  /** The OS keychain (`app.secrets` at runtime): the only home of the sealed private halves. */
  keychain: SecretStore;
  /**
   * The unlocked session: whose pair this is and the `vaultKey` that seals it (SP02 §8). `current()`
   * is `null` while locked, which is what makes every method here a no-op instead of a guess.
   */
  session: {
    current(): Person | null;
    vaultKey(): Uint8Array<ArrayBuffer> | null;
  };
  /** Injectable clock (the pin dates in the tests). Default: `new Date()`. */
  now?: () => Date;
}

/** The K1/K2 surface, as `backend/main.ts` and the future send/accept flows use it. */
export interface Keys {
  /**
   * K1/SP06 §2, `docs/canonico.md` §22: makes sure this machine holds the person's X25519 and
   * Ed25519 pairs and that the host knows their public halves and the sealed private blob.
   *
   * The pair is per person, not per machine: the host's row decides. A machine that holds the pair
   * uploads the blob when the host lacks one; a machine without keys, or one whose pair the host
   * superseded, downloads and adopts the host's pair instead of publishing a competing one; a reset
   * (`regenerate`, an activation over an existing account) generates a fresh pair and replaces both
   * halves — unless the host already holds a pair this `vaultKey` opens, which is another machine's
   * reset having published it. A blob that does not open with this `vaultKey` writes nothing and
   * answers `keys unavailable — sign in again`: the person signs in again, and this machine adopts.
   *
   * `connection` is the pinned host, or `null` when there is none or the O2 gate has this Nod too
   * old to write to it; a host that refuses leaves the local pair in place and `KeyStatus.error`
   * carries why. Best-effort by contract: an activation is never refused over a key pair, and
   * nothing here throws.
   */
  ensure(connection: HostConnection | null, options?: { regenerate?: boolean }): Promise<KeyStatus>;
  /**
   * SP02 §7/`docs/canonico.md` §22: the vault just re-keyed (a password change) and the pair does
   * not change with it — the keychain value is re-sealed under the new key (by
   * `session.changePassword`'s own batch, or by this call when it still opens with the old one) and
   * the host blob follows it (the public keys are untouched, so no colleague sees `changed`).
   * `previousVaultKey` is `session.vaultKey()` as it was **before** the change. A value neither key
   * opens writes nothing and answers `keys unavailable — sign in again`.
   */
  reSeal(previousVaultKey: Uint8Array<ArrayBuffer> | null, connection: HostConnection | null): Promise<KeyStatus>;
  /**
   * M1/SP02 §7: the password change is about to move the `vaultKey`, so the host's blob is marked
   * stale **before** it does. `reSeal` then republishes it (and clears the mark) once `PUT /v1/keys`
   * takes it; until then `mine` answers `pending` and the next `ensure` republishes the blob even
   * though the public halves already match the host's — the mark is what makes a change that dies
   * mid-way, or a host that refuses, recoverable. A locked session has nothing to mark and no-ops.
   */
  beginReseal(): void;
  /**
   * F3/M1: the mark above is cleared when `session.changePassword` throws — a wrong current
   * password, a host that would not take the new `authKey` — because the vault did not move and the
   * host's blob is not stale. Without it Settings → Account would answer `pending` (and promise a
   * republish at the next sync) until the next unlock, for a change that never happened.
   */
  clearReseal(personId: Id): void;
  /**
   * K1/SP06 §2 for Settings → Account: the fingerprint of this machine's own pair, whether it is in
   * place, waiting to be published or unavailable, and the sentence to show in the latter two cases.
   * The `meta` row and the keychain value together decide — a pair whose value this `vaultKey` does
   * not open is not one the person can use, and the card says so instead of reading a fingerprint
   * for keys nothing can decipher.
   */
  mine(): Promise<MineKeys>;
  /**
   * K2/SP06 §2: applies the verified snapshot's roster to the pin table — first sight pins, a
   * different pair marks the peer `changed`. Idempotent; answers whether a row moved.
   */
  observe(): Promise<boolean>;
  /** K2: the guild's colleagues as Settings → Account lists them (names from the cached roster). */
  peers(): Promise<PeerKey[]>;
  /** The pinned pair of one colleague and whether it is still in force; `null` when none is pinned. */
  peerKeyFor(personId: Id): PinnedPeerKey | null;
  /**
   * K4/SP06 §3: this machine's own pair, private halves included, for the sender and the opener of
   * `backend/shares.ts`. `null` while locked, before `ensure` ran or while the stored value does not
   * open with this account's `vaultKey`; the caller refuses rather than guesses.
   */
  ownPrivate(): Promise<OwnPrivatePair | null>;
  /**
   * K2/RF-45: the person confirmed the changed pair — the one whose `fingerprint` this machine is
   * showing them (`peers()` answers the pending one while a peer is `changed`). It becomes the
   * pinned one. L2: the confirmation is bound to that fingerprint, so a pair the host replaced
   * between the read and the click — or a call for a peer with nothing pending — is refused instead
   * of promoting a key nobody looked at.
   */
  confirm(personId: Id, fingerprint: string): true;
}

/** One person of `Snapshot.people` (SP04 §2), as far as the pin table cares. */
interface RosterPerson {
  id: Id;
  name: string;
  x25519Public?: string;
  ed25519Public?: string;
}

/**
 * One full pair, as `ensure`, `publish` and `reSeal` pass it around: the public halves (`meta` and
 * the host's roster) and the PKCS#8 private halves (the keychain value and the host's blob).
 */
interface KeyPair {
  x25519: Uint8Array<ArrayBuffer>;
  ed25519: Uint8Array<ArrayBuffer>;
  x25519Private: Uint8Array<ArrayBuffer>;
  ed25519Private: Uint8Array<ArrayBuffer>;
}

/** The four base64url fields of the host blob (`docs/canonico.md` §22), as `sealBlob` writes them. */
interface BlobFields {
  x25519Pkcs8: string;
  ed25519Pkcs8: string;
  x25519Public: string;
  ed25519Public: string;
}

/** The JSON of a stored or cached value; `null` when the text is not JSON at all. */
function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The two base64url halves of a JSON object this module wrote (`{ x25519, ed25519 }`), or `null`.
 * Narrowing by `in`/`typeof` keeps a body of another shape — or a newer one — from being read as a
 * pair of keys.
 */
function readPair(value: unknown): { x25519: string; ed25519: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('x25519' in value) || !('ed25519' in value)) return null;
  const { x25519, ed25519 } = value;
  if (typeof x25519 !== 'string' || typeof ed25519 !== 'string') return null;
  return { x25519, ed25519 };
}

/**
 * The four base64url fields of the host blob this module wrote, or `null` when the JSON is not that
 * shape — a newer blob, another person's, or junk. Both publics travel inside it, which is what lets
 * a machine check that the pair it opened is the pair the host answers with.
 */
function readBlob(value: unknown): BlobFields | null {
  if (typeof value !== 'object' || value === null) return null;
  const blob = value as Record<string, unknown>;
  const { x25519Pkcs8, ed25519Pkcs8, x25519Public, ed25519Public } = blob;
  if (
    typeof x25519Pkcs8 !== 'string' ||
    typeof ed25519Pkcs8 !== 'string' ||
    typeof x25519Public !== 'string' ||
    typeof ed25519Public !== 'string'
  ) {
    return null;
  }
  return { x25519Pkcs8, ed25519Pkcs8, x25519Public, ed25519Public };
}

/** One entry of `Snapshot.people`, or `null` when it carries no usable id. */
function readRosterPerson(value: unknown): RosterPerson | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('id' in value) || typeof value.id !== 'string' || value.id === '') return null;
  const id = value.id;
  const name = 'name' in value && typeof value.name === 'string' ? value.name : id;
  return {
    id,
    name,
    x25519Public: 'x25519Public' in value && typeof value.x25519Public === 'string' ? value.x25519Public : undefined,
    ed25519Public: 'ed25519Public' in value && typeof value.ed25519Public === 'string' ? value.ed25519Public : undefined,
  };
}

/** The message of an error as the page and the tests read it; never a key. */
function reason(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return HOST_REFUSED;
}

export function createKeys(deps: KeysDeps): Keys {
  const now = deps.now ?? (() => new Date());

  // ---------------------------------------------------------------- the cached roster (SP04 §2)

  /**
   * The roster of the last verified snapshot, or `null` when there is none to read: no `host` row,
   * no snapshot yet, bytes that do not parse, or a body of an older host without `people` (SP04 §2
   * makes the field optional). A body this side cannot read is not one it pins keys from.
   */
  function rosterOf(): RosterPerson[] | null {
    const row = deps.repo.hostRecord();
    if (row === null || row.snapshot === null) return null;
    const body = jsonValue(row.snapshot);
    if (typeof body !== 'object' || body === null || !('people' in body)) return null;
    const people = body.people;
    if (!Array.isArray(people)) return null;
    const roster: RosterPerson[] = [];
    for (const item of people) {
      const person = readRosterPerson(item);
      if (person !== null) roster.push(person);
    }
    return roster;
  }

  /** The pair of one roster entry, or `null` when it carries none or not two raw 32-byte keys. */
  function publicPairOf(person: RosterPerson): PublicPair | null {
    const { x25519Public, ed25519Public } = person;
    if (x25519Public === undefined || ed25519Public === undefined) return null;
    try {
      if (
        fromBase64url(x25519Public).length !== PUBLIC_KEY_LENGTH ||
        fromBase64url(ed25519Public).length !== PUBLIC_KEY_LENGTH
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return { x25519: x25519Public, ed25519: ed25519Public };
  }

  /** SP06 §2's fingerprint of a pair of base64url keys; `null` on bytes that are not those keys. */
  async function fingerprintOf(pair: PublicPair): Promise<string | null> {
    try {
      return await personFingerprint(fromBase64url(pair.x25519), fromBase64url(pair.ed25519));
    } catch {
      return null;
    }
  }

  function pendingOf(row: PeerKeyRecord): PublicPair | null {
    const { pendingX25519, pendingEd25519 } = row;
    if (pendingX25519 === null || pendingEd25519 === null) return null;
    return { x25519: pendingX25519, ed25519: pendingEd25519 };
  }

  // ---------------------------------------------------------------- this machine's own pair (K1)

  /** The public halves this machine generated, from `meta`; `null` when there is none to read. */
  function readMine(personId: Id): { x25519: Uint8Array<ArrayBuffer>; ed25519: Uint8Array<ArrayBuffer> } | null {
    const raw = deps.repo.meta(MINE_PREFIX + personId);
    if (raw === null) return null;
    const pair = readPair(jsonValue(raw));
    if (pair === null) return null;
    try {
      const x25519 = fromBase64url(pair.x25519);
      const ed25519 = fromBase64url(pair.ed25519);
      if (x25519.length !== PUBLIC_KEY_LENGTH || ed25519.length !== PUBLIC_KEY_LENGTH) return null;
      return { x25519, ed25519 };
    } catch {
      return null;
    }
  }

  /**
   * The private halves of the `bv1.` value, or `null` when it does not open with this `vaultKey`
   * (the account was reset elsewhere, or the value belongs to another person) or does not carry two
   * PKCS#8 keys: importing them is what proves the stored bytes are the SP06 §2 pairs.
   */
  async function openPrivateKeys(
    vaultKey: Uint8Array<ArrayBuffer>,
    aad: string,
    value: string,
  ): Promise<{ x25519: Uint8Array<ArrayBuffer>; ed25519: Uint8Array<ArrayBuffer> } | null> {
    const bytes = await decryptVaultBytes(vaultKey, aad, value);
    if (bytes === null) return null;
    const pair = readPair(jsonValue(new TextDecoder().decode(bytes)));
    if (pair === null) return null;
    try {
      const x25519 = fromBase64url(pair.x25519);
      const ed25519 = fromBase64url(pair.ed25519);
      await importX25519PrivateKey(x25519);
      await importEd25519PrivateKey(ed25519);
      return { x25519, ed25519 };
    } catch {
      return null;
    }
  }

  /**
   * This machine's pair — the public halves from `meta`, the private ones from the keychain value —
   * or `null` when either half is missing or the value does not open with this `vaultKey`. The
   * `meta` row is what carries the public halves, and a PKCS#8 private key does not yield its public
   * half (s0), so an item that survives a lost `meta` row is unusable: the caller regenerates.
   */
  async function localPair(personId: Id, vaultKey: Uint8Array<ArrayBuffer>): Promise<KeyPair | null> {
    const aad = keysKey(personId);
    const stored = await deps.keychain.get(aad);
    const mine = readMine(personId);
    if (stored === null || mine === null) return null;
    const priv = await openPrivateKeys(vaultKey, aad, stored);
    if (priv === null) return null;
    return {
      x25519: mine.x25519,
      ed25519: mine.ed25519,
      x25519Private: priv.x25519,
      ed25519Private: priv.ed25519,
    };
  }

  /** A fresh pair of the shape every writer below stores and publishes (SP06 §2). */
  async function generatePair(): Promise<KeyPair> {
    const x25519 = await generateX25519KeyPair();
    const ed25519 = await generateEd25519KeyPair();
    return {
      x25519: x25519.publicKey,
      ed25519: ed25519.publicKey,
      x25519Private: x25519.privateKey,
      ed25519Private: ed25519.privateKey,
    };
  }

  /**
   * Writes the pair where this machine reads it: the `bv1.` value under `nod.keys.<person>` (AAD =
   * the same string) and the two public halves in `meta`. Answers whether the keychain took it —
   * `false` means nothing was stored, the `meta` row included.
   */
  async function storePair(
    personId: Id,
    vaultKey: Uint8Array<ArrayBuffer>,
    pair: KeyPair,
  ): Promise<boolean> {
    const value = await encryptVaultBytes(
      vaultKey,
      keysKey(personId),
      new TextEncoder().encode(
        JSON.stringify({
          x25519: toBase64url(pair.x25519Private),
          ed25519: toBase64url(pair.ed25519Private),
        }),
      ),
    );
    if (!(await deps.keychain.set(keysKey(personId), value))) return false;
    deps.repo.setMeta(
      MINE_PREFIX + personId,
      JSON.stringify({
        x25519: toBase64url(pair.x25519),
        ed25519: toBase64url(pair.ed25519),
      }),
    );
    return true;
  }

  /** The two public halves as the wire and the roster carry them (base64url raw 32 bytes, SP06 §2). */
  function publicKeysOf(pair: KeyPair): PublicKeys {
    return { x25519Public: toBase64url(pair.x25519), ed25519Public: toBase64url(pair.ed25519) };
  }

  /** Whether this machine made the pair it holds and the host has not taken it yet (see above). */
  function pendingPublish(personId: Id): boolean {
    return deps.repo.meta(PENDING_PREFIX + personId) === '1';
  }

  /** Marks a freshly generated pair as one the host has not heard about; `publish` clears it. */
  function markPending(personId: Id): void {
    deps.repo.setMeta(PENDING_PREFIX + personId, '1');
  }

  /**
   * Clears the unpublished-pair mark. The host has the pair (`publish`), or this machine adopted the
   * host's own (an adoption means it no longer holds a generated pair the host lacks) — either way
   * the `pending` of `mine()` is no longer true.
   */
  function clearPending(personId: Id): void {
    deps.repo.setMeta(PENDING_PREFIX + personId, '');
  }

  /** Whether the host's blob is still under the key a password change moved away from (above). */
  function resealPending(personId: Id): boolean {
    return deps.repo.meta(RESEAL_PREFIX + personId) === '1';
  }

  /**
   * M1/SP02 §7: marks the host's blob as stale, from the moment a password change starts. The
   * caller is `session.changePassword`, **before** the vault moves: a process that dies between the
   * two leaves the mark set, and the next `ensure` publishes the blob even though the public keys
   * already match — without it the host would keep a blob sealed under a key nobody holds and every
   * other machine of this person would be stuck on `keys unavailable — sign in again`.
   */
  function beginReseal(): void {
    const person = deps.session.current();
    if (person === null) return; // a locked session has nothing to re-seal; `reSeal` answers it.
    deps.repo.setMeta(RESEAL_PREFIX + person.id, '1');
  }

  /**
   * Clears the stale-blob mark: `PUT /v1/keys` took the blob (`publish`), this machine adopted the
   * host's own — an adopted blob is one this session's `vaultKey` has just opened, so the host's copy
   * is sealed under the key in hand and there is nothing left to re-seal — or F3: a
   * `session.changePassword` that threw left the mark behind although the vault never moved.
   */
  function clearReseal(personId: Id): void {
    deps.repo.setMeta(RESEAL_PREFIX + personId, '');
  }

  /**
   * `docs/canonico.md` §22: the pair as the host blob — a second `bv1.` envelope over the private
   * halves, under AAD `nod.keys.private/v1|<person>`, with both public halves inside so the opener
   * can prove it took the pair the host answers with.
   */
  async function sealBlob(
    personId: Id,
    vaultKey: Uint8Array<ArrayBuffer>,
    pair: KeyPair,
  ): Promise<string> {
    return await encryptVaultBytes(
      vaultKey,
      privateKeysAad(personId),
      new TextEncoder().encode(
        JSON.stringify({
          x25519Pkcs8: toBase64url(pair.x25519Private),
          ed25519Pkcs8: toBase64url(pair.ed25519Private),
          x25519Public: toBase64url(pair.x25519),
          ed25519Public: toBase64url(pair.ed25519),
        }),
      ),
    );
  }

  /**
   * The pair inside a host blob, or `null` when it does not open with this `vaultKey`, carries no
   * four base64url halves, or carries private halves this runtime refuses to import: one answer for
   * all three, because the caller does the same thing with each — nothing but report it.
   */
  async function openBlob(
    personId: Id,
    vaultKey: Uint8Array<ArrayBuffer>,
    blob: string,
  ): Promise<KeyPair | null> {
    const bytes = await decryptVaultBytes(vaultKey, privateKeysAad(personId), blob);
    if (bytes === null) return null;
    const fields = readBlob(jsonValue(new TextDecoder().decode(bytes)));
    if (fields === null) return null;
    try {
      const pair: KeyPair = {
        x25519: fromBase64url(fields.x25519Public),
        ed25519: fromBase64url(fields.ed25519Public),
        x25519Private: fromBase64url(fields.x25519Pkcs8),
        ed25519Private: fromBase64url(fields.ed25519Pkcs8),
      };
      if (pair.x25519.length !== PUBLIC_KEY_LENGTH || pair.ed25519.length !== PUBLIC_KEY_LENGTH) {
        return null;
      }
      await importX25519PrivateKey(pair.x25519Private);
      await importEd25519PrivateKey(pair.ed25519Private);
      return pair;
    } catch {
      return null;
    }
  }

  /**
   * `docs/canonico.md` §22: the host's pair as this machine's own — opened with this `vaultKey` and
   * required to carry the very public keys the host answered with (the blob is the authority, the
   * response is the claim). `null` means it is not one to adopt, and the caller writes nothing.
   */
  async function adoptBlob(
    hosted: OwnKeys,
    personId: Id,
    vaultKey: Uint8Array<ArrayBuffer>,
  ): Promise<KeyPair | null> {
    if (hosted.privateSealed === null) return null;
    const pair = await openBlob(personId, vaultKey, hosted.privateSealed);
    if (pair === null) return null;
    const publics = publicKeysOf(pair);
    if (publics.x25519Public !== hosted.x25519Public || publics.ed25519Public !== hosted.ed25519Public) {
      return null;
    }
    return pair;
  }

  /** One answer for the caller, from the pair this call ended with. */
  async function report(
    pair: KeyPair,
    created: boolean,
    published: boolean,
    error: string | null,
  ): Promise<KeyStatus> {
    return {
      fingerprint: await personFingerprint(pair.x25519, pair.ed25519),
      created,
      published,
      error,
    };
  }

  /**
   * Whether the host has to hear these public keys: the cached roster does not carry this person,
   * carries no pair for them, or carries a different one. A roster there is none of (no snapshot
   * yet) is a host that cannot be credited with the pair, so the answer is yes — the request is
   * idempotent, and the next snapshot records what was stored.
   */
  function needsPublish(personId: Id, mine: PublicKeys): boolean {
    const roster = rosterOf();
    if (roster === null) return true;
    const found = roster.find((person) => person.id === personId);
    if (found === undefined) return true;
    return found.x25519Public !== mine.x25519Public || found.ed25519Public !== mine.ed25519Public;
  }

  /**
   * Publishes the pair: the public halves and the sealed blob in one `PUT /v1/keys`, which is what
   * makes another machine of this person adopt this very pair (`docs/canonico.md` §22). Without a
   * connection there is nothing to send. A host that refuses leaves everything local in place and
   * the answer carries why; the pair is stored either way.
   */
  async function publish(
    connection: HostConnection | null,
    personId: Id,
    vaultKey: Uint8Array<ArrayBuffer>,
    pair: KeyPair,
    created: boolean,
  ): Promise<KeyStatus> {
    if (connection === null) return await report(pair, created, false, null);
    try {
      await connection.putKeys({
        ...publicKeysOf(pair),
        privateSealed: await sealBlob(personId, vaultKey, pair),
      });
    } catch (error) {
      return await report(pair, created, false, reason(error));
    }
    // The host has the pair and this very blob, so both marks (`keys.pending.` and the stale-blob
    // `keys.reseal.pending.`) are answered by this one request.
    clearPending(personId);
    clearReseal(personId);
    return await report(pair, created, true, null);
  }

  function refused(error: string | null): KeyStatus {
    return { fingerprint: null, created: false, published: false, error };
  }

  async function mine(): Promise<MineKeys> {
    const person = deps.session.current();
    const vaultKey = deps.session.vaultKey();
    if (person === null || vaultKey === null) {
      return { fingerprint: null, status: 'unavailable', message: LOCKED };
    }
    // `localPair` is the honest test: the `meta` row alone can name a pair whose keychain value this
    // `vaultKey` does not open (a reset elsewhere), and such a pair is not one to show a fingerprint
    // for. The read is synchronous against the repository plus one keychain read.
    const pair = await localPair(person.id, vaultKey);
    if (pair === null) {
      return { fingerprint: null, status: 'unavailable', message: KEYS_UNAVAILABLE };
    }
    const fingerprint = await personFingerprint(pair.x25519, pair.ed25519);
    // M1/SP02 §7: the same answer for both marks — this machine's own pair is fine and the host has
    // not taken everything it has to (a pair it never took, or a blob a password change left behind).
    if (pendingPublish(person.id) || resealPending(person.id)) {
      return { fingerprint, status: 'pending', message: PENDING_PUBLISH };
    }
    return { fingerprint, status: 'ok', message: null };
  }

  async function ensure(
    connection: HostConnection | null,
    options: { regenerate?: boolean } = {},
  ): Promise<KeyStatus> {
    const person = deps.session.current();
    const vaultKey = deps.session.vaultKey();
    if (person === null || vaultKey === null) return refused(LOCKED);
    const personId = person.id;

    try {
      // `docs/canonico.md` §22: the host's own row is the account's pair, so every `ensure` reads it
      // — it is what says whether the blob is there, and whether this machine's pair is still the
      // account's. A `404` (no pair on the host) is `null` here, and a refused call throws into the
      // catch below, which reports it without writing anything.
      const hosted = connection === null ? null : await connection.getOwnKeys();

      // (d) SP02 §7/SP06 §2: a reset — this machine re-activated the account, or another machine
      // did and published the new pair. The host's blob decides between the two: one this
      // `vaultKey` opens is the pair the account has now, and adopting it is what keeps two
      // machines from fighting over the key. Anything else is replaced below with a fresh pair.
      if (options.regenerate === true) {
        if (hosted !== null) {
          const adopted = await adoptBlob(hosted, personId, vaultKey);
          if (adopted !== null) {
            if (!(await storePair(personId, vaultKey, adopted))) return refused(KEYCHAIN_REFUSED);
            clearPending(personId);
            clearReseal(personId);
            return await report(adopted, false, false, null);
          }
        }
        const fresh = await generatePair();
        if (!(await storePair(personId, vaultKey, fresh))) return refused(KEYCHAIN_REFUSED);
        markPending(personId);
        return await publish(connection, personId, vaultKey, fresh, true);
      }

      const local = await localPair(personId, vaultKey);

      // (b) This machine has no pair this `vaultKey` opens (a machine that never had one, a wiped
      // keychain, or a password that moved elsewhere and left the old value behind): the host's
      // pair is adopted, and only a host that holds none at all — `404`, or a row published before
      // the blob existed — lets this machine make one.
      if (local === null) {
        if (hosted !== null && hosted.privateSealed !== null) {
          const adopted = await adoptBlob(hosted, personId, vaultKey);
          if (adopted === null) return refused(KEYS_UNAVAILABLE); // (e)
          if (!(await storePair(personId, vaultKey, adopted))) return refused(KEYCHAIN_REFUSED);
          clearPending(personId);
          clearReseal(personId);
          return await report(adopted, false, false, null);
        }
        const fresh = await generatePair();
        if (!(await storePair(personId, vaultKey, fresh))) return refused(KEYCHAIN_REFUSED);
        markPending(personId);
        return await publish(connection, personId, vaultKey, fresh, true);
      }

      const minePublics = publicKeysOf(local);
      if (hosted !== null) {
        // (a) The host already holds this pair: nothing to publish except the blob it does not have
        // yet (a row published before this rule existed), and the one a password change left behind
        // — the public halves matching is no proof that the blob is under the key in hand (M1).
        if (
          hosted.x25519Public === minePublics.x25519Public &&
          hosted.ed25519Public === minePublics.ed25519Public
        ) {
          if (hosted.privateSealed !== null && !resealPending(personId)) {
            return await report(local, false, false, null);
          }
          return await publish(connection, personId, vaultKey, local, false);
        }
        // (c) The host holds another pair: this machine's was superseded (another machine published
        // its own, or a reset elsewhere replaced it). Publishing the local one would start the same
        // fight from this side, so the host's pair is adopted instead — the local one was the loser.
        const adopted = await adoptBlob(hosted, personId, vaultKey);
        if (adopted !== null) {
          if (!(await storePair(personId, vaultKey, adopted))) return refused(KEYCHAIN_REFUSED);
          clearPending(personId);
          clearReseal(personId);
          return await report(adopted, false, false, null);
        }
        // The blob is not one this key opens. If this pair is one this machine generated and could
        // not publish (a reset while the host was unreachable, that same activation's unlock), then
        // publishing it is exactly what the reset asked for and the host still holds what it
        // replaced. Any other machine's pair leaves everything alone: (e).
        if (pendingPublish(personId)) {
          return await publish(connection, personId, vaultKey, local, false);
        }
        return refused(KEYS_UNAVAILABLE); // (e)
      }

      // No host knowledge — no connection, no `host` row, or a host that holds no pair yet — so the
      // cached roster is the only witness: publish when it does not carry this pair (SP06 §2).
      if (connection === null || !needsPublish(personId, minePublics)) {
        return await report(local, false, false, null);
      }
      return await publish(connection, personId, vaultKey, local, false);
    } catch (error) {
      return refused(reason(error));
    }
  }

  /**
   * SP02 §7/`docs/canonico.md` §22: the vault just re-keyed (a password change), and the pair does
   * not change with it. The keychain value is sealed under the key in hand — either this call moves
   * it from `previousVaultKey` (a run that let the session's own batch pass it by), or
   * `session.changePassword` already did it beside the vault items and this call only publishes —
   * and the host blob follows, so another machine with the new password still adopts this pair. The
   * public keys are untouched, so no colleague sees `changed`.
   *
   * A value neither key opens is left exactly as it is and the person hears
   * `keys unavailable — sign in again`: re-sealing a pair this machine cannot read would be a guess.
   */
  async function reSeal(
    previousVaultKey: Uint8Array<ArrayBuffer> | null,
    connection: HostConnection | null,
  ): Promise<KeyStatus> {
    const person = deps.session.current();
    const vaultKey = deps.session.vaultKey();
    if (person === null || vaultKey === null) return refused(LOCKED);
    if (previousVaultKey === null) return refused(KEYS_UNAVAILABLE);

    try {
      const aad = keysKey(person.id);
      const stored = await deps.keychain.get(aad);
      const mine = readMine(person.id);
      if (stored === null || mine === null) return refused(KEYS_UNAVAILABLE);
      // M1/SP02 §7: `session.changePassword` re-seals this very value in its own keychain batch
      // (beside the vault items), so by the time this call runs it may already be under the new key
      // — then there is nothing to write and only the host's blob is owed. The value opening with
      // the old key is this call's own to move, exactly as before.
      const priv = await openPrivateKeys(previousVaultKey, aad, stored);
      const opened = priv ?? (await openPrivateKeys(vaultKey, aad, stored));
      if (opened === null) return refused(KEYS_UNAVAILABLE);
      const pair: KeyPair = {
        x25519: mine.x25519,
        ed25519: mine.ed25519,
        x25519Private: opened.x25519,
        ed25519Private: opened.ed25519,
      };
      if (priv !== null && !(await storePair(person.id, vaultKey, pair))) {
        return refused(KEYCHAIN_REFUSED);
      }
      return await publish(connection, person.id, vaultKey, pair, false);
    } catch (error) {
      return refused(reason(error));
    }
  }

  // ---------------------------------------------------------------- the pin table (K2)

  async function observe(): Promise<boolean> {
    const roster = rosterOf();
    if (roster === null) return false;
    const me = deps.session.current();
    const at = now().toISOString();
    let moved = false;
    for (const person of roster) {
      // This machine's own entry is K1's, not a pin: it follows from `ensure`, never from the host.
      if (me !== null && person.id === me.id) continue;
      const seen = publicPairOf(person);
      if (seen === null) continue;
      const fingerprint = await fingerprintOf(seen);
      if (fingerprint === null) continue;
      const previous = deps.repo.peerKey(person.id);
      switch (
        pinAction(
          previous === null
            ? null
            : { x25519: previous.x25519, ed25519: previous.ed25519, pending: pendingOf(previous) },
          seen,
        )
      ) {
        case 'pin':
          moved =
            deps.repo.pinPeerKey({
              personId: person.id,
              ...seen,
              fingerprint,
              firstSeen: at,
              // SP06 §2 pins on first sight: there is nothing to compare against, and the pin *is*
              // the confirmation that this machine met the key then (`confirmed_at`).
              confirmedAt: at,
            }) || moved;
          break;
        case 'changed':
          moved =
            deps.repo.markPeerKeyChanged({ personId: person.id, ...seen, fingerprint, since: at }) ||
            moved;
          break;
        case 'clear':
          moved = deps.repo.clearPeerKeyChange(person.id) || moved;
          break;
        case 'none':
          break;
      }
    }
    return moved;
  }

  /** One row of the screen from a pin table row and the roster's name for that person. */
  function peerRow(name: string, row: PeerKeyRecord): PeerKey {
    const changed = pendingOf(row) !== null;
    return {
      personId: row.personId,
      name,
      // While `changed` the new fingerprint is the one to read out loud (SP06 §2); the pinned one
      // is still what an incoming share is verified with, and it stays in the table.
      fingerprint: changed ? row.pendingFingerprint : row.fingerprint,
      status: changed ? 'changed' : 'pinned',
      firstSeen: row.firstSeen,
      confirmedAt: row.confirmedAt,
    };
  }

  async function peers(): Promise<PeerKey[]> {
    // The read is also a first sight (SP06 §2): a person the roster just started carrying keys for
    // is pinned here, so the screen never shows `unknown` for somebody it could pin, and a second
    // call changes nothing.
    await observe();
    const me = deps.session.current();
    const listed: PeerKey[] = [];
    for (const person of rosterOf() ?? []) {
      if (me !== null && person.id === me.id) continue;
      const row = deps.repo.peerKey(person.id);
      listed.push(
        row === null
          ? {
              personId: person.id,
              name: person.name,
              fingerprint: null,
              status: 'unknown',
              firstSeen: null,
              confirmedAt: null,
            }
          : peerRow(person.name, row),
      );
    }
    // By name, so the list does not move when the host reorders its roster; the id breaks a tie.
    return listed.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.personId.localeCompare(right.personId),
    );
  }

  function peerKeyFor(personId: Id): PinnedPeerKey | null {
    const row = deps.repo.peerKey(personId);
    if (row === null) return null;
    return {
      x25519: row.x25519,
      ed25519: row.ed25519,
      fingerprint: row.fingerprint,
      status: pendingOf(row) === null ? 'pinned' : 'changed',
    };
  }

  function confirm(personId: Id, fingerprint: string): true {
    const row = deps.repo.peerKey(personId);
    const pending = row === null ? null : row.pendingFingerprint;
    // L2/RF-45: the person read one fingerprint out loud and confirmed that one. The host can publish
    // again between the list and the click, so the pending fingerprint — not the id alone — is what
    // the confirmation is checked against; a peer with nothing pending has nothing to confirm either.
    if (pending === null || pending !== fingerprint) throw new Error(PEER_KEY_MOVED);
    deps.repo.confirmPeerKey(personId, now().toISOString());
    return true;
  }

  /**
   * K4/SP06 §3: the private halves are the `bv1.` value under `nod.keys.<person>` — the same one
   * `ensure` wrote — and the public halves are the `meta` row beside it. A locked session has no
   * `vaultKey`, a machine that never ran `ensure` has neither, and a value the key does not open is
   * not a pair: all three answer `null`, and the share flow refuses instead of sealing to a guess.
   */
  async function ownPrivate(): Promise<OwnPrivatePair | null> {
    const person = deps.session.current();
    const vaultKey = deps.session.vaultKey();
    if (person === null || vaultKey === null) return null;
    const aad = keysKey(person.id);
    const stored = await deps.keychain.get(aad);
    const mine = readMine(person.id);
    if (stored === null || mine === null) return null;
    const priv = await openPrivateKeys(vaultKey, aad, stored);
    if (priv === null) return null;
    return {
      x25519Public: mine.x25519,
      ed25519Public: mine.ed25519,
      x25519Private: priv.x25519,
      ed25519Private: priv.ed25519,
    };
  }

  return { ensure, reSeal, beginReseal, clearReseal, mine, observe, peers, peerKeyFor, ownPrivate, confirm };
}
