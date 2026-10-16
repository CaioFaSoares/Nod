// The command palette (⌘K): an overlay inside the main window that searches tools, their views and
// the app actions (docs/arquitetura.md §5, canonico §7).
// Everything it needs arrives in `ctx` from `src/app.ts`: the palette never reads the session, the
// tools or the catalog on its own. It talks to the backend only through `./api`.
import { call, errorMessage } from './api';
import { el, message } from './ui';
import type { Entry, ToolStatus } from '../shared/types';
import type { SettingsTab } from './settings';

const OVERLAY_ID = 'palette-overlay';
const LIST_ID = 'palette-list';

interface Item {
  label: string;
  /** match key: lowercase, without accents */
  key: string;
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

export function openPalette(ctx: {
  tools: ToolStatus[];
  entries: Entry[];
  isAdmin: boolean;
  go: (target: 'home' | SettingsTab) => void;
  lock: () => void;
}): void {
  // One palette at a time: the global shortcut and the push `palette` can both ask for it.
  if (document.getElementById(OVERLAY_ID) !== null) return;

  const opener = document.activeElement;
  const previous = opener instanceof HTMLElement ? opener : null;

  const items: Item[] = [];
  for (const tool of ctx.tools) {
    items.push({ label: tool.title, key: matchKey(tool.title), run: () => call('tools.open', { id: tool.id }) });
  }
  for (const entry of ctx.entries) {
    entry.views.forEach((entryView, index) => {
      const label = `${entry.title} › ${entryView.label}`;
      items.push({
        label,
        key: matchKey(label),
        run: () => call('tools.openView', { toolId: entry.id, index }),
      });
    });
  }
  const home = 'Home';
  items.push({ label: home, key: matchKey(home), run: () => ctx.go('home') });
  for (const tab of SETTINGS_TABS) {
    if (tab.admin && !ctx.isAdmin) continue;
    const label = `Settings › ${tab.label}`;
    items.push({ label, key: matchKey(label), run: () => ctx.go(tab.id) });
  }
  const lock = 'Lock';
  items.push({ label: lock, key: matchKey(lock), run: () => ctx.lock() });
  const quit = 'Quit';
  items.push({ label: quit, key: matchKey(quit), run: () => call('bond.quit') });

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
        item.label,
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
