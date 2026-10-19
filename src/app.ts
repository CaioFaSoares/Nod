// The Nod main window: boot, the entry screen, the sidebar, Home and Settings routing
// (docs/arquitetura.md §5, canonico §7).
// The page talks to the backend only through `./api`, and only with methods of `ApiContract`.
// No password or invite code ever leaves this module except as the parameter of `call(...)`:
// nothing is written to storage, the console, the page title or an error message.
// 0.5.0 (RF-60): the locked screen is the rail of tiles in `./entry`; the join flow it and
// Settings → Hosts share is `./join`.
import { call, errorMessage, on } from './api';
import { mountEntry, resetEntry, showEntryInvite } from './entry';
import { openPalette } from './palette';
import { mountSettings } from './settings';
import { runGate } from './vault-gate';
import { activeTab, createEmbedLayer, mountTabs, reportSlot, tabsApi } from './tabs';
import type { EmbedLayer, TabsApi, TabsHandle } from './tabs';
import { button, clear, el, field, glyph, initials, input, message } from './ui';
import type { SettingsTab } from './settings';
import type {
  AppInfo,
  EmbedCheck,
  Entry,
  EntryProfiles,
  HostState,
  Id,
  JoinInvite,
  LoginResult,
  SaveTabResult,
  SessionState,
  TabState,
  ToolStatus,
  ToolsState,
  UpdateInfo,
  VaultItem,
} from '../shared/types';
import { GATE_PASSWORD_REQUIRED, GATE_PROMPT_FAILED } from '../shared/types';
import { categoryOf, groupByCategory } from '../shared/catalog';
import type { PresenceEntry } from '../shared/host-api';

/**
 * What the right side of the window shows: Home, the tab view of docked mode (RF-49) or one
 * Settings tab.
 */
type View = 'home' | 'tab' | SettingsTab;

/** English text of each cascade result (canonico §8, §11). */
const LOGIN_TEXT: Record<LoginResult, string> = {
  session: 'Signed in with session',
  filled: 'Signed in by Nod',
  provider: 'Signed in via provider',
  manual: 'Sign in manually',
  failed: 'Sign-in failed',
};

interface Shell {
  sidebar: HTMLElement;
  /** RF-55: the slot of the update notice, above the banner. */
  notice: HTMLElement;
  banner: HTMLElement;
  content: HTMLElement;
}

/** What `mountSettings` returns (docs/arquitetura.md §5): the Settings view is mounted, then kept. */
interface SettingsHandle {
  setTab(tab: SettingsTab): void;
  update(session: SessionState): void;
  destroy(): void;
}

/** The page's only container: `index.html` provides `#app` (docs/arquitetura.md §5). */
function requireRoot(): HTMLElement {
  const element = document.getElementById('app');
  if (element === null) throw new Error('index.html must provide #app');
  return element;
}

/** Every render below writes inside this element; resolved once, before the boot. */
const root: HTMLElement = requireRoot();

/** Last known session: the answer of `session.state` or the push `session`. */
let session: SessionState | null = null;
/** Answer of `nod.info`; Settings needs it. */
let info: AppInfo | null = null;
/** Answer of `tools.state` or the push `tools`. */
let tools: ToolStatus[] = [];
/**
 * E03: the whole answer of `tools.state`/`tools`/`tabs.*` — the tabs in strip order, the active
 * one, the mode and whether the backend owns the tab shortcuts (RF-49…RF-52). `null` before the
 * first answer and after a lock.
 */
let tabsState: ToolsState | null = null;
/** Answer of `catalog.list` or a refresh triggered by the push `catalog`. */
let catalog: Entry[] = [];
/**
 * B7/SP05 §4: the person's ordered favorites, from `favorites.list`. The sidebar's order comes from
 * the backend already; this list is what draws the toggle's state.
 */
let favorites: Id[] = [];
/** Push `update` (RF-55): the newer release to announce, or `null` when there is none. */
let update: UpdateInfo | null = null;
/** SP05 §3: the one host, from `host.state` or the push `host`. */
let host: HostState | null = null;
/**
 * RF-58: the guild's members with a live session, from `host.presence`. Refreshed when a sync
 * publishes the host state and when Home opens — the sync's own cadence, so no page timer.
 */
let presence: PresenceEntry[] = [];
/**
 * 0.5.0 (RF-60): the tiles of the entry screen, from `session.profiles`. Read while locked (the
 * entry screen draws nothing before it) and again after a lock or a join; the sidebar's top mark
 * takes the guild's icon from here too.
 */
let profiles: EntryProfiles | null = null;
/** SP04 §1.3: the invite a `nod://join` link carried, until the join flow spends it. */
let joinInvite: JoinInvite | null = null;
let view: View = 'home';
let shell: Shell | null = null;
let settings: SettingsHandle | null = null;
let settingsTab: SettingsTab | null = null;
/** E03: the tab view of the center panel, mounted while docked mode shows it (`src/tabs.ts`). */
let tabView: TabsHandle | null = null;
/**
 * RF-69: the iframe layer of the embedded tabs. It is mounted on the panel's content box once and
 * lives with the shell, not with the tab view, so Home and Settings visits never reload an
 * embedded tool (RF-50); `destroyTabView` hides it instead of detaching its iframes.
 */
let embeds: EmbedLayer | null = null;
/**
 * 0.6.0b (RF-69): the person's vault metadata, read lazily for the embedded tab's Sign in control.
 * Settings reads it when its Vault tab opens; there is no vault push, so this cache is refreshed
 * when an embedded tab lands on the panel (and after a conversion). It holds usernames and labels,
 * never a secret — the password only ever travels inside the gated `vault.copy`.
 */
let vaultItems: VaultItem[] | null = null;
/** The `vault.list` call in flight, so a redraw does not repeat it. */
let vaultPending: Promise<void> | null = null;
/** Bumped on every session change: a read that lands after a lock cannot feed the next session. */
let vaultEpoch = 0;
/** 0.6.0b: a system prompt failed in this unlocked session, so the gate asks for the password. */
let gateFallback = false;

// ------------------------------------------------------------------ helpers

/** Entry icon: the tool window state carries a data URI; a seed path is not readable by the page. */
function entryIcon(entry: Entry, tool: ToolStatus | null): string | null {
  if (tool !== null && tool.icon !== null && tool.icon !== '') return tool.icon;
  if (entry.icon !== null && entry.icon.startsWith('data:')) return entry.icon;
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function stateText(tool: ToolStatus | null): string {
  if (tool === null) return 'Not open';
  if (tool.loading) return 'Loading…';
  if (tool.error !== null) return `Failed: ${tool.error}`;
  return tool.openWindows > 0 ? 'Open' : 'Not open';
}

// -------------------------------------------------------------- entry screen

/**
 * 0.5.0 (RF-60): the locked screen is the entry rail in `./entry` — the Offline tile, the guild
 * tile and the `+` tile, with the pane of the selected one beside it. This module owns the session
 * it enters by, so the screen hands every answer back here.
 */
function renderLocked(): void {
  if (session === null) return;
  mountEntry(
    root,
    { state: session, profiles, invite: joinInvite },
    {
      info,
      onSession: (next) => {
        session = next;
        if (next.unlocked) {
          void startUnlocked();
          return;
        }
        render();
      },
      onProfiles: (next) => {
        profiles = next;
        render();
      },
    },
  );
}

/**
 * The tiles of the entry screen (`session.profiles`), which work locked. Read after a boot, after a
 * lock and after a join; the sidebar's top mark takes the guild's icon from the same answer.
 */
async function loadProfiles(): Promise<void> {
  try {
    profiles = await call('session.profiles');
  } catch {
    // Without the tiles the entry screen says so and the sidebar keeps its own mark; the next
    // render (a push, a lock) reads them again.
    return;
  }
  render();
}

// ------------------------------------------------------------ unlocked shell

function buildShell(): void {
  const sidebar = el('aside', { class: 'sidebar', aria: { label: 'Nod' } });
  const notice = el('div', { class: 'notice-slot' });
  const banner = el('div', { class: 'banner' });
  const content = el('div', { class: 'content' });
  shell = { sidebar, notice, banner, content };
  // RF-69: the iframe layer of the embedded tabs lives with the shell, beside the screens the
  // content box shows — Home, Settings and the tab view come and go; the iframes do not.
  ensureEmbeds();
  root.replaceChildren(
    el('div', { class: 'shell' }, sidebar, el('div', { class: 'main' }, notice, banner, content)),
  );
}

function teardownShell(): void {
  destroySettings();
  // E03: the tab view goes with the panel (a lock), reporting the empty slot on its way out.
  destroyTabView();
  // RF-69: a locked window has no tabs, so the iframes go with the shell too.
  if (embeds !== null) {
    embeds.destroy();
    embeds = null;
  }
  // B7: the dialog is an overlay of the main window, so it goes with the shell (a lock). E03: the
  // "Open link…" dialog is the same kind of overlay and goes with it too.
  document.getElementById(PERSONAL_DIALOG_ID)?.remove();
  document.getElementById(OPEN_LINK_DIALOG_ID)?.remove();
  shell = null;
}

function renderSidebar(): void {
  if (shell === null || session === null) return;
  const list = el('nav', { class: 'sidebar-tools', aria: { label: 'Tools' } });
  for (const node of sidebarRows()) list.append(node);
  const footer = el(
    'div',
    { class: 'sidebar-footer' },
    // 0.5.0: the same separator the entry screen's rail draws between its tiles.
    el('span', { class: 'rail-separator', aria: { hidden: 'true' } }),
    // SP05 §4: `stale` is the last sync having failed — the cached guild still shows, and the
    // sidebar says so instead of pretending everything is current.
    host !== null && host.status === 'stale'
      ? el(
          'span',
          {
            class: 'badge badge-offline',
            title: `Offline — Nod is showing the cached guild${host.lastError === null ? '' : ` (${host.lastError})`}`,
          },
          'offline',
        )
      : null,
    sidebarAction('⚙', 'Settings', () => {
      go('account');
    }, inboxCount),
    sidebarAction('⏻', 'Lock', () => {
      void lockSession();
    }),
  );
  // 0.5.0 (RF-60): the top mark says where this session is — the guild's icon (or its initials)
  // while the guild is the one being synced, the Offline glyph of the tile that was entered.
  const guild = profiles !== null && profiles.guilds.length > 0 ? profiles.guilds[0] : null;
  const where = session.mode === 'offline' || guild === null ? 'Offline' : guild.guild;
  const mark = el(
    'button',
    {
      class: 'mark',
      // The name the entry screen's tile carries, as a server name on hover.
      title: `${where} — Home`,
      aria: { label: 'Home' },
      attrs: { type: 'button' },
    },
    session.mode === 'offline' || guild === null
      ? '⌂'
      : guild.icon !== null
        ? el('img', { class: 'mark-img', attrs: { src: guild.icon, alt: '' } })
        : el('span', { class: 'chip' }, initials(guild.guild)),
  );
  mark.addEventListener('click', () => {
    go('home');
  });
  const tabs = sidebarTabs();
  shell.sidebar.replaceChildren(
    mark,
    ...(tabs === null ? [] : [tabs]),
    el('span', { class: 'rail-separator', aria: { hidden: 'true' } }),
    list,
    footer,
  );
}

/**
 * E03 (RF-49): the way back to the strip of docked mode from anywhere else — Home, one Settings
 * tab. The button sits under the mark, in the mark's own size and style, and only docked mode has a
 * tab view at all (RF-52). It is disabled, not hidden, while the strip is empty: the rail keeps its
 * shape and the tooltip says why. The click is the path a sidebar tool click takes once its answer
 * lands — `openTabView` — with no backend call of its own.
 */
function sidebarTabs(): HTMLButtonElement | null {
  const state = tabsState;
  if (state === null || state.mode !== 'docked') return null;
  const count = state.tabs.length;
  const current = view === 'tab';
  const label = count === 0 ? 'No open tabs' : 'Open tabs';
  const node = el(
    'button',
    {
      class: current ? 'mark mark-tabs current' : 'mark mark-tabs',
      title: label,
      aria: current ? { label, current: 'true' } : { label },
      attrs: { type: 'button' },
    },
    el('span', { class: 'mark-tabs-glyph', aria: { hidden: 'true' } }, '▤'),
    count === 0
      ? null
      : el('span', { class: 'badge sidebar-action-badge tabs-badge', aria: { hidden: 'true' } }, String(count)),
  );
  node.disabled = count === 0;
  node.addEventListener('click', () => {
    openTabView();
  });
  return node;
}

/**
 * RF-62: the sidebar's rows, in the visual order the digits follow — the favorites as one block,
 * then a divider per category group, then the personal tools, which are their own group. `tools`
 * arrives grouped (`backend/tool-windows.ts` over `shared/host-merge.ts`'s `sidebarOrder`), so a
 * category is a run of the same name; the favorites are never split.
 */
function sidebarRows(): HTMLElement[] {
  const entryOf = new Map<Id, Entry>();
  for (const entry of catalog) entryOf.set(entry.id, entry);
  /** RF-62: the name a tool is filed under, `null` for a tool the catalog does not resolve. */
  const categoryName = (id: Id): string | null => {
    const entry = entryOf.get(id);
    return entry === undefined ? null : categoryOf(entry);
  };
  const favorite = new Set(favorites);
  const rows: HTMLElement[] = [];
  let index = 0;
  while (index < tools.length && favorite.has(tools[index].id)) {
    rows.push(sidebarTool(tools[index]));
    index += 1;
  }
  const rest = tools.slice(index);
  const org = rest.filter((tool) => entryOf.get(tool.id)?.scope !== 'personal');
  const personal = rest.filter((tool) => entryOf.get(tool.id)?.scope === 'personal');
  // A bare divider marks the uncategorized group, and only while there is a named group to part it
  // from: a guild that files nothing keeps the plain column of icons.
  const named = org.some((tool) => categoryName(tool.id) !== null);
  let current: string | null | undefined;
  for (const tool of org) {
    const category = categoryName(tool.id);
    if (category !== current) {
      if (category !== null || named) rows.push(sidebarDivider(category));
      current = category;
    }
    rows.push(sidebarTool(tool));
  }
  for (const tool of personal) rows.push(sidebarTool(tool));
  return rows;
}

/**
 * RF-62: the thin rule that opens a category group in the sidebar, with the category name in small
 * caps. The `title` carries the whole name — the column is narrow and the label may be truncated.
 */
function sidebarDivider(category: string | null): HTMLElement {
  const label =
    category === null
      ? null
      : el('span', { class: 'sidebar-divider-label', title: category, aria: { hidden: 'true' } }, category);
  return el('div', { class: 'sidebar-divider', aria: { hidden: 'true' } }, label, el('span', { class: 'sidebar-divider-rule' }));
}

function sidebarTool(tool: ToolStatus): HTMLButtonElement {
  const classes = ['tool-icon'];
  if (tool.openWindows > 0) classes.push('open');
  if (tool.loading) classes.push('loading');
  if (tool.error !== null) classes.push('error');
  // B7/canonico §22: the sidebar's half of the warning the tool window carries.
  const foreign = catalog.find((entry) => entry.id === tool.id)?.scope === 'personal';
  if (foreign) classes.push('personal');
  if (favorites.includes(tool.id)) classes.push('favorite');
  // E03 (RF-49): the tool whose tab is on the center panel — the strip's active tab, on the rail.
  const onPanel = tabOnPanel();
  const current = onPanel !== null && onPanel.toolId === tool.id;
  if (current) classes.push('current');

  const login = tool.login === null ? null : LOGIN_TEXT[tool.login];
  const tip = login === null ? tool.title : `${tool.title} — ${login}`;
  // The tool of the tab on the panel says so: the rail's ring is not there for a reader that does
  // not see it.
  const panel = current ? ' — on the panel' : '';
  const base = `${foreign ? `Not from your org — ${tip}` : tip}${panel}`;
  const label = tool.error === null ? base : `${tool.title} — failed: ${tool.error}${panel}`;
  const node = el(
    'button',
    {
      class: classes.join(' '),
      title: base,
      aria: { label, pressed: tool.openWindows > 0 ? 'true' : 'false' },
      data: { tool: tool.id },
      attrs: { type: 'button' },
    },
    glyph(tool.title, tool.icon),
    tool.digit === null ? null : el('span', { class: 'digit' }, String(tool.digit)),
  );
  node.addEventListener('click', () => {
    void openTool(tool.id);
  });
  return node;
}

/**
 * One action of the sidebar's footer. `badge` is the count K4 puts beside Settings: the shares
 * waiting in the vault inbox, which the label spells out for a reader that does not see it.
 */
function sidebarAction(
  mark: string,
  label: string,
  onClick: () => void,
  badge = 0,
): HTMLButtonElement {
  const title =
    badge > 0 ? `${label} — ${badge} ${badge === 1 ? 'share' : 'shares'} waiting` : label;
  const node = el(
    'button',
    { class: 'sidebar-action', title, aria: { label: title }, attrs: { type: 'button' } },
    el('span', { class: 'glyph', aria: { hidden: 'true' } }, mark),
    el('span', { class: 'sidebar-action-label' }, label),
    badge > 0
      ? el('span', { class: 'badge sidebar-action-badge', aria: { hidden: 'true' } }, String(badge))
      : null,
  );
  node.addEventListener('click', onClick);
  return node;
}

function destroySettings(): void {
  if (settings !== null) {
    settings.destroy();
    settings = null;
  }
  settingsTab = null;
}

/**
 * E03 (RF-49/RF-69): the children of the center panel, with the iframe layer of the embedded tabs
 * left where it is. A `replaceChildren` would take the iframes out of the document — and the
 * embedded tools would reload when the person came back (RF-50) — so every screen replaces only
 * what it drew around that one element.
 */
function fillContent(content: HTMLElement, ...nodes: Array<Node | null>): void {
  const keep = embeds === null ? null : embeds.element;
  for (const child of Array.from(content.children)) {
    if (child !== keep) child.remove();
  }
  for (const node of nodes) {
    if (node !== null) content.append(node);
  }
}

/** RF-69: the iframe layer of the shell, created (and mounted) the first time it is needed. */
function ensureEmbeds(): EmbedLayer {
  if (embeds !== null) return embeds;
  const layer = createEmbedLayer();
  embeds = layer;
  shell?.content.append(layer.element);
  return layer;
}

/**
 * The center panel draws the face `view` asks for: Home, the tab view of docked mode (E03/RF-49) or
 * one Settings tab. The Settings screen is mounted once and updated in place afterwards.
 */
function renderContent(): void {
  if (shell === null || session === null || info === null) return;
  if (view === 'tab') {
    destroySettings();
    renderTabView();
    return;
  }
  if (view === 'home') {
    destroySettings();
    // E03: `renderHome` takes the tab view with it, whoever asked for Home (RF-49).
    renderHome(shell.content);
    return;
  }
  if (settings !== null && settingsTab === view) {
    settings.update(session);
    return;
  }
  destroySettings();
  // E03 (RF-49): Settings takes the panel, so the tab view goes with its slot and its observers.
  destroyTabView();
  const container = el('div', { class: 'settings-view' });
  fillContent(shell.content, container);
  settingsTab = view;
  settings = mountSettings(container, { session, info, tab: view, host, join: joinInvite });
}

/**
 * E03 (RF-49/RF-50): the center panel in docked mode — the strip, the toolbar and the slot the
 * backend lays the active tab on. It is mounted once and updated in place: a `tools` push redraws
 * the strip without tearing the slot down, so the docked window is not re-placed for every change
 * of state.
 */
function renderTabView(): void {
  const state = tabsState;
  if (shell === null || state === null) return;
  const active = activeTab(state);
  // 0.6.0b (RF-69): the Sign in control of an embedded tab needs the vault metadata. There is no
  // vault push, so it is read when the view mounts — which is also how a change made in Settings →
  // Vault is picked up — and while it is still unknown when an embedded tab becomes active in place.
  if (active !== null && active.embedded && active.toolId !== null) {
    if (tabView === null || vaultItems === null) void readVault();
  }
  if (tabView !== null) {
    tabView.update(state);
    return;
  }
  const container = el('div', { class: 'tab-view' });
  fillContent(shell.content, container);
  tabView = mountTabs(container, {
    state,
    actions: tabActions,
    // RF-66: the dialog of `openLinkDialog`, beside the personal-tool one.
    openLink: () => openLinkDialog(),
    // RF-69: the iframes of the embedded tabs, mounted by the shell and kept across views.
    embeds: ensureEmbeds(),
    // 0.6.0b: the credential of an embedded tool, for the Sign in control (metadata only).
    credential: defaultCredential,
  });
}

/** E03: the panel left the tab view — the observers stop and the backend is told there is no slot. */
function destroyTabView(): void {
  if (tabView === null) return;
  tabView.destroy();
  tabView = null;
}

/** canonico §22, B7: a tool the org did not add — a personal tool, or an entry marked personal. */
function isForeign(entry: Entry): boolean {
  return entry.scope === 'personal';
}

function renderHome(content: HTMLElement): void {
  if (session === null) return;
  // E03 (RF-49): Home is not the tab view, and this is where Home is drawn from every path —
  // `renderContent`, `refreshChrome` (which draws Home directly so a mounted Settings screen is
  // left alone) and `loadPresence`. A tab view left mounted would keep its observers on a slot no
  // longer in the document and would go on reporting a rect the backend places a window on, over
  // Home. `destroyTabView` is idempotent, so the second call of a path costs nothing.
  destroyTabView();
  const body = el('div', { class: 'home' });
  if (catalog.length === 0) {
    body.append(
      el(
        'div',
        { class: 'empty' },
        el('p', {}, 'No tools yet.'),
        session.person !== null && session.person.admin
          ? el('p', { class: 'muted' }, 'Add a tool in Settings → Tools')
          : null,
      ),
    );
  } else {
    appendCatalog(body);
  }
  fillContent(
    content,
    el(
      'header',
      { class: 'content-header' },
      el('h1', { class: 'content-title' }, 'Tools'),
      // B7: anyone may add a personal tool; the dialog asks for a title and an address.
      button('Add personal tool', () => openPersonalToolDialog(), {
        kind: 'ghost',
        title: 'Add a tool only you see',
      }),
    ),
    body,
    ...[presenceCard()].filter((card) => card !== null),
  );
}

/**
 * RF-62: Home's cards in the sidebar's order — the favorites as one block, one section per category,
 * "Other tools" for the org tools the guild filed nowhere, then the personal tools. A guild that
 * files nothing keeps the single grid this screen always had.
 */
function appendCatalog(body: HTMLElement): void {
  const favorite = new Set(favorites);
  const org = catalog.filter((entry) => !isForeign(entry));
  if (!org.some((entry) => categoryOf(entry) !== null)) {
    body.append(toolGrid(catalog));
    return;
  }
  const starred = catalog.filter((entry) => favorite.has(entry.id));
  if (starred.length > 0) body.append(toolGrid(starred));
  const rest = catalog.filter((entry) => !favorite.has(entry.id));
  // `groupByCategory` puts the uncategorized group last, which is where "Other tools" reads.
  for (const group of groupByCategory(rest.filter((entry) => !isForeign(entry)))) {
    body.append(toolSection(group.category ?? 'Other tools', group.entries));
  }
  const personal = rest.filter((entry) => isForeign(entry));
  if (personal.length > 0) body.append(toolGrid(personal));
}

/** One grid of cards, the shape both Home's blocks and its sections use. */
function toolGrid(entries: Entry[]): HTMLElement {
  const grid = el('div', { class: 'grid' });
  for (const entry of entries) grid.append(toolCard(entry));
  return grid;
}

/** RF-62: one category of Home — the name the guild gave it, and the tools it files. */
function toolSection(title: string, entries: Entry[]): HTMLElement {
  return el(
    'section',
    { class: 'home-section', aria: { label: title } },
    el('h2', { class: 'home-section-title' }, title),
    toolGrid(entries),
  );
}

/** RF-58: how long ago, in words a person reads at a glance. */
function seenAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * RF-58: the guild has a host this Nod reaches (or reached); local mode has no guild to show.
 * 0.5.0 (RF-60): a session entered through the Offline tile is that same disconnect — the guild is
 * there, and nothing of it is read or written this session.
 */
function guildConnected(): boolean {
  return host !== null && host.offlineSession !== true && (host.status === 'connected' || host.status === 'stale');
}

/**
 * RF-58: "Online now" — the members whose Nod synced in the last minutes, then the ones seen
 * earlier. Only with a host; names and an instant, nothing about the device.
 */
function presenceCard(): HTMLElement | null {
  if (!guildConnected()) return null;
  const online = presence.filter((entry) => entry.online);
  const recent = presence.filter((entry) => !entry.online).slice(0, 20);
  const list = el('ul', { class: 'presence-list', aria: { label: 'Online now' } });
  for (const entry of online) {
    list.append(el('li', { class: 'presence-item' }, el('span', { class: 'presence-dot', aria: { hidden: 'true' } }), entry.name));
  }
  if (online.length === 0) list.append(el('li', { class: 'muted' }, 'Nobody online right now.'));
  const card = el(
    'section',
    { id: 'presence-card', class: 'card presence-card', attrs: { tabindex: '-1' }, aria: { label: 'Online now' } },
    el('h2', { class: 'presence-title' }, 'Online now'),
    list,
  );
  if (recent.length > 0) {
    const earlier = el('ul', { class: 'presence-list presence-recent', aria: { label: 'Recently' } });
    for (const entry of recent) {
      earlier.append(el('li', { class: 'presence-item muted' }, `${entry.name} · last seen ${seenAgo(entry.lastSeenAt)}`));
    }
    card.append(el('h3', { class: 'presence-subtitle muted' }, 'Recently'), earlier);
  }
  if (host !== null && host.status === 'stale') {
    card.append(el('p', { class: 'muted' }, 'Offline: this list is from the last sync.'));
  }
  return card;
}

/** RF-58: asks the host who is online; a failure (offline) keeps the last list on screen. */
async function loadPresence(): Promise<void> {
  if (!guildConnected()) {
    presence = [];
  } else {
    try {
      presence = await call('host.presence');
    } catch {
      return;
    }
  }
  if (shell !== null && view === 'home') renderHome(shell.content);
}

/**
 * K4: how many shares are waiting in the vault inbox — the number the Settings action carries.
 * Without a guild there is no inbox to read, so it is zero.
 */
let inboxCount = 0;

/** K4: asks the host for the shares addressed to this Nod; a failure (offline) keeps the last count. */
async function loadInboxCount(): Promise<void> {
  let next = 0;
  // A locked window has no inbox to read: the route is the unlocked person's.
  if (guildConnected() && session !== null && session.unlocked) {
    try {
      next = (await call('shares.inbox')).length;
    } catch {
      return;
    }
  }
  if (next === inboxCount) return;
  inboxCount = next;
  if (shell !== null) renderSidebar();
}

/** B7: the star of SP05 §4 — one entry in or out of the ordered favorites, sent whole. */
function favoriteToggle(entry: Entry): HTMLButtonElement {
  const on = favorites.includes(entry.id);
  const node = el(
    'button',
    {
      class: on ? 'favorite favorite-on' : 'favorite',
      title: on ? `Remove ${entry.title} from favorites` : `Add ${entry.title} to favorites`,
      aria: { label: on ? `Remove ${entry.title} from favorites` : `Add ${entry.title} to favorites`, pressed: on ? 'true' : 'false' },
      attrs: { type: 'button' },
    },
    on ? '★' : '☆',
  );
  node.addEventListener('click', () => void toggleFavorite(entry.id));
  return node;
}

/** B7/SP05 §3: the whole ordered list goes back, with the entry added at the end or taken out. */
async function toggleFavorite(id: Id): Promise<void> {
  const next = favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id];
  clearBanner();
  try {
    await call('favorites.set', { ids: next });
  } catch (e) {
    showBanner(e);
    return;
  }
  favorites = next;
  refreshChrome();
}

/** B7/SP05 §3: a personal tool goes away, and with it the local credential of its tool (A6). */
async function removePersonalTool(id: Id): Promise<void> {
  clearBanner();
  try {
    await call('personal.removeTool', { id });
  } catch (e) {
    showBanner(e);
    return;
  }
  favorites = favorites.filter((item) => item !== id);
  await loadCatalog();
}

/** The dialog of `personal.saveTool`: it exists once, and Escape or a click outside closes it. */
const PERSONAL_DIALOG_ID = 'personal-tool-dialog';

/**
 * B7/SP05 §3: "Add personal tool" — a title and an address. The dialog is the palette's sibling: an
 * overlay inside the main window, keyboard first, and it talks to the backend only through `call`.
 * The id, the owner and the write time are the backend's (`backend/personal.ts`); this side sends the
 * two fields a person can type.
 */
function openPersonalToolDialog(): void {
  if (session === null || !session.unlocked || shell === null) return;
  if (document.getElementById(PERSONAL_DIALOG_ID) !== null) return;

  const title = input('title', { placeholder: 'Team notes', required: true });
  const url = input('url', { type: 'url', placeholder: 'https://notes.example.com', required: true });
  const errorBox = el('div', { class: 'palette-message' });
  const overlay = el('div', { id: PERSONAL_DIALOG_ID, class: 'overlay' });

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };

  const submit = button(
    'Add',
    async () => {
      clear(errorBox);
      let saved: Entry;
      try {
        saved = await call('personal.saveTool', {
          entry: { title: title.value.trim(), url: url.value.trim() },
        });
      } catch (e) {
        message(errorBox, 'error', errorMessage(e));
        return;
      }
      close();
      // The backend pushes the catalog; this side shows the new card at once either way.
      if (!catalog.some((entry) => entry.id === saved.id)) catalog = [...catalog, saved];
      refreshChrome();
    },
    { kind: 'primary' },
  );

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  const card = el(
    'div',
    { class: 'palette', role: 'dialog', aria: { modal: 'true', label: 'Add personal tool' } },
    el('h2', { class: 'dialog-title' }, 'Add personal tool'),
    el(
      'p',
      { class: 'muted' },
      'Only you see it, on every machine signed in to this Nod. Its camera and microphone need your permission.',
    ),
    field('Title', title),
    field('Address', url),
    errorBox,
    el(
      'div',
      { class: 'row' },
      submit,
      button('Cancel', () => close(), { kind: 'ghost' }),
    ),
  );
  overlay.append(card);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  title.focus();
}

function toolCard(entry: Entry): HTMLElement {
  const tool = tools.find((item) => item.id === entry.id) ?? null;
  const open = tool !== null && tool.openWindows > 0;

  const card = el(
    'article',
    { class: isForeign(entry) ? 'card tool-card tool-card-personal' : 'card tool-card' },
    el(
      'div',
      { class: 'tool-head' },
      glyph(entry.title, entryIcon(entry, tool)),
      el(
        'div',
        { class: 'tool-titles' },
        el('h2', { class: 'tool-title' }, entry.title),
        el('p', { class: 'tool-host muted' }, hostOf(entry.url)),
      ),
      favoriteToggle(entry),
    ),
    // canonico §22: the warning the owner asked for, beside the tool in the window that opens it.
    isForeign(entry)
      ? el(
          'p',
          { class: 'tool-warning', role: 'status' },
          'Not from your org — this link was not added by your organization. Camera and microphone need your permission.',
        )
      : null,
    el('p', { class: 'tool-state' }, stateText(tool)),
  );

  const login = tool === null || tool.login === null ? null : LOGIN_TEXT[tool.login];
  if (login !== null) card.append(el('p', { class: 'tool-login muted' }, login));

  const actions = el(
    'div',
    { class: 'row' },
    button(open ? 'Bring to front' : 'Open', () => openTool(entry.id), {
      kind: 'primary',
      title: open ? `Bring ${entry.title} to front` : `Open ${entry.title}`,
    }),
  );
  if (open) {
    actions.append(
      button('Close', () => {
        void runTools(() => call('tools.close', { id: entry.id }));
      }, {
        kind: 'ghost',
        title: `Close ${entry.title}`,
      }),
    );
  }
  if (tool !== null && tool.error !== null) {
    actions.append(
      button('Try again', () => {
        void runTools(() => call('tools.reload', { id: entry.id }));
      }, {
        kind: 'ghost',
        title: `Try ${entry.title} again`,
      }),
    );
  }
  // B7: only the person's own tool is theirs to remove.
  if (isForeign(entry)) {
    actions.append(
      button('Remove', () => removePersonalTool(entry.id), {
        kind: 'danger',
        title: `Remove ${entry.title}`,
      }),
    );
  }
  // The views (deep links) are one select in the action row instead of a button each, so a tool
  // with several views never wraps the card onto more lines. Picking one opens it and the select
  // goes back to its placeholder, ready for the next pick.
  if (entry.views.length > 0) {
    const views = el(
      'select',
      { class: 'input tool-views', attrs: { name: `views-${entry.id}`, 'aria-label': `${entry.title} views` } },
      el('option', { attrs: { value: '' } }, 'Views…'),
    );
    entry.views.forEach((entryView, index) => {
      views.append(el('option', { attrs: { value: String(index), title: `${entry.title} › ${entryView.label}` } }, entryView.label));
    });
    views.addEventListener('change', () => {
      const picked = views.value;
      views.value = '';
      if (picked === '') return;
      runTools(() => call('tools.openView', { toolId: entry.id, index: Number(picked) }));
    });
    actions.append(views);
  }
  card.append(actions);
  return card;
}

/** Everything around the content that reads the session and the host: sidebar, the panel, notices. */
function refreshChrome(): void {
  if (shell === null) return;
  renderSidebar();
  // E03: the panel follows the view — Home's cards, or the tab view of docked mode, which
  // `renderContent` mounts once and updates in place from here on.
  if (view === 'home') renderHome(shell.content);
  else if (view === 'tab') renderContent();
  // The offline-session and O2 banners read `host`, which a fresh unlock has just answered — the
  // boot's own render ran before it (`renderNotices` is idempotent).
  renderNotices();
}

function showBanner(e: unknown): void {
  if (shell === null) return;
  message(shell.banner, 'error', errorMessage(e));
}

function clearBanner(): void {
  if (shell !== null) clear(shell.banner);
}

// ------------------------------------------------------------ notices (host, RF-55)

/**
 * O2/SP04 §1: the guild serves a `minAppVersion` newer than this Nod, so the guild is disconnected:
 * the backend reaches no route but the discovery and the version check, pushes nothing
 * (`backend/sync.ts`) and refuses every call that would reach the host (`backend/main.ts`), and the
 * Nod runs on its local catalog — no org tool, no share, nothing of the cached snapshot shown. The
 * row, the token and the cache stay where they are, so updating is all it takes. This notice stays
 * on top of the window until the version moves — there is nothing to dismiss, which is the whole
 * point.
 */
function renderUpdateRequiredNotice(slot: HTMLElement): void {
  const state = host;
  if (state === null || !state.updateRequired) return;
  const guild = state.guild ?? 'The guild';
  const required = state.minAppVersion === null ? '' : ` (${state.minAppVersion} or newer)`;
  slot.append(
    el(
      'div',
      { class: 'notice notice-danger', role: 'status' },
      el(
        'p',
        { class: 'notice-text' },
        `${guild} needs a newer Nod${required}. Update to reconnect — the guild stays disconnected until then.`,
      ),
      el(
        'div',
        { class: 'notice-actions' },
        button(
          'Check for updates',
          () => {
            go('account');
          },
          { kind: 'primary' },
        ),
      ),
    ),
  );
}

/**
 * SP04 §3/RF-39: the host ended this session. Nothing syncs until the person signs in again, so the
 * notice sits on top of the window and takes them to Settings → Hosts.
 */
function renderHostNotice(slot: HTMLElement): void {
  const state = host;
  if (state === null || state.status !== 'signed-out') return;
  slot.append(
    el(
      'div',
      { class: 'notice notice-warn', role: 'status' },
      el('p', { class: 'notice-text' }, `${state.guild ?? 'The guild'} signed this Nod out`),
      el(
        'div',
        { class: 'notice-actions' },
        button(
          'Sign in',
          () => {
            go('hosts');
          },
          { kind: 'primary' },
        ),
      ),
    ),
  );
}

/**
 * RF-55: the newer release the backend found on its own, on top of the main window — the person
 * does not open Settings to learn about it. Installing stays a decision (A13): the button exists
 * only for an admin, who is the one `nod.installUpdate` accepts.
 */
function renderUpdateNotice(slot: HTMLElement): void {
  const notice = update;
  const person = session === null || !session.unlocked ? null : session.person;
  if (notice === null || notice.latest === null) return;
  const version = notice.latest;

  const dismiss = el(
    'button',
    {
      class: 'notice-dismiss',
      title: 'Dismiss until a newer version appears',
      aria: { label: `Dismiss the notice of version ${version}` },
      attrs: { type: 'button' },
    },
    '×',
  );
  dismiss.addEventListener('click', () => void dismissNotice(version));

  slot.append(
    el(
      'div',
      { class: 'notice', role: 'status' },
      el('p', { class: 'notice-text' }, `Version ${version} available`),
      el(
        'div',
        { class: 'notice-actions' },
        // Installing is an admin method (§2): a person without it never sees the button.
        person !== null && person.admin
          ? button('Install', () => installUpdateNow(), { kind: 'primary' })
          : null,
        button('Details', () => {
          go('account');
        }, { kind: 'ghost' }),
        dismiss,
      ),
    ),
  );
}

/**
 * 0.5.0 (RF-60): the person entered through the Offline tile, so the guild is disconnected for this
 * session — the local catalog, no sync, no host call, exactly as O2 disconnects it. The guild is
 * still on this machine and one click away, so the banner says which one it is and offers to lock.
 */
function renderOfflineSessionNotice(slot: HTMLElement): void {
  const state = host;
  const guild =
    (state !== null && state.guild !== null && state.guild !== '' ? state.guild : null) ??
    (profiles !== null && profiles.guilds.length > 0 ? profiles.guilds[0].guild : null);
  if (session === null || session.mode !== 'offline' || guild === null) return;
  slot.append(
    el(
      'div',
      { class: 'notice', role: 'status' },
      el('p', { class: 'notice-text' }, `Offline — ${guild} is not syncing. Lock and choose ${guild} to connect.`),
      el(
        'div',
        { class: 'notice-actions' },
        button(`Switch to ${guild}`, () => void lockSession(), { kind: 'primary' }),
      ),
    ),
  );
}

function renderNotices(): void {
  const target = shell;
  if (target === null) return;
  clear(target.notice);
  // O2 first: an out-of-date Nod is the reason nothing else it does reaches the guild.
  renderUpdateRequiredNotice(target.notice);
  renderOfflineSessionNotice(target.notice);
  renderHostNotice(target.notice);
  renderUpdateNotice(target.notice);
}

/** The install of Settings, reused here: the backend records the event, swaps and restarts. */
async function installUpdateNow(): Promise<void> {
  const target = shell;
  if (target === null) return;
  message(target.banner, 'info', 'Installing the update…');
  try {
    await call('nod.installUpdate');
  } catch (e) {
    showBanner(e);
    return;
  }
  message(target.banner, 'ok', 'Update installed');
}

/** RF-55: the dismissal is per version, and the backend keeps it in the machine's preferences. */
async function dismissNotice(version: string): Promise<void> {
  try {
    await call('nod.dismissUpdate', { version });
  } catch (e) {
    showBanner(e);
    return;
  }
  update = null;
  renderNotices();
}

async function runTools(action: () => Promise<ToolsState>): Promise<boolean> {
  clearBanner();
  let state: ToolsState;
  try {
    state = await action();
  } catch (e) {
    showBanner(e);
    return false;
  }
  applyToolsState(state);
  return true;
}

async function openTool(id: Id): Promise<void> {
  await runTools(() => call('tools.open', { id }));
}

// ------------------------------------------------------------------ tabs (E03)

/** E03: the page's `tabs.*` actions — one definition for the strip, the palette and the keyboard. */
const tabActions: TabsApi = tabsApi({
  run: (action) => {
    void runTools(action);
  },
  save: (id) => {
    void saveTab(id);
  },
  setEmbedded: (toolId, embedded) => {
    void applyEmbedded(toolId, embedded);
  },
  copyUsername: (item) => {
    void copyUsername(item);
  },
  copyPassword: (item) => {
    copyPassword(item);
  },
});

/**
 * E03 (RF-49): the tab the backend shows on the slot — what the strip's toolbar, the palette rows
 * and the shortcuts act on. `null` in Windows mode, and while every tab is detached.
 */
function tabOnPanel(): TabState | null {
  return tabsState === null ? null : activeTab(tabsState);
}

/**
 * 0.6.0b (RF-69): the credential the login cascade uses for `toolId` — the default one, or the
 * tool's first while the list holds no default. Only metadata comes from `vault.list`; the page
 * never holds a secret.
 */
function defaultCredential(toolId: Id): VaultItem | null {
  if (vaultItems === null) return null;
  const forTool = vaultItems.filter((item) => item.toolId === toolId);
  return forTool.find((item) => item.isDefault) ?? forTool[0] ?? null;
}

/**
 * 0.6.0b (RF-69): reads the vault's metadata for the embedded tab's Sign in control. There is no
 * vault push, so the read happens when an embedded tab lands on the panel and after a conversion;
 * the answer redraws the toolbar in place, and a failure keeps the last knowledge for the next
 * mount to retry. Settings → Vault reads the same list when its tab opens.
 */
function readVault(): Promise<void> {
  if (vaultPending !== null) return vaultPending;
  const epoch = vaultEpoch;
  const pending: Promise<void> = call('vault.list')
    .then((items) => {
      if (epoch === vaultEpoch) vaultItems = items;
    })
    .catch(() => undefined)
    .finally(() => {
      if (vaultPending === pending) vaultPending = null;
      if (epoch === vaultEpoch && view === 'tab' && tabView !== null && tabsState !== null) {
        tabView.update(tabsState);
      }
    })
    .then(() => undefined);
  vaultPending = pending;
  return pending;
}

/** 0.6.0b: the username is on screen in Settings → Vault, so it is copied as ordinary text. */
async function copyUsername(item: VaultItem): Promise<void> {
  clearBanner();
  try {
    await navigator.clipboard.writeText(item.username);
    if (shell !== null) message(shell.banner, 'ok', 'Username copied');
  } catch {
    if (shell !== null) {
      message(shell.banner, 'error', 'Could not copy; select it in Settings → Vault and copy it by hand');
    }
  }
}

/** 0.6.0b: the password prompt of a gate outside Settings — the Sign in control of an embedded tab. */
const GATE_DIALOG_ID = 'gate-dialog';

/**
 * K5/SP02 §9: renders the password prompt `runGate` asks for. The decision to ask, and the
 * system-prompt → password fallback, are the same helper Settings → Vault uses; only the place the
 * prompt appears differs (a dialog here, the card itself there). The typed value goes back to the
 * action and is never kept: the field is cleared before the call.
 */
function askGatePassword(note: string | null, run: (password?: string) => Promise<void>): void {
  if (document.getElementById(GATE_DIALOG_ID) !== null) return;
  const password = input('gate-password', { type: 'password', autocomplete: 'current-password' });
  password.classList.add('gate-password');
  const overlay = el('div', { id: GATE_DIALOG_ID, class: 'overlay' });

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  const confirm = button(
    'Confirm',
    () => {
      const typed = password.value;
      // Read once and cleared right away: neither the field nor this window keeps it.
      password.value = '';
      close();
      return run(typed === '' ? undefined : typed);
    },
    { kind: 'primary' },
  );
  const hint =
    note !== null
      ? note
      : info !== null && info.biometricAvailable
        ? 'This is a development run: the action takes your password.'
        : 'This machine has no biometrics: the action asks for your password.';
  const card = el(
    'div',
    { class: 'palette', role: 'dialog', aria: { modal: 'true', label: 'Password' } },
    el('h2', { class: 'dialog-title' }, 'Password'),
    el('p', { class: 'muted' }, 'Nod asks for your password before it copies the credential.'),
    field('Password', password, hint),
    el('div', { class: 'row' }, confirm, button('Cancel', () => close(), { kind: 'ghost' })),
  );
  password.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    confirm.click();
  });
  overlay.append(card);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  password.focus();
}

/**
 * 0.6.0b (RF-69): copies the credential's password through the gated `vault.copy`, exactly as
 * Settings → Vault's Copy does — the same item, the same fallback flow (`runGate`), and the same
 * wording. Nothing of the secret comes back to the page.
 */
function copyPassword(item: VaultItem): void {
  clearBanner();
  let failure: string | null = null;
  const run = async (password?: string): Promise<void> => {
    failure = null;
    try {
      await call('vault.copy', password === undefined ? { itemId: item.id } : { itemId: item.id, password });
      if (shell !== null) message(shell.banner, 'ok', 'Copied — paste it now: this page never held it');
    } catch (e) {
      failure = errorMessage(e);
      // A gate answer asks for the password; every other refusal is the window's banner.
      if (failure !== GATE_PROMPT_FAILED && failure !== GATE_PASSWORD_REQUIRED && shell !== null) {
        message(shell.banner, 'error', failure);
      }
    }
  };
  runGate({
    systemPrompt:
      session !== null &&
      !gateFallback &&
      (session.biometric || (info !== null && info.biometricAvailable && !info.devRun)),
    run,
    failure: () => failure,
    systemPromptFailed: () => {
      gateFallback = true;
    },
    ask: (note, submit) => askGatePassword(note, submit),
  });
}

/**
 * RF-69: "Show inside Nod"/"Open as window" of the toolbar and the palette. Becoming embedded asks
 * the backend first (`tabs.checkEmbed`, the same check `tabs.setEmbedded` runs): a tool whose
 * address may not be framed keeps its window and the panel says why; nothing else changes. The
 * conversion itself (the preference and every open tab of the tool, in place) is the backend's.
 */
async function applyEmbedded(toolId: Id, embedded: boolean): Promise<void> {
  clearBanner();
  if (embedded) {
    let check: EmbedCheck;
    try {
      check = await call('tabs.checkEmbed', { toolId });
    } catch (e) {
      showBanner(e);
      return;
    }
    if (!check.frameable) {
      const title = tools.find((tool) => tool.id === toolId)?.title ?? 'This tool';
      if (shell !== null) {
        message(
          shell.banner,
          'info',
          `${title} cannot be shown inside Nod — ${check.reason ?? 'the address refuses framing'}`,
        );
      }
      return;
    }
  }
  const applied = await runTools(() => call('tabs.setEmbedded', { toolId, embedded }));
  if (!applied || !embedded) return;
  // 0.6.0b (RF-69): no script reaches a subframe, so an embedded tool is never filled by the
  // login cascade. The person's saved credential is still useful through the tab's Sign in control;
  // say so after the conversion has landed, without blocking the new tab.
  await readVault();
  if (defaultCredential(toolId) !== null && shell !== null) {
    const title = tools.find((tool) => tool.id === toolId)?.title ?? 'This tool';
    message(
      shell.banner,
      'info',
      `${title} will not be signed in automatically inside Nod — use Sign in on the tab to copy your login.`,
    );
  }
}

/**
 * E03 (RF-49/RF-52): one `tools.state`/`tools`/`tabs.*` answer lands here. The center panel has two
 * faces, Home and the tab view, and Windows mode has only the first: a tab view left behind by a
 * mode that moved to Windows, or by the last tab closing, would be a strip with nothing under it.
 */
function applyTools(state: ToolsState): void {
  tabsState = state;
  tools = state.tools;
  // RF-69: the iframe layer follows every answer even while Home or Settings hide it — a closed
  // tab's iframe goes, a new embedded tab's frame is created (hidden) at once.
  embeds?.update(state);
  if (view !== 'tab') return;
  if (state.mode !== 'docked' || state.tabs.length === 0) view = 'home';
}

/**
 * E03 (RF-49): the panel follows the answer of a tools or tabs call — it is the tab view while the
 * mode is docked and there is anything to show there: the tab on the slot, or, with every tab
 * detached, the strip whose ⤓ (and the palette's "Dock tab") brings one back onto the panel
 * (RF-51). Only an empty strip would be worse than Home, and Windows mode has no tab view at all
 * (RF-52).
 */
function showActiveTab(state: ToolsState): void {
  if (state.mode !== 'docked') return;
  if (state.active === null && state.tabs.length === 0) return;
  view = 'tab';
}

/**
 * E03 (RF-49): "Open tabs" of the sidebar and of the palette — the tab view on the active tab,
 * or the strip alone while every tab is detached (`showActiveTab` keeps that case on the strip,
 * which is where the ⤓ of a detached tab lives, RF-51). This is the path a sidebar tool click takes
 * once the backend has answered, without any call of its own: the page already holds the state.
 */
function openTabView(): void {
  const state = tabsState;
  if (state === null || state.mode !== 'docked' || state.tabs.length === 0) return;
  showActiveTab(state);
  refreshChrome();
}

/**
 * E03: the answer of a tools or tabs call lands in the page and the window follows it — the tab view
 * takes (or keeps) the center panel, which is how a sidebar row, a Home card, a digit and a palette
 * row all end up on the same tab the backend answered with.
 */
function applyToolsState(state: ToolsState): void {
  applyTools(state);
  showActiveTab(state);
  refreshChrome();
}

/** E03 (RF-52): a view opens through the app too, so a `window` view lands as a tab of its own. */
async function openToolView(toolId: Id, index: number): Promise<void> {
  await runTools(() => call('tools.openView', { toolId, index }));
}

/**
 * E03 (RF-67): "Save to sidebar" — the tab's address becomes a personal view when its origin is
 * already a tool, or a personal tool with the probed title and icon otherwise, with no typing. The
 * catalog is read again so the new entry is on the sidebar and on Home right away.
 */
async function saveTab(id: string): Promise<void> {
  clearBanner();
  let saved: SaveTabResult;
  try {
    saved = await call('tabs.save', { id });
  } catch (e) {
    showBanner(e);
    return;
  }
  await loadCatalog();
  const entry = catalog.find((item) => item.id === saved.entryId) ?? null;
  if (shell === null) return;
  message(
    shell.banner,
    'ok',
    saved.kind === 'view'
      ? `Saved as a view of ${entry === null ? 'the tool' : entry.title}`
      : `Saved ${entry === null ? 'the link' : entry.title} to the sidebar`,
  );
}

/** The dialog of "Open link…" (E03/RF-66): it exists once, and Escape or a click outside closes it. */
const OPEN_LINK_DIALOG_ID = 'open-link-dialog';

/**
 * E03 (RF-66): any `http(s)` address opens in the Nod as an ad-hoc tab, next to the one on screen —
 * by hand from ⌘L, the tab view's toolbar, the palette and the `openLink` push (the same shortcut
 * registered globally). One field: `tabs.openLink` takes the address (a bare host gets `https://`)
 * and answers `invalid link` for anything that is not `http(s)`. It is the personal-tool dialog's
 * sibling: an overlay of the main window, keyboard first, and it talks to the backend only through
 * `call`.
 */
function openLinkDialog(): void {
  if (session === null || !session.unlocked || shell === null) return;
  if (document.getElementById(OPEN_LINK_DIALOG_ID) !== null) return;

  const url = input('url', { type: 'url', placeholder: 'https://example.com/docs', required: true });
  const errorBox = el('div', { class: 'palette-message' });
  const overlay = el('div', { id: OPEN_LINK_DIALOG_ID, class: 'overlay' });

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };

  /** Opens the address; a refusal (`invalid link`) stays in the dialog (RNF-01). */
  async function submit(): Promise<void> {
    clear(errorBox);
    let state: ToolsState;
    try {
      state = await call('tabs.openLink', { url: url.value.trim() });
    } catch (e) {
      message(errorBox, 'error', errorMessage(e));
      return;
    }
    close();
    // RF-49: docked, the new tab becomes the active one, so the panel shows it right away.
    applyToolsState(state);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  const card = el(
    'div',
    { class: 'palette', role: 'dialog', aria: { modal: 'true', label: 'Open link' } },
    el('h2', { class: 'dialog-title' }, 'Open link'),
    el(
      'p',
      { class: 'muted' },
      'It opens as an ad-hoc tab: not saved, no autofill, and Nod gives it no access to your account.',
    ),
    field('Address', url),
    errorBox,
    el(
      'div',
      { class: 'row' },
      button('Open', () => submit(), { kind: 'primary' }),
      button('Cancel', () => close(), { kind: 'ghost' }),
    ),
  );
  overlay.append(card);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  // Enter opens the address it is typed in, the way a one-field dialog reads.
  url.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submit();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  url.focus();
}

async function lockSession(): Promise<void> {
  clearBanner();
  let next: SessionState;
  try {
    next = await call('session.lock');
  } catch (e) {
    showBanner(e);
    return;
  }
  session = next;
  teardownShell();
  tools = [];
  // E03: the tab view went with the shell (`teardownShell`), and a locked window has no tabs.
  tabsState = null;
  // 0.6.0b: a locked window holds no vault metadata, and the gate starts from the system prompt
  // again for the next unlocked session.
  vaultEpoch += 1;
  vaultItems = null;
  vaultPending = null;
  gateFallback = false;
  catalog = [];
  favorites = [];
  // Locked windows cannot read `host.state` (SP05 §3): the badge waits for the next unlock.
  host = null;
  inboxCount = 0;
  joinInvite = null;
  view = 'home';
  render();
  // 0.5.0 (RF-60): the entry screen picks its tile from the profiles again — the unlock that just
  // ended stored its target as `last`.
  profiles = null;
  await loadProfiles();
}

async function loadUnlocked(): Promise<void> {
  let state: ToolsState;
  // 0.6.0b: every unlock starts with no vault metadata (the Sign in control reads it lazily) and
  // with the gate trying the system prompt first.
  vaultEpoch += 1;
  vaultItems = null;
  vaultPending = null;
  gateFallback = false;
  try {
    const [answer, entries, hostState, ids, tiles] = await Promise.all([
      call('tools.state'),
      call('catalog.list'),
      // SP05 §3: locked windows cannot read it, and the sidebar needs it right after the unlock.
      call('host.state'),
      // B7: the favorites the toggle draws from.
      call('favorites.list'),
      // 0.5.0 (RF-60): the tiles of the entry screen, read while locked and kept: the sidebar's top
      // mark is the guild's icon, and the next lock re-reads them anyway.
      call('session.profiles'),
    ]);
    state = answer;
    catalog = entries;
    host = hostState;
    favorites = ids;
    profiles = tiles;
  } catch (e) {
    showBanner(e);
    return;
  }
  // E03 (RF-52): Windows mode has no slot of the page's own — the backend is told once, here, so a
  // slot left over from a docked session is not followed by a window of a mode that has none.
  if (state.mode === 'windows') reportSlot(null);
  // E03 (RF-49/RF-50): the page's whole answer — the tabs, the active one, the mode — and the panel
  // shows its active tab at once: the tabs a docked session had open are restored and docked again.
  applyToolsState(state);
  void loadPresence();
  // K4: how many shares the inbox is holding, for the badge the sidebar draws.
  void loadInboxCount();
}

async function startUnlocked(): Promise<void> {
  render();
  await loadUnlocked();
}

// --------------------------------------------------------------- navigation

/**
 * E03: Home and one Settings tab are reached by name; the tab view of docked mode is entered by
 * `showActiveTab`, from the answer that made a docked tab active (RF-49).
 */
function go(target: 'home' | SettingsTab): void {
  view = target;
  // E03: the sidebar says where the window is — the "Open tabs" button's `aria-current` and its
  // ring are the view's, so the rail is drawn again even when a mounted Settings screen is only
  // asked to change tab.
  renderSidebar();
  if (target !== 'home' && settings !== null) {
    settingsTab = target;
    settings.setTab(target);
    return;
  }
  if (target === 'home') void loadPresence();
  renderContent();
}

function openPaletteNow(): void {
  if (session === null || !session.unlocked || shell === null) return;
  const panelTab = tabOnPanel();
  openPalette({
    tools,
    entries: catalog,
    isAdmin: session.person !== null && session.person.admin,
    go: (target) => {
      go(target);
    },
    lock: () => {
      void lockSession();
    },
    // B7: "Add personal tool" is in the palette, the keyboard-first rule of RNF-07. The dialog waits
    // for the next tick so the palette has closed and given its focus back before the input takes it.
    addPersonalTool: () => {
      window.setTimeout(() => openPersonalToolDialog(), 0);
    },
    // RF-58: only with a guild to show.
    showOnline: guildConnected()
      ? () => {
          go('home');
          document.getElementById('presence-card')?.focus();
        }
      : null,
    // K4: the vault inbox, reachable from the keyboard like every other screen (RNF-07).
    openInbox: guildConnected()
      ? () => {
          go('vault');
          document.getElementById('vault-inbox')?.focus();
        }
      : null,
    // E03: "Open tabs" — the strip of docked mode, from the state the page already holds ("the
    // path a tool click takes after its answer"); nothing to offer in Windows mode or empty.
    openTabs:
      tabsState !== null && tabsState.mode === 'docked' && tabsState.tabs.length > 0
        ? () => {
            openTabView();
          }
        : null,
    // E03: a tool and a view open through the app, so a docked tab lands on the center panel
    // (RF-49); a failure goes to the window's banner, as it does for the sidebar and Home.
    openTool: (id) => {
      void openTool(id);
    },
    openView: (toolId, index) => {
      void openToolView(toolId, index);
    },
    // E03 (RF-66): "Open link…" — the dialog waits for the next tick, like the one above, so the
    // palette has closed and given its focus back before the field takes it.
    openLink: () => {
      window.setTimeout(() => openLinkDialog(), 0);
    },
    // E03 (RF-50/RF-51/RF-67): the tab rows and actions. Windows mode has no tabs of the page's own
    // (RF-52), so the palette offers none there.
    tabs:
      tabsState !== null && tabsState.mode === 'docked'
        ? {
            active: panelTab,
            open: tabsState.tabs,
            // 0.6.0b: the Sign in rows of an embedded tab; the metadata is read by the tab view.
            credential:
              panelTab !== null && panelTab.toolId !== null
                ? defaultCredential(panelTab.toolId)
                : null,
            ...tabActions,
          }
        : null,
  });
}

// --------------------------------------------------------------------- boot

function render(): void {
  if (session === null) return;
  if (!session.unlocked) {
    teardownShell();
    renderLocked();
    return;
  }
  if (shell === null) buildShell();
  renderSidebar();
  renderContent();
  renderNotices();
}

async function boot(): Promise<void> {
  try {
    const [state, appInfo] = await Promise.all([call('session.state'), call('nod.info')]);
    session = state;
    info = appInfo;
  } catch (e) {
    root.replaceChildren(
      el(
        'div',
        { class: 'auth' },
        el('div', { class: 'card auth-card' }, el('p', { class: 'message message-error', role: 'alert' }, errorMessage(e))),
      ),
    );
    return;
  }
  render();
  if (session.unlocked) await loadUnlocked();
  else await loadProfiles();
}

on('session', (next) => {
  const wasUnlocked = session !== null && session.unlocked;
  session = next;
  if (!next.unlocked) {
    teardownShell();
    tools = [];
    // E03: the tab view went with the shell, and a locked window has no tabs.
    tabsState = null;
    // 0.6.0b: a locked window holds no vault metadata and no gate fallback from the old session.
    vaultEpoch += 1;
    vaultItems = null;
    vaultPending = null;
    gateFallback = false;
    catalog = [];
    favorites = [];
    host = null;
    inboxCount = 0;
    joinInvite = null;
    view = 'home';
    // 0.5.0 (RF-60): the entry screen is built again — its tile comes from the profiles, which the
    // unlock that just ended changed (`last`).
    resetEntry();
    render();
    void loadProfiles();
    return;
  }
  // A join always unlocks: the invite is spent, whether it came from a link or from typing.
  joinInvite = null;
  // A join (`host.activate` / `host.signIn`) unlocks the session from the page's own call: the
  // shell was never built, so it is built here with the tools and the catalog of the new person.
  if (!wasUnlocked) {
    void startUnlocked();
    return;
  }
  render();
});

on('tools', (next) => {
  // E03: the strip draws this answer. A push is not a person asking for a tab, so the window keeps
  // the view it is on — the `tab` push below is the one that says "show this tab". The one
  // exception is the mode switch (Settings → Account, RF-52/RF-69): moving to docked with tabs open
  // must land on the strip, because every tab may be detached and the strip is where their ⤓ is.
  const previous = tabsState;
  applyTools(next);
  if (previous !== null && previous.mode !== 'docked' && next.mode === 'docked' && next.tabs.length > 0) {
    view = 'tab';
  }
  refreshChrome();
});

/**
 * E03: the backend opened or activated a tab — a shortcut, an adopted popup, a `nod://open` link.
 * The page shows the tab view with it. A detached tab is its own window (the backend focused it
 * there), and the panel still shows the strip: with every tab detached the backend has no active
 * tab, and the strip is the only place its ⤓ is (RF-51). A tab the page has not been told about yet
 * arrives with its own `tools` push.
 */
on('tab', (id) => {
  const state = tabsState;
  if (state === null || state.mode !== 'docked') return;
  const tab = state.tabs.find((item) => item.id === id) ?? null;
  if (tab === null) {
    void runTools(() => call('tools.state'));
    return;
  }
  view = 'tab';
  // The sidebar's own mark follows the tab the backend put on the panel (`renderContent` alone
  // would leave the rail saying the previous tool).
  refreshChrome();
});

/**
 * E03 (RF-66): a global shortcut asked for "Open link…" — the dialog ⌘L opens in the page, pushed
 * while the main window does not have the keyboard (backend/tool-windows.ts).
 */
on('openLink', () => {
  openLinkDialog();
});

on('catalog', () => {
  void loadCatalog();
});

on('palette', () => {
  openPaletteNow();
});

on('update', (next) => {
  update = next;
  renderNotices();
});

on('host', (next) => {
  host = next;
  // The sidebar badge and the signed-out notice both read it; the Hosts tab reads the push itself.
  if (shell !== null) {
    renderSidebar();
    renderNotices();
  }
  void loadPresence();
  // K4: a share arrives as a host push, so the count beside Settings follows it.
  void loadInboxCount();
});

/**
 * SP04 §1.3: a `nod://join` link. Unlocked, it opens Settings → Hosts with the invite prefilled;
 * locked, it opens the `+` tile of the entry screen with the invite already looked up (RF-60) — a
 * Nod with no account at all is the usual case.
 */
on('join', (invite) => {
  if (invite === null) return;
  joinInvite = invite;
  if (session !== null && session.unlocked) {
    // The Hosts tab takes the invite through `mountSettings`, so it is mounted anew with it.
    destroySettings();
    go('hosts');
    return;
  }
  showEntryInvite(invite);
});

async function loadCatalog(): Promise<void> {
  try {
    // B7: the list the toggle draws from travels with the entries — a sync that moved the favorites
    // of another machine reaches this side through the same push.
    const [entries, ids] = await Promise.all([call('catalog.list'), call('favorites.list')]);
    catalog = entries;
    favorites = ids;
  } catch (e) {
    showBanner(e);
    return;
  }
  refreshChrome();
}

// The global shortcuts belong to the backend (backend/tool-windows.ts); this covers the main window
// while it has the keyboard.
document.addEventListener('keydown', (event) => {
  if (session === null || !session.unlocked) return;
  if (!event.metaKey && !event.ctrlKey) return;
  if (event.altKey) return;

  const key = event.key.toLowerCase();
  // E03 (§7): the page's keys of docked mode — and never while the backend registers the same ones
  // globally: `tabHotkeys` says it does, and its shortcuts fire while any Nod window is focused, the
  // main one included, so handling them here as well would run each action twice (see
  // `handleTabKey`).
  if (tabsState !== null && tabsState.mode === 'docked' && !tabsState.tabHotkeys) {
    // RF-66: "Open link…" is not an action on a window that may be out of sight — it opens a dialog,
    // so it works while Home or Settings hold the panel too.
    if (key === 'l') {
      event.preventDefault();
      openLinkDialog();
      return;
    }
    // E03 (§7): the rest act on the tab that is on the slot, and stay quiet while the panel is not
    // the tab view — a window the person cannot see is not the one ⌘W was asked to close. The
    // backend's own tab hotkeys follow the same rule, so the two agree whichever has the keyboard.
    if (view === 'tab' && handleTabKey(event, key)) return;
  }

  if (key === 'k') {
    event.preventDefault();
    openPaletteNow();
    return;
  }
  if (key === ',' || key === '<') {
    event.preventDefault();
    go('account');
    return;
  }
  if (key.length !== 1 || key < '1' || key > '9') return;

  const tool = tools.find((item) => item.digit === Number(key));
  if (tool === undefined) return;
  event.preventDefault();
  void openTool(tool.id);
});

/**
 * E03 (§7): ⌘T new tab, ⌘W close tab, ⌃Tab/⌃⇧Tab next and previous, ⌘⇧D detach or dock (a no-op
 * on an embedded tab, RF-69), ⌘D save the tab to the sidebar. True when the event was one of them.
 * ⌘L ("Open link…") is not one of these: the caller handles it, because the dialog works from Home
 * and Settings as well.
 *
 * The caller only reaches it in docked mode and while the tab view is the panel — the tab on the
 * slot is what these act on. It also keeps out while the backend registers the same keys globally:
 * `tabHotkeys` says it does, and its shortcuts fire while any Nod window is focused — the main one
 * included — so handling them here as well would run each action twice (⌘T would open two tabs,
 * ⌘W would close two). The keydown only reaches this document while the main window has the
 * keyboard, which is the case the global shortcuts and this handler would otherwise both cover
 * (canonico §7).
 */
function handleTabKey(event: KeyboardEvent, key: string): boolean {
  const tab = tabOnPanel();
  // ⌃Tab and ⌃⇧Tab are Control everywhere, not the page's ⌘/Ctrl.
  if (event.ctrlKey && !event.metaKey && key === 'tab') {
    event.preventDefault();
    tabActions.next(event.shiftKey ? -1 : 1);
    return true;
  }
  if (key === 't' && tab !== null && tab.toolId !== null) {
    event.preventDefault();
    tabActions.newTab(tab.toolId);
    return true;
  }
  if (key === 'w' && tab !== null) {
    // Closing the tab must not close the main window with it: the backend closes the tab, and this
    // side only says which one.
    event.preventDefault();
    tabActions.close(tab.id);
    return true;
  }
  if (key === 'd' && event.shiftKey && tab !== null) {
    event.preventDefault();
    // RF-69: an embedded tab has no window to detach into or dock from — the key is a no-op.
    if (tab.embedded) return true;
    if (tab.docked) tabActions.detach(tab.id);
    else tabActions.dock(tab.id);
    return true;
  }
  if (key === 'd' && tab !== null) {
    event.preventDefault();
    tabActions.save(tab.id);
    return true;
  }
  return false;
}

void boot();
