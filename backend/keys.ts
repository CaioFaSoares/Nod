// The E02 key pairs of this Nod: generated here, sealed with the session's `vaultKey`, published to
// the host, plus the pinned keys of the guild's colleagues — story K1 and K2 of
// `docs/specs/SP06-credential-sharing.md` §2.
//
//   every machine        nod.keys.<person>          bv1. value, AAD = the same string, private halves
//   every machine        meta.keys.public.<person>  JSON { x25519, ed25519 }, the raw public halves
//   the host             PUT /v1/keys               { x25519Public, ed25519Public }, base64url
//   the local database   peer_keys                  one row per colleague, pinned / changed
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
import type { PublicKeys } from '../shared/host-api';
import type { Id, PeerKey, Person, SecretStore } from '../shared/types';
import type { HostConnection } from './host-client';
import type { PeerKeyRecord, Repo } from './repo';

/** SP06 §2: the keychain key of a person's sealed private keys, and the AAD that binds the value. */
export function keysKey(personId: Id): string {
  return `nod.keys.${personId}`;
}

/**
 * `meta` key of a person's own public halves: the pair this machine generated, as JSON
 * `{ "x25519": "…", "ed25519": "…" }` of the raw 32-byte keys. One key per person, because this
 * database can hold more than one account.
 */
const MINE_PREFIX = 'keys.public.';
/** SP06 §2: the raw public key is 32 bytes, so anything else is not one of these keys. */
const PUBLIC_KEY_LENGTH = 32;
/** No `vaultKey` in memory: a locked session can neither seal the private halves nor open them. */
const LOCKED = 'the session is locked';
const KEYCHAIN_REFUSED = 'the system keychain refused the key pair';
const HOST_REFUSED = 'the host refused the public keys';

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

/** What one `ensure` did, for the caller that wants to know and for the tests. */
export interface KeyStatus {
  /** The fingerprint of this machine's own pair (SP06 §2), `null` while there is none. */
  fingerprint: string | null;
  /** This call generated a fresh pair — an activation, a sign-in on a machine without one, a reset. */
  created: boolean;
  /** `PUT /v1/keys` went out with these public halves. */
  published: boolean;
  /** Why nothing happened, in English; `null` when the pair is in place. */
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
   * K1/SP06 §2: makes sure this machine holds the person's X25519 and Ed25519 pairs and that the
   * host knows their public halves — generating them when there are none (activation, a sign-in on a
   * machine without a pair), replacing them when the stored ones cannot be opened with this
   * account's `vaultKey` (a reset), or when `regenerate` says the account was reset elsewhere.
   *
   * `connection` is the pinned host, or `null` when there is none or the O2 gate has this Nod too
   * old to write to it; a host that refuses leaves the local pair in place and `KeyStatus.error`
   * carries why. Best-effort by contract: an activation is never refused over a key pair, and
   * nothing here throws.
   */
  ensure(connection: HostConnection | null, options?: { regenerate?: boolean }): Promise<KeyStatus>;
  /** The fingerprint of this machine's own pair, or `null` while it holds none. */
  mine(): Promise<string | null>;
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
  /** K2/RF-45: the person confirmed the changed pair — it becomes the pinned one. */
  confirm(personId: Id): true;
}

/** One person of `Snapshot.people` (SP04 §2), as far as the pin table cares. */
interface RosterPerson {
  id: Id;
  name: string;
  x25519Public?: string;
  ed25519Public?: string;
}

/** The pair this machine made sure it has, and whether this call is what made it. */
interface OwnPair {
  x25519: Uint8Array<ArrayBuffer>;
  ed25519: Uint8Array<ArrayBuffer>;
  created: boolean;
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
   * The pair of this machine, generating and storing one when there is nothing usable: a fresh
   * activation, a sign-in on a machine that never had one, or a value the current `vaultKey` does
   * not open. Answers `null` when the keychain refused the write — nothing was stored in that case,
   * the `meta` row included.
   *
   * The `meta` row is what carries the public halves, so a keychain item that survives a lost `meta`
   * row cannot be reused: a PKCS#8 private key does not yield its public half (s0), and a pair whose
   * public key is unknown could never open a share. That case regenerates, like a reset does.
   */
  async function ownPair(
    personId: Id,
    vaultKey: Uint8Array<ArrayBuffer>,
    regenerate: boolean,
  ): Promise<OwnPair | null> {
    const aad = keysKey(personId);
    if (!regenerate) {
      const stored = await deps.keychain.get(aad);
      const mine = readMine(personId);
      if (stored !== null && mine !== null && (await openPrivateKeys(vaultKey, aad, stored)) !== null) {
        return { ...mine, created: false };
      }
    }

    const x25519 = await generateX25519KeyPair();
    const ed25519 = await generateEd25519KeyPair();
    const value = await encryptVaultBytes(
      vaultKey,
      aad,
      new TextEncoder().encode(
        JSON.stringify({
          x25519: toBase64url(x25519.privateKey),
          ed25519: toBase64url(ed25519.privateKey),
        }),
      ),
    );
    if (!(await deps.keychain.set(aad, value))) return null;
    deps.repo.setMeta(
      MINE_PREFIX + personId,
      JSON.stringify({
        x25519: toBase64url(x25519.publicKey),
        ed25519: toBase64url(ed25519.publicKey),
      }),
    );
    return { x25519: x25519.publicKey, ed25519: ed25519.publicKey, created: true };
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

  function refused(error: string | null): KeyStatus {
    return { fingerprint: null, created: false, published: false, error };
  }

  async function mine(): Promise<string | null> {
    const person = deps.session.current();
    if (person === null) return null;
    const pair = readMine(person.id);
    if (pair === null) return null;
    return await personFingerprint(pair.x25519, pair.ed25519);
  }

  async function ensure(
    connection: HostConnection | null,
    options: { regenerate?: boolean } = {},
  ): Promise<KeyStatus> {
    const person = deps.session.current();
    const vaultKey = deps.session.vaultKey();
    if (person === null || vaultKey === null) return refused(LOCKED);

    let pair: OwnPair | null;
    try {
      pair = await ownPair(person.id, vaultKey, options.regenerate === true);
    } catch (error) {
      return refused(reason(error));
    }
    if (pair === null) return refused(KEYCHAIN_REFUSED);

    const fingerprint = await personFingerprint(pair.x25519, pair.ed25519);
    const publicKeys: PublicKeys = {
      x25519Public: toBase64url(pair.x25519),
      ed25519Public: toBase64url(pair.ed25519),
    };
    const inPlace = { fingerprint, created: pair.created, published: false, error: null };
    if (!needsPublish(person.id, publicKeys) || connection === null) return inPlace;

    try {
      await connection.putKeys(publicKeys);
    } catch (error) {
      return { ...inPlace, error: reason(error) };
    }
    return { ...inPlace, published: true };
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

  function confirm(personId: Id): true {
    // A person with nothing pending, or one this machine never pinned, is not an error: there is
    // simply nothing to promote, and the screen's Confirm only appears while the peer is `changed`.
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

  return { ensure, mine, observe, peers, peerKeyFor, ownPrivate, confirm };
}
