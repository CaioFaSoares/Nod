// The two documents SP04 signs or pins: the discovery of §1 (guild, key, fingerprint, minimum app
// version) and the per-person snapshot of §2 (the body, its version, and the Ed25519 signature over
// the exact bytes that travel).
//
// Why it is one module: `/.well-known/nod` and `GET /v1/state` are the same subject — the host's
// Ed25519 pair, what the Nod pins from it, and what the host signs with it. `host/routes/state.ts`
// mounts the two routes and owns the HTTP surface; everything the bytes depend on lives here, so the
// routes never touch key material or a digest.
//
// Two rules of the folder are structural here:
//
// - **Nothing secret leaves.** The private key is imported once per process and only signs; no error
//   or log of this file carries key material, a body or a bearer (`AGENTS.md`, `host/context.md`).
// - **The bytes are the contract.** SP04 §2 verifies the signature over the body as received, so the
//   document is serialized once by `serializeSnapshot` and those exact bytes are what the route
//   returns — never a re-serialization by the HTTP layer.

import { fromBase64url, toBase64url } from '../shared/encoding';
import {
  CODE_ALPHABET,
  formatCode,
  type Discovery,
  type Holder,
  type IncomingShare,
  type PersonalView,
  type Snapshot,
  type SnapshotPerson,
  type SnapshotSignature,
} from '../shared/host-api';
import type { Entry, Id, Role, View } from '../shared/types';
import type { SigningKey } from './keys';
import type { HostPerson, HostTool, HostView, Repo, ShareRecord } from './repo';

// ---------------------------------------------------------------- source rows (SP04 §2)

/**
 * Everything one person's snapshot is built from: rows `repo.ts` already filtered by owner — no route
 * and no query here can widen what a person sees.
 */
export interface SnapshotSource {
  /** The caller, as `HostPerson`: the private columns (salt, hashes, `disabledAt`) stay in the repo. */
  me: HostPerson;
  /** Every role of the guild: names are not secret inside it (SP04 §2). */
  roles: Role[];
  /** Org entries granted to me; every org entry, if I am admin (SP04 §2). */
  orgTools: HostTool[];
  personalTools: HostTool[];
  personalViews: HostView[];
  favorites: Id[];
  /**
   * The guild icon's digest, or null (SP04 §2's `guildIcon`). The guild serves one icon, so this row
   * is the same for every person — and it is the digest alone, never the bytes: the Nod downloads
   * those from `GET /v1/guild/icon` (SP03 §2).
   */
  guildIcon: string | null;
  /**
   * The block 2 rows of SP04 §2: the roster with its public keys (which is how a sender picks a
   * recipient and seals to them, SP06 §3), the shares waiting for me, the holders of what I hold, and
   * the credentials I must rotate.
   */
  people: SnapshotPerson[];
  incomingShares: ShareRecord[];
  /** By credential id; a `repo.ts` holder row is a `Holder` field for field, so nothing is mapped. */
  holders: Record<string, Holder[]>;
  rotationPending: Id[];
}

/**
 * The reads of SP04 §2, in one place: the admin's catalog or the entries my roles are granted.
 *
 * `now` bounds the expired shares and runs the purge of SP06 §4. It defaults to the wall clock so a
 * caller that only needs the block 1 body keeps its two-argument call; the state route passes its
 * own instant instead, so one request reads one clock.
 */
export function snapshotSource(
  repo: Repo,
  me: HostPerson,
  now: string = new Date().toISOString(),
): SnapshotSource {
  // SP06 §4: every read path clears the ciphertext of the shares that reached 14 days. It is a
  // no-op update when nothing expired, so a poll stays a poll.
  repo.purgeExpiredShares(now);
  const keys = repo.keysByPerson();
  const holders: Record<string, Holder[]> = {};
  for (const credentialId of repo.heldCredentials(me.id, me.admin)) {
    holders[credentialId] = repo.holdersOf(credentialId);
  }
  return {
    me,
    roles: repo.listRoles(),
    orgTools: me.admin ? repo.listOrgTools() : repo.orgToolsFor(me.id),
    personalTools: repo.listPersonalTools(me.id),
    personalViews: repo.listPersonalViews(me.id),
    favorites: repo.favorites(me.id),
    guildIcon: repo.guildIconHash(),
    // SP04 §2: every non-disabled person of the guild, with the keys of those who have a pair. The
    // host's own columns of a person row never travel (`SnapshotPerson` has no email on purpose).
    people: repo
      .listPeople()
      .filter((person) => person.disabledAt === null)
      .map((person) => {
        const pair = keys.get(person.id);
        return {
          id: person.id,
          name: person.name,
          roles: person.roles,
          kind: person.kind,
          ...(pair === undefined
            ? {}
            : { x25519Public: pair.x25519Public, ed25519Public: pair.ed25519Public }),
        };
      }),
    incomingShares: repo.openShares(me.id, now),
    holders,
    rotationPending: repo.rotationPending(me.id),
  };
}

// ---------------------------------------------------------------- document (SP04 §2)

/** A view row as `View`: the id, the scope and the owner travel with the label, url and mode. */
function viewOf(row: HostView): View {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    mode: row.mode,
    scope: row.scope,
    ownerId: row.ownerId,
  };
}

/** An entry row as `Entry`: the host's own columns (`updatedAt`, `ord`) stay out of the wire shape. */
function entryOf(row: HostTool): Entry {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.ownerId,
    title: row.title,
    url: row.url,
    icon: row.icon,
    order: row.order,
    roles: row.roles,
    views: row.views.map(viewOf),
    auth: row.auth,
    active: row.active,
  };
}

/** A personal view row as `PersonalView`: it names the entry it hangs under and its own id (SP04 §2). */
function personalViewOf(row: HostView): PersonalView {
  return { ...viewOf(row), id: row.id, entryId: row.entryId, updatedAt: row.updatedAt };
}

/** A share row as `IncomingShare`: the wire shape names the sender `from`, and `toId` stays here. */
function incomingShareOf(row: ShareRecord): IncomingShare {
  return {
    id: row.id,
    credentialId: row.credentialId,
    toolId: row.toolId,
    from: row.fromId,
    scope: row.scope,
    kind: row.kind,
    sealed: row.sealed,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * SP04 §2's body. `me` is built field by field on purpose: the host's private columns of a person row
 * (`salt`, `auth_hash`, `disabledAt`) are columns of `HostPerson` and none of them is a field of `me`.
 */
export function snapshotDocument(
  source: SnapshotSource,
  issuedAt: string,
  version: string,
): Snapshot {
  return {
    api: 1,
    version,
    issuedAt,
    me: {
      id: source.me.id,
      email: source.me.email,
      name: source.me.name,
      roles: source.me.roles,
      admin: source.me.admin,
      kind: source.me.kind,
    },
    roles: source.roles,
    orgTools: source.orgTools.map(entryOf),
    personalTools: source.personalTools.map(entryOf),
    personalViews: source.personalViews.map(personalViewOf),
    favorites: source.favorites,
    // SP04 §2: the digest is inside the signed bytes, so an icon swapped on the host moves the
    // version and a Nod that holds the old signature refuses the new one.
    guildIcon: source.guildIcon,
    // Block 2, inside the same signed bytes: the roster, my inbox, the holders of what I hold — a
    // holder row of `repo.ts` is a `Holder` field for field, so only the share rows need mapping.
    people: source.people,
    incomingShares: source.incomingShares.map(incomingShareOf),
    holders: source.holders,
    rotationPending: source.rotationPending,
  };
}

/**
 * The bytes of the body: JSON with the name of every object field in ascending order, so the same
 * state always serializes to the same string and the version only moves when the state moves. Every
 * shape here is a document this module builds, and `Entry.auth` is the one free-form value (a JSON
 * column of `repo.ts`); ordering its fields too is what keeps a hand-written `auth` from changing the
 * bytes of an otherwise identical snapshot. Arrays keep their order — the catalog, the views and the
 * favorites are ordered data, not sets.
 */
export function serializeSnapshot(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(serializeSnapshot).join(',')}]`;
  const fields = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, field]) => `${JSON.stringify(name)}:${serializeSnapshot(field)}`);
  return `{${fields.join(',')}}`;
}

// ---------------------------------------------------------------- version and instant (SP04 §2)

/** SP04 §2: the version is the first 16 bytes of the digest — 22 base64url characters. */
export const VERSION_BYTES = 16;

/** base64url of the first `VERSION_BYTES` of SHA-256 of these bytes (SP04 §2). */
export async function snapshotVersion(body: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
  );
  return toBase64url(digest.subarray(0, VERSION_BYTES));
}

/** The two values SP04 §2 derives from one person's state: `issuedAt` and `version`. */
export type IssuedSnapshot = { issuedAt: string; version: string };

/** The state the host issued before, per person: the digest of its content and its instant. */
const issuedStates = new Map<Id, { content: string; issuedAt: string }>();

/**
 * SP04 §2's `issuedAt` and `version` for one state.
 *
 * Two readings of the spec are decided here (recorded in `docs/handovers/h6.md`):
 *
 * - **The version digests the body with an empty `version`.** A field cannot hash itself, and SP04 §2
 *   writes "SHA-256 of the unsigned body" meaning the body as it is signed (the signature travels in
 *   a header); everything else in the document is hashed exactly as it travels.
 * - **`issuedAt` is the instant the current content appeared, not the instant of the response.** It
 *   is part of the body, so a fresh instant per response would give every poll a new version and
 *   `304` could never happen (SP04 §2 asks for both). The host keeps, per person, the instant of the
 *   content it issued last; content that did not move keeps its instant. A restart forgets the table
 *   and re-issues an instant — newer than the one the Nod accepted, which is what SP04 §2 requires.
 *
 * In memory on purpose: it is an optimisation of the answer, not data, exactly like the rate limits
 * of SP02 §5 (`host/context.md`).
 */
export async function issueSnapshot(
  source: SnapshotSource,
  now: () => string,
): Promise<IssuedSnapshot> {
  const content = await snapshotVersion(serializeSnapshot(snapshotDocument(source, '', '')));
  const previous = issuedStates.get(source.me.id);
  const issuedAt = previous !== undefined && previous.content === content ? previous.issuedAt : now();
  issuedStates.set(source.me.id, { content, issuedAt });
  return {
    issuedAt,
    version: await snapshotVersion(serializeSnapshot(snapshotDocument(source, issuedAt, ''))),
  };
}

/** `ETag: "<version>"` (SP04 §2): what the route answers and `backend/host-client.ts` sends back. */
export function etagOf(version: string): string {
  return `"${version}"`;
}

/**
 * Whether the caller already holds this state. SP04 §2's client sends `If-None-Match: "<version>"`; a
 * bare version, a list and the `W/` of a weak validator are answered alike, and `*` matches any state
 * (RFC 9110 §13.1.2).
 */
export function etagMatches(header: string | null, version: string): boolean {
  if (header === null) return false;
  return header.split(',').some((candidate) => {
    const text = candidate.trim().replace(/^W\//, '');
    if (text === '*') return true;
    return text.replace(/^"|"$/g, '') === version;
  });
}

// ---------------------------------------------------------------- signature (SP04 §2)

/** The imported private key of a `SigningKey`, cached per process: `bootHost` builds one and keeps it. */
const privateKeys = new WeakMap<SigningKey, Promise<CryptoKey>>();

function signingKeyOf(key: SigningKey): Promise<CryptoKey> {
  let imported = privateKeys.get(key);
  if (imported === undefined) {
    imported = crypto.subtle.importKey('jwk', key.privateJwk, { name: 'Ed25519' }, false, ['sign']);
    privateKeys.set(key, imported);
  }
  return imported;
}

/** SP04 §2: Ed25519 over the exact body bytes — no canonical JSON on the wire, only here. */
export async function signSnapshot(body: string, key: SigningKey): Promise<SnapshotSignature> {
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', await signingKeyOf(key), new TextEncoder().encode(body)),
  );
  return { kid: key.kid, sig: toBase64url(signature) };
}

/** SP04 §2's `Nod-Signature: kid=<kid>; sig=<base64url>`, the one spelling its client parses. */
export function signatureHeader(signature: SnapshotSignature): string {
  return `kid=${signature.kid}; sig=${signature.sig}`;
}

// ---------------------------------------------------------------- discovery (SP04 §1)

/** SP04 §1.1: the raw public key is 32 bytes and the fingerprint is its first 10 digest bytes. */
export const PUBLIC_KEY_BYTES = 32;
export const FINGERPRINT_BYTES = 10;

/** SP04 §1's raw 32-byte public key, base64url: the `x` of the JWK `host/keys.ts` stores (SP01 §1). */
export function publicKeyOf(key: SigningKey): string {
  const raw = key.publicJwk.x;
  // `host/keys.ts` refuses a signing key without `x` at boot, so this is unreachable for a host that
  // is serving. It stays a refusal instead of a silent empty key.
  if (raw === undefined) throw new Error('the signing key carries no public key');
  // SP04 §1.1: the Nod refuses a key that is not the 32 raw bytes of an Ed25519 pair, and a key file
  // edited by hand is the one way this host could not carry one.
  if (fromBase64url(raw).length !== PUBLIC_KEY_BYTES) {
    throw new Error('the signing key is not a 32-byte Ed25519 public key');
  }
  return raw;
}

/**
 * SP04 §1.1: SHA-256 of the raw public key, its first 10 bytes in Crockford base32, grouped
 * `XXXX-XXXX-XXXX-XXXX` — the string the person reads out and the invite carries.
 *
 * Finding for the coordinator (`docs/handovers/h6.md`): `backend/host-client.ts` holds this same
 * function, and B1's handover already asked for its home to be `shared/host-api.ts`, whose base32
 * encoder is private. Until that move, `host/state.test.ts` asserts the two implementations answer
 * the same string for the same key, and this file never imports from `backend/` (the host image ships
 * `shared/` and `host/` only, `host/Dockerfile`).
 */
export async function fingerprintOf(rawPublicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey));
  let out = '';
  let buffer = 0;
  let bits = 0;
  // 5 bits per character, most significant first; 10 bytes are 80 bits, exactly 16 characters.
  for (const byte of digest.subarray(0, FINGERPRINT_BYTES)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CODE_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  return formatCode(out);
}

/** `GET /.well-known/nod` (SP04 §1): what the Nod shows and pins before it signs in. */
export async function discoveryDocument(input: {
  guild: string;
  key: SigningKey;
  minAppVersion: string;
}): Promise<Discovery> {
  const ed25519Public = publicKeyOf(input.key);
  return {
    api: 1,
    guild: input.guild,
    key: { kid: input.key.kid, ed25519Public },
    // Recomputed from the key that signs, never carried: the fingerprint is what the person compares.
    fingerprint: await fingerprintOf(fromBase64url(ed25519Public)),
    minAppVersion: input.minAppVersion,
    // SP04 §1: `email` arrives with the deferred email sign-in; SP03 §2's `login` is the code-less
    // path of a person who already has a password.
    signIn: ['access-code'],
  };
}
