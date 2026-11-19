// The Nod main window: boot, the entry screen, the sidebar, Home and Settings routing
// (docs/arquitetura.md §5, canonico §7).
// The page talks to the backend only through `./api`, and only with methods of `ApiContract`.
// No password or invite code ever leaves this module except as the parameter of `call(...)`:
// nothing is written to storage, the console, the page title or an error message.
// 0.5.0 (RF-60): the locked screen is the rail of tiles in `./entry`; the join flow it and
// Settings → Hosts share is `./join`.
import { call, errorMessage, on } from './api';
import { applyAppearance } from './appearance';
import { mountEntry, resetEntry, showEntryInvite } from './entry';
import { openPalette } from './palette';
import { mountSettings } from './settings';
import { activeTab, mountTabs, reportSlot, tabsApi } from './tabs';
import type { TabsApi, TabsHandle } from './tabs';
import { button, clear, closeMenu, closePrompt, el, field, glyph, iconButton, iconSlot, initials, input, message, openMenu, promptText } from './ui';
import type { MenuItem } from './ui';
import {
  addFolder,
  folderOf,
  mergeIntoFolder,
  moveFolder,
  moveTool,
  newFolderId,
  removeFolder,
  renameFolder,
  seedLayout,
  setFolderOpen,
  step,
  takeOutOfFolder,
} from '../shared/sidebar-layout';
import type { Drop } from '../shared/sidebar-layout';
import type { SettingsTab } from './settings';
import type {
  AppInfo,
  Entry,
  EntryProfiles,
  HostState,
  Id,
  JoinInvite,
  LoginResult,
  Role,
  RosterPerson,
  SaveTabResult,
  SessionState,
  SidebarFolder,
  SidebarLayout,
  TabState,
  ToolStatus,
  ToolsState,
  UpdateInfo,
} from '../shared/types';
import { categoryOf, orgAccountOf, tagsOf } from '../shared/catalog';
import {
  DEFAULT_LIBRARY_VIEW,
  LIBRARY_VIEWS,
  blockStacks,
  libraryGroups,
  libraryViewOf,
  orgChart,
  rosterOf,
  type LibraryInput,
  type LibraryView,
} from '../shared/library';
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
type SettingsHandle = ReturnType<typeof mountSettings>;

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
 * How many `tools` pushes have been applied. A read issued before one of them hands back the state
 * of a moment ago, and `loadUnlocked` must not put an older answer over a newer push (a member
 * joining the guild has the first snapshot land between two of its reads); this is what orders the
 * two.
 */
let toolsRevision = 0;
/**
 * E03: the whole answer of `tools.state`/`tools`/`tabs.*` — the tabs in strip order, the active
 * one, the mode and whether the backend owns the tab shortcuts (RF-49…RF-52). `null` before the
 * first answer and after a lock.
 */
let tabsState: ToolsState | null = null;
/** Answer of `catalog.list` or a refresh triggered by the push `catalog`. */
let catalog: Entry[] = [];
/** `toolsRevision`'s counterpart for the catalog: a push owns the answer newer than a read. */
let catalogRevision = 0;
/**
 * B7/SP05 §4: the person's ordered favorites, from `favorites.list`. The sidebar's order comes from
 * the backend already; this list is what draws the toggle's state.
 */
let favorites: Id[] = [];
/**
 * The person's own sidebar (`sidebar.layout`): their order and folders, or `null` while they keep the
 * default one. The first edit seeds it from the default (`seedLayout`), so nothing else moves.
 */
let layout: SidebarLayout | null = null;
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

/** Atrius: the state of a tool as a key for its glyph — the words stay `stateText`'s. */
function stateKey(tool: ToolStatus | null): 'closed' | 'loading' | 'failed' | 'open' {
  if (tool === null) return 'closed';
  if (tool.loading) return 'loading';
  if (tool.error !== null) return 'failed';
  return tool.openWindows > 0 ? 'open' : 'closed';
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
  closeMenu();
  closePrompt();
  endRailDrag();
  destroySettings();
  // E03: the tab view goes with the panel (a lock), reporting the empty slot on its way out.
  destroyTabView();
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
  // The quick way to a new tool, at the end of the tools: the dialog of `personal.saveTool`.
  const add = el(
    'button',
    { class: 'sidebar-add', title: 'Add tool', aria: { label: 'Add tool' }, attrs: { type: 'button' } },
    el('span', { class: 'glyph', aria: { hidden: 'true' } }, '+'),
    el('span', { class: 'sidebar-action-label' }, 'Add tool'),
  );
  add.addEventListener('click', () => openPersonalToolDialog());
  list.append(add);
  // A right click on the rail itself (not on an item) offers what the whole rail can do.
  list.addEventListener('contextmenu', (event) => {
    if (event.target !== list) return;
    event.preventDefault();
    openMenu({ x: event.clientX, y: event.clientY }, railMenu(), 'Sidebar');
  });
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
    sidebarAction('⚿', 'Saved logins', () => {
      go('vault');
    }, inboxCount),
    // Atrius: ☷ is the rail's Settings glyph (⚙ can render as an emoji on macOS).
    sidebarAction('☷', 'Settings', () => {
      go('account');
    }),
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
  if (layout !== null) return customRows(layout);
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

// ------------------------------------------------------------ the person's own sidebar

/**
 * The default sidebar as groups — what `sidebarRows` draws while there is no layout: the favorites,
 * the guild's categories in order, the uncategorized org tools, the personal tools. The first edit
 * seeds the layout from it (`seedLayout`): each category becomes an open folder of the same name.
 */
function defaultGroups(): { category: string | null; ids: Id[] }[] {
  const entryOf = new Map<Id, Entry>();
  for (const entry of catalog) entryOf.set(entry.id, entry);
  const favorite = new Set(favorites);
  const groups: { category: string | null; ids: Id[] }[] = [];
  let index = 0;
  const top: Id[] = [];
  while (index < tools.length && favorite.has(tools[index].id)) {
    top.push(tools[index].id);
    index += 1;
  }
  groups.push({ category: null, ids: top });
  const rest = tools.slice(index);
  for (const tool of rest) {
    const entry = entryOf.get(tool.id);
    const category = entry === undefined || entry.scope === 'personal' ? null : categoryOf(entry);
    const last = groups[groups.length - 1];
    if (last.category === category) last.ids.push(tool.id);
    else groups.push({ category, ids: [tool.id] });
  }
  return groups;
}

/** The layout to edit: the person's, or the default seeded into one. */
function currentLayout(): SidebarLayout {
  const current = layout ?? seedLayout(defaultGroups(), () => newFolderId());
  const placed = new Set(current.nodes.flatMap((node) => node.kind === 'tool' ? [node.id] : node.folder.tools));
  // A sync or quick-add can introduce tools after the layout was saved. They are drawn at the end
  // and must be included before an edit too, otherwise moving one of them is a silent no-op.
  return { nodes: [...current.nodes, ...tools.filter((tool) => !placed.has(tool.id)).map((tool) => ({ kind: 'tool' as const, id: tool.id }))] };
}

/**
 * One edit of the sidebar: drawn at once, then stored whole. The backend pushes the catalog and the
 * tools back in the new order (the digits follow); a refusal puts the stored layout back.
 */
async function commitLayout(next: SidebarLayout | null): Promise<void> {
  const owner = shell;
  if (owner === null || session?.unlocked !== true) return;
  layout = next;
  renderSidebar();
  clearBanner();
  try {
    await call('sidebar.setLayout', { layout: next });
  } catch (e) {
    if (shell !== owner) return;
    showBanner(e);
    try {
      const stored = await call('sidebar.layout');
      if (shell !== owner) return;
      layout = stored;
    } catch {
      // The next catalog push reads it again.
    }
    renderSidebar();
  }
}

/** The rail in the person's order: their items, then whatever the layout does not name yet. */
function customRows(current: SidebarLayout): HTMLElement[] {
  const byId = new Map<Id, ToolStatus>();
  for (const tool of tools) byId.set(tool.id, tool);
  const rows: HTMLElement[] = [];
  const placed = new Set<Id>();
  for (const node of current.nodes) {
    if (node.kind === 'tool') {
      const tool = byId.get(node.id);
      if (tool === undefined || placed.has(tool.id)) continue;
      placed.add(tool.id);
      rows.push(sidebarTool(tool));
      continue;
    }
    const inside: ToolStatus[] = [];
    for (const id of node.folder.tools) {
      const tool = byId.get(id);
      if (tool === undefined || placed.has(id)) continue;
      placed.add(id);
      inside.push(tool);
    }
    rows.push(sidebarFolder(node.folder, inside));
  }
  const rest = tools.filter((tool) => !placed.has(tool.id));
  if (rest.length > 0) {
    // Tools the guild added since the person arranged the rail: after a bare rule, in catalog order.
    if (rows.length > 0) rows.push(sidebarDivider(null));
    for (const tool of rest) rows.push(sidebarTool(tool));
  }
  return rows;
}

/**
 * One folder of the rail. Closed, its cell shows up to four of its tools in small; open, the cell is
 * its name and its tools follow inside a band. A click opens or closes it (stored with the layout).
 */
function sidebarFolder(folder: SidebarFolder, inside: ToolStatus[]): HTMLElement {
  const onPanel = tabOnPanel();
  const holdsCurrent = onPanel !== null && inside.some((tool) => tool.id === onPanel.toolId);
  const holdsOpen = inside.some((tool) => tool.openWindows > 0);
  const count = `${inside.length} ${inside.length === 1 ? 'tool' : 'tools'}`;
  const classes = ['folder-head'];
  if (!folder.open && holdsOpen) classes.push('open');
  if (!folder.open && holdsCurrent) classes.push('current');
  const head = el(
    'button',
    {
      class: classes.join(' '),
      title: `${folder.name} — ${count}`,
      aria: { label: `Folder ${folder.name}, ${count}`, expanded: folder.open ? 'true' : 'false' },
      data: { 'folder-head': folder.id },
      attrs: { type: 'button' },
    },
    folder.open
      ? el('span', { class: 'folder-name', aria: { hidden: 'true' } }, folder.name)
      : el(
          'span',
          { class: 'folder-grid', aria: { hidden: 'true' } },
          ...inside.slice(0, 4).map((tool) => glyph(tool.title, tool.icon)),
        ),
  );
  head.addEventListener('click', () => {
    void commitLayout(setFolderOpen(currentLayout(), folder.id, !folder.open));
  });
  arrangeable(head, { folder: folder.id }, folder.name);
  const box = el(
    'div',
    { class: folder.open ? 'rail-folder rail-folder-open' : 'rail-folder', role: 'group', aria: { label: folder.name }, data: { folder: folder.id } },
    head,
  );
  if (folder.open) {
    for (const tool of inside) box.append(sidebarTool(tool));
    if (inside.length === 0) box.append(el('span', { class: 'folder-empty', aria: { hidden: 'true' } }, '·'));
  }
  return box;
}

type RailRef = { tool: Id } | { folder: string };

/** The folders of the layout, in rail order. */
function folders(of: SidebarLayout): SidebarFolder[] {
  const found: SidebarFolder[] = [];
  for (const node of of.nodes) if (node.kind === 'folder') found.push(node.folder);
  return found;
}

/** Asks for a folder's name; `null` when the person cancels. */
async function askFolderName(value = ''): Promise<string | null> {
  const owner = shell;
  const name = await promptText({
    title: value === '' ? 'New folder' : 'Rename folder',
    label: 'Name',
    value,
    placeholder: 'Work',
    confirm: value === '' ? 'Create folder' : 'Rename',
  });
  return owner !== null && shell === owner && session?.unlocked === true ? name : null;
}

/** What the rail as a whole can do — its right click, and the palette's sidebar rows. */
function railMenu(): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Add tool…', glyph: '+', run: () => openPersonalToolDialog() },
    {
      label: 'New folder…',
      glyph: '▤',
      run: () => {
        void askFolderName().then((name) => {
          if (name !== null) void commitLayout(addFolder(currentLayout(), name, newFolderId()));
        });
      },
    },
  ];
  if (layout !== null) {
    items.push('separator', { label: 'Reset sidebar order', glyph: '↺', run: () => void commitLayout(null) });
  }
  return items;
}

/** The acts on one rail item: its right click, the menu key, and Shift+F10. */
function itemMenu(ref: RailRef): MenuItem[] {
  const current = currentLayout();
  const items: MenuItem[] = [
    { group: 'Arrange' },
    { label: 'Move up', glyph: '↑', hint: '[⌥↑]', run: () => void commitLayout(step(currentLayout(), ref, -1)) },
    { label: 'Move down', glyph: '↓', hint: '[⌥↓]', run: () => void commitLayout(step(currentLayout(), ref, 1)) },
  ];
  if ('tool' in ref) {
    const id = ref.tool;
    const holder = folderOf(current, id);
    items.push({ group: 'Folder' });
    for (const folder of folders(current)) {
      if (holder !== null && holder.id === folder.id) continue;
      items.push({ label: `Move to ${folder.name}`, glyph: '▸', run: () => void commitLayout(moveTool(layout === null ? current : currentLayout(), id, { into: folder.id })) });
    }
    items.push({
      label: 'New folder with this tool…',
      glyph: '▤',
      run: () => {
        void askFolderName().then((name) => {
          if (name !== null) void commitLayout(addFolder(currentLayout(), name, newFolderId(), id));
        });
      },
    });
    if (holder !== null) {
      items.push({ label: `Take out of ${holder.name}`, glyph: '◂', run: () => void commitLayout(takeOutOfFolder(currentLayout(), id)) });
    }
  } else {
    const folderId = ref.folder;
    const folder = folders(current).find((item) => item.id === folderId);
    if (folder !== undefined) {
      items.push(
        { group: 'Folder' },
        {
          label: folder.open ? 'Close folder' : 'Open folder',
          glyph: folder.open ? '▴' : '▾',
          run: () => void commitLayout(setFolderOpen(currentLayout(), folderId, !folder.open)),
        },
        {
          label: 'Rename folder…',
          glyph: '✎',
          run: () => {
            void askFolderName(folder.name).then((name) => {
              if (name !== null) void commitLayout(renameFolder(currentLayout(), folderId, name));
            });
          },
        },
        { label: 'Add tool here…', glyph: '+', run: () => openPersonalToolDialog(folderId) },
        'separator',
        { label: 'Delete folder, keep its tools', glyph: '×', danger: true, run: () => void commitLayout(removeFolder(currentLayout(), folderId)) },
      );
    }
  }
  items.push('separator', ...railMenu());
  return items;
}

/** The drag in progress over the rail, if any. */
interface RailDrag {
  ref: RailRef;
  source: HTMLElement;
  x: number;
  y: number;
  active: boolean;
  /** where it lands, or the tool it would make a folder with */
  target: { drop: Drop; line: { top: number } | null; into: HTMLElement | null } | null;
  marker: HTMLElement | null;
}

let railDrag: RailDrag | null = null;

/**
 * Makes a rail item arrangeable: drag it (the pointer, 4 px before it counts) to move it or, onto
 * another tool, to make a folder of the two; ⌥↑/⌥↓ step it from the keyboard; the right click (or
 * the menu key) opens its acts. A drag never opens the item it started on.
 */
function arrangeable(node: HTMLElement, ref: RailRef, name: string): void {
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const at = event.clientX === 0 && event.clientY === 0 ? node : { x: event.clientX, y: event.clientY };
    openMenu(at, itemMenu(ref), name);
  });
  node.addEventListener('keydown', (event) => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      void commitLayout(step(currentLayout(), ref, event.key === 'ArrowUp' ? -1 : 1)).then(() => {
        refocus(ref);
      });
    } else if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      openMenu(node, itemMenu(ref), name);
    }
  });
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || railDrag !== null) return;
    railDrag = { ref, source: node, x: event.clientX, y: event.clientY, active: false, target: null, marker: null };
    window.addEventListener('pointermove', onRailMove);
    window.addEventListener('pointerup', onRailUp, { once: true });
    window.addEventListener('pointercancel', onRailCancel, { once: true });
    document.addEventListener('keydown', onRailEscape, true);
  });
}

/** The focus follows an item the keyboard just moved (the rail was drawn again). */
function refocus(ref: RailRef): void {
  const selector = 'tool' in ref ? `.sidebar [data-tool="${CSS.escape(ref.tool)}"]` : `.sidebar [data-folder-head="${CSS.escape(ref.folder)}"]`;
  document.querySelector<HTMLElement>(selector)?.focus();
}

function onRailMove(event: PointerEvent): void {
  const drag = railDrag;
  if (drag === null) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.active = true;
    drag.source.classList.add('dragging');
    document.body.classList.add('rail-dragging');
    drag.marker = el('div', { class: 'rail-drop', aria: { hidden: 'true' } });
    document.body.append(drag.marker);
    document.addEventListener('keydown', onRailEscape, true);
  }
  event.preventDefault();
  drag.target = railTarget(drag, event.clientX, event.clientY);
  document.querySelectorAll('.drop-into').forEach((node) => node.classList.remove('drop-into'));
  const marker = drag.marker;
  if (marker === null) return;
  const line = drag.target?.line ?? null;
  marker.hidden = line === null;
  if (line !== null) {
    const rail = document.querySelector('.sidebar')?.getBoundingClientRect();
    marker.style.top = `${Math.round(line.top - 1)}px`;
    marker.style.left = `${Math.round(rail?.left ?? 0)}px`;
    marker.style.width = `${Math.round(rail?.width ?? 48)}px`;
  }
  drag.target?.into?.classList.add('drop-into');
}

/**
 * Where the pointer would drop the dragged item: next to an item (the top or bottom third of it),
 * into a folder (the middle of its cell), onto a tool (its middle: the two become a folder), or at
 * the end (the rail's empty part).
 */
function railTarget(drag: RailDrag, x: number, y: number): RailDrag['target'] {
  const hit = document.elementFromPoint(x, y);
  const rail = hit?.closest('.sidebar-tools');
  if (hit === null || rail === null || rail === undefined) return null;
  const item = hit.closest<HTMLElement>('[data-tool], [data-folder-head]');
  if (item === null) {
    const last = rail.querySelector('.sidebar-add')?.getBoundingClientRect();
    return { drop: { end: true }, line: last === undefined ? null : { top: last.top }, into: null };
  }
  const box = item.getBoundingClientRect();
  const rel = (y - box.top) / box.height;
  const dragging = drag.ref;
  const toolId = item.dataset.tool;
  if (toolId !== undefined) {
    if ('tool' in dragging && dragging.tool === toolId) return null;
    if ('folder' in dragging) {
      return rel < 0.5
        ? { drop: { before: toolId }, line: { top: box.top }, into: null }
        : { drop: { after: toolId }, line: { top: box.bottom }, into: null };
    }
    if (rel < 0.3) return { drop: { before: toolId }, line: { top: box.top }, into: null };
    if (rel > 0.7) return { drop: { after: toolId }, line: { top: box.bottom }, into: null };
    // The middle of a tool: the two make a folder (or join the folder the target is in).
    return { drop: { before: toolId }, line: null, into: item };
  }
  const folderId = item.dataset.folderHead ?? '';
  const open = item.getAttribute('aria-expanded') === 'true';
  if ('folder' in dragging) {
    if (dragging.folder === folderId) return null;
    const box2 = item.closest('.rail-folder')?.getBoundingClientRect() ?? box;
    return rel < 0.5
      ? { drop: { beforeFolder: folderId }, line: { top: box.top }, into: null }
      : { drop: { afterFolder: folderId }, line: { top: box2.bottom }, into: null };
  }
  if (rel < 0.3) return { drop: { beforeFolder: folderId }, line: { top: box.top }, into: null };
  if (rel > 0.7 && !open) return { drop: { afterFolder: folderId }, line: { top: box.bottom }, into: null };
  return { drop: { into: folderId, index: open ? 0 : undefined }, line: null, into: item };
}

function endRailDrag(): RailDrag | null {
  const drag = railDrag;
  railDrag = null;
  window.removeEventListener('pointermove', onRailMove);
  window.removeEventListener('pointerup', onRailUp);
  window.removeEventListener('pointercancel', onRailCancel);
  document.removeEventListener('keydown', onRailEscape, true);
  document.body.classList.remove('rail-dragging');
  document.querySelectorAll('.drop-into').forEach((node) => node.classList.remove('drop-into'));
  if (drag !== null) {
    drag.source.classList.remove('dragging');
    drag.marker?.remove();
  }
  return drag;
}

function onRailCancel(): void {
  endRailDrag();
}

function onRailEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  endRailDrag();
}

function onRailUp(): void {
  const drag = endRailDrag();
  if (drag === null || !drag.active) return;
  // The click that follows a drag is not a request to open the item.
  const swallow = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  const target = drag.target;
  if (target === null) return;
  const current = currentLayout();
  if ('folder' in drag.ref) {
    void commitLayout(moveFolder(current, drag.ref.folder, target.drop));
    return;
  }
  const id = drag.ref.tool;
  if (target.into !== null && target.into.dataset.tool !== undefined) {
    void commitLayout(mergeIntoFolder(current, target.into.dataset.tool, id, 'New folder', newFolderId()));
    return;
  }
  void commitLayout(moveTool(current, id, target.drop));
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
  arrangeable(node, { tool: tool.id }, tool.title);
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
  shell.content.replaceChildren(container);
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
  if (tabView !== null) {
    tabView.update(state);
    return;
  }
  const container = el('div', { class: 'tab-view' });
  shell.content.replaceChildren(container);
  tabView = mountTabs(container, {
    state,
    actions: tabActions,
    // RF-66: the dialog of `openLinkDialog`, beside the personal-tool one.
    openLink: () => openLinkDialog(),
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
          ? button('Add team tool', () => {
              go('tools');
              settings?.addTool();
            }, { kind: 'primary' })
          : el('p', { class: 'muted' }, 'Add a personal tool, or ask your admin for access.'),
      ),
    );
  } else {
    body.append(libraryBody());
  }
  const card = presenceCard();
  // RF-79's bar stays one row at the window's smallest width: the acts are marks, and their words
  // — the button's own text, the tooltip and the name the screen reader reads — are the whole
  // label. The palette also answers ⌘K / Ctrl+K.
  const searchTools = iconButton('⌕', 'Search tools', () => openPaletteNow(), {
    title: 'Search tools or actions (⌘K / Ctrl+K)',
  });
  // The magnifier is drawn smaller than the other marks in its own em box; the class gives it the
  // size that reads beside them.
  searchTools.classList.add('header-act-search');
  content.replaceChildren(
    el(
      'header',
      { class: 'content-header' },
      el('h1', { class: 'content-title' }, 'Tools'),
      libraryToolbar(),
      el(
        'div',
        { class: 'header-acts' },
        searchTools,
        // B7: anyone may add a personal tool; the dialog asks for a title and an address.
        iconButton('+', 'Add personal tool', () => openPersonalToolDialog(), {
          title: 'Add a tool only you see',
        }),
      ),
    ),
    body,
    ...(card === null ? [] : [card]),
  );
}

// ------------------------------------------------------------- RF-79: the library

/**
 * The library (RF-79): the Steam-like catalog of both surfaces. The models are `shared/library.ts`'s
 * — what a group is, what the search reads, what the org chart and the isometric blocks draw — and
 * the styles are `shared/library.css`'s, imported by `src/style.css`; what stays here is the app's
 * own half: the search field, the view buttons, and the card with its six acts.
 */

/** The machine's own choices, kept where the web portal keeps them: a page preference, never a guild call. */
const LIBRARY_VIEW_KEY = 'nod-library-view';
const LIBRARY_COLLAPSED_KEY = 'nod-library-collapsed';

let libraryQuery = '';
let libraryViewLoaded = false;
let libraryView: LibraryView = DEFAULT_LIBRARY_VIEW;

function currentLibraryView(): LibraryView {
  if (!libraryViewLoaded) {
    libraryView = libraryViewOf(window.localStorage.getItem(LIBRARY_VIEW_KEY));
    libraryViewLoaded = true;
  }
  return libraryView;
}

function chooseLibraryView(next: LibraryView): void {
  libraryView = next;
  libraryViewLoaded = true;
  try {
    window.localStorage.setItem(LIBRARY_VIEW_KEY, next);
  } catch {
    /* a preference that cannot be stored is still in force for this window */
  }
}

function libraryCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(LIBRARY_COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function storeLibraryCollapsed(set: Set<string>): void {
  try {
    window.localStorage.setItem(LIBRARY_COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* same rule: the collapse is still in force while the window lives */
  }
}

/** The library's input from the page's own state; the roster and the roles fill in when a view needs them. */
function libraryInput(roles: Role[] = [], people: RosterPerson[] = []): LibraryInput {
  return {
    orgTools: catalog.filter((entry) => !isForeign(entry)),
    personalTools: catalog.filter((entry) => isForeign(entry)),
    favorites,
    roles,
    people: rosterOf(people, roles),
  };
}

/**
 * The mark each view takes in Home's strip. `iconButton` keeps the view's label as the button's
 * own text — the tooltip, the name a screen reader reads and what the smoke matches — so the mark
 * is the only thing the eye loses.
 */
const LIBRARY_VIEW_GLYPHS: Record<LibraryView, string> = {
  cards: '▦',
  list: '☰',
  org: '┬',
  blocks: '⬔',
};

/** The search field and the four views, beside the title (RF-79's "a busca e as categorias"). */
function libraryToolbar(): HTMLElement {
  const search = el(
    'input',
    {
      class: 'input lb-search-input',
      aria: { label: 'Search the library' },
      attrs: { type: 'search', placeholder: 'Search title, category, tag, account…' },
    },
  );
  search.value = libraryQuery;
  search.addEventListener('input', () => {
    libraryQuery = search.value;
    refreshLibrary();
  });

  const views = el('div', { class: 'lb-views', role: 'group', aria: { label: 'Library views' } });
  for (const option of LIBRARY_VIEWS) {
    const node = iconButton(LIBRARY_VIEW_GLYPHS[option.id], option.label, () => {
      chooseLibraryView(option.id);
      renderHomeNow();
    }, {
      title: `The library as ${option.label.toLowerCase()}`,
      pressed: currentLibraryView() === option.id,
    });
    node.classList.add('lb-view');
    views.append(node);
  }

  return el('div', { class: 'lb-toolbar' }, el('span', { class: 'lb-search' }, search), views);
}

/** Home is redrawn from the current answer, wherever the library asked for it. */
function renderHomeNow(): void {
  if (shell !== null && view === 'home') renderHome(shell.content);
}

/** The library's area redraw alone — the header and the presence card stay as they are. */
function refreshLibrary(): void {
  const area = document.querySelector('.home');
  if (area === null) return;
  const next = libraryBody();
  area.replaceChildren(...next.childNodes);
}

/** The library's body for the view this machine chose (RF-79): cards, list, org chart or blocks. */
function libraryBody(): HTMLElement {
  const chosen = currentLibraryView();
  const input = libraryInput();
  if (chosen === 'list') return libraryList(input);
  if (chosen === 'cards') return libraryCards(input);
  // The two organization views read the roster too; they fill in when the answers arrive.
  const area = chosen === 'org' ? el('div', { class: 'lb-org' }) : el('div', { class: 'lb-blocks' });
  void fillOrganizationViews(area, chosen);
  return area;
}

/** The roster and the roles of the two organization views, fetched once per draw. */
async function fillOrganizationViews(area: HTMLElement, chosen: LibraryView): Promise<void> {
  let roles: Role[] = [];
  let people: RosterPerson[] = [];
  try {
    [roles, people] = await Promise.all([call('roles.list'), call('roster.list')]);
  } catch {
    /* a guild that cannot answer leaves the two views their empty drawing */
  }
  const input = libraryInput(roles, people);
  const redraw = chosen === 'org' ? orgChartArea(input) : blocksArea(input);
  area.replaceChildren(...redraw.childNodes);
}

/** RF-79's cards: the categories as collapsible groups, the guild's favorites kept inside them. */
function libraryCards(input: LibraryInput): HTMLElement {
  const groups = el('div', { class: 'lb-groups' });
  const closed = libraryCollapsed();
  libraryGroups(input, libraryQuery).forEach((group, index) => {
    const label = group.category ?? (group.kind === 'personal' ? 'Your tools' : 'Other tools');
    const cards = el('div', { class: 'lb-group-cards' });
    group.cards.forEach((card, at) => {
      const node = toolCard(card.entry);
      // RF-79: the first group's first tools take the width — the featured row.
      if (index === 0 && at < 2) node.dataset.featured = 'true';
      cards.append(node);
    });
    const key = group.kind === 'personal' ? '\u0000personal' : group.category ?? '\u0000other';
    const section = el(
      'section',
      { class: 'lb-group', aria: { label } },
      el(
        'button',
        {
          class: 'lb-group-head',
          title: `Collapse ${label}`,
          aria: { expanded: closed.has(key) ? 'false' : 'true' },
        },
        el('span', { class: 'lb-caret', aria: { hidden: 'true' } }, '▸'),
        el('span', { class: 'lb-group-title' }, label),
        el('span', { class: 'lb-group-count', aria: { hidden: 'true' } }, String(group.cards.length)),
      ),
      cards,
    );
    section.dataset.collapsed = closed.has(key) ? 'true' : 'false';
    section.querySelector('.lb-group-head')?.addEventListener('click', () => {
      const now = section.dataset.collapsed !== 'true';
      section.dataset.collapsed = now ? 'true' : 'false';
      const head = section.querySelector('.lb-group-head');
      head?.setAttribute('aria-expanded', now ? 'false' : 'true');
      const set = libraryCollapsed();
      if (now) set.add(key);
      else set.delete(key);
      storeLibraryCollapsed(set);
    });
    groups.append(section);
  });
  if (groups.childElementCount === 0) {
    return el('div', { class: 'lb-empty' }, el('p', { class: 'muted' }, 'Nothing matches.'));
  }
  return groups;
}

/** RF-79's list: one compact row per tool — the title, the host, the tags, the org account, the open. */
function libraryList(input: LibraryInput): HTMLElement {
  const rows = el('div', { class: 'lb-list' });
  for (const group of libraryGroups(input, libraryQuery)) {
    for (const card of group.cards) {
      const open = iconButton('↗', 'Open', () => openTool(card.entry.id), {
        kind: 'primary',
        title: `Open ${card.entry.title}`,
      });
      const row = el(
        'div',
        {
          class: 'lb-list-row',
          role: 'button',
          attrs: { tabindex: '0' },
          aria: { label: `Open ${card.entry.title}` },
        },
        glyph(card.entry.title, entryIcon(card.entry, tools.find((tool) => tool.id === card.entry.id) ?? null)),
        el('span', { class: 'lb-card-title' }, card.entry.title),
        el('span', { class: 'lb-card-host muted' }, hostOfLibrary(card.entry.url)),
        el(
          'span',
          { class: 'lb-card-tags' },
          ...card.tags.map((tag) => el('span', { class: 'lb-tag' }, tag)),
        ),
        card.orgAccount === null
          ? null
          : el('span', { class: 'lb-card-account muted' }, card.orgAccount),
        card.favorite ? el('span', { class: 'lb-card-star', aria: { hidden: 'true' } }, '★') : null,
        open,
      );
      row.addEventListener('click', () => openTool(card.entry.id));
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openTool(card.entry.id);
      });
      rows.append(row);
    }
  }
  if (rows.childElementCount === 0) {
    return el('div', { class: 'lb-empty' }, el('p', { class: 'muted' }, 'Nothing matches.'));
  }
  return rows;
}

/** The host of an address as the library prints it (`shared/library.ts`'s own reader). */
function hostOfLibrary(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** RF-79's org chart: the guild's roles as nodes with their people, and who reaches what. */
function orgChartArea(input: LibraryInput): HTMLElement {
  const area = el('div', { class: 'lb-org' });
  for (const node of orgChart(input, libraryQuery)) {
    const people = el('div', { class: 'lb-org-people' });
    for (const person of node.people) {
      const chip = el('span', { class: 'lb-person' }, person.name);
      chip.dataset.admin = person.admin ? 'true' : 'false';
      people.append(chip);
    }
    const reach = el('div', { class: 'lb-org-categories' });
    for (const name of node.categories) {
      reach.append(el('span', { class: 'lb-reach' }, name === '' ? 'Other tools' : name));
    }
    area.append(
      el(
        'div',
        { class: 'lb-org-node' },
        el('h3', { class: 'lb-org-role' }, node.role?.name ?? 'No role'),
        people,
        reach,
      ),
    );
  }
  if (area.childElementCount === 0) {
    return el('div', { class: 'lb-empty' }, el('p', { class: 'muted' }, 'Nothing matches.'));
  }
  return area;
}

/** RF-79's isometric blocks: a real projection — the rotated stage, the stacks, who stands where. */
function blocksArea(input: LibraryInput): HTMLElement {
  const stage = el('div', { class: 'lb-stage' });
  for (const stack of blockStacks(input, libraryQuery)) {
    const plate = el(
      'div',
      {
        class: 'lb-plate',
        title: stack.category ?? (stack.kind === 'personal' ? 'Your tools' : 'Other tools'),
      },
      el('div', { class: 'lb-plate-title' }, stack.category ?? (stack.kind === 'personal' ? 'Your tools' : 'Other tools')),
      el('div', { class: 'lb-plate-tools' }),
    );
    const height = Math.min(6, stack.cards.length);
    for (const style of [plate]) {
      style.style.setProperty('--lb-height', String(height));
    }
    const standing = el('div', { class: 'lb-standing' });
    standing.style.setProperty('--lb-height', String(height));
    const toolsNode = plate.querySelector('.lb-plate-tools') as HTMLElement;
    for (const card of stack.cards) {
      const chip = el(
        'span',
        { class: 'lb-plate-tool', role: 'button', attrs: { tabindex: '0' } },
        card.entry.title,
      );
      chip.addEventListener('click', () => openTool(card.entry.id));
      chip.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openTool(card.entry.id);
      });
      toolsNode.append(chip);
    }
    for (const person of stack.people) {
      const chip = el('span', { class: 'lb-person' }, person.name);
      chip.dataset.admin = person.admin ? 'true' : 'false';
      standing.append(chip);
    }
    const tile = el('div', { class: 'lb-stack' });
    tile.style.setProperty('--lb-height', String(height));
    tile.append(plate, standing);
    stage.append(tile);
  }
  if (stage.childElementCount === 0) {
    return el('div', { class: 'lb-empty' }, el('p', { class: 'muted' }, 'Nothing matches.'));
  }
  return el('div', { class: 'lb-blocks' }, stage);
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
      class: on ? 'favorite favorite-on icon-button' : 'favorite icon-button',
      title: on ? `Remove ${entry.title} from favorites` : `Add ${entry.title} to favorites`,
      aria: { label: on ? `Remove ${entry.title} from favorites` : `Add ${entry.title} to favorites`, pressed: on ? 'true' : 'false' },
      attrs: { type: 'button' },
      data: { icon: on ? '★' : '☆' },
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
function openPersonalToolDialog(intoFolder: string | null = null): void {
  if (session === null || !session.unlocked || shell === null) return;
  if (document.getElementById(PERSONAL_DIALOG_ID) !== null) return;

  const title = input('title', { placeholder: 'Team notes', required: true });
  const url = input('url', { type: 'url', placeholder: 'https://notes.example.com', required: true });
  // The sidebar's quick add: the new tool can land straight in one of the person's folders.
  const known = layout === null ? [] : folders(layout);
  const folderSelect =
    known.length === 0
      ? null
      : el(
          'select',
          { class: 'input', attrs: { name: 'folder' } },
          el('option', { attrs: { value: '' } }, 'No folder'),
          ...known.map((folder) => el('option', { attrs: { value: folder.id } }, folder.name)),
        );
  if (folderSelect !== null && intoFolder !== null) folderSelect.value = intoFolder;
  // A paste of an address alone fills the title from its host, so two keystrokes add a tool.
  url.addEventListener('change', () => {
    if (title.value.trim() !== '') return;
    try {
      const host = new URL(url.value.trim()).hostname.replace(/^www\./, '');
      const name = host.split('.')[0] ?? '';
      if (name !== '') title.value = name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      // Not an address yet: the person types the title.
    }
  });
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
      const target = folderSelect === null ? '' : folderSelect.value;
      if (target !== '' && layout !== null) {
        void commitLayout(moveTool(layout, saved.id, { into: target }));
      }
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
      guildConnected()
        ? 'Only you see this tool. It syncs across your guild devices. Camera and microphone require your permission.'
        : 'Only you see this tool, on this device. Camera and microphone require your permission.',
    ),
    field('Address', url),
    field('Title', title),
    folderSelect === null ? null : field('Folder', folderSelect),
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
  url.focus();
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
    ),
    // canonico §22: the warning the owner asked for, beside the tool in the window that opens it.
    isForeign(entry)
      ? el(
          'p',
          { class: 'tool-warning', role: 'status' },
          'Personal tool · Not managed by your guild. Camera and microphone require your permission.',
        )
      : null,
    // Atrius: the state is glyph + word; `data-state` picks the glyph and its colour (style.css).
    el('p', { class: 'tool-state', title: stateText(tool), data: { state: stateKey(tool) } }, stateText(tool)),
  );

  const login = tool === null || tool.login === null ? null : LOGIN_TEXT[tool.login];
  if (login !== null && tool !== null && tool.login !== null) {
    card.append(el('p', { class: 'tool-login muted', data: { login: tool.login } }, login));
  }

  // RF-77: the tags the guild gave the tool — the library's search reads them, so the card wears
  // them. RF-78: the org's default account, a plain label (the password stays in the vault).
  const tags = tagsOf(entry);
  if (tags.length > 0 || orgAccountOf(entry) !== null) {
    card.append(
      el(
        'div',
        { class: 'tool-library' },
        tags.length > 0
          ? el(
              'div',
              { class: 'lb-card-tags' },
              ...tags.map((tag) => el('span', { class: 'lb-tag' }, tag)),
            )
          : null,
        orgAccountOf(entry) === null
          ? null
          : el(
              'p',
              { class: 'lb-card-account muted', title: 'The account the whole guild uses for this tool' },
              'Guild account: ',
              el('b', {}, orgAccountOf(entry) as string),
            ),
      ),
    );
  }

  // The row's acts are icons in fixed slots, the same six in every row — open or bring to front,
  // close, try again, views, remove, favorite — and a slot that does not apply stays empty, so each
  // act sits in the same column down the whole list.
  const views = entry.views;
  const actions = el(
    'div',
    { class: 'tool-actions', role: 'group', aria: { label: `${entry.title} actions` } },
    iconButton(open ? '⧉' : '↗', open ? 'Bring to front' : 'Open', () => openTool(entry.id), {
      kind: 'primary',
      title: open ? `Bring ${entry.title} to front` : `Open ${entry.title}`,
    }),
    open
      ? iconButton('■', 'Close', () => {
          void runTools(() => call('tools.close', { id: entry.id }));
        }, { title: `Close ${entry.title}` })
      : iconSlot(),
    tool !== null && tool.error !== null
      ? iconButton('↻', 'Try again', () => {
          void runTools(() => call('tools.reload', { id: entry.id }));
        }, { title: `Try ${entry.title} again` })
      : iconSlot(),
    views.length > 0 ? viewsButton(entry) : iconSlot(),
    // B7: only the person's own tool is theirs to remove.
    isForeign(entry)
      ? iconButton('×', 'Remove', () => removePersonalTool(entry.id), { kind: 'danger', title: `Remove ${entry.title}` })
      : iconSlot(),
    favoriteToggle(entry),
  );
  card.append(actions);
  return card;
}

/**
 * The views (deep links) of a tool: one icon that opens them as a menu, so a tool with several views
 * takes one slot like every other row.
 */
function viewsButton(entry: Entry): HTMLButtonElement {
  const node = iconButton(
    '☰',
    'Views',
    () => {
      openMenu(
        node,
        entry.views.map((entryView, index) => ({
          label: entryView.label,
          glyph: '↗',
          run: () => void runTools(() => call('tools.openView', { toolId: entry.id, index })),
        })),
        `${entry.title} views`,
      );
    },
    { title: `${entry.title} views (${entry.views.length})`, popup: true },
  );
  return node;
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
  let installed: boolean;
  try {
    installed = await call('nod.installUpdate');
  } catch (e) {
    showBanner(e);
    return;
  }
  // `false` is the backend refusing the install (bad hash, failed swap, rollback): the bundle on
  // disk is untouched, so the banner must not claim success over it.
  if (!installed) {
    message(target.banner, 'error', 'The update could not be installed');
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
});

/**
 * E03 (RF-49): the tab the backend shows on the slot — what the strip's toolbar, the palette rows
 * and the shortcuts act on. `null` in Windows mode, and while every tab is detached.
 */
function tabOnPanel(): TabState | null {
  return tabsState === null ? null : activeTab(tabsState);
}

/**
 * E03 (RF-49/RF-52): one `tools.state`/`tools`/`tabs.*` answer lands here. The center panel has two
 * faces, Home and the tab view, and Windows mode (the Wayland case) has only the first: a tab view
 * left behind by the last tab closing would be a strip with nothing under it.
 */
function applyTools(state: ToolsState): void {
  tabsState = state;
  tools = state.tools;
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
      'Opens an unsaved tab. No autofill or access to your Nod account.',
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
  // A push that lands while these reads are in flight is the newer answer: the backend sends a whole
  // `ToolsState` (and the catalog) on every change, and a read that left before it can only hand back
  // the state of a moment ago. `Promise.all` makes that easy to hit — the first snapshot of a member
  // joining the guild lands between two of the five answers — and applying the read's empty list over
  // that push left the new member's sidebar empty with no later push to correct it (the reader is
  // here, so the reads are the only writers left). A push took over those fields instead.
  const toolsAt = toolsRevision;
  const catalogAt = catalogRevision;
  try {
    const [answer, entries, hostState, ids, tiles, arranged] = await Promise.all([
      call('tools.state'),
      call('catalog.list'),
      // SP05 §3: locked windows cannot read it, and the sidebar needs it right after the unlock.
      call('host.state'),
      // B7: the favorites the toggle draws from.
      call('favorites.list'),
      // 0.5.0 (RF-60): the tiles of the entry screen, read while locked and kept: the sidebar's top
      // mark is the guild's icon, and the next lock re-reads them anyway.
      call('session.profiles'),
      // The person's own sidebar, read with the catalog it orders.
      call('sidebar.layout'),
    ]);
    state = answer;
    if (catalogRevision === catalogAt) {
      catalog = entries;
      favorites = ids;
      layout = arranged;
    }
    host = hostState;
    profiles = tiles;
  } catch (e) {
    showBanner(e);
    return;
  }
  // E03 (RF-52): Windows mode (Wayland) has no slot of the page's own — the backend is told once,
  // here, so a stale slot is not followed by a window of a mode that has none.
  if (state.mode === 'windows') reportSlot(null);
  // E03 (RF-49/RF-50): the page's whole answer — the tabs, the active one, the mode — and the panel
  // shows its active tab at once: the tabs a docked session had open are restored and docked again.
  // A `tools` push that arrived during the reads already carries that whole answer (`tabsState`), so
  // the pushed one is what the panel follows.
  if (toolsRevision === toolsAt) {
    applyToolsState(state);
  } else if (tabsState !== null) {
    showActiveTab(tabsState);
    refreshChrome();
  } else {
    applyToolsState(state);
  }
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
    // The sidebar's own acts (new folder, reset), one row away from the keyboard (RNF-07).
    sidebar: railMenu().flatMap((item) =>
      typeof item === 'object' && 'run' in item && item.label !== 'Add tool…'
        ? [{ label: `Sidebar: ${item.label}`, run: () => window.setTimeout(item.run, 0) }]
        : [],
    ),
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
    // 2026-11-19 style toggle: the window wears the stored skin before anything is drawn, so even
    // the locked entry screen opens in it (src/appearance.ts owns the how).
    applyAppearance(appInfo.appearance);
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
    // The lock is newer than any read a shell left in flight: it must not be undone by that read.
    toolsRevision += 1;
    catalogRevision += 1;
    // E03: the tab view went with the shell, and a locked window has no tabs.
    tabsState = null;
    catalog = [];
    favorites = [];
    layout = null;
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
  // the view it is on — the `tab` push below is the one that says "show this tab".
  toolsRevision += 1;
  applyTools(next);
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
  catalogRevision += 1;
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
    const [entries, ids, arranged] = await Promise.all([
      call('catalog.list'),
      call('favorites.list'),
      call('sidebar.layout'),
    ]);
    catalog = entries;
    favorites = ids;
    layout = arranged;
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
 * E03 (§7): ⌘T new tab, ⌘W close tab, ⌃Tab/⌃⇧Tab next and previous, ⌘⇧D detach or dock,
 * ⌘D save the tab to the sidebar. True when the event was one of them.
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
