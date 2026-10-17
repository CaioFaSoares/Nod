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
  e.url AS url, e.icon AS icon, e.ord AS "order", e.auth AS auth, e.active AS active,
  e.updated_at AS updatedAt, g.role_id AS roleId`;

interface EntryRow {
  id: string;
  scope: string;
  ownerId: string | null;
  title: string;
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
        `INSERT INTO entries (id, scope, owner_id, title, url, icon, ord, auth, active, updated_at)
         VALUES (?, 'org', NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url, icon = excluded.icon,
           ord = excluded.ord, auth = excluded.auth, active = excluded.active, updated_at = excluded.updated_at`,
      ).run(
        tool.id,
        tool.title,
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

    createSession,
    sessionByTokenHash,
    sessionById,
    sessionsOfPerson,
    touchSession,
    revokeSession,
    revokeOwnSession,
    revokeSessionsOfPerson,

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
  };
}
