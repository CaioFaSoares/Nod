// The command palette (⌘K): an overlay inside the main window that searches tools, their views and
// the app actions (docs/arquitetura.md §5, canonico §7).
// Everything it needs arrives in `ctx` from `src/app.ts`: the palette never reads the session, the
// tools or the catalog on its own. It talks to the backend only through `./api`.
import { call, errorMessage } from './api';
import { el, message } from './ui';
import { categoryOf } from '../shared/catalog';
import type { TabsApi } from './tabs';
import type { Entry, Id, TabState, ToolStatus, VaultItem } from '../shared/types';
import type { SettingsTab } from './settings';

const OVERLAY_ID = 'palette-overlay';
const LIST_ID = 'palette-list';

interface Item {
  label: string;
  /** match key: lowercase, without accents */
  key: string;
  /** RF-62: the secondary text of the row — the category of a tool, when it has one. */
  hint?: string;
  run: () => unknown;
}

interface SettingsTabItem {
  id: SettingsTab;
  label: string;
  /** admin-only tabs: everyone gets Account and Vault, the rest is the admin's */
  admin: boolean;
}

const SETTINGS_TABS: SettingsTabItem[] = [
  { id: 'account', label: 'Account', admin: false },
  { id: 'hosts', label: 'Hosts', admin: false },
  { id: 'vault', label: 'Vault', admin: false },
  { id: 'tools', label: 'Tools', admin: true },
  { id: 'roles', label: 'Roles', admin: true },
  { id: 'people', label: 'People', admin: true },
  { id: 'activity', label: 'Activity', admin: true },
  { id: 'catalog', label: 'Catalog', admin: true },
];

/** Lowercase and without accents: the filter ignores case and diacritics. */
function matchKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** The query matches anywhere, as long as its characters appear in order. */
function isSubsequence(target: string, query: string): boolean {
  let from = 0;
  for (const character of query) {
    const found = target.indexOf(character, from);
    if (found < 0) return false;
    from = found + character.length;
  }
  return true;
}

/** Prefix matches come first; the rest keeps the order of the list. */
function filter(items: Item[], query: string): Item[] {
  const needle = matchKey(query.trim());
  if (needle === '') return [...items];
  const matching = items.filter((item) => isSubsequence(item.key, needle));
  return [
    ...matching.filter((item) => item.key.startsWith(needle)),
    ...matching.filter((item) => !item.key.startsWith(needle)),
  ];
}

/**
 * E03: what the palette may do to the tabs of docked mode — the strip's own actions (`TabsApi`,
 * which is where each one is documented), plus the list they act on: `active` (the tab on the slot,
 * or null while the panel has none) and `open` (every tab, in strip order). `null` in Windows mode,
 * where the page has no tabs of its own (RF-52).
 */
export type PaletteTabs = TabsApi & {
  active: TabState | null;
  open: TabState[];
  /**
   * 0.6.0b: the default credential of the active embedded tab, when the page knows the vault —
   * null while the metadata has not been read or the tool has none.
   */
  credential: VaultItem | null;
};

export function openPalette(ctx: {
  tools: ToolStatus[];
  entries: Entry[];
  isAdmin: boolean;
  go: (target: 'home' | SettingsTab) => void;
  lock: () => void;
  /** B7: "Add personal tool" — the dialog of `src/app.ts`, opened from the palette. */
  addPersonalTool: () => void;
  /** RF-58: "Who's online" — Home's card; null while there is no guild to show. */
  showOnline: (() => void) | null;
  /** K4: "Vault inbox" — Settings → Vault, scrolled to the shares waiting; null without a guild. */
  openInbox: (() => void) | null;
  /** E03: "Open tabs" — the tab view of docked mode, from the page's own state; null in Windows
   * mode and while the strip is empty. */
  openTabs: (() => void) | null;
  /** E03: a tool opens through the app, so a docked tab lands on the center panel (RF-49). A
   * failure is the window's banner, the same one the sidebar and Home use. */
  openTool: (id: Id) => void;
  /** E03: a view opens through the app for the same reason. */
  openView: (toolId: Id, index: number) => void;
  /** E03 (RF-66): "Open link…" — the dialog of `src/app.ts`; it works in both modes. */
  openLink: () => void;
  /** E03: the tab rows and actions of docked mode. */
  tabs: PaletteTabs | null;
}): void {
  // One palette at a time: the global shortcut and the push `palette` can both ask for it.
  if (document.getElementById(OVERLAY_ID) !== null) return;

  const opener = document.activeElement;
  const previous = opener instanceof HTMLElement ? opener : null;

  const items: Item[] = [];
  // RF-62: a tool row carries its category as the secondary text of the list.
  const categoryOfId = new Map<Id, string | null>();
  for (const entry of ctx.entries) categoryOfId.set(entry.id, categoryOf(entry));
  for (const tool of ctx.tools) {
    const category = categoryOfId.get(tool.id) ?? null;
    items.push({
      label: tool.title,
      key: matchKey(tool.title),
      ...(category === null ? {} : { hint: category }),
      // E03: through the app, so a docked tab takes the center panel (RF-49).
      run: () => ctx.openTool(tool.id),
    });
  }
  for (const entry of ctx.entries) {
    entry.views.forEach((entryView, index) => {
      const label = `${entry.title} › ${entryView.label}`;
      items.push({
        label,
        key: matchKey(label),
        run: () => ctx.openView(entry.id, index),
      });
    });
  }
  // E03 (RF-50/RF-51/RF-67): the tabs of docked mode. Every open tab is one row away — the
  // keyboard's own way of switching between them — the four actions act on the active tab, and a
  // detached tab carries its own way back (the backend's active tab is a docked one, so it is null
  // while every tab is detached).
  const tabs = ctx.tabs;
  if (tabs !== null) {
    for (const tab of tabs.open) {
      const label = `Tab: ${tab.title}`;
      items.push({ label, key: matchKey(label), run: () => tabs.activate(tab.id) });
      // RF-51: a detached tab is docked back from here too — the strip may not be on screen (Home,
      // Settings), and with every tab detached the backend has no active tab for the row below.
      if (!tab.docked && !tab.embedded) {
        const dock = `Dock tab: ${tab.title}`;
        items.push({ label: dock, key: matchKey(dock), run: () => tabs.dock(tab.id) });
      }
    }
    const active = tabs.active;
    if (active !== null) {
      const toolId = active.toolId;
      // An ad-hoc tab has no tool of its own to open another tab of (RF-66).
      if (toolId !== null) {
        const newTab = 'New tab';
        items.push({ label: newTab, key: matchKey(newTab), run: () => tabs.newTab(toolId) });
        // RF-69: the same toggle the toolbar shows, for the tool of the active tab.
        const mode = active.embedded ? 'Open as window' : 'Show inside Nod';
        items.push({
          label: mode,
          key: matchKey(mode),
          run: () => tabs.setEmbedded(toolId, !active.embedded),
        });
        // RF-70: the same report the embedded toolbar offers — the login did not survive the
        // iframe, so the tool stops embedding and its tabs go back to windows.
        if (active.embedded) {
          const login = "Login won't stay? Open as window";
          items.push({
            label: login,
            key: matchKey(login),
            run: () => tabs.reportLoginFails(toolId),
          });
        }
      }
      const close = 'Close tab';
      items.push({ label: close, key: matchKey(close), run: () => tabs.close(active.id) });
      // 0.6.0b (RF-69): the Sign in control of an embedded tab — no script reaches the iframe, so
      // the login is copied to the person. Same two actions the toolbar offers.
      if (active.embedded && tabs.credential !== null) {
        const credential = tabs.credential;
        const username = 'Copy username';
        items.push({
          label: username,
          key: matchKey(username),
          run: () => tabs.copyUsername(credential),
        });
        const password = 'Copy password';
        items.push({
          label: password,
          key: matchKey(password),
          run: () => tabs.copyPassword(credential),
        });
      }
      // RF-69: an embedded tab has no window to detach and no dock to come back from.
      if (!active.embedded) {
        const toggle = active.docked ? 'Detach tab' : 'Dock tab';
        items.push({
          label: toggle,
          key: matchKey(toggle),
          run: () => {
            if (active.docked) tabs.detach(active.id);
            else tabs.dock(active.id);
          },
        });
      }
      const save = 'Save tab to sidebar';
      items.push({ label: save, key: matchKey(save), run: () => tabs.save(active.id) });
    }
  }
  // E03: the strip of docked mode, one row away (the same action as the sidebar's button).
  const openTabs = ctx.openTabs;
  if (openTabs !== null) {
    const label = 'Open tabs';
    items.push({ label, key: matchKey(label), run: () => openTabs() });
  }
  // E03 (RF-66): an address by hand — the same dialog the toolbar and ⌘L open, in either mode.
  const openLink = 'Open link…';
  items.push({ label: openLink, key: matchKey(openLink), run: () => ctx.openLink() });
  const home = 'Home';
  items.push({ label: home, key: matchKey(home), run: () => ctx.go('home') });
  // B7/SP05 §4: the dialog of a personal tool, reachable from the keyboard like every action.
  const addPersonal = 'Add personal tool';
  items.push({ label: addPersonal, key: matchKey(addPersonal), run: () => ctx.addPersonalTool() });
  const showOnline = ctx.showOnline;
  if (showOnline !== null) {
    const online = "Who's online";
    items.push({ label: online, key: matchKey(online), run: () => showOnline() });
  }
  // K4: the shares waiting for an answer, one keystroke away.
  const openInbox = ctx.openInbox;
  if (openInbox !== null) {
    const inbox = 'Vault inbox';
    items.push({ label: inbox, key: matchKey(inbox), run: () => openInbox() });
  }
  for (const tab of SETTINGS_TABS) {
    if (tab.admin && !ctx.isAdmin) continue;
    const label = `Settings › ${tab.label}`;
    items.push({ label, key: matchKey(label), run: () => ctx.go(tab.id) });
  }
  const lock = 'Lock';
  items.push({ label: lock, key: matchKey(lock), run: () => ctx.lock() });
  const quit = 'Quit';
  items.push({ label: quit, key: matchKey(quit), run: () => call('nod.quit') });

  const search = el('input', {
    class: 'input palette-input',
    attrs: {
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': LIST_ID,
      'aria-activedescendant': '',
      'aria-autocomplete': 'list',
      'aria-label': 'Search tools, views and actions',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: 'Search tools, views and actions…',
    },
  });
  const errorBox = el('div', { class: 'palette-message' });
  const list = el('ul', { id: LIST_ID, class: 'palette-list', role: 'listbox', aria: { label: 'Results' } });
  const empty = el('p', { class: 'empty' }, 'Nothing found.');
  const panel = el(
    'div',
    { class: 'palette', role: 'dialog', aria: { modal: 'true', label: 'Command palette' } },
    search,
    errorBox,
    list,
    empty,
  );
  const overlay = el('div', { id: OVERLAY_ID, class: 'overlay' }, panel);

  let visible = items;
  let selected = 0;

  function close(): void {
    document.removeEventListener('focusin', keepInside);
    search.removeEventListener('keydown', onKey);
    overlay.remove();
    if (previous !== null && previous.isConnected) previous.focus();
  }

  function renderList(): void {
    if (visible.length === 0) selected = 0;
    else if (selected < 0) selected = 0;
    else if (selected >= visible.length) selected = visible.length - 1;

    list.replaceChildren();
    visible.forEach((item, index) => {
      const active = index === selected;
      const option = el(
        'li',
        {
          id: `palette-item-${index}`,
          class: active ? 'palette-item palette-item-active' : 'palette-item',
          role: 'option',
          aria: { selected: active ? 'true' : 'false' },
        },
        el('span', { class: 'palette-item-label' }, item.label),
        item.hint === undefined ? null : el('span', { class: 'palette-item-hint' }, item.hint),
      );
      option.addEventListener('click', () => {
        void runItem(item);
      });
      list.append(option);
    });

    empty.hidden = visible.length > 0;
    search.setAttribute('aria-expanded', visible.length > 0 ? 'true' : 'false');
    search.setAttribute('aria-activedescendant', visible.length > 0 ? `palette-item-${selected}` : '');
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  function move(step: number): void {
    if (visible.length === 0) return;
    selected = Math.min(Math.max(selected + step, 0), visible.length - 1);
    renderList();
  }

  /** Acting on an item closes the palette; a failed call keeps it open with the message. */
  async function runItem(item: Item): Promise<void> {
    search.disabled = true;
    try {
      await item.run();
    } catch (e) {
      search.disabled = false;
      search.focus();
      message(errorBox, 'error', errorMessage(e));
      return;
    }
    close();
  }

  function keepInside(event: FocusEvent): void {
    const target = event.target;
    if (target instanceof Node && !overlay.contains(target)) search.focus();
  }

  function onKey(event: KeyboardEvent): void {
    // While the palette is open it owns the keyboard, so ⌘/Ctrl combinations stay here.
    if (event.metaKey || event.ctrlKey) {
      event.stopPropagation();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = visible[selected];
      if (item !== undefined) void runItem(item);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    // The palette is operated by the keyboard: Tab stays on the search field.
    if (event.key === 'Tab') {
      event.preventDefault();
      search.focus();
    }
  }

  search.addEventListener('input', () => {
    visible = filter(items, search.value);
    selected = 0;
    renderList();
  });
  search.addEventListener('keydown', onKey);
  document.addEventListener('focusin', keepInside);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });

  document.body.append(overlay);
  search.focus();
  renderList();
}
