// Backend entry point of Bond (docs/arquitetura.md §4): opens the database, applies the bundled
// seed and wires session, vault and tool windows. It exports the `api` (every key of `ApiContract`,
// with the §2 window guard) and the runtime hooks.
// No secret crosses this frontier: only `vault.reveal` returns a credential, and no secret ever
// enters an event, `store` or a log.
import { generateInviteCode, hashInviteCode, inviteIsValid, randomSalt, verifyStoredPassword } from '../shared/auth';
import { auditUrl, exportSeed, originOf, validateEntry, validateSeed, visibleEntries } from '../shared/catalog';
import { toBase64url } from '../shared/encoding';
import { HOST_ROUTES } from '../shared/host-api';
import { MAIN_WINDOW, toolOfWindow } from '../shared/types';
import type {
  AppInfo,
  Entry,
  EntryDetails,
  EventFilter,
  HostState,
  Id,
  InviteSeed,
  JoinInvite,
  LoginResult,
  Method,
  Person,
  Probe,
  PushEvents,
  RawIcon,
  ReportState,
  Result,
  Role,
  Seed,
  SessionState,
  ToolsState,
  UpdateInfo,
} from '../shared/types';
import type {
  ActivateRequest,
  Device,
  LoginRequest,
  PasswordChangeRequest,
  SaltResponse,
  TokenResponse,
} from '../shared/host-api';
import { createConnectedCatalog } from './connected-catalog';
import { hostAdminFor, orgViewsOf } from './host-admin';
import { createHostClient } from './host-client';
import { createIcons } from './icons';
import { probe } from './probe-net';
import { createRepo, LegacyDatabaseError } from './repo';
import { applyBundledSeed, gateOrigins, importSeedFile, storedSeedVersion } from './seed';
import { createSession } from './session';
import { openSqlite } from './sqlite';
import { createSync } from './sync';
import { createToolWindows } from './tool-windows';
import { createVault } from './vault';
import type { ConnectedCatalog } from './connected-catalog';
import type { HostClient, HostConnection, HostDiscovery } from './host-client';
import type { Icons } from './icons';
import type { Repo } from './repo';
import type { Session } from './session';
import type { Sync } from './sync';
import type { ToolWindows } from './tool-windows';
import type { Vault } from './vault';

type System = 'macos' | 'windows' | 'linux';

let repo: Repo | null = null;
let session: Session | null = null;
let vault: Vault | null = null;
let windows: ToolWindows | null = null;
let icons: Icons | null = null;
let runtime: TinyApp | null = null;
/** The host client (B1): no I/O of its own, and the only path to a host (RF-30). */
let client: HostClient | null = null;
/** The sync timer and its state (B4). Built with the database, started and stopped by the session. */
let sync: Sync | null = null;
/**
 * The effective catalog (B5): the snapshot's entries and roles while a `host` row exists, the local
 * tables otherwise (SP05 §2). Re-derived wherever the row can have moved.
 */
let connected: ConnectedCatalog | null = null;
/** Whether the last derivation found a `host` row: the catalog layer's local/connected switch. */
let connectedMode = false;
/** The entries the effective catalog holds while connected — empty until the first snapshot reads. */
let connectedEntries: Entry[] = [];
/**
 * SP04 §1.3's `bond://join` link, kept until the join flow picks it up (`host.discover`) or a host
 * is added. Not a secret — the address, the fingerprint and the code the person was given — and it
 * never goes to a file, an event or `store`.
 */
let pendingJoin: JoinInvite | null = null;
let system: System = 'linux';
let tray = false;
let bundledSeed: Seed | null = null;
/** Why the database could not be opened, when it could not: every handler answers with it (§4). */
let bootFailure: string | null = null;
/** RF-55: the notice the main window shows, `null` while there is nothing to announce. */
let updateNotice: UpdateInfo | null = null;

/** How often the background check of the update channel runs (RF-55). */
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
/** The window needs a moment before it can take a push, so the first check waits for it (RF-55). */
const UPDATE_FIRST_CHECK_MS = 5_000;
/** `store` key of the version whose notice was dismissed: one version string, never a secret. */
const DISMISSED_UPDATE_KEY = 'dismissed_update';

/** Data URI of each entry's icon: the tool-window API asks for an icon synchronously. */
const iconCache = new Map<Id, string>();

export async function init(app: TinyApp): Promise<void> {
  runtime = app;
  const paths = await app.paths();
  // `paths.data` is per app and is not created by the runtime (`docs/tinyjs.md` §1); without this
  // SQLite fails.
  await tjs.makeDir(paths.data, { recursive: true });

  let database: Repo;
  try {
    database = await openDatabase(paths.data);
  } catch (error) {
    // The window still opens: `session.state` and every other handler answer with the reason
    // instead of a raw SQLite message, and nothing else is wired (there is no database to wire).
    bootFailure = `Bond couldn't open its database: ${reason(error)}`;
    return;
  }
  repo = database;
  database.ensureAdminRole();

  const store = createIcons(`${paths.data}/icons`);
  icons = store;

  // §2: the capabilities are read once here; an absent key means supported.
  const capabilities = await app.system.capabilities();
  system = app.system.os();
  bundledSeed = await readBundledSeed(paths.resources);

  try {
    await applyBundledSeed(database, paths.resources, store);
  } catch (error) {
    // A broken seed does not keep the app from opening: the catalog already in the database stands.
    database.addEvent({
      personId: null,
      toolId: null,
      type: 'seed_applied',
      url: null,
      result: 'failed',
      detail: reason(error),
    });
  }
  // SP05 §2: the effective catalog — the snapshot's org half while a `host` row exists, the local
  // tables otherwise. Derived here, before anything reads an entry, and again wherever the row can
  // have moved (an unlock, a join, a removal, every state a sync publishes).
  connected = createConnectedCatalog({ now: () => Date.now() });
  refreshConnectedCatalog();
  await refreshIcons();

  session = createSession({
    repo: database,
    keychain: app.secrets,
    store: app.store,
    authenticate: (request: string) => app.authenticate(request),
    biometricAvailable: system !== 'linux' && supported(capabilities, 'authenticate'),
  });
  // SP02 §8/RF-38: the vault reads the entry of a credential through the effective catalog, so the
  // origin it records is the entry's own url at save time — the host entry's, while connected.
  vault = createVault({ repo: { ...database, entry: (id) => catalogEntryOf(id) }, keychain: app.secrets });
  // Connected mode (SP05 §1): the host client holds no state and makes no call of its own, and the
  // sync loop only ever asks it for a connection built from the `host` row (RF-30).
  client = createHostClient({ fetch, keychain: app.secrets });
  sync = createSync({
    repo: database,
    connection: () => connectionOf(),
    now: () => Date.now(),
    onState: (state) => {
      push('host', state);
      // SP05 §2: a run that moved the snapshot moves the catalog with it, and the page hears it once
      // — a `304` advances `last_sync_at` alone, and the catalog it would push is the same one.
      if (refreshConnectedCatalog()) afterCatalogChange();
    },
    onSignedOut: () => {
      // SP04 §3/RF-39: the session is gone — the bearer is dropped and the page asks to sign in.
      // `host.last_error` already carries `SIGNED_OUT_ERROR`, which is what the state reports.
      const connection = connectionOf();
      if (connection !== null) void connection.forgetToken();
    },
    setInterval: (run, ms) => setInterval(run, ms),
    // `Sync` keeps its handle opaque (`unknown`); the runtime's `clearInterval` takes back the id
    // its own `setInterval` answered.
    clearInterval: (handle) => clearInterval(handle as number),
  });
  windows = createToolWindows(app, {
    entries: () => visibleEntriesOf(),
    icon: (id) => iconCache.get(id) ?? null,
    credential: (toolId) => credentialOf(toolId),
    vaultOrigin: (toolId) => vaultOriginOf(toolId),
    record: (event) => {
      // The tool windows do not know the session: this side fills the person in (canonico §13).
      const person = currentPerson();
      database.addEvent({
        ...event,
        personId: event.personId ?? (person === null ? null : person.id),
      });
    },
    store: app.store,
    os: system,
    hotkeys: supported(capabilities, 'hotkey'),
  });

  app.window(MAIN_WINDOW).setMinSize(760, 500);
  tray = setTray(app, paths.resources, supported(capabilities, 'tray'));
  // With a tray, closing the main window hides it and the tool windows keep running (RF-15); with
  // no tray the main window's own close quits the app.
  if (tray) app.win.setHideOnClose(true);

  // RF-55: armed last, so the check never sits on the boot path; without a channel it is a no-op.
  startUpdateWatch();
}

// ---------------------------------------------------------------- database boot

/**
 * §4: opens `bond.db` and brings it to the current schema. A database written by Bond v1 is moved
 * aside — nothing is deleted — and a fresh one takes its place, with the name of the moved file
 * kept in `meta.legacy_database` so the owner can find it.
 */
async function openDatabase(directory: string): Promise<Repo> {
  const path = `${directory}/bond.db`;
  const handle = openSqlite(path);
  try {
    const repository = createRepo(handle);
    repository.migrate();
    return repository;
  } catch (error) {
    // The handle has to go before the file moves: SQLite would keep writing to the old inode.
    handle.close();
    if (!(error instanceof LegacyDatabaseError)) throw error;
    const moved = await moveDatabaseAside(directory);
    const repository = createRepo(openSqlite(path));
    repository.migrate();
    repository.setMeta('legacy_database', moved);
    return repository;
  }
}

/**
 * Renames `bond.db` and the WAL siblings that exist to `bond.v1-<yyyyMMddHHmmss>.db` — in UTC, the
 * clock the whole app keeps — in the same directory. Answers the new name. Nothing is deleted: the
 * moved files are the whole v1 database, for whoever wants to look at it.
 */
async function moveDatabaseAside(directory: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const moved = `bond.v1-${stamp}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${directory}/bond.db${suffix}`;
    if (await fileExists(from)) await tjs.rename(from, `${directory}/${moved}${suffix}`);
  }
  return moved;
}

/** `tjs.stat` rejects with code `ENOENT` when the path is missing (`backend/tjs.d.ts`). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await tjs.stat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------- derived state

function currentPerson(): Person | null {
  return session === null ? null : session.current();
}

function visibleEntriesOf(): Entry[] {
  const r = repo;
  const person = currentPerson();
  if (r === null || person === null) return [];
  // SP05 §2: while a `host` row exists the entries are the snapshot's, in SP05 §4's order; without
  // one they are the local catalog's, untouched.
  if (connectedMode) return connectedEntries;
  return visibleEntries(r.listEntries(), person);
}

/**
 * SP05 §2: the effective catalog of the `host` row the caller just read — the snapshot while one
 * exists, the local tables otherwise. It is derived wherever the row can have moved (the boot, an
 * unlock, a join, a removal and every state the sync publishes) and answers whether the entries,
 * the roles and the person the host knows changed since the last derivation.
 */
function refreshConnectedCatalog(): boolean {
  const r = repo;
  const catalog = connected;
  if (r === null || catalog === null) return false;
  const record = r.hostRecord();
  const changed = catalog.refresh(record);
  connectedMode = record !== null;
  connectedEntries = catalog.entries();
  return changed;
}

/** What a changed effective catalog moves: the sidebar's icons, the open tool windows, the page. */
function afterCatalogChange(): void {
  cacheConnectedIcons();
  const open = windows;
  if (open !== null) open.reconcile();
  push('catalog', null);
  push('tools', toolsState());
}

/** The effective entry of this id: the connected catalog's while one is in force, the local's else. */
function catalogEntryOf(id: Id): Entry | null {
  const r = repo;
  if (r === null) return null;
  if (connectedMode) return connectedEntries.find((entry) => entry.id === id) ?? null;
  return r.entry(id);
}

function toolsState(): ToolsState {
  return windows === null ? { tools: [] } : windows.state();
}

function credentialOf(toolId: Id): Promise<{ username: string; secret: string } | null> {
  const person = currentPerson();
  const store = vault;
  return store === null || person === null ? Promise.resolve(null) : store.read(person.id, toolId);
}

/** The origin the person's credential for this tool was saved for; null without an item (RF-38). */
function vaultOriginOf(toolId: Id): string | null {
  const r = repo;
  const person = currentPerson();
  return r === null || person === null ? null : r.vaultOrigin(person.id, toolId);
}

/**
 * The entries the page lists (SP05 §3 `catalog.list`), in `visibleEntriesOf`'s order. A connected
 * entry carries the host's icon inside the snapshot; a local one keeps it in the store, addressed by
 * the hash of the row (`canonico §8`; `Entry.icon` at runtime is a data URI or null).
 */
async function listedEntries(): Promise<Entry[]> {
  const entries = visibleEntriesOf();
  if (connectedMode) {
    return entries.map((entry) => ({
      ...entry,
      icon: typeof entry.icon === 'string' ? entry.icon : null,
    }));
  }
  const store = icons;
  return store === null ? entries : await localEntriesWithIcons(entries, store);
}

/**
 * The local rows as the page and B8a read them: each icon leaves the store as a data URI (`canonico
 * §8`). A connected entry never comes through here — its icon travels inside the snapshot.
 */
async function localEntriesWithIcons(entries: Entry[], store: Icons): Promise<Entry[]> {
  const r = repo;
  if (r === null) return entries;
  return Promise.all(
    entries.map(async (entry) => {
      const hash = r.iconHash(entry.id);
      return { ...entry, icon: hash === null ? null : await store.dataUri(hash) };
    }),
  );
}

/** SP05 §2: the guild's roles while connected, the local `role` table (untouched) otherwise. */
function rolesOf(): Role[] {
  const r = required(repo, 'roles.list');
  const catalog = connected;
  if (connectedMode && catalog !== null) return catalog.roles();
  return r.listRoles();
}

/** The page and the tool windows read an entry's icon as a data URI (canonico §8). */
async function refreshIcons(): Promise<void> {
  const r = repo;
  const store = icons;
  iconCache.clear();
  if (r === null || store === null) return;
  for (const entry of r.listEntries()) {
    const hash = r.iconHash(entry.id);
    if (hash === null) continue;
    const uri = await store.dataUri(hash);
    if (uri !== null) iconCache.set(entry.id, uri);
  }
  // Last, so that a connected entry answers with its own icon when it shares an id with a local one.
  cacheConnectedIcons();
}

/** The connected entries carry their icon in the snapshot itself: a data URI, or nothing to show. */
function cacheConnectedIcons(): void {
  if (!connectedMode) return;
  for (const entry of connectedEntries) {
    if (typeof entry.icon === 'string' && entry.icon.startsWith('data:')) iconCache.set(entry.id, entry.icon);
  }
}

async function readBundledSeed(resourcesDir: string | null): Promise<Seed | null> {
  if (resourcesDir === null) return null;
  try {
    const bytes = await tjs.readFile(`${resourcesDir}/seed.json`);
    return validateSeed(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null; // dev without a seed, or an unreadable one: the origin gate stays empty
  }
}

/** §2: `capabilities()` lists only the exceptions — an absent key means supported. */
function supported(capabilities: Record<string, unknown>, key: string): boolean {
  return capabilities[key] !== false;
}

/** §4: the tray menu and the per-OS icon; `false` when this machine has no tray (RF-15). */
function setTray(app: TinyApp, resources: string | null, available: boolean): boolean {
  if (!available) return false;
  try {
    app.tray.set({
      title: 'Bond',
      icon: trayIcon(resources),
      tooltip: 'Bond',
      menu: [
        { id: 'open', label: 'Open Bond' },
        { id: 'lock', label: 'Lock' },
        { separator: true },
        { id: 'quit', label: 'Quit Bond' },
      ],
    });
    return true;
  } catch {
    // Linux without AppIndicator (or any platform that refuses the icon): no tray, so closing the
    // main window quits the app.
    return false;
  }
}

function trayIcon(resources: string | null): string {
  if (system === 'macos') return 'sf:rectangle.stack';
  if (system === 'windows') return 'emoji:🔗';
  return `${resources === null ? '' : resources}/tray.png`;
}

// ---------------------------------------------------------------- §2 guard

type Handler<M extends Method> = (
  params: unknown,
  app: TinyApp,
  meta: TinyApiMeta,
) => Result<M> | Promise<Result<M>>;

/** The only methods an unlocked admin calls (§2). */
const ADMIN_ONLY: Partial<Record<Method, true>> = {
  'catalog.get': true,
  'catalog.probe': true,
  'catalog.save': true,
  'catalog.remove': true,
  'catalog.exportToFile': true,
  'catalog.importFromFile': true,
  'roles.save': true,
  'roles.remove': true,
  'roles.grant': true,
  'people.list': true,
  'people.setRoles': true,
  'people.revoke': true,
  'invites.issue': true,
  'host.bootstrap': true,
  'events.list': true,
  'events.syncStatus': true,
  'events.exportToFile': true,
  'bond.installUpdate': true,
};

/** The only methods that work with the session locked (§2); the rest require an unlock. */
const WITHOUT_SESSION: Partial<Record<Method, true>> = {
  'session.state': true,
  'session.createAccount': true,
  'session.unlock': true,
  'session.unlockBiometric': true,
  // SP05 §3: the first run has no account at all, and a join is what creates the connected one.
  'host.discover': true,
  'host.activate': true,
  'host.signIn': true,
  'bond.info': true,
  'bond.quit': true,
};

/**
 * §2: every method but `login.report` comes from the main window. `login.report` comes from a tool
 * window, and when `meta.origin` is filled in (macOS) only from that tool's own origin.
 */
function guarded<M extends Method>(method: M, handler: Handler<M>): TinyApiHandler {
  return (params: unknown, app: TinyApp, meta: TinyApiMeta) => {
    // Without a database there is nothing any method can answer; the window shows this instead of
    // the raw SQLite message.
    if (bootFailure !== null) throw new Error(bootFailure);
    if (method === 'login.report') {
      const toolId = toolOfWindow(meta.window);
      if (toolId === null) throw new Error('login.report only comes from a tool window');
      requireToolOrigin(toolId, meta.origin);
      return handler(params, app, meta);
    }
    if (meta.window !== MAIN_WINDOW) throw new Error('this method is only available in the main window');

    if (WITHOUT_SESSION[method] !== true) {
      const person = unlockedPerson(method);
      if (ADMIN_ONLY[method] === true && !person.admin) throw new Error('only an admin can do this');
    }
    return handler(params, app, meta);
  };
}

function requireToolOrigin(toolId: Id, origin: string | undefined): void {
  if (origin === undefined || origin === '') return; // Windows/Linux do not stamp the origin
  const entry = required(repo, 'login.report').entry(toolId);
  if (entry === null) throw new Error('unknown tool');
  if (origin !== originOf(entry.url)) throw new Error('login.report only comes from the tool origin');
}

function unlockedPerson(where: string): Person {
  const person = required(session, where).current();
  if (person === null) throw new Error('session is locked');
  return person;
}

// ---------------------------------------------------------------- input helpers

function required<T>(value: T | null, where: string): T {
  if (value === null) throw new Error(`${where}: Bond has not finished starting`);
  return value;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function parameters(params: unknown, message: string): Record<string, unknown> {
  return params === undefined || params === null ? {} : object(params, message);
}

function text(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value;
}

function integer(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(message);
  return value;
}

function booleanValue(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message);
  return value;
}

function textList(value: unknown, message: string): Id[] {
  if (!Array.isArray(value)) throw new Error(message);
  const items: unknown[] = value;
  return items.map((item) => text(item, message));
}

function orNull(value: unknown, message: string): string | null {
  return value === undefined || value === null ? null : text(value, message);
}

function optional<T>(value: unknown, convert: (input: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : convert(value);
}

function reportState(value: unknown): ReportState {
  if (value === 'no-form' || value === 'form' || value === 'filled' || value === 'error') return value;
  throw new Error('invalid report');
}

function rawIcon(value: unknown): RawIcon {
  const raw = object(value, 'invalid icon');
  const type = raw.type;
  if (type !== 'png' && type !== 'svg' && type !== 'jpeg' && type !== 'webp') {
    throw new Error('unsupported icon type');
  }
  return { type, base64: text(raw.base64, 'invalid icon') };
}

/** `RawIcon` media types (`backend/icons.ts`'s `MIME`, which also leaves as a data URI). */
const ICON_MIME: Record<RawIcon['type'], string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * `RawIcon` → the data URI an entry's icon is at runtime (`canonico §8`), which is what the host
 * stores too (SP04 §2): a connected write sends the picked bytes as the URI of their media type.
 */
function iconDataUri(icon: RawIcon): string {
  return `data:${ICON_MIME[icon.type]};base64,${icon.base64}`;
}

function role(value: unknown): Role {
  const raw = object(value, 'invalid role');
  return {
    id: text(raw.id, 'invalid role id'),
    name: text(raw.name, 'invalid role name'),
    admin: booleanValue(raw.admin, 'invalid role'),
  };
}

function probeValue(value: unknown): Probe {
  const raw = object(value, 'invalid probe');
  const icon = raw.icon;
  return {
    url: text(raw.url, 'invalid probe'),
    origin: text(raw.origin, 'invalid probe'),
    finalUrl: text(raw.finalUrl, 'invalid probe'),
    title: orNull(raw.title, 'invalid probe'),
    icon: icon === undefined || icon === null ? null : rawIcon(icon),
    hasLoginForm: booleanValue(raw.hasLoginForm, 'invalid probe'),
    provider: orNull(raw.provider, 'invalid probe'),
  };
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

// ---------------------------------------------------------------- session and catalog effects

function push<K extends keyof PushEvents>(event: K, data: PushEvents[K]): void {
  if (runtime !== null) runtime.push(event, data);
}

/**
 * Version whose notice was dismissed on this machine, from `store`. Only the version string is
 * kept there (RF-55): no address, no token, nothing that belongs in the keychain.
 */
async function dismissedUpdate(): Promise<string | null> {
  const app = runtime;
  if (app === null) return null;
  try {
    const raw = await app.store.get(DISMISSED_UPDATE_KEY);
    return typeof raw === 'string' && raw !== '' ? raw : null;
  } catch {
    // An unreadable preference is not a reason to stop checking.
    return null;
  }
}

/**
 * RF-55: checks the release channel and pushes the notice. Nothing here blocks the boot — `init`
 * only arms the timer — and nothing here installs: installing is the person's call (A13,
 * `bond.installUpdate`). A failure turns into one audit event with the reason and nothing else.
 */
async function refreshUpdateNotice(): Promise<void> {
  const app = runtime;
  const r = repo;
  if (app === null || r === null || bundledSeed === null || bundledSeed.update === null) return;
  let info: UpdateInfo;
  try {
    info = await app.update.check();
  } catch (error) {
    // Offline is normal; the event is the whole trace of it.
    r.addEvent({
      personId: null,
      toolId: null,
      type: 'update',
      url: null,
      result: 'failed',
      detail: reason(error),
    });
    return;
  }
  const latest = info.latest;
  updateNotice =
    info.available && latest !== null && latest !== (await dismissedUpdate()) ? info : null;
  push('update', updateNotice);
}

/** RF-55: one check shortly after the launch, then one every 24 hours. Without a channel the seed
 * names, none of this runs — no address in the code, no call out of a Bond that has no channel. */
function startUpdateWatch(): void {
  if (bundledSeed === null || bundledSeed.update === null) return;
  setTimeout(() => void refreshUpdateNotice(), UPDATE_FIRST_CHECK_MS);
  setInterval(() => void refreshUpdateNotice(), UPDATE_CHECK_MS);
}

/** §4: unlocking or creating an account pushes session and tools, then restores the open tools. */
async function afterUnlock(state: SessionState): Promise<SessionState> {
  const open = required(windows, 'session');
  // SP05 §2: before anything reads an entry — a join has just added the `host` row, and the tools
  // this function pushes next come from the effective catalog.
  refreshConnectedCatalog();
  push('session', state);
  push('tools', open.state());
  await open.restore();
  push('tools', open.state());
  // RF-55: the notice the launch check already found, for the window that had not subscribed yet.
  push('update', updateNotice);
  // SP05 §3: the host state goes with the session, so the sidebar knows before any sync ran.
  push('host', hostState());
  // SP04 §3: the unlock is the first trigger of a sync. RF-30: without a `host` row there is no
  // client and no call, so `start()` is only armed when there is something to sync with.
  const running = sync;
  if (running !== null && required(repo, 'host').hostRecord() !== null) running.start();
  return state;
}

/** §4: locking closes every tool window and the popups they opened. */
function lockSession(): SessionState {
  // SP04 §3: nothing is synced while locked — the state a locked Bond shows is the cache.
  sync?.stop();
  const state = required(session, 'session.lock').lock();
  required(windows, 'session.lock').closeAll();
  push('session', state);
  push('tools', toolsState());
  return state;
}

/**
 * §4: anything that changed the catalog, the roles, a grant or the people reloads the session,
 * reconciles the tool windows and pushes catalog, tools and session — in that order.
 */
async function afterChange(): Promise<void> {
  const s = required(session, 'catalog');
  s.refresh();
  await refreshIcons();
  const open = windows;
  if (open !== null) open.reconcile();
  push('catalog', null);
  push('tools', toolsState());
  push('session', await s.state());
  // SP04 §3: an admin write is one of the triggers of a sync. The write itself still goes to the
  // local catalog; routing it to the host is B6. `afterWrite` is a no-op while stopped.
  if (sync !== null) sync.afterWrite();
}

/**
 * SP05 §3–§4: an admin write that went to the host instead of the local tables. The change is on the
 * host the moment the route answers, so what is left is to make it visible: `afterChange()` reloads
 * this side and asks for a sync of its own, and the run is awaited so the `catalog.list` the Tools
 * tab reads right after the call already carries the new row. A host that cannot be reached leaves
 * the write where it landed and `host.state` says why — never a failed admin method.
 */
async function afterHostWrite(): Promise<void> {
  await afterChange();
  const running = sync;
  const r = repo;
  if (running === null || r === null || r.hostRecord() === null) return;
  await running.syncNow();
}

// ---------------------------------------------------------------- connected mode (SP05, SP04)

/**
 * SP04 §1.3: `bond://join?host=<address>&fp=<fingerprint>[&code=<code>]`. Every other link — another
 * scheme, another host, a missing `host` or `fp` — answers null and the app ignores it.
 */
function parseJoinLink(url: string): JoinInvite | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'bond:') return null;
  // `bond://join` puts the action in the authority; a link typed as `bond:join` has it in the path.
  const action = parsed.host !== '' ? parsed.host : parsed.pathname.replaceAll('/', '');
  if (action.toLowerCase() !== 'join') return null;
  const address = parsed.searchParams.get('host');
  const fingerprint = parsed.searchParams.get('fp');
  if (address === null || address.trim() === '') return null;
  if (fingerprint === null || fingerprint.trim() === '') return null;
  return { address, fingerprint, code: parsed.searchParams.get('code') };
}

/**
 * RF-30: a connection exists only while a `host` row exists. Every host call the backend makes past
 * the two auth calls of a join goes through this one builder, and the client holds the bearer in
 * the keychain (SP02 §5) — never in a parameter, a row or an event.
 */
function connectionOf(): HostConnection | null {
  const r = repo;
  const c = client;
  if (r === null || c === null) return null;
  const row = r.hostRecord();
  if (row === null) return null;
  return c.connect({
    address: row.address,
    kid: row.kid,
    publicKey: row.publicKey,
    personId: row.personId,
  });
}

/**
 * The public auth routes of SP02 §4 (`salt`, `activate`, `setup`, `login`) carry no bearer, and the
 * person is known only once they answer: a connection built before that names no `personId`, so the
 * keychain has no item under its key and the request goes out without an `Authorization` header
 * (`backend/host-client.ts`). It is never used for a call that needs a session.
 */
function preAuthConnection(found: HostDiscovery): HostConnection {
  return required(client, 'host').connect({
    address: found.address,
    kid: found.pin.kid,
    publicKey: found.pin.ed25519Public,
    personId: '',
  });
}

/** SP03 §2's `device`: the host shows it in the session list (O1). None of it is a secret. */
async function deviceOf(): Promise<Device> {
  const app = required(runtime, 'host');
  const info = await app.info();
  let arch: string | null = null;
  try {
    arch = (await app.system.info()).arch;
  } catch {
    // A runtime that does not answer `system.info` still has an OS: the name is coarser, not wrong.
    arch = null;
  }
  return { name: arch === null ? system : `${system} ${arch}`, os: system, appVersion: info.version };
}

/** SP05 §3 `host.state`: the one guild, or the `none` of a Bond that was never connected. */
function hostState(): HostState {
  return required(sync, 'host.state').state();
}

/** The invites that still travel in an export: unused and unexpired (canonico §9). */
function activeInvites(r: Repo, now: Date): InviteSeed[] {
  return r
    .listInvites()
    .filter((invite) => inviteIsValid(invite, now))
    .map((invite) => ({
      codeHash: invite.codeHash,
      roles: invite.roles,
      expiresAt: invite.expiresAt,
    }));
}

/** §4: the vault export checks the local password first (the session is already unlocked). */
async function confirmLocalPassword(r: Repo, person: Person, password: string): Promise<void> {
  // The row carries a v1 PBKDF2 hash or B3's V2 check (SP02 §6): `personAuthByEmail` is the read
  // that returns either, and `verifyStoredPassword` dispatches on it.
  const record = r.personAuthByEmail(person.email);
  if (record === null) throw new Error('invalid credentials');
  if (!(await verifyStoredPassword(password, record.password))) throw new Error('incorrect password');
}

async function writeTextFile(path: string, content: string): Promise<true> {
  try {
    await tjs.writeFile(path, content);
  } catch (error) {
    throw new Error(`couldn't write the file: ${reason(error)}`);
  }
  return true;
}

async function readTextFile(path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await tjs.readFile(path));
  } catch (error) {
    throw new Error(`couldn't read the file: ${reason(error)}`);
  }
}

/**
 * Most frequent result among the last login events of a tool; on a tie the most recent one, which
 * is how `repo.loginResults` orders them (newest first).
 */
function usualLogin(results: LoginResult[]): LoginResult | null {
  const counts = new Map<LoginResult, number>();
  let best: LoginResult | null = null;
  let bestCount = 0;
  for (const result of results) {
    const count = (counts.get(result) ?? 0) + 1;
    counts.set(result, count);
    if (count > bestCount) {
      best = result;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------- api

const methods: { [M in Method]: Handler<M> } = {
  // -------------------------------------------------------------- session
  'session.state': () => {
    // SP04 §1.3: the page subscribes before it calls this at boot, so a `bond://join` link that
    // arrived while it was loading is handed over here.
    if (pendingJoin !== null) push('join', pendingJoin);
    return required(session, 'session.state').state();
  },

  'session.createAccount': async (params) => {
    const p = parameters(params, 'invalid account');
    return afterUnlock(
      await required(session, 'session.createAccount').createAccount({
        email: text(p.email, 'invalid email'),
        name: text(p.name, 'invalid name'),
        password: text(p.password, 'invalid password'),
        code: optional(p.code, (value) => text(value, 'invalid invite')),
      }),
    );
  },

  'session.unlock': async (params) => {
    const p = parameters(params, 'invalid credentials');
    return afterUnlock(
      await required(session, 'session.unlock').unlock({
        email: text(p.email, 'invalid credentials'),
        password: text(p.password, 'invalid credentials'),
      }),
    );
  },

  'session.unlockBiometric': async () =>
    afterUnlock(await required(session, 'session.unlockBiometric').unlockBiometric()),

  'session.enableBiometric': (params) => {
    const p = parameters(params, 'invalid password');
    return required(session, 'session.enableBiometric').enableBiometric(
      text(p.password, 'invalid password'),
    );
  },

  'session.changePassword': async (params): Promise<true> => {
    const p = parameters(params, 'invalid passwords');
    const connection = connectionOf();
    // SP02 §7: when a host is connected, the host rewrites its salt and hash **first**; only then
    // does the local verifier follow. The request carries the two `authKey`s, never a password.
    await required(session, 'session.changePassword').changePassword(
      text(p.current, 'invalid current password'),
      text(p.next, 'invalid new password'),
      connection === null
        ? undefined
        : async (request: PasswordChangeRequest): Promise<void> => {
            await connection.request('POST', HOST_ROUTES.authPassword, request);
          },
    );
    return true;
  },

  'session.lock': () => lockSession(),

  // -------------------------------------------------------------- host (connected mode)
  'host.state': () => hostState(),

  'host.discover': async (params) => {
    // SP04 §1 steps 1–4: nothing is written — the page shows the guild and the fingerprint.
    const found = await required(client, 'host.discover').discover(
      text(parameters(params, 'invalid address').address, 'invalid address'),
    );
    // SP04 §1.3: the flow picked the invite up, so it is not offered again on the next call.
    pendingJoin = null;
    return { guild: found.document.guild, fingerprint: found.fingerprint };
  },

  'host.activate': async (params) => {
    const c = required(client, 'host.activate');
    const r = required(repo, 'host.activate');
    const s = required(session, 'host.activate');
    const p = parameters(params, 'invalid join');
    const address = text(p.address, 'invalid address');
    const fingerprint = text(p.fingerprint, 'invalid fingerprint');
    const email = text(p.email, 'invalid email').trim();
    const code = text(p.code, 'invalid code');
    const password = text(p.password, 'invalid password');
    const name = optional(p.name, (value) => text(value, 'invalid name'));

    // SP05 §2 keeps one guild at a time. Replacing the row here would drop the current host's
    // bearer and snapshot without a word, so the person removes the host first.
    if (r.hostRecord() !== null) {
      throw new Error('Bond is already connected to a host — remove it first');
    }

    // SP04 §1.3: the invite's `fp` must be the key the host answers. A mismatch throws here, before
    // any request past the discovery, and stores nothing.
    const found = await c.discover(address, { fingerprint });
    const pre = preAuthConnection(found);
    // SP02 §4: the host's iteration count for this derivation (it answers for any email).
    const published = await pre.request<SaltResponse>('POST', HOST_ROUTES.authSalt, { email });
    // SP02 §1: at activation the Bond chooses the person's salt. SP02 §7's reset is a new salt, so
    // the one the host answers is only read, never stored — another machine's cached salt is what
    // notices a reset, and it must never match by accident.
    const salt = randomSalt();
    const keys = await s.deriveFor(password, salt, published.iterations);

    const body: ActivateRequest = {
      email,
      code,
      salt,
      // SP02 §1–§2: only this one derived key travels; the password stays on this machine.
      authKey: toBase64url(keys.authKey),
      device: await deviceOf(),
    };
    const setup = name !== undefined;
    // SP02 §3: the setup code creates the first admin; an access code redeems one person's row.
    const opened = await pre.request<TokenResponse>(
      'POST',
      setup ? HOST_ROUTES.authSetup : HOST_ROUTES.authActivate,
      setup ? { ...body, name } : body,
    );

    const connection = c.connect({
      address: found.address,
      kid: found.pin.kid,
      publicKey: found.pin.ed25519Public,
      personId: opened.personId,
    });
    const state = await s.adoptConnectedAccount({
      personId: opened.personId,
      email,
      // The host knows the person's name; an access-code activation learns it from the first
      // snapshot, and the local row carries the email until then.
      name: name ?? email,
      password,
      salt,
      iterations: published.iterations,
      // An access-code activation says nothing about the roles: the snapshot fills them (B4/B5).
      admin: setup,
    });
    await connection.saveToken(opened.token);
    r.saveHost({
      address: found.address,
      guild: found.document.guild,
      kid: found.pin.kid,
      publicKey: found.pin.ed25519Public,
      personId: opened.personId,
      salt,
      addedAt: new Date().toISOString(),
    });
    pendingJoin = null;
    return afterUnlock(state);
  },

  'host.signIn': async (params) => {
    const c = required(client, 'host.signIn');
    const r = required(repo, 'host.signIn');
    const s = required(session, 'host.signIn');
    const p = parameters(params, 'invalid sign-in');
    const address = text(p.address, 'invalid address');
    const fingerprint = text(p.fingerprint, 'invalid fingerprint');
    const email = text(p.email, 'invalid email').trim();
    const password = text(p.password, 'invalid password');

    const row = r.hostRecord();
    // SP04 §1: a host that is already added is pinned, so a second key is never accepted silently;
    // a host that is not has only the fingerprint the person confirmed (or the invite carried).
    const found = await c.discover(
      address,
      row === null
        ? { fingerprint }
        : { pinned: { kid: row.kid, ed25519Public: row.publicKey } },
    );
    const pre = preAuthConnection(found);
    // SP02 §4: the person's own salt for an activated account (a fake one would sign nobody in).
    const published = await pre.request<SaltResponse>('POST', HOST_ROUTES.authSalt, { email });
    const keys = await s.deriveFor(password, published.salt, published.iterations);
    const opened = await pre.request<TokenResponse>('POST', HOST_ROUTES.authLogin, {
      email,
      authKey: toBase64url(keys.authKey),
      device: await deviceOf(),
    } satisfies LoginRequest);

    // SP02 §7: the host answered a salt other than the one this machine cached, so the account was
    // reset somewhere else. The saved logins of this machine go before the new keys are adopted
    // (RF-43) — and only for the person the host just signed in.
    const same = row !== null && row.personId === opened.personId;
    if (same && row.salt !== published.salt) await s.wipeVault(row.personId);

    const local = r.personById(opened.personId);
    const connection = c.connect({
      address: found.address,
      kid: found.pin.kid,
      publicKey: found.pin.ed25519Public,
      personId: opened.personId,
    });
    const state = await s.adoptConnectedAccount({
      personId: opened.personId,
      email,
      name: local === null ? email : local.name,
      password,
      salt: published.salt,
      iterations: published.iterations,
      // The snapshot is what says who is an admin (B4/B5); the local row is the last word until then.
      admin: local !== null && local.admin,
    });
    await connection.saveToken(opened.token);
    r.saveHost({
      address: found.address,
      guild: found.document.guild,
      kid: found.pin.kid,
      publicKey: found.pin.ed25519Public,
      personId: opened.personId,
      salt: published.salt,
      addedAt: same && row !== null ? row.addedAt : new Date().toISOString(),
    });
    pendingJoin = null;
    return afterUnlock(state);
  },

  'host.syncNow': async () => {
    if (required(repo, 'host.syncNow').hostRecord() === null) {
      throw new Error('Bond is not connected to a host');
    }
    return await required(sync, 'host.syncNow').syncNow();
  },

  'host.remove': async (params) => {
    const r = required(repo, 'host.remove');
    // SP05 §3 requires the flag; what it decides — the local personal tools — is block 2 (SP05 §2
    // keeps them in `tool` rows either way, and `clearHost` never touches them).
    booleanValue(parameters(params, 'invalid removal').keepPersonal, 'invalid removal');

    sync?.stop();
    const connection = connectionOf();
    // SP02 §5: the bearer goes with the host; without a row nothing would ever read it again.
    if (connection !== null) await connection.forgetToken();
    r.clearHost();
    // SP05 §2: without a `host` row the local tables are the catalog again — "removing the host
    // returns to them" — so the effective catalog and the page's list are re-derived here.
    refreshConnectedCatalog();
    afterCatalogChange();
    const state = hostState();
    push('host', state);
    return state;
  },

  /**
   * B8a (SP05 §4, RF-40): the first admin of a host that has no org tool publishes this Bond's local
   * catalog — the `org` rows of the local `tool` table with their views and their icons, and the
   * local roles — through `POST /v1/admin/bootstrap`. The host writes it all in one go and refuses a
   * second time (SP03 §2); the refusal comes back as `refused` so the offer can end without the page
   * having to read a status.
   */
  'host.bootstrap': async () => {
    const r = required(repo, 'host.bootstrap');
    const actor = unlockedPerson('host.bootstrap');
    const store = required(icons, 'host.bootstrap');
    const admin = hostAdminFor(connectionOf());
    if (admin === null) throw new Error('Bond is not connected to a host');

    // The local catalog, not the effective one: publishing the snapshot's own tools back to the host
    // would be a no-op at best. A local personal tool is not part of the guild's catalog (RF-40).
    const local = r.listEntries().filter((entry) => (entry.scope ?? 'org') === 'org');
    const tools = await localEntriesWithIcons(local, store);
    if (tools.length === 0) throw new Error('this Bond has no local tools to publish');
    const roles = r.listRoles();

    const answer = await admin.bootstrap(tools, roles);
    if (answer.refused) return answer;
    r.addEvent({
      personId: actor.id,
      toolId: null,
      type: 'catalog_changed',
      url: null,
      result: 'published',
      detail: `tools: ${answer.created}, roles: ${roles.length}`,
    });
    await afterHostWrite();
    return answer;
  },

  // -------------------------------------------------------------- catalog
  'catalog.list': async () => {
    unlockedPerson('catalog.list');
    // SP05 §2: the effective catalog — the snapshot's entries while a `host` row exists.
    return listedEntries();
  },

  'catalog.get': async (params): Promise<EntryDetails> => {
    const r = required(repo, 'catalog.get');
    const store = required(icons, 'catalog.get');
    const id = text(parameters(params, 'invalid tool').id, 'invalid id');
    const entry = catalogEntryOf(id);
    if (entry === null) throw new Error('tool not found');

    // SP05 §4: the Tools tab edits the entries the page lists, and while connected those are the
    // snapshot's (B5 left this read for B6). The probe and the login history are this machine's own
    // records of the local catalog, and the host holds neither; the person's personal views hang
    // under the entry for the screens that open them (B5) and are not the org tool's own.
    if (connectedMode) {
      return {
        entry: { ...entry, icon: entry.icon ?? null, views: orgViewsOf(entry.views) },
        probe: null,
        usualLogin: null,
      };
    }

    const hash = r.iconHash(id);
    return {
      entry: { ...entry, icon: hash === null ? null : await store.dataUri(hash) },
      probe: r.probe(id),
      usualLogin: usualLogin(r.loginResults(id, 20)),
    };
  },

  'catalog.probe': (params) => {
    const p = parameters(params, 'invalid address');
    return probe(text(p.url, 'invalid address'));
  },

  'catalog.save': async (params) => {
    const r = required(repo, 'catalog.save');
    const store = required(icons, 'catalog.save');
    const person = unlockedPerson('catalog.save');
    const p = parameters(params, 'invalid entry');
    const entry = validateEntry(p.entry);
    const admin = hostAdminFor(connectionOf());

    // SP05 §3: while a host is connected the catalog is the host's, so this write goes to
    // `PUT /v1/admin/tools/:id` and the local `tool` rows stay untouched (SP05 §2).
    if (admin !== null) {
      // The admin tool routes write the guild's org tools; a personal tool of this person is not
      // one of them (SP04 §2, and the grants of SP01 §2 are org-only).
      if (catalogEntryOf(entry.id)?.scope === 'personal') {
        throw new Error('a personal tool is not part of the guild catalog');
      }
      const icon =
        p.icon === undefined ? entry.icon : p.icon === null ? null : iconDataUri(rawIcon(p.icon));
      const saved = await admin.saveTool({ ...entry, icon });
      r.addEvent({
        personId: person.id,
        toolId: saved.id,
        type: 'catalog_changed',
        url: auditUrl(saved.url),
        result: 'saved',
        detail: saved.title,
      });
      await afterHostWrite();
      return saved;
    }

    // An absent `icon` keeps the stored one, `null` removes it and a `RawIcon` writes a new one; the
    // key only enters `extras` when the parameter arrived — that is how the repo decides.
    const extras: { iconHash?: string | null; probe?: Probe | null } = {};
    if (p.icon !== undefined) {
      extras.iconHash = p.icon === null ? null : await store.save(rawIcon(p.icon));
    }
    if (p.probe !== undefined) {
      extras.probe = p.probe === null ? null : probeValue(p.probe);
    }

    const saved = r.saveEntry(entry, extras);
    r.addEvent({
      personId: person.id,
      toolId: saved.id,
      type: 'catalog_changed',
      url: auditUrl(saved.url),
      result: 'saved',
      detail: saved.title,
    });
    await afterChange();

    const hash = r.iconHash(saved.id);
    return { ...saved, icon: hash === null ? null : await store.dataUri(hash) };
  },

  'catalog.remove': async (params): Promise<true> => {
    const r = required(repo, 'catalog.remove');
    const person = unlockedPerson('catalog.remove');
    const id = text(parameters(params, 'invalid tool').id, 'invalid id');
    // The entry the page sees: the snapshot's while connected, the local row otherwise.
    const previous = catalogEntryOf(id);
    if (previous === null) throw new Error('tool not found');
    const admin = hostAdminFor(connectionOf());

    // SP05 §3: removing a connected entry removes the host's row. The local row, its icon and the
    // credentials saved for it are this machine's own and stay (the local catalog is not the catalog
    // while connected, SP05 §2) — deleting them would take the admin's logins with the guild's tool.
    if (admin !== null) {
      if (previous.scope === 'personal') throw new Error('a personal tool is not part of the guild catalog');
      await admin.removeTool(id);
      r.addEvent({
        personId: person.id,
        toolId: id,
        type: 'catalog_changed',
        url: auditUrl(previous.url),
        result: 'removed',
        detail: previous.title,
      });
      await afterHostWrite();
      return true;
    }

    // A6: the credentials of a removed tool leave the keychain and the vault index first.
    await required(vault, 'catalog.remove').removeAllForTool(id);
    r.removeEntry(id);
    r.addEvent({
      personId: person.id,
      toolId: id,
      type: 'catalog_changed',
      url: auditUrl(previous.url),
      result: 'removed',
      detail: previous.title,
    });
    await afterChange();
    return true;
  },

  'catalog.exportToFile': async (params): Promise<true> => {
    const r = required(repo, 'catalog.exportToFile');
    const path = text(parameters(params, 'invalid file').path, 'invalid path');
    const now = new Date();
    const exported = exportSeed(
      {
        entries: r.listEntries(),
        roles: r.listRoles(),
        invites: activeInvites(r, now),
        // The update channel belongs to the release, not to the local edits.
        update: bundledSeed === null ? null : bundledSeed.update,
        version: (storedSeedVersion(r) ?? 0) + 1,
      },
      now,
    );
    return writeTextFile(path, JSON.stringify(exported, null, 2));
  },

  'catalog.importFromFile': async (params) => {
    const r = required(repo, 'catalog.importFromFile');
    const store = required(icons, 'catalog.importFromFile');
    const person = unlockedPerson('catalog.importFromFile');
    const p = parameters(params, 'invalid file');
    const path = text(p.path, 'invalid path');
    const mode = p.mode;
    if (mode !== 'merge' && mode !== 'overwrite') throw new Error('invalid import mode');

    const counts = await importSeedFile(r, await readTextFile(path), mode, store);
    r.addEvent({
      personId: person.id,
      toolId: null,
      type: 'catalog_imported',
      url: null,
      result: mode,
      detail: `entries: ${counts.entries}, roles: ${counts.roles}, invites: ${counts.invites}`,
    });
    await afterChange();
    return { entries: counts.entries, roles: counts.roles, invites: counts.invites };
  },

  // -------------------------------------------------------------- roles
  'roles.list': () => rolesOf(),

  'roles.save': async (params) => {
    const r = required(repo, 'roles.save');
    const person = unlockedPerson('roles.save');
    const wanted = role(parameters(params, 'invalid role').role);
    const admin = hostAdminFor(connectionOf());

    // SP05 §3: the guild's roles live on the host while connected (B5 reads them from the snapshot;
    // this is the write side).
    if (admin !== null) {
      const saved = await admin.saveRole(wanted);
      r.addEvent({
        personId: person.id,
        toolId: null,
        type: 'roles_changed',
        url: null,
        result: 'saved',
        detail: saved.id,
      });
      await afterHostWrite();
      return saved;
    }

    const saved = r.saveRole(wanted);
    r.addEvent({
      personId: person.id,
      toolId: null,
      type: 'roles_changed',
      url: null,
      result: 'saved',
      detail: saved.id,
    });
    await afterChange();
    return saved;
  },

  'roles.remove': async (params): Promise<true> => {
    const r = required(repo, 'roles.remove');
    const person = unlockedPerson('roles.remove');
    const id = text(parameters(params, 'invalid role').id, 'invalid id');
    const admin = hostAdminFor(connectionOf());

    if (admin !== null) {
      // The host refuses the role that would leave the guild without an admin (`409`); the failure
      // reaches the page as it is, and nothing local changes.
      await admin.removeRole(id);
      r.addEvent({
        personId: person.id,
        toolId: null,
        type: 'roles_changed',
        url: null,
        result: 'removed',
        detail: id,
      });
      await afterHostWrite();
      return true;
    }

    r.removeRole(id);
    r.addEvent({
      personId: person.id,
      toolId: null,
      type: 'roles_changed',
      url: null,
      result: 'removed',
      detail: id,
    });
    await afterChange();
    return true;
  },

  'roles.grant': async (params): Promise<true> => {
    const r = required(repo, 'roles.grant');
    const person = unlockedPerson('roles.grant');
    const p = parameters(params, 'invalid grant');
    const granted = booleanValue(p.granted, 'invalid grant');
    const roleId = text(p.roleId, 'invalid role');
    const toolId = text(p.toolId, 'invalid tool');
    const admin = hostAdminFor(connectionOf());

    // SP05 §3/SP03 §2: a grant is the host's row on an org entry; the host is the one that decides
    // whether the entry is an org one at all.
    if (admin !== null) {
      await admin.grant(roleId, toolId, granted);
      r.addEvent({
        personId: person.id,
        toolId,
        type: 'grant_changed',
        url: null,
        result: granted ? 'granted' : 'revoked',
        detail: roleId,
      });
      await afterHostWrite();
      return true;
    }

    r.grant(roleId, toolId, granted);
    r.addEvent({
      personId: person.id,
      toolId,
      type: 'grant_changed',
      url: null,
      result: granted ? 'granted' : 'revoked',
      detail: roleId,
    });
    await afterChange();
    return true;
  },

  // -------------------------------------------------------------- people and invites
  'people.list': async () => {
    const admin = hostAdminFor(connectionOf());
    // SP05 §4: the People tab lists the guild's people while connected, from `GET
    // /v1/admin/people` (never a salt or a hash, SP03 §2). The local `person` table holds this
    // machine's accounts, which is a different question in connected mode.
    if (admin !== null) return await admin.listPeople();
    return required(repo, 'people.list').listPeople();
  },

  'people.setRoles': async (params) => {
    const r = required(repo, 'people.setRoles');
    const p = parameters(params, 'invalid person');
    const personId = text(p.personId, 'invalid person');
    const roles = textList(p.roles, 'invalid roles');
    const admin = hostAdminFor(connectionOf());

    if (admin !== null) {
      const updated = await admin.setRoles(personId, roles);
      r.addEvent({
        personId: updated.id,
        toolId: null,
        type: 'roles_changed',
        url: null,
        result: 'assigned',
        detail: roles.length === 0 ? 'none' : roles.join(', '),
      });
      await afterHostWrite();
      return updated;
    }

    const updated = r.setRoles(personId, roles);
    r.addEvent({
      personId: updated.id,
      toolId: null,
      type: 'roles_changed',
      url: null,
      result: 'assigned',
      detail: roles.length === 0 ? 'none' : roles.join(', '),
    });
    await afterChange();
    return updated;
  },

  'people.revoke': async (params): Promise<true> => {
    const r = required(repo, 'people.revoke');
    const store = required(vault, 'people.revoke');
    const actor = unlockedPerson('people.revoke');
    const p = parameters(params, 'invalid person');
    const personId = text(p.personId, 'invalid person');
    const deleteCredentials = booleanValue(p.deleteCredentials, 'invalid revocation');
    const admin = hostAdminFor(connectionOf());

    // SP05 §3–§4: revoking a guild member is disabling them on the host (`PATCH
    // /v1/admin/people/:id { disabled: true }`), which ends every session of theirs (SP03 §2, RF-39).
    // Their saved credentials live on their own machine, so `deleteCredentials` — this machine's
    // vault (RF-16) — has nothing to delete here; the flag is read all the same, as SP05 §3 asks.
    if (admin !== null) {
      if (personId === actor.id) throw new Error("you can't revoke yourself");
      await admin.disable(personId);
      r.addEvent({
        personId,
        toolId: null,
        type: 'access_revoked',
        url: null,
        result: 'disabled on the host',
        detail: null,
      });
      await afterHostWrite();
      return true;
    }

    const target = r.personById(personId);
    if (target === null) throw new Error('person not found');
    if (target.id === actor.id) throw new Error("you can't revoke yourself");
    if (target.admin && r.countAdmins() === 1) throw new Error('the last admin cannot be revoked');

    r.revokePerson(personId);
    // The vault index always goes; the keychain items only on request (RF-16). The biometric key of
    // the account goes with it (A14).
    if (deleteCredentials) await store.removeAllOf(personId);
    else r.removeVaultOf(personId);
    await required(runtime, 'people.revoke').secrets.delete(`bond.bio.${personId}`);

    r.addEvent({
      personId,
      toolId: null,
      type: 'access_revoked',
      url: null,
      result: deleteCredentials ? 'credentials deleted' : 'credentials kept',
      detail: null,
    });
    await afterChange();
    return true;
  },

  'invites.issue': async (params) => {
    const r = required(repo, 'invites.issue');
    const actor = unlockedPerson('invites.issue');
    const p = parameters(params, 'invalid invite');
    const roles = textList(p.roles, 'invalid roles');
    const admin = hostAdminFor(connectionOf());

    // SP05 §3: while connected the same question — "a code to hand over" — is the host's
    // `POST /v1/admin/people` (create the person and their access code) or, for somebody who is
    // already in the guild, `POST /v1/admin/people/:id/code` (reissue, revoking the previous one).
    // `days` stays local: SP02 §3 fixes 72 h on the host's side.
    if (admin !== null) {
      const personId = optional(p.personId, (value) => text(value, 'invalid person'));
      if (personId !== undefined) {
        const issued = await admin.issueCode(personId);
        r.addEvent({
          personId: actor.id,
          toolId: null,
          type: 'invite_issued',
          url: null,
          result: null,
          detail: `reissued for ${personId} — expires at ${issued.expiresAt}`,
        });
        // The list the People tab reloads is the host's; no sync is needed for a code.
        return { code: issued.code, expiresAt: issued.expiresAt };
      }

      const email = text(p.email, 'invalid email');
      const name = text(p.name, 'invalid name');
      const created = await admin.createPerson({ email, name, roles });
      r.addEvent({
        personId: actor.id,
        toolId: null,
        type: 'invite_issued',
        url: null,
        result: null,
        detail: `roles: ${roles.length === 0 ? 'none' : roles.join(', ')} — expires at ${created.expiresAt}`,
      });
      return { code: created.code, expiresAt: created.expiresAt };
    }

    const known = new Set(r.listRoles().map((item) => item.id));
    for (const id of roles) {
      if (!known.has(id)) throw new Error(`unknown role: ${id}`);
    }
    const days = optional(p.days, (value) => integer(value, 'invalid validity')) ?? 7;
    if (days < 1) throw new Error('invalid validity');

    const code = generateInviteCode();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    r.saveInvite({ codeHash: await hashInviteCode(code), roles, expiresAt, createdBy: actor.id });
    // The clear code appears once, in the response; the event keeps the roles and the validity.
    r.addEvent({
      personId: actor.id,
      toolId: null,
      type: 'invite_issued',
      url: null,
      result: null,
      detail: `roles: ${roles.length === 0 ? 'none' : roles.join(', ')} — expires at ${expiresAt}`,
    });
    return { code, expiresAt };
  },

  // -------------------------------------------------------------- vault
  'vault.list': () => required(vault, 'vault.list').list(unlockedPerson('vault.list').id),

  'vault.save': async (params) => {
    const r = required(repo, 'vault.save');
    const person = unlockedPerson('vault.save');
    const p = parameters(params, 'invalid credential');
    const item = await required(vault, 'vault.save').save(person.id, {
      toolId: text(p.toolId, 'invalid tool'),
      username: text(p.username, 'invalid username'),
      secret: text(p.secret, 'invalid secret'),
      label: optional(p.label, (value) => text(value, 'invalid label')),
    });
    r.addEvent({
      personId: person.id,
      toolId: item.toolId,
      type: 'credential_saved',
      url: null,
      result: null,
      detail: item.label,
    });
    return item;
  },

  'vault.reveal': async (params) => {
    const person = unlockedPerson('vault.reveal');
    const toolId = text(parameters(params, 'invalid credential').toolId, 'invalid tool');
    const found = await required(vault, 'vault.reveal').read(person.id, toolId);
    if (found === null) throw new Error('credential not found');
    return found;
  },

  'vault.remove': async (params): Promise<true> => {
    const r = required(repo, 'vault.remove');
    const person = unlockedPerson('vault.remove');
    const toolId = text(parameters(params, 'invalid credential').toolId, 'invalid tool');
    await required(vault, 'vault.remove').remove(person.id, toolId);
    r.addEvent({
      personId: person.id,
      toolId,
      type: 'credential_removed',
      url: null,
      result: null,
      detail: null,
    });
    return true;
  },

  'vault.exportToFile': async (params): Promise<true> => {
    const r = required(repo, 'vault.exportToFile');
    const store = required(vault, 'vault.exportToFile');
    const person = unlockedPerson('vault.exportToFile');
    const p = parameters(params, 'invalid password');
    const password = text(p.password, 'invalid password');
    const path = text(p.path, 'invalid path');

    await confirmLocalPassword(r, person, password);
    const written = await writeTextFile(path, await store.export(person.id, password));
    r.addEvent({
      personId: person.id,
      toolId: null,
      type: 'vault_exported',
      url: null,
      result: null,
      detail: null,
    });
    return written;
  },

  'vault.importFromFile': async (params) => {
    const r = required(repo, 'vault.importFromFile');
    const store = required(vault, 'vault.importFromFile');
    const person = unlockedPerson('vault.importFromFile');
    const p = parameters(params, 'invalid file');
    const password = text(p.password, 'invalid password');
    const path = text(p.path, 'invalid path');

    const items = await store.import(person.id, await readTextFile(path), password);
    r.addEvent({
      personId: person.id,
      toolId: null,
      type: 'vault_imported',
      url: null,
      result: String(items),
      detail: null,
    });
    return { items };
  },

  // -------------------------------------------------------------- tool windows
  'tools.state': () => required(windows, 'tools.state').state(),

  'tools.open': (params) =>
    required(windows, 'tools.open').open(text(parameters(params, 'invalid tool').id, 'invalid id')),

  'tools.openView': (params) => {
    const p = parameters(params, 'invalid view');
    return required(windows, 'tools.openView').openView(
      text(p.toolId, 'invalid tool'),
      integer(p.index, 'invalid view'),
    );
  },

  'tools.close': (params) =>
    required(windows, 'tools.close').close(text(parameters(params, 'invalid tool').id, 'invalid id')),

  'tools.reload': (params) =>
    required(windows, 'tools.reload').reload(text(parameters(params, 'invalid tool').id, 'invalid id')),

  // -------------------------------------------------------------- audit
  'events.list': async (params) => {
    const r = required(repo, 'events.list');
    const p = parameters(params, 'invalid filter');
    const filter: EventFilter = {};
    for (const key of ['personId', 'toolId', 'result'] as const) {
      const value = optional(p[key], (input) => text(input, 'invalid filter'));
      if (value !== undefined) filter[key] = value;
    }
    const limit = optional(p.limit, (input) => integer(input, 'invalid filter'));
    if (limit !== undefined) filter.limit = limit;
    // SP05 §4: Settings → Activity shows the guild's own log while connected (`GET
    // /v1/admin/events`, SP03 §2) — the local event table is this machine's queue for the host.
    const admin = hostAdminFor(connectionOf());
    if (admin !== null) return await admin.listEvents(filter);
    return r.listEvents(filter);
  },

  'events.exportToFile': (params) => {
    const r = required(repo, 'events.exportToFile');
    const path = text(parameters(params, 'invalid file').path, 'invalid path');
    return writeTextFile(path, r.eventsJsonl());
  },

  /** SP04 §5: the sent/pending counters of Settings → Activity. Counters only — no event travels. */
  'events.syncStatus': () => required(repo, 'events.syncStatus').eventSyncCounts(),

  // -------------------------------------------------------------- bond
  'bond.info': async (): Promise<AppInfo> => {
    const r = required(repo, 'bond.info');
    const info = await required(runtime, 'bond.info').info();
    return {
      version: info.version,
      seedVersion: storedSeedVersion(r),
      os: system,
      gateOrigins: gateOrigins(bundledSeed),
      tray,
    };
  },

  'bond.checkUpdate': () => required(runtime, 'bond.checkUpdate').update.check(),

  'bond.installUpdate': async (): Promise<boolean> => {
    const r = required(repo, 'bond.installUpdate');
    const person = unlockedPerson('bond.installUpdate');
    // A13: the install restarts the app, so the event goes in before it starts.
    r.addEvent({
      personId: person.id,
      toolId: null,
      type: 'update',
      url: null,
      result: 'requested',
      detail: null,
    });
    return required(runtime, 'bond.installUpdate').update.install();
  },

  /** RF-55: hides the notice of one version on this machine; `store` keeps the version string. */
  'bond.dismissUpdate': async (params): Promise<true> => {
    const app = required(runtime, 'bond.dismissUpdate');
    const version = text(parameters(params, 'invalid dismissal').version, 'invalid version');
    // `store.set` answers false when it could not write: better to say so than to hide a notice
    // that comes back on the next launch.
    if (!(await app.store.set(DISMISSED_UPDATE_KEY, version))) {
      throw new Error('Bond could not save the dismissal');
    }
    if (updateNotice !== null && updateNotice.latest === version) {
      updateNotice = null;
      push('update', null);
    }
    return true;
  },

  'bond.quit': () => {
    required(runtime, 'bond.quit').quit();
    return true;
  },

  // -------------------------------------------------------------- tool-window report
  'login.report': (params, _app, meta): true => {
    const state = reportState(parameters(params, 'invalid report').state);
    required(windows, 'login.report').onReport(meta.window, state, meta.origin);
    return true;
  },
};

/** Every key of `ApiContract`, each one with the §2 guard applied before its body. */
export const api: Record<string, TinyApiHandler> = Object.fromEntries(
  (Object.keys(methods) as Method[]).map((method): [string, TinyApiHandler] => [
    method,
    guarded(method, methods[method]),
  ]),
);

// ---------------------------------------------------------------- runtime hooks

/**
 * SP04 §1.3: a `bond://join?host=…&fp=…[&code=…]` link (tinyjs' `"urlScheme"`, the second launch
 * forwarding to the running copy). The window comes forward and the page opens the join screen with
 * the invite prefilled; anything else the launcher forwards is ignored. The code is the person's own
 * — it is never logged, written to a file or put in an event.
 */
export function onOpenUrl(url: string, app: TinyApp): void {
  const join = parseJoinLink(url);
  if (join === null) return;
  pendingJoin = join;
  app.window(MAIN_WINDOW).show();
  push('join', join);
}

export function onNavigate(info: TinyNavEvent): 'deny' | 'external' | undefined {
  const open = windows;
  return open === null ? undefined : open.onNavigate(info);
}

/** A tool window popup: the tool windows decide between their own window, the browser and denial. */
export function onWindowOpen(info: TinyPopupEvent): 'window' | 'external' | 'deny' | undefined {
  const open = windows;
  return open === null ? undefined : open.onPopup(info);
}

export function onDownload(info: TinyDownloadEvent): void {
  if (info.state !== 'done' && info.state !== 'failed') return;
  const r = repo;
  if (r === null) return;
  const person = session === null ? null : session.current();
  r.addEvent({
    personId: person === null ? null : person.id,
    toolId: null,
    type: 'download',
    url: auditUrl(info.url),
    result: info.state,
    detail: info.state === 'failed' ? `${info.filename}: ${info.error ?? 'failed'}` : info.filename,
  });
}

export function onWindowClosed(id: string): void {
  const open = windows;
  if (open !== null) open.onWindowClosed(id);
}

export function onWindowState(info: TinyWindowStateEvent): void {
  const open = windows;
  if (open !== null) open.onFocus(info.win, info.focused);
}

export function onHotkey(id: string): void {
  const open = windows;
  if (open !== null) open.onHotkey(id);
}

/** Tray menu and icon click (RF-15): `open`, `lock`, `quit`, and a bare click opens the window. */
export function onTray(id: string | null, app: TinyApp): void {
  if (id === 'quit') {
    app.quit();
    return;
  }
  if (id === 'lock') {
    lockSession();
    app.window(MAIN_WINDOW).show();
    return;
  }
  app.window(MAIN_WINDOW).show();
}
