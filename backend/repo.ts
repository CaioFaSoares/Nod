// Nod repository — §4 of `docs/arquitetura.md`.
//
// All of the app's SQL lives here: no other slice writes SQL. The schema is the one from §16 of
// `docs/canonico.md` with the additions of the architecture contract (see `SCHEMA` below).
// Nothing here holds a secret: the vault keeps only the pointer (`keychain_key`) to the system
// keychain, and the local password is a verifier — the v1 PBKDF2 `PasswordHash` or the V2 `check`
// of SP02 §6 — never the password or a derived key.
import { PASSWORD_V2_ALGORITHM } from '../shared/auth';
import { originOf } from '../shared/catalog';
import type { PasswordHashV2, StoredPassword } from '../shared/auth';
import type { ShareScope } from '../shared/host-api';
import type {
  AuditEvent,
  AuthOverride,
  Entry,
  EventFilter,
  EventSyncStatus,
  Id,
  Invite,
  LoginResult,
  PasswordHash,
  Person,
  Probe,
  Role,
  SqlDb,
  VaultItem,
  View,
} from '../shared/types';

// `event` has no foreign key on purpose: the audit (§13) survives the removal of the tool or of
// the person. A revoked person is invisible to every read of `person`; only `countPeople` still
// sees it (the first-account rule asks whether the database ever held an account).
//
// A column a later build added to a table of this schema (SP05 §2) has to be written twice: here,
// for a database that does not exist yet, and in `addColumns()`, for one that does — every `CREATE`
// below is `IF NOT EXISTS` and would be skipped whole.
//
// A *constraint* that a later build removes from a table that already exists is the same problem the
// other way round: SQLite cannot drop one with an `ALTER`, so `migrate()` rebuilds the table
// (`rebuildVaultItem`, for the foreign key to `tool` that SP05 §2 takes off `vault_item`).
//
// The `host` and `host_outbox` tables of SP05 §2 are new: no earlier build wrote them, so the
// `IF NOT EXISTS` here creates them on a fresh database and on an existing one alike. `host` has no
// token column and never will (SP02 §5): the bearer lives in the system keychain.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  password_check TEXT,
  password_algorithm TEXT NOT NULL DEFAULT 'PBKDF2-SHA256'
);
CREATE TABLE IF NOT EXISTS role (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS person_role (
  person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES role (id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, role_id)
);
CREATE TABLE IF NOT EXISTS tool (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  icon_hash TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  auth_json TEXT,
  probe_json TEXT,
  scope TEXT NOT NULL DEFAULT 'org',
  owner_id TEXT
);
CREATE TABLE IF NOT EXISTS tool_view (
  tool_id TEXT NOT NULL REFERENCES tool (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (tool_id, idx)
);
CREATE TABLE IF NOT EXISTS tool_grant (
  role_id TEXT NOT NULL REFERENCES role (id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES tool (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, tool_id)
);
CREATE TABLE IF NOT EXISTS vault_item (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  keychain_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin TEXT,
  credential_id TEXT,
  scope TEXT NOT NULL DEFAULT 'role',
  UNIQUE (person_id, tool_id)
);
CREATE TABLE IF NOT EXISTS invite (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  roles_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  person_id TEXT,
  tool_id TEXT,
  type TEXT NOT NULL,
  url TEXT,
  result TEXT,
  detail TEXT,
  client_id TEXT,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS host (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  address       TEXT NOT NULL,
  guild         TEXT NOT NULL,
  kid           TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  salt          TEXT NOT NULL,
  snapshot      TEXT,
  version       TEXT,
  issued_at     TEXT,
  last_sync_at  TEXT,
  last_error    TEXT,
  added_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS host_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE TABLE IF NOT EXISTS peer_keys (
  person_id       TEXT PRIMARY KEY,
  x25519          TEXT NOT NULL,
  ed25519         TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  first_seen      TEXT NOT NULL,
  confirmed_at    TEXT,
  pending_x25519      TEXT,
  pending_ed25519     TEXT,
  pending_fingerprint TEXT,
  pending_since       TEXT
);
`;

/**
 * Schema version of `SCHEMA`, kept in `PRAGMA user_version` (§4). A database that carries it needs
 * nothing but the `CREATE … IF NOT EXISTS` above; a database without a version is either empty (a
 * fresh install), v2-shaped from a build older than the versioning, or one written by an older Nod
 * — and that last one is refused whole instead of half-migrated.
 *
 * `3` is SP05 §2's connected schema: the two `host` tables, the event's client id and sent time,
 * the local password V2 columns and the tool's scope/owner. A `2` database gets them by presence
 * (`addColumns`), with its people, tools and vault rows untouched; `0` covers everything written
 * before the versioning, which is completed the same way. Only 0, 2, 3 and the current version are
 * known — anything else is a database from a build this one cannot reason about.
 *
 * `4` is K1–K2's `peer_keys` (SP06 §2): one more table and no other change, so a `3` database gets
 * it from the `CREATE … IF NOT EXISTS` above and is re-stamped; its rows are untouched.
 *
 * `5` is K4's vault index of a shared credential (SP06 §3–§5): `vault_item.credential_id` — the
 * uuid that groups every holder of one credential, `NULL` until the item is first shared — and
 * `vault_item.scope`, the sharing scope (`role` by default). Two columns of an existing table, so a
 * `4` database gets them from `addColumns` and every item it holds becomes `role`/unshared.
 */
export const SCHEMA_VERSION = 5;

/** The versions `migrate` completes and re-stamps: before the versioning (`0`), v2–v4, current. */
const KNOWN_VERSIONS: readonly number[] = [0, 2, 3, 4, SCHEMA_VERSION];

/**
 * The database was created by an older Nod (v1, in Portuguese). `migrate` throws this and touches
 * nothing: the tables it holds (`pessoa`, a `meta (chave, valor)`, …) are not this build's, and
 * creating a v2 schema alongside them would leave the file ambiguous instead of recovered.
 */
export class LegacyDatabaseError extends Error {}

/** The tables of `SCHEMA`, read from the DDL itself so the two cannot drift apart. */
const SCHEMA_TABLES: readonly string[] = (SCHEMA.match(/CREATE TABLE IF NOT EXISTS \w+/g) ?? []).map((create) =>
  create.slice('CREATE TABLE IF NOT EXISTS '.length),
);

interface PersonRow {
  id: Id;
  email: string;
  name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  created_at: string;
  revoked_at: string | null;
  /** `PasswordHashV2.check` (SP02 §6); `NULL` on a v1 row. */
  password_check: string | null;
  /** `'PBKDF2-SHA256'` (v1) or `PASSWORD_V2_ALGORITHM` (V2). */
  password_algorithm: string;
}

interface RoleRow {
  id: Id;
  name: string;
  admin: number;
}

interface ToolRow {
  id: Id;
  title: string;
  url: string;
  origin: string;
  icon_hash: string | null;
  sort_order: number;
  active: number;
  auth_json: string | null;
  probe_json: string | null;
  /** `'org'` or `'personal'` (SP05 §2): a local personal tool is a `tool` row of its owner's. */
  scope: string;
  /** The person a personal row belongs to; `null` for a catalog entry. */
  owner_id: Id | null;
}

interface ViewRow {
  tool_id: Id;
  idx: number;
  label: string;
  url: string;
  mode: string;
}

interface VaultRow {
  id: Id;
  person_id: Id;
  tool_id: Id;
  label: string;
  username: string;
  keychain_key: string;
  created_at: string;
  updated_at: string;
  origin: string | null;
  /** K4: the credential this copy belongs to, or `NULL` when it never travelled. */
  credential_id: string | null;
  /** K6: the sharing scope (`role`, `blocked` or `org`). */
  scope: string;
}

interface InviteRow {
  id: Id;
  code_hash: string;
  roles_json: string;
  expires_at: string;
  used_at: string | null;
  created_by: Id | null;
}

interface EventRow {
  id: number;
  at: string;
  person_id: Id | null;
  tool_id: Id | null;
  type: string;
  url: string | null;
  result: string | null;
  detail: string | null;
  client_id: Id | null;
  sent_at: string | null;
}

interface HostRow {
  id: number;
  address: string;
  guild: string;
  kid: string;
  public_key: string;
  person_id: Id;
  salt: string;
  snapshot: string | null;
  version: string | null;
  issued_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  added_at: string;
}

interface OutboxRowSql {
  id: number;
  method: string;
  path: string;
  body: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

interface PeerKeyRow {
  person_id: Id;
  x25519: string;
  ed25519: string;
  fingerprint: string;
  first_seen: string;
  confirmed_at: string | null;
  pending_x25519: string | null;
  pending_ed25519: string | null;
  pending_fingerprint: string | null;
  pending_since: string | null;
}

/**
 * The one `host` row of SP05 §2 as the rest of the backend reads it: the pinned host (address, key,
 * person id, salt) and the cache of the last verified snapshot. No token field exists, on purpose
 * (SP02 §5): the bearer is a keychain item, `nod.host.<kid>.<personId>`.
 */
export interface HostRecord {
  address: string;
  guild: string;
  kid: string;
  /** Pinned Ed25519 public key, base64url raw 32 bytes (SP05 §2). */
  publicKey: string;
  /** The host's person id: also the local person id of a connected account (SP05 §2). */
  personId: Id;
  /** The host salt, for offline unlock (SP02 §6). */
  salt: string;
  /** The last snapshot the Nod verified, verbatim, or `null` before the first sync. */
  snapshot: string | null;
  version: string | null;
  issuedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  addedAt: string;
}

/** SP05 §2's `host_outbox.method`: the two writes the outbox replays (SP04 §4). */
export type OutboxMethod = 'PUT' | 'DELETE';

/** One pending write of SP04 §4, oldest first by `id`. */
export interface OutboxEntry {
  id: number;
  method: OutboxMethod;
  path: string;
  body: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

/**
 * One row of SP06 §2's `peer_keys` (K2), as the pinning logic reads and writes it: the pair this
 * machine pinned for a colleague, and — while the host publishes a different one — the pair that
 * would replace it. Neither side is a secret: both are public keys, base64url of the raw 32 bytes,
 * and the fingerprint is SP06 §2's 16 Crockford characters.
 *
 * The table is SP06 §2's six columns plus the four of the `changed` state (`pending_x25519`,
 * `pending_ed25519`, `pending_fingerprint`, `pending_since`); the spec's `changed` is a state, and a
 * Nod that did not keep the pair it saw could not show the new fingerprint to confirm (RF-45).
 */
export interface PeerKeyRecord {
  personId: Id;
  x25519: string;
  ed25519: string;
  fingerprint: string;
  /** When this machine first pinned a pair of that person's (ISO 8601 UTC). */
  firstSeen: string;
  /** When the person confirmed the pinned pair; `null` while it was never confirmed by hand. */
  confirmedAt: string | null;
  /** The unconfirmed replacement, all three set together while the peer is `changed`. */
  pendingX25519: string | null;
  pendingEd25519: string | null;
  pendingFingerprint: string | null;
  /** When that unconfirmed pair first appeared in a snapshot (ISO 8601 UTC). */
  pendingSince: string | null;
}

/** The only login results a `login` event may carry (`docs/arquitetura.md` §4). */
const LOGIN_RESULTS: readonly LoginResult[] = ['session', 'filled', 'provider', 'manual', 'failed'];

/**
 * SP04 §5: an event on its way to the host. `clientId` is the one a pushed event cannot lack —
 * `unsentEvents` fills a row that predates the column before it answers — while `AuditEvent` keeps it
 * optional, because a read that does not go through the push (`listEvents`) may see such a row first.
 */
export interface PendingEvent extends AuditEvent {
  clientId: string;
}

/**
 * What `addEvent` takes: the event without the identity the repository owns — the numeric `id`, the
 * instant (`at` is the caller's when it matters, now otherwise) and SP04 §5's `clientId`/`sentAt`.
 */
export type EventInput = Omit<AuditEvent, 'id' | 'at' | 'clientId' | 'sentAt'> & { at?: string };

/**
 * Repository contract (§4 of `docs/arquitetura.md`). Whoever needs it imports the name `Repo` from
 * here; `createRepo` is the only implementation, and it is the only owner of the app's SQL.
 */
export interface Repo {
  /**
   * Brings the database to `SCHEMA_VERSION`. A database written by an older Nod throws
   * `LegacyDatabaseError`; a version this build does not know throws `unsupported database
   * version: <n>`.
   */
  migrate(): void;
  // people
  /** Including revoked people: the first-account rule (P6) asks about the table, not about who is active. */
  countPeople(): number;
  /** Active people holding an admin role. */
  countAdmins(): number;
  createPerson(p: { email: string; name: string; password: PasswordHash; roles: Id[] }): Person;
  /**
   * One transaction: consumes the invite (`used_at IS NULL AND expires_at > now`) and creates the
   * person with the invite roles (D7). `null` when the code was not consumed — unknown, already
   * used or expired — and then nothing was written.
   */
  createPersonWithInvite(
    p: { email: string; name: string; password: PasswordHash },
    codeHash: string,
    now: Date,
  ): Person | null;
  /** Case-insensitive; ignores revoked people. */
  personByEmail(email: string): { person: Person; password: PasswordHash } | null;
  /**
   * The person plus the verifier their row carries (SP02 §6): the V2 record when
   * `password_algorithm` is `PASSWORD_V2_ALGORITHM`, the v1 PBKDF2 hash otherwise — the read every local
   * unlock and password gate goes through. Case-insensitive; ignores revoked people.
   */
  personAuthByEmail(email: string): { person: Person; password: StoredPassword } | null;
  /**
   * F1: whoever holds this email, revoked included, or `null`. It is the read a join makes before it
   * asks the host, and the one its adoption re-keys: `personByEmail` ignores a revoked row, and the
   * join that ignored it ended in a raw `UNIQUE constraint failed` — the email column is unique
   * across every state (the `person` table's `email TEXT NOT NULL COLLATE NOCASE UNIQUE`). `revoked`
   * says whether the row is the one the state hides.
   */
  personByEmailAnyState(email: string): { person: Person; revoked: boolean } | null;
  /**
   * Creates — or updates in place — the local person of a connected account (SP05 §2): the host
   * person id is the local id, the row carries the V2 verifier over the host salt and no v1 hash,
   * and a revoked row comes back. Roles are replaced wholesale, like `setRoles`.
   */
  saveConnectedPerson(p: {
    id: Id;
    email: string;
    name: string;
    password: PasswordHashV2;
    roles: Id[];
  }): Person;
  /**
   * F1: the local account of `fromId` becomes the host person `toId`, in one transaction — its
   * `person` row (the id, and nothing else of it), its `person_role` rows, its `vault_item` rows and
   * every `event` that named it (the audit is that person's own history, `docs/canonico.md` §13).
   *
   * A credential's keychain key carries the person id (`nod.cred.<person>.<tool>`,
   * `backend/vault.ts`), so each row's `keychain_key` is rewritten with `keychainKeyOf(item)` and the
   * answer carries the items exactly as they were read — the old key included. Renaming the keychain
   * items themselves is the caller's: only the session reaches the keychain.
   *
   * The children move before the parent and the parent's key changes last, so SQLite's foreign keys
   * (on at runtime, `backend/sqlite.ts`) would refuse the intermediate state: the transaction
   * defers them to the commit. A `person` row that already holds `toId` is the caller's to refuse —
   * this would merge two rows and their `vault_item`s collide on `UNIQUE (person_id, tool_id)`.
   */
  adoptPersonId(p: { fromId: Id; toId: Id; keychainKeyOf: (item: VaultItem) => string }): VaultItem[];
  /**
   * Rewrites the local verifier as V2 (SP02 §6): the salt, the iterations and the check move to the
   * row, the algorithm is stamped and the v1 hash is emptied. A revoked or unknown person is a
   * no-op.
   */
  savePasswordCheck(personId: Id, password: PasswordHashV2): void;
  /**
   * F2: the snapshot's `me` is the last word on the connected person (SP04 §2) — after every applied
   * snapshot the local row's name and its local admin role follow it, so an access-code admin reaches
   * the admin screens and a demoted one leaves them. Answers whether anything changed; an empty name
   * is ignored and a revoked or unknown person is a no-op.
   */
  saveConnectedIdentity(personId: Id, identity: { name: string; admin: boolean }): boolean;
  /** Ignores revoked people. */
  personById(id: Id): Person | null;
  /** Ignores revoked people. */
  listPeople(): Person[];
  setRoles(personId: Id, roles: Id[]): Person;
  changePassword(personId: Id, password: PasswordHash): void;
  revokePerson(personId: Id): void;
  // roles
  listRoles(): Role[];
  saveRole(r: Role): Role;
  /** Deletes grants and links; `'admin'` cannot be removed. */
  removeRole(id: Id): void;
  ensureAdminRole(): Role;
  // catalog
  /** `roles` come from `tool_grant`, `views` from `tool_view`; `icon` leaves through `iconHash`. */
  listEntries(): Entry[];
  entry(id: Id): Entry | null;
  /** Upsert; rewrites views and grants; `extras` decides by presence of key. */
  saveEntry(e: Entry, extras?: { iconHash?: string | null; probe?: Probe | null }): Entry;
  removeEntry(id: Id): void;
  grant(roleId: Id, toolId: Id, granted: boolean): void;
  iconHash(id: Id): string | null;
  probe(id: Id): Probe | null;
  // invites
  /** Ignores a repeated `codeHash`: returns the invite that already exists. */
  saveInvite(i: { codeHash: string; roles: Id[]; expiresAt: string; createdBy: Id | null }): Invite;
  activeInvite(codeHash: string, now: Date): Invite | null;
  listInvites(): Invite[];
  // vault index
  listVault(personId: Id): VaultItem[];
  vaultItem(personId: Id, toolId: Id): VaultItem | null;
  /**
   * The origin that person's credential for that tool was saved for (SP02 §8, RF-38): the origin a
   * tool window must be on for the fill to run. `null` when the index holds no item — or an item
   * with no origin, which no fill may use either.
   */
  vaultOrigin(personId: Id, toolId: Id): string | null;
  /** Every person's item of that tool (to clean the keychain when a tool is removed). */
  vaultItemsByTool(toolId: Id): VaultItem[];
  saveVaultItem(i: {
    personId: Id;
    toolId: Id;
    label: string;
    username: string;
    keychainKey: string;
    /** Canonical origin of the tool entry at save time; the fill is bound to it (B9, RF-38). */
    origin: string;
    /** K4: the credential group of a shared item; omitted or `null` leaves the stored one in place. */
    credentialId?: string | null;
    /** K6: the sharing scope; omitted leaves the stored one in place. */
    scope?: ShareScope;
  }): VaultItem;
  /** K4/SP06 §4: writes the credential group of an item the moment it is first shared. */
  setVaultCredential(personId: Id, toolId: Id, credentialId: string): void;
  /** K6/SP06 §5: stores a new sharing scope for one item (the owner's choice, or an accept). */
  setVaultScope(personId: Id, toolId: Id, scope: ShareScope): void;
  /**
   * K4: both sharing fields at once, `null` included — the rollback of a failed accept restores the
   * item exactly as it was, credential group and scope alike.
   */
  setVaultSharing(
    personId: Id,
    toolId: Id,
    p: { credentialId: string | null; scope: ShareScope },
  ): void;
  removeVaultItem(personId: Id, toolId: Id): void;
  /**
   * B8b/RF-40: re-points the vault index rows of one tool id to another — what a local tool turned
   * into a personal tool needs, so a credential saved for the old id stays usable under the new one.
   * `keychain_key` is left untouched on purpose: the value in the keychain is sealed with that string
   * as AAD and `backend/vault.ts` reads by the stored key, so the credential opens unchanged without
   * the `vaultKey` on hand. Answers how many rows moved.
   */
  rekeyVaultTool(fromToolId: Id, toToolId: Id): number;
  /** Returns what it removed: the caller needs the keys to clean the keychain. */
  removeVaultOf(personId: Id): VaultItem[];
  // events
  /**
   * Appends one event. The repo owns the row's identity: the numeric `id`, the instant (`at`, the
   * caller's or now) and SP04 §5's `clientId` (a fresh uuid) — the caller passes neither.
   */
  addEvent(e: EventInput): AuditEvent;
  /** Newest first; default limit 500. */
  listEvents(f: EventFilter): AuditEvent[];
  /**
   * SP04 §5: the events the host does not hold yet, oldest first, at most `limit` — the next batch of
   * the push. A row recorded before the client id existed gets one here, so every answer carries it.
   */
  unsentEvents(limit: number): PendingEvent[];
  /** SP04 §5: marks the ids the host acked with the receipt `at`; unknown ids and repeats are no-ops. */
  markEventsSent(clientIds: readonly Id[], at: string): void;
  /** How many events the host holds and how many are pending a push (SP04 §5, Settings → Activity). */
  eventSyncCounts(): EventSyncStatus;
  /** One JSON per line, in chronological order. */
  eventsJsonl(): string;
  /** Newest first, from the `login` events of that tool, only valid `LoginResult` values. */
  loginResults(toolId: Id, limit: number): LoginResult[];
  // meta
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  // host (connected mode, SP05 §2)
  /**
   * The one `host` row, or `null` without a host. Everything the Nod sends to a host is built from
   * this row (RF-30: no row, no client, no call).
   */
  hostRecord(): HostRecord | null;
  /**
   * Adds or replaces the row — `id = 1`, one guild at a time (SP05 §2). The pinned half is what the
   * caller passes; `snapshot`, `version`, `issuedAt`, `lastSyncAt` and `lastError` start empty and
   * are written by `saveHostSnapshot`/`saveHostError`. The token is never a parameter of anything
   * here (SP02 §5).
   */
  saveHost(h: {
    address: string;
    guild: string;
    kid: string;
    publicKey: string;
    personId: Id;
    salt: string;
    addedAt: string;
  }): HostRecord;
  /**
   * Stores one verified snapshot verbatim (SP04 §2) — the body as received, its `version`, its
   * `issuedAt` and when the sync succeeded. `syncedAt` also clears `last_error`: the last call
   * decided.
   */
  saveHostSnapshot(s: { snapshot: string; version: string; issuedAt: string; syncedAt: string }): void;
  /**
   * Rewrites the salt the `host` row caches for offline unlock (SP02 §6) — and nothing else. SP02
   * §7's password change moves that salt, and the cached one has to move with it: the sign-in of
   * §7 calls a salt other than the cached one a reset, and a reset wipes the vault (RF-43). No-op
   * without a host row.
   */
  saveHostSalt(salt: string): void;
  /** The failure of the last sync, for Settings → Hosts (SP04 §3); `null` clears it. */
  saveHostError(message: string | null): void;
  /**
   * Forgets the host: the row and the pending writes in one transaction. Without a host the outbox
   * can never be replayed (nothing builds a client), so keeping it would only hide rows. What
   * happens to the local personal tools is the caller's `keepPersonal` decision (SP05 §3), not this
   * method's: they are `tool` rows, untouched here.
   */
  clearHost(): void;
  // outbox
  /** Appends one pending write (SP04 §4); the local cache already changed when this is called. */
  enqueueOutbox(w: { method: OutboxMethod; path: string; body: string; createdAt: string }): OutboxEntry;
  /** Every pending write, `id` order: the replay order of SP04 §4. */
  listOutbox(): OutboxEntry[];
  /** One more failed attempt and why it failed; `null` clears the message. Unknown id: no-op. */
  markOutboxAttempt(id: number, error: string | null): void;
  /** Drops one row: the write is done, or the host refused it for good (SP04 §4). Unknown id: no-op. */
  deleteOutbox(id: number): void;
  // peer keys (K1–K2, SP06 §2)
  /** The pair this machine pinned for one colleague, or `null` when it never saw one. */
  peerKey(personId: Id): PeerKeyRecord | null;
  /**
   * SP06 §2's first sight: writes the pinned pair. A person who already has a row is left exactly
   * as it is — a pair that differs from a pinned one is a `changed` (K2), never a re-pin — and the
   * answer says whether a row was written.
   */
  pinPeerKey(p: {
    personId: Id;
    x25519: string;
    ed25519: string;
    fingerprint: string;
    firstSeen: string;
    confirmedAt: string | null;
  }): boolean;
  /**
   * SP06 §2's change: keeps the pinned pair and records the pair the host now publishes as the
   * pending one, which is what makes a peer `changed` until `confirmPeerKey`. Unknown person: no-op.
   */
  markPeerKeyChanged(p: {
    personId: Id;
    x25519: string;
    ed25519: string;
    fingerprint: string;
    since: string;
  }): boolean;
  /**
   * Forgets the pending pair without touching the pinned one: the host went back to the pair this
   * machine had pinned, so there is nothing left to confirm. Answers whether a change was pending.
   */
  clearPeerKeyChange(personId: Id): boolean;
  /**
   * K2/RF-45: the person confirmed the pending pair — it becomes the pinned one, `confirmed_at` is
   * `at` and `first_seen` becomes when that pair was first seen (`pending_since`), because that is
   * when this machine met the key it now trusts. Answers whether a change was waiting.
   */
  confirmPeerKey(personId: Id, at: string): boolean;
}

export function createRepo(db: SqlDb): Repo {
  // §2 of the contract: every date is ISO 8601 UTC. The lexicographic order of an ISO string is
  // chronological — that is what `activeInvite`, `listEvents`, `loginResults` and `eventsJsonl`
  // rely on.
  function nowIso(): string {
    return new Date().toISOString();
  }

  function transaction<T>(body: () => T): T {
    db.exec('BEGIN');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // The runtime has no `get()`: a single row comes from `.all()[0]`.
  function singleRow<T>(sql: string, params: unknown[] = []): T | null {
    return db.all<T>(sql, params)[0] ?? null;
  }

  function orFail<T>(value: T | null, message: string): T {
    if (value === null) throw new Error(message);
    return value;
  }

  /** How many rows the last statement wrote: `run()` returns nothing (not even the rowid). */
  function rowsChanged(): number {
    return singleRow<{ n: number }>('SELECT changes() AS n')?.n ?? 0;
  }

  /**
   * A database with no schema version is an older Nod's when it holds a table this build does not
   * know (`pessoa`, …) or a `meta` table whose columns are not this build's — `key` is the column
   * every read here asks for, and v1's `meta` was `(chave, valor)`.
   */
  function isLegacy(): boolean {
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((row) => row.name);
    if (tables.some((name) => !SCHEMA_TABLES.includes(name))) return true;
    if (!tables.includes('meta')) return false;
    const columns = db.all<{ name: string }>('PRAGMA table_info(meta)').map((row) => row.name);
    return !columns.includes('key');
  }

  /**
   * Adds a column to a table that already exists. Every `CREATE TABLE` here is `IF NOT EXISTS`, so
   * a column added to `SCHEMA` never reaches a database whose table is already there: SQLite keeps
   * the old shape and the whole `CREATE` is skipped (the `meta (chave, valor)` surprise of
   * `docs/handovers/v2-repo.md`). A column of SP05 §2 therefore lives in both places — in the DDL
   * above, written with the shape the `ALTER` leaves behind (nullable, appended at the end), and
   * here, by presence. A migrated database and a fresh one end up the same.
   */
  function addColumn(table: string, column: string, definition: string): void {
    const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
    if (columns.includes(column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** The columns a later build added to a table of this schema (SP05 §2). */
  function addColumns(): void {
    // B9: the origin a credential's fill is bound to (RF-38).
    addColumn('vault_item', 'origin', 'TEXT');
    // B1: the local password V2 of SP02 §6. The old `password_hash`/`password_salt` stay: they are
    // what a v2 database's accounts can still be unlocked with, once (SP02 §6's migration).
    addColumn('person', 'password_check', 'TEXT');
    addColumn('person', 'password_algorithm', "TEXT NOT NULL DEFAULT 'PBKDF2-SHA256'");
    // B1: a personal tool is a `tool` row while the Nod is in local mode (SP05 §2).
    addColumn('tool', 'scope', "TEXT NOT NULL DEFAULT 'org'");
    addColumn('tool', 'owner_id', 'TEXT');
    // B10: the stable client id of an event and when the host acked it (SP04 §5).
    addColumn('event', 'client_id', 'TEXT');
    addColumn('event', 'sent_at', 'TEXT');
    // K4/K6: the credential group of a shared item and its sharing scope (SP06 §3–§5). Every item a
    // `4` database holds is unshared and `role`, which is the default of the new column.
    addColumn('vault_item', 'credential_id', 'TEXT');
    addColumn('vault_item', 'scope', "TEXT NOT NULL DEFAULT 'role'");
  }

  /**
   * SP05 §2: `vault_item.tool_id` no longer has a foreign key to `tool (id)`. A credential may
   * belong to a tool that exists only on the host — a connected entry has no local `tool` row — and
   * with `PRAGMA foreign_keys = ON` (B9's schema) that insert would fail with `FOREIGN KEY
   * constraint failed`. The DDL above is already the new shape; a database whose `vault_item` was
   * created with the constraint keeps it, because `CREATE TABLE IF NOT EXISTS` skips the whole
   * statement — so the table is rebuilt here.
   *
   * The guard is the constraint itself and not `user_version`: a v2 database and a block-1 one both
   * carry it (both are completed, unversioned or stamped), and a database this build already
   * rebuilt answers `false` here, which is what makes `migrate()` idempotent. The recipe is the
   * SQLite documentation's "making other kinds of table schema changes": `foreign_keys` off —
   * outside the transaction, where the pragma is a silent no-op —, the new table, the rows, `DROP`,
   * `RENAME`, all inside one transaction, and the pragma back where it was. Every row, the
   * constraint on `person`, the `UNIQUE (person_id, tool_id)` and the `origin` column come along.
   *
   * Removing a local tool still takes its vault rows with it: with the FK gone that is
   * `removeEntry`'s explicit `DELETE FROM vault_item WHERE tool_id = ?`, which it already does.
   */
  function rebuildVaultItem(): void {
    const pointsAtTool = db
      .all<{ table: string }>('PRAGMA foreign_key_list(vault_item)')
      .some((row) => row.table === 'tool');
    if (!pointsAtTool) return;
    const foreignKeysOn = singleRow<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1;
    if (foreignKeysOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(() => {
        // The shape of the `vault_item` of `SCHEMA` above, table name apart — the same double
        // writing `addColumns` explains, in the direction of a constraint instead of a column.
        db.exec(`
CREATE TABLE vault_item_rebuilt (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  keychain_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin TEXT,
  credential_id TEXT,
  scope TEXT NOT NULL DEFAULT 'role',
  UNIQUE (person_id, tool_id)
);`);
        db.run(
          `INSERT INTO vault_item_rebuilt
             (id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin,
              credential_id, scope)
           SELECT id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin,
                  credential_id, scope
             FROM vault_item`,
        );
        db.exec('DROP TABLE vault_item');
        db.exec('ALTER TABLE vault_item_rebuilt RENAME TO vault_item');
      });
    } finally {
      // Back on before anything else runs: the rest of the session relies on it (B9).
      if (foreignKeysOn) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * B9/RF-38: an item saved before the column existed takes the origin of its tool. That is the
   * address the entry had when the credential was saved — the same value `saveVaultItem` writes
   * today — and the only origin the item can be attributed to. An item that already carries one
   * keeps it: a moved tool must not move the credential with it.
   */
  function backfillVaultOrigin(): void {
    db.run(
      `UPDATE vault_item
          SET origin = (SELECT t.origin FROM tool t WHERE t.id = vault_item.tool_id)
        WHERE origin IS NULL`,
    );
  }

  /**
   * §4: `PRAGMA user_version` is the schema version. `3` is already this build's, so the DDL below
   * only completes what is missing; `2` is a database of the previous block-1 build; no version at
   * all is a database from before the versioning — empty (a fresh install), v2-shaped (an earlier
   * v2 build: completed and stamped) or v1, which leaves as `LegacyDatabaseError` without a single
   * write. The columns and tables of SP05 §2 come after the DDL, by presence, and the origin of the
   * items written before that column is filled in there. Nothing here rewrites the *values* of a v2
   * database: local-mode data — people, tools, views, grants, vault items, events — is left exactly
   * as it was. What does move is the shape of `vault_item`, whose foreign key to `tool` SP05 §2
   * takes off (`rebuildVaultItem`), and even that keeps every row as it stands.
   */
  function migrate(): void {
    const version = singleRow<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    if (!KNOWN_VERSIONS.includes(version)) {
      throw new Error(`unsupported database version: ${version}`);
    }
    if (version === 0 && isLegacy()) {
      throw new LegacyDatabaseError('this database was created by an older Nod');
    }
    db.exec(SCHEMA);
    addColumns();
    rebuildVaultItem();
    backfillVaultOrigin();
    if (version !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // ---------------------------------------------------------------- people

  function rolesOf(personId: Id): Id[] {
    return db
      .all<{ role_id: Id }>('SELECT role_id FROM person_role WHERE person_id = ? ORDER BY role_id', [personId])
      .map((l) => l.role_id);
  }

  function isAdmin(personId: Id): boolean {
    const row = singleRow<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM person_role pr
         JOIN role r ON r.id = pr.role_id
        WHERE pr.person_id = ? AND r.admin = 1`,
      [personId],
    );
    return (row?.n ?? 0) > 0;
  }

  function buildPerson(l: PersonRow): Person {
    return {
      id: l.id,
      email: l.email,
      name: l.name,
      roles: rolesOf(l.id),
      admin: isAdmin(l.id),
      createdAt: l.created_at,
    };
  }

  // Swaps the links without opening a transaction: the caller decides whether it needs one.
  // `BEGIN` inside `BEGIN` is an error in SQLite, and `createPerson`/`createPersonWithInvite`/
  // `setRoles` already open theirs.
  function replaceRoles(personId: Id, roles: Id[]): void {
    db.run('DELETE FROM person_role WHERE person_id = ?', [personId]);
    for (const roleId of roles) {
      db.run('INSERT OR IGNORE INTO person_role (person_id, role_id) VALUES (?, ?)', [personId, roleId]);
    }
  }

  function insertPerson(id: Id, p: { email: string; name: string; password: PasswordHash }): void {
    db.run(
      `INSERT INTO person (id, email, name, password_hash, password_salt, password_iterations, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, p.email.trim().toLowerCase(), p.name, p.password.hash, p.password.salt, p.password.iterations, nowIso()],
    );
  }

  function countPeople(): number {
    // The whole table: a revoked person still counts for the first-account rule (P6).
    return singleRow<{ n: number }>('SELECT COUNT(*) AS n FROM person')?.n ?? 0;
  }

  function countAdmins(): number {
    const row = singleRow<{ n: number }>(
      `SELECT COUNT(DISTINCT pr.person_id) AS n
         FROM person_role pr
         JOIN role r ON r.id = pr.role_id
         JOIN person p ON p.id = pr.person_id
        WHERE r.admin = 1 AND p.revoked_at IS NULL`,
    );
    return row?.n ?? 0;
  }

  function createPerson(p: { email: string; name: string; password: PasswordHash; roles: Id[] }): Person {
    const id = crypto.randomUUID();
    return transaction(() => {
      insertPerson(id, p);
      replaceRoles(id, p.roles);
      return orFail(personById(id), 'person not found');
    });
  }

  function createPersonWithInvite(
    p: { email: string; name: string; password: PasswordHash },
    codeHash: string,
    now: Date,
  ): Person | null {
    const at = now.toISOString();
    const id = crypto.randomUUID();
    // One transaction, both statements: consuming the invite and creating the person are atomic
    // (D7). A second call with the same code — or any failure below — finds `used_at` set.
    db.exec('BEGIN');
    try {
      db.run('UPDATE invite SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', [
        at,
        codeHash,
        at,
      ]);
      if (rowsChanged() === 0) {
        // Unknown, already used or expired: roll back and leave the database as it was.
        db.exec('ROLLBACK');
        return null;
      }
      const invite = singleRow<InviteRow>('SELECT * FROM invite WHERE code_hash = ?', [codeHash]);
      insertPerson(id, p);
      replaceRoles(id, invite === null ? [] : (JSON.parse(invite.roles_json) as Id[]));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return orFail(personById(id), 'person not found');
  }

  /**
   * The v1 projection of the row: the PBKDF2 verifier of a local account. A V2 row (a connected
   * account, SP02 §6) has no v1 hash and answers with the empty one — `personAuthByEmail` is the
   * read that decides by algorithm.
   */
  function personByEmail(email: string): { person: Person; password: PasswordHash } | null {
    const found = personAuthByEmail(email);
    if (found === null) return null;
    const password = found.password;
    return {
      person: found.person,
      password:
        password.algorithm === PASSWORD_V2_ALGORITHM
          ? { algorithm: 'PBKDF2-SHA256', hash: '', salt: password.salt, iterations: password.iterations }
          : password,
    };
  }

  /**
   * SP02 §6: the row's verifier. A `password_algorithm` of `PASSWORD_V2_ALGORITHM` makes the row V2 — it has
   * no v1 hash and its `check` decides; anything else is the v1 PBKDF2 hash. A V2 row with no
   * `check` reads as an empty one, which matches no password.
   */
  function personAuthByEmail(email: string): { person: Person; password: StoredPassword } | null {
    const row = singleRow<PersonRow>('SELECT * FROM person WHERE email = ? AND revoked_at IS NULL', [
      email.trim().toLowerCase(),
    ]);
    if (row === null) return null;
    if (row.password_algorithm === PASSWORD_V2_ALGORITHM) {
      return {
        person: buildPerson(row),
        password: {
          algorithm: PASSWORD_V2_ALGORITHM,
          salt: row.password_salt,
          iterations: row.password_iterations,
          check: row.password_check ?? '',
        },
      };
    }
    return {
      person: buildPerson(row),
      password: {
        algorithm: 'PBKDF2-SHA256',
        hash: row.password_hash,
        salt: row.password_salt,
        iterations: row.password_iterations,
      },
    };
  }

  function personByEmailAnyState(email: string): { person: Person; revoked: boolean } | null {
    const row = singleRow<PersonRow>('SELECT * FROM person WHERE email = ?', [
      email.trim().toLowerCase(),
    ]);
    return row === null ? null : { person: buildPerson(row), revoked: row.revoked_at !== null };
  }

  function saveConnectedPerson(p: {
    id: Id;
    email: string;
    name: string;
    password: PasswordHashV2;
    roles: Id[];
  }): Person {
    // `password_hash` is emptied on purpose: a connected account never had a v1 verifier (SP02 §6
    // creates it with V2), and the empty value is what says so — `verifyPassword` cannot match it.
    const email = p.email.trim().toLowerCase();
    const verifier = [p.password.salt, p.password.iterations, p.password.check, PASSWORD_V2_ALGORITHM];
    transaction(() => {
      const exists = singleRow<{ id: Id }>('SELECT id FROM person WHERE id = ?', [p.id]) !== null;
      if (exists) {
        // A revoked row comes back: the host is the one that decides who is active (SP05 §2), and an
        // activation that just succeeded is that decision. `created_at` stays: the row is not new.
        db.run(
          `UPDATE person
              SET email = ?, name = ?, password_hash = '', password_salt = ?, password_iterations = ?,
                  password_check = ?, password_algorithm = ?, revoked_at = NULL
            WHERE id = ?`,
          [email, p.name, ...verifier, p.id],
        );
      } else {
        db.run(
          `INSERT INTO person (id, email, name, password_hash, password_salt, password_iterations,
                               created_at, revoked_at, password_check, password_algorithm)
           VALUES (?, ?, ?, '', ?, ?, ?, NULL, ?, ?)`,
          [p.id, email, p.name, p.password.salt, p.password.iterations, nowIso(), p.password.check, PASSWORD_V2_ALGORITHM],
        );
      }
      replaceRoles(p.id, p.roles);
    });
    return orFail(personById(p.id), 'person not found');
  }

  function adoptPersonId(p: {
    fromId: Id;
    toId: Id;
    keychainKeyOf: (item: VaultItem) => string;
  }): VaultItem[] {
    return transaction(() => {
      // A `person` row already holding `toId` is not adoptable: two rows would merge and their
      // `vault_item`s would collide on `UNIQUE (person_id, tool_id)`. Refusing here keeps the join
      // from ending in a raw SQLite message — and the transaction leaves both rows as they were.
      if (singleRow<{ id: Id }>('SELECT id FROM person WHERE id = ?', [p.toId]) !== null) {
        throw new Error('this Nod already holds an account of that guild person');
      }
      const items = db
        .all<VaultRow>('SELECT * FROM vault_item WHERE person_id = ?', [p.fromId])
        .map(buildVaultItem);
      for (const item of items) {
        db.run('UPDATE vault_item SET keychain_key = ? WHERE id = ?', [p.keychainKeyOf(item), item.id]);
      }
      // The children first and the key last, with the foreign keys deferred to the commit: the
      // runtime turns them on (`backend/sqlite.ts`), and the state between the two halves of a
      // re-key — child rows pointing at a person that no longer has that id — is not one SQLite
      // checks, it is the middle of one transaction.
      db.exec('PRAGMA defer_foreign_keys = ON');
      db.run('UPDATE person_role SET person_id = ? WHERE person_id = ?', [p.toId, p.fromId]);
      db.run('UPDATE vault_item SET person_id = ? WHERE person_id = ?', [p.toId, p.fromId]);
      db.run('UPDATE event SET person_id = ? WHERE person_id = ?', [p.toId, p.fromId]);
      db.run('UPDATE person SET id = ? WHERE id = ?', [p.toId, p.fromId]);
      return items;
    });
  }

  function savePasswordCheck(personId: Id, password: PasswordHashV2): void {
    db.run(
      `UPDATE person
          SET password_hash = '', password_salt = ?, password_iterations = ?, password_check = ?,
              password_algorithm = ?
        WHERE id = ? AND revoked_at IS NULL`,
      [password.salt, password.iterations, password.check, PASSWORD_V2_ALGORITHM, personId],
    );
  }

  function saveConnectedIdentity(personId: Id, identity: { name: string; admin: boolean }): boolean {
    const row = singleRow<PersonRow>('SELECT * FROM person WHERE id = ? AND revoked_at IS NULL', [personId]);
    if (row === null) return false;
    // The host's name is never empty (SP04 §2's `me.name` is a required string): a blank one is not
    // a name to write, and the local row keeps what it has.
    const name = identity.name.trim();
    const wanted = name === '' || name === row.name ? null : name;
    // `me.admin` is derived from the guild's roles; the local row carries it as the local admin role
    // (SP05 §2), which is what `Person.admin` reads. Read first, write after: this runs on every
    // state the sync publishes, and the push that changes nothing must not touch a row.
    const isAdminNow = isAdmin(personId);
    if (wanted === null && isAdminNow === identity.admin) return false;
    transaction(() => {
      if (wanted !== null) db.run('UPDATE person SET name = ? WHERE id = ?', [wanted, personId]);
      if (isAdminNow !== identity.admin) {
        const adminRole = ensureAdminRole().id;
        const kept = rolesOf(personId).filter((id) => id !== adminRole);
        replaceRoles(personId, identity.admin ? [...kept, adminRole] : kept);
      }
    });
    return true;
  }

  function personById(id: Id): Person | null {
    const row = singleRow<PersonRow>('SELECT * FROM person WHERE id = ? AND revoked_at IS NULL', [id]);
    return row === null ? null : buildPerson(row);
  }

  function listPeople(): Person[] {
    return db
      .all<PersonRow>('SELECT * FROM person WHERE revoked_at IS NULL ORDER BY name COLLATE NOCASE, email')
      .map(buildPerson);
  }

  function setRoles(personId: Id, roles: Id[]): Person {
    orFail(personById(personId), 'person not found');
    transaction(() => {
      replaceRoles(personId, roles);
    });
    return orFail(personById(personId), 'person not found');
  }

  function changePassword(personId: Id, password: PasswordHash): void {
    db.run(
      'UPDATE person SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ? AND revoked_at IS NULL',
      [password.hash, password.salt, password.iterations, personId],
    );
  }

  function revokePerson(personId: Id): void {
    db.run('UPDATE person SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso(), personId]);
  }

  // ---------------------------------------------------------------- roles

  function buildRole(l: RoleRow): Role {
    return { id: l.id, name: l.name, admin: l.admin === 1 };
  }

  function listRoles(): Role[] {
    return db.all<RoleRow>('SELECT * FROM role ORDER BY name COLLATE NOCASE, id').map(buildRole);
  }

  function saveRole(r: Role): Role {
    db.run(
      `INSERT INTO role (id, name, admin) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, admin = excluded.admin`,
      [r.id, r.name, r.admin ? 1 : 0],
    );
    return buildRole(orFail(singleRow<RoleRow>('SELECT * FROM role WHERE id = ?', [r.id]), 'role not found'));
  }

  function removeRole(id: Id): void {
    if (id === 'admin') throw new Error('the admin role cannot be removed');
    // Children first and explicitly, without trusting `ON DELETE CASCADE`.
    transaction(() => {
      db.run('DELETE FROM tool_grant WHERE role_id = ?', [id]);
      db.run('DELETE FROM person_role WHERE role_id = ?', [id]);
      db.run('DELETE FROM role WHERE id = ?', [id]);
    });
  }

  function ensureAdminRole(): Role {
    return saveRole({ id: 'admin', name: 'Admin', admin: true });
  }

  // ---------------------------------------------------------------- catalog

  function rolesByTool(): Map<Id, Id[]> {
    const byTool = new Map<Id, Id[]>();
    for (const row of db.all<{ tool_id: Id; role_id: Id }>(
      'SELECT tool_id, role_id FROM tool_grant ORDER BY tool_id, role_id',
    )) {
      const roles = byTool.get(row.tool_id);
      if (roles === undefined) byTool.set(row.tool_id, [row.role_id]);
      else roles.push(row.role_id);
    }
    return byTool;
  }

  function viewsByTool(): Map<Id, View[]> {
    const byTool = new Map<Id, View[]>();
    for (const row of db.all<ViewRow>('SELECT tool_id, idx, label, url, mode FROM tool_view ORDER BY tool_id, idx')) {
      const view: View = { label: row.label, url: row.url, mode: row.mode as View['mode'] };
      const views = byTool.get(row.tool_id);
      if (views === undefined) byTool.set(row.tool_id, [view]);
      else views.push(view);
    }
    return byTool;
  }

  function buildEntry(l: ToolRow, roles: Map<Id, Id[]>, views: Map<Id, View[]>): Entry {
    return {
      id: l.id,
      // SP04 §2: local mode fills both — a catalog row is `'org'`, a personal tool names its owner.
      scope: l.scope === 'personal' ? 'personal' : 'org',
      ownerId: l.owner_id,
      title: l.title,
      url: l.url,
      // The icon does not leave here: the backend serves the bytes by `iconHash` (data URI, §4).
      icon: null,
      order: l.sort_order,
      roles: roles.get(l.id) ?? [],
      views: views.get(l.id) ?? [],
      auth: l.auth_json === null ? null : (JSON.parse(l.auth_json) as AuthOverride),
      active: l.active === 1,
    };
  }

  function listEntries(): Entry[] {
    const roles = rolesByTool();
    const views = viewsByTool();
    return db
      .all<ToolRow>('SELECT * FROM tool ORDER BY sort_order ASC, title COLLATE NOCASE ASC')
      .map((l) => buildEntry(l, roles, views));
  }

  function entry(id: Id): Entry | null {
    const row = singleRow<ToolRow>('SELECT * FROM tool WHERE id = ?', [id]);
    return row === null ? null : buildEntry(row, rolesByTool(), viewsByTool());
  }

  function saveEntry(e: Entry, extras?: { iconHash?: string | null; probe?: Probe | null }): Entry {
    // `extras` decides by presence, not by value: without the key, what is in the database stays.
    const previous = singleRow<ToolRow>('SELECT * FROM tool WHERE id = ?', [e.id]);
    const iconHash = extras !== undefined && 'iconHash' in extras ? (extras.iconHash ?? null) : (previous?.icon_hash ?? null);
    const probeJson =
      extras !== undefined && 'probe' in extras ? JSON.stringify(extras.probe ?? null) : (previous?.probe_json ?? null);
    // SP05 §2: a personal tool is a `tool` row with its scope and its owner. Both are decided by
    // presence, like `extras` above: an entry that carries neither — every `validateEntry` answer —
    // keeps what the row has, so editing a tool from the admin screens cannot turn one person's
    // personal tool into a catalog entry.
    const scope = (e.scope ?? previous?.scope) === 'personal' ? 'personal' : 'org';
    const ownerId = e.ownerId !== undefined ? e.ownerId : (previous?.owner_id ?? null);
    transaction(() => {
      db.run(
        `INSERT INTO tool (id, title, url, origin, icon_hash, sort_order, active, auth_json, probe_json, scope, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           origin = excluded.origin,
           icon_hash = excluded.icon_hash,
           sort_order = excluded.sort_order,
           active = excluded.active,
           auth_json = excluded.auth_json,
           probe_json = excluded.probe_json,
           scope = excluded.scope,
           owner_id = excluded.owner_id`,
        [
          e.id,
          e.title,
          e.url,
          originOf(e.url),
          iconHash,
          e.order,
          e.active ? 1 : 0,
          e.auth === null ? null : JSON.stringify(e.auth),
          probeJson,
          scope,
          ownerId,
        ],
      );
      // Views and grants are rewritten wholesale: whatever did not come in the entry is gone.
      db.run('DELETE FROM tool_view WHERE tool_id = ?', [e.id]);
      e.views.forEach((view, idx) => {
        db.run('INSERT INTO tool_view (tool_id, idx, label, url, mode) VALUES (?, ?, ?, ?, ?)', [
          e.id,
          idx,
          view.label,
          view.url,
          view.mode,
        ]);
      });
      db.run('DELETE FROM tool_grant WHERE tool_id = ?', [e.id]);
      for (const roleId of e.roles) {
        db.run('INSERT OR IGNORE INTO tool_grant (role_id, tool_id) VALUES (?, ?)', [roleId, e.id]);
      }
    });
    return orFail(entry(e.id), 'entry not found');
  }

  function removeEntry(id: Id): void {
    // The vault pointer goes with the tool; the value in the system keychain is deleted by the
    // vault slice, which is the one that knows the keys.
    transaction(() => {
      db.run('DELETE FROM tool_view WHERE tool_id = ?', [id]);
      db.run('DELETE FROM tool_grant WHERE tool_id = ?', [id]);
      db.run('DELETE FROM vault_item WHERE tool_id = ?', [id]);
      db.run('DELETE FROM tool WHERE id = ?', [id]);
    });
  }

  function grant(roleId: Id, toolId: Id, granted: boolean): void {
    if (granted) {
      db.run('INSERT OR IGNORE INTO tool_grant (role_id, tool_id) VALUES (?, ?)', [roleId, toolId]);
    } else {
      db.run('DELETE FROM tool_grant WHERE role_id = ? AND tool_id = ?', [roleId, toolId]);
    }
  }

  function iconHash(id: Id): string | null {
    return singleRow<{ icon_hash: string | null }>('SELECT icon_hash FROM tool WHERE id = ?', [id])?.icon_hash ?? null;
  }

  function probe(id: Id): Probe | null {
    const json = singleRow<{ probe_json: string | null }>('SELECT probe_json FROM tool WHERE id = ?', [id])?.probe_json;
    return json === null || json === undefined ? null : (JSON.parse(json) as Probe);
  }

  // ---------------------------------------------------------------- invites

  function buildInvite(l: InviteRow): Invite {
    return {
      id: l.id,
      codeHash: l.code_hash,
      roles: JSON.parse(l.roles_json) as Id[],
      expiresAt: l.expires_at,
      usedAt: l.used_at,
      createdBy: l.created_by,
    };
  }

  function saveInvite(i: { codeHash: string; roles: Id[]; expiresAt: string; createdBy: Id | null }): Invite {
    // `code_hash` is unique: a repeated invite returns the one that already exists (the seed may be
    // applied again).
    const existing = singleRow<InviteRow>('SELECT * FROM invite WHERE code_hash = ?', [i.codeHash]);
    if (existing !== null) return buildInvite(existing);
    db.run(
      'INSERT INTO invite (id, code_hash, roles_json, expires_at, used_at, created_by) VALUES (?, ?, ?, ?, NULL, ?)',
      [crypto.randomUUID(), i.codeHash, JSON.stringify(i.roles), i.expiresAt, i.createdBy],
    );
    return buildInvite(orFail(singleRow<InviteRow>('SELECT * FROM invite WHERE code_hash = ?', [i.codeHash]), 'invite not found'));
  }

  function activeInvite(codeHash: string, now: Date): Invite | null {
    const at = now.toISOString();
    const row = singleRow<InviteRow>('SELECT * FROM invite WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', [
      codeHash,
      at,
    ]);
    return row === null ? null : buildInvite(row);
  }

  function listInvites(): Invite[] {
    return db.all<InviteRow>('SELECT * FROM invite ORDER BY expires_at DESC, id').map(buildInvite);
  }

  // ---------------------------------------------------------------- vault

  function buildVaultItem(l: VaultRow): VaultItem {
    return {
      id: l.id,
      personId: l.person_id,
      toolId: l.tool_id,
      label: l.label,
      username: l.username,
      keychainKey: l.keychain_key,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
      // K4: `NULL` until the item is first shared; the snapshot decorates `holders` and
      // `rotationPending` over it (`backend/shares.ts`).
      credentialId: l.credential_id,
      scope: l.scope as ShareScope,
      rotationPending: false,
      holders: [],
    };
  }

  function listVault(personId: Id): VaultItem[] {
    return db
      .all<VaultRow>('SELECT * FROM vault_item WHERE person_id = ? ORDER BY label COLLATE NOCASE, tool_id', [personId])
      .map(buildVaultItem);
  }

  function vaultItem(personId: Id, toolId: Id): VaultItem | null {
    const row = singleRow<VaultRow>('SELECT * FROM vault_item WHERE person_id = ? AND tool_id = ?', [personId, toolId]);
    return row === null ? null : buildVaultItem(row);
  }

  function vaultOrigin(personId: Id, toolId: Id): string | null {
    // An item with no origin (`NULL`) answers `null` on purpose: an origin nobody recorded is not
    // an origin the fill may run in (RF-38 fails closed).
    const row = singleRow<{ origin: string | null }>(
      'SELECT origin FROM vault_item WHERE person_id = ? AND tool_id = ?',
      [personId, toolId],
    );
    return row?.origin ?? null;
  }

  function vaultItemsByTool(toolId: Id): VaultItem[] {
    return db
      .all<VaultRow>('SELECT * FROM vault_item WHERE tool_id = ? ORDER BY person_id, label COLLATE NOCASE', [toolId])
      .map(buildVaultItem);
  }

  function saveVaultItem(i: {
    personId: Id;
    toolId: Id;
    label: string;
    username: string;
    keychainKey: string;
    origin: string;
    /** K4: the credential group, when the caller knows it; a plain save leaves it as it was. */
    credentialId?: string | null;
    /** K6: the sharing scope; a plain save leaves the stored one as it was. */
    scope?: ShareScope;
  }): VaultItem {
    const at = nowIso();
    // One item per (person, tool) pair: saving again updates in place and keeps the same id. The
    // origin is rewritten with the rest: it belongs to the credential as it is now, and it is what
    // the fill compares the window's entry origin against (B9, RF-38). `credential_id` and `scope`
    // (K4/K6) are only overwritten by a caller that knows them: a later plain `vault.save` must not
    // forget that this copy belongs to a shared credential. `scope` is `NOT NULL`, so a plain save
    // inserts the default `role` and the `CASE` leaves the stored value untouched on a conflict.
    const hasScope = i.scope === undefined ? 0 : 1;
    db.run(
      `INSERT INTO vault_item (id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin, credential_id, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN ? ELSE 'role' END)
       ON CONFLICT (person_id, tool_id) DO UPDATE SET
         label = excluded.label,
         username = excluded.username,
         keychain_key = excluded.keychain_key,
         updated_at = excluded.updated_at,
         origin = excluded.origin,
         credential_id = COALESCE(excluded.credential_id, vault_item.credential_id),
         scope = CASE WHEN ? = 1 THEN excluded.scope ELSE vault_item.scope END`,
      [
        crypto.randomUUID(),
        i.personId,
        i.toolId,
        i.label,
        i.username,
        i.keychainKey,
        at,
        at,
        i.origin,
        i.credentialId ?? null,
        hasScope,
        i.scope ?? 'role',
        hasScope,
      ],
    );
    return orFail(vaultItem(i.personId, i.toolId), 'vault item not found');
  }

  /** K4/SP06 §4: stores the credential group of an item the moment it is first shared. */
  function setVaultCredential(personId: Id, toolId: Id, credentialId: string): void {
    db.run('UPDATE vault_item SET credential_id = ? WHERE person_id = ? AND tool_id = ?', [
      credentialId,
      personId,
      toolId,
    ]);
  }

  /** K6/SP06 §5: stores a new sharing scope for one item (the owner's choice, or an accept). */
  function setVaultScope(personId: Id, toolId: Id, scope: ShareScope): void {
    db.run('UPDATE vault_item SET scope = ? WHERE person_id = ? AND tool_id = ?', [
      scope,
      personId,
      toolId,
    ]);
  }

  /** K4: the pair of sharing fields in one write, `NULL` included (the accept rollback). */
  function setVaultSharing(
    personId: Id,
    toolId: Id,
    p: { credentialId: string | null; scope: ShareScope },
  ): void {
    db.run(
      'UPDATE vault_item SET credential_id = ?, scope = ? WHERE person_id = ? AND tool_id = ?',
      [p.credentialId, p.scope, personId, toolId],
    );
  }

  function removeVaultItem(personId: Id, toolId: Id): void {
    db.run('DELETE FROM vault_item WHERE person_id = ? AND tool_id = ?', [personId, toolId]);
  }

  function rekeyVaultTool(fromToolId: Id, toToolId: Id): number {
    // Only `tool_id` moves: `keychain_key` names the sealed value, which the vault reads back by
    // that stored key (its AAD is the same string), so the credential opens unchanged without the
    // `vaultKey` on hand. A row already at `toToolId` is left alone: `UNIQUE (person_id, tool_id)`
    // would otherwise fail the whole update.
    db.run('UPDATE OR IGNORE vault_item SET tool_id = ? WHERE tool_id = ?', [toToolId, fromToolId]);
    return rowsChanged();
  }

  function removeVaultOf(personId: Id): VaultItem[] {
    // Returns what it removed: the caller needs the `keychainKey`s to clean the keychain.
    return transaction(() => {
      const removed = db.all<VaultRow>('SELECT * FROM vault_item WHERE person_id = ?', [personId]).map(buildVaultItem);
      db.run('DELETE FROM vault_item WHERE person_id = ?', [personId]);
      return removed;
    });
  }

  // ---------------------------------------------------------------- events

  function buildEvent(l: EventRow): AuditEvent {
    return {
      id: l.id,
      at: l.at,
      personId: l.person_id,
      toolId: l.tool_id,
      type: l.type as AuditEvent['type'],
      url: l.url,
      result: l.result,
      detail: l.detail,
      // SP04 §5: a row of a database written before the push existed has no client id yet; it stays
      // `undefined` here and `unsentEvents` gives it one before the host ever sees it.
      ...(l.client_id === null ? {} : { clientId: l.client_id }),
      sentAt: l.sent_at,
    };
  }

  /**
   * SP04 §5: every event carries a stable client id from the moment it is written — the host's
   * idempotency key (`ON CONFLICT(id) DO NOTHING`). It is a uuid, not the local rowid: the host's
   * `id` is the primary key of every person's events (`docs/handovers/h8.md`, finding 4), so two
   * machines of the same person — each numbering its own rows from 1 — would collide and one
   * machine's events would be dropped as duplicates.
   *
   * A row recorded before the column existed (local mode, or an older build) gets one the first time
   * it is offered to the host: a Nod that never connects writes nothing extra. A row that is
   * already `sent_at` cannot be one of these — the ack is matched by client id.
   */
  function backfillEventClientIds(): void {
    for (const row of db.all<{ id: number }>('SELECT id FROM event WHERE sent_at IS NULL AND client_id IS NULL')) {
      db.run('UPDATE event SET client_id = ? WHERE id = ?', [crypto.randomUUID(), row.id]);
    }
  }

  function addEvent(e: EventInput): AuditEvent {
    const at = e.at ?? nowIso();
    const clientId = crypto.randomUUID();
    // The id comes back from `RETURNING`: the runtime's `run()` returns nothing (not even rowid).
    const inserted = singleRow<{ id: number }>(
      `INSERT INTO event (at, person_id, tool_id, type, url, result, detail, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [at, e.personId, e.toolId, e.type, e.url, e.result, e.detail, clientId],
    );
    return { ...e, at, id: orFail(inserted, 'event not recorded').id, clientId, sentAt: null };
  }

  /**
   * SP04 §5: the events the host does not hold yet, oldest first, at most `limit` of them — the next
   * batch. `at` is the event's own instant and the order the host receives them in; `id` breaks a
   * tie, so two batches can never skip or repeat a row.
   */
  function unsentEvents(limit: number): PendingEvent[] {
    backfillEventClientIds();
    // `client_id IS NOT NULL` is what the backfill above just ensured: every answer carries the id
    // the host dedupes by (`PendingEvent`).
    return db
      .all<EventRow>(
        'SELECT * FROM event WHERE sent_at IS NULL AND client_id IS NOT NULL ORDER BY at ASC, id ASC LIMIT ?',
        [limit],
      )
      .map((row) => buildEvent(row) as PendingEvent);
  }

  /**
   * SP04 §5: marks the ids the host acked, and only those. `at` is the receipt of this push; the
   * `sent_at IS NULL` guard keeps the first one when the same ack arrives twice. Unknown ids are a
   * no-op.
   */
  function markEventsSent(clientIds: readonly Id[], at: string): void {
    if (clientIds.length === 0) return;
    const placeholders = clientIds.map(() => '?').join(', ');
    db.run(`UPDATE event SET sent_at = ? WHERE client_id IN (${placeholders}) AND sent_at IS NULL`, [
      at,
      ...clientIds,
    ]);
  }

  /** SP04 §5: what Settings → Activity shows as sent vs pending. */
  function eventSyncCounts(): EventSyncStatus {
    return {
      sent: singleRow<{ n: number }>('SELECT count(*) AS n FROM event WHERE sent_at IS NOT NULL')?.n ?? 0,
      pending: singleRow<{ n: number }>('SELECT count(*) AS n FROM event WHERE sent_at IS NULL')?.n ?? 0,
    };
  }

  function listEvents(f: EventFilter): AuditEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (f.personId !== undefined) {
      conditions.push('person_id = ?');
      params.push(f.personId);
    }
    if (f.toolId !== undefined) {
      conditions.push('tool_id = ?');
      params.push(f.toolId);
    }
    if (f.result !== undefined) {
      conditions.push('result = ?');
      params.push(f.result);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    params.push(f.limit ?? 500);
    return db
      .all<EventRow>(`SELECT * FROM event${where} ORDER BY at DESC, id DESC LIMIT ?`, params)
      .map(buildEvent);
  }

  function eventsJsonl(): string {
    // Chronological order (the reverse of the UI list), one JSON line per event (§13).
    return db
      .all<EventRow>('SELECT * FROM event ORDER BY at ASC, id ASC')
      .map((l) => `${JSON.stringify(buildEvent(l))}\n`)
      .join('');
  }

  function isLoginResult(value: string | null): value is LoginResult {
    return value !== null && LOGIN_RESULTS.some((result) => result === value);
  }

  function loginResults(toolId: Id, limit: number): LoginResult[] {
    const placeholders = LOGIN_RESULTS.map(() => '?').join(', ');
    return db
      .all<{ result: string | null }>(
        `SELECT result FROM event
          WHERE type = 'login' AND tool_id = ? AND result IN (${placeholders})
          ORDER BY at DESC, id DESC
          LIMIT ?`,
        [toolId, ...LOGIN_RESULTS, limit],
      )
      .map((l) => l.result)
      .filter(isLoginResult);
  }

  // ---------------------------------------------------------------- meta

  function meta(key: string): string | null {
    return singleRow<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null;
  }

  function setMeta(key: string, value: string): void {
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
      key,
      value,
    ]);
  }

  // ---------------------------------------------------------------- host (connected mode)

  function buildHost(l: HostRow): HostRecord {
    return {
      address: l.address,
      guild: l.guild,
      kid: l.kid,
      publicKey: l.public_key,
      personId: l.person_id,
      salt: l.salt,
      snapshot: l.snapshot,
      version: l.version,
      issuedAt: l.issued_at,
      lastSyncAt: l.last_sync_at,
      lastError: l.last_error,
      addedAt: l.added_at,
    };
  }

  function hostRecord(): HostRecord | null {
    const row = singleRow<HostRow>('SELECT * FROM host WHERE id = 1');
    return row === null ? null : buildHost(row);
  }

  function saveHost(h: {
    address: string;
    guild: string;
    kid: string;
    publicKey: string;
    personId: Id;
    salt: string;
    addedAt: string;
  }): HostRecord {
    // One row, id 1 (SP05 §2): adding a host over an existing one replaces it whole — including the
    // snapshot and the last error, which belong to the host that is going away. What is already
    // there is not read first: the caller decided to replace it.
    db.run(
      `INSERT INTO host (id, address, guild, kid, public_key, person_id, salt, snapshot, version, issued_at,
                         last_sync_at, last_error, added_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT (id) DO UPDATE SET
         address = excluded.address,
         guild = excluded.guild,
         kid = excluded.kid,
         public_key = excluded.public_key,
         person_id = excluded.person_id,
         salt = excluded.salt,
         snapshot = NULL,
         version = NULL,
         issued_at = NULL,
         last_sync_at = NULL,
         last_error = NULL,
         added_at = excluded.added_at`,
      [h.address, h.guild, h.kid, h.publicKey, h.personId, h.salt, h.addedAt],
    );
    return orFail(hostRecord(), 'host not found');
  }

  function saveHostSnapshot(s: { snapshot: string; version: string; issuedAt: string; syncedAt: string }): void {
    db.run(
      `UPDATE host
          SET snapshot = ?, version = ?, issued_at = ?, last_sync_at = ?, last_error = NULL
        WHERE id = 1`,
      [s.snapshot, s.version, s.issuedAt, s.syncedAt],
    );
    // A snapshot row with no host is a caller bug, not an empty cache: say so instead of dropping it
    // (the verified body the caller just checked would be lost silently).
    if (rowsChanged() === 0) throw new Error('host not found');
  }

  function saveHostError(message: string | null): void {
    db.run('UPDATE host SET last_error = ? WHERE id = 1', [message]);
    if (rowsChanged() === 0) throw new Error('host not found');
  }

  function saveHostSalt(salt: string): void {
    // No `host not found` here, unlike the snapshot and the error: losing the host in the middle of
    // a password change must not fail the change, and without a row there is no cache to keep.
    db.run('UPDATE host SET salt = ? WHERE id = 1', [salt]);
  }

  function clearHost(): void {
    transaction(() => {
      db.run('DELETE FROM host_outbox');
      db.run('DELETE FROM host');
    });
  }

  // ---------------------------------------------------------------- outbox

  function buildOutbox(l: OutboxRowSql): OutboxEntry {
    return {
      id: l.id,
      // The column carries what the caller wrote; the table's own contract is the two verbs
      // (SP05 §2), and the caller is the only writer.
      method: l.method as OutboxMethod,
      path: l.path,
      body: l.body,
      createdAt: l.created_at,
      attempts: l.attempts,
      lastError: l.last_error,
    };
  }

  function enqueueOutbox(w: { method: OutboxMethod; path: string; body: string; createdAt: string }): OutboxEntry {
    // `RETURNING id`: the runtime's `run()` returns nothing (not even rowid), same as `addEvent`.
    const inserted = singleRow<{ id: number }>(
      `INSERT INTO host_outbox (method, path, body, created_at, attempts, last_error)
       VALUES (?, ?, ?, ?, 0, NULL) RETURNING id`,
      [w.method, w.path, w.body, w.createdAt],
    );
    const id = orFail(inserted, 'outbox write not recorded').id;
    return buildOutbox(orFail(singleRow<OutboxRowSql>('SELECT * FROM host_outbox WHERE id = ?', [id]), 'outbox write not found'));
  }

  function listOutbox(): OutboxEntry[] {
    return db.all<OutboxRowSql>('SELECT * FROM host_outbox ORDER BY id ASC').map(buildOutbox);
  }

  function markOutboxAttempt(id: number, error: string | null): void {
    db.run('UPDATE host_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', [error, id]);
  }

  function deleteOutbox(id: number): void {
    db.run('DELETE FROM host_outbox WHERE id = ?', [id]);
  }

  // ---------------------------------------------------------------- peer keys (K1–K2, SP06 §2)

  function buildPeerKey(l: PeerKeyRow): PeerKeyRecord {
    return {
      personId: l.person_id,
      x25519: l.x25519,
      ed25519: l.ed25519,
      fingerprint: l.fingerprint,
      firstSeen: l.first_seen,
      confirmedAt: l.confirmed_at,
      pendingX25519: l.pending_x25519,
      pendingEd25519: l.pending_ed25519,
      pendingFingerprint: l.pending_fingerprint,
      pendingSince: l.pending_since,
    };
  }

  function peerKey(personId: Id): PeerKeyRecord | null {
    const row = singleRow<PeerKeyRow>('SELECT * FROM peer_keys WHERE person_id = ?', [personId]);
    return row === null ? null : buildPeerKey(row);
  }

  function pinPeerKey(p: {
    personId: Id;
    x25519: string;
    ed25519: string;
    fingerprint: string;
    firstSeen: string;
    confirmedAt: string | null;
  }): boolean {
    // `DO NOTHING` is the rule of SP06 §2 written in SQL: the first sight pins, and every later
    // sight of a different pair is the caller's `changed` — never a silent re-pin.
    db.run(
      `INSERT INTO peer_keys
         (person_id, x25519, ed25519, fingerprint, first_seen, confirmed_at,
          pending_x25519, pending_ed25519, pending_fingerprint, pending_since)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT (person_id) DO NOTHING`,
      [p.personId, p.x25519, p.ed25519, p.fingerprint, p.firstSeen, p.confirmedAt],
    );
    return rowsChanged() > 0;
  }

  function markPeerKeyChanged(p: {
    personId: Id;
    x25519: string;
    ed25519: string;
    fingerprint: string;
    since: string;
  }): boolean {
    // The pinned pair is untouched on purpose: it is what verifies an incoming share's signature
    // (SP06 §3) until the person confirms the new one.
    db.run(
      `UPDATE peer_keys
          SET pending_x25519 = ?, pending_ed25519 = ?, pending_fingerprint = ?, pending_since = ?
        WHERE person_id = ?`,
      [p.x25519, p.ed25519, p.fingerprint, p.since, p.personId],
    );
    return rowsChanged() > 0;
  }

  function clearPeerKeyChange(personId: Id): boolean {
    db.run(
      `UPDATE peer_keys
          SET pending_x25519 = NULL, pending_ed25519 = NULL, pending_fingerprint = NULL,
              pending_since = NULL
        WHERE person_id = ? AND pending_x25519 IS NOT NULL`,
      [personId],
    );
    return rowsChanged() > 0;
  }

  function confirmPeerKey(personId: Id, at: string): boolean {
    // Every right-hand side reads the row as it was before the update, so the pending pair is
    // promoted in one statement and the cleared columns cannot shadow it.
    db.run(
      `UPDATE peer_keys
          SET x25519 = pending_x25519,
              ed25519 = pending_ed25519,
              fingerprint = pending_fingerprint,
              first_seen = COALESCE(pending_since, first_seen),
              confirmed_at = ?,
              pending_x25519 = NULL,
              pending_ed25519 = NULL,
              pending_fingerprint = NULL,
              pending_since = NULL
        WHERE person_id = ?
          AND pending_x25519 IS NOT NULL
          AND pending_ed25519 IS NOT NULL
          AND pending_fingerprint IS NOT NULL`,
      [at, personId],
    );
    return rowsChanged() > 0;
  }

  return {
    migrate,
    countPeople,
    countAdmins,
    createPerson,
    createPersonWithInvite,
    personByEmail,
    personAuthByEmail,
    personByEmailAnyState,
    saveConnectedPerson,
    adoptPersonId,
    savePasswordCheck,
    saveConnectedIdentity,
    personById,
    listPeople,
    setRoles,
    changePassword,
    revokePerson,
    listRoles,
    saveRole,
    removeRole,
    ensureAdminRole,
    listEntries,
    entry,
    saveEntry,
    removeEntry,
    grant,
    iconHash,
    probe,
    saveInvite,
    activeInvite,
    listInvites,
    listVault,
    vaultItem,
    vaultOrigin,
    vaultItemsByTool,
    saveVaultItem,
    setVaultCredential,
    setVaultScope,
    setVaultSharing,
    removeVaultItem,
    rekeyVaultTool,
    removeVaultOf,
    addEvent,
    listEvents,
    unsentEvents,
    markEventsSent,
    eventSyncCounts,
    eventsJsonl,
    loginResults,
    meta,
    setMeta,
    hostRecord,
    saveHost,
    saveHostSnapshot,
    saveHostSalt,
    saveHostError,
    clearHost,
    enqueueOutbox,
    listOutbox,
    markOutboxAttempt,
    deleteOutbox,
    peerKey,
    pinPeerKey,
    markPeerKeyChanged,
    clearPeerKeyChange,
    confirmPeerKey,
  };
}
