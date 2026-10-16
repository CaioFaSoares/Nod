// Backend entry point of Bond (docs/arquitetura.md §4): opens the database, applies the bundled
// seed and wires session, vault and tool windows. It exports the `api` (every key of `ApiContract`,
// with the §2 window guard) and the runtime hooks.
// No secret crosses this frontier: only `vault.reveal` returns a credential, and no secret ever
// enters an event, `store` or a log.
import { generateInviteCode, hashInviteCode, inviteIsValid, verifyPassword } from '../shared/auth';
import { auditUrl, exportSeed, originOf, validateEntry, validateSeed, visibleEntries } from '../shared/catalog';
import { MAIN_WINDOW, toolOfWindow } from '../shared/types';
import type {
  AppInfo,
  Entry,
  EntryDetails,
  EventFilter,
  Id,
  InviteSeed,
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
} from '../shared/types';
import { createIcons } from './icons';
import { probe } from './probe-net';
import { createRepo, LegacyDatabaseError } from './repo';
import { applyBundledSeed, gateOrigins, importSeedFile, storedSeedVersion } from './seed';
import { createSession } from './session';
import { openSqlite } from './sqlite';
import { createToolWindows } from './tool-windows';
import { createVault } from './vault';
import type { Icons } from './icons';
import type { Repo } from './repo';
import type { Session } from './session';
import type { ToolWindows } from './tool-windows';
import type { Vault } from './vault';

type System = 'macos' | 'windows' | 'linux';

let repo: Repo | null = null;
let session: Session | null = null;
let vault: Vault | null = null;
let windows: ToolWindows | null = null;
let icons: Icons | null = null;
let runtime: TinyApp | null = null;
let system: System = 'linux';
let tray = false;
let bundledSeed: Seed | null = null;
/** Why the database could not be opened, when it could not: every handler answers with it (§4). */
let bootFailure: string | null = null;

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
  await refreshIcons();

  session = createSession({
    repo: database,
    keychain: app.secrets,
    store: app.store,
    authenticate: (request: string) => app.authenticate(request),
    biometricAvailable: system !== 'linux' && supported(capabilities, 'authenticate'),
  });
  vault = createVault({ repo: database, keychain: app.secrets });
  windows = createToolWindows(app, {
    entries: () => visibleEntriesOf(),
    icon: (id) => iconCache.get(id) ?? null,
    credential: (toolId) => credentialOf(toolId),
    hasCredential: (toolId) => hasCredentialOf(toolId),
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
  return r === null || person === null ? [] : visibleEntries(r.listEntries(), person);
}

function toolsState(): ToolsState {
  return windows === null ? { tools: [] } : windows.state();
}

function credentialOf(toolId: Id): Promise<{ username: string; secret: string } | null> {
  const person = currentPerson();
  const store = vault;
  return store === null || person === null ? Promise.resolve(null) : store.read(person.id, toolId);
}

/**
 * §4: whether the vault index holds a credential for the tool. Synchronous, and only the index —
 * the cascade counts the fill attempt by it (`hasCredential` in `ToolWindowsDeps`), so a tool
 * without a credential ends its cascade in `session` instead of `filled`.
 */
function hasCredentialOf(toolId: Id): boolean {
  const r = repo;
  const person = currentPerson();
  return r !== null && person !== null && r.vaultItem(person.id, toolId) !== null;
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
  'events.list': true,
  'events.exportToFile': true,
  'bond.installUpdate': true,
};

/** The only methods that work with the session locked (§2); the rest require an unlock. */
const WITHOUT_SESSION: Partial<Record<Method, true>> = {
  'session.state': true,
  'session.createAccount': true,
  'session.unlock': true,
  'session.unlockBiometric': true,
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

/** §4: unlocking or creating an account pushes session and tools, then restores the open tools. */
async function afterUnlock(state: SessionState): Promise<SessionState> {
  const open = required(windows, 'session');
  push('session', state);
  push('tools', open.state());
  await open.restore();
  push('tools', open.state());
  return state;
}

/** §4: locking closes every tool window and the popups they opened. */
function lockSession(): SessionState {
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
  const record = r.personByEmail(person.email);
  if (record === null) throw new Error('invalid credentials');
  if (!(await verifyPassword(password, record.password))) throw new Error('incorrect password');
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
  'session.state': () => required(session, 'session.state').state(),

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
    await required(session, 'session.changePassword').changePassword(
      text(p.current, 'invalid current password'),
      text(p.next, 'invalid new password'),
    );
    return true;
  },

  'session.lock': () => lockSession(),

  // -------------------------------------------------------------- catalog
  'catalog.list': async () => {
    const r = required(repo, 'catalog.list');
    const store = required(icons, 'catalog.list');
    const person = unlockedPerson('catalog.list');
    return Promise.all(
      visibleEntries(r.listEntries(), person).map(async (entry) => {
        const hash = r.iconHash(entry.id);
        // `Entry.icon` at runtime is a data URI or null (shared/types): the page shows the image.
        return { ...entry, icon: hash === null ? null : await store.dataUri(hash) };
      }),
    );
  },

  'catalog.get': async (params): Promise<EntryDetails> => {
    const r = required(repo, 'catalog.get');
    const store = required(icons, 'catalog.get');
    const id = text(parameters(params, 'invalid tool').id, 'invalid id');
    const entry = r.entry(id);
    if (entry === null) throw new Error('tool not found');

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
    const previous = r.entry(id);
    if (previous === null) throw new Error('tool not found');

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
  'roles.list': () => required(repo, 'roles.list').listRoles(),

  'roles.save': async (params) => {
    const r = required(repo, 'roles.save');
    const person = unlockedPerson('roles.save');
    const saved = r.saveRole(role(parameters(params, 'invalid role').role));
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
  'people.list': () => required(repo, 'people.list').listPeople(),

  'people.setRoles': async (params) => {
    const r = required(repo, 'people.setRoles');
    const p = parameters(params, 'invalid person');
    const personId = text(p.personId, 'invalid person');
    const roles = textList(p.roles, 'invalid roles');
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
  'events.list': (params) => {
    const r = required(repo, 'events.list');
    const p = parameters(params, 'invalid filter');
    const filter: EventFilter = {};
    for (const key of ['personId', 'toolId', 'result'] as const) {
      const value = optional(p[key], (input) => text(input, 'invalid filter'));
      if (value !== undefined) filter[key] = value;
    }
    const limit = optional(p.limit, (input) => integer(input, 'invalid filter'));
    if (limit !== undefined) filter.limit = limit;
    return r.listEvents(filter);
  },

  'events.exportToFile': (params) => {
    const r = required(repo, 'events.exportToFile');
    const path = text(parameters(params, 'invalid file').path, 'invalid path');
    return writeTextFile(path, r.eventsJsonl());
  },

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
