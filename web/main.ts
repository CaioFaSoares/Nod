// The portal's page (E04 M1, RF-73–RF-79): sign in with the guild account, see the catalog
// granted to you, open each tool in a new browser tab. The models and the styles are the ones the
// app's own Home uses (`shared/library.ts`, `shared/library.css`), so the two surfaces cannot
// drift about what a group is or how the isometric stage projects.
//
// RF-75: the password never travels. The page asks the host for the salt, derives `authKey` with
// the same `shared/auth.ts` the app runs, and sends only that; the session the host answers is an
// `HttpOnly` cookie this script cannot read.

import { deriveKeys } from '../shared/auth';
import { toBase64url } from '../shared/encoding';
import {
  hostOf,
  libraryGroups,
  libraryViewOf,
  blockStacks,
  orgChart,
  LIBRARY_VIEWS,
  type LibraryInput,
  type LibraryView,
} from '../shared/library';
import type { Entry, Id } from '../shared/types';

/** The view choice and the collapsed categories are the machine's own, never a guild call. */
const VIEW_KEY = 'nod-web-library-view';
const COLLAPSED_KEY = 'nod-web-library-collapsed';

interface Me {
  guild: string;
  name: string;
  email: string;
  admin: boolean;
}

interface Catalog extends LibraryInput {
  orgTools: Entry[];
  personalTools: Entry[];
  favorites: Id[];
  roles: LibraryInput['roles'];
  people: LibraryInput['people'];
}

const root = document.getElementById('root') as HTMLElement;

/** One element, children by text node — the page never builds HTML from a string. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    class?: string;
    text?: string;
    href?: string;
    target?: string;
    rel?: string;
    title?: string;
    id?: string;
    role?: string;
    ariaLabel?: string;
    ariaPressed?: string;
  } = {},
  ...children: (Node | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class !== undefined) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.href !== undefined) node.setAttribute('href', options.href);
  if (options.target !== undefined) node.setAttribute('target', options.target);
  if (options.rel !== undefined) node.setAttribute('rel', options.rel);
  if (options.title !== undefined) node.setAttribute('title', options.title);
  if (options.id !== undefined) node.id = options.id;
  if (options.role !== undefined) node.setAttribute('role', options.role);
  if (options.ariaLabel !== undefined) node.setAttribute('aria-label', options.ariaLabel);
  if (options.ariaPressed !== undefined) node.setAttribute('aria-pressed', options.ariaPressed);
  node.append(...children.filter((child): child is Node => child !== null && child !== undefined));
  return node;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T | null }> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
  });
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

/** The initials a tile wears while the guild gave it no icon. */
function initials(title: string): string {
  return (
    title
      .split(/\s+/)
      .filter((word) => word !== '')
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || '·'
  );
}

/** The card both the cards view and the list draw, as one anchor that opens a new tab (RF-73). */
function cardAnchor(entry: Entry, featured: boolean): HTMLAnchorElement {
  const glyph = h('span', { class: 'lb-card-glyph' });
  if (entry.icon !== null && entry.icon !== '') {
    const image = document.createElement('img');
    image.src = entry.icon;
    image.alt = '';
    glyph.append(image);
  } else {
    glyph.textContent = initials(entry.title);
  }
  const node = h(
    'a',
    {
      class: 'lb-card',
      href: entry.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: `${entry.title} — ${hostOf(entry.url)} (opens in a new tab)`,
    },
    h(
      'div',
      { class: 'lb-card-top' },
      glyph,
      h(
        'div',
        { class: 'lb-card-titles' },
        h('div', { class: 'lb-card-title', text: entry.title }),
        h('div', { class: 'lb-card-host', text: hostOf(entry.url) }),
      ),
    ),
  );
  if (featured) node.dataset.featured = 'true';
  return node;
}

function view(): LibraryView {
  return libraryViewOf(window.localStorage.getItem(VIEW_KEY));
}

function collapsed(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function storeCollapsed(set: Set<string>): void {
  window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
}

/** The four views, each fed by the same models (`shared/library.ts`). */
function drawViews(input: Catalog, query: string, chosen: LibraryView): HTMLElement {
  if (chosen === 'org') {
    const area = h('div', { class: 'lb-org' });
    for (const node of orgChart(input, query)) {
      const people = h('div', { class: 'lb-org-people' });
      for (const person of node.people) {
        const chip = h('span', { class: 'lb-person', text: person.name });
        chip.dataset.admin = person.admin ? 'true' : 'false';
        people.append(chip);
      }
      const categories = h('div', { class: 'lb-org-categories' });
      for (const name of node.categories) {
        categories.append(h('span', { class: 'lb-reach', text: name === '' ? 'Other tools' : name }));
      }
      area.append(
        h('div', { class: 'lb-org-node' }, h('h3', { class: 'lb-org-role', text: node.role?.name ?? 'No role' }), people, categories),
      );
    }
    return area.childElementCount > 0 ? area : h('p', { class: 'lb-empty', text: 'Nothing matches.' });
  }

  if (chosen === 'blocks') {
    const stage = h('div', { class: 'lb-stage' });
    for (const stack of blockStacks(input, query)) {
      const plate = h(
        'div',
        { class: 'lb-plate', title: stack.category ?? 'Your tools' },
        h('div', { class: 'lb-plate-title', text: stack.category ?? (stack.kind === 'personal' ? 'Your tools' : 'Other tools') }),
        h('div', { class: 'lb-plate-tools' }),
      );
      const tools = plate.querySelector('.lb-plate-tools') as HTMLElement;
      for (const card of stack.cards) {
        tools.append(h('span', { class: 'lb-plate-tool', text: card.entry.title }));
      }
      const standing = h('div', { class: 'lb-standing' });
      for (const person of stack.people) {
        const chip = h('span', { class: 'lb-person', text: person.name });
        chip.dataset.admin = person.admin ? 'true' : 'false';
        standing.append(chip);
      }
      const tile = h('div', { class: 'lb-stack' });
      tile.style.setProperty('--lb-height', String(Math.min(6, stack.cards.length)));
      plate.style.setProperty('--lb-height', String(Math.min(6, stack.cards.length)));
      plate.style.transform = `translateZ(calc(${Math.min(6, stack.cards.length)} * 0.6rem))`;
      standing.style.transform =
        `translateZ(calc(${Math.min(6, stack.cards.length)} * 0.6rem + 0.2rem)) rotateZ(45deg) rotateX(-58deg)`;
      tile.append(plate, standing);
      stage.append(tile);
    }
    if (stage.childElementCount === 0) return h('p', { class: 'lb-empty', text: 'Nothing matches.' });
    return h('div', { class: 'lb-blocks' }, stage);
  }

  if (chosen === 'list') {
    const rows = h('div', { class: 'lb-list' });
    for (const group of libraryGroups(input, query)) {
      for (const card of group.cards) {
        const row = cardAnchor(card.entry, false);
        row.className = 'lb-list-row';
        if (card.favorite) {
          row.append(h('span', { class: 'lb-card-star', text: '★' }));
        }
        if (card.orgAccount !== null) {
          row.append(h('span', { class: 'lb-card-account', text: card.orgAccount }));
        }
        for (const tag of card.tags) row.append(h('span', { class: 'lb-tag', text: tag }));
        rows.append(row);
      }
    }
    return rows.childElementCount > 0 ? rows : h('p', { class: 'lb-empty', text: 'Nothing matches.' });
  }

  const groups = h('div', { class: 'lb-groups' });
  const closed = collapsed();
  libraryGroups(input, query).forEach((group, index) => {
    const label = group.category ?? (group.kind === 'personal' ? 'Your tools' : 'Other tools');
    const body = h('div', { class: 'lb-group-cards' });
    group.cards.forEach((card, at) => {
      const node = cardAnchor(card.entry, index === 0 && at < 2);
      if (card.favorite) {
        node.append(h('span', { class: 'lb-card-star', text: '★' }));
      }
      if (card.orgAccount !== null) {
        node.append(h('p', { class: 'lb-card-account' }, document.createTextNode('Guild account: '), h('b', { text: card.orgAccount })));
      }
      const tags = h('div', { class: 'lb-card-tags' });
      for (const tag of card.tags) tags.append(h('span', { class: 'lb-tag', text: tag }));
      node.append(tags);
      body.append(node);
    });
    const section = h(
      'section',
      { class: 'lb-group' },
      h(
        'button',
        { class: 'lb-group-head', title: group.category === null ? label : `Collapse ${label}` },
        h('span', { class: 'lb-caret', text: '▸' }),
        h('span', { class: 'lb-group-title', text: label }),
        h('span', { class: 'lb-group-count', text: String(group.cards.length) }),
      ),
      body,
    );
    const key = group.kind === 'personal' ? '\u0000personal' : group.category ?? '\u0000other';
    section.dataset.collapsed = closed.has(key) ? 'true' : 'false';
    section.querySelector('.lb-group-head')?.addEventListener('click', () => {
      const now = section.dataset.collapsed !== 'true';
      section.dataset.collapsed = now ? 'true' : 'false';
      const set = collapsed();
      if (now) set.add(key);
      else set.delete(key);
      storeCollapsed(set);
    });
    groups.append(section);
  });
  return groups.childElementCount > 0 ? groups : h('p', { class: 'lb-empty', text: 'Nothing matches.' });
}

/** The signed-in screen: the header, the toolbar, the view. */
function drawPortal(me: Me, catalog: Catalog): void {
  let query = '';
  let chosen = view();

  const redraw = (): void => {
    const area = document.getElementById('lb-area');
    if (area !== null) area.replaceChildren(drawViews(catalog, query, chosen));
  };

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search title, category, tag, account…';
  search.autocomplete = 'off';
  search.addEventListener('input', () => {
    query = search.value;
    redraw();
  });

  const views = h('div', { class: 'lb-views', role: 'group', ariaLabel: 'Library views' });
  for (const option of LIBRARY_VIEWS) {
    const button = h('button', { class: 'lb-view', text: option.label, title: `The library as ${option.label.toLowerCase()}` });
    button.dataset.view = option.id;
    button.setAttribute('aria-pressed', chosen === option.id ? 'true' : 'false');
    button.addEventListener('click', () => {
      chosen = option.id;
      window.localStorage.setItem(VIEW_KEY, chosen);
      for (const other of views.querySelectorAll('.lb-view')) {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      }
      redraw();
    });
    views.append(button);
  }

  const signOut = h('button', { class: 'lb-signout', text: 'Sign out', title: 'End this browser session' });
  signOut.addEventListener('click', async () => {
    await api('/web/api/logout', { method: 'POST', headers: { origin: window.location.origin } });
    window.location.reload();
  });

  root.replaceChildren(
    h(
      'header',
      { class: 'lb-header' },
      h('div', { class: 'lb-brand' }, h('span', { class: 'lb-logo', text: 'N' }), h('span', { class: 'lb-guild', text: me.guild || 'Nod' })),
      h('div', { class: 'lb-who' }, h('span', { class: 'lb-person', text: me.name }), signOut),
    ),
    h(
      'div',
      { class: 'lb-toolbar' },
      h('label', { class: 'lb-search' }, search),
      views,
    ),
    h('div', { class: 'lb-body', id: 'lb-area' }),
  );
  redraw();
}

/** The sign-in screen (RF-73): the salt request, the derivation, and only the `authKey` on the wire. */
function drawSignIn(): void {
  const email = document.createElement('input');
  email.type = 'email';
  email.autocomplete = 'username';
  email.placeholder = 'you@guild.example';
  const password = document.createElement('input');
  password.type = 'password';
  password.autocomplete = 'current-password';
  password.placeholder = 'Password';
  const message = h('p', { class: 'lb-message' });
  const submit = h('button', { class: 'lb-submit', text: 'Sign in' });

  const signIn = async (): Promise<void> => {
    submit.disabled = true;
    message.textContent = '';
    try {
      const salt = await api<{ salt: string; iterations: number }>('/v1/auth/salt', {
        method: 'POST',
        body: JSON.stringify({ email: email.value }),
      });
      if (!salt.ok || salt.body === null) throw new Error('the host did not answer a salt');
      const keys = await deriveKeys(password.value, new TextEncoder().encode(salt.body.salt), salt.body.iterations);
      const response = await fetch('/web/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: window.location.origin },
        body: JSON.stringify({ email: email.value, authKey: toBase64url(keys.authKey) }),
      });
      if (response.status === 401) throw new Error('invalid credentials');
      if (response.status === 429) throw new Error('too many attempts — try again in a few minutes');
      if (!response.ok) throw new Error('sign-in failed');
      window.location.reload();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : 'sign-in failed';
      submit.disabled = false;
    }
  };

  submit.addEventListener('click', () => void signIn());
  password.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void signIn();
  });

  root.replaceChildren(
    h(
      'div',
      { class: 'lb-entry' },
      h('div', { class: 'lb-brand lb-brand-entry' }, h('span', { class: 'lb-logo', text: 'N' }), h('span', { class: 'lb-guild', text: 'Nod' })),
      h('h1', { class: 'lb-entry-title', text: 'Sign in' }),
      h('label', { class: 'lb-field' }, h('span', { class: 'lb-field-label', text: 'Email' }), email),
      h('label', { class: 'lb-field' }, h('span', { class: 'lb-field-label', text: 'Password' }), password),
      message,
      submit,
      h('p', { class: 'lb-note', text: 'The password stays in this page: only the key it derives travels to the host.' }),
    ),
  );
  email.focus();
}

async function boot(): Promise<void> {
  const me = await api<Me>('/web/api/me');
  if (!me.ok || me.body === null) {
    drawSignIn();
    return;
  }
  const catalog = await api<Catalog>('/web/api/catalog');
  if (!catalog.ok || catalog.body === null) {
    drawSignIn();
    return;
  }
  drawPortal(me.body, catalog.body);
}

void boot();
