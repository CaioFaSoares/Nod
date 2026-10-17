// Domain and API contract for Nod.
// Concepts: docs/canonico.md (§7 window model, §8 catalog, §9 identity, §10 roles, §11 vault,
// §13 audit, §16 data). Module signatures: docs/arquitetura.md.
// Imported by the backend, the frontend and the tests: nothing here may depend on `tjs`, `tiny`
// or the DOM.

// Type-only, and the one import of this file: the device rows of O1 (`host.sessions`,
// `people.sessions`) and the presence rows of RF-58 (`host.presence`) are the host's own documents,
// defined beside the routes that serve them (`shared/host-api.ts`). Nothing is emitted for them, so
// the two files keep their direction (`host-api.ts` imports the domain types from here) without a
// cycle at runtime.
import type { DeviceSession, Holder, PresenceEntry, ShareKind, ShareScope } from './host-api';

export type Id = string;

// ---------------------------------------------------------------- catalog

export interface View {
  /**
   * uuid the host stores for the view (SP04 §2); absent in local mode, where a view is addressed by
   * its index inside the entry (`toolWindowId`).
   */
  id?: Id;
  label: string;
  url: string;
  /** 'window' opens its own tool window; 'navigate' navigates the tool's main window */
  mode: 'window' | 'navigate';
  /** 'org' for a view of the catalog; 'personal' for a view its owner hangs under an entry (SP04 §2) */
  scope?: 'org' | 'personal';
  /** owner of a personal view; `null` for an org view (SP04 §2) */
  ownerId?: Id | null;
}

/** Optional override of the login cascade (canonico §8). Absent = default cascade. */
export interface AuthOverride {
  /** never fill a form in this tool */
  noFill?: boolean;
}

export interface Entry {
  /** slug: ^[a-z0-9][a-z0-9-]{0,39}$ */
  id: Id;
  /**
   * 'org' for a catalog entry, 'personal' for one person's own tool (SP04 §2). Local mode fills
   * 'org', so a local catalog entry carries it too; absent only in data written before the field.
   */
  scope?: 'org' | 'personal';
  /** owner of a personal entry; `null` for an org entry (SP04 §2) */
  ownerId?: Id | null;
  title: string;
  /** https URL (http only on loopback); no user:password@ */
  url: string;
  /** seed: path relative to resources/ or data URI; runtime: data URI or null */
  icon: string | null;
  order: number;
  /** roles granted this entry */
  roles: Id[];
  views: View[];
  auth: AuthOverride | null;
  active: boolean;
}

export interface Role {
  id: Id;
  name: string;
  admin: boolean;
}

/** An invite as it travels in the seed: only the hash of the code (canonico §9). */
export interface InviteSeed {
  /** lowercase hex sha256 of the code */
  codeHash: string;
  roles: Id[];
  /** ISO 8601 */
  expiresAt: string;
}

/** Private rules file embedded in the release (canonico §19). Never holds a secret. */
export interface Seed {
  version: number;
  generatedAt: string;
  roles: Role[];
  entries: Entry[];
  invites: InviteSeed[];
  update: { url: string } | null;
}

// ---------------------------------------------------------------- people

export interface Person {
  id: Id;
  email: string;
  name: string;
  roles: Id[];
  /** derived: some role has admin = true */
  admin: boolean;
  createdAt: string;
  /**
   * Connected mode (SP03 §2 `AdminPerson`, SP05 §4): the two columns the host keeps and Settings →
   * People shows — when the person redeemed their code, and when the host disabled them. Absent in
   * local mode, which has neither.
   */
  activatedAt?: string | null;
  disabledAt?: string | null;
}

export interface PasswordHash {
  algorithm: 'PBKDF2-SHA256';
  /** base64 */
  hash: string;
  /** base64, 16 bytes */
  salt: string;
  iterations: number;
}

export interface Invite {
  id: Id;
  codeHash: string;
  roles: Id[];
  expiresAt: string;
  usedAt: string | null;
  createdBy: Id | null;
}

// ---------------------------------------------------------------- vault

export interface VaultItem {
  id: Id;
  personId: Id;
  toolId: Id;
  label: string;
  username: string;
  /** key of the item in the OS keychain: nod.cred.<person>.<tool> */
  keychainKey: string;
  createdAt: string;
  updatedAt: string;
  /**
   * K4/SP06 §4: the credential this item is a copy of, owned by whoever first shared it; null for a
   * credential that never travelled. It is the id every holder row of the group is keyed by.
   */
  credentialId: string | null;
  /** K6/SP06 §5: who the scope allows as a recipient. `blocked` is a state, never a share. */
  scope: ShareScope;
  /**
   * K9/SP06 §4: the owner revoked a holder and has not saved a new secret since, so every copy of
   * the remaining holders is still the one the revoked person knows. Cleared by the next save.
   */
  rotationPending: boolean;
  /** K7/RF-54: who holds a copy, from the host's snapshot; `[]` without a host. */
  holders: Holder[];
}

/**
 * K4/SP06 §5: one candidate recipient of a send, as `shares.recipients` answers it — the person, the
 * state of their key on this machine and whether the scope of the credential allows them.
 */
export interface ShareRecipient {
  personId: Id;
  name: string;
  /** The fingerprint pinned to this machine, or null while this Nod holds no key of theirs (K2). */
  fingerprint: string | null;
  /** K2/RF-45: `changed` means the person's key is not the pinned one and the send waits for it. */
  keyStatus: 'pinned' | 'changed' | 'unknown';
  allowed: boolean;
  /** Why the scope leaves them out, or null when it does not. */
  reason: string | null;
}

/**
 * K4/SP06 §4: one open share addressed to this Nod, as `shares.inbox` answers it — the metadata the
 * page shows, never the sealed copy and never the secret.
 */
export interface InboxShare {
  id: Id;
  credentialId: string;
  toolId: Id;
  /** Title of the tool in this Nod's catalog, or null when it is not there. */
  toolTitle: string | null;
  fromId: Id;
  fromName: string;
  scope: ShareScope;
  kind: ShareKind;
  createdAt: string;
  expiresAt: string;
}

/** An item as it goes into the optional encrypted export (RF-28). */
export interface VaultExportItem {
  toolId: Id;
  label: string;
  username: string;
  secret: string;
}

// ---------------------------------------------------------------- audit

export type EventType =
  | 'account_created'
  | 'unlocked'
  | 'unlock_failed'
  | 'locked'
  | 'password_changed'
  | 'tool_opened'
  | 'view_opened'
  | 'login'
  | 'load_failed'
  | 'navigation_blocked'
  | 'external_opened'
  | 'download'
  | 'credential_saved'
  | 'credential_removed'
  | 'vault_exported'
  | 'vault_imported'
  | 'catalog_changed'
  | 'catalog_imported'
  | 'seed_applied'
  | 'grant_changed'
  | 'roles_changed'
  | 'invite_issued'
  | 'access_revoked'
  | 'update'
  /**
   * SP04 §4: the Sync loop's own event — the host refused an outbox write for good (`4xx`, `409`
   * excepted). Not one of canonico §13's kinds: it exists only in connected mode. `docs/handovers/c1.md`
   * (decision 5) left the member for this slice.
   */
  | 'sync.rejected';

/** Result of the login cascade (canonico §8, §11). */
export type LoginResult = 'session' | 'filled' | 'provider' | 'manual' | 'failed';

export interface AuditEvent {
  /**
   * Local row id. While connected, Settings → Activity reads the host's own log, whose ids are
   * uuids (SP03 §2 `HostEvent`), so the field is a number only in local mode.
   */
  id: number | string;
  at: string;
  personId: Id | null;
  toolId: Id | null;
  type: EventType;
  /** origin + path only — never query string or fragment (they may carry tokens) */
  url: string | null;
  result: string | null;
  detail: string | null;
  /**
   * SP04 §5: the stable client id the host dedupes by — a `crypto.randomUUID()` written with the
   * row. Optional because a row recorded before the push existed carries none until it is first
   * offered to the host; `backend/repo.ts` fills it then, so an event handed to the wire always has
   * one.
   */
  clientId?: string;
  /** SP04 §5: when the host acked the event; `null` while it is still waiting for a push. */
  sentAt?: string | null;
}

export interface EventFilter {
  personId?: Id;
  toolId?: Id;
  result?: string;
  limit?: number;
}

/**
 * SP04 §5's "what was sent" counters, for Settings → Activity: how many of the local events the
 * host holds (`sent`) and how many are still pending a push (`pending`).
 */
export interface EventSyncStatus {
  sent: number;
  pending: number;
}

// ---------------------------------------------------------------- probe

export interface RawIcon {
  type: 'png' | 'svg' | 'jpeg' | 'webp';
  base64: string;
}

/** Result of assisted registration (canonico §8, RF-29). */
export interface Probe {
  url: string;
  origin: string;
  /** URL after redirects */
  finalUrl: string;
  title: string | null;
  icon: RawIcon | null;
  hasLoginForm: boolean;
  /** origin of the identity provider when the page redirects to one */
  provider: string | null;
}

export interface EntryDetails {
  entry: Entry;
  /** last probe saved with the entry */
  probe: Probe | null;
  /** most frequent result of the last login events for this tool */
  usualLogin: LoginResult | null;
}

// ---------------------------------------------------------------- tools (windows)

export interface ToolStatus {
  id: Id;
  title: string;
  /** data URI */
  icon: string | null;
  /** 1..9 or null */
  digit: number | null;
  /** number of open windows of this tool (main window + view windows) */
  openWindows: number;
  loading: boolean;
  /** message of the last failed load */
  error: string | null;
  /** last cascade result in this session */
  login: LoginResult | null;
}

export interface ToolsState {
  tools: ToolStatus[];
}

export interface SessionState {
  /** some person exists in the local database (revoked included) */
  hasAccount: boolean;
  /** creating an account requires an invite (there is an account or an open invite) */
  requiresInvite: boolean;
  unlocked: boolean;
  person: Person | null;
  /** biometrics available on this platform and enabled for the last person */
  biometric: boolean;
  /** ms until the next unlock attempt is accepted (0 = free) */
  waitMs: number;
}

/**
 * F1: what a join answers. `local-account` is the typed "this Nod already has an account with this
 * email" of SP05 §4's flow: it is answered **before any host call**, so the code is not spent, and
 * the page asks which account wins — the guild's (the join goes out again with `adoptLocal: true`,
 * which re-keys the local person onto the host person id, `backend/session.ts`) or the local one (the
 * join is cancelled and nothing is sent). `session` is the ordinary answer: the state of the joined
 * person, already unlocked. `name` is the local person's, for the choice on screen.
 */
export type JoinResult =
  | {
      kind: 'session';
      session: SessionState;
      /**
       * SP02 §7/RF-43 (V1): the saved logins of this machine were removed — the host answered a salt
       * other than the cached one (a reset), or the activation of a local account that already had a
       * `vaultKey` derived a fresh one. `src/settings.ts` shows it as the notice after the join.
       */
      wipedVault?: boolean;
    }
  | { kind: 'local-account'; personId: Id; email: string; name: string };

/**
 * Connected mode (SP05 §3): the one host a Nod knows, as Settings → Hosts shows it. `none` without
 * a `host` row; `connected` after the last sync succeeded; `stale` when it failed (SP04 §3) — the
 * cache stays in use and the sidebar says `offline`; `signed-out` after a `401`, which asks the
 * person to sign in again (RF-39). `fingerprint` is SP04 §1.1's string of the pinned key.
 */
export interface HostState {
  status: 'none' | 'connected' | 'stale' | 'signed-out';
  /** `meta.guild_name` of the host (SP04 §1); null without a host. */
  guild: string | null;
  address: string | null;
  fingerprint: string | null;
  /** ISO 8601 UTC of the last snapshot the Nod verified; null before the first one. */
  lastSyncAt: string | null;
  /** Why the last sync failed, as Settings → Hosts shows it; null after one that worked. */
  lastError: string | null;
  /** Writes waiting in the outbox (SP04 §4). */
  pendingWrites: number;
  /**
   * O2/SP04 §1: the host serves a `minAppVersion` newer than this Nod, so nothing is pushed to the
   * guild and no write reaches it — the cache keeps the Nod readable (`backend/sync.ts`), and the
   * main window shows the notice that asks for the update. False without a host.
   */
  updateRequired: boolean;
  /** The oldest version the host serves (SP04 §1, SP03 §3); null before one tells this Nod. */
  minAppVersion: string | null;
}

/**
 * K2/SP06 §2: one colleague of the guild as this machine's pin table knows them — the name from the
 * verified snapshot's roster and the fingerprint of the pair this Nod pinned for them.
 *
 * `status` is what the screen is about. `pinned` is a pair seen for the first time (or one the
 * person confirmed); `changed` is a pair that differs from the pinned one, and sending to that
 * person is refused until they confirm it (RF-45); `unknown` is somebody the roster carries with no
 * pair to pin — they have not activated, or their reset has not published a pair yet.
 *
 * `fingerprint` is the **new** one while `changed` (the string the person compares out loud, SP06
 * §2) and the pinned one otherwise; it is `null` when there is no pair to read, which is exactly
 * the `unknown` case. `firstSeen` is when the machine first pinned a pair for them.
 */
export interface PeerKey {
  personId: Id;
  name: string;
  fingerprint: string | null;
  status: 'pinned' | 'changed' | 'unknown';
  firstSeen: string | null;
  confirmedAt: string | null;
}

/**
 * B7, SP05 §3: a personal tool as the page sends it. The dialog knows the title and the address; the
 * rest is the backend's — `id` is absent on a new one (the Nod generates `p-…`, SP03 §2), and so are
 * `scope`/`ownerId` and the defaults SP03 §2's `PersonalTool` requires of the body that leaves for
 * the host. `id` present names a personal tool of this person to edit (SP04 §2).
 */
export interface PersonalToolDraft {
  id?: Id;
  title: string;
  url: string;
  icon?: string | null;
  order?: number;
  views?: View[];
  auth?: AuthOverride | null;
  active?: boolean;
}

/**
 * B7, SP05 §3: a personal view as the page sends it — the entry it hangs under (SP04 §2) and the
 * view's own fields. `id` is absent on a new one (the backend generates a uuid); `updatedAt` is the
 * write time the Nod stamps (SP04 §4), so the page never sends one.
 */
export interface PersonalViewDraft {
  id?: Id;
  entryId: Id;
  label: string;
  url: string;
  mode: 'window' | 'navigate';
}

/**
 * SP05 §6: which icon the Nod shows — the one it shipped with, or the PNG the guild's admin
 * uploaded. One choice per machine: `app.icon` is the icon of the running app, not of a window.
 */
export type AppIconChoice = 'default' | 'guild';

/** What `nod.appIcon` and `nod.setAppIcon` answer (SP05 §6). */
export interface AppIconState {
  /** The choice, as `store.json` holds it (`appIcon`); no secret, so a plain preference. */
  choice: AppIconChoice;
  /**
   * A guild icon is on disk and can be applied: the last snapshot carries a `guildIcon` hash and the
   * cached bytes hash to exactly that value (SP04 §2). False while the guild has none, while the
   * bytes were never fetched, or after one that did not verify.
   */
  guildIconAvailable: boolean;
}

export interface AppInfo {
  version: string;
  seedVersion: number | null;
  os: 'macos' | 'windows' | 'linux';
  /** origins allowed to report login results in this build (from the embedded seed) */
  gateOrigins: string[];
  /** a tray icon exists, so closing the main window hides it instead of quitting */
  tray: boolean;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------- infra

/** Minimal SQLite interface: tjs:sqlite at runtime, bun:sqlite in tests. */
export interface SqlDb {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): void;
}

/** Keychain interface: app.secrets at runtime, memory in tests. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------- API

/** Method → [params, result]. Single source of method names. */
export interface ApiContract {
  'session.state': [void, SessionState];
  'session.createAccount': [{ email: string; name: string; password: string; code?: string }, SessionState];
  'session.unlock': [{ email: string; password: string }, SessionState];
  'session.unlockBiometric': [void, SessionState];
  'session.enableBiometric': [{ password: string }, SessionState];
  'session.disableBiometric': [void, SessionState];
  'session.changePassword': [{ current: string; next: string }, true];
  'session.lock': [void, SessionState];

  // connected mode (SP05 §3). `discover`, `activate` and `signIn` work with no session at all:
  // the first run has no account yet, and the password only ever travels page → backend. F3: when
  // this Nod already has an account and no host, the two joins need that account's session.
  'host.state': [void, HostState];
  'host.discover': [{ address: string }, { guild: string; fingerprint: string }];
  'host.activate': [
    {
      address: string;
      /** the invite's `fp` (SP04 §1.3), or the fingerprint the person confirmed on screen */
      fingerprint: string;
      email: string;
      code: string;
      password: string;
      /** only for a setup code: it creates the first admin of an empty host (SP02 §3) */
      name?: string;
      /**
       * F1: the person chose the guild account over the local account of the same email; without
       * it a collision answers `local-account` and nothing is sent to the host.
       */
      adoptLocal?: boolean;
    },
    JoinResult,
  ];
  'host.signIn': [
    { address: string; fingerprint: string; email: string; password: string; adoptLocal?: boolean },
    JoinResult,
  ];
  'host.syncNow': [void, HostState];
  /** `keepPersonal` is SP05 §3's choice about the local personal tools (block 2). */
  'host.remove': [{ keepPersonal: boolean }, HostState];
  /**
   * B8a: publishes this Nod's local catalog — the `org` rows of the local `tool` table, with their
   * views and their icons, and the local roles — to a host that has no org tool yet (SP03 §2
   * `/v1/admin/bootstrap`). `refused` is the host's `409`: the window is closed because the guild
   * already holds org tools (H5 decision 12), which is an answer and not a failure of the call.
   * Admin only, like every write of the host's catalog.
   */
  'host.bootstrap': [void, { created: number; refused: boolean }];
  /**
   * B8b/RF-40: this Nod's local `org` tools that the verified snapshot does **not** already carry
   * as an org tool — the catalog the person saw before joining, minus the tools the guild serves
   * itself. The address is what matches: origin plus path (query and fragment dropped). While the
   * host holds no snapshot it is empty, and a personal row never enters it. The Hosts tab reads it
   * to offer the leftovers as personal tools, so no local tool disappears on a join.
   */
  'host.localLeftovers': [void, Entry[]];
  /**
   * B8b/RF-40: keeps the chosen local tools as this person's personal tools — each one goes through
   * the same path as `personal.saveTool` (the `p-…` id, the Nod's `updatedAt`, one outbox row per
   * write while connected), carrying its title, address, views, auth override and icon, and the
   * local `org` row goes away with it. `created` counts the tools that were kept. The ids must be
   * leftovers of `host.localLeftovers`; one that is not is skipped.
   */
  'host.adoptLocalAsPersonal': [{ ids: Id[] }, { created: number }];
  /**
   * SP05 §6, admin of a connected guild: stores the guild icon — the PNG every member's Nod can
   * show as the app icon (`PUT /v1/admin/guild/icon`, SP03 §2). `png` is the base64url of the PNG
   * bytes; the host refuses bytes that are not a PNG and answers their SHA-256, which is what the
   * signed snapshot then carries (SP04 §2).
   */
  'host.setGuildIcon': [{ png: string }, { sha256: string }];
  /** SP05 §6, admin of a connected guild: the guild has no icon again (`DELETE`, SP03 §2). */
  'host.clearGuildIcon': [void, true];
  /**
   * O1/SP03 §2 (`GET /v1/sessions`): this person's live device sessions, newest last seen first —
   * name, OS, app version and the two instants of the row, never the token hash (SP02 §5). The
   * connected-only card of Settings → Account.
   */
  'host.sessions': [void, DeviceSession[]];
  /**
   * O1/SP03 §2 (`DELETE /v1/sessions/:id`): ends one of this person's own sessions with `204`. The
   * device signs out at its next sync, which is the `401` `backend/sync.ts` already handles (RF-39);
   * revoking this machine's own session is that same path.
   */
  'host.revokeSession': [{ id: Id }, true];
  /**
   * RF-58 (`GET /v1/presence`): the guild's members with a live session, online first — name and
   * last seen only. `[]` without a host. Home's "Online now" card.
   */
  'host.presence': [void, PresenceEntry[]];
  /** O1/SP03 §2 (`GET /v1/admin/people/:id/sessions`): one person's sessions, admin only. */
  'people.sessions': [{ personId: Id }, DeviceSession[]];
  /** O1/SP03 §2 (`DELETE /v1/admin/sessions/:id`): ends any session of the guild, admin only. */
  'people.revokeSession': [{ id: Id }, true];

  /**
   * K1/SP06 §2: the fingerprint of this person's own E02 key pair, or `null` while this machine
   * holds none — a local account, or a connected one whose pair is not generated yet. The private
   * halves never cross this method: what leaves is a digest of the two public keys, which is the
   * string Settings → Account shows.
   */
  'keys.mine': [void, { fingerprint: string } | null];
  /**
   * K2/SP06 §2: the guild's colleagues as this machine pinned them — the fingerprint of each and
   * whether it is the pair it was pinned with, a pair that changed under it, or no pair at all.
   * Settings → Account lists them and asks for the confirmation a change needs (RF-45).
   */
  'peers.list': [void, PeerKey[]];
  /**
   * K2/SP06 §2: the person confirmed that a changed key of a colleague is really theirs. The pair
   * the host last published becomes the pinned one and sending to that person is allowed again.
   * Confirming somebody with nothing pending changes nothing and still answers `true`.
   */
  'peers.confirm': [{ personId: Id }, true];

  /**
   * B7/SP05 §3: a personal tool of this person — the entry the host stores at
   * `PUT /v1/personal/tools/:id` (SP03 §2) while connected, a `tool` row with `scope = 'personal'`
   * in local mode (SP05 §2). The backend generates the id (`p-…`, SP03 §2) and stamps `updatedAt`;
   * the page sends the title and the address and nothing else to know.
   */
  'personal.saveTool': [{ entry: PersonalToolDraft }, Entry];
  /** B7/SP05 §3: the person's own tool goes away (`DELETE /v1/personal/tools/:id`, SP03 §2). */
  'personal.removeTool': [{ id: Id }, true];
  /** B7/SP05 §3: a view of this person's, hung under an entry they see (`PUT /v1/personal/views/:id`). */
  'personal.saveView': [{ view: PersonalViewDraft }, View];
  /** B7/SP05 §3: one of the person's own views goes away. */
  'personal.removeView': [{ id: Id }, true];
  /**
   * B7/SP05 §4: the ordered favorites of SP04 §2 — the page needs the current list to draw the
   * toggle and to send the whole list back with `favorites.set`. SP05 §3 lists the write alone; the
   * read is its counterpart (finding in `docs/handovers/b7-personal.md`).
   */
  'favorites.list': [void, Id[]];
  /**
   * B7/SP05 §3: replaces the ordered list whole (`PUT /v1/favorites`, SP03 §2). Ids that resolve to
   * no entry the person sees are dropped, and a repeat keeps its first place.
   */
  'favorites.set': [{ ids: Id[] }, true];

  'catalog.list': [void, Entry[]];
  'catalog.get': [{ id: Id }, EntryDetails];
  'catalog.probe': [{ url: string }, Probe];
  'catalog.save': [{ entry: Entry; icon?: RawIcon | null; probe?: Probe | null }, Entry];
  'catalog.remove': [{ id: Id }, true];
  'catalog.exportToFile': [{ path: string }, true];
  'catalog.importFromFile': [
    { path: string; mode: 'merge' | 'overwrite' },
    { entries: number; roles: number; invites: number },
  ];

  'roles.list': [void, Role[]];
  'roles.save': [{ role: Role }, Role];
  'roles.remove': [{ id: Id }, true];
  'roles.grant': [{ roleId: Id; toolId: Id; granted: boolean }, true];

  'people.list': [void, Person[]];
  'people.setRoles': [{ personId: Id; roles: Id[] }, Person];
  /**
   * Local mode: revokes the person and, with `deleteCredentials`, their local credentials (RF-16).
   * Connected (SP05 §3): disables the person on the host (`disabledAt`), which revokes every session
   * of theirs (SP03 §2) — their credentials live on their own machine, so nothing is deleted here.
   */
  'people.revoke': [{ personId: Id; deleteCredentials: boolean }, true];
  /**
   * Local mode: an invite code for a new local account, valid `days` (default 7).
   * Connected (SP05 §3): the same question — "a code to hand over" — answered by the host.
   * `email` + `name` create the person and their one access code (`POST /v1/admin/people`, RF-33);
   * `personId` reissues the code of an existing person (`POST /v1/admin/people/:id/code`), revoking
   * the previous one. `days` is local-only: SP02 §3 fixes 72 h on the host.
   */
  'invites.issue': [
    { roles: Id[]; days?: number; email?: string; name?: string; personId?: Id },
    { code: string; expiresAt: string },
  ];

  'vault.list': [void, VaultItem[]];
  'vault.save': [{ toolId: Id; username: string; secret: string; label?: string }, VaultItem];
  /**
   * K5/SP02 §9, SP06 §4: the gate is the backend's — biometrics when this machine has them, the
   * person's password in `password` otherwise. Without either the call fails, which is why the page
   * may pass a password and never sees one come back.
   */
  'vault.reveal': [{ toolId: Id; password?: string }, { username: string; secret: string }];
  /**
   * K5: the same gate, with the secret going to the clipboard through the runtime instead of to the
   * page: nothing of it is returned, so a copy can never leave it in the DOM or in a variable.
   */
  'vault.copy': [{ toolId: Id; password?: string }, true];
  /**
   * K6/SP06 §5: the sharing scope of one credential, set by its owner (or by the admin for an
   * assignment). Not gated: nothing secret is shown to change it.
   */
  'vault.setScope': [{ toolId: Id; scope: ShareScope }, VaultItem];
  'vault.remove': [{ toolId: Id }, true];
  'vault.exportToFile': [{ password: string; path: string }, true];
  'vault.importFromFile': [{ password: string; path: string }, { items: number }];

  /**
   * K4/SP06 §5: everyone the scope of this credential could reach, each with the state of their key
   * and whether the scope allows them — what the send dialog lists. The host repeats the same check.
   */
  'shares.recipients': [{ toolId: Id }, ShareRecipient[]];
  /** K4/SP06 §4: seals one copy per recipient and sends them. Gated (`password`), as `vault.reveal`. */
  'shares.send': [{ toolId: Id; to: Id[]; password?: string }, { sent: number }];
  /** K4: the open, unexpired shares addressed to me — metadata only, no sealed copy, no secret. */
  'shares.inbox': [void, InboxShare[]];
  /**
   * K4/SP06 §4: accepts one share after the gate, which lands the value in the vault bound to the
   * tool's origin. An `update` of a credential already held skips the gate: nothing is shown.
   */
  'shares.accept': [{ id: Id; password?: string }, VaultItem];
  /** K4: declines one share. Nothing secret is involved, so there is no gate. */
  'shares.decline': [{ id: Id }, true];

  'tools.state': [void, ToolsState];
  'tools.open': [{ id: Id }, ToolsState];
  'tools.openView': [{ toolId: Id; index: number }, ToolsState];
  'tools.close': [{ id: Id }, ToolsState];
  'tools.reload': [{ id: Id }, ToolsState];

  'events.list': [EventFilter, AuditEvent[]];
  /** SP04 §5: the sent/pending counters of Settings → Activity (`{ sent: 0, pending: 0 }` with no host). */
  'events.syncStatus': [void, EventSyncStatus];
  'events.exportToFile': [{ path: string }, true];

  /** `nod.*`, not `app.*`: the runtime has builtins under `app.` that would win (bridge.js:3156). */
  'nod.info': [void, AppInfo];
  /**
   * SP05 §6: the app icon this machine shows and whether a guild icon is available to show. Read by
   * Settings → Account (the choice) and Settings → Hosts (the admin's card).
   */
  'nod.appIcon': [void, AppIconState];
  /**
   * SP05 §6: stores the choice and applies it — `guild` needs a verified guild icon on disk, and
   * `default` puts the bundle icon back. Whole app, not one window, so nothing else moves.
   */
  'nod.setAppIcon': [{ choice: AppIconChoice }, AppIconState];
  'nod.checkUpdate': [void, UpdateInfo];
  'nod.installUpdate': [void, boolean];
  /** RF-55: hides the notice of one version on this machine; only the version string is stored. */
  'nod.dismissUpdate': [{ version: string }, true];
  'nod.quit': [void, true];

  /** The only call accepted from tool windows (the tool's origin). */
  'login.report': [{ state: ReportState }, true];
}

export type Method = keyof ApiContract;
export type Params<M extends Method> = ApiContract[M][0];
export type Result<M extends Method> = ApiContract[M][1];

/** What the login adapter script reports back (canonico §11). */
export type ReportState = 'no-form' | 'form' | 'filled' | 'error';

/** What a `nod://join` link carries (SP04 §1.3): no secret — an address, a fingerprint, a code. */
export interface JoinInvite {
  address: string;
  fingerprint: string;
  code: string | null;
}

/** Events the backend pushes to the main window (app.push). */
export interface PushEvents {
  session: SessionState;
  tools: ToolsState;
  catalog: null;
  /**
   * Connected mode: `host.state` changed or was pushed by the sync (B4). The sidebar's `offline`
   * badge and Settings → Hosts both read it.
   */
  host: HostState;
  /**
   * A `nod://join?host=…&fp=…[&code=…]` link arrived (SP04 §1.3): the join screen opens with the
   * invite's host, fingerprint and code prefilled. Delivered again on the next `session.state`
   * until the join flow picks it up with `host.discover`.
   */
  join: JoinInvite | null;
  /** a global shortcut asked the main window to open the command palette */
  palette: null;
  /**
   * RF-55: the automatic check of the release channel (backend/main.ts). The notice to show, or
   * `null` when there is nothing to announce — no channel, no newer release, or that version was
   * dismissed on this machine. A dismissed version never comes back through here; Settings' manual
   * check (`nod.checkUpdate`) answers with it regardless.
   */
  update: UpdateInfo | null;
}

/** The single management window (canonico §7). */
export const MAIN_WINDOW = 'main';

/**
 * Window ids never contain `:` — the runtime finds the calling window by the text before the
 * first `:` of the call id (`~/.tinyjs/runtime/bridge.js:3181`, tinyjs 0.57.2), so `tool:x` would
 * reach the backend as `tool`. `_` never appears in an entry id (slug), so it separates cleanly.
 */
export const TOOL_WINDOW_PREFIX = 'tool_';

/** Window id of a tool's main window, or of one of its views in 'window' mode. */
export function toolWindowId(toolId: Id, view?: number): string {
  return view === undefined ? TOOL_WINDOW_PREFIX + toolId : `${TOOL_WINDOW_PREFIX}${toolId}_${view}`;
}

/** Tool that owns a window; `null` if the window is not a tool window. */
export function toolOfWindow(windowId: string): Id | null {
  if (!windowId.startsWith(TOOL_WINDOW_PREFIX)) return null;
  const id = windowId.slice(TOOL_WINDOW_PREFIX.length).split('_')[0];
  return id === undefined || id === '' ? null : id;
}
