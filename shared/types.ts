// Domain and API contract for Bond.
// Concepts: docs/canonico.md (§7 window model, §8 catalog, §9 identity, §10 roles, §11 vault,
// §13 audit, §16 data). Module signatures: docs/arquitetura.md.
// Imported by the backend, the frontend and the tests: nothing here may depend on `tjs`, `tiny`
// or the DOM.

export type Id = string;

// ---------------------------------------------------------------- catalog

export interface View {
  label: string;
  url: string;
  /** 'window' opens its own tool window; 'navigate' navigates the tool's main window */
  mode: 'window' | 'navigate';
}

/** Optional override of the login cascade (canonico §8). Absent = default cascade. */
export interface AuthOverride {
  /** never fill a form in this tool */
  noFill?: boolean;
}

export interface Entry {
  /** slug: ^[a-z0-9][a-z0-9-]{0,39}$ */
  id: Id;
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
  /** key of the item in the OS keychain: bond.cred.<person>.<tool> */
  keychainKey: string;
  createdAt: string;
  updatedAt: string;
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
  | 'update';

/** Result of the login cascade (canonico §8, §11). */
export type LoginResult = 'session' | 'filled' | 'provider' | 'manual' | 'failed';

export interface AuditEvent {
  id: number;
  at: string;
  personId: Id | null;
  toolId: Id | null;
  type: EventType;
  /** origin + path only — never query string or fragment (they may carry tokens) */
  url: string | null;
  result: string | null;
  detail: string | null;
}

export interface EventFilter {
  personId?: Id;
  toolId?: Id;
  result?: string;
  limit?: number;
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
  'session.changePassword': [{ current: string; next: string }, true];
  'session.lock': [void, SessionState];

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
  'people.revoke': [{ personId: Id; deleteCredentials: boolean }, true];
  'invites.issue': [{ roles: Id[]; days?: number }, { code: string; expiresAt: string }];

  'vault.list': [void, VaultItem[]];
  'vault.save': [{ toolId: Id; username: string; secret: string; label?: string }, VaultItem];
  'vault.reveal': [{ toolId: Id }, { username: string; secret: string }];
  'vault.remove': [{ toolId: Id }, true];
  'vault.exportToFile': [{ password: string; path: string }, true];
  'vault.importFromFile': [{ password: string; path: string }, { items: number }];

  'tools.state': [void, ToolsState];
  'tools.open': [{ id: Id }, ToolsState];
  'tools.openView': [{ toolId: Id; index: number }, ToolsState];
  'tools.close': [{ id: Id }, ToolsState];
  'tools.reload': [{ id: Id }, ToolsState];

  'events.list': [EventFilter, AuditEvent[]];
  'events.exportToFile': [{ path: string }, true];

  /** `bond.*`, not `app.*`: the runtime has builtins under `app.` that would win (bridge.js:3156). */
  'bond.info': [void, AppInfo];
  'bond.checkUpdate': [void, UpdateInfo];
  'bond.installUpdate': [void, boolean];
  /** RF-55: hides the notice of one version on this machine; only the version string is stored. */
  'bond.dismissUpdate': [{ version: string }, true];
  'bond.quit': [void, true];

  /** The only call accepted from tool windows (the tool's origin). */
  'login.report': [{ state: ReportState }, true];
}

export type Method = keyof ApiContract;
export type Params<M extends Method> = ApiContract[M][0];
export type Result<M extends Method> = ApiContract[M][1];

/** What the login adapter script reports back (canonico §11). */
export type ReportState = 'no-form' | 'form' | 'filled' | 'error';

/** Events the backend pushes to the main window (app.push). */
export interface PushEvents {
  session: SessionState;
  tools: ToolsState;
  catalog: null;
  /** a global shortcut asked the main window to open the command palette */
  palette: null;
  /**
   * RF-55: the automatic check of the release channel (backend/main.ts). The notice to show, or
   * `null` when there is nothing to announce — no channel, no newer release, or that version was
   * dismissed on this machine. A dismissed version never comes back through here; Settings' manual
   * check (`bond.checkUpdate`) answers with it regardless.
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
