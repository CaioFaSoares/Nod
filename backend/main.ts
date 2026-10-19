// Backend entry point of Nod (docs/arquitetura.md §4): opens the database, applies the bundled
// seed and wires session, vault and tool windows. It exports the `api` (every key of `ApiContract`,
// with the §2 window guard) and the runtime hooks.
// No secret crosses this frontier: only `vault.reveal` returns a credential, and no secret ever
// enters an event, `store` or a log.
import {
  PASSWORD_V2_ALGORITHM,
  generateInviteCode,
  hashInviteCode,
  inviteIsValid,
  randomSalt,
  verifyStoredPassword,
} from '../shared/auth';
import { BUILD_MODE_STAMP, stampMode } from '../shared/build-mode';
import { auditUrl, catalogMode, exportSeed, originOf, validateEntry, validateSeed, visibleEntries } from '../shared/catalog';
import { fromBase64url, toBase64url } from '../shared/encoding';
import { HOST_ROUTES, codeKindOf, isPng } from '../shared/host-api';
import { leftoverLocalTools, parseSnapshot } from '../shared/host-merge';
import { joinLink, parseJoinLink } from '../shared/join-link';
import { GATE_PASSWORD_REQUIRED, GATE_PROMPT_FAILED, MAIN_WINDOW, toolOfWindow } from '../shared/types';
import { compareVersions, tooOldFor } from '../shared/version';
import { encryptVaultBytes, encryptVaultValue, plainVaultCredential } from '../shared/vault-crypto';
import type {
  AppIconChoice,
  AppIconState,
  AppInfo,
  CredentialHolders,
  Entry,
  EntryDetails,
  EntryProfiles,
  EntryTarget,
  EventFilter,
  GuildProfile,
  HostState,
  Id,
  InviteSeed,
  InviteView,
  JoinInvite,
  JoinResult,
  LoginResult,
  Method,
  MineKeys,
  PeerKey,
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
  VaultItem,
} from '../shared/types';
import type {
  ActivateRequest,
  CodeKind,
  CreateInviteRequest,
  Device,
  DeviceSession,
  GuildInvite,
  InvitePreview,
  PresenceEntry,
  GuildIconRequest,
  GuildIconResponse,
  LoginRequest,
  PasswordChangeRequest,
  SaltResponse,
  Snapshot,
  TokenResponse,
} from '../shared/host-api';
import { createConnectedCatalog } from './connected-catalog';
import { createGuildIcon, GUILD_ICON_FILE } from './guild-icon';
import { buildCredentialHolders } from './holders';
import { hostAdminFor, orgViewsOf, ownerGate } from './host-admin';
import { createHostClient, HostError, hostTokenKey } from './host-client';
import { bytesToBase64, createIcons } from './icons';
import { createKeys, keysKey } from './keys';
import { createPersonal } from './personal';
import { probe } from './probe-net';
import { createRepo, LegacyDatabaseError } from './repo';
import { applyBundledSeed, applySeedFile, gateOrigins, importSeedFile, seedCountsDetail, storedSeedVersion } from './seed';
import type { SeedApplied } from './seed';
import { createSecretStore, importLegacySecrets, sealedSecrets } from './secret-store';
import { OFFLINE_SESSION_ERROR, createSession } from './session';
import { createShares, GATE_REASON } from './shares';
import { openSqlite } from './sqlite';
import { createSync, UPDATE_REQUIRED_ERROR } from './sync';
import { createToolWindows } from './tool-windows';
import { createVault } from './vault';
import type { ConnectedCatalog } from './connected-catalog';
import type { GuildIcon } from './guild-icon';
import type { HostClient, HostConnection, HostDiscovery } from './host-client';
import type { Icons } from './icons';
import type { Keys } from './keys';
import type { Personal } from './personal';
import type { EventInput, Repo } from './repo';
import type { Session } from './session';
import type { Shares } from './shares';
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
 * The guild icon and the app-icon choice (SP05 §6): the PNG `guild-icon.png` under the data dir,
 * fetched once per signed hash, plus the preference `appIcon` of `store.json`.
 */
let guildIcon: GuildIcon | null = null;
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
 * B7: the person's own tools, views and favorites (SP05 §2–§4). Built with the database; every write
 * it makes lands in the outbox while a host is connected and in the local tables otherwise.
 */
let personal: Personal | null = null;
/**
 * K1/K2/SP06 §2: this person's E02 key pairs (sealed private halves in the keychain, public halves
 * in `meta`) and the pinned keys of the guild's colleagues. Built with the database; fed by the
 * activation hook, by `afterUnlock` and by every applied snapshot.
 */
let keys: Keys | null = null;
/**
 * K4–K7/SP06 §4–§5: the share flows — sealing, the inbox, accept/decline, the scope and the
 * holders of a credential — over the vault, the key pairs and the cached snapshot.
 */
let shares: Shares | null = null;
/**
 * K5/SP02 §9: whether this machine has biometrics. The gate of `vault.reveal`, `vault.copy`,
 * `shares.send` and `shares.accept` uses `app.authenticate` when it does, and the person's password
 * otherwise; the read is once, in `init`, like the session's own.
 */
let biometrics = false;
/**
 * SP02 §9/`docs/canonico.md` §22: whether this is a non-release dev run (`tinyjs dev`) — the one
 * place a typed password is still a factor on a machine that also has `app.authenticate`. Read once
 * in `init` from the build-mode stamp `scripts/gen-config.ts` leaves in the project's `resources/`
 * (`shared/build-mode.ts`): a release build stages no stamp, so this is `false` there whatever the
 * environment, the seed or the page say.
 */
let devRun = false;
/**
 * K5/SP02 §9 fallback (`docs/canonico.md` §22, "Gate fallback when the system prompt fails"): the
 * runtime reports `authenticate` per OS, not per enrollment — on Windows without Hello the prompt
 * answers `false` every time (`~/.tinyjs/skill/references/platforms.md`, "false where not
 * enrolled"). Once the system prompt did not confirm in this unlocked session, the person's typed
 * password is a factor too. Cleared at every lock and unlock.
 */
let promptFailed = false;
/**
 * SP04 §1.3's `nod://join` link, kept until the join flow picks it up (`host.discover`) or a host
 * is added. Not a secret — the address, the fingerprint and the code the person was given — and it
 * never goes to a file, an event or `store`.
 */
let pendingJoin: JoinInvite | null = null;
let system: System = 'linux';
/**
 * O2: the version of the running app (`app.info().version`), read once at start-up because the gate
 * that compares it against the host's `minAppVersion` is asked on a synchronous path
 * (`backend/sync.ts`). `null` while the runtime has not answered.
 */
let appVersion: string | null = null;
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
    bootFailure = `Nod couldn't open its database: ${reason(error)}`;
    return;
  }
  repo = database;
  database.ensureAdminRole();

  const store = createIcons(`${paths.data}/icons`);
  icons = store;

  // §2: the capabilities are read once here; an absent key means supported.
  const capabilities = await app.system.capabilities();
  system = app.system.os();
  // K5/SP02 §9: the same answer the session gets, kept for the gate that guards reveal, copy,
  // send and accept. Linux has no `app.authenticate`, so there the gate is the password.
  biometrics = system !== 'linux' && supported(capabilities, 'authenticate');
  // SP02 §9/`docs/canonico.md` §22: the dev exception of the gate. The stamp is written by
  // `scripts/gen-config.ts <mode>` beside the seed and is not part of a release's resources, so a
  // built app reads none and answers a plain `false` — see `shared/build-mode.ts`.
  devRun = await readDevRun(paths.resources);
  // O2: the same version the page shows (`nod.info`), read once because the sync's gate is asked
  // synchronously. A runtime that does not answer leaves it unknown, and nothing is refused.
  try {
    appVersion = (await app.info()).version;
  } catch {
    appVersion = null;
  }
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

  // SP05 §6: the guild's icon on this machine (`guild-icon.png` under the data dir) and the choice
  // between it and the bundle icon. The file calls and the runtime's `app.icon` arrive as
  // parameters, so `backend/guild-icon.ts` is driven by `bun test` with no runtime at all. Its
  // connection is the gated one: disconnected, no snapshot moves the icon and no byte is fetched.
  guildIcon = createGuildIcon({
    path: `${paths.data}/${GUILD_ICON_FILE}`,
    connection: () => guildConnection(),
    icon: (path) => app.icon(path),
    // §2/`docs/tinyjs.md` §6: Linux on Wayland has nowhere to put an app icon, and says so.
    iconSupported: supported(capabilities, 'icon'),
    files: {
      // `tjs.readFile` answers a loosely typed view of the bytes it read; one copy in the app's
      // start-up hands `backend/guild-icon.ts` the `Uint8Array<ArrayBuffer>` a digest takes.
      read: async (path) => new Uint8Array(await tjs.readFile(path)),
      write: (path, bytes) => tjs.writeFile(path, bytes),
      remove: removeFile,
    },
    store: { get: (key) => app.store.get(key), set: (key, value) => app.store.set(key, value) },
  });

  // 0.5.1 (RF-63): the keychain keeps the biometric item only; the `bv1.` values live in the
  // `secret` table, and what an older Nod left in the keychain is copied once by `importLegacy`.
  const sealed = createSecretStore({ rows: database, keychain: app.secrets });
  const bearers = sealedSecrets(sealed, () => (session === null ? null : session.vaultKey()));
  session = createSession({
    repo: database,
    keychain: sealed,
    store: app.store,
    authenticate: (request: string) => app.authenticate(request),
    biometricAvailable: biometrics,
    // SP02 §7, RF-63: the bearer is sealed under the `vaultKey` a password change moves.
    sealedExtras: (personId) => {
      const host = database.hostRecord();
      return host !== null && host.personId === personId ? [hostTokenKey(host.kid, personId)] : [];
    },
  });
  // SP02 §8/RF-38: the vault reads the entry of a credential through the effective catalog, so the
  // origin it records is the entry's own url at save time — the host entry's, while connected.
  // V1: every value is sealed with the `vaultKey` the session keeps in memory; with a locked session
  // there is no key and the vault refuses to read or write one.
  vault = createVault({
    repo: { ...database, entry: (id) => catalogEntryOf(id) },
    keychain: sealed,
    vaultKey: () => (session === null ? null : session.vaultKey()),
    // K9/SP06 §4: the one sharing call-out of the vault. A save of a credential the owner already
    // shared re-seals the new value to the holders through `backend/shares.ts`; the call-out is
    // best-effort and never fails the save (`backend/vault.ts` swallows a throw).
    afterSave: async (personId, item) => (shares === null ? null : await shares.update(personId, item)),
  });
  // K1–K2/SP06 §2: the person's E02 pairs and the guild's pinned keys. Built with the database, and
  // fed by three moments — an activation, an unlock and an applied snapshot (`onState` below).
  keys = createKeys({
    repo: database,
    keychain: sealed,
    session: {
      current: () => (session === null ? null : session.current()),
      vaultKey: () => (session === null ? null : session.vaultKey()),
    },
  });
  // K4–K7/SP06 §4–§5: the share flows. The catalog and the connection are read at call time (a
  // snapshot or a host row may have moved since start-up), the gate is this backend's
  // `authenticate` below, and a successful write asks the sync loop for a run so the holders of the
  // snapshot follow.
  shares = createShares({
    repo: database,
    session: { current: () => (session === null ? null : session.current()) },
    vault: required(vault, 'shares'),
    keys: required(keys, 'shares'),
    entry: (id) => catalogEntryOf(id),
    connection: () => guildConnection(),
    gate: (reason, password) => authenticate(reason, password),
    onChanged: () => sync?.afterWrite(),
  });
  // V1/K1: the session says when the row of an activation is written and the new keys are in hand —
  // the first moment a `bv1.` value can be sealed under this account's `vaultKey`. `reset` is true
  // for an access-code activation (SP02 §7: a fresh salt, so the pair sealed under the old key can
  // never open) and for a sign-in that wiped this machine's vault: either way the key pairs are
  // regenerated (SP06 §2). The host row does not exist yet at this moment — the join writes it right
  // after — so this stores the pair, and the `afterUnlock` that closes the same call publishes it
  // (SP06 §2's `PUT /v1/keys`).
  session.onActivated(async (event) => {
    await ensureKeys(event.reset);
  });
  // Connected mode (SP05 §1): the host client holds no state and makes no call of its own, and the
  // sync loop only ever asks it for a connection built from the `host` row (RF-30).
  client = createHostClient({ fetch, keychain: bearers });
  sync = createSync({
    repo: database,
    connection: () => connectionOf(),
    now: () => Date.now(),
    // O2: the version of this build, against the host's `minAppVersion`.
    appVersion: () => appVersion,
    onState: (state) => {
      push('host', state);
      // SP05 §2: a run that moved the snapshot moves the catalog with it, and the page hears it once
      // — a `304` advances `last_sync_at` alone, and the catalog it would push is the same one.
      const moved = refreshConnectedCatalog();
      if (moved) afterCatalogChange();
      // K1–K2/SP06 §2: an applied snapshot is also what the pin table and this machine's own pair
      // follow. First sight of a colleague pins; a different pair marks them changed; and the
      // person's own entry says whether the host still holds the pair this machine published (a
      // reset elsewhere makes it publish again). Both are local reads of the cached body, made on
      // the runs that carried a new one; the calls are chained, not awaited, because the state push
      // the page is waiting for does not depend on them.
      if (moved) {
        void keys?.observe();
        void keys?.ensure(guildConnection());
      }
      // K9/SP06 §4: every run is a chance to deliver an update a save could not (`retryPending`),
      // and an applied snapshot is when an incoming `update` of a credential already held lands
      // with no gate (`applyUpdates`). Both are chained: the state push does not wait for them.
      void shares?.retryPending();
      if (moved) void shares?.applyUpdates();
      // SP05 §6: the snapshot's `guildIcon` is what says which icon this machine should hold. The
      // call is chained, not awaited: the state push the page is waiting for does not depend on it.
      syncGuildIcon();
      // F2: the snapshot's `me` is also what the local person follows — the name and the admin flag
      // of a connected account are the host's to say, and the page hears about it when they move.
      void reconcileConnectedIdentity();
    },
    onSignedOut: () => {
      // SP04 §3/RF-39: the session is gone — the bearer is dropped and the page asks to sign in.
      // `host.last_error` already carries `SIGNED_OUT_ERROR`, which is what the state reports.
      const connection = connectionOf();
      if (connection !== null) void connection.forgetToken();
    },
    // K8/SP06 §4, RF-47: an admin's Nod reads the members still without an assigned copy on every
    // run that reached the host (`backend/shares.ts` keeps the list) and `host.state` carries the
    // count. A non-admin's keychain-person clears it, and the read never fails a run.
    refreshAssignments: () => shares?.refreshAssignments() ?? Promise.resolve(),
    missingCopies: () => shares?.missingCount() ?? 0,
    // 0.5.0 (RF-60): `HostState.offlineSession`, and with it the sidebar's "not syncing" banner —
    // the session is what knows, and it is created before this.
    offlineSession: () => offlineSession(),
    setInterval: (run, ms) => setInterval(run, ms),
    // `Sync` keeps its handle opaque (`unknown`); the runtime's `clearInterval` takes back the id
    // its own `setInterval` answered.
    clearInterval: (handle) => clearInterval(handle as number),
  });
  // B7/SP05 §2: the personal layer. Which home a write gets is `db.hostRecord()`'s answer at the
  // moment of the write — the row, not the cache — and the two callbacks are what makes the write
  // visible: the local one reloads the catalog, the connected one re-derives the snapshot's with the
  // new outbox row applied, pushes it and asks the sync loop for a run of its own (SP04 §3–§4).
  personal = createPersonal({
    repo: database,
    entries: () => visibleEntriesOf(),
    personId: () => unlockedPerson('personal').id,
    connected: () => database.hostRecord() !== null,
    now: () => Date.now(),
    removeCredentials: (toolId) => required(vault, 'personal.removeTool').removeAllForTool(toolId),
    onWrite: () => {
      if (connectedMode) {
        refreshConnectedCatalog();
        afterCatalogChange();
        return;
      }
      void afterChange();
    },
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
 * §4: opens `nod.db` and brings it to the current schema. A database written by Nod v1 is moved
 * aside — nothing is deleted — and a fresh one takes its place, with the name of the moved file
 * kept in `meta.legacy_database` so the owner can find it.
 */
async function openDatabase(directory: string): Promise<Repo> {
  const path = `${directory}/nod.db`;
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
 * Renames `nod.db` and the WAL siblings that exist to `nod.v1-<yyyyMMddHHmmss>.db` — in UTC, the
 * clock the whole app keeps — in the same directory. Answers the new name. Nothing is deleted: the
 * moved files are the whole v1 database, for whoever wants to look at it.
 */
async function moveDatabaseAside(directory: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const moved = `nod.v1-${stamp}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${directory}/nod.db${suffix}`;
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
  // one they are the local catalog's — SP05 §4's order too, with the person's own tools and their
  // views (B7: favorites → org → personal, the rule the connected half already follows). A Nod older
  // than the guild's minimum is served the local half the same way (O2, owner 2026-10-17): the guild
  // is disconnected, so `connectedMode` is false and this reads the tables.
  if (connectedMode) return connectedEntries;
  const layer = personal;
  return layer === null ? visibleEntries(r.listEntries(), person) : layer.localCatalog(person);
}

/**
 * SP05 §2: the effective catalog of the `host` row the caller just read — the snapshot while one
 * exists and this Nod is not older than the guild's minimum, the local tables otherwise. It is
 * derived wherever the row can have moved (the boot, an unlock, a join, a removal and every state
 * the sync publishes) and answers whether what the page sees changed since the last derivation.
 *
 * The outbox goes in with the row: a personal write that is still queued is SP05 §2's overlay over
 * the snapshot's personal half, so the catalog this derivation answers already carries it.
 */
function refreshConnectedCatalog(): boolean {
  const r = repo;
  const catalog = connected;
  if (r === null || catalog === null) return false;
  const record = r.hostRecord();
  const changed = catalog.refresh(record, r.listOutbox());
  // O2/SP04 §1 (owner decision 2026-10-17): too old for the guild, the row's snapshot is not the
  // catalog any more — the local tables are, as if no host existed. The row, the bearer and the
  // cached body stay on disk, and Settings → Hosts keeps showing the guild.
  const updated = catalogMode(record !== null, disconnected()) === 'connected';
  // A mode that moved is news to the page even when the snapshot did not (the transition into the
  // disconnected state, and the one back out of it once the host lowers its minimum or the app is
  // updated) — without this the sidebar would keep the catalog of the previous mode.
  const moved = changed || updated !== connectedMode;
  connectedMode = updated;
  connectedEntries = catalog.entries();
  return moved;
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
  // The local catalog first, so a personal tool answers with the views the person hung under it (B7)
  // — the same entry `tools.openView` indexes. A row that is not visible to this person still answers
  // from the table, which is what the admin's Tools tab edits.
  return visibleEntriesOf().find((entry) => entry.id === id) ?? r.entry(id);
}

/**
 * M7/RF-54: the signed body of the last verified snapshot, or `null` without one. The signature was
 * checked before `backend/sync.ts` stored the bytes, so this parses what the pinned key signed;
 * `backend/shares.ts` reads its own fields from the same cached body.
 *
 * O2/SP04 §1 (owner, 2026-10-17): while this Nod is older than the guild's minimum the body is not
 * shown at all — the guild is disconnected and the Nod runs on its local catalog — so the one reader
 * of this (the admin's holders list, M7) answers empty. The bytes stay in the row.
 */
function snapshotBody(): Snapshot | null {
  if (disconnected()) return null;
  const record = repo === null ? null : repo.hostRecord();
  if (record === null || record.snapshot === null) return null;
  try {
    const value = JSON.parse(record.snapshot) as unknown;
    return typeof value === 'object' && value !== null ? (value as Snapshot) : null;
  } catch {
    return null;
  }
}

/**
 * M7/RF-54, finding M7 of `docs/handovers/block2-review.md`: every credential the verified snapshot
 * carries holder rows for — every credential of the guild, for an admin — with the roster's names
 * and the tool each one belongs to.
 *
 * The signed body names the credential but not its tool, so the tool comes from what this Nod knows:
 * its own vault rows (SP06 §3's `vault_item.credential_id`), the shares addressed to it (an
 * `IncomingShare` names the pair), and the admin's missing-copy rows (K8's rows name it too). A
 * credential none of them names is still listed, under its own id with no title, so the admin loses
 * no holder row (`backend/holders.ts`).
 */
function credentialHolders(): CredentialHolders[] {
  const snapshot = snapshotBody();
  const person = currentPerson();
  const tools: Record<string, Id> = {};
  if (person !== null && repo !== null) {
    for (const item of repo.listVault(person.id)) {
      if (item.credentialId !== null) tools[item.credentialId] = item.toolId;
    }
  }
  for (const share of snapshot?.incomingShares ?? []) tools[share.credentialId] = share.toolId;
  for (const row of shares === null ? [] : shares.missing()) tools[row.credentialId] = row.toolId;
  return buildCredentialHolders({
    holders: snapshot?.holders,
    people: snapshot?.people,
    toolOf: (credentialId) => tools[credentialId] ?? null,
    titleOf: (toolId) => catalogEntryOf(toolId)?.title ?? null,
  });
}

function toolsState(): ToolsState {
  return windows === null ? { tools: [] } : windows.state();
}

/**
 * RF-65: the credential a tool window fills with — the default of the tool, because a person may
 * hold several of one and which one fills is their own choice (`vault.setDefault`). The window knows
 * its tool; the vault knows the rule.
 */
function credentialOf(toolId: Id): Promise<{ username: string; secret: string } | null> {
  const person = currentPerson();
  const store = vault;
  return store === null || person === null ? Promise.resolve(null) : store.readDefault(person.id, toolId);
}

/** The origin the default credential of this tool was saved for; null without one (RF-38, RF-65). */
function vaultOriginOf(toolId: Id): string | null {
  const r = repo;
  const person = currentPerson();
  return r === null || person === null ? null : r.vaultOrigin(person.id, toolId);
}

/**
 * RF-65/SP06 §6: the two audit events of the vault, built in one place so the rule has one home and
 * one test (`test/vault-events.test.ts`). The event names the tool and the credential's own id —
 * **never** its label, which defaults to the username (`VaultItem.label`), and never a value of the
 * secret: a local event is pushed to the host (`backend/sync.ts`), and the host may not hold a
 * username of a vault in clear (RF-44). The item id is opaque to the host; the label is not.
 */
export function credentialEvent(
  type: 'credential_saved' | 'credential_removed',
  personId: Id,
  item: VaultItem,
): EventInput {
  return { personId, toolId: item.toolId, type, url: null, result: null, detail: item.id };
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

/**
 * B8b/RF-40: this Nod's local tools the verified snapshot does not already carry — the catalog the
 * person saw before joining, minus the tools the guild serves itself (org) and the personal rows the
 * snapshot's own personal half already holds. A local `personal` row (B7, added before the host
 * existed) is hidden from the connected catalog, so without this it would disappear on a join
 * (RF-40's fix). The snapshot is read the way the catalog layer reads it; a body this side cannot
 * read answers nothing, the same way an absent one does, so the Hosts tab shows no offer rather than
 * an error the person cannot act on.
 *
 * O2/SP04 §1 (owner, 2026-10-17): while this Nod is older than the guild's minimum the guild is
 * disconnected and the local tables are the catalog again, so nothing is a leftover and the offer to
 * keep them has nothing to offer (`host.adoptLocalAsPersonal` is refused in that state).
 */
function leftoverTools(): Entry[] {
  const r = repo;
  if (disconnected()) return [];
  const record = r === null ? null : r.hostRecord();
  if (r === null || record === null || record.snapshot === null) return [];
  let orgTools: Entry[];
  let personalTools: Entry[];
  try {
    const rows = parseSnapshot(JSON.parse(record.snapshot) as unknown);
    orgTools = rows.orgTools;
    personalTools = rows.personalTools;
  } catch {
    return [];
  }
  const person = currentPerson();
  const local = r
    .listEntries()
    .filter(
      (entry) => (entry.scope ?? 'org') === 'org' || (person !== null && entry.ownerId === person.id),
    );
  return leftoverLocalTools(local, orgTools, personalTools);
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

/**
 * SP02 §9/`docs/canonico.md` §22: whether this run is a non-release dev run, from the stamp
 * `scripts/gen-config.ts <mode>` leaves in the resources folder (`shared/build-mode.ts`). A release
 * stages no stamp — it is not in the `"resources"` list — so its read throws and answers `false`;
 * a stamp that names anything but `dev` is a release too (fail closed).
 */
async function readDevRun(resourcesDir: string | null): Promise<boolean> {
  if (resourcesDir === null) return false;
  try {
    const bytes = await tjs.readFile(`${resourcesDir}/${BUILD_MODE_STAMP}`);
    return stampMode(new TextDecoder().decode(bytes)) === 'dev';
  } catch {
    return false;
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
      title: 'Nod',
      icon: trayIcon(resources),
      tooltip: 'Nod',
      menu: [
        { id: 'open', label: 'Open Nod' },
        { id: 'lock', label: 'Lock' },
        { separator: true },
        { id: 'quit', label: 'Quit Nod' },
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
  // 0.5.3 (RF-64): both are the owner's writes; a non-owner admin reaches them and the host is the
  // one that refuses with `403 owner only`, exactly like a member is refused the rest here.
  'people.update': true,
  'people.delete': true,
  'people.revoke': true,
  'people.sessions': true,
  'people.revokeSession': true,
  'invites.issue': true,
  // 0.5.0 (RF-59): the guild's invites are the admin's — the host refuses a member the same way.
  'guildInvites.list': true,
  'guildInvites.create': true,
  'guildInvites.revoke': true,
  'host.bootstrap': true,
  'host.setGuildIcon': true,
  'host.clearGuildIcon': true,
  // K8/SP06 §4: the assignment of a credential and the missing list behind it are the admin's; the
  // host refuses a member the same way (`admin only`, SP03 §1).
  'assignments.set': true,
  'assignments.missing': true,
  'assignments.sealMissing': true,
  // M7/RF-54: the snapshot carries an admin the holder rows of every credential, so the list that
  // shows them is the admin's; a member gets the same refusal the host gives (`admin only`).
  'holders.list': true,
  'events.list': true,
  'events.syncStatus': true,
  'events.exportToFile': true,
  'nod.installUpdate': true,
};

/** The only methods that work with the session locked (§2); the rest require an unlock. */
const WITHOUT_SESSION: Partial<Record<Method, true>> = {
  'session.state': true,
  // 0.5.0 (RF-60): the tiles of the entry screen are what the locked window draws before a password.
  'session.profiles': true,
  // RF-61: the seed import belongs to the first run, which is unlocked by definition — no account
  // exists yet, so there is no session to open.
  'session.importSeed': true,
  'session.createAccount': true,
  'session.unlock': true,
  'session.unlockBiometric': true,
  // SP05 §3: the first run has no account at all, and a join is what creates the connected one.
  'host.discover': true,
  'host.activate': true,
  'host.signIn': true,
  // 0.5.0 (RF-59): the invite card is shown before the account exists — someone with only a link has
  // no session here yet, and the preview carries no secret but the code the person already holds.
  'host.invitePreview': true,
  'nod.info': true,
  'nod.quit': true,
};

/**
 * O2/SP04 §1 (owner decision 2026-10-17): the methods that reach the host. While this Nod is older
 * than the host's `minAppVersion` the guild is **disconnected** — no call leaves the machine but the
 * discovery and the `GET /v1/meta/app` of a sync run — so every one of them is refused with
 * `UPDATE_REQUIRED_ERROR` before anything goes out. `HOST_WRITES`/`HOST_READS` below are that rule's
 * two halves and `backend/sync.ts` pushes nothing in the same state.
 *
 * The reads of the *cached* snapshot are not host calls and are not here: they answer empty instead
 * (`snapshotBody`, the `shares`/`keys` reads the catalog layer no longer feeds), and the catalog
 * layer runs on the local tables (`shared/catalog.ts`'s `catalogMode`).
 *
 * `host.remove` stays open: it takes the row, the bearer and the cache away on this machine and asks
 * the host nothing. The discovery stays open too (the person must be able to see the guild and its
 * fingerprint); the joins and the sign-in refuse themselves over the discovery's `minAppVersion`,
 * before the salt request, the code and the `authKey` (`beginAuth`).
 *
 * The person's writes of block 2 (`personal.*`, `favorites.set`) are here too (B8b's fix): while
 * connected they reach the host through the outbox, and a disconnected Nod must not queue a write
 * the newer host may not read back. A write the host holds nothing of is not here either:
 * `catalog.importFromFile` and `vault.*` are this machine's own.
 */
const HOST_WRITES: Partial<Record<Method, true>> = {
  // SP02 §7: with a host, the password is rewritten there first.
  'session.changePassword': true,
  'catalog.save': true,
  'catalog.remove': true,
  'roles.save': true,
  'roles.remove': true,
  'roles.grant': true,
  'people.setRoles': true,
  // 0.5.3 (RF-64): `PATCH`/`DELETE /v1/admin/people/:id` are rows on the host's side.
  'people.update': true,
  'people.delete': true,
  'people.revoke': true,
  'people.revokeSession': true,
  // O1/SP03 §2: `DELETE /v1/sessions/:id` is a write to the host's session row. It used to stay open
  // as a security action; a disconnected guild reaches no route, so it is refused like the rest.
  'host.revokeSession': true,
  'invites.issue': true,
  // 0.5.0 (RF-59): both invite writes are rows on the host's side.
  'guildInvites.create': true,
  'guildInvites.revoke': true,
  'host.bootstrap': true,
  // B8b: it writes the guild's personal half for this person (through the outbox), so an outdated
  // Nod refuses it like the other `host.*` writes.
  'host.adoptLocalAsPersonal': true,
  'host.setGuildIcon': true,
  'host.clearGuildIcon': true,
  // B7/B8b: SP05 §2–§4's personal writes. While connected each queues a row for the host, so an
  // outdated Nod refuses them like the `host.*` writes — the outbox is not flushed anyway.
  'personal.saveTool': true,
  'personal.removeTool': true,
  'personal.saveView': true,
  'personal.removeView': true,
  'favorites.set': true,
  // K4: the sealed copies and the recipient's answer are writes to the host's share rows. A Nod
  // this old must not send, accept or decline against a host that asked for a newer one.
  'shares.send': true,
  'shares.accept': true,
  'shares.decline': true,
  // K9: revoking a holder is a write to the host's holder row (the update a save fans out is not
  // here: its connection is already null while the gate is up, so it waits as a pending marker).
  'shares.removeHolder': true,
  // K8/SP06 §4: the assignment row and the sealing of the copies behind it are the admin's writes
  // to the host; `assignments.missing` is only a read and answers empty instead (O2).
  'assignments.set': true,
  'assignments.sealMissing': true,
};

/**
 * O2/SP04 §1: the reads whose whole answer is the host's own — the device sessions of this person
 * (O1) and of any person of the guild (the admin's People screen), over `GET /v1/sessions` and
 * `GET /v1/admin/people/:id/sessions`. A disconnected Nod refuses them with the same sentence as the
 * writes rather than answering a list it cannot know. `people.list`, `events.list` and
 * `host.presence` are not here: they have a local answer (this machine's people and its own log) or
 * the empty one of a Nod with no guild, and they answer that instead.
 */
const HOST_READS: Partial<Record<Method, true>> = {
  'host.sessions': true,
  'people.sessions': true,
  // 0.5.0 (RF-59): the guild's invites are only the host's to list.
  'guildInvites.list': true,
};

/**
 * O2 + 0.5.0 (RF-60): whether this Nod's guild is **disconnected** — it is older than the host's
 * `minAppVersion`, or the session entered through the Offline tile. Both mean the same thing to
 * every caller: no call leaves the machine, the local tables are the catalog and the reads that only
 * the host can answer answer nothing. A Nod with no `host` row has no guild to disconnect: an Offline
 * session there is the plain local Nod, whose admin writes go to the local tables as always. Pure,
 * so a test pins the rule without the runtime.
 */
export function disconnectedSession(
  updateRequired: boolean,
  mode: 'offline' | 'guild' | null,
  hasHost: boolean,
): boolean {
  return hasHost && (updateRequired || mode === 'offline');
}

/**
 * O2/SP04 §1: whether `method` is refused while this Nod is older than the host's `minAppVersion`
 * or while the session is offline. The two tables are the one decision, and `disconnected()` is the
 * other; kept as pure predicates so a test can pin both halves (a disconnected Nod refuses; a local
 * one, with no `host` row, has `updateRequired` false and is never stopped) without booting the
 * runtime.
 */
export function hostWriteRefused(method: Method, disconnected: boolean): boolean {
  return HOST_WRITES[method] === true && disconnected;
}

export function hostReadRefused(method: Method, disconnected: boolean): boolean {
  return HOST_READS[method] === true && disconnected;
}

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
    // O2 + 0.5.0 (RF-60): the guild is disconnected, and this method would reach the host — a write
    // or a read only the host can answer. Anything else reaches no route and is answered below.
    const offline = offlineSession();
    const stopped = disconnectedSession(requiresUpdate(), offline ? 'offline' : null, hasHostRow());
    if (hostWriteRefused(method, stopped) || hostReadRefused(method, stopped)) {
      throw new Error(offline ? OFFLINE_SESSION_ERROR : UPDATE_REQUIRED_ERROR);
    }
    return handler(params, app, meta);
  };
}

/** O2: what the sync loop last derived — `false` while no host row exists or no minimum arrived. */
function requiresUpdate(): boolean {
  const running = sync;
  return running !== null && running.state().updateRequired;
}

/** 0.5.0 (RF-60): the session entered through the Offline tile — the guild is disconnected for it. */
function offlineSession(): boolean {
  const s = session;
  return s !== null && s.mode() === 'offline' && hasHostRow();
}

/** RF-30: a guild exists on this machine only while the `host` row does. */
function hasHostRow(): boolean {
  return repo !== null && repo.hostRecord() !== null;
}

/**
 * O2 + 0.5.0 (RF-60): the one predicate every reader of the guild goes through — the sync gate, the
 * RPC gate, `guildConnection()`, `snapshotBody()` and the catalog layer. `shared/catalog.ts`'s
 * `catalogMode`, `backend/sync.ts`'s state and this file's reads all see the same answer.
 */
function disconnected(): boolean {
  return disconnectedSession(requiresUpdate(), session === null ? null : session.mode(), hasHostRow());
}

function requireToolOrigin(toolId: Id, origin: string | undefined): void {
  if (origin === undefined || origin === '') return; // Windows/Linux do not stamp the origin
  // The effective catalog (SP05 §2): a connected entry comes from the snapshot and may have no local
  // `tool` row at all, and its window is still the entry's own origin. In local mode this is the
  // same `repo.entry` it always was.
  const entry = catalogEntryOf(toolId);
  if (entry === null) throw new Error('unknown tool');
  if (origin !== originOf(entry.url)) throw new Error('login.report only comes from the tool origin');
}

function unlockedPerson(where: string): Person {
  const person = required(session, where).current();
  if (person === null) throw new Error('session is locked');
  return person;
}

// ---------------------------------------------------------------- the K5 gate

/** SP02 §9: which of the two factors one gated call uses, or none at all. */
export type GateFactor = 'password' | 'biometrics' | 'unavailable';

/**
 * SP02 §9's factor, pure. The machine decides first: where the runtime reports `authenticate`,
 * `app.authenticate` is the factor and the page sends no password at all. The typed password is the
 * factor where that capability is absent (Linux — SP02 §9's classical fallback), in a non-release
 * dev run (`devRun`, `docs/canonico.md` §22 "Gate in a dev run": the unattended smoke passes the
 * account password so no operating system prompt can block it), and after the system prompt did
 * not confirm in this unlocked session (`promptFailed`, canonico §22 "Gate fallback when the system
 * prompt fails": the capability is per OS, so a Windows machine without Hello reports it and then
 * answers `false` to every prompt). Until a prompt fails, a release build never takes a password
 * on a capable machine. `unavailable` is the refusal: neither capability nor password.
 *
 * Exported for the test that pins the rule without a runtime (`test/gate.test.ts`).
 */
export function gateFactor(
  password: string | undefined,
  biometrics: boolean,
  devRun: boolean,
  promptFailed: boolean,
): GateFactor {
  const typed = typeof password === 'string' && password !== '';
  if (biometrics) return typed && (devRun || promptFailed) ? 'password' : 'biometrics';
  return typed ? 'password' : 'unavailable';
}

/**
 * Owner on 2026-10-17 ("peça sempre no máximo uma vez", choosing "once per session, with a
 * timeout"): a confirmed gate — the Touch ID unlock, or a gated action that passed — covers the next
 * gated actions of the same unlocked person until 15 minutes pass without one. Each covered action
 * restarts the clock (idle, not absolute); a lock forgets it.
 */
export const GATE_WINDOW_MS = 15 * 60 * 1000;

/** Whether a gate confirmed at `confirmedAt` still covers a call made at `now` (pure, for the test). */
export function gateStillOpen(confirmedAt: number | null, now: number): boolean {
  return confirmedAt !== null && now >= confirmedAt && now - confirmedAt < GATE_WINDOW_MS;
}

/** The last confirmation of the gate in this unlocked session: whose, and when (`Date.now()`). */
let gateConfirmed: { personId: Id; at: number } | null = null;

/** Records a confirmation by `personId` now: the Touch ID unlock and every gate that passes. */
function confirmGate(personId: Id): void {
  gateConfirmed = { personId, at: Date.now() };
}

/**
 * K5/SP06 §4: the one gate behind `vault.reveal`, `vault.copy`, `shares.send`, `shares.accept` and
 * the admin's `assignments.*` seals.
 *
 * A confirmation of the same person still inside `GATE_WINDOW_MS` covers the call and nothing is
 * asked. Otherwise, where the machine has `app.authenticate` that prompt runs — the person is
 * present. When it does not confirm, the refusal is `GATE_PROMPT_FAILED` and the session remembers
 * it, so the page's next call may carry the typed password instead (`gateFactor`). Without the
 * capability, or after that failure, a password the call carries is verified against the verifier
 * of the unlocked person's row (`verifyStoredPassword`, SP02 §6), exactly as it always was on Linux.
 * A machine with neither factor refuses: nothing is shown, copied, sent or accepted, and no message
 * carries a password or a secret.
 */
async function authenticate(reason: string, password?: string): Promise<void> {
  const person = unlockedPerson('authentication');
  if (gateConfirmed !== null && gateConfirmed.personId === person.id && gateStillOpen(gateConfirmed.at, Date.now())) {
    confirmGate(person.id);
    return;
  }
  const factor = gateFactor(password, biometrics, devRun, promptFailed);
  if (factor === 'unavailable') throw new Error(GATE_PASSWORD_REQUIRED);
  if (factor === 'biometrics') {
    if (!(await required(runtime, 'authentication').authenticate(reason))) {
      promptFailed = true;
      throw new Error(GATE_PROMPT_FAILED);
    }
    confirmGate(person.id);
    return;
  }
  // `factor === 'password'` — `gateFactor` answers it only for a non-empty string.
  const typed = password ?? '';
  const found = required(repo, 'authentication').personAuthByEmail(person.email);
  if (found === null || found.person.id !== person.id) throw new Error(GATE_PASSWORD_REQUIRED);
  if (!(await verifyStoredPassword(typed, found.password))) {
    throw new Error(GATE_PASSWORD_REQUIRED);
  }
  confirmGate(person.id);
}

// ---------------------------------------------------------------- input helpers

function required<T>(value: T | null, where: string): T {
  if (value === null) throw new Error(`${where}: Nod has not finished starting`);
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

/** 0.5.0 (RF-60): one tile of the entry screen, as the page sends it back. */
function entryTarget(value: unknown): EntryTarget {
  const raw = object(value, 'invalid target');
  if (raw.kind === 'offline') return { kind: 'offline' };
  if (raw.kind !== 'guild') throw new Error('invalid target');
  return { kind: 'guild', id: text(raw.id, 'invalid target') };
}

function orNull(value: unknown, message: string): string | null {
  return value === undefined || value === null ? null : text(value, message);
}

function optional<T>(value: unknown, convert: (input: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : convert(value);
}

/**
 * K5: the `password` of a gated call — a plain string, empty included (the gate is what refuses
 * it). Anything that is not a string is the caller's mistake, not a wrong password.
 */
function optionalPassword(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('invalid password');
  return value;
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
 * F1: the typed answer of a join whose email is a local account of this Nod and whose person has
 * not decided which one wins. It is answered before any host call — the code the person was given is
 * whole — and the page asks (SP05 §4's join flow, `src/settings.ts`).
 */
function localAccountChoice(person: Person): JoinResult {
  return { kind: 'local-account', personId: person.id, email: person.email, name: person.name };
}

/**
 * F2: the snapshot's `me` (SP04 §2) is the last word on the connected person — its name and its
 * admin flag. It runs on every state the sync publishes (an applied snapshot included), so an admin
 * created by an access code reaches the admin screens after the first sync and a demoted one leaves
 * them. The push only happens when something moved, and only the session: the catalog and the tools
 * are `refreshConnectedCatalog`'s own.
 */
async function reconcileConnectedIdentity(): Promise<void> {
  const s = session;
  const me = connected === null ? null : (connected.current()?.me ?? null);
  if (s === null || me === null) return;
  if (!s.reconcileConnectedIdentity({ id: me.id, name: me.name, admin: me.admin })) return;
  push('session', await s.state());
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
 * `nod.installUpdate`). A failure turns into one audit event with the reason and nothing else.
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
  info = withHotfixes(info);
  const latest = info.latest;
  updateNotice =
    info.available && latest !== null && latest !== (await dismissedUpdate()) ? info : null;
  push('update', updateNotice);
}

/**
 * 0.5.5a (`docs/distribuicao.md` §8): the runtime's `update.check` compares only the three numbers,
 * so a Nod on 0.5.5 hears "nothing new" about 0.5.5a. The Nod's own comparison (`shared/version.ts`)
 * reads the hotfix letters and turns that answer into the offer. It only ever adds an offer the
 * runtime missed; `update.install` does not compare versions, it installs what the manifest names.
 */
function withHotfixes(info: UpdateInfo): UpdateInfo {
  if (info.available || info.latest === null) return info;
  return { ...info, available: compareVersions(info.current, info.latest) < 0 };
}

/** RF-55: one check shortly after the launch, then one every 24 hours. Without a channel the seed
 * names, none of this runs — no address in the code, no call out of a Nod that has no channel. */
function startUpdateWatch(): void {
  if (bundledSeed === null || bundledSeed.update === null) return;
  setTimeout(() => void refreshUpdateNotice(), UPDATE_FIRST_CHECK_MS);
  setInterval(() => void refreshUpdateNotice(), UPDATE_CHECK_MS);
}

/**
 * SP02 §7/RF-43: an activation or a sign-in that re-keyed an existing account leaves its saved
 * logins sealed with the old `vaultKey` (SP02 §8). The answer's `wipedVault` is what tells the
 * person on screen.
 *
 * F1 is not a reset: a local account with another id is *adopted*, and `adoptConnectedAccount`
 * re-seals its credentials under the new key. A reset is the same person id re-activating with a
 * fresh salt (`local.id === personId`), where there is nothing to move — the values are unreadable
 * with the new key and go.
 */
async function wipeResetVault(
  r: Repo,
  s: Session,
  local: Person | null,
  personId: Id,
): Promise<boolean> {
  if (local === null || local.id !== personId || r.listVault(local.id).length === 0) return false;
  const previous = r.personAuthByEmail(local.email);
  if (previous === null || previous.password.algorithm !== PASSWORD_V2_ALGORITHM) return false;
  await s.wipeVault(local.id);
  return true;
}

/** §4: unlocking or creating an account pushes session and tools, then restores the open tools. */
async function afterUnlock(state: SessionState): Promise<SessionState> {
  const open = required(windows, 'session');
  // K5: a fresh session starts on the system prompt again (canonico §22, gate fallback).
  promptFailed = false;
  // RF-63: whatever an older Nod left in the system keychain for this person is copied into the
  // `secret` table once, right after the first unlock, and never again (`importLegacy`). After that
  // the only keychain item this backend reads is the biometric one.
  if (state.person !== null) await importLegacy(state.person.id);
  // SP05 §2: before anything reads an entry — a join has just added the `host` row, and the tools
  // this function pushes next come from the effective catalog.
  refreshConnectedCatalog();
  // SP05 §6: the icon of the cached snapshot, before the loop's first run: after a restart the app
  // carries the bundle icon again, and this is what puts the guild's back.
  syncGuildIcon();
  push('session', state);
  push('tools', open.state());
  await open.restore();
  push('tools', open.state());
  // RF-55: the notice the launch check already found, for the window that had not subscribed yet.
  push('update', updateNotice);
  // SP05 §3: the host state goes with the session, so the sidebar knows before any sync ran.
  push('host', hostState());
  // SP02 §3/SP06 §2, K1: a sign-in on a machine without a pair generates one here, and an account
  // whose host lost the pair behind a reset re-publishes it (`ensure` reads the cached roster). The
  // activation hook does the same one step earlier for the activation itself; this is the unlock
  // that is not one, and the second call changes nothing. Only a connected account has a pair: a
  // local one never reaches SP06 §2.
  //
  // 0.5.0 (RF-60): an offline session reaches no host at all — no pair is published and the loop
  // does not start, so the entry by the Offline tile is the same disconnect as having no host. The
  // O2 case is left as it was: there the run itself is what confirms the minimum.
  const host = offlineSession() ? null : required(repo, 'host').hostRecord();
  if (host !== null) await ensureKeys(false);
  // SP04 §3: the unlock is the first trigger of a sync. RF-30: without a `host` row there is no
  // client and no call, so `start()` is only armed when there is something to sync with.
  const running = sync;
  if (running !== null && host !== null) running.start();
  return state;
}

/**
 * RF-63: copies what an older Nod left in the system keychain for `personId` — the vault items, the
 * E02 pair and the guild bearer — into the `secret` table, through `importLegacySecrets`: one
 * attempt per person ever, read-only, only the keys the table lacks, nothing deleted, a refused item
 * counted and never retried. From then on no read of this person's reaches the keychain, so a new
 * build of the app finds nothing there to prompt about. A plaintext (a 0.5.0 bearer, a pre-V1
 * credential) is sealed under the session's `vaultKey` on the way in.
 */
async function importLegacy(personId: Id): Promise<void> {
  const r = repo;
  const app = runtime;
  const vaultKey = session === null ? null : session.vaultKey();
  if (r === null || app === null || vaultKey === null) return;
  const host = r.hostRecord();
  const bearer = host !== null && host.personId === personId ? hostTokenKey(host.kid, personId) : null;
  const keys = [
    ...r.listVault(personId).map((item) => item.keychainKey),
    keysKey(personId),
    ...(bearer === null ? [] : [bearer]),
  ];
  await importLegacySecrets({ rows: r, keychain: app.secrets }, personId, keys, async (key, plaintext) => {
    if (key === bearer) return encryptVaultBytes(vaultKey, key, new TextEncoder().encode(plaintext));
    const credential = plainVaultCredential(plaintext);
    return credential === null ? null : encryptVaultValue(vaultKey, key, credential);
  }).catch(() => 0);
}

/** §4: locking closes every tool window and the popups they opened. */
function lockSession(): SessionState {
  // SP04 §3: nothing is synced while locked — the state a locked Nod shows is the cache.
  sync?.stop();
  promptFailed = false;
  gateConfirmed = null;
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
 * K1/SP06 §2 + O2/SP04 §1: the connection every host call past the sync's own uses — the key
 * publish, the share flows, the guild icon and the admin routes — or `null`. While this Nod is older
 * than the host's `minAppVersion` the guild is disconnected (owner decision 2026-10-17), so there is
 * none: the pair waits locally, the vault shares nothing, the icon on disk stays where it is, and the
 * screens that would read the guild answer from this machine instead.
 */
function guildConnection(): HostConnection | null {
  return disconnected() ? null : connectionOf();
}

/**
 * K1/SP06 §2: makes sure this machine holds the unlocked person's key pairs and that the host knows
 * their public halves — the call an activation, an unlock and an applied snapshot make. `regenerate`
 * is SP02 §7's reset, whose pairs are made again. Named apart because `afterUnlock` shadows `keys`
 * with the `vaultKey` it reads there; best effort, because `keys.ensure` never throws and never
 * fails an unlock.
 */
async function ensureKeys(regenerate: boolean): Promise<void> {
  await keys?.ensure(guildConnection(), { regenerate });
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

/** What the prologue of a join and of a sign-in hands back (SP02 §4). */
export interface AuthPrologue {
  /** SP04 §1: the discovery, whose document names the guild and the version it serves. */
  found: HostDiscovery;
  /** SP02 §4: the iteration count and the salt the host published for this email. */
  published: SaltResponse;
  /** The pre-auth connection the credential request goes over. */
  connection: HostConnection;
}

/** What the discovery prologue of a join, a sign-in and an invite preview needs (SP04 §1, O2). */
export interface DiscoveryDeps {
  /** SP04 §1: the discovery — the address, with the fingerprint the person confirmed or the pin. */
  discover: () => Promise<HostDiscovery>;
  /** SP04 §1: the minimum the discovery carries, kept in memory for `host.state`. */
  observe: (minAppVersion: string) => void;
  /** O2: the version of the running app (`app.info().version`), or `null`. */
  appVersion: () => string | null;
}

/** What `beginAuth` needs, injected so a test drives it without a runtime. */
export interface AuthPrologueDeps extends DiscoveryDeps {
  /** SP02 §4: the pre-auth connection built from that discovery (`preAuthConnection`). */
  connect: (found: HostDiscovery) => HostConnection;
}

/**
 * SP04 §1 + O2/SP04 §1 (owner decision 2026-10-17): the discovery every sequence makes before
 * anything of the guild leaves this machine — a join, a sign-in, and the invite preview of RF-59,
 * which has no email and no salt to ask for.
 *
 * The discovery document already carries the guild's `minAppVersion`, so a Nod older than it stops
 * right here — no access code, no `authKey` and no password reaches the host — with the sentence the
 * sync's gate and the RPC gate answer with. A host that serves no minimum, or one
 * `shared/version.ts` cannot read, refuses nothing. The check is the discovery's answer and not the
 * remembered one: a Nod that was offline when the host raised the minimum must not spend a code on a
 * join it cannot make.
 *
 * Exported, and free of `tjs`/`tiny`, so `bun test` pins it against a scripted discovery: the rule
 * is that nothing but the discovery leaves the machine while this Nod is too old.
 */
export async function discoverFor(deps: DiscoveryDeps): Promise<HostDiscovery> {
  const found = await deps.discover();
  deps.observe(found.document.minAppVersion);
  if (tooOldFor(deps.appVersion(), found.document.minAppVersion)) {
    throw new Error(UPDATE_REQUIRED_ERROR);
  }
  return found;
}

/**
 * The two host calls a join and a sign-in make before any credential leaves the machine: the
 * discovery (`discoverFor`) and, only when the guild takes this Nod, the salt request of SP02 §4.
 */
export async function beginAuth(deps: AuthPrologueDeps, email: string): Promise<AuthPrologue> {
  const found = await discoverFor(deps);
  const connection = deps.connect(found);
  const published = await connection.request<SaltResponse>('POST', HOST_ROUTES.authSalt, { email });
  return { found, published, connection };
}

/**
 * 0.5.0 (RF-59): which route a code takes, and whether the person's name travels with it. The kind
 * is read from the code itself (SP02 §3's length rule) and never from what the screen was showing:
 * a setup code creates the first admin, an invite creates the person who redeems it — both are named
 * — and an access code redeems the row of somebody who already exists. `null` is not a code at all,
 * which the caller refuses with the single `invalid code` sentence.
 *
 * Pure and exported, like `hostWriteRefused`, so `bun test` pins the routing without the runtime.
 */
export function activateRoute(code: string): { kind: CodeKind; route: string; needsName: boolean } | null {
  const kind = codeKindOf(code);
  if (kind === null) return null;
  const route =
    kind === 'setup'
      ? HOST_ROUTES.authSetup
      : kind === 'invite'
        ? HOST_ROUTES.authJoin
        : HOST_ROUTES.authActivate;
  return { kind, route, needsName: kind !== 'access' };
}

/**
 * 0.5.0 (RF-59): the invite card `host.invitePreview` answers — the guild of the invite, the names of
 * the roles it grants, and the address and fingerprint the person just confirmed. The icon travels
 * as a data URI; the host sends the PNG as base64url (the repo's rule for binary on the wire,
 * `docs/specs/README.md`), which a `data:` URI cannot carry as it is.
 *
 * Pure, so `bun test` pins the mapping without a host.
 */
export function inviteView(found: HostDiscovery, preview: InvitePreview): InviteView {
  return {
    guild: preview.guild,
    address: found.address,
    fingerprint: found.fingerprint,
    roles: preview.roles.map((role) => role.name),
    expiresAt: preview.expiresAt,
    usesLeft: preview.usesLeft,
    icon: preview.icon === null ? null : `data:image/png;base64,${bytesToBase64(fromBase64url(preview.icon))}`,
  };
}

/**
 * 0.5.0 (RF-59): the two `404`s of the invite routes, as sentences this side writes. The host's own
 * body never reaches a Nod (`backend/host-client.ts` reads none on a failure), so every refusal a
 * screen has to explain is worded here — like F7's `invalid code or password`.
 */
const INVALID_INVITE = 'invalid invite';
/** A role of the invite was deleted after the invite was created; the use is not spent. */
const INVITE_ROLE_GONE = 'the invite names a role the guild no longer has';

/**
 * SP03 §2's `device`: the host shows it in the session list (O1). None of it is a secret.
 */
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

/** SP05 §3 `host.state`: the one guild, or the `none` of a Nod that was never connected. */
function hostState(): HostState {
  return required(sync, 'host.state').state();
}

// ---------------------------------------------------------------- entry screen (0.5.0, RF-60/61)

/** What `entryProfiles` reads, injected so a test drives the answer without a runtime. */
export interface ProfilesDeps {
  /** People on this machine, revoked included (`Repo.countPeople`). */
  countPeople: () => number;
  /** An unused local invite exists, so even the first account needs a code (canonico §9). */
  hasOpenInvite: () => boolean;
  /** The person of the last unlock, for the Offline tile's prefilled email. */
  lastPerson: () => Promise<Person | null>;
  /** The one `host` row, or `null` (`Repo.hostRecord`). */
  hostRecord: () => { address: string; guild: string; personId: Id; snapshot: string | null } | null;
  /** The local person of the guild's own account; `null` when their row is gone. */
  personById: (id: Id) => Person | null;
  /** The `guildIcon` of the cached body — `undefined` without a row (SP04 §2). */
  snapshotIconHash: () => string | null | undefined;
  /** That icon as a data URI, when the bytes on disk are the signed ones. */
  guildIcon: (hash: string | null) => Promise<string | null>;
  /** The guild as `host.state` reports it (status, updateRequired). */
  hostState: () => HostState;
  /** The tile of the last unlock (`Session.lastEntry`). */
  lastEntry: () => Promise<EntryTarget | null>;
  /** Biometrics enabled for the last person (`SessionState.biometric`). */
  biometric: () => Promise<boolean>;
}

/**
 * 0.5.0 (RF-60): the tiles of the entry screen, drawn before any password. The Offline profile is
 * always there — it is this machine's own account, or the offer of one — and the guild(s) come from
 * the `host` row; today that is at most one (canonico §22 "Guilds per install"), and the id of a
 * tile is the guild's address so several can live here later. Nothing of this answer is a secret:
 * names, an address, a fingerprint-derived icon, and no code, token or password.
 *
 * Exported, and free of `tjs`/`tiny`, so `bun test` drives the whole answer with a fake repository.
 */
export async function entryProfiles(deps: ProfilesDeps): Promise<EntryProfiles> {
  const total = deps.countPeople();
  const host = deps.hostRecord();
  const guilds: GuildProfile[] = [];
  if (host !== null) {
    const person = deps.personById(host.personId);
    const state = deps.hostState();
    const hash = deps.snapshotIconHash();
    guilds.push({
      // 0.5.0: one guild, named by the address it is pinned to — the id `EntryTarget` carries.
      id: host.address,
      guild: host.guild,
      address: host.address,
      icon: await deps.guildIcon(hash === undefined ? null : hash),
      // A guild account the local table lost (a revocation) leaves the tile with nothing to prefill.
      email: person === null ? '' : person.email,
      name: person === null ? '' : person.name,
      status: state.status,
      updateRequired: state.updateRequired,
    });
  }
  const last = await deps.lastPerson();
  const remembered = await deps.lastEntry();
  return {
    offline: {
      // Revoked people included (P6): one of them already means this machine is not new.
      hasAccount: total > 0,
      requiresInvite: total > 0 || deps.hasOpenInvite(),
      email: last === null ? null : last.email,
      // RF-61: a seed is a first-run import — with any account here there is nothing to set up.
      seedImportable: total === 0,
    },
    guilds,
    // A remembered guild this Nod no longer holds (`host.remove`) preselects nothing: the entry
    // screen must not open on a tile it has no way to draw.
    last:
      remembered !== null && remembered.kind === 'guild' && !guilds.some((tile) => tile.id === remembered.id)
        ? null
        : remembered,
    biometric: await deps.biometric(),
  };
}

/** What `importSeed` needs, injected so a test drives the refusal without a runtime. */
export interface SeedImportDeps {
  /** How many people this machine holds — any of them closes the window (RF-61). */
  countPeople: () => number;
  /** Applies the seed of `path` in boot mode; `null` when it did not advance (`applySeedFile`). */
  apply: (path: string) => Promise<SeedApplied | null>;
}

/** RF-61: what `session.importSeed` answers when this machine already has an account. */
export const SEED_IMPORT_REFUSED = 'this Nod already has an account — the seed is only imported at setup';

/**
 * 0.5.0 (RF-61): the optional seed import of the first run. It is the same core the release's own
 * seed runs through at boot (`applySeedFile`, boot mode: only what is missing, only a newer
 * version), so a seed imported here and one embedded in the release leave the same tables — and
 * `null` means the file was already applied (or is not a seed this build can read).
 *
 * Only while this Nod has no account at all: the tables a seed writes are the catalog and the
 * invites, and both belong to somebody once an account exists. The origins the runtime gate opens
 * are the embedded seed's alone — `tinyjs.json` is built, not read at runtime (RF-61) — so a seed
 * imported here can fill the catalog and never widen what a tool may call.
 *
 * Exported, and free of `tjs`/`tiny`, so `bun test` pins the refusal without the runtime.
 */
export async function importSeed(deps: SeedImportDeps, path: string): Promise<SeedApplied | null> {
  if (deps.countPeople() > 0) throw new Error(SEED_IMPORT_REFUSED);
  return await deps.apply(path);
}

// ---------------------------------------------------------------- guild icon (SP05 §6)

/**
 * `tjs.remove(path)` deletes a file. txiki.js has it — its own bridge uses it for its temporary
 * files — but `backend/tjs.d.ts` is the minimal typing file for the globals this backend uses and
 * does not declare it yet. Finding for the coordinator, who owns that file; this slice keeps one
 * named cast here instead of editing someone else's typings. The read is late on purpose: no global
 * is touched while the module is being evaluated.
 */
function removeFile(path: string): Promise<void> {
  const files = tjs as unknown as { remove: (path: string) => Promise<void> };
  return files.remove(path);
}

/**
 * SP04 §2's `guildIcon` of the body in the `host` row: the digest, or `null` when that body says the
 * guild has no icon. `undefined` is a different answer — no `host` row at all (or a body that does
 * not read) — and it means the machine is not connected, so nothing of the guild's is touched.
 */
function snapshotIconHash(): string | null | undefined {
  const row = repo === null ? null : repo.hostRecord();
  if (row === null) return undefined;
  if (row.snapshot === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.snapshot) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || !('guildIcon' in value)) return undefined;
  const icon = value.guildIcon;
  return typeof icon === 'string' && icon !== '' ? icon : null;
}

/**
 * SP05 §6: hands the icon of the snapshot just applied to `backend/guild-icon.ts`. It is called
 * after every state the sync publishes and once after an unlock, and never awaited: the page is
 * waiting for the state, not for a PNG, and a failure leaves the icon the machine already has —
 * which the next sync retries.
 */
function syncGuildIcon(): void {
  const icon = guildIcon;
  if (icon === null) return;
  const hash = snapshotIconHash();
  // RF-30: without a `host` row there is no guild whose icon could have moved. `host.remove` is what
  // deletes the file in that case.
  if (hash === undefined) return;
  void icon.sync(hash).catch(() => undefined);
}

/** SP05 §6: `nod.setAppIcon`'s one parameter, refused with the same sentence as the screen's. */
function appIconChoice(value: unknown): AppIconChoice {
  if (value !== 'default' && value !== 'guild') throw new Error('invalid app icon choice');
  return value;
}

/**
 * SP05 §6/SP03 §2: the PNG an admin picked, as `PUT /v1/admin/guild/icon` takes it — base64url of
 * the bytes. The host decides (it refuses anything that is not a PNG and anything past its body
 * limit); this side checks the same two things first so that the refusal is one sentence instead of
 * a `400` from a guild the person cannot see.
 */
function guildIconBody(value: unknown): string {
  const png = text(value, 'invalid guild icon');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64url(png);
  } catch {
    throw new Error('invalid guild icon');
  }
  if (!isPng(bytes)) throw new Error('the guild icon must be a PNG');
  // SP03 §2 caps the route's body at 512 KB, and what travels is the base64url of the bytes: a
  // larger PNG is refused here, before a body no host would take. (`docs/handovers/
  // i2b-guild-icon-app.md` has the finding that the constant is not in `shared/host-api.ts`.)
  if (png.length > GUILD_ICON_MAX_ENCODED) {
    throw new Error('the guild icon is too large — PNG files up to 384 KiB');
  }
  return png;
}

/**
 * SP03 §2's body limit for the icon routes, in the encoded form that actually travels: a 512 KB
 * base64url string is a PNG of at most 384 KiB.
 */
const GUILD_ICON_MAX_ENCODED = 512 * 1024;

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
    // SP04 §1.3: the page subscribes before it calls this at boot, so a `nod://join` link that
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

  /**
   * 0.5.0 (RF-60): the tiles the entry screen draws, before any password. Everything it needs is
   * this machine's own — the people table, the `host` row, the cached body's icon hash — and no call
   * leaves here, which is what lets a locked window show the guild it is disconnected from.
   */
  'session.profiles': async (): Promise<EntryProfiles> => {
    const r = required(repo, 'session.profiles');
    const s = required(session, 'session.profiles');
    const state = await s.state();
    return await entryProfiles({
      countPeople: () => r.countPeople(),
      hasOpenInvite: () => r.listInvites().some((invite) => invite.usedAt === null),
      lastPerson: () => s.lastPerson(),
      hostRecord: () => r.hostRecord(),
      personById: (id) => r.personById(id),
      snapshotIconHash: () => snapshotIconHash(),
      guildIcon: (hash) => (guildIcon === null ? Promise.resolve(null) : guildIcon.dataUri(hash)),
      hostState: () => hostState(),
      lastEntry: () => s.lastEntry(),
      // `state()` is already here: the answer is the same one `session.state` gives, so asking the
      // keychain twice for it would be one read too many.
      biometric: async () => state.biometric,
    });
  },

  /**
   * 0.5.0 (RF-61): the optional seed import of the first run — the page picks the file with
   * `tiny.dialog` and hands the path over. The tables it writes are the local ones (the catalog,
   * the roles and the invites), exactly as an embedded seed would at boot; the runtime origin gate
   * is untouched (it is built, RF-61), so this never widens what a tool may call.
   */
  'session.importSeed': async (params): Promise<SessionState> => {
    const r = required(repo, 'session.importSeed');
    const s = required(session, 'session.importSeed');
    const store = required(icons, 'session.importSeed');
    const path = text(parameters(params, 'invalid file').path, 'invalid path');
    const applied = await importSeed(
      {
        countPeople: () => r.countPeople(),
        // A relative icon of an imported seed is ignored, like every seed read outside the bundle:
        // the file the person picked is not a release's `resources/` (`backend/seed.ts`).
        apply: (file) => applySeedFile(r, file, null, store, (target) => tjs.readFile(target)),
      },
      path,
    );
    if (applied !== null) {
      // Like `catalog.importFromFile`: the counts go in the log, never a value of the file. No
      // person is unlocked yet, so the event belongs to the machine.
      r.addEvent({
        personId: null,
        toolId: null,
        type: 'catalog_imported',
        url: null,
        result: 'seed',
        detail: seedCountsDetail(applied.counts),
      });
    }
    // The tiles of the entry screen follow the seed: the offers are the seed's (the roles and the
    // invites it brought), and the page is told before it is answered.
    const state = await s.state();
    push('session', state);
    return state;
  },

  /**
   * 0.5.0 (RF-60): unlocking from a tile. `target` is that tile — absent means the Offline one —
   * and `backend/session.ts` refuses a guild target that is not the guild's own person with the
   * same `invalid credentials` a wrong password gets (a tile is never an oracle). The mode it
   * records is what makes the whole guild side of this session disconnected; the tile is kept in
   * `store` so the next entry screen preselects it.
   */
  'session.unlock': async (params) => {
    const p = parameters(params, 'invalid credentials');
    return afterUnlock(
      await required(session, 'session.unlock').unlock({
        email: text(p.email, 'invalid credentials'),
        password: text(p.password, 'invalid credentials'),
        target: optional(p.target, (value) => entryTarget(value)),
      }),
    );
  },

  'session.unlockBiometric': async (params) => {
    const p = parameters(params, 'invalid credentials');
    const state = await required(session, 'session.unlockBiometric').unlockBiometric({
      target: optional(p.target, (value) => entryTarget(value)),
    });
    // The fingerprint of the unlock is the session's first confirmation of the gate (owner,
    // 2026-10-17): the next reveal or copy inside `GATE_WINDOW_MS` asks nothing more.
    if (state.person !== null) confirmGate(state.person.id);
    return afterUnlock(state);
  },

  'session.enableBiometric': (params) => {
    const p = parameters(params, 'invalid password');
    return required(session, 'session.enableBiometric').enableBiometric(
      text(p.password, 'invalid password'),
    );
  },

  // SP02 §9: the item that holds the `vaultKey` goes; the password remains the only way in.
  'session.disableBiometric': () =>
    required(session, 'session.disableBiometric').disableBiometric(),

  'session.changePassword': async (params): Promise<true> => {
    const p = parameters(params, 'invalid passwords');
    const connection = connectionOf();
    // K1/`docs/canonico.md` §22: the pair does not change with the password, but the `vaultKey` that
    // seals it does (SP02 §7). The session still holds the old one at this point, so it is read
    // first; `reSeal` then opens the keychain value and the host blob with it and seals both again
    // under the new key, leaving the public halves — and every colleague's pin — untouched.
    const previousVaultKey = session === null ? null : session.vaultKey();
    // M1/SP02 §7: the host's blob is marked stale **before** the vault moves. A process that dies
    // between the two, or a host that refuses the new blob, leaves that mark in place: the next
    // `ensure` republishes the blob even though the public halves already match, and `keys.mine`
    // answers `pending` until it lands — see `backend/keys.ts`. Without it the host would keep a
    // blob sealed under a key nobody holds and every other machine of this person would be stuck.
    keys?.beginReseal();
    // SP02 §7: when a host is connected, the host rewrites its salt and hash **first**; only then
    // does the local verifier follow. The request carries the two `authKey`s, never a password.
    try {
      await required(session, 'session.changePassword').changePassword(
        text(p.current, 'invalid current password'),
        text(p.next, 'invalid new password'),
        connection === null
          ? undefined
          : async (request: PasswordChangeRequest): Promise<void> => {
              await connection.request('POST', HOST_ROUTES.authPassword, request);
            },
      );
    } catch (error) {
      // F3: the change was refused (a wrong current password locally, or a host that would not take
      // the new `authKey`), so the vault did not move and the host's blob is not stale. The mark
      // `beginReseal` just left would make Settings → Account answer `pending` until the next
      // unlock, for a change that never happened — clear it and report the refusal.
      const person = session?.current();
      if (person !== null && person !== undefined) keys?.clearReseal(person.id);
      throw error;
    }
    await keys?.reSeal(previousVaultKey, guildConnection());
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
    // O2: the discovery already carries the oldest version the host serves, so the gate knows it
    // before this Nod is even connected. The discovery itself is never refused — the person has to be
    // able to see the guild and its fingerprint; the joins and the sign-in refuse themselves on this
    // version (`beginAuth`).
    sync?.observeMinVersion(found.document.minAppVersion);
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
    const adoptLocal = optional(p.adoptLocal, (value) => booleanValue(value, 'invalid join')) ?? false;

    // SP05 §2 keeps one guild at a time. Replacing the row here would drop the current host's
    // bearer and snapshot without a word, so the person removes the host first.
    if (r.hostRecord() !== null) {
      throw new Error('Nod is already connected to a host — remove it first');
    }

    // 0.5.0 (RF-59): the code the person typed decides the route — a setup code creates the first
    // admin, a guild invite creates the account the person just chose (both carry a name), and an
    // access code redeems the row of somebody who already exists.
    const opening = activateRoute(code);
    if (opening === null) throw new Error('invalid code');
    if (opening.needsName && name === undefined) throw new Error('invalid name');
    // F1/F3/F7: the local half of the join first — the collision with a local account of this Nod
    // and the choice it asks for, the unlocked session F3 demands, and the one sentence a wrong code
    // becomes. Nothing here has reached the host yet: a join the page has not decided does not spend
    // the code (`hostPinned` is `false` by construction — activation refuses over an existing host).
    const gate = await s.joinGate({
      email,
      adoptLocal,
      hostPinned: false,
      signIn: false,
      host: async () => {
        // SP04 §1.3: the invite's `fp` must be the key the host answers. A mismatch throws inside the
        // discovery, before any request past it, and stores nothing. O2: the same call refuses a Nod
        // the guild's `minAppVersion` is above, before the salt request and before the code is spent.
        const { found, published, connection } = await beginAuth(
          {
            discover: () => c.discover(address, { fingerprint }),
            connect: (host) => preAuthConnection(host),
            observe: (version) => sync?.observeMinVersion(version),
            appVersion: () => appVersion,
          },
          email,
        );
        // SP02 §1: at activation the Nod chooses the person's salt. SP02 §7's reset is a new salt,
        // so the one the host answers is only read, never stored — another machine's cached salt is
        // what notices a reset, and it must never match by accident.
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
        // SP02 §3/RF-59: a setup code and an invite both create the person, so both carry the name.
        let opened: TokenResponse;
        try {
          opened = await connection.request<TokenResponse>(
            'POST',
            opening.route,
            opening.needsName ? { ...body, name } : body,
          );
        } catch (error) {
          // 0.5.0 (RF-59): the host refuses a join whose invite names a role it has since deleted
          // with `404 unknown role`, and it does not spend a use of the invite. F7's `401` (a wrong
          // code) is `joinGate`'s own.
          if (opening.kind === 'invite' && error instanceof HostError && error.status === 404) {
            throw new Error(INVITE_ROLE_GONE);
          }
          throw error;
        }
        return { found, published, salt, opened };
      },
    });
    // F1: the typed answer of a join the person has not decided yet: nothing was sent, the code is
    // whole, and the page asks which of the two accounts wins.
    if (gate.kind === 'choose') return localAccountChoice(gate.person);
    const { found, published, salt, opened } = gate.answer;

    const connection = c.connect({
      address: found.address,
      kid: found.pin.kid,
      publicKey: found.pin.ed25519Public,
      personId: opened.personId,
    });
    // SP02 §7/RF-43: activation chooses a fresh salt. An F1 adoption (another local id) is *not* a
    // reset — its saved logins are re-sealed under the new key by `adoptConnectedAccount`; only the
    // same person re-activating has values that nothing can open, and those are wiped before the row
    // is rewritten. The answer carries the flag the page uses to tell the person.
    const wipedVault = await wipeResetVault(r, s, gate.local, opened.personId);
    const state = await s.adoptConnectedAccount({
      personId: opened.personId,
      email,
      // The host knows the person's name; an access-code activation learns it from the first
      // snapshot, and the local row carries the email until then. An adopted local account has one
      // of its own, which is the better of the two until the snapshot answers (F2).
      name: name ?? gate.local?.name ?? email,
      password,
      salt,
      iterations: published.iterations,
      // An access-code activation says nothing about the roles: the snapshot fills them (B4/B5).
      // RF-59: an invite's person is a member — only the setup code creates the first admin.
      admin: opening.kind === 'setup',
      // K1/SP02 §7: an activation (or the setup) always picks a fresh salt, so the account's
      // `vaultKey` moved and `onActivated` must regenerate the E02 pair — even a machine that never
      // held the account, where `wipeResetVault` found nothing to wipe.
      activation: true,
      ...(gate.local === null ? {} : { adoptLocalId: gate.local.id }),
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
    // 0.5.0 (RF-60): the join entered as the guild, and the tile of it — its address — is what the
    // next entry screen preselects.
    await s.rememberEntry({ kind: 'guild', id: found.address });
    pendingJoin = null;
    return { kind: 'session', session: await afterUnlock(state), wipedVault } satisfies JoinResult;
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
    const adoptLocal = optional(p.adoptLocal, (value) => booleanValue(value, 'invalid join')) ?? false;

    const row = r.hostRecord();
    // F3: with a host row this is the sign-in of the host this Nod already has. It goes to the
    // address the row pinned and to no other — the page prefills it from the row, so a different one
    // is a Nod being pointed at a second host, not a sign-in.
    if (row !== null && originOf(address) !== originOf(row.address)) {
      throw new Error('this Nod is connected to another host — remove it first');
    }
    // F1/F3/F7: the same local gate. With a host row the session may stay locked (that is the
    // signed-out case F3 is about) and the attempt pays the unlock backoff; without one, a Nod that
    // already has an account needs that account's session like `host.activate` does.
    const gate = await s.joinGate({
      email,
      adoptLocal,
      hostPinned: row !== null,
      signIn: true,
      host: async () => {
        // SP04 §1: a host that is already added is pinned, so a second key is never accepted
        // silently; a host that is not has only the fingerprint the person confirmed (or the invite
        // carried). O2: the discovery of a sign-in carries the minimum too — this Nod may have been
        // offline when the host raised it — and a Nod below it signs in nowhere: the password is not
        // even derived (`beginAuth`).
        const { found, published, connection } = await beginAuth(
          {
            discover: () =>
              c.discover(
                row === null ? address : row.address,
                row === null
                  ? { fingerprint }
                  : { pinned: { kid: row.kid, ed25519Public: row.publicKey } },
              ),
            connect: (host) => preAuthConnection(host),
            observe: (version) => sync?.observeMinVersion(version),
            appVersion: () => appVersion,
          },
          email,
        );
        // SP02 §4: the person's own salt for an activated account (a fake one would sign nobody in).
        const keys = await s.deriveFor(password, published.salt, published.iterations);
        const opened = await connection.request<TokenResponse>('POST', HOST_ROUTES.authLogin, {
          email,
          authKey: toBase64url(keys.authKey),
          device: await deviceOf(),
        } satisfies LoginRequest);
        return { found, published, opened };
      },
    });
    if (gate.kind === 'choose') return localAccountChoice(gate.person);
    const { found, published, opened } = gate.answer;

    // SP02 §7: the host answered a salt other than the one this machine cached, so the account was
    // reset somewhere else. The saved logins of this machine go before the new keys are adopted
    // (RF-43) — and only for the person the host just signed in. The answer carries the flag the
    // page uses to tell the person.
    const same = row !== null && row.personId === opened.personId;
    const wipedVault = same && row.salt !== published.salt;
    if (wipedVault && row !== null) await s.wipeVault(row.personId);

    const local = r.personById(opened.personId);
    const connection = c.connect({
      address: found.address,
      kid: found.pin.kid,
      publicKey: found.pin.ed25519Public,
      personId: opened.personId,
    });
    await s.adoptConnectedAccount({
      personId: opened.personId,
      email,
      name: local === null ? (gate.local?.name ?? email) : local.name,
      password,
      salt: published.salt,
      iterations: published.iterations,
      // The snapshot is what says who is an admin (B4/B5); the local row is the last word until the
      // first sync below.
      admin: local !== null && local.admin,
      ...(gate.local === null || gate.local.id === opened.personId ? {} : { adoptLocalId: gate.local.id }),
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
    // 0.5.0 (RF-60): a sign-in is a guild entry too — the tile of that guild is preselected next.
    await s.rememberEntry({ kind: 'guild', id: found.address });
    pendingJoin = null;
    // F2 (RF-48 finding 2 of `docs/handovers/k10-smoke.md`): a fresh machine has no local account,
    // so `admin` above is `false` until the first snapshot — the host's `me.admin` is the last word.
    // The sign-in therefore runs that first sync here, before it answers, so the returned state
    // already carries the admin flag (and the name) instead of reporting a guild admin as a member.
    // It is the run the loop would make a moment later; a failure is the run's own state.
    await sync?.syncNow();
    return { kind: 'session', session: await afterUnlock(await s.state()), wipedVault } satisfies JoinResult;
  },

  'host.syncNow': async () => {
    if (required(repo, 'host.syncNow').hostRecord() === null) {
      throw new Error('Nod is not connected to a host');
    }
    return await required(sync, 'host.syncNow').syncNow();
  },

  /**
   * 0.5.0 (RF-59): what a guild invite opens, before any account exists — the guild, its icon, the
   * roles the invite grants and how long and how often it still works. Works locked: somebody with
   * only a link has no session here.
   *
   * The discovery is the same one a join makes, so the `fp` of the link is checked against the key
   * the host answers (SP04 §1.3) and a Nod the guild's `minAppVersion` is above stops before the
   * code leaves this machine (`discoverFor`).
   */
  'host.invitePreview': async (params): Promise<InviteView> => {
    const c = required(client, 'host.invitePreview');
    const p = parameters(params, 'invalid invite');
    const address = text(p.address, 'invalid address');
    const fingerprint = text(p.fingerprint, 'invalid fingerprint');
    const code = text(p.code, 'invalid code');
    const found = await discoverFor({
      discover: () => c.discover(address, { fingerprint }),
      observe: (version) => sync?.observeMinVersion(version),
      appVersion: () => appVersion,
    });
    let preview: InvitePreview;
    try {
      preview = await preAuthConnection(found).request<InvitePreview>(
        'POST',
        HOST_ROUTES.authInvite,
        { code },
      );
    } catch (error) {
      // SP03 §2: one `404` on this route means the code is invalid, used up, expired or revoked.
      if (error instanceof HostError && error.status === 404) throw new Error(INVALID_INVITE);
      throw error;
    }
    return inviteView(found, preview);
  },

  // -------------------------------------------------------------- guild invites (0.5.0, RF-59)
  /**
   * The guild's invites, revoked ones included — the admin screen shows their state.
   *
   * RF-64: on a host older than 0.5.0 the route does not exist and this throws `HOST_TOO_OLD`
   * (`backend/host-admin.ts`'s `listInvites`). The People tab's invite card treats that as a note and
   * still renders the person list it already loaded (`src/settings.ts`); this RPC keeps throwing, so
   * the screen — not the backend — decides how the old host is shown.
   */
  'guildInvites.list': async (): Promise<GuildInvite[]> => {
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');
    return await admin.listInvites();
  },

  /**
   * An invite the admin hands over: the roles it grants, how many times it may be used and when it
   * ends. The answer carries the code once and the `nod://join` link built from this machine's own
   * row — the address and the fingerprint it pinned — so the invitee sees the guild before typing
   * anything. The code never enters an event or a log.
   */
  'guildInvites.create': async (params) => {
    const r = required(repo, 'guildInvites.create');
    const actor = unlockedPerson('guildInvites.create');
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');
    // The link needs the address and the fingerprint of the `host` row, and `host.state` is the one
    // reader of both (the fingerprint is derived from the pinned key).
    const guild = hostState();
    if (guild.address === null || guild.fingerprint === null) {
      throw new Error('Nod is not connected to a host');
    }
    const p = parameters(params, 'invalid invite');
    const input: CreateInviteRequest = {
      roles: textList(p.roles, 'invalid roles'),
      maxUses: optional(p.maxUses, (value) => integer(value, 'invalid max uses')) ?? null,
      expiresInMinutes:
        optional(p.expiresInMinutes, (value) => integer(value, 'invalid expiry')) ?? null,
    };
    const created = await admin.createInvite(
      input,
      // RF-64: the guild's role ids, as this Nod listed them (`rolesOf`, SP05 §2). The invite routes'
      // `404` only means "unknown role" against this list; a role that is here means the host has no
      // `/v1/admin/invites` at all (`HOST_TOO_OLD`), which is the deployed-host bug this fixes.
      rolesOf().map((role) => role.id),
    );
    // Like `invites.issue`: what the log keeps is the roles and the terms, never the code.
    r.addEvent({
      personId: actor.id,
      toolId: null,
      type: 'invite_issued',
      url: null,
      result: null,
      detail:
        `roles: ${input.roles.length === 0 ? 'none' : input.roles.join(', ')} — ` +
        `uses: ${input.maxUses === null ? 'no limit' : input.maxUses} — ` +
        `expires: ${created.invite.expiresAt ?? 'never'}`,
    });
    return {
      invite: created.invite,
      code: created.code,
      link: joinLink({ address: guild.address, fingerprint: guild.fingerprint, code: created.code }),
    };
  },

  /** Revoking ends the invite; a person who already joined keeps the account it made (RF-59). */
  'guildInvites.revoke': async (params): Promise<true> => {
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');
    unlockedPerson('guildInvites.revoke');
    const id = text(parameters(params, 'invalid invite').id, 'invalid invite');
    return await admin.revokeInvite(id);
  },

  'host.remove': async (params) => {
    const r = required(repo, 'host.remove');
    // SP05 §3, B7: the flag decides what happens to the personal half of the snapshot — the tools,
    // their views and the favorites stay as local data (`tool` rows and the local store), or go with
    // the host. `clearHost` never touches them either way.
    const keepPersonal = booleanValue(parameters(params, 'invalid removal').keepPersonal, 'invalid removal');

    sync?.stop();
    const connection = connectionOf();
    // SP02 §5: the bearer goes with the host; without a row nothing would ever read it again.
    if (connection !== null) await connection.forgetToken();
    // Before the row goes, while the last verified body is still readable (SP05 §2).
    const last = r.hostRecord();
    required(personal, 'host.remove').adoptSnapshot(
      last === null ? null : last.snapshot,
      last === null ? '' : last.personId,
      keepPersonal,
      // B8b: a write still in the outbox is part of the personal half the person is deciding about —
      // `clearHost` below takes the outbox with the host, so the overlay is what keeps a personal
      // tool the person just added (a join's adopted leftovers, offline included).
      r.listOutbox(),
    );
    r.clearHost();
    // SP05 §6: the guild's icon goes with the guild — the file and the app icon it was showing.
    await required(guildIcon, 'host.remove').reset();
    // SP05 §2: without a `host` row the local tables are the catalog again — "removing the host
    // returns to them" — so the effective catalog and the page's list are re-derived here.
    refreshConnectedCatalog();
    afterCatalogChange();
    const state = hostState();
    push('host', state);
    return state;
  },

  /**
   * B8a (SP05 §4, RF-40): the first admin of a host that has no org tool publishes this Nod's local
   * catalog — the `org` rows of the local `tool` table with their views and their icons, and the
   * local roles — through `POST /v1/admin/bootstrap`. The host writes it all in one go and refuses a
   * second time (SP03 §2); the refusal comes back as `refused` so the offer can end without the page
   * having to read a status.
   */
  'host.bootstrap': async () => {
    const r = required(repo, 'host.bootstrap');
    const actor = unlockedPerson('host.bootstrap');
    const store = required(icons, 'host.bootstrap');
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');

    // The local catalog, not the effective one: publishing the snapshot's own tools back to the host
    // would be a no-op at best. A local personal tool is not part of the guild's catalog (RF-40).
    const local = r.listEntries().filter((entry) => (entry.scope ?? 'org') === 'org');
    const tools = await localEntriesWithIcons(local, store);
    if (tools.length === 0) throw new Error('this Nod has no local tools to publish');
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

  /**
   * B8b/RF-40: what the Hosts tab lists as the leftovers of a join. The ids are the local rows the
   * verified snapshot does not carry — an `org` row the guild does not serve on its address, or a
   * `personal` row (B7) the snapshot's personal half does not hold — each with its icon resolved to
   * a data URI so the page can show the same tool the person saw before joining.
   */
  'host.localLeftovers': async (): Promise<Entry[]> => {
    unlockedPerson('host.localLeftovers');
    const store = icons;
    const rows = leftoverTools();
    return store === null ? rows : await localEntriesWithIcons(rows, store);
  },

  /**
   * B8b/RF-40: keeps the chosen leftovers as this person's personal tools. Each one goes through
   * `backend/personal.ts`'s `adoptLocalTool` — the same path `personal.saveTool` takes — and its
   * local row goes away with it: the tool is the guild's now, and a local row left behind would show
   * up a second time once the host is removed. An `org` row moves to a fresh `p-…` id and its saved
   * credential is re-pointed before the row goes; a local `personal` row keeps its own id, so its
   * credential and the snapshot's copy already agree.
   */
  'host.adoptLocalAsPersonal': async (params): Promise<{ created: number }> => {
    const r = required(repo, 'host.adoptLocalAsPersonal');
    const layer = required(personal, 'host.adoptLocalAsPersonal');
    const store = icons;
    const ids = textList(parameters(params, 'invalid tools').ids, 'invalid tools');
    const rows = leftoverTools();
    const withIcons = store === null ? rows : await localEntriesWithIcons(rows, store);
    const done = new Set<Id>();
    let created = 0;
    for (const id of ids) {
      // Only a leftover is kept: an id the snapshot already carries is the guild's, and the page can
      // only have sent one the list it read gave it. A repeated id is kept once.
      if (done.has(id)) continue;
      done.add(id);
      const local = withIcons.find((entry) => entry.id === id);
      if (local === undefined) continue;
      const entry = layer.adoptLocalTool(local, local.icon);
      // The saved credentials follow the tool when its id changes (`repo.rekeyVaultTool` keeps each
      // row's keychain key and its own id, so every sealed value still opens — RF-65), then the local
      // row — and its views, already copied above — go.
      if (entry.id !== id) r.rekeyVaultTool(id, entry.id);
      r.removeEntry(id);
      created += 1;
    }
    return { created };
  },

  /**
   * SP05 §6, SP03 §2: the PNG the guild shows as its app icon. Admin only (the §2 guard) and only
   * while a host is connected: the host stores the bytes and answers their SHA-256, which is what
   * reaches every member inside the next signed snapshot (SP04 §2) — the bytes themselves travel
   * only to the Nod that fetched them.
   */
  'host.setGuildIcon': async (params): Promise<{ sha256: string }> => {
    const connection = guildConnection();
    if (connection === null) throw new Error('Nod is not connected to a host');
    const png = guildIconBody(parameters(params, 'invalid guild icon').png);
    const answer = await connection.request<GuildIconResponse>('PUT', HOST_ROUTES.adminGuildIcon, {
      png,
    } satisfies GuildIconRequest);
    // The write landed on the host, so what is left is to make it visible: the sync that follows
    // brings the body whose `guildIcon` is this digest, and the state push fetches and applies the
    // bytes (`syncGuildIcon`). A host that cannot be reached leaves the write where it landed.
    await afterHostWrite();
    return { sha256: answer.sha256 };
  },

  /** SP05 §6, SP03 §2: the guild has no icon again, and the next body says `guildIcon: null`. */
  'host.clearGuildIcon': async (): Promise<true> => {
    const connection = guildConnection();
    if (connection === null) throw new Error('Nod is not connected to a host');
    await connection.request('DELETE', HOST_ROUTES.adminGuildIcon);
    await afterHostWrite();
    return true;
  },

  /**
   * O1/SP03 §2: this person's devices, as the host holds them — the row of each, its name, OS and
   * app version, and when it was last seen. No token and no hash of one travels (SP02 §5), and
   * nothing of it is written here: the list is the host's answer, shown while the screen is open.
   */
  'host.sessions': async (): Promise<DeviceSession[]> => {
    unlockedPerson('host.sessions');
    const connection = guildConnection();
    if (connection === null) throw new Error('Nod is not connected to a host');
    return await connection.sessions();
  },

  /**
   * O1/SP03 §2: ends one of this person's own sessions. The device signs out at its next sync —
   * the `401` of SP04 §3, which is the path RF-39 already handles — so revoking this machine's own
   * session is the same thing seen from the other side.
   */
  'host.revokeSession': async (params): Promise<true> => {
    unlockedPerson('host.revokeSession');
    const connection = guildConnection();
    if (connection === null) throw new Error('Nod is not connected to a host');
    await connection.revokeSession(text(parameters(params, 'invalid session').id, 'invalid session'));
    return true;
  },

  /**
   * K1/SP06 §2: the state of this person's own E02 pair — the fingerprint to read out, whether it
   * is still waiting to be published, and the sentence Settings → Account shows when it cannot be
   * used (`keys unavailable — sign in again`, SP02 §7). A local account, or a connected one whose
   * pair is not generated yet, answers `unavailable` with no fingerprint. No key material crosses
   * here — a fingerprint is a digest of the two public keys.
   */
  'keys.mine': (): Promise<MineKeys> => required(keys, 'keys.mine').mine(),

  /**
   * K2/SP06 §2: the guild's colleagues, the fingerprint of each and whether the pair is the one
   * this machine pinned. The read is also a first sight (SP06 §2), so a colleague whose keys the
   * roster just started carrying is pinned here and the screen never misses what the next applied
   * snapshot would have pinned. A local account, or one with no snapshot yet, answers nothing — and
   * so does a disconnected Nod (O2, owner 2026-10-17): the roster the list comes from is the cached
   * body, and nothing of the guild is shown while this build is too old for it.
   */
  'peers.list': (): Promise<PeerKey[]> =>
    disconnected() ? Promise.resolve([]) : required(keys, 'peers.list').peers(),

  /**
   * K2/RF-45: the person confirmed that a changed key is really that colleague's. The pair whose
   * `fingerprint` the page is showing becomes the pinned one, `confirmed_at` moves and sending to
   * them is allowed again (SP06 §2). L2: the fingerprint is what the confirmation is checked
   * against, so a pair the host replaced between the list and the click is refused instead of
   * promoted unseen.
   */
  'peers.confirm': (params): true => {
    unlockedPerson('peers.confirm');
    const p = parameters(params, 'invalid peer');
    return required(keys, 'peers.confirm').confirm(
      text(p.personId, 'invalid person'),
      text(p.fingerprint, 'invalid fingerprint'),
    );
  },

  /**
   * RF-58: who in the guild is online now (`GET /v1/presence`). Not inside the signed snapshot, so it
   * is asked for on its own; without a host — or while this Nod is older than the guild's minimum, so
   * the guild is disconnected — there is no guild to ask and the answer is empty.
   */
  'host.presence': async (): Promise<PresenceEntry[]> => {
    unlockedPerson('host.presence');
    const connection = guildConnection();
    if (connection === null) return [];
    return await connection.presence();
  },

  // -------------------------------------------------------------- personal and favorites (B7)

  /**
   * SP05 §3 `personal.saveTool`, SP05 §2: the person's own tool. Connected, the write is one
   * `host_outbox` row for `PUT /v1/personal/tools/:id` (SP04 §4) and the local cache shows it at
   * once — `backend/connected-catalog.ts` applies the pending row over the snapshot's personal half.
   * Local, it is a `tool` row with `scope = 'personal'` and its owner. The id is never the page's: a
   * draft without one gets `p-…` (`backend/personal.ts`).
   */
  'personal.saveTool': (params): Entry => {
    unlockedPerson('personal.saveTool');
    return required(personal, 'personal.saveTool').saveTool(
      parameters(params, 'invalid personal tool').entry,
    );
  },

  /** SP05 §3 `personal.removeTool`: the person's own tool goes away (local mode takes its credential). */
  'personal.removeTool': async (params): Promise<true> => {
    unlockedPerson('personal.removeTool');
    return await required(personal, 'personal.removeTool').removeTool(
      text(parameters(params, 'invalid personal tool').id, 'invalid id'),
    );
  },

  /** SP05 §3 `personal.saveView`: a view of the person's, hung under an entry they see. */
  'personal.saveView': (params) => {
    unlockedPerson('personal.saveView');
    return required(personal, 'personal.saveView').saveView(
      parameters(params, 'invalid personal view').view,
    );
  },

  /** SP05 §3 `personal.removeView`: one of the person's own views goes away. */
  'personal.removeView': async (params): Promise<true> => {
    unlockedPerson('personal.removeView');
    return await required(personal, 'personal.removeView').removeView(
      text(parameters(params, 'invalid personal view').id, 'invalid id'),
    );
  },

  /**
   * B7/SP05 §4: the ordered favorites, from the effective catalog while connected (the snapshot's
   * list with the pending writes applied) and from the local store otherwise. The page draws the
   * toggle from this list and sends the whole list back with `favorites.set`.
   */
  'favorites.list': (): Id[] => {
    const person = unlockedPerson('favorites.list');
    const effective = connectedMode ? connected?.current() : null;
    if (effective !== null && effective !== undefined) return [...effective.favorites];
    return required(personal, 'favorites.list').localFavorites(person.id);
  },

  /** SP05 §3 `favorites.set`: replaces the ordered list whole (SP04 §4). */
  'favorites.set': async (params): Promise<true> => {
    unlockedPerson('favorites.set');
    return await required(personal, 'favorites.set').setFavorites(
      textList(parameters(params, 'invalid favorites').ids, 'invalid favorites'),
    );
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
    const admin = hostAdminFor(guildConnection());

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
    const admin = hostAdminFor(guildConnection());

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
    const admin = hostAdminFor(guildConnection());

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
    const admin = hostAdminFor(guildConnection());

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
    const admin = hostAdminFor(guildConnection());

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
    const admin = hostAdminFor(guildConnection());
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
    const admin = hostAdminFor(guildConnection());

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

  /**
   * 0.5.3 (RF-64): the guild owner renames a person or changes their email
   * (`PATCH /v1/admin/people/:id { name?, email? }`). Connected only — a local account's name and
   * email are edited by the person themselves, never from the People screen. At least one field is
   * required; `name` is trimmed non-empty, `email` trimmed, non-empty and carrying an `@` before the
   * call, so an obviously wrong body never leaves this machine. The host trims and lowercases the
   * email and answers `403 owner only` / `409 email taken` for the cases only it can decide — both
   * kept as its own refusals because the screen shows them. `ownerGate` reads the guild's people
   * first and refuses a host without an owner (`HOST_TOO_OLD_PEOPLE`) or a caller who is not the
   * owner, before the `PATCH` is sent.
   */
  'people.update': async (params) => {
    const r = required(repo, 'people.update');
    const actor = unlockedPerson('people.update');
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');
    const p = parameters(params, 'invalid person');
    const personId = text(p.personId, 'invalid person');
    const name = optional(p.name, (value) => text(value, 'invalid person').trim());
    const email = optional(p.email, (value) => text(value, 'invalid person').trim());
    if (name === undefined && email === undefined) throw new Error('invalid person');
    if (email !== undefined && !email.includes('@')) throw new Error('invalid person');
    const input: { name?: string; email?: string } = {};
    if (name !== undefined) input.name = name;
    if (email !== undefined) input.email = email;

    // RF-64: the gate reads the guild's people first — `HOST_TOO_OLD_PEOPLE` on a host without an
    // owner, `only the guild owner can do this` for anyone else — before the PATCH is sent.
    await ownerGate(admin, actor.id);
    const updated = await admin.updatePerson(personId, input);
    const fields = [name !== undefined ? 'name' : null, email !== undefined ? 'email' : null]
      .filter((field): field is string => field !== null)
      .join(', ');
    r.addEvent({
      personId: updated.id,
      toolId: null,
      type: 'person_updated',
      url: null,
      result: 'updated',
      detail: fields,
    });
    await afterHostWrite();
    return updated;
  },

  /**
   * 0.5.3 (RF-64): the guild owner removes a person from the guild
   * (`DELETE /v1/admin/people/:id`), a hard delete the host runs in one transaction. Connected
   * only. `ownerGate` reads the guild's people first and refuses a host without an owner
   * (`HOST_TOO_OLD_PEOPLE`), a caller who is not the owner and the owner as the delete's target —
   * before the `DELETE` is sent. The host is the one that refuses a non-owner (`403 owner only`),
   * the owner's own deletion (`403`) and the last-admin `409`; `people.update`'s log line names the
   * fields, this one the id.
   */
  'people.delete': async (params): Promise<true> => {
    const r = required(repo, 'people.delete');
    const actor = unlockedPerson('people.delete');
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');
    const personId = text(parameters(params, 'invalid person').personId, 'invalid person');

    await ownerGate(admin, actor.id, personId);
    await admin.deletePerson(personId);
    r.addEvent({
      personId,
      toolId: null,
      type: 'person_deleted',
      url: null,
      result: 'removed from the host',
      detail: null,
    });
    await afterHostWrite();
    return true;
  },

  'people.revoke': async (params): Promise<true> => {
    const r = required(repo, 'people.revoke');
    const store = required(vault, 'people.revoke');
    const actor = unlockedPerson('people.revoke');
    const p = parameters(params, 'invalid person');
    const personId = text(p.personId, 'invalid person');
    const deleteCredentials = booleanValue(p.deleteCredentials, 'invalid revocation');
    const admin = hostAdminFor(guildConnection());

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
    await required(runtime, 'people.revoke').secrets.delete(`nod.bio.${personId}`);

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

  /**
   * O1/SP03 §2 (`GET /v1/admin/people/:id/sessions`): the devices of one person of the guild, for
   * the admin's People screen. Connected only — a local account has no session of its own to list,
   * and the screen does not offer the card without a host.
   */
  'people.sessions': async (params): Promise<DeviceSession[]> => {
    unlockedPerson('people.sessions');
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');
    const personId = text(parameters(params, 'invalid person').personId, 'invalid person');
    return await admin.sessions(personId);
  },

  /**
   * O1/SP03 §2 (`DELETE /v1/admin/sessions/:id`): ends one session of the guild, whichever person
   * it belongs to. The device signs out at its next sync; nothing local changes here.
   */
  'people.revokeSession': async (params): Promise<true> => {
    unlockedPerson('people.revokeSession');
    const admin = hostAdminFor(guildConnection());
    if (admin === null) throw new Error('Nod is not connected to a host');
    await admin.revokeSession(text(parameters(params, 'invalid session').id, 'invalid session'));
    return true;
  },

  'invites.issue': async (params) => {
    const r = required(repo, 'invites.issue');
    const actor = unlockedPerson('invites.issue');
    const p = parameters(params, 'invalid invite');
    const roles = textList(p.roles, 'invalid roles');
    const admin = hostAdminFor(guildConnection());

    // SP05 §3/0.5.0: while connected the same question — "a code to hand over" — is the host's, but
    // only for somebody who already exists: `personId` reissues their access code
    // (`POST /v1/admin/people/:id/code`, revoking the previous one). A person who does not exist yet
    // joins through a guild invite, which carries their roles (`guildInvites.create`, RF-59) — the
    // email-bound create route is gone with 0.5.0. `days` stays local: SP02 §3 fixes 72 h on the
    // host's side.
    if (admin !== null) {
      const personId = optional(p.personId, (value) => text(value, 'invalid person'));
      if (personId === undefined) {
        throw new Error('this Nod is connected to a guild — create a guild invite instead');
      }
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
  /**
   * K7/RF-54: the vault list, with the holders and the `rotationPending` chip of each item. Both come
   * from the cached snapshot, so a Nod older than the guild's minimum — disconnected (O2, owner
   * 2026-10-17) — shows the machine's own items undecorated instead, exactly as it does with no host
   * at all.
   */
  'vault.list': () => {
    const items = required(vault, 'vault.list').list(unlockedPerson('vault.list').id);
    return disconnected() ? items : required(shares, 'vault.list').decorate(items);
  },

  'vault.save': async (params) => {
    const r = required(repo, 'vault.save');
    const person = unlockedPerson('vault.save');
    const p = parameters(params, 'invalid credential');
    const item = await required(vault, 'vault.save').save(person.id, {
      // RF-65: with an `itemId` this credential is replaced; without one a new credential is added
      // to the tool, beside the ones it already has.
      itemId: optional(p.itemId, (value) => text(value, 'invalid credential')),
      toolId: text(p.toolId, 'invalid tool'),
      username: text(p.username, 'invalid username'),
      secret: text(p.secret, 'invalid secret'),
      label: optional(p.label, (value) => text(value, 'invalid label')),
    });
    // The event names the tool and the credential's own id — never the label, which defaults to the
    // username and would reach the host (RF-65, SP06 §6; `credentialEvent`).
    r.addEvent(credentialEvent('credential_saved', person.id, item));
    return item;
  },

  /**
   * RF-65: the credential of its tool the login cascade fills with — the person's own choice among
   * the credentials they hold of it. Not gated: nothing secret is shown, and the answer is the item
   * as the vault holds it (the page refreshes the list around it).
   */
  'vault.setDefault': (params) => {
    const person = unlockedPerson('vault.setDefault');
    const itemId = text(parameters(params, 'invalid credential').itemId, 'invalid credential');
    return required(repo, 'vault.setDefault').setVaultDefault(person.id, itemId);
  },

  /**
   * K5/SP02 §9: the gate comes before the read, so a cancelled prompt returns nothing at all. The
   * credential is opened only after it, and the answer is the only secret that crosses this
   * frontier.
   */
  'vault.reveal': async (params) => {
    const person = unlockedPerson('vault.reveal');
    const p = parameters(params, 'invalid credential');
    const itemId = text(p.itemId, 'invalid credential');
    // RF-65: the id has to be one this person holds before the gate is asked — the index is not a
    // secret, and a prompt for a credential that is not there is a prompt wasted.
    if (required(repo, 'vault.reveal').vaultItemById(person.id, itemId) === null) {
      throw new Error('unknown credential');
    }
    await authenticate(GATE_REASON.reveal, optionalPassword(p.password));
    const found = await required(vault, 'vault.reveal').read(person.id, itemId);
    // The item is there and its value does not open (a lost keychain item, or a vault written
    // elsewhere): a different answer from the unknown id above.
    if (found === null) throw new Error('credential not found');
    return found;
  },

  /**
   * K5: the same gate, and the runtime's clipboard is the only destination — the secret is never
   * returned, so the page cannot keep it.
   */
  'vault.copy': async (params): Promise<true> => {
    const person = unlockedPerson('vault.copy');
    const p = parameters(params, 'invalid credential');
    const itemId = text(p.itemId, 'invalid credential');
    if (required(repo, 'vault.copy').vaultItemById(person.id, itemId) === null) {
      throw new Error('unknown credential');
    }
    await authenticate(GATE_REASON.copy, optionalPassword(p.password));
    const found = await required(vault, 'vault.copy').read(person.id, itemId);
    if (found === null) throw new Error('credential not found');
    await required(runtime, 'vault.copy').clipboard.write({ text: found.secret });
    return true;
  },

  /**
   * K6/SP06 §5: the scope of one credential, set by its owner (an item that never travelled has no
   * holder row, so its person is its owner) or by the admin of an assignment. Not gated: nothing
   * secret is shown to change it.
   */
  'vault.setScope': async (params) => {
    const p = parameters(params, 'invalid scope');
    if (p.scope !== 'role' && p.scope !== 'blocked' && p.scope !== 'org') {
      throw new Error('invalid scope');
    }
    return await required(shares, 'vault.setScope').setScope(
      text(p.itemId, 'invalid credential'),
      p.scope,
    );
  },

  'vault.remove': async (params): Promise<true> => {
    const r = required(repo, 'vault.remove');
    const person = unlockedPerson('vault.remove');
    const itemId = text(parameters(params, 'invalid credential').itemId, 'invalid credential');
    // Read before the removal for the event: the tool the credential belonged to and its own id —
    // never its label, which defaults to the username and would reach the host with the event
    // (RF-65, SP06 §6). The removal refuses an id this person does not hold, so the row that was
    // there is the one recorded.
    const item = r.vaultItemById(person.id, itemId);
    await required(vault, 'vault.remove').remove(person.id, itemId);
    if (item !== null) r.addEvent(credentialEvent('credential_removed', person.id, item));
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

  // -------------------------------------------------------------- shares (K4–K7, SP06 §4–§5)

  /**
   * K4/SP06 §5: the people the credential's scope could reach, with their key state. The roster and
   * the pinned keys that answer it come from the cached snapshot, so a disconnected Nod (O2, owner
   * 2026-10-17) has nobody to offer — the same answer a Nod with no host gives.
   */
  'shares.recipients': (params) => {
    if (disconnected()) return [];
    const itemId = text(parameters(params, 'invalid credential').itemId, 'invalid credential');
    return required(shares, 'shares.recipients').recipients(itemId);
  },

  /** K4/SP06 §4: one sealed copy per recipient. Gated in `backend/shares.ts`. */
  'shares.send': async (params) => {
    const p = parameters(params, 'invalid share');
    const itemId = text(p.itemId, 'invalid credential');
    if (!Array.isArray(p.to)) throw new Error('invalid recipients');
    const to = p.to.map((value) => text(value, 'invalid recipient'));
    return await required(shares, 'shares.send').send(itemId, to, optionalPassword(p.password));
  },

  /**
   * K4: the snapshot's open shares addressed to me — metadata only, never the sealed copy. The inbox
   * is the cached snapshot's, so a disconnected Nod (O2, owner 2026-10-17) shows none: the shares are
   * still in the body on disk and appear the moment the guild takes this Nod back.
   */
  'shares.inbox': () => (disconnected() ? [] : required(shares, 'shares.inbox').inbox()),

  /**
   * K4/SP06 §4: opens the share, lands it in the vault bound to the tool's origin and accepts it on
   * the host. Gated, except an `update` of a credential already held: nothing is shown there.
   */
  'shares.accept': async (params) => {
    const p = parameters(params, 'invalid share');
    const id = text(p.id, 'invalid share');
    return await required(shares, 'shares.accept').accept(id, optionalPassword(p.password));
  },

  /** K4: declines one share; the host purges the ciphertext. Nothing secret is involved. */
  'shares.decline': async (params): Promise<true> =>
    await required(shares, 'shares.decline').decline(
      text(parameters(params, 'invalid share').id, 'invalid share'),
    ),

  /**
   * K9/SP06 §4: the owner (or an admin) revokes one holder; the host sets `removed_at` and the next
   * snapshot marks the credential `rotationPending`. Not gated: nothing secret is shown or sent.
   */
  'shares.removeHolder': async (params) => {
    const p = parameters(params, 'invalid holder');
    return await required(shares, 'shares.removeHolder').removeHolder(
      text(p.itemId, 'invalid credential'),
      text(p.personId, 'invalid recipient'),
    );
  },

  /**
   * K8/SP06 §4, RF-47 (admin): assign a credential to a role (`roleId`) or to a person (`personId`)
   * and seal the copies of the members still missing one in the same gated step (`backend/shares.ts`
   * runs the second half after the first). `assigned: false` takes the role's assignment away.
   */
  'assignments.set': async (params): Promise<{ sent: number; skipped: number }> => {
    const p = parameters(params, 'invalid assignment');
    const itemId = text(p.itemId, 'invalid credential');
    const roleId = p.roleId === undefined ? null : text(p.roleId, 'invalid role');
    const personId = p.personId === undefined ? null : text(p.personId, 'invalid person');
    const assigned = booleanValue(p.assigned, 'invalid assignment');
    return await required(shares, 'assignments.set').assign(
      { itemId, roleId, personId, assigned },
      optionalPassword(p.password),
    );
  },

  /**
   * K8/RF-47 (admin): the members of the assigned roles still without a copy, as of the last sync.
   * The list is the host's answer, so a disconnected Nod (O2, owner 2026-10-17) has none to show —
   * the read itself does not run while the guild is disconnected.
   */
  'assignments.missing': () => (disconnected() ? [] : required(shares, 'assignments.missing').missing()),

  /**
   * K8/SP06 §4 (admin): seals a copy to every member of the list this Nod can reach, with the one
   * gate the send uses. A member whose pinned key changed or is unknown is skipped and counted.
   */
  'assignments.sealMissing': async (params) => {
    const p = parameters(params, 'invalid request');
    return await required(shares, 'assignments.sealMissing').sealMissing(
      optionalPassword(p.password),
    );
  },

  /**
   * M7/SP06 §4, RF-54 (admin): the holders of every credential of the guild — including the ones
   * this Nod does not hold. The rows come from the verified snapshot, the names from its roster and
   * the titles from the effective catalog (`credentialHolders`, `backend/holders.ts`).
   */
  'holders.list': () => credentialHolders(),

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
    const admin = hostAdminFor(guildConnection());
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

  // -------------------------------------------------------------- nod
  'nod.info': async (): Promise<AppInfo> => {
    const r = required(repo, 'nod.info');
    const info = await required(runtime, 'nod.info').info();
    return {
      version: info.version,
      seedVersion: storedSeedVersion(r),
      os: system,
      gateOrigins: gateOrigins(bundledSeed),
      tray,
      // SP02 §9/`docs/canonico.md` §22: what the page needs to decide between the operating
      // system's prompt and its own password field — the machine capability (not the per-person
      // shortcut of `session.biometric`) and whether this is a non-release dev run, the only case
      // where a typed password is a factor on a machine that also has `authenticate`.
      biometricAvailable: biometrics,
      devRun,
    };
  },

  'nod.checkUpdate': async () => withHotfixes(await required(runtime, 'nod.checkUpdate').update.check()),

  'nod.installUpdate': async (): Promise<boolean> => {
    const r = required(repo, 'nod.installUpdate');
    const person = unlockedPerson('nod.installUpdate');
    // A13: the install restarts the app, so the event goes in before it starts.
    r.addEvent({
      personId: person.id,
      toolId: null,
      type: 'update',
      url: null,
      result: 'requested',
      detail: null,
    });
    return required(runtime, 'nod.installUpdate').update.install();
  },

  /**
   * SP05 §6: the app icon of this machine and whether a guild icon is available to show. Read by
   * Settings → Account (the choice) and by the admin's card in Settings → Hosts.
   */
  'nod.appIcon': async (): Promise<AppIconState> => await required(guildIcon, 'nod.appIcon').state(),

  /**
   * SP05 §6: stores the choice and applies it — `guild` needs a verified guild icon on disk, and
   * `default` puts the bundle icon back. A machine whose system has no app icon (Linux on Wayland)
   * says so through `capabilities()`; the choice is kept all the same, for a session that has one.
   */
  'nod.setAppIcon': async (params): Promise<AppIconState> => {
    const choice = appIconChoice(parameters(params, 'invalid app icon choice').choice);
    return await required(guildIcon, 'nod.setAppIcon').setChoice(choice);
  },

  /** RF-55: hides the notice of one version on this machine; `store` keeps the version string. */
  'nod.dismissUpdate': async (params): Promise<true> => {
    const app = required(runtime, 'nod.dismissUpdate');
    const version = text(parameters(params, 'invalid dismissal').version, 'invalid version');
    // `store.set` answers false when it could not write: better to say so than to hide a notice
    // that comes back on the next launch.
    if (!(await app.store.set(DISMISSED_UPDATE_KEY, version))) {
      throw new Error('Nod could not save the dismissal');
    }
    if (updateNotice !== null && updateNotice.latest === version) {
      updateNotice = null;
      push('update', null);
    }
    return true;
  },

  'nod.quit': () => {
    required(runtime, 'nod.quit').quit();
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
 * SP04 §1.3: a `nod://join?host=…&fp=…[&code=…]` link (tinyjs' `"urlScheme"`, the second launch
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
