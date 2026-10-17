// The host's data access: every block 1 query lives here, and this is the only module that touches
// `bun:sqlite` besides the connection itself (`openDatabase`/`applyMigrations` in `migrations.ts`,
// `host/context.md`). The rules SP01 §2 cannot express in SQL are enforced here: a grant only on an
// org entry, a personal entry always with an owner, a favorite and a personal view only on an entry
// its person can see, favorites pruned when visibility goes away, and never a change that would
// leave the guild without an admin.
//
// Two rules of this folder are structural:
//
// - **Personal data is filtered by owner in the SQL itself.** No function returns another person's
//   personal tool, views or favorites, admin included — the `owner_id = ?` is part of the query, not
//   of a route that could forget it.
// - **No secret leaves here.** `salt`, `auth_hash`, `token_hash` and `code_hash` are written and
//   compared, never returned; the single exception is `personAuthByEmail`, the one read the sign-in
//   path needs (SP02 §2, §4).
//
// Time arrives as an explicit ISO 8601 UTC string: the caller owns the clock, which is what lets a
// test move it, and the lexicographic order of those strings is chronological
// (`docs/specs/README.md`). Row types are host-local — `shared/host-api.ts` carries the wire shapes
// — and keep the field names of `Entry`/`View` in `shared/types.ts` so a snapshot can hand a row
// over without a rename. The Nod-side shapes that are already stable (`Person`, `Role`,
// `AuthOverride`, `View.mode`) are imported instead of restated.
//
// Error messages are static English (SP03 §1): none of them echoes a value from the request.

import type { Database } from 'bun:sqlite';

import { auditUrl } from '../shared/catalog';
import { fromBase64url, toBase64url } from '../shared/encoding';
import type { AuthOverride, Person, Role, View } from '../shared/types';
import { SCHEMA_VERSION_KEY } from './migrations';

// ---------------------------------------------------------------- types

export type EntryScope = 'org' | 'personal';
export type PersonKind = 'member' | 'client';
export type CodePurpose = 'setup' | 'activate';
export type ViewMode = View['mode'];

/** SP02 §3: an access code dies after 5 wrong tries, or after its TTL. */
export const MAX_CODE_ATTEMPTS = 5;
export const CODE_TTL_MS: Readonly<Record<CodePurpose, number>> = {
  activate: 72 * 3_600_000,
  setup: 24 * 3_600_000,
};
/** SP01 §2: `expires_at = last_seen_at + 14 days`, sliding (SP02 §5). */
export const SESSION_TTL_MS = 14 * 24 * 3_600_000;
/** `GET /v1/admin/events` without a `limit` (SP03 §2). */
export const EVENTS_DEFAULT_LIMIT = 500;

/**
 * The two `meta` rows the guild icon lives in (SP03 §2). `meta` is SP01 §2's key/value table and
 * SP01 §5 pins a fresh `/data` to `schema_version = 1` while block 1 is unreleased: the icon is one
 * value with one digest, so it adds keys instead of a migration. The bytes travel base64url, the rule
 * `docs/specs/README.md` fixes for binary.
 */
export const GUILD_ICON_HASH_KEY = 'guild_icon_sha256';
export const GUILD_ICON_BYTES_KEY = 'guild_icon_bytes';

/** A person row plus the columns the host adds to `Person`. */
export interface HostPerson extends Person {
  kind: PersonKind;
  /** Null until the person redeems a code (SP02 §3). */
  activatedAt: string | null;
  /** Set when the host revoked the person: no sign-in, no snapshot (SP01 §2). */
  disabledAt: string | null;
}

/** The only read that carries `auth_hash` (SP02 §2): the sign-in path of `host/auth.ts`. */
export interface PersonAuth {
  person: HostPerson;
  /** base64url of the 16 bytes stored in clear. */
  salt: string | null;
  /** `argon2id(authKey)`, or null until the person is activated. */
  authHash: string | null;
}

/** `device = { name, os, appVersion }` (SP03 §2); `os` is `macos` | `windows` | `linux` (SP01 §2). */
export interface Device {
  name: string;
  os: string;
  appVersion: string;
}

export interface SessionRecord {
  id: string;
  personId: string;
  device: Device;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** A code row without its hash: the hash is a lookup key, never data. */
export interface CodeRecord {
  id: string;
  purpose: CodePurpose;
  personId: string | null;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

/**
 * One guild invite (0.4.5, RF-59; SP01 §2): the roles it grants, how many redemptions it allows
 * (`maxUses` null = no limit), how many it has had, and until when it works (`expiresAt` null =
 * never). The code is not a field by construction — only its hash is stored, and no read hands a
 * hash back (`shared/host-api.ts`'s `GuildInvite` is this row on the wire).
 */
export interface GuildInviteRecord {
  id: string;
  roles: string[];
  maxUses: number | null;
  uses: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** A view row: the fields `View` carries plus the columns SP01 §2 adds. */
export interface HostView {
  id: string;
  entryId: string;
  scope: EntryScope;
  ownerId: string | null;
  label: string;
  url: string;
  mode: ViewMode;
  /** Display order inside its entry; a personal view is a single row and stays 0. */
  ord: number;
  updatedAt: string;
}

/** An entry row: the fields `Entry` carries plus `scope`, `ownerId` and `updatedAt`. */
export interface HostEntry {
  id: string;
  scope: EntryScope;
  ownerId: string | null;
  title: string;
  /** RF-62: the display category the guild gave the tool; `null` while it filed it nowhere. */
  category: string | null;
  url: string;
  icon: string | null;
  /** `Entry.order`; the column is `ord`. */
  order: number;
  /** Granted role ids (org entries only), in role-id order. */
  roles: string[];
  auth: AuthOverride | null;
  active: boolean;
  updatedAt: string;
}

export interface HostTool extends HostEntry {
  views: HostView[];
}

/** A view a `PUT` carries: `View` plus the id the Nod generates (SP04 §2). */
export interface ViewInput extends View {
  id: string;
}

export interface PersonalViewInput extends ViewInput {
  entryId: string;
}

/** A tool write without grants or views — what a personal tool is. */
export interface EntryInput {
  id: string;
  title: string;
  /**
   * RF-62: the display category. Optional because a personal entry never carries one: the personal
   * routes do not declare the field and `savePersonalTool` writes `NULL`, so a value here is
   * ignored for a personal tool.
   */
  category?: string | null;
  url: string;
  icon: string | null;
  order: number;
  auth: AuthOverride | null;
  active: boolean;
}

/** An org tool write: `roles` replaces the entry's grants, `views` replaces its views in this order. */
export interface ToolInput extends EntryInput {
  roles: string[];
  views: ViewInput[];
}

/** One event of a `POST /v1/events` batch; `id` is the Nod's stable client id (SP04 §5). */
export interface EventInput {
  id: string;
  at: string;
  kind: string;
  toolId?: string | null;
  /** Stored as origin + pathname only, or null. */
  url?: string | null;
  result?: string | null;
  detail?: string | null;
}

export interface HostEvent {
  id: string;
  personId: string;
  sessionId: string;
  at: string;
  kind: string;
  toolId: string | null;
  url: string | null;
  result: string | null;
  detail: string | null;
  receivedAt: string;
}

export interface HostEventFilter {
  personId?: string;
  toolId?: string;
  /** Inclusive ISO 8601 bounds on the client time `at`. */
  from?: string;
  to?: string;
  /** Defaults to `EVENTS_DEFAULT_LIMIT`. */
  limit?: number;
}

/**
 * The guild icon of SP03 §2: the PNG bytes the admin uploaded and the lowercase hex SHA-256 of those
 * exact bytes. The digest is what the snapshot signs; the bytes are what `GET /v1/guild/icon`
 * answers, and the two are always read from the same two `meta` rows.
 */
export interface GuildIcon {
  sha256: string;
  /** Backed by a plain `ArrayBuffer`, the way `shared/encoding.ts` hands bytes over (WebCrypto and `Response` take those). */
  bytes: Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------- block 2: credential sharing (SP06)

/** SP06 §4: an unaccepted share dies after 14 days and its ciphertext is purged (SP01 §3). */
export const SHARE_TTL_MS = 14 * 24 * 3_600_000;

/** SP01 §3 `shares.scope`, SP06 §5: `blocked` is a state of the credential, never a share that travels. */
export type ShareScope = 'role' | 'blocked' | 'org';

/** SP01 §3 `shares.kind`, SP06 §4: a person's send, an admin's assignment, or the owner's update. */
export type ShareKind = 'send' | 'assign' | 'update';

/**
 * SP06 §5's breadth of a scope: `blocked` reaches nobody, `role` a shared role, `org` every member.
 * A share may narrow the credential's scope, never widen it.
 */
const SCOPE_BREADTH: Readonly<Record<ShareScope, number>> = { blocked: 0, role: 1, org: 2 };

/** SP06 §2: the public halves of a person's pair, as `person_keys` stores them (base64url, 32 bytes). */
export interface PersonKeys {
  x25519Public: string;
  ed25519Public: string;
}

/**
 * `docs/canonico.md` §22, SP06 §2: the owner's row with the sealed private halves. Only
 * `GET /v1/keys/private` — the person's own read — ever sees this shape; the roster and the sender's
 * lookup use `PersonKeys` above, which has no private half at all.
 */
export interface OwnPersonKeys extends PersonKeys {
  /** The `bv1.` blob the Nod sealed, or `null` for a row written before migration 3. */
  privateSealed: string | null;
}

/** One `shares` row (SP01 §3) as the host reads it back. */
export interface ShareRecord {
  id: string;
  credentialId: string;
  fromId: string;
  toId: string;
  toolId: string;
  scope: ShareScope;
  kind: ShareKind;
  /** base64url of SP06 §3's body, or `''` once accept, decline or expiry purged it. */
  sealed: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  purgedAt: string | null;
}

/** One `credential_holders` row with the person's name: SP03 §3's `Holder`, row for row. */
export interface HolderRecord {
  personId: string;
  name: string;
  toolId: string;
  owner: boolean;
  scope: ShareScope;
  since: string;
  removedAt: string | null;
}

/** One row of `GET /v1/admin/assignments/missing` (SP03 §3): a member of an assigned role without a copy. */
export interface MissingCopyRecord {
  credentialId: string;
  toolId: string;
  roleId: string;
  personId: string;
}

/** One recipient of `POST /v1/shares`: the row id the route chose and the copy sealed to them. */
export interface ShareItemInput {
  id: string;
  to: string;
  sealed: string;
}

/** Everything `POST /v1/shares` carries: one scope, one kind, one sealed copy per item (SP06 §4). */
export interface ShareInput {
  fromId: string;
  credentialId: string;
  toolId: string;
  scope: ShareScope;
  kind: ShareKind;
  items: ShareItemInput[];
}

// ---------------------------------------------------------------- errors

/**
 * A rule the host refuses to break. `status` is the code SP03 §1 gives it, so a route maps an error
 * to a response without interpreting a message: 409 for a conflict, 403 for "not yours", 404 for an
 * id an admin cannot find.
 */
export class RepoError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export class ConflictError extends RepoError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class ForbiddenError extends RepoError {
  constructor(message: string) {
    super(message, 403);
  }
}

export class NotFoundError extends RepoError {
  constructor(message: string) {
    super(message, 404);
  }
}

// ---------------------------------------------------------------- contract

/**
 * The host's SQL, in one place. Every method takes what the route already validated and answers with
 * rows; a broken rule throws a typed error (above). The wire shapes (`shared/host-api.ts`) are the
 * routes' business, not this module's.
 */
export interface Repo {
  /**
   * One unit of work, so a route that composes writes — redeem a setup code, create the person,
   * open the session — is all-or-nothing. Nested calls become savepoints (`bun:sqlite`), and the
   * callback is synchronous.
   */
  transaction<T>(work: () => T): T;

  // meta (SP01 §2)
  meta(key: string): string | null;
  /** Refuses `schema_version`: that key belongs to `applyMigrations`. */
  setMeta(key: string, value: string): void;

  // people
  /** Creates the person, lowercasing and trimming the email (SP01 §2). `409` on a taken email. */
  createPerson(
    input: { id: string; email: string; name: string; kind?: PersonKind; roles?: string[] },
    now: string,
  ): HostPerson;
  personById(id: string): HostPerson | null;
  /** Normalized email; a person row without `salt` or `auth_hash`. */
  personByEmail(email: string): HostPerson | null;
  /** The sign-in read: the row plus the salt and `argon2id(authKey)` of SP02 §2. */
  personAuthByEmail(email: string): PersonAuth | null;
  listPeople(): HostPerson[];
  renamePerson(personId: string, name: string): HostPerson;
  /** Replaces the person's roles and prunes favorites they can no longer see (SP01 §2). */
  setRoles(personId: string, roles: string[]): HostPerson;
  /** Disabling revokes every session of the person (SP02 §5, SP03 §2). */
  setDisabled(personId: string, disabled: boolean, now: string): HostPerson;
  /** Stores the first salt and hash and stamps `activated_at` once (SP02 §3, §7). */
  activatePerson(personId: string, auth: { salt: string; authHash: string }, now: string): void;
  /** A password change: new salt, new hash, same activation (SP02 §7). */
  changeAuth(personId: string, auth: { salt: string; authHash: string }): void;

  // access and setup codes (SP02 §3)
  /** Stores the hash, revokes the previous unused code of the same purpose, and sets the TTL. */
  issueCode(
    input: { id: string; purpose: CodePurpose; personId: string | null; codeHash: string },
    now: string,
  ): CodeRecord;
  /**
   * The one atomic redemption: consume the active code, or count the wrong try and kill the code on
   * the fifth. Answers the consumed code, or null when nothing was consumed — unknown, expired,
   * revoked, used or out of tries — and then nothing was written but the attempt.
   */
  redeemCode(
    purpose: CodePurpose,
    personId: string | null,
    codeHash: string,
    now: string,
  ): CodeRecord | null;

  // guild invites (0.4.5, RF-59)
  /**
   * Stores one invite. `roles` must all exist (`404` when one does not, SP03 §1) and
   * `expiresInMinutes` — null for never — becomes `expires_at` off the caller's clock. `now` is
   * both `created_at` and the base of that TTL.
   */
  createInvite(
    input: {
      id: string;
      codeHash: string;
      roles: string[];
      maxUses: number | null;
      createdBy: string;
      expiresInMinutes: number | null;
    },
    now: string,
  ): GuildInviteRecord;
  /** Every invite, newest first — revoked ones included (SP03 §2). */
  listInvites(): GuildInviteRecord[];
  /** The row behind a normalized code's hash, in any state, or null: what a preview or a join reads. */
  inviteByCodeHash(codeHash: string): GuildInviteRecord | null;
  /**
   * Sets `revoked_at` once (a second revoke is a no-op). False when no invite holds that id — the
   * route's `404` (SP03 §1).
   */
  revokeInvite(id: string, now: string): boolean;
  /**
   * Spends one use, or none: the update carries the whole rule of RF-59 (not revoked, not expired,
   * a use left) in its predicate, so two joins of the last use cannot both win. Called inside the
   * join transaction, so a failure later rolls the spend back and `uses` only counts accounts that
   * were actually created.
   */
  spendInviteUse(id: string, now: string): boolean;
  /**
   * RF-59: whether any of these role ids carries an admin role. An invite is a bearer code pasted
   * into chats, so it may never make an admin: `createInvite` refuses one, and the join re-reads
   * this because a role can be promoted to admin after the invite was created.
   */
  includesAdminRole(roleIds: string[]): boolean;

  // sessions
  createSession(
    input: { id: string; personId: string; tokenHash: string; device: Device },
    now: string,
  ): SessionRecord;
  /** A live session by token hash: revoked or expired answers null, exactly like an unknown token. */
  sessionByTokenHash(tokenHash: string, now: string): SessionRecord | null;
  /** Any state, so a route can tell `404` from `403`. */
  sessionById(id: string): SessionRecord | null;
  /** Live sessions of that person, most recently seen first. */
  sessionsOfPerson(personId: string, now: string): SessionRecord[];
  /** Sliding expiry: `last_seen_at = now`, `expires_at = now + 14 d` (SP02 §5). */
  touchSession(id: string, now: string): void;
  /** Any session (the admin path). False when there was nothing to revoke. */
  revokeSession(id: string, now: string): boolean;
  /** The person path: false when the id is not a live session of that person. */
  revokeOwnSession(personId: string, id: string, now: string): boolean;
  /** Disabling a person, or "sign out everywhere". */
  revokeSessionsOfPerson(personId: string, now: string): number;
  /**
   * RF-58: every non-disabled `member` with a live session, with the newest `last_seen_at` among
   * them, most recent first. Clients never appear; no device, OS or session id leaves.
   */
  presence(now: string): { personId: string; name: string; lastSeenAt: string }[];

  // roles
  listRoles(): Role[];
  /** Upsert; `409` when demoting the role would leave no admin. */
  saveRole(role: Role): Role;
  /** `409` when removing the role would leave no admin; `404` when it does not exist. */
  removeRole(id: string): void;
  /** Activated, non-disabled people holding an admin role: the count SP01 §2 protects. */
  adminCount(): number;

  // grants
  /** `true` grants, `false` revokes; a grant references an org entry only (SP01 §2). */
  grant(roleId: string, entryId: string, granted: boolean): void;

  // org tools
  /** True while the host has no org tool at all — the bootstrap window (SP03 §2, B8a). */
  hasOrgTools(): boolean;
  /** SP03 §2 `/v1/admin/bootstrap`: roles and tools in one write, refused once org tools exist. */
  bootstrap(input: { roles: Role[]; tools: ToolInput[] }, now: string): void;
  /** Every org entry of the guild, with its views and grants (`ord` order). */
  listOrgTools(): HostTool[];
  /** The org entries granted to one of the person's roles (`Entry.roles` filled). */
  orgToolsFor(personId: string): HostTool[];
  /** Upsert; grants and views become exactly what the input carries. */
  saveOrgTool(tool: ToolInput, now: string): HostTool;
  removeOrgTool(id: string): void;

  // personal tools and views: always filtered by owner
  listPersonalTools(personId: string): HostTool[];
  personalTool(personId: string, id: string): HostTool | null;
  /** `409` when the stored record is newer; `403` when the id belongs to someone else. */
  savePersonalTool(personId: string, tool: EntryInput, updatedAt: string): HostTool;
  removePersonalTool(personId: string, id: string, updatedAt: string): void;
  listPersonalViews(personId: string): HostView[];
  /** `403` while the entry is not one the person can see (SP01 §2). */
  savePersonalView(personId: string, view: PersonalViewInput, updatedAt: string): HostView;
  removePersonalView(personId: string, id: string, updatedAt: string): void;

  // favorites
  /** The person's ordered entry ids. */
  favorites(personId: string): string[];
  /** Replaces the ordered list; `403` on an entry the person cannot see, `409` when stale. */
  replaceFavorites(personId: string, entryIds: string[], updatedAt: string): void;

  // events
  /** Idempotent by client id: inserts what is new and answers every id the host now holds. */
  addEvents(personId: string, sessionId: string, events: EventInput[], now: string): string[];
  /** Newest first, filtered by person, tool and client-time range. */
  listEvents(filter?: HostEventFilter): HostEvent[];

  // guild icon (SP03 §2)
  /**
   * The digest the snapshot signs, or null while the guild has no icon. This is the read of every
   * `GET /v1/state`, so it never touches the bytes.
   */
  guildIconHash(): string | null;
  /** The stored bytes and their digest, or null: the answer of `GET /v1/guild/icon` (SP03 §2). */
  guildIcon(): GuildIcon | null;
  /** Stores one icon — the bytes and the digest of those exact bytes — replacing what was there. */
  setGuildIcon(icon: GuildIcon): void;
  /** Removes the icon and its digest; false when there was none. */
  clearGuildIcon(): boolean;

  // block 2: public keys (SP06 §2, SP03 §3)
  /**
   * Upsert: a reset replaces the pair — `person_keys` holds one row per person (SP01 §3). Same
   * public keys and a `privateSealed`: only the blob moves (a password change re-seals it), so
   * `created_at` stays. Different public keys: the whole row is replaced, blob included
   * (`docs/canonico.md` §22). A `null` blob on the same pair leaves the stored one alone.
   */
  savePersonKeys(personId: string, keys: PersonKeys, privateSealed: string | null, now: string): void;
  /** The stored pair, or null: what `POST /v1/shares` reads before it seals to someone. */
  personKeys(personId: string): PersonKeys | null;
  /**
   * The caller's own row, sealed private halves included: what `GET /v1/keys/private` answers. No
   * other read of this table carries the blob, so the snapshot and the sender's lookup never see it.
   */
  ownPersonKeys(personId: string): OwnPersonKeys | null;
  /** Every stored pair by person id: what `Snapshot.people` fills its public keys from (SP04 §2). */
  keysByPerson(): Map<string, PersonKeys>;

  // block 2: shares (SP06, SP03 §3)
  /**
   * Every rule of SP06 §5 for every item, then the rows, in one transaction: `403` for a recipient
   * the scope does not allow, a non-admin assignment, a non-owner update, a sender who is not a
   * live holder of an existing credential or cannot see the tool, and a share to oneself; `404` for
   * an unknown recipient or tool; `409` for a recipient without keys or a `toolId` that differs
   * from the credential's. The owner row is written only when the credential has no holder row yet
   * (SP06 §4), and it is what every later request derives the allowed scope from.
   */
  createShares(input: ShareInput, now: string): string[];
  /** The open, unexpired shares of one person, oldest first (SP04 §2's `incomingShares`). */
  openShares(personId: string, now: string): ShareRecord[];
  /** Any state of a share, so a route can tell `404` from `403` (SP03 §1). */
  shareById(id: string): ShareRecord | null;
  /**
   * Purges the `sealed` of every expired share; answers how many rows it purged (SP06 §4). E02 §6:
   * each purged row also writes a `share.expired` event for the recipient (`docs/handovers/share-events.md`).
   */
  purgeExpiredShares(now: string): number;
  /** The recipient's accept: ciphertext purged, `accepted_at` set, holder row written (SP06 §4). */
  acceptShare(id: string, personId: string, now: string): void;
  /** The recipient's decline: the same row, purged, with `declined_at` (SP06 §4). */
  declineShare(id: string, personId: string, now: string): void;
  /** Every holder row of one credential, the owner first, removed holders included (SP03 §3). */
  holdersOf(credentialId: string): HolderRecord[];
  /**
   * SP06 §5: the owner holder (or an admin) sets the scope of the credential. Every holder row
   * takes it, and every later share derives its allowed scope from the owner row. `403` for anyone
   * else, `404` while the credential has no holder row at all.
   */
  setCredentialScope(input: {
    credentialId: string;
    byId: string;
    admin: boolean;
    scope: ShareScope;
  }): void;
  /** Credentials the person holds with a live row; every credential of the guild, if `all` (SP04 §2). */
  heldCredentials(personId: string, all: boolean): string[];
  /** The owner's revocation of one holder: `removed_at` on a live row (SP06 §4, RF-48). */
  removeHolder(
    input: { credentialId: string; personId: string; byId: string; admin: boolean },
    now: string,
  ): void;
  /**
   * RF-48: the owner holder or an admin records that a new secret was saved for that credential
   * (`rotated_at` on the owner row). It is the explicit signal `rotationPending` reads beside the
   * latest `update` share, because an update fan-out has no recipient to clear the state through
   * when the last non-owner holder was revoked. `403` for anyone else, `404` for an unowned id.
   */
  markRotated(input: { credentialId: string; byId: string; admin: boolean }, now: string): void;
  /** The credentials the person owns with a revoked holder not followed by a save (SP04 §2, RF-48). */
  rotationPending(personId: string): string[];

  // block 2: assignments (SP06 §4, SP03 §3)
  /** `true` upserts, `false` removes: one assignment per credential and role (SP01 §3). */
  saveAssignment(
    input: {
      credentialId: string;
      roleId: string;
      toolId: string;
      assignedBy: string;
      assigned: boolean;
    },
    now: string,
  ): void;
  /** Every member of an assigned role still without a live copy, the assigner excluded (RF-47). */
  missingCopies(): MissingCopyRecord[];
}

// ---------------------------------------------------------------- rows

type Bind = string | number | null;

const PERSON_COLUMNS = `p.id AS id, p.email AS email, p.name AS name, p.kind AS kind,
  p.created_at AS createdAt, p.activated_at AS activatedAt, p.disabled_at AS disabledAt,
  pr.role_id AS roleId, r.admin AS roleAdmin`;

const PERSON_JOIN = `FROM people p
  LEFT JOIN person_roles pr ON pr.person_id = p.id
  LEFT JOIN roles r ON r.id = pr.role_id`;

interface PersonRow {
  id: string;
  email: string;
  name: string;
  kind: string;
  createdAt: string;
  activatedAt: string | null;
  disabledAt: string | null;
  roleId: string | null;
  roleAdmin: number | null;
}

const ENTRY_COLUMNS = `e.id AS id, e.scope AS scope, e.owner_id AS ownerId, e.title AS title,
  e.category AS category, e.url AS url, e.icon AS icon, e.ord AS "order", e.auth AS auth,
  e.active AS active, e.updated_at AS updatedAt, g.role_id AS roleId`;

interface EntryRow {
  id: string;
  scope: string;
  ownerId: string | null;
  title: string;
  category: string | null;
  url: string;
  icon: string | null;
  order: number;
  auth: string | null;
  active: number;
  updatedAt: string;
  roleId: string | null;
}

const VIEW_COLUMNS = `v.id AS id, v.entry_id AS entryId, v.scope AS scope, v.owner_id AS ownerId,
  v.label AS label, v.url AS url, v.mode AS mode, v.ord AS ord, v.updated_at AS updatedAt`;

interface ViewRow {
  id: string;
  entryId: string;
  scope: string;
  ownerId: string | null;
  label: string;
  url: string;
  mode: string;
  ord: number;
  updatedAt: string;
}

const SESSION_COLUMNS = `id, person_id AS personId, device_name AS deviceName, os,
  app_version AS appVersion, created_at AS createdAt, last_seen_at AS lastSeenAt,
  expires_at AS expiresAt, revoked_at AS revokedAt`;

interface SessionRow {
  id: string;
  personId: string;
  deviceName: string;
  os: string;
  appVersion: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

const CODE_COLUMNS = `id, purpose, person_id AS personId, attempts, created_at AS createdAt,
  expires_at AS expiresAt, used_at AS usedAt, revoked_at AS revokedAt`;

interface CodeRow {
  id: string;
  purpose: string;
  personId: string | null;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

/** `guild_invites` (migration 5): `roles` is the JSON array of role ids, read and written whole. */
const INVITE_COLUMNS = `id, roles, max_uses AS maxUses, uses, created_by AS createdBy,
  created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt`;

interface InviteRow {
  id: string;
  roles: string;
  maxUses: number | null;
  uses: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

const EVENT_COLUMNS = `id, person_id AS personId, session_id AS sessionId, at, kind,
  tool_id AS toolId, url, result, detail, received_at AS receivedAt`;

interface EventRow {
  id: string;
  personId: string;
  sessionId: string;
  at: string;
  kind: string;
  toolId: string | null;
  url: string | null;
  result: string | null;
  detail: string | null;
  receivedAt: string;
}

const SHARE_COLUMNS = `id, credential_id AS credentialId, from_id AS fromId, to_id AS toId,
  tool_id AS toolId, scope, kind, sealed, created_at AS createdAt, expires_at AS expiresAt,
  accepted_at AS acceptedAt, declined_at AS declinedAt, purged_at AS purgedAt`;

interface ShareRow {
  id: string;
  credentialId: string;
  fromId: string;
  toId: string;
  toolId: string;
  scope: string;
  kind: string;
  sealed: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  purgedAt: string | null;
}

const HOLDER_COLUMNS = `h.person_id AS personId, p.name AS name, h.tool_id AS toolId,
  h.owner AS owner, h.scope AS scope, h.since AS since, h.removed_at AS removedAt`;

interface HolderRow {
  personId: string;
  name: string;
  toolId: string;
  owner: number;
  scope: string;
  since: string;
  removedAt: string | null;
}

/** `email TEXT NOT NULL UNIQUE` holds the lowercased, trimmed form (SP01 §2). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/** `?` placeholders for a list of binds. */
function marks(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * RF-59: whether an invite still redeems — not revoked, not expired, a use left. It is the read side
 * of the rule `spendInviteUse` carries in its SQL predicate (the one that decides two joins racing
 * for the last use), kept beside it so the host's answer to a preview and to a join cannot drift.
 */
export function inviteRedeemable(invite: GuildInviteRecord, now: string): boolean {
  return (
    invite.revokedAt === null &&
    (invite.expiresAt === null || invite.expiresAt > now) &&
    (invite.maxUses === null || invite.uses < invite.maxUses)
  );
}

// ---------------------------------------------------------------- implementation

export function createRepo(db: Database): Repo {
  const runInTransaction = <T>(work: () => T): T => db.transaction(work)();

  /** SP01 §2: an entry a person can see — their own personal entry, or an org entry granted to one
   *  of their roles. The fragment binds the person id twice. */
  const visibleTo = (person: string): string => `(
    (e.scope = 'personal' AND e.owner_id = ${person})
    OR (e.scope = 'org' AND EXISTS (
          SELECT 1 FROM person_roles pr JOIN grants gr ON gr.role_id = pr.role_id
           WHERE pr.person_id = ${person} AND gr.entry_id = e.id))
  )`;

  /** SP01 §2: favorites only on entries their person can see — dropping the rest. */
  function pruneInvisibleFavorites(): number {
    return db
      .query(
        `DELETE FROM favorites WHERE NOT EXISTS (
           SELECT 1 FROM entries e WHERE e.id = favorites.entry_id
             AND ((e.scope = 'personal' AND e.owner_id = favorites.person_id)
                  OR (e.scope = 'org' AND EXISTS (
                        SELECT 1 FROM person_roles pr JOIN grants gr ON gr.role_id = pr.role_id
                         WHERE pr.person_id = favorites.person_id AND gr.entry_id = e.id))))`,
      )
      .run().changes;
  }

  function buildPeople(rows: PersonRow[]): HostPerson[] {
    const people = new Map<string, HostPerson>();
    for (const row of rows) {
      let person = people.get(row.id);
      if (person === undefined) {
        person = {
          id: row.id,
          email: row.email,
          name: row.name,
          kind: row.kind as PersonKind,
          roles: [],
          admin: false,
          createdAt: row.createdAt,
          activatedAt: row.activatedAt,
          disabledAt: row.disabledAt,
        };
        people.set(row.id, person);
      }
      if (row.roleId !== null) {
        person.roles.push(row.roleId);
        if (row.roleAdmin === 1) person.admin = true;
      }
    }
    return [...people.values()];
  }

  function readPerson(where: string, params: Bind[]): HostPerson | null {
    const rows = db
      .query<PersonRow, Bind[]>(
        `SELECT ${PERSON_COLUMNS} ${PERSON_JOIN} WHERE ${where} ORDER BY pr.role_id`,
      )
      .all(...params);
    return buildPeople(rows)[0] ?? null;
  }

  function assertPersonExists(personId: string): void {
    if (db.query<{ id: string }, [string]>('SELECT id FROM people WHERE id = ?').get(personId) === null) {
      throw new NotFoundError('unknown person');
    }
  }

  function assertRolesExist(ids: string[]): void {
    for (const id of ids) {
      if (db.query<{ id: string }, [string]>('SELECT id FROM roles WHERE id = ?').get(id) === null) {
        throw new NotFoundError('unknown role');
      }
    }
  }

  /** RF-59: one query for "would these roles make an admin" — read by `createInvite` and the join. */
  function includesAdminRole(roleIds: string[]): boolean {
    if (roleIds.length === 0) return false;
    const row = db
      .query<{ n: number }, Bind[]>(
        `SELECT COUNT(*) AS n FROM roles WHERE admin = 1 AND id IN (${marks(roleIds.length)})`,
      )
      .get(...roleIds);
    return (row?.n ?? 0) > 0;
  }

  /** Activated, non-disabled people holding an admin role (SP01 §2). */
  function countAdmins(): number {
    const row = db
      .query<{ n: number }, []>(
        `SELECT COUNT(DISTINCT p.id) AS n FROM people p
           JOIN person_roles pr ON pr.person_id = p.id
           JOIN roles r ON r.id = pr.role_id
          WHERE r.admin = 1 AND p.activated_at IS NOT NULL AND p.disabled_at IS NULL`,
      )
      .get();
    return row?.n ?? 0;
  }

  /**
   * The last-admin guard of SP01 §2: once an admin is activated, the write that would leave none is
   * refused and the whole transaction rolls back. Before the first admin exists the guard is silent,
   * which is what lets an empty host be built.
   */
  function guarded<T>(write: () => T): T {
    return runInTransaction(() => {
      const before = countAdmins();
      const result = write();
      if (before > 0 && countAdmins() === 0) throw new ConflictError('the last admin cannot be removed');
      return result;
    });
  }

  function toRole(row: { id: string; name: string; admin: number }): Role {
    return { id: row.id, name: row.name, admin: row.admin === 1 };
  }

  function readRole(id: string): Role | null {
    const row = db
      .query<{ id: string; name: string; admin: number }, [string]>(
        'SELECT id, name, admin FROM roles WHERE id = ?',
      )
      .get(id);
    return row === null ? null : toRole(row);
  }

  function toSession(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      personId: row.personId,
      device: { name: row.deviceName, os: row.os, appVersion: row.appVersion },
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  function readSession(id: string): SessionRecord | null {
    const row = db
      .query<SessionRow, [string]>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id);
    return row === null ? null : toSession(row);
  }

  function toCode(row: CodeRow): CodeRecord {
    return {
      id: row.id,
      purpose: row.purpose as CodePurpose,
      personId: row.personId,
      attempts: row.attempts,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      revokedAt: row.revokedAt,
    };
  }

  function readCode(id: string): CodeRecord | null {
    const row = db
      .query<CodeRow, [string]>(`SELECT ${CODE_COLUMNS} FROM access_codes WHERE id = ?`)
      .get(id);
    return row === null ? null : toCode(row);
  }

  function toView(row: ViewRow): HostView {
    return {
      id: row.id,
      entryId: row.entryId,
      scope: row.scope as EntryScope,
      ownerId: row.ownerId,
      label: row.label,
      url: row.url,
      mode: row.mode as ViewMode,
      ord: row.ord,
      updatedAt: row.updatedAt,
    };
  }

  /** Reads entries and the views that belong to them, in one shape: the view query repeats the
   *  entries' predicate (both alias `entries` as `e`), so an entry that is filtered out takes its
   *  views with it. */
  function readEntries(
    entrySql: string,
    entryParams: Bind[],
    viewSql: string,
    viewParams: Bind[],
  ): HostTool[] {
    const tools = new Map<string, HostTool>();
    for (const row of db.query<EntryRow, Bind[]>(entrySql).all(...entryParams)) {
      let tool = tools.get(row.id);
      if (tool === undefined) {
        tool = {
          id: row.id,
          scope: row.scope as EntryScope,
          ownerId: row.ownerId,
          title: row.title,
          category: row.category,
          url: row.url,
          icon: row.icon,
          order: row.order,
          roles: [],
          auth: row.auth === null ? null : (JSON.parse(row.auth) as AuthOverride),
          active: row.active === 1,
          updatedAt: row.updatedAt,
          views: [],
        };
        tools.set(row.id, tool);
      }
      if (row.roleId !== null) tool.roles.push(row.roleId);
    }
    if (tools.size === 0) return [];
    for (const row of db.query<ViewRow, Bind[]>(viewSql).all(...viewParams)) {
      tools.get(row.entryId)?.views.push(toView(row));
    }
    return [...tools.values()];
  }

  function listOrgTools(where = '', params: Bind[] = []): HostTool[] {
    return readEntries(
      `SELECT ${ENTRY_COLUMNS} FROM entries e LEFT JOIN grants g ON g.entry_id = e.id
        WHERE e.scope = 'org' ${where} ORDER BY e.ord, e.id, g.role_id`,
      params,
      `SELECT ${VIEW_COLUMNS} FROM views v JOIN entries e ON e.id = v.entry_id
        WHERE e.scope = 'org' AND v.scope = 'org' ${where} ORDER BY v.entry_id, v.ord, v.id`,
      params,
    );
  }

  function listPersonalTools(personId: string, where = '', params: Bind[] = []): HostTool[] {
    return readEntries(
      `SELECT ${ENTRY_COLUMNS} FROM entries e LEFT JOIN grants g ON g.entry_id = e.id
        WHERE e.scope = 'personal' AND e.owner_id = ? ${where} ORDER BY e.ord, e.id`,
      [personId, ...params],
      `SELECT ${VIEW_COLUMNS} FROM views v JOIN entries e ON e.id = v.entry_id
        WHERE v.scope = 'personal' AND v.owner_id = ? AND e.scope = 'personal' AND e.owner_id = ?
        ${where} ORDER BY v.entry_id, v.ord, v.id`,
      [personId, personId, ...params],
    );
  }

  /** `scope`, `owner_id` and `updated_at` of one entry: what the write paths guard on. */
  function readEntryState(
    id: string,
  ): { scope: EntryScope; ownerId: string | null; updatedAt: string } | null {
    const row = db
      .query<{ scope: string; ownerId: string | null; updatedAt: string }, [string]>(
        'SELECT scope, owner_id AS ownerId, updated_at AS updatedAt FROM entries WHERE id = ?',
      )
      .get(id);
    return row === null
      ? null
      : { scope: row.scope as EntryScope, ownerId: row.ownerId, updatedAt: row.updatedAt };
  }

  function readViewState(
    id: string,
  ): { scope: EntryScope; ownerId: string | null; updatedAt: string } | null {
    const row = db
      .query<{ scope: string; ownerId: string | null; updatedAt: string }, [string]>(
        'SELECT scope, owner_id AS ownerId, updated_at AS updatedAt FROM views WHERE id = ?',
      )
      .get(id);
    return row === null
      ? null
      : { scope: row.scope as EntryScope, ownerId: row.ownerId, updatedAt: row.updatedAt };
  }

  function readPersonalView(personId: string, id: string): HostView | null {
    const row = db
      .query<ViewRow, Bind[]>(
        `SELECT ${VIEW_COLUMNS} FROM views v
          WHERE v.scope = 'personal' AND v.owner_id = ? AND v.id = ?`,
      )
      .get(personId, id);
    return row === null ? null : toView(row);
  }

  function toEvent(row: EventRow): HostEvent {
    return {
      id: row.id,
      personId: row.personId,
      sessionId: row.sessionId,
      at: row.at,
      kind: row.kind,
      toolId: row.toolId,
      url: row.url,
      result: row.result,
      detail: row.detail,
      receivedAt: row.receivedAt,
    };
  }

  // ---------------------------------------------------------------- methods

  function createPerson(
    input: { id: string; email: string; name: string; kind?: PersonKind; roles?: string[] },
    now: string,
  ): HostPerson {
    const email = normalizeEmail(input.email);
    const roles = [...new Set(input.roles ?? [])];
    return runInTransaction(() => {
      if (db.query<{ id: string }, [string]>('SELECT id FROM people WHERE email = ?').get(email) !== null) {
        throw new ConflictError('email taken');
      }
      assertRolesExist(roles);
      db.query('INSERT INTO people (id, email, name, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(
        input.id,
        email,
        input.name,
        input.kind ?? 'member',
        now,
      );
      const link = db.query('INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)');
      for (const role of roles) link.run(input.id, role);
      return readPerson('p.id = ?', [input.id]) as HostPerson;
    });
  }

  function personById(id: string): HostPerson | null {
    return readPerson('p.id = ?', [id]);
  }

  function personByEmail(email: string): HostPerson | null {
    return readPerson('p.email = ?', [normalizeEmail(email)]);
  }

  function personAuthByEmail(email: string): PersonAuth | null {
    const row = db
      .query<{ id: string; salt: string | null; authHash: string | null }, [string]>(
        'SELECT id, salt, auth_hash AS authHash FROM people WHERE email = ?',
      )
      .get(normalizeEmail(email));
    if (row === null) return null;
    const person = personById(row.id);
    if (person === null) return null;
    return { person, salt: row.salt, authHash: row.authHash };
  }

  function listPeople(): HostPerson[] {
    return buildPeople(
      db
        .query<PersonRow, []>(
          `SELECT ${PERSON_COLUMNS} ${PERSON_JOIN} ORDER BY p.name COLLATE NOCASE, p.email, pr.role_id`,
        )
        .all(),
    );
  }

  function renamePerson(personId: string, name: string): HostPerson {
    const changes = db.query('UPDATE people SET name = ? WHERE id = ?').run(name, personId).changes;
    if (changes !== 1) throw new NotFoundError('unknown person');
    return readPerson('p.id = ?', [personId]) as HostPerson;
  }

  function setRoles(personId: string, roles: string[]): HostPerson {
    const wanted = [...new Set(roles)];
    return guarded(() => {
      assertPersonExists(personId);
      assertRolesExist(wanted);
      db.query('DELETE FROM person_roles WHERE person_id = ?').run(personId);
      const link = db.query('INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)');
      for (const role of wanted) link.run(personId, role);
      pruneInvisibleFavorites();
      return readPerson('p.id = ?', [personId]) as HostPerson;
    });
  }

  function setDisabled(personId: string, disabled: boolean, now: string): HostPerson {
    return guarded(() => {
      assertPersonExists(personId);
      db.query('UPDATE people SET disabled_at = ? WHERE id = ?').run(disabled ? now : null, personId);
      if (disabled) revokeSessionsOfPerson(personId, now);
      return readPerson('p.id = ?', [personId]) as HostPerson;
    });
  }

  function activatePerson(
    personId: string,
    auth: { salt: string; authHash: string },
    now: string,
  ): void {
    const changes = db
      .query(
        `UPDATE people SET salt = ?, auth_hash = ?, activated_at = COALESCE(activated_at, ?)
          WHERE id = ?`,
      )
      .run(auth.salt, auth.authHash, now, personId).changes;
    if (changes !== 1) throw new NotFoundError('unknown person');
  }

  function changeAuth(personId: string, auth: { salt: string; authHash: string }): void {
    const changes = db
      .query('UPDATE people SET salt = ?, auth_hash = ? WHERE id = ?')
      .run(auth.salt, auth.authHash, personId).changes;
    if (changes !== 1) throw new NotFoundError('unknown person');
  }

  function issueCode(
    input: { id: string; purpose: CodePurpose; personId: string | null; codeHash: string },
    now: string,
  ): CodeRecord {
    const expiresAt = addMs(now, CODE_TTL_MS[input.purpose]);
    return runInTransaction(() => {
      // SP02 §3: a new code revokes the previous unused one — the person's, or the setup code's.
      const scope = input.personId === null ? 'person_id IS NULL' : 'person_id = ?';
      const params: Bind[] = input.personId === null ? [now, input.purpose] : [now, input.purpose, input.personId];
      db.query(
        `UPDATE access_codes SET revoked_at = ?
          WHERE purpose = ? AND used_at IS NULL AND revoked_at IS NULL AND ${scope}`,
      ).run(...params);
      db.query(
        `INSERT INTO access_codes (id, purpose, person_id, code_hash, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.purpose, input.personId, input.codeHash, now, expiresAt);
      return readCode(input.id) as CodeRecord;
    });
  }

  function redeemCode(
    purpose: CodePurpose,
    personId: string | null,
    codeHash: string,
    now: string,
  ): CodeRecord | null {
    return runInTransaction(() => {
      const scope = personId === null ? 'person_id IS NULL' : 'person_id = ?';
      const params: Bind[] = personId === null ? [purpose] : [purpose, personId];
      const row = db
        .query<{ id: string; attempts: number; expiresAt: string; codeHash: string }, Bind[]>(
          `SELECT id, attempts, expires_at AS expiresAt, code_hash AS codeHash FROM access_codes
            WHERE purpose = ? AND ${scope} AND used_at IS NULL AND revoked_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(...params);
      if (row === null) return null;

      // Expired: dead by its own `expires_at` (SP02 §3), and nothing is written for it.
      if (row.expiresAt <= now) return null;

      if (row.codeHash !== codeHash) {
        const attempts = row.attempts + 1;
        db.query(
          `UPDATE access_codes SET attempts = ?,
             revoked_at = CASE WHEN ? >= ? THEN ? ELSE revoked_at END
           WHERE id = ?`,
        ).run(attempts, attempts, MAX_CODE_ATTEMPTS, now, row.id);
        return null;
      }

      // Consumed once: the predicate of the update is the guard, and the row was read in the same
      // transaction (SP02 §3, RF-32).
      const consumed = db
        .query(
          `UPDATE access_codes SET used_at = ?
            WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now, row.id).changes;
      if (consumed !== 1) return null;
      return readCode(row.id);
    });
  }

  // ---------------------------------------------------------------- guild invites (0.4.5, RF-59)

  function toInvite(row: InviteRow): GuildInviteRecord {
    return {
      id: row.id,
      roles: JSON.parse(row.roles) as string[],
      maxUses: row.maxUses,
      uses: row.uses,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  /** Any state, exactly like `shareById`: a route that must tell 404 from 401 reads it and decides. */
  function inviteByCodeHash(codeHash: string): GuildInviteRecord | null {
    const row = db
      .query<InviteRow, [string]>(`SELECT ${INVITE_COLUMNS} FROM guild_invites WHERE code_hash = ?`)
      .get(codeHash);
    return row === null ? null : toInvite(row);
  }

  function createInvite(
    input: {
      id: string;
      codeHash: string;
      roles: string[];
      maxUses: number | null;
      createdBy: string;
      expiresInMinutes: number | null;
    },
    now: string,
  ): GuildInviteRecord {
    // SP03 §2: a role the guild does not have is the 404 of the whole write, and no invite is
    // stored — one transaction, as every code and person write of this file is. `roles` keeps the
    // order the admin chose: it is the order the person's roles will have.
    const roles = [...new Set(input.roles)];
    const expiresAt =
      input.expiresInMinutes === null ? null : addMs(now, input.expiresInMinutes * 60_000);
    return runInTransaction(() => {
      assertRolesExist(roles);
      // RF-59: an invite is a bearer code pasted into chats, so it never makes an admin — the role
      // list an invite carries is member material, and promoting a person stays
      // `PATCH /v1/admin/people/:id` (SP03 §2).
      if (includesAdminRole(roles)) {
        throw new RepoError('an invite cannot grant an admin role', 400);
      }
      db.query(
        `INSERT INTO guild_invites
           (id, code_hash, roles, max_uses, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.codeHash,
        JSON.stringify(roles),
        input.maxUses,
        input.createdBy,
        now,
        expiresAt,
      );
      const created = db
        .query<InviteRow, [string]>(`SELECT ${INVITE_COLUMNS} FROM guild_invites WHERE id = ?`)
        .get(input.id);
      return toInvite(created as InviteRow);
    });
  }

  function listInvites(): GuildInviteRecord[] {
    return db
      .query<InviteRow, []>(
        `SELECT ${INVITE_COLUMNS} FROM guild_invites ORDER BY created_at DESC, id DESC`,
      )
      .all()
      .map(toInvite);
  }

  function revokeInvite(id: string, now: string): boolean {
    // The first revoke stamps the instant; a later one leaves it. Either way the row exists, and an
    // id nobody holds changes nothing and answers false (the route's 404, SP03 §1).
    return (
      db
        .query('UPDATE guild_invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
        .run(now, id).changes === 1
    );
  }

  function spendInviteUse(id: string, now: string): boolean {
    // RF-59: the three rules live in the predicate, so the check and the spend are one statement —
    // two joins racing for the last use cannot both read "one left" and both write (SP01 §1's one
    // writer, plus this guard, is what makes the last use go to exactly one of them). The read side
    // of the same rule is `inviteRedeemable`.
    return (
      db
        .query(
          `UPDATE guild_invites SET uses = uses + 1
            WHERE id = ? AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND (max_uses IS NULL OR uses < max_uses)`,
        )
        .run(id, now).changes === 1
    );
  }

  function createSession(
    input: { id: string; personId: string; tokenHash: string; device: Device },
    now: string,
  ): SessionRecord {
    return runInTransaction(() => {
      db.query(
        `INSERT INTO sessions
           (id, person_id, token_hash, device_name, os, app_version, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.personId,
        input.tokenHash,
        input.device.name,
        input.device.os,
        input.device.appVersion,
        now,
        now,
        addMs(now, SESSION_TTL_MS),
      );
      return readSession(input.id) as SessionRecord;
    });
  }

  function sessionByTokenHash(tokenHash: string, now: string): SessionRecord | null {
    const row = db
      .query<SessionRow, [string, string]>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
          WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, now);
    return row === null ? null : toSession(row);
  }

  function sessionById(id: string): SessionRecord | null {
    return readSession(id);
  }

  function sessionsOfPerson(personId: string, now: string): SessionRecord[] {
    return db
      .query<SessionRow, [string, string]>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
          WHERE person_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY last_seen_at DESC, id`,
      )
      .all(personId, now)
      .map(toSession);
  }

  function touchSession(id: string, now: string): void {
    db.query(
      `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL`,
    ).run(now, addMs(now, SESSION_TTL_MS), id);
  }

  function revokeSession(id: string, now: string): boolean {
    return (
      db.query('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)
        .changes === 1
    );
  }

  function revokeOwnSession(personId: string, id: string, now: string): boolean {
    return (
      db
        .query(
          `UPDATE sessions SET revoked_at = ?
            WHERE id = ? AND person_id = ? AND revoked_at IS NULL`,
        )
        .run(now, id, personId).changes === 1
    );
  }

  function revokeSessionsOfPerson(personId: string, now: string): number {
    return db
      .query('UPDATE sessions SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL')
      .run(now, personId).changes;
  }

  function presence(now: string): { personId: string; name: string; lastSeenAt: string }[] {
    return db
      .query<{ personId: string; name: string; lastSeenAt: string }, [string]>(
        `SELECT p.id AS personId, p.name AS name, MAX(s.last_seen_at) AS lastSeenAt
           FROM people p JOIN sessions s ON s.person_id = p.id
          WHERE p.kind = 'member' AND p.disabled_at IS NULL
            AND s.revoked_at IS NULL AND s.expires_at > ?
          GROUP BY p.id, p.name
          ORDER BY lastSeenAt DESC, p.id`,
      )
      .all(now);
  }

  function listRoles(): Role[] {
    return db
      .query<{ id: string; name: string; admin: number }, []>(
        'SELECT id, name, admin FROM roles ORDER BY name COLLATE NOCASE, id',
      )
      .all()
      .map(toRole);
  }

  function saveRole(role: Role): Role {
    return guarded(() => {
      db.query(
        `INSERT INTO roles (id, name, admin) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, admin = excluded.admin`,
      ).run(role.id, role.name, role.admin ? 1 : 0);
      return readRole(role.id) as Role;
    });
  }

  function removeRole(id: string): void {
    guarded(() => {
      // `changes` counts the rows an `ON DELETE CASCADE` takes with the role, so the test is
      // "something went" — zero means the role was not there.
      if (db.query('DELETE FROM roles WHERE id = ?').run(id).changes < 1) {
        throw new NotFoundError('unknown role');
      }
      pruneInvisibleFavorites();
    });
  }

  function grant(roleId: string, entryId: string, granted: boolean): void {
    runInTransaction(() => {
      if (readRole(roleId) === null) throw new NotFoundError('unknown role');
      const entry = readEntryState(entryId);
      if (entry === null) throw new NotFoundError('unknown entry');
      if (entry.scope !== 'org') throw new ForbiddenError('grants apply to org tools only');
      if (granted) {
        db.query(
          'INSERT INTO grants (role_id, entry_id) VALUES (?, ?) ON CONFLICT(role_id, entry_id) DO NOTHING',
        ).run(roleId, entryId);
      } else {
        db.query('DELETE FROM grants WHERE role_id = ? AND entry_id = ?').run(roleId, entryId);
        pruneInvisibleFavorites();
      }
    });
  }

  function hasOrgTools(): boolean {
    return (
      db.query<{ id: string }, []>("SELECT id FROM entries WHERE scope = 'org' LIMIT 1").get() !== null
    );
  }

  function orgToolsFor(personId: string): HostTool[] {
    return listOrgTools(
      `AND EXISTS (SELECT 1 FROM person_roles pr JOIN grants gr ON gr.role_id = pr.role_id
                    WHERE pr.person_id = ? AND gr.entry_id = e.id)`,
      [personId],
    );
  }

  function saveOrgTool(tool: ToolInput, now: string): HostTool {
    const roles = [...new Set(tool.roles)];
    return runInTransaction(() => {
      assertRolesExist(roles);
      const existing = readEntryState(tool.id);
      if (existing !== null && existing.scope !== 'org') throw new ForbiddenError('not yours');

      db.query(
        `INSERT INTO entries (id, scope, owner_id, title, category, url, icon, ord, auth, active, updated_at)
         VALUES (?, 'org', NULL, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, category = excluded.category,
           url = excluded.url, icon = excluded.icon,
           ord = excluded.ord, auth = excluded.auth, active = excluded.active, updated_at = excluded.updated_at`,
      ).run(
        tool.id,
        tool.title,
        tool.category ?? null,
        tool.url,
        tool.icon,
        tool.order,
        tool.auth === null ? null : JSON.stringify(tool.auth),
        tool.active ? 1 : 0,
        now,
      );

      // Grants: exactly the roles the entry carries (SP01 §2).
      db.query('DELETE FROM grants WHERE entry_id = ?').run(tool.id);
      const linkGrant = db.query('INSERT INTO grants (role_id, entry_id) VALUES (?, ?)');
      for (const roleId of roles) linkGrant.run(roleId, tool.id);

      // Views: exactly the list, in the order it arrives (`ord` is the display order).
      const keep = tool.views.map((view) => view.id);
      if (keep.length === 0) {
        db.query("DELETE FROM views WHERE entry_id = ? AND scope = 'org'").run(tool.id);
      } else {
        db.query(
          `DELETE FROM views WHERE entry_id = ? AND scope = 'org' AND id NOT IN (${marks(keep.length)})`,
        ).run(tool.id, ...keep);
      }
      const saveView = db.query(
        `INSERT INTO views (id, entry_id, scope, owner_id, label, url, mode, ord, updated_at)
         VALUES (?, ?, 'org', NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET entry_id = excluded.entry_id, label = excluded.label,
           url = excluded.url, mode = excluded.mode, ord = excluded.ord, updated_at = excluded.updated_at`,
      );
      tool.views.forEach((view, index) => {
        const owned = readViewState(view.id);
        if (owned !== null && owned.scope !== 'org') throw new ForbiddenError('not yours');
        saveView.run(view.id, tool.id, view.label, view.url, view.mode, index, now);
      });

      return (listOrgTools('AND e.id = ?', [tool.id])[0] as HostTool);
    });
  }

  function removeOrgTool(id: string): void {
    // F2: a share row keeps its tool. `shares.tool_id` is a plain reference (migration 2, no
    // `ON DELETE`) — the guard that stops a share from outliving its tool — so the parent delete
    // would abort inside SQLite and the route would answer `500 internal error`. Refusing first
    // keeps the guard and gives the caller a typed answer instead.
    const shared = db
      .query<{ one: number }, [string]>('SELECT 1 AS one FROM shares WHERE tool_id = ?')
      .get(id);
    if (shared !== null) throw new ConflictError('a shared credential keeps the tool');

    // As in `removeRole`: the cascade of views, grants and favorites is counted too.
    const changes = db.query("DELETE FROM entries WHERE id = ? AND scope = 'org'").run(id).changes;
    if (changes < 1) throw new NotFoundError('unknown tool');
  }

  function bootstrap(input: { roles: Role[]; tools: ToolInput[] }, now: string): void {
    runInTransaction(() => {
      // SP03 §2, B8a: the bootstrap window closes with the first org tool.
      if (hasOrgTools()) throw new ConflictError('the host already has org tools');
      for (const role of input.roles) saveRole(role);
      for (const tool of input.tools) saveOrgTool(tool, now);
    });
  }

  function personalTool(personId: string, id: string): HostTool | null {
    return listPersonalTools(personId, 'AND e.id = ?', [id])[0] ?? null;
  }

  function savePersonalTool(personId: string, tool: EntryInput, updatedAt: string): HostTool {
    return runInTransaction(() => {
      const existing = readEntryState(tool.id);
      if (existing !== null && (existing.scope !== 'personal' || existing.ownerId !== personId)) {
        throw new ForbiddenError('not yours');
      }
      if (existing !== null && existing.updatedAt > updatedAt) throw new ConflictError('stale updatedAt');

      // RF-62: a personal tool carries no category — it has its own group in the display — and a
      // category a body declares is ignored here: the statement names no `category` column, so the
      // row keeps `NULL`. The personal route does not declare the field either (`routes/person.ts`).
      db.query(
        `INSERT INTO entries (id, scope, owner_id, title, url, icon, ord, auth, active, updated_at)
         VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url, icon = excluded.icon,
           ord = excluded.ord, auth = excluded.auth, active = excluded.active, updated_at = excluded.updated_at`,
      ).run(
        tool.id,
        personId,
        tool.title,
        tool.url,
        tool.icon,
        tool.order,
        tool.auth === null ? null : JSON.stringify(tool.auth),
        tool.active ? 1 : 0,
        updatedAt,
      );
      return personalTool(personId, tool.id) as HostTool;
    });
  }

  function removePersonalTool(personId: string, id: string, updatedAt: string): void {
    runInTransaction(() => {
      const existing = readEntryState(id);
      if (existing === null) throw new NotFoundError('unknown tool');
      if (existing.scope !== 'personal' || existing.ownerId !== personId) {
        throw new ForbiddenError('not yours');
      }
      if (existing.updatedAt > updatedAt) throw new ConflictError('stale updatedAt');
      db.query('DELETE FROM entries WHERE id = ?').run(id);
    });
  }

  function listPersonalViews(personId: string): HostView[] {
    return db
      .query<ViewRow, [string]>(
        `SELECT ${VIEW_COLUMNS} FROM views v
          WHERE v.scope = 'personal' AND v.owner_id = ?
          ORDER BY v.entry_id, v.ord, v.id`,
      )
      .all(personId)
      .map(toView);
  }

  function savePersonalView(
    personId: string,
    view: PersonalViewInput,
    updatedAt: string,
  ): HostView {
    return runInTransaction(() => {
      // SP01 §2: a personal view hangs under an entry its owner can see.
      const visible = db
        .query<{ id: string }, Bind[]>(
          `SELECT e.id AS id FROM entries e WHERE e.id = ? AND ${visibleTo('?')}`,
        )
        .get(view.entryId, personId, personId);
      if (visible === null) throw new ForbiddenError('not yours');
      const existing = readViewState(view.id);
      if (existing !== null && (existing.scope !== 'personal' || existing.ownerId !== personId)) {
        throw new ForbiddenError('not yours');
      }
      if (existing !== null && existing.updatedAt > updatedAt) throw new ConflictError('stale updatedAt');

      db.query(
        `INSERT INTO views (id, entry_id, scope, owner_id, label, url, mode, ord, updated_at)
         VALUES (?, ?, 'personal', ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET entry_id = excluded.entry_id, label = excluded.label,
           url = excluded.url, mode = excluded.mode, updated_at = excluded.updated_at`,
      ).run(view.id, view.entryId, personId, view.label, view.url, view.mode, updatedAt);

      return readPersonalView(personId, view.id) as HostView;
    });
  }

  function removePersonalView(personId: string, id: string, updatedAt: string): void {
    runInTransaction(() => {
      const existing = readViewState(id);
      if (existing === null) throw new NotFoundError('unknown view');
      if (existing.scope !== 'personal' || existing.ownerId !== personId) {
        throw new ForbiddenError('not yours');
      }
      if (existing.updatedAt > updatedAt) throw new ConflictError('stale updatedAt');
      db.query('DELETE FROM views WHERE id = ?').run(id);
    });
  }

  function favorites(personId: string): string[] {
    return db
      .query<{ entryId: string }, [string]>(
        'SELECT entry_id AS entryId FROM favorites WHERE person_id = ? ORDER BY ord, entry_id',
      )
      .all(personId)
      .map((row) => row.entryId);
  }

  function replaceFavorites(personId: string, entryIds: string[], updatedAt: string): void {
    const ids = [...new Set(entryIds)];
    runInTransaction(() => {
      if (ids.length > 0) {
        // SP01 §2: a favorite references an entry its person can see.
        const visible = db
          .query<{ id: string }, Bind[]>(
            `SELECT e.id AS id FROM entries e WHERE e.id IN (${marks(ids.length)}) AND ${visibleTo('?')}`,
          )
          .all(...ids, personId, personId);
        if (visible.length !== ids.length) throw new ForbiddenError('not yours');
      }
      const current = db
        .query<{ updatedAt: string | null }, [string]>(
          'SELECT MAX(updated_at) AS updatedAt FROM favorites WHERE person_id = ?',
        )
        .get(personId);
      if (current?.updatedAt != null && current.updatedAt > updatedAt) {
        throw new ConflictError('stale updatedAt');
      }
      db.query('DELETE FROM favorites WHERE person_id = ?').run(personId);
      const insert = db.query(
        'INSERT INTO favorites (person_id, entry_id, ord, updated_at) VALUES (?, ?, ?, ?)',
      );
      ids.forEach((id, index) => insert.run(personId, id, index, updatedAt));
    });
  }

  function addEvents(
    personId: string,
    sessionId: string,
    events: EventInput[],
    now: string,
  ): string[] {
    const ids = [...new Set(events.map((event) => event.id))];
    return runInTransaction(() => {
      const insert = db.query(
        `INSERT INTO events
           (id, person_id, session_id, at, kind, tool_id, url, result, detail, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      );
      for (const event of events) {
        insert.run(
          event.id,
          personId,
          sessionId,
          event.at,
          event.kind,
          event.toolId ?? null,
          // SP01 §2: `url` keeps origin + pathname only; a query string may carry a token.
          event.url == null ? null : auditUrl(event.url),
          event.result ?? null,
          event.detail ?? null,
          now,
        );
      }
      if (ids.length === 0) return [];
      // SP04 §5: the answer is every id the host now holds, in the order of the batch.
      const held = new Set(
        db
          .query<{ id: string }, Bind[]>(
            `SELECT id FROM events WHERE id IN (${marks(ids.length)})`,
          )
          .all(...ids)
          .map((row) => row.id),
      );
      return ids.filter((id) => held.has(id));
    });
  }

  function listEvents(filter: HostEventFilter = {}): HostEvent[] {
    const where: string[] = [];
    const params: Bind[] = [];
    if (filter.personId !== undefined) {
      where.push('person_id = ?');
      params.push(filter.personId);
    }
    if (filter.toolId !== undefined) {
      where.push('tool_id = ?');
      params.push(filter.toolId);
    }
    if (filter.from !== undefined) {
      where.push('at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('at <= ?');
      params.push(filter.to);
    }
    params.push(filter.limit ?? EVENTS_DEFAULT_LIMIT);
    return db
      .query<EventRow, Bind[]>(
        `SELECT ${EVENT_COLUMNS} FROM events
          ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
          ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(...params)
      .map(toEvent);
  }

  /**
   * SP03 §2: the guild icon is two `meta` rows, written and cleared together. `readMeta`/`writeMeta`
   * are the pair the public `meta`/`setMeta` of the interface also use, so the one query shape lives
   * once; the guards around them (the `schema_version` refusal) stay with the interface.
   */
  function readMeta(key: string): string | null {
    return (
      db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value ??
      null
    );
  }

  function writeMeta(key: string, value: string): void {
    db.query(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  function guildIcon(): GuildIcon | null {
    const sha256 = readMeta(GUILD_ICON_HASH_KEY);
    const encoded = readMeta(GUILD_ICON_BYTES_KEY);
    // Both rows or none: the digest without bytes would be a snapshot the route cannot serve.
    if (sha256 === null || encoded === null) return null;
    return { sha256, bytes: fromBase64url(encoded) };
  }

  function setGuildIcon(icon: GuildIcon): void {
    runInTransaction(() => {
      writeMeta(GUILD_ICON_HASH_KEY, icon.sha256);
      writeMeta(GUILD_ICON_BYTES_KEY, toBase64url(icon.bytes));
    });
  }

  function clearGuildIcon(): boolean {
    return runInTransaction(
      () =>
        db.query('DELETE FROM meta WHERE key IN (?, ?)').run(GUILD_ICON_HASH_KEY, GUILD_ICON_BYTES_KEY)
          .changes > 0,
    );
  }

  // ---------------------------------------------------------------- block 2: sharing (SP06)

  function savePersonKeys(
    personId: string,
    keys: PersonKeys,
    privateSealed: string | null,
    now: string,
  ): void {
    runInTransaction(() => {
      assertPersonExists(personId);
      // SP06 §2 (`docs/canonico.md` §22): a reset replaces the pair — one row per person. Same public
      // keys means the pair did not move (a password change re-sealed the blob): only
      // `private_sealed` follows, and `created_at` stays. A `null` blob on an unchanged pair leaves
      // the stored one in place; the Nod uploads a blob when it has one, never to erase it.
      db.query(
        `INSERT INTO person_keys (person_id, x25519_public, ed25519_public, private_sealed, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(person_id) DO UPDATE SET
           private_sealed = CASE
             WHEN person_keys.x25519_public = excluded.x25519_public
              AND person_keys.ed25519_public = excluded.ed25519_public
             THEN COALESCE(excluded.private_sealed, person_keys.private_sealed)
             ELSE excluded.private_sealed
           END,
           created_at = CASE
             WHEN person_keys.x25519_public = excluded.x25519_public
              AND person_keys.ed25519_public = excluded.ed25519_public
             THEN person_keys.created_at
             ELSE excluded.created_at
           END,
           x25519_public = excluded.x25519_public,
           ed25519_public = excluded.ed25519_public`,
      ).run(personId, keys.x25519Public, keys.ed25519Public, privateSealed, now);
    });
  }

  function personKeys(personId: string): PersonKeys | null {
    const row = db
      .query<{ x25519Public: string; ed25519Public: string }, [string]>(
        `SELECT x25519_public AS x25519Public, ed25519_public AS ed25519Public
           FROM person_keys WHERE person_id = ?`,
      )
      .get(personId);
    return row === null
      ? null
      : { x25519Public: row.x25519Public, ed25519Public: row.ed25519Public };
  }

  function ownPersonKeys(personId: string): OwnPersonKeys | null {
    const row = db
      .query<
        { x25519Public: string; ed25519Public: string; privateSealed: string | null },
        [string]
      >(
        `SELECT x25519_public AS x25519Public, ed25519_public AS ed25519Public,
                private_sealed AS privateSealed
           FROM person_keys WHERE person_id = ?`,
      )
      .get(personId);
    return row === null
      ? null
      : {
          x25519Public: row.x25519Public,
          ed25519Public: row.ed25519Public,
          privateSealed: row.privateSealed,
        };
  }

  function keysByPerson(): Map<string, PersonKeys> {
    const keys = new Map<string, PersonKeys>();
    const rows = db
      .query<{ personId: string; x25519Public: string; ed25519Public: string }, []>(
        `SELECT person_id AS personId, x25519_public AS x25519Public, ed25519_public AS ed25519Public
           FROM person_keys`,
      )
      .all();
    for (const row of rows) {
      keys.set(row.personId, { x25519Public: row.x25519Public, ed25519Public: row.ed25519Public });
    }
    return keys;
  }

  function toShare(row: ShareRow): ShareRecord {
    return {
      id: row.id,
      credentialId: row.credentialId,
      fromId: row.fromId,
      toId: row.toId,
      toolId: row.toolId,
      scope: row.scope as ShareScope,
      kind: row.kind as ShareKind,
      sealed: row.sealed,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      declinedAt: row.declinedAt,
      purgedAt: row.purgedAt,
    };
  }

  function readShare(id: string): ShareRecord | null {
    const row = db
      .query<ShareRow, [string]>(`SELECT ${SHARE_COLUMNS} FROM shares WHERE id = ?`)
      .get(id);
    return row === null ? null : toShare(row);
  }

  /** The `credential_holders` state of one person on one credential, or null (SP01 §3). */
  function holderState(
    credentialId: string,
    personId: string,
  ): { owner: boolean; removedAt: string | null } | null {
    const row = db
      .query<{ owner: number; removedAt: string | null }, [string, string]>(
        `SELECT owner, removed_at AS removedAt FROM credential_holders
          WHERE credential_id = ? AND person_id = ?`,
      )
      .get(credentialId, personId);
    return row === null ? null : { owner: row.owner === 1, removedAt: row.removedAt };
  }

  /** Every holder row of one credential, removed holders included (SP06 §4–§5). */
  function holderRowsOf(credentialId: string): {
    personId: string;
    owner: boolean;
    scope: ShareScope;
    toolId: string;
    removedAt: string | null;
  }[] {
    return db
      .query<
        {
          personId: string;
          owner: number;
          scope: string;
          toolId: string;
          removedAt: string | null;
        },
        [string]
      >(
        `SELECT person_id AS personId, owner, scope, tool_id AS toolId, removed_at AS removedAt
           FROM credential_holders WHERE credential_id = ?`,
      )
      .all(credentialId)
      .map((row) => ({
        personId: row.personId,
        owner: row.owner === 1,
        scope: row.scope as ShareScope,
        toolId: row.toolId,
        removedAt: row.removedAt,
      }));
  }

  function createShares(input: ShareInput, now: string): string[] {
    return runInTransaction(() => {
      const sender = personById(input.fromId);
      if (sender === null) throw new NotFoundError('unknown person');
      // SP06 §5: `blocked` never accepts a share — neither the scope the body claims nor a
      // credential whose owner holder row says so.
      if (input.scope === 'blocked') throw new ForbiddenError('the credential is blocked');

      const holders = holderRowsOf(input.credentialId);
      const owner = holders.find((holder) => holder.owner) ?? null;
      const senderHolder = holders.find((holder) => holder.personId === input.fromId) ?? null;
      if (owner !== null && owner.scope === 'blocked') {
        throw new ForbiddenError('the credential is blocked');
      }

      const tool = readEntryState(input.toolId);
      if (tool === null) throw new NotFoundError('unknown tool');

      // H1: one credential belongs to one tool. A later request cannot point it at another one.
      if (owner !== null && owner.toolId !== input.toolId) {
        throw new ConflictError('credential belongs to another tool');
      }

      // L7: the sender must be able to see the tool they are sharing. An admin sees every tool
      // (canonico §10); everyone else needs the grant that makes the entry visible.
      if (!sender.admin) {
        const visible =
          db
            .query<{ one: number }, [string, string]>(
              `SELECT 1 AS one FROM entries e
                 JOIN grants g ON g.entry_id = e.id
                 JOIN person_roles pr ON pr.role_id = g.role_id
                WHERE e.id = ? AND pr.person_id = ? AND e.scope = 'org'`,
            )
            .get(input.toolId, input.fromId) !== null;
        if (!visible) throw new ForbiddenError('tool not visible to sender');
      }

      // SP06 §4: only an admin assigns, and only the credential's owner holder sends an update.
      if (input.kind === 'assign' && !sender.admin) throw new ForbiddenError('admin only');
      if (input.kind === 'update' && (senderHolder === null || !senderHolder.owner)) {
        throw new ForbiddenError('not the owner');
      }

      // H1/M5: once the credential has holder rows, `send` and `assign` come from a live holder —
      // an admin included. Only a credential with no holder row at all writes the owner row below.
      if ((input.kind === 'send' || input.kind === 'assign') && holders.length > 0) {
        if (senderHolder === null) throw new ForbiddenError('not a holder');
        if (senderHolder.removedAt !== null) throw new ForbiddenError('holder was removed');
      }

      // K8/SP06 §4: the roles this credential is assigned to, read once for the whole request. A
      // direct person assignment has no row at all, and that is what tells the two apart below.
      const assignedRoles = db
        .query<{ roleId: string }, [string]>(
          'SELECT role_id AS roleId FROM assignments WHERE credential_id = ?',
        )
        .all(input.credentialId)
        .map((row) => row.roleId);

      // Every item is validated before a single row is written, so a wide request fails whole.
      const validated: ShareItemInput[] = [];
      for (const item of input.items) {
        // L7: a copy to oneself is never a share.
        if (item.to === input.fromId) throw new ForbiddenError('cannot share with yourself');

        const recipient = personById(item.to);
        if (recipient === null) throw new NotFoundError('unknown person');
        if (recipient.disabledAt !== null) throw new ForbiddenError('recipient is disabled');
        // SP06 §2: without a pair there is nothing to seal to — the sender's copy would be lost.
        if (personKeys(item.to) === null) throw new ConflictError('recipient has no keys');

        // SP06 §4: an update goes to the current holders of the credential, nobody else.
        if (input.kind === 'update') {
          const holder = holders.find((row) => row.personId === item.to) ?? null;
          if (holder === null || holder.removedAt !== null) throw new ForbiddenError('not a holder');
        }

        // M5: a revoked holder comes back only through the owner or an admin. Any other sender
        // leaves them out; their row keeps `removedAt` until that re-add.
        const recipientHolder = holders.find((row) => row.personId === item.to) ?? null;
        if (
          recipientHolder !== null &&
          recipientHolder.removedAt !== null &&
          !(senderHolder?.owner ?? false) &&
          !sender.admin
        ) {
          throw new ForbiddenError('recipient was removed');
        }

        // SP06 §5: both scopes require the tool to be an org entry granted to one of the
        // recipient's roles, which is also what makes it visible to them.
        const granted =
          db
            .query<{ one: number }, [string, string]>(
              `SELECT 1 AS one FROM entries e
                 JOIN grants g ON g.entry_id = e.id
                 JOIN person_roles pr ON pr.role_id = g.role_id
                WHERE e.id = ? AND pr.person_id = ? AND e.scope = 'org'`,
            )
            .get(input.toolId, item.to) !== null;
        if (!granted) throw new ForbiddenError('tool not visible to recipient');

        if (input.scope === 'org') {
          // SP06 §5: clients never receive an `org` share (E04).
          if (recipient.kind !== 'member') throw new ForbiddenError('org shares go to members only');
        } else if (input.kind !== 'assign') {
          // SP06 §5: a member-to-member share of scope `role` needs a role in common with the
          // sender. An assignment is not that: the admin assigning a credential to a role is not in
          // it (SP06 §4), so the requirement of §5 does not apply to `kind: 'assign'` (K8).
          const commonRole =
            db
              .query<{ one: number }, [string, string]>(
                `SELECT 1 AS one FROM person_roles mine
                   JOIN person_roles theirs ON theirs.role_id = mine.role_id
                  WHERE mine.person_id = ? AND theirs.person_id = ?`,
              )
              .get(input.fromId, item.to) !== null;
          if (!commonRole) throw new ForbiddenError('no role in common');
        }

        // K8/SP06 §4: a role assignment only reaches a member of one of the roles it was assigned
        // to. The direct person assignment — a credential with no assignment row at all — is the
        // admin addressing one person; it needs no row and carries the scope of the request.
        if (input.kind === 'assign' && assignedRoles.length > 0) {
          const inAssignedRole =
            db
              .query<{ one: number }, [string, string]>(
                `SELECT 1 AS one FROM assignments a
                   JOIN person_roles pr ON pr.role_id = a.role_id
                  WHERE a.credential_id = ? AND pr.person_id = ?`,
              )
              .get(input.credentialId, item.to) !== null;
          if (!inAssignedRole) throw new ForbiddenError('not a member of an assigned role');
        }

        validated.push(item);
      }

      // M4: the owner row is the credential's scope. A request may narrow it, never widen it; a
      // `blocked` owner row was refused above, so this is the remaining half of the rule.
      if (owner !== null && SCOPE_BREADTH[input.scope] > SCOPE_BREADTH[owner.scope]) {
        throw new ForbiddenError('scope wider than the credential');
      }

      const expiresAt = addMs(now, SHARE_TTL_MS);
      const insert = db.query(
        `INSERT INTO shares
           (id, credential_id, from_id, to_id, tool_id, scope, kind, sealed, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of validated) {
        insert.run(
          item.id,
          input.credentialId,
          input.fromId,
          item.to,
          input.toolId,
          input.scope,
          input.kind,
          item.sealed,
          now,
          expiresAt,
        );
      }

      // H1/SP06 §4: only a credential with no holder row at all writes its owner row, once — the
      // row that later lets its person update and makes them the one who sees `rotationPending`.
      if (holders.length === 0) {
        db.query(
          `INSERT INTO credential_holders
             (credential_id, person_id, tool_id, owner, scope, via_share_id, since)
           VALUES (?, ?, ?, 1, ?, NULL, ?)`,
        ).run(input.credentialId, input.fromId, input.toolId, input.scope, now);
      }
      return input.items.map((item) => item.id);
    });
  }

  function openShares(personId: string, now: string): ShareRecord[] {
    return db
      .query<ShareRow, [string, string]>(
        `SELECT ${SHARE_COLUMNS} FROM shares
          WHERE to_id = ? AND accepted_at IS NULL AND declined_at IS NULL AND purged_at IS NULL
            AND expires_at > ?
          ORDER BY created_at, id`,
      )
      .all(personId, now)
      .map(toShare);
  }

  /**
   * SP06 §4, E02 §6: the ciphertext of an unaccepted share that reached 14 days is deleted, not the
   * row — the metadata is what tells the sender it expired — and the recipient gains one
   * `share.expired` event (`events` of SP01 §2). The event is content-free: `detail` is the share id,
   * `tool_id` the tool, `person_id` the recipient, never a username, a secret, a label or the sealed
   * body. The purge and its events are one transaction, so an expiry is either recorded or not.
   *
   * `events.session_id` is NOT NULL REFERENCES `sessions` and the purge runs off a read, not off a
   * request of the recipient: the row is attributed to the recipient's own session — the newest live
   * one, or, since `sessions` rows are never deleted, the newest they ever had. A recipient with no
   * session row at all (a person who never signed in; a share recipient always has one, because
   * `createShares` only reaches pairs the guild published) gets no event, and that asymmetry is the
   * finding of `docs/handovers/share-events.md`.
   */
  function purgeExpiredShares(now: string): number {
    // The common path is a read: nothing to purge, no transaction, no write lock (a poll stays a
    // poll, `host/snapshot.ts`).
    const expired = db
      .query<{ id: string; toId: string; toolId: string }, [string]>(
        `SELECT id, to_id AS toId, tool_id AS toolId FROM shares
          WHERE purged_at IS NULL AND expires_at <= ?`,
      )
      .all(now);
    if (expired.length === 0) return 0;
    return runInTransaction(() => {
      const purge = db.query(
        "UPDATE shares SET sealed = '', purged_at = ? WHERE id = ? AND purged_at IS NULL",
      );
      const insert = db.query(
        `INSERT INTO events
           (id, person_id, session_id, at, kind, tool_id, url, result, detail, received_at)
         VALUES (?, ?, ?, ?, 'share.expired', ?, NULL, NULL, ?, ?)`,
      );
      let purged = 0;
      for (const share of expired) {
        // The row is claimed once: a second purge of the same share cannot double the event.
        if (purge.run(now, share.id).changes === 0) continue;
        purged += 1;
        const sessionId = sessionForEvent(share.toId, now);
        if (sessionId === null) continue;
        insert.run(crypto.randomUUID(), share.toId, sessionId, now, share.toolId, share.id, now);
      }
      return purged;
    });
  }

  /**
   * The session a host-written event is attributed to: the person's newest live session, else the
   * newest they ever had (`sessions` rows are never deleted). `null` only when the person has no
   * `sessions` row at all.
   */
  function sessionForEvent(personId: string, now: string): string | null {
    const row = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM sessions WHERE person_id = ?
          ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, last_seen_at DESC, id
          LIMIT 1`,
      )
      .get(personId, now);
    return row === null ? null : row.id;
  }

  /**
   * The two answers a recipient can give, which differ in one column. Both require an open share of
   * the caller: an unknown id is `404`, someone else's or a closed one is `403`/`409` (SP03 §1).
   */
  function answerShare(id: string, personId: string, now: string, accept: boolean): void {
    runInTransaction(() => {
      const share = readShare(id);
      if (share === null) throw new NotFoundError('unknown share');
      if (share.toId !== personId) throw new ForbiddenError('not yours');
      if (
        share.acceptedAt !== null ||
        share.declinedAt !== null ||
        share.purgedAt !== null ||
        share.expiresAt <= now
      ) {
        throw new ConflictError('share is not open');
      }
      db.query(
        `UPDATE shares SET sealed = '', purged_at = ?, ${accept ? 'accepted_at' : 'declined_at'} = ?
          WHERE id = ?`,
      ).run(now, now, id);
      if (!accept) return;
      // SP06 §4: the accepted copy makes the caller a holder. An update of a credential they
      // already hold refreshes the scope and the date; whether it clears an earlier revocation
      // depends on who sent it (M5): the owner (or an admin) is the credential's own re-add, while
      // any other holder cannot undo the revocation — `removed_at` stays as it was.
      const sender = personById(share.fromId);
      const senderHolder = holderState(share.credentialId, share.fromId);
      const revives = sender !== null && (sender.admin || (senderHolder?.owner ?? false));
      db.query(
        `INSERT INTO credential_holders
           (credential_id, person_id, tool_id, owner, scope, via_share_id, since, removed_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, NULL)
         ON CONFLICT(credential_id, person_id) DO UPDATE SET scope = excluded.scope,
           via_share_id = excluded.via_share_id, since = excluded.since,
           removed_at = CASE WHEN ? = 1 THEN NULL ELSE credential_holders.removed_at END`,
      ).run(
        share.credentialId,
        personId,
        share.toolId,
        share.scope,
        id,
        now,
        revives ? 1 : 0,
      );
    });
  }

  function holdersOf(credentialId: string): HolderRecord[] {
    return db
      .query<HolderRow, [string]>(
        `SELECT ${HOLDER_COLUMNS} FROM credential_holders h JOIN people p ON p.id = h.person_id
          WHERE h.credential_id = ?
          ORDER BY h.owner DESC, h.since, p.name COLLATE NOCASE`,
      )
      .all(credentialId)
      .map((row) => ({
        personId: row.personId,
        name: row.name,
        toolId: row.toolId,
        owner: row.owner === 1,
        scope: row.scope as ShareScope,
        since: row.since,
        removedAt: row.removedAt,
      }));
  }

  function heldCredentials(personId: string, all: boolean): string[] {
    const rows = all
      ? db
          .query<{ credentialId: string }, []>(
            `SELECT DISTINCT credential_id AS credentialId FROM credential_holders
              ORDER BY credential_id`,
          )
          .all()
      : db
          .query<{ credentialId: string }, [string]>(
            `SELECT credential_id AS credentialId FROM credential_holders
              WHERE person_id = ? AND removed_at IS NULL ORDER BY credential_id`,
          )
          .all(personId);
    return rows.map((row) => row.credentialId);
  }

  function removeHolder(
    input: { credentialId: string; personId: string; byId: string; admin: boolean },
    now: string,
  ): void {
    runInTransaction(() => {
      // SP03 §3: the owner holder or an admin revokes a holder. A member who holds the credential
      // but is not its owner cannot remove anyone.
      const caller = holderState(input.credentialId, input.byId);
      if (!input.admin && (caller === null || !caller.owner)) throw new ForbiddenError('not yours');

      const target = holderState(input.credentialId, input.personId);
      if (target === null) throw new NotFoundError('unknown holder');
      if (target.removedAt !== null) throw new ConflictError('holder already removed');
      // The owner row is the credential's anchor in the host's bookkeeping: `rotationPending` is
      // read from it and an update has to come from it, so it is not a removable holder.
      if (target.owner) throw new ConflictError('the owner cannot be removed');

      db.query(
        'UPDATE credential_holders SET removed_at = ? WHERE credential_id = ? AND person_id = ?',
      ).run(now, input.credentialId, input.personId);
    });
  }

  function setCredentialScope(input: {
    credentialId: string;
    byId: string;
    admin: boolean;
    scope: ShareScope;
  }): void {
    runInTransaction(() => {
      // SP06 §5: the scope belongs to the credential, so the owner holder (or an admin) sets it on
      // every holder row at once. A credential no one holds yet is the 404 of SP03 §1.
      const rows = holderRowsOf(input.credentialId);
      if (rows.length === 0) throw new NotFoundError('unknown credential');
      const caller = rows.find((row) => row.personId === input.byId) ?? null;
      if (!input.admin && (caller === null || !caller.owner)) {
        throw new ForbiddenError('not yours');
      }
      db.query('UPDATE credential_holders SET scope = ? WHERE credential_id = ?').run(
        input.scope,
        input.credentialId,
      );
    });
  }

  function markRotated(
    input: { credentialId: string; byId: string; admin: boolean },
    now: string,
  ): void {
    runInTransaction(() => {
      // RF-48: the owner holder (or an admin) says the new secret exists. The owner row is the
      // credential's anchor, exactly as `removeHolder` reads it; a member who merely holds the
      // credential cannot record a rotation on somebody's behalf.
      const caller = holderState(input.credentialId, input.byId);
      if (!input.admin && (caller === null || !caller.owner)) throw new ForbiddenError('not yours');
      const owner = db
        .query<{ one: number }, [string]>(
          `SELECT 1 AS one FROM credential_holders WHERE credential_id = ? AND owner = 1`,
        )
        .get(input.credentialId);
      if (owner === null) throw new NotFoundError('unknown credential');
      db.query(
        'UPDATE credential_holders SET rotated_at = ? WHERE credential_id = ? AND owner = 1',
      ).run(now, input.credentialId);
    });
  }

  function rotationPending(personId: string): string[] {
    // SP06 §4, RF-48: the owner revoked someone and has not saved a new secret since. A save shows
    // up in two ways — as an `update` share the owner created, or as the explicit rotation signal
    // (`rotated_at`, `POST /v1/credentials/:id/rotated`). The signal is what makes the state clear
    // when the revoked holder was the last non-owner one and the fan-out had no recipient
    // (`docs/handovers/k10-smoke.md` finding 1). Either witness clears a removal at or after itself:
    // the host clock has millisecond resolution, so the removal and the save can land in the same
    // one, and a strict comparison would leave the credential pending forever.
    return db
      .query<{ credentialId: string }, [string, string]>(
        `SELECT h.credential_id AS credentialId FROM credential_holders h
          WHERE h.person_id = ? AND h.owner = 1
            AND EXISTS (SELECT 1 FROM credential_holders r
                         WHERE r.credential_id = h.credential_id AND r.removed_at IS NOT NULL
                           AND r.removed_at > COALESCE(h.rotated_at, '')
                           AND NOT EXISTS (
                                 SELECT 1 FROM shares s
                                  WHERE s.credential_id = r.credential_id AND s.from_id = ?
                                    AND s.kind = 'update' AND s.created_at >= r.removed_at))
          ORDER BY h.credential_id`,
      )
      .all(personId, personId)
      .map((row) => row.credentialId);
  }

  function saveAssignment(
    input: {
      credentialId: string;
      roleId: string;
      toolId: string;
      assignedBy: string;
      assigned: boolean;
    },
    now: string,
  ): void {
    runInTransaction(() => {
      if (!input.assigned) {
        db.query('DELETE FROM assignments WHERE credential_id = ? AND role_id = ?').run(
          input.credentialId,
          input.roleId,
        );
        return;
      }
      if (readRole(input.roleId) === null) throw new NotFoundError('unknown role');
      const tool = readEntryState(input.toolId);
      if (tool === null) throw new NotFoundError('unknown tool');
      // As with a grant (SP01 §2): an assignment names an org entry, never a personal one.
      if (tool.scope !== 'org') throw new ForbiddenError('assignments apply to org tools only');
      db.query(
        `INSERT INTO assignments (credential_id, role_id, tool_id, assigned_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(credential_id, role_id) DO UPDATE SET tool_id = excluded.tool_id,
           assigned_by = excluded.assigned_by, created_at = excluded.created_at`,
      ).run(input.credentialId, input.roleId, input.toolId, input.assignedBy, now);
    });
  }

  function missingCopies(): MissingCopyRecord[] {
    // RF-47: every current member of the assigned role who has keys, is not the admin who assigned,
    // and has no holder row for the credential. An owner's revocation suppresses the entry
    // (`docs/canonico.md` §22, "Revoked member of an assigned role"): re-adding takes the explicit
    // direct assignment, so any holder row — removed included — keeps the person out of the list.
    //
    // K8: a `client` of E04 is left out, the same way SP06 §5 refuses them an `org` share: the
    // assignment row carries no scope (the admin's choice lives on their own Nod), so the list is
    // the members a role assignment can reach at all. A client an admin wants to hand a copy to gets
    // it through the direct person assignment (`kind: 'assign'` with no assignment row).
    //
    // F1: SP06 §5's "granted the tool" rule holds for `kind: 'assign'` too, and `createShares`
    // refuses a recipient without it (`tool not visible to recipient`) — one refused item fails the
    // whole request. An un-granted member of the assigned role is therefore not a recipient the
    // assignment can reach, and the same predicate `createShares` applies is part of the list: the
    // grant is read from the person's own roles, not from the role being assigned.
    return db
      .query<MissingCopyRecord, []>(
        `SELECT a.credential_id AS credentialId, a.tool_id AS toolId, a.role_id AS roleId,
                p.id AS personId
           FROM assignments a
           JOIN person_roles pr ON pr.role_id = a.role_id
           JOIN people p ON p.id = pr.person_id
          WHERE p.disabled_at IS NULL
            AND p.kind <> 'client'
            AND p.id <> a.assigned_by
            AND EXISTS (SELECT 1 FROM person_keys k WHERE k.person_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM credential_holders h
                             WHERE h.credential_id = a.credential_id AND h.person_id = p.id)
            AND EXISTS (SELECT 1 FROM grants g
                          JOIN entries e ON e.id = g.entry_id
                          JOIN person_roles prg ON prg.role_id = g.role_id
                         WHERE e.id = a.tool_id AND e.scope = 'org' AND prg.person_id = p.id)
          ORDER BY a.credential_id, a.role_id, p.id`,
      )
      .all();
  }

  return {
    transaction: runInTransaction,

    meta: readMeta,

    setMeta(key, value) {
      // The version is the migrations' to write; a route setting it would break the next boot.
      if (key === SCHEMA_VERSION_KEY) throw new ConflictError('schema_version belongs to the migrations');
      writeMeta(key, value);
    },

    createPerson,
    personById,
    personByEmail,
    personAuthByEmail,
    listPeople,
    renamePerson,
    setRoles,
    setDisabled,
    activatePerson,
    changeAuth,

    issueCode,
    redeemCode,

    createInvite,
    listInvites,
    inviteByCodeHash,
    revokeInvite,
    spendInviteUse,
    includesAdminRole,

    createSession,
    sessionByTokenHash,
    sessionById,
    sessionsOfPerson,
    touchSession,
    revokeSession,
    revokeOwnSession,
    revokeSessionsOfPerson,
    presence,

    listRoles,
    saveRole,
    removeRole,
    adminCount: countAdmins,

    grant,

    hasOrgTools,
    bootstrap,
    listOrgTools,
    orgToolsFor,
    saveOrgTool,
    removeOrgTool,
    listPersonalTools,
    personalTool,
    savePersonalTool,
    removePersonalTool,
    listPersonalViews,
    savePersonalView,
    removePersonalView,

    favorites,
    replaceFavorites,

    addEvents,
    listEvents,

    guildIconHash: () => readMeta(GUILD_ICON_HASH_KEY),
    guildIcon,
    setGuildIcon,
    clearGuildIcon,

    savePersonKeys,
    personKeys,
    ownPersonKeys,
    keysByPerson,

    createShares,
    openShares,
    shareById: readShare,
    purgeExpiredShares,
    acceptShare: (id, personId, now) => answerShare(id, personId, now, true),
    declineShare: (id, personId, now) => answerShare(id, personId, now, false),
    holdersOf,
    heldCredentials,
    removeHolder,
    setCredentialScope,
    markRotated,
    rotationPending,

    saveAssignment,
    missingCopies,
  };
}
