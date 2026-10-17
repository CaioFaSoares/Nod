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
import { button, clear, el, field, initials, input, message } from './ui';
import type { SettingsTab } from './settings';
import type {
  AppInfo,
  Entry,
  EntryProfiles,
  HostState,
  Id,
  JoinInvite,
  LoginResult,
  SessionState,
  ToolStatus,
  ToolsState,
  UpdateInfo,
} from '../shared/types';
import { categoryOf, groupByCategory } from '../shared/catalog';
import type { PresenceEntry } from '../shared/host-api';

/** What the right side shows: Home or one Settings tab. */
type View = 'home' | SettingsTab;

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

// ------------------------------------------------------------------ helpers

/** Tool icon: the data URI from the backend, or the first two letters of the title. */
function glyph(title: string, icon: string | null): HTMLElement {
  if (icon !== null) return el('img', { class: 'glyph-img', attrs: { src: icon, alt: '' } });
  const initials = title.trim().slice(0, 2).toUpperCase();
  return el('span', { class: 'chip' }, initials === '' ? '?' : initials);
}

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
  root.replaceChildren(
    el('div', { class: 'shell' }, sidebar, el('div', { class: 'main' }, notice, banner, content)),
  );
}

function teardownShell(): void {
  destroySettings();
  // B7: the dialog is an overlay of the main window, so it goes with the shell (a lock).
  document.getElementById(PERSONAL_DIALOG_ID)?.remove();
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
  shell.sidebar.replaceChildren(mark, el('span', { class: 'rail-separator', aria: { hidden: 'true' } }), list, footer);
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

  const login = tool.login === null ? null : LOGIN_TEXT[tool.login];
  const tip = login === null ? tool.title : `${tool.title} — ${login}`;
  const base = foreign ? `Not from your org — ${tip}` : tip;
  const label = tool.error === null ? base : `${tool.title} — failed: ${tool.error}`;
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

function renderContent(): void {
  if (shell === null || session === null || info === null) return;
  if (view === 'home') {
    destroySettings();
    renderHome(shell.content);
    return;
  }
  if (settings !== null && settingsTab === view) {
    settings.update(session);
    return;
  }
  destroySettings();
  const container = el('div', { class: 'settings-view' });
  shell.content.replaceChildren(container);
  settingsTab = view;
  settings = mountSettings(container, { session, info, tab: view, host, join: joinInvite });
}

/** canonico §22, B7: a tool the org did not add — a personal tool, or an entry marked personal. */
function isForeign(entry: Entry): boolean {
  return entry.scope === 'personal';
}

function renderHome(content: HTMLElement): void {
  if (session === null) return;
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
  content.replaceChildren(
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
      button('Close', () => runTools(() => call('tools.close', { id: entry.id })), {
        kind: 'ghost',
        title: `Close ${entry.title}`,
      }),
    );
  }
  if (tool !== null && tool.error !== null) {
    actions.append(
      button('Try again', () => runTools(() => call('tools.reload', { id: entry.id })), {
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
  card.append(actions);

  if (entry.views.length > 0) {
    const views = el('div', { class: 'row tool-views' });
    entry.views.forEach((entryView, index) => {
      views.append(
        button(entryView.label, () => runTools(() => call('tools.openView', { toolId: entry.id, index })), {
          kind: 'ghost',
          title: `${entry.title} › ${entryView.label}`,
        }),
      );
    });
    card.append(views);
  }
  return card;
}

/** Everything around the content that reads the session and the host: sidebar, Home, notices. */
function refreshChrome(): void {
  if (shell === null) return;
  renderSidebar();
  if (view === 'home') renderHome(shell.content);
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

async function runTools(action: () => Promise<ToolsState>): Promise<void> {
  clearBanner();
  let state: ToolsState;
  try {
    state = await action();
  } catch (e) {
    showBanner(e);
    return;
  }
  tools = state.tools;
  refreshChrome();
}

async function openTool(id: Id): Promise<void> {
  await runTools(() => call('tools.open', { id }));
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
  try {
    const [state, entries, hostState, ids, tiles] = await Promise.all([
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
    tools = state.tools;
    catalog = entries;
    host = hostState;
    favorites = ids;
    profiles = tiles;
  } catch (e) {
    showBanner(e);
    return;
  }
  refreshChrome();
  void loadPresence();
  // K4: how many shares the inbox is holding, for the badge the sidebar draws.
  void loadInboxCount();
}

async function startUnlocked(): Promise<void> {
  render();
  await loadUnlocked();
}

// --------------------------------------------------------------- navigation

function go(target: View): void {
  view = target;
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
  tools = next.tools;
  refreshChrome();
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

void boot();
