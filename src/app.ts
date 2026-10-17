// The Nod main window: boot, locked screen, sidebar, Home and Settings routing
// (docs/arquitetura.md §5, canonico §7).
// The page talks to the backend only through `./api`, and only with methods of `ApiContract`.
// No password or invite code ever leaves this module except as the parameter of `call(...)`:
// nothing is written to storage, the console, the page title or an error message.
import { call, errorMessage, on } from './api';
import { openPalette } from './palette';
import { mountJoinFlow, mountSettings } from './settings';
import { button, clear, el, field, input, message } from './ui';
import type { SettingsTab } from './settings';
import type {
  AppInfo,
  Entry,
  HostState,
  Id,
  JoinInvite,
  LoginResult,
  SessionState,
  ToolStatus,
  ToolsState,
  UpdateInfo,
} from '../shared/types';
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
/** SP05 §4: the first-run screen is on "Join a guild" instead of create/invite. */
let joiningGuild = false;
/** SP04 §1.3: the invite a `nod://join` link carried, until the join flow spends it. */
let joinInvite: JoinInvite | null = null;
/** Handle of the join flow on the locked screen, so a second link re-aims it. */
let lockedJoin: { setPrefill(invite: JoinInvite | null): void } | null = null;
let view: View = 'home';
/** The person chose to create an account with an invite code instead of signing in. */
let creatingAccount = false;
let shell: Shell | null = null;
let settings: SettingsHandle | null = null;
let settingsTab: SettingsTab | null = null;
/** Handle of `window.setInterval` for the backoff countdown of the locked screen. */
let waitTimer: number | null = null;

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

// ------------------------------------------------------------- locked screen

function renderLocked(): void {
  if (session === null) return;
  const state = session;
  const card = el('div', { class: 'card auth-card' });
  if (joiningGuild) renderJoin(card);
  else if (!state.hasAccount || creatingAccount) renderCreateAccount(card, state);
  else renderUnlock(card, state);
  root.replaceChildren(el('div', { class: 'auth' }, card));
}

/**
 * SP05 §4's third path of the first-run screen: "Join a guild". The host flow of `host.activate`
 * and `host.signIn` needs no local session, so this screen replaces the create/invite pair before
 * a person exists; a deep link (`nod://join`) lands here with the invite already filled in.
 */
function renderJoin(card: HTMLElement): void {
  authHeader(card, 'Join a guild', 'The address and the fingerprint your admin gave you.');
  const form = el('div');
  card.append(form);
  lockedJoin = mountJoinFlow(form, {
    prefill: joinInvite,
    email: null,
    onJoined: () => {
      // The backend pushed the session already; the `session` handler builds the shell. This only
      // closes the screen.
      joiningGuild = false;
      joinInvite = null;
      lockedJoin = null;
    },
  });
  card.append(
    button('Back', () => {
      joiningGuild = false;
      joinInvite = null;
      lockedJoin = null;
      render();
    }, { kind: 'ghost' }),
  );
}

function authHeader(card: HTMLElement, title: string, subtitle: string | null): void {
  card.append(el('p', { class: 'auth-mark', aria: { hidden: 'true' } }, 'B'));
  card.append(el('h1', { class: 'auth-title' }, title));
  if (subtitle !== null) card.append(el('p', { class: 'muted' }, subtitle));
}

function renderUnlock(card: HTMLElement, state: SessionState): void {
  authHeader(card, 'Unlock', 'Enter your password.');

  const email = input('email', { type: 'email', autocomplete: 'username', required: true });
  const password = input('password', { type: 'password', autocomplete: 'current-password', required: true });
  const wait = el('div', { class: 'auth-wait' });
  const error = el('div', { class: 'auth-error' });
  const submit = el('button', { class: 'button button-primary', attrs: { type: 'submit' } }, 'Unlock');

  const form = el(
    'form',
    { class: 'stack', attrs: { novalidate: '' } },
    field('Email', email),
    field('Password', password),
    wait,
    submit,
    error,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    void submitUnlock(email.value, password.value, { submit, error, wait });
  });
  card.append(form);

  if (state.biometric) {
    const biometric = info !== null && info.os === 'macos' ? 'Unlock with Touch ID' : 'Unlock with biometrics';
    card.append(button(biometric, () => submitBiometric({ submit, error }), { kind: 'ghost' }));
  }
  if (state.hasAccount) {
    card.append(
      button('I have an invite', () => {
        creatingAccount = true;
        render();
      }, { kind: 'ghost', title: 'Create an account with an invite code' }),
    );
  }
  card.append(
    button('Join a guild', () => {
      joiningGuild = true;
      render();
    }, { kind: 'ghost', title: 'Connect this Nod to a guild host' }),
  );

  if (state.waitMs > 0) armWait(state.waitMs, submit, wait);
}

function renderCreateAccount(card: HTMLElement, state: SessionState): void {
  const first = !state.requiresInvite;
  authHeader(
    card,
    first ? 'Create the admin account' : 'Create your account',
    first ? 'This machine has no account yet.' : 'Use the invite code an admin gave you.',
  );

  const name = input('name', { autocomplete: 'name', required: true });
  const email = input('email', { type: 'email', autocomplete: 'username', required: true });
  const password = input('password', { type: 'password', autocomplete: 'new-password', required: true });
  const confirm = input('confirm', { type: 'password', autocomplete: 'new-password', required: true });
  const code = state.requiresInvite ? input('code', { autocomplete: 'off', required: true }) : null;
  const error = el('div', { class: 'auth-error' });
  const submit = el('button', { class: 'button button-primary', attrs: { type: 'submit' } }, 'Create account');

  const fields: HTMLElement[] = [
    field('Name', name),
    field('Email', email),
    field('Password', password),
    field('Confirm password', confirm),
  ];
  if (code !== null) fields.push(field('Invite code', code));

  const form = el('form', { class: 'stack', attrs: { novalidate: '' } }, ...fields, submit, error);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const values = {
      name: name.value.trim(),
      email: email.value.trim(),
      password: password.value,
      confirm: confirm.value,
      code: code === null ? null : code.value.trim(),
    };
    if (values.name === '' || values.email === '' || values.password === '' || values.code === '') {
      message(error, 'error', 'fill in every field');
      return;
    }
    if (values.password !== values.confirm) {
      message(error, 'error', 'passwords do not match');
      return;
    }
    void submitCreate(values, submit, error);
  });
  card.append(form);

  if (state.hasAccount) {
    card.append(
      button('Back to sign in', () => {
        creatingAccount = false;
        render();
      }, { kind: 'ghost' }),
    );
  }
  card.append(
    button('Join a guild', () => {
      joiningGuild = true;
      render();
    }, { kind: 'ghost', title: 'Connect this Nod to a guild host' }),
  );
}

function stopWait(): void {
  if (waitTimer !== null) {
    window.clearInterval(waitTimer);
    waitTimer = null;
  }
}

/** Counts `ms` down in seconds with the submit disabled, then frees the form again. */
function armWait(ms: number, submit: HTMLButtonElement, wait: HTMLElement): void {
  stopWait();
  let remaining = Math.max(1, Math.ceil(ms / 1000));
  const tick = (): void => {
    if (remaining <= 0) {
      stopWait();
      clear(wait);
      submit.disabled = false;
      return;
    }
    message(wait, 'info', `wait ${remaining} s`);
    submit.disabled = true;
    remaining -= 1;
  };
  tick();
  waitTimer = window.setInterval(tick, 1000);
}

async function submitUnlock(
  email: string,
  password: string,
  controls: { submit: HTMLButtonElement; error: HTMLElement; wait: HTMLElement },
): Promise<void> {
  clear(controls.error);
  controls.submit.disabled = true;
  let next: SessionState;
  try {
    next = await call('session.unlock', { email, password });
  } catch (e) {
    message(controls.error, 'error', errorMessage(e));
    const waitMs = await waitFromState();
    if (waitMs > 0) {
      armWait(waitMs, controls.submit, controls.wait);
      return;
    }
    controls.submit.disabled = false;
    return;
  }
  session = next;
  await startUnlocked();
}

async function submitBiometric(controls: { submit: HTMLButtonElement; error: HTMLElement }): Promise<void> {
  clear(controls.error);
  controls.submit.disabled = true;
  let next: SessionState;
  try {
    next = await call('session.unlockBiometric');
  } catch (e) {
    message(controls.error, 'error', errorMessage(e));
    controls.submit.disabled = waitTimer !== null;
    return;
  }
  session = next;
  await startUnlocked();
}

async function submitCreate(
  values: { name: string; email: string; password: string; confirm: string; code: string | null },
  submit: HTMLButtonElement,
  error: HTMLElement,
): Promise<void> {
  const params: { email: string; name: string; password: string; code?: string } = {
    email: values.email,
    name: values.name,
    password: values.password,
  };
  if (values.code !== null) params.code = values.code;

  clear(error);
  submit.disabled = true;
  let next: SessionState;
  try {
    next = await call('session.createAccount', params);
  } catch (e) {
    message(error, 'error', errorMessage(e));
    submit.disabled = false;
    return;
  }
  session = next;
  await startUnlocked();
}

/** Backoff the backend keeps after a failed attempt: the locked screen has to run it down too. */
async function waitFromState(): Promise<number> {
  try {
    const state = await call('session.state');
    session = state;
    return state.waitMs;
  } catch {
    return 0;
  }
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
  stopWait();
  // B7: the dialog is an overlay of the main window, so it goes with the shell (a lock).
  document.getElementById(PERSONAL_DIALOG_ID)?.remove();
  shell = null;
}

function renderSidebar(): void {
  if (shell === null || session === null) return;
  const list = el('nav', { class: 'sidebar-tools', aria: { label: 'Tools' } });
  for (const tool of tools) list.append(sidebarTool(tool));
  const footer = el(
    'div',
    { class: 'sidebar-footer' },
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
  const mark = el(
    'button',
    { class: 'mark', title: 'Home', aria: { label: 'Home' }, attrs: { type: 'button' } },
    'B',
  );
  mark.addEventListener('click', () => {
    go('home');
  });
  shell.sidebar.replaceChildren(mark, list, footer);
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
    const grid = el('div', { class: 'grid' });
    for (const entry of catalog) grid.append(toolCard(entry));
    body.append(grid);
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

/** RF-58: how long ago, in words a person reads at a glance. */
function seenAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** RF-58: the guild has a host this Nod reaches (or reached); local mode has no guild to show. */
function guildConnected(): boolean {
  return host !== null && (host.status === 'connected' || host.status === 'stale');
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

function refreshChrome(): void {
  if (shell === null) return;
  renderSidebar();
  if (view === 'home') renderHome(shell.content);
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

function renderNotices(): void {
  const target = shell;
  if (target === null) return;
  clear(target.notice);
  // O2 first: an out-of-date Nod is the reason nothing else it does reaches the guild.
  renderUpdateRequiredNotice(target.notice);
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
}

async function loadUnlocked(): Promise<void> {
  try {
    const [state, entries, hostState, ids] = await Promise.all([
      call('tools.state'),
      call('catalog.list'),
      // SP05 §3: locked windows cannot read it, and the sidebar needs it right after the unlock.
      call('host.state'),
      // B7: the favorites the toggle draws from.
      call('favorites.list'),
    ]);
    tools = state.tools;
    catalog = entries;
    host = hostState;
    favorites = ids;
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
  stopWait();
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
    joiningGuild = false;
    lockedJoin = null;
    view = 'home';
    creatingAccount = false;
    render();
    return;
  }
  creatingAccount = false;
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
 * locked, it opens the join screen — a Nod with no account at all is the usual case.
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
  joiningGuild = true;
  if (lockedJoin !== null) lockedJoin.setPrefill(invite);
  else render();
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
