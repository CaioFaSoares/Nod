// The host API contract: the wire shape of every host route and of the two signed documents
// (SP03 §2–§3, SP04 §1–§2, §5). The Nod and the host compile against this one file, so a field
// renamed here breaks both sides in the same commit (`shared/context.md`).
//
// Pure, like every other module of `shared/`: types, path and format constants, and pure helpers —
// no `tjs`, no `tiny`, no DOM, no `bun:*`, and no import beyond `shared/types.ts` and the language.
// The host's SQL rows are `host/repo.ts`'s business; they carry these field names on purpose, so a
// snapshot can hand a row over without a rename (H2 decision 17).
//
// Scope: block 1 and block 2's credential sharing (SP06): every route of SP03 §2–§3 (including
// `/v1/meta/app`, O2) and the block 2 members of `Snapshot`. Sealed shares travel as opaque base64url
// strings — the seal itself is `shared/seal.ts`, and no key material is a field of this file.
//
// Nothing here is secret-bearing by construction: a body carries `authKey` (never the password,
// canonico §11) and its own salt, and the helpers below cover only the code and email formats of
// SP02 §3–§4.

import type { Entry, EventType, Id, Person, Role, View } from './types';

// ---------------------------------------------------------------- routes

/**
 * Every path of block 1, as written in SP03 §2. `:id` marks the segment the caller fills; the route
 * files and the Nod client both build from here, so a typo cannot live in one side only.
 */
export const HOST_ROUTES = {
  /** `200 ok`, text (SP03 §2). */
  health: '/health',
  /** `Discovery`, public (SP04 §1). */
  discovery: '/.well-known/nod',
  authSalt: '/v1/auth/salt',
  authActivate: '/v1/auth/activate',
  authSetup: '/v1/auth/setup',
  authLogin: '/v1/auth/login',
  authLogout: '/v1/auth/logout',
  authPassword: '/v1/auth/password',
  /** Signed `Snapshot`; `304` on an `If-None-Match` hit (SP04 §2). */
  state: '/v1/state',
  sessions: '/v1/sessions',
  session: '/v1/sessions/:id',
  /** `PresenceEntry[]`, person (`kind = member`): who in the guild is online now (RF-58). */
  presence: '/v1/presence',
  /** `:id` matches `^p-[a-z0-9]{10}$`; the Nod generates it (SP03 §2). */
  personalTool: '/v1/personal/tools/:id',
  personalView: '/v1/personal/views/:id',
  favorites: '/v1/favorites',
  events: '/v1/events',
  /** `200 image/png` raw bytes with `ETag: "<sha256>"`, no `Content-Type` negotiation (SP03 §2). */
  guildIcon: '/v1/guild/icon',
  adminPeople: '/v1/admin/people',
  adminPerson: '/v1/admin/people/:id',
  adminPersonCode: '/v1/admin/people/:id/code',
  adminPersonSessions: '/v1/admin/people/:id/sessions',
  adminSession: '/v1/admin/sessions/:id',
  adminRole: '/v1/admin/roles/:id',
  adminGrants: '/v1/admin/grants',
  adminTool: '/v1/admin/tools/:id',
  adminToolPromote: '/v1/admin/tools/:id/promote',
  adminBootstrap: '/v1/admin/bootstrap',
  /** `PUT` stores a PNG and answers its digest; `DELETE` clears it with `204` (SP03 §2). */
  adminGuildIcon: '/v1/admin/guild/icon',
  adminEvents: '/v1/admin/events',
  // block 2 (SP03 §3)
  /** `204`; replaces the caller's public keys, which is what a reset does (SP06 §2). */
  keys: '/v1/keys',
  /**
   * `OwnKeys` to its owner only, `404` when that person has no pair: the sealed private halves a
   * second machine of the same person adopts instead of generating a pair (`docs/canonico.md` §22).
   */
  keysPrivate: '/v1/keys/private',
  /** Answers `{ ids }`; the host checks every recipient against the credential's scope (SP06 §5). */
  shares: '/v1/shares',
  /** `204`; the recipient accepts: the host purges `sealed` and records the holder (SP06 §4). */
  shareAccept: '/v1/shares/:id/accept',
  shareDecline: '/v1/shares/:id/decline',
  /** `Holder[]` to a holder or an admin, `403` to anyone else (SP03 §3). */
  holders: '/v1/credentials/:id/holders',
  /** `204`; the owner holder or an admin revokes one holder (SP06 §4). */
  holder: '/v1/credentials/:id/holders/:personId',
  /**
   * `204`; the owner holder (or an admin) records that a new secret was saved, which is the
   * explicit signal that clears `rotationPending` when no live holder is left to receive an
   * `update` share (RF-48).
   */
  credentialRotated: '/v1/credentials/:id/rotated',
  /**
   * `204`; the credential's owner holder (or an admin) sets the scope of every holder row
   * (SP06 §5). Every later share derives its allowed scope from the owner row.
   */
  credentialScope: '/v1/credentials/:id/scope',
  adminAssignments: '/v1/admin/assignments',
  /** The members of an assigned role still without a copy (SP03 §3, RF-47). */
  adminAssignmentsMissing: '/v1/admin/assignments/missing',
  /** `AppMeta`, public: what a Nod reads before it uses the host (SP03 §3, O2). */
  appMeta: '/v1/meta/app',
} as const;

// ---------------------------------------------------------------- errors

/**
 * The answer of every failing route, and the only field of it (SP03 §1): an English message that
 * never carries a stack trace or a value from the request.
 */
export interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------- devices and sessions

/** SP01 §2 `sessions.os`; `AppInfo.os` in `shared/types.ts` holds the same three values. */
export type DeviceOs = 'macos' | 'windows' | 'linux';

/** SP03 §2: `device = { name, os, appVersion }`, one row per sign-in (SP02 §5). */
export interface Device {
  name: string;
  os: DeviceOs;
  appVersion: string;
}

/** SP03 §2 `DeviceSession`: a live session row of SP01 §2 without the token hash (SP02 §5). */
export interface DeviceSession {
  id: Id;
  personId: Id;
  device: Device;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** Touched on every authenticated request: the sliding expiry (SP02 §5). */
  lastSeenAt: string;
  expiresAt: string;
}

/**
 * RF-58: a person is online while one of their live sessions was seen inside this window. The Nod
 * syncs every 5 minutes and every authenticated request touches `last_seen_at` (SP02 §5), so six
 * minutes covers one missed tick without a heartbeat. Kept out of the signed snapshot: presence
 * would move its `version` on every poll (SP04 §2).
 */
export const PRESENCE_WINDOW_MS = 6 * 60_000;

/** `GET /v1/presence` (RF-58): a member with a live session — never device, OS or address. */
export interface PresenceEntry {
  personId: Id;
  name: string;
  /** ISO 8601 UTC: the newest `last_seen_at` among their live sessions. */
  lastSeenAt: string;
  /** `lastSeenAt` is inside `PRESENCE_WINDOW_MS` of the host clock. */
  online: boolean;
}

// ---------------------------------------------------------------- auth (SP02)

/** SP03 §2 `POST /v1/auth/salt` (SP02 §4). */
export interface SaltRequest {
  email: string;
}

/** Answered for every email, so it never says who exists (SP02 §4). */
export interface SaltResponse {
  /** base64url of the person's 16 bytes — or the stable fake salt of SP02 §4. */
  salt: string;
  /** `PBKDF2_ITERATIONS`, the same 600 000 for everyone (SP02 §1, §4). */
  iterations: number;
}

/** `{ token, personId }`: the answer of `activate`, `setup` and `login` (SP03 §2). */
export interface TokenResponse {
  /** 32 random bytes, base64url; returned once, stored by the host as hex SHA-256 (SP02 §5). */
  token: string;
  personId: Id;
}

/** `POST /v1/auth/activate` (SP03 §2): redeem an `activate` code and set the first password. */
export interface ActivateRequest {
  email: string;
  /** The code as typed; the host normalizes it before hashing (SP02 §3). */
  code: string;
  /** base64url of the 16 bytes the Nod chose for this person (SP02 §1). */
  salt: string;
  /** base64url of the 32-byte `authKey`; the password never travels (SP02 §1–§2). */
  authKey: string;
  device: Device;
}

/** `POST /v1/auth/setup` (SP03 §2): the setup code, which creates the first admin. */
export interface SetupRequest extends ActivateRequest {
  name: string;
}

/** `POST /v1/auth/login` (SP03 §2). The salt came from `/v1/auth/salt` (SP02 §4). */
export interface LoginRequest {
  email: string;
  authKey: string;
  device: Device;
}

/** `POST /v1/auth/password` (SP02 §7): the session survives the change. */
export interface PasswordChangeRequest {
  /** base64url of the current `authKey`, verified by the host before anything is written. */
  currentAuthKey: string;
  /** base64url of the 16 bytes of the new derivation. */
  newSalt: string;
  newAuthKey: string;
}

// ---------------------------------------------------------------- people

/** SP01 §2 `people.kind`: `member` is a person, `client` the read-only caller of E04. */
export type PersonKind = 'member' | 'client';

/**
 * SP03 §2 `AdminPerson`: `Person` plus the host's own columns — and never `salt` or `auth_hash`
 * (SP02 §2), which no route returns.
 */
export interface AdminPerson extends Person {
  kind: PersonKind;
  /** Null until the person redeems a code (SP02 §3). */
  activatedAt: string | null;
  /** Set when the host disabled the person: no sign-in, no snapshot (SP01 §2). */
  disabledAt: string | null;
}

/** `POST /v1/admin/people` (SP03 §2). */
export interface PersonCreateRequest {
  email: string;
  name: string;
  roles: Id[];
}

/** The new person and the access code, which is shown once and never returned again (SP02 §3). */
export interface PersonCreateResponse {
  person: AdminPerson;
  code: string;
  expiresAt: string;
}

/** `PATCH /v1/admin/people/:id`: only what the caller sends changes (SP03 §2). */
export interface PersonUpdateRequest {
  name?: string;
  roles?: Id[];
  /** `true` revokes every session of that person (SP02 §5). */
  disabled?: boolean;
}

/** `POST /v1/admin/people/:id/code` (SP03 §2): a reissued code replaces the previous one. */
export interface CodeResponse {
  code: string;
  expiresAt: string;
}

// ---------------------------------------------------------------- roles, grants, tools

/** `PUT /v1/admin/roles/:id` (SP03 §2); the answer is the stored `Role`. */
export interface RoleRequest {
  name: string;
  admin: boolean;
}

/** `PUT /v1/admin/grants` (SP03 §2): a grant references an org entry only (SP01 §2). */
export interface GrantRequest {
  roleId: Id;
  entryId: Id;
  granted: boolean;
}

/**
 * `OrgTool` = `Entry` + views (SP03 §2): the body and the answer of the admin tool routes. `roles`
 * is the entry's grants; `views` is the whole view list in display order. A view the host created
 * carries its `id` (SP04 §2); a write may leave it out for one the host has not created yet.
 */
export type OrgTool = Entry;

/** `POST /v1/admin/tools/:id/promote` (SP03 §2): the personal tool to copy to the org catalog. */
export interface PromoteRequest {
  personalId: Id;
}

/** `POST /v1/admin/bootstrap` (SP03 §2): roles and tools in one write, once (B8a). */
export interface BootstrapRequest {
  tools: OrgTool[];
  roles: Role[];
}

/**
 * SP03 §2 writes this answer as `{ created }` without typing the count: it is the number of org
 * tools the host created. See the finding in `docs/handovers/c1.md` — if B8a needs the ids instead,
 * this is a one-line change with no other consequence.
 */
export interface BootstrapResponse {
  created: number;
}

// ---------------------------------------------------------------- personal writes and favorites

/** `PUT /v1/personal/tools/:id` (SP03 §2): an entry the person owns (SP04 §2). */
export interface PersonalTool extends Entry {
  /** The Nod's write time, ISO 8601 UTC; the host keeps the newest (SP04 §4). */
  updatedAt: string;
}

/** `PUT /v1/personal/views/:id` (SP03 §2): a `View` the person owns, hung under an entry they see. */
export type PersonalView = View & {
  /** Generated by the Nod and stored by the host (SP01 §2). */
  id: Id;
  /** The entry the view hangs under — an org tool they are granted, or their own personal tool. */
  entryId: Id;
  updatedAt: string;
};

/** The body of `DELETE /v1/personal/tools/:id` and `DELETE /v1/personal/views/:id` (SP03 §2). */
export interface DeleteRequest {
  updatedAt: string;
}

/** `PUT /v1/favorites` (SP03 §2): replaces the ordered list whole (SP04 §4). */
export interface FavoritesRequest {
  /** Entry ids, in the order the person chose. */
  entries: Id[];
  updatedAt: string;
}

// ---------------------------------------------------------------- events

/**
 * One event of a `POST /v1/events` batch (SP04 §5). `id` is the Nod's stable client id and the
 * idempotency key: the host inserts `ON CONFLICT(id) DO NOTHING` and acks every id it holds.
 */
export interface ClientEvent {
  id: Id;
  /** Client time, ISO 8601 UTC. */
  at: string;
  /** The local event kinds of `shared/types.ts` (canonico §13): the list the Nod can produce.
   * SP04 §4's `sync.rejected` is missing from that list — finding in `docs/handovers/c1.md`. */
  kind: EventType;
  toolId: Id | null;
  /** `origin + pathname` only, or null: query and fragment may carry a token (canonico §13). */
  url: string | null;
  result: string | null;
  detail: string | null;
}

/** `POST /v1/events` (SP03 §2): at most 500 events, oldest first, one request at a time (SP04 §5). */
export interface EventsRequest {
  events: ClientEvent[];
}

/** Every id the host now holds — sent before, or inserted by this batch (SP04 §5). */
export interface EventsResponse {
  acked: Id[];
}

/**
 * One row of `GET /v1/admin/events` (SP03 §2). `kind` stays a string: the admin list shows what the
 * host holds, which a newer host may have extended past the Nod's own list.
 */
export interface HostEvent {
  id: Id;
  personId: Id;
  sessionId: Id;
  at: string;
  kind: string;
  toolId: Id | null;
  url: string | null;
  result: string | null;
  detail: string | null;
  /** Host clock, ISO 8601 UTC: when the batch arrived. */
  receivedAt: string;
}

/** The query of `GET /v1/admin/events` (SP03 §2), in the wire names of the URL. */
export interface AdminEventsQuery {
  person?: Id;
  tool?: Id;
  /** Inclusive ISO 8601 bounds on the client time `at`. */
  from?: string;
  to?: string;
  /** Defaults to 500, the page size of the admin list. */
  limit?: number;
}

// ---------------------------------------------------------------- guild icon

/**
 * SP03 §2: the guild icon is the PNG the admin uploads in the Nod. It travels base64url (the rule of
 * `docs/specs/README.md` for binary) and the host stores the bytes; only the digest is signed, so a
 * tampered icon is refused by the Nod without the bytes ever entering the snapshot.
 */
export interface GuildIconRequest {
  /** base64url of the PNG bytes, without padding; must start with the PNG signature. */
  png: string;
}

/** SP03 §2: the lowercase hex SHA-256 of the stored bytes — the value `Snapshot.guildIcon` carries. */
export interface GuildIconResponse {
  sha256: string;
}

/** The first eight bytes of every PNG file (ISO/IEC 15948 §5.2): the only check that needs no decoder. */
export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Whether these bytes are the start of a PNG (SP03 §2: the icon route refuses anything else with a
 * 400). Eight bytes of signature are what the host can decide without decoding an image, and an
 * image decoder is not this contract's.
 */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  }
  return true;
}

// ---------------------------------------------------------------- discovery and snapshot

/** Sign-in methods a host offers (SP04 §1); `email` arrives with the deferred email sign-in. */
export type SignInMethod = 'access-code' | 'email';

/** `GET /.well-known/nod` (SP04 §1): what the Nod shows and pins before it signs in. */
export interface Discovery {
  api: 1;
  /** `meta.guild_name` (SP01 §2). */
  guild: string;
  /** Raw 32-byte Ed25519 public key, base64url, and the id of the pair that signed it. */
  key: { kid: string; ed25519Public: string };
  /** SHA-256 of the raw public key, first 10 bytes, Crockford base32 `XXXX-XXXX-XXXX-XXXX` (SP04 §1). */
  fingerprint: string;
  /** semver of the oldest Nod this host serves. */
  minAppVersion: string;
  signIn: SignInMethod[];
}

/**
 * `GET /v1/meta/app` (SP03 §3, O2): the public document a Nod reads to learn which version this host
 * serves — the same value `Discovery.minAppVersion` carries, from the one configuration (SP07 §2) —
 * and where the tinyjs update manifest lives (`update.check`, canonico §19 F5). `update` is null
 * while the deployment sets no manifest, and a Nod then has no newer build to offer.
 */
export interface AppMeta {
  minAppVersion: string;
  update: { url: string } | null;
}

/**
 * `GET /v1/state` (SP04 §2): the whole state one person sees, filtered to the person, signed as one
 * body. The Nod verifies the signature over the bytes as received and refuses an `issuedAt` older
 * than the last accepted one.
 */
export interface Snapshot {
  api: 1;
  /** base64url of the first 16 bytes of SHA-256 of the unsigned body; also the `ETag`. */
  version: string;
  issuedAt: string;
  /** The caller. The host's private columns (salt, hashes) never travel (SP02 §2). */
  me: { id: Id; email: string; name: string; roles: Id[]; admin: boolean; kind: PersonKind };
  /** Every role of the guild: names are not secret inside it (SP04 §2). */
  roles: Role[];
  /** Org entries granted to me — all of them, if I am admin — with org views and `roles` filled. */
  orgTools: Entry[];
  /** Mine, `scope: 'personal'` (SP04 §2). */
  personalTools: Entry[];
  /** Mine, under any entry I can see (SP01 §2). */
  personalViews: PersonalView[];
  /** Entry ids, in my order (SP04 §2). */
  favorites: Id[];
  /**
   * Lowercase hex SHA-256 of the guild icon the admin uploaded, or null while the guild has none
   * (SP04 §2). It is the icon's `ETag` (`GET /v1/guild/icon`) and what the Nod compares the bytes it
   * downloaded against; the bytes themselves never travel in the snapshot.
   */
  guildIcon: string | null;
  /**
   * The block 2 fields of SP04 §2. They are optional so a Nod still reads a snapshot from a host of
   * an older build, and they are inside the signed bytes like every other field — the Nod refuses an
   * unsigned one whatever it carries.
   */
  /** Every non-disabled person of the guild, with the public keys of those who have them (SP06 §2). */
  people?: SnapshotPerson[];
  /** The open, unexpired shares addressed to me, `sealed` included (SP06 §4). */
  incomingShares?: IncomingShare[];
  /** The holders of every credential I hold — every credential, if I am admin (RF-54). */
  holders?: Record<string, Holder[]>;
  /** Credential ids I own with a revoked holder and no update since: the value must rotate (SP06 §4). */
  rotationPending?: Id[];
}

/** SP04 §2: the name of the `ETag` header of `GET /v1/state`. */
export const SNAPSHOT_ETAG_HEADER = 'ETag';
/** SP04 §2: the name of the signature header of `GET /v1/state`. */
export const SNAPSHOT_SIGNATURE_HEADER = 'Nod-Signature';

/** What `Nod-Signature` carries (SP04 §2), `kid=<kid>; sig=<base64url>`. */
export interface SnapshotSignature {
  /** The id of the signing pair; a `kid` other than the pinned one is a key change, refused. */
  kid: string;
  /** Ed25519 signature over the exact response body bytes — no canonical JSON (SP04 §2). */
  sig: string;
}

/** The signed envelope of `GET /v1/state`: what travels beside the `Snapshot` body, in the two headers of SP04 §2. */
export interface SnapshotEnvelope {
  /** The snapshot's own `version`, quoted in the `ETag` header. */
  version: string;
  signature: SnapshotSignature;
}

// ---------------------------------------------------------------- access and setup codes (SP02 §3)

/**
 * The two codes of SP02 §3. `access` is the one the host stores as purpose `activate` — SP01 §2's
 * `access_codes.purpose` and `host/repo.ts`'s `CodePurpose` — and `setup` is the one that creates
 * the first admin.
 */
export type CodeKind = 'access' | 'setup';

/** Crockford base32 (SP02 §3): `U` is not part of it, and neither are `I`, `L` or `O`. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Random bytes per kind (SP02 §3): 5 for an access code, 10 for a setup code. */
export const CODE_BYTES: Readonly<Record<CodeKind, number>> = { access: 5, setup: 10 };

/** Characters per kind (SP02 §3), which is `CODE_BYTES × 8 / 5`. */
export const CODE_LENGTH: Readonly<Record<CodeKind, number>> = { access: 8, setup: 16 };

/** Codes are grouped in fours: `XXXX-XXXX` and `XXXX-XXXX-XXXX-XXXX` (SP02 §3). */
export const CODE_GROUP = 4;

/** 5 bits per character, most significant first; `bytes` is a whole number of bytes (SP02 §3). */
function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CODE_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += CODE_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Groups a normalized code in fours: `ABCD1234` → `ABCD-1234` (SP02 §3). Presentation only — what
 * the host hashes is `normalizeCode`'s answer.
 */
export function formatCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += CODE_GROUP) groups.push(code.slice(i, i + CODE_GROUP));
  return groups.join('-');
}

/** `generateCode('access')` → `XXXX-XXXX`, `generateCode('setup')` → `XXXX-XXXX-XXXX-XXXX`. */
export function generateCode(kind: CodeKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES[kind]));
  return formatCode(encodeBase32(bytes));
}

/**
 * SP02 §3's normalization, in this order: uppercase; drop spaces and hyphens; `O→0`, `I→1`, `L→1`.
 * Answers `null` when a character is not in the alphabet — `U`, punctuation, anything — which the
 * caller answers with the single `invalid code` failure (SP02 §5).
 */
export function normalizeCode(code: string): string | null {
  const upper = code.toUpperCase().replaceAll(' ', '').replaceAll('-', '');
  let normalized = '';
  for (const char of upper) {
    const mapped = char === 'O' ? '0' : char === 'I' || char === 'L' ? '1' : char;
    if (!CODE_ALPHABET.includes(mapped)) return null;
    normalized += mapped;
  }
  return normalized;
}

/** `normalizeCode` plus the length of that kind: what the host accepts before it hashes (SP02 §3). */
export function validateCode(code: string, kind: CodeKind): boolean {
  const normalized = normalizeCode(code);
  return normalized !== null && normalized.length === CODE_LENGTH[kind];
}

/**
 * SP01 §2 stores emails trimmed and lowercased, and `backend/repo.ts` and `host/repo.ts` do the same
 * at every lookup: this is that one definition, for the routes that must match a person by email
 * (SP02 §4).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------- credential sharing (SP06, block 2)

/**
 * `PUT /v1/keys` (SP03 §3): the two raw 32-byte public keys of SP06 §2, base64url without padding.
 * The private halves never travel in clear — they ride `privateSealed`, an opaque `bv1.` value the
 * host stores and never opens (`docs/canonico.md` §22).
 */
export interface PublicKeys {
  /** The receiving key of SP06 §2. */
  x25519Public: string;
  /** The signing key of SP06 §2. */
  ed25519Public: string;
  /**
   * `docs/canonico.md` §22, SP06 §2: the private halves of this pair as a `bv1.` value sealed under
   * the person's `vaultKey` (AAD `nod.keys.private/v1|<person>`), so every other machine of that
   * person opens the same pair instead of generating a competing one. Absent means "keep what the
   * host already holds"; the two public keys above always travel together with it.
   */
  privateSealed?: string;
}

/**
 * `GET /v1/keys/private` (SP03 §3): the caller's own row — the public keys and the sealed private
 * halves as published. `404` while the person has no pair. Nobody else's row is ever in an answer.
 */
export interface OwnKeys {
  x25519Public: string;
  ed25519Public: string;
  /** The `bv1.` blob `PUT /v1/keys` stored, or `null` for a pair published before the column. */
  privateSealed: string | null;
}

/**
 * The sharing scope of a credential (SP06 §5, SP01 §3 `shares.scope`): who the host accepts as a
 * recipient. `blocked` is a state, never a share: one carrying it is refused whole (SP03 §3).
 */
export type ShareScope = 'role' | 'blocked' | 'org';

/** Why a share exists (SP06 §4): a person's send, an admin's assignment, or the owner's update. */
export type ShareKind = 'send' | 'assign' | 'update';

/** One recipient of a share and the copy sealed to them (`shared/seal.ts`, SP06 §3). */
export interface ShareItem {
  /** The recipient's person id; the host ids the row it creates itself. */
  to: Id;
  /** base64url of SP06 §3's `body || sig`, opaque to the host. */
  sealed: string;
}

/** `POST /v1/shares` (SP03 §3): one sealed copy per item, all of them of one credential. */
export interface ShareRequest {
  /** The owner's uuid, which groups every holder of the credential (SP01 §3). */
  credentialId: Id;
  /** An org entry: only a tool the recipient can reach may be shared (SP06 §5). */
  toolId: Id;
  scope: ShareScope;
  kind: ShareKind;
  items: ShareItem[];
}

/** The ids of the rows this request created, in the order of `items` (SP03 §3). */
export interface ShareResponse {
  ids: Id[];
}

/**
 * `PUT /v1/credentials/:id/scope` (SP03 §3): sets the scope of every holder row of the credential.
 * A later share may narrow it, never widen it; `blocked` refuses every share (SP06 §5).
 */
export interface CredentialScopeRequest {
  scope: ShareScope;
}

/** One open share addressed to the caller, as `Snapshot.incomingShares` carries it (SP04 §2). */
export interface IncomingShare {
  id: Id;
  credentialId: Id;
  toolId: Id;
  /** The sender — the share's `from`, and whose Ed25519 key signs the sealed body (SP06 §3). */
  from: Id;
  scope: ShareScope;
  kind: ShareKind;
  /** The sealed copy, until accept, decline or expiry purges it (SP06 §4). */
  sealed: string;
  /** ISO 8601 UTC; `expiresAt` is `createdAt` + 14 days (SP01 §3). */
  createdAt: string;
  expiresAt: string;
}

/**
 * One holder of a credential (SP03 §3 `GET /v1/credentials/:id/holders`, `Snapshot.holders`): who
 * has a copy, from when, with which scope. The host knows the metadata and never the content (E02 §2).
 */
export interface Holder {
  personId: Id;
  name: string;
  /** The org entry the credential is for; every holder row of one credential carries it (H1). */
  toolId: Id;
  /** The credential's owner: the one holder who can re-share it (SP06 §4). */
  owner: boolean;
  scope: ShareScope;
  /** ISO 8601 UTC: when the row was created, or the last accept of an update. */
  since: string;
  /** Set when the owner revoked this holder (SP06 §4, RF-48); the row stays, with its date. */
  removedAt: string | null;
}

/** `PUT /v1/admin/assignments` (SP03 §3): `assigned: false` removes the assignment. */
export interface AssignmentRequest {
  credentialId: Id;
  roleId: Id;
  toolId: Id;
  assigned: boolean;
}

/** One row of `GET /v1/admin/assignments/missing` (SP03 §3): a member of an assigned role without a copy. */
export interface MissingCopy {
  credentialId: Id;
  toolId: Id;
  roleId: Id;
  personId: Id;
}

/**
 * One person of `Snapshot.people` (SP04 §2): the roster a sender picks recipients from. The public
 * keys are absent while the person has not activated (or after a reset, before the new pair lands).
 */
export interface SnapshotPerson {
  id: Id;
  name: string;
  roles: Id[];
  /** `PersonKind` on the wire: a string, so a newer host may add a kind this Nod does not know. */
  kind: string;
  x25519Public?: string;
  ed25519Public?: string;
}
