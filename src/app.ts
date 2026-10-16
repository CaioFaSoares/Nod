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
/** Push `update` (RF-55): the newer release to announce, or `null` when there is none. */
let update: UpdateInfo | null = null;
/** SP05 §3: the one host, from `host.state` or the push `host`. */
let host: HostState | null = null;
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
    }),
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

  const login = tool.login === null ? null : LOGIN_TEXT[tool.login];
  const tip = login === null ? tool.title : `${tool.title} — ${login}`;
  const label = tool.error === null ? tip : `${tool.title} — failed: ${tool.error}`;
  const node = el(
    'button',
    {
      class: classes.join(' '),
      title: tip,
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

function sidebarAction(mark: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el(
    'button',
    { class: 'sidebar-action', title: label, aria: { label }, attrs: { type: 'button' } },
    el('span', { class: 'glyph', aria: { hidden: 'true' } }, mark),
    el('span', { class: 'sidebar-action-label' }, label),
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
    el('header', { class: 'content-header' }, el('h1', { class: 'content-title' }, 'Tools')),
    body,
  );
}

function toolCard(entry: Entry): HTMLElement {
  const tool = tools.find((item) => item.id === entry.id) ?? null;
  const open = tool !== null && tool.openWindows > 0;

  const card = el(
    'article',
    { class: 'card tool-card' },
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
  // Locked windows cannot read `host.state` (SP05 §3): the badge waits for the next unlock.
  host = null;
  joinInvite = null;
  view = 'home';
  render();
}

async function loadUnlocked(): Promise<void> {
  try {
    const [state, entries, hostState] = await Promise.all([
      call('tools.state'),
      call('catalog.list'),
      // SP05 §3: locked windows cannot read it, and the sidebar needs it right after the unlock.
      call('host.state'),
    ]);
    tools = state.tools;
    catalog = entries;
    host = hostState;
  } catch (e) {
    showBanner(e);
    return;
  }
  refreshChrome();
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
    host = null;
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
    catalog = await call('catalog.list');
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
