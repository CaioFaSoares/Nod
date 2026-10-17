// 0.4.5 (RF-60): the entry screen — the locked screen of the main window, a Discord-like rail of
// tiles with the pane of the selected one beside it.
//
//   [ Offline ]  the profile of this machine: local catalog, no sync, no host call
//   ───────────  (the separator of canonico §22's "Guilds per install": several guilds later)
//   [ Guild   ]  a guild this Nod joined, its icon or its initials, its status dot
//   [   +     ]  join a guild, or set one up (the join flow of ./join)
//
// Choosing a tile and giving the password enters that way: `session.unlock` takes the target, and
// the backend keeps the mode for the session (RF-60). Nothing here is a secret: the password goes
// from the field into that one call, and `session.profiles` carries none.
//
// The page talks to the backend only through `./api`. app.ts owns the session and mounts this.
import { call, errorMessage } from './api';
import { mountJoinFlow } from './join';
import { button, clear, el, field, initials, input, message } from './ui';
import type {
  AppInfo,
  EntryProfiles,
  EntryTarget,
  GuildProfile,
  JoinInvite,
  SessionState,
} from '../shared/types';

/** Which tile the rail has selected: the machine's profile, a guild, the `+` tile, or a sign-in. */
type Tile = EntryTarget | { kind: 'join' } | { kind: 'signin'; id: string };

/** What the screen draws from: app.ts keeps both and hands them in on every render. */
export interface EntryView {
  state: SessionState;
  /** `session.profiles`; null while the first read of the boot is in flight */
  profiles: EntryProfiles | null;
  /** SP04 §1.3: the invite a `nod://join` link carried, if there is one */
  invite: JoinInvite | null;
}

/** What the screen asks the page to do. Both answers are the backend's own state, kept by app.ts. */
export interface EntryHandlers {
  /** `nod.info`, for the operating system's name in the biometric button */
  info: AppInfo | null;
  /** a call changed the session (unlock, create, join): unlocked means the shell replaces this */
  onSession(state: SessionState): void;
  /** the tiles changed — `session.importSeed` answers the state, then `session.profiles` the tiles */
  onProfiles(profiles: EntryProfiles): void;
}

let root: HTMLElement | null = null;
let view: EntryView | null = null;
let handlers: EntryHandlers | null = null;
/** The selected tile; null while the default of the profiles (`last`, the guild, Offline) rules. */
let tile: Tile | null = null;
/** The offline pane shows the create-account form instead of the sign-in one. */
let creating = false;
/** SP04 §1.3: the invite a pushed `nod://join` link carries, until it is spent. */
let invite: JoinInvite | null = null;
let waitTimer: number | null = null;
/** The join flow owns its DOM (and a half-typed form), so a re-render re-attaches it. */
let joinBox: HTMLElement | null = null;
let joinKey: string | null = null;
/** Handle of the mounted join flow: a link that arrives on an open dialog re-aims it (SP04 §1.3). */
let joinFlow: { setPrefill(invite: JoinInvite | null): void } | null = null;

/** The backend's backoff after a failed attempt: this screen has to run it down too. */
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

/**
 * The backoff the backend keeps after a failed attempt, in ms. `session.state` is where it shows,
 * and this screen keeps it here instead of re-rendering: the form that failed keeps its own error
 * line while it runs the wait down.
 */
let waitMs = 0;

/** Reads the backoff the last failure left, without touching the screen. */
async function readWait(): Promise<number> {
  try {
    const state = await call('session.state');
    return state.waitMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- the rail

/** The tile that opens when nothing was picked: `last`, else the guild, else Offline (RF-60). */
function defaultTile(profiles: EntryProfiles): Tile {
  const last = profiles.last;
  if (last === null) {
    return profiles.guilds.length > 0 ? { kind: 'guild', id: profiles.guilds[0].id } : { kind: 'offline' };
  }
  if (last.kind === 'offline') return last;
  return profiles.guilds.some((guild) => guild.id === last.id) ? last : { kind: 'offline' };
}

/** The status dot of a guild tile: what the tile says about the guild without opening it. */
function guildDot(guild: GuildProfile): { dot: string; title: string } {
  if (guild.updateRequired) return { dot: 'update', title: 'needs a newer Nod' };
  if (guild.status === 'signed-out') return { dot: 'out', title: 'signed out — sign in again' };
  if (guild.status === 'stale') return { dot: 'stale', title: 'last sync failed' };
  return { dot: 'on', title: 'connected' };
}

function tileButton(active: boolean, glyph: string | Node, label: string, data: string, dot: HTMLElement | null): HTMLButtonElement {
  const node = el(
    'button',
    {
      class: active ? 'tile tile-active' : 'tile',
      title: label,
      aria: { label, pressed: active ? 'true' : 'false' },
      data: { tile: data },
      attrs: { type: 'button' },
    },
    el('span', { class: 'tile-mark', aria: { hidden: 'true' } }, glyph),
    dot,
  );
  node.addEventListener('click', () => {
    if (data === 'offline') tile = { kind: 'offline' };
    else if (data === 'join') tile = { kind: 'join' };
    else tile = { kind: 'guild', id: data };
    creating = false;
    render();
  });
  return node;
}

function rail(current: Tile, profiles: EntryProfiles, offlineSuffix: string): HTMLElement {
  const list = el('nav', { class: 'entry-rail', aria: { label: 'Where to enter' } });
  list.append(
    tileButton(
      current.kind === 'offline',
      '⌂',
      `Offline — this machine alone${offlineSuffix}`,
      'offline',
      null,
    ),
  );
  // 0.4.5: the one separator of both rails, always under Offline, as the sidebar draws it under
  // its mark.
  list.append(el('span', { class: 'rail-separator', aria: { hidden: 'true' } }));
  for (const guild of profiles.guilds) {
    const status = guildDot(guild);
    const mark =
      guild.icon !== null
        ? el('img', { class: 'tile-img', attrs: { src: guild.icon, alt: '' } })
        : el('span', { class: 'chip' }, initials(guild.guild));
    list.append(
      tileButton(
        current.kind === 'guild' && current.id === guild.id,
        mark,
        `${guild.guild} — ${status.title}`,
        guild.id,
        el('span', { class: `tile-dot tile-dot-${status.dot}`, title: status.title }),
      ),
    );
  }
  list.append(
    tileButton(current.kind === 'join' || current.kind === 'signin', '+', 'Join a guild or set one up', 'join', null),
  );
  return list;
}

// ---------------------------------------------------------------- the panes

/** One field of an account form, with the error line and the submit of the whole form. */
interface Form {
  form: HTMLFormElement;
  error: HTMLElement;
  wait: HTMLElement;
  submit: HTMLButtonElement;
  name: HTMLInputElement;
  email: HTMLInputElement;
  password: HTMLInputElement;
  confirm: HTMLInputElement;
  code: HTMLInputElement | null;
}

function accountForm(requiresInvite: boolean, action: string, actionLabel: string): Form {
  const name = input('name', { autocomplete: 'name', required: true });
  const email = input('email', { type: 'email', autocomplete: 'username', required: true });
  const password = input('password', { type: 'password', autocomplete: 'new-password', required: true });
  const confirm = input('confirm', { type: 'password', autocomplete: 'new-password', required: true });
  const code = requiresInvite ? input('code', { autocomplete: 'off', required: true }) : null;
  const error = el('div', { class: 'auth-error' });
  const wait = el('div', { class: 'auth-wait' });
  const submit = el(
    'button',
    { class: 'button button-primary', data: { action }, attrs: { type: 'submit' } },
    actionLabel,
  );
  const fields: HTMLElement[] = [
    field('Name', name),
    field('Email', email),
    field('Password', password),
    field('Confirm password', confirm),
  ];
  if (code !== null) fields.push(field('Invite code', code));
  const form = el('form', { class: 'stack', attrs: { novalidate: '' } }, ...fields, wait, submit, error);
  return { form, error, wait, submit, name, email, password, confirm, code };
}

/**
 * The Offline tile with no account on this machine: "Set up Nod on this machine". The seed is an
 * optional import (RF-61) — an old release's `seed.json` still works, and a release without one
 * simply starts empty.
 */
function createPane(offline: EntryProfiles['offline']): HTMLElement {
  const first = !offline.hasAccount;
  const card = el(
    'section',
    { class: 'card stack entry-card' },
    el('p', { class: 'entry-mark', aria: { hidden: 'true' } }, '⌂'),
    el('h1', { class: 'entry-title' }, first ? 'Set up Nod on this machine' : 'Create your account'),
    el(
      'p',
      { class: 'muted' },
      first
        ? 'Your tools on this machine only. Nothing syncs.'
        : 'Use the invite code an admin gave you for this machine.',
    ),
  );
  const form = accountForm(offline.requiresInvite, 'create', 'Create account');
  form.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (form.submit.disabled) return;
    const values = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      password: form.password.value,
      confirm: form.confirm.value,
      code: form.code === null ? '' : form.code.value.trim(),
    };
    if (values.name === '' || values.email === '' || values.password === '') {
      message(form.error, 'error', 'fill in every field');
      return;
    }
    if (values.password !== values.confirm) {
      message(form.error, 'error', 'passwords do not match');
      return;
    }
    if (offline.requiresInvite && values.code === '') {
      message(form.error, 'error', 'enter the invite code an admin gave you');
      return;
    }
    void submitCreate(values, form);
  });
  card.append(form.form);

  if (offline.seedImportable) {
    card.append(
      el(
        'div',
        { class: 'stack' },
        el(
          'p',
          { class: 'muted' },
          'Have a seed file from an older install? Import it and its tools, roles and invites become this machine\'s own.',
        ),
        el(
          'div',
          { class: 'row' },
          button('Import a seed file', () => void importSeed(form), { kind: 'ghost' }),
        ),
      ),
    );
  }
  if (offline.hasAccount) {
    card.append(
      button('Back', () => {
        creating = false;
        render();
      }, { kind: 'ghost' }),
    );
  }
  return card;
}

/** The Offline tile with an account: the last person who entered this way, and a password. */
function offlinePane(offline: EntryProfiles['offline'], biometric: boolean): HTMLElement {
  const mark = offline.email === null ? '⌂' : initials(offline.email);
  const card = el(
    'section',
    { class: 'card stack entry-card' },
    el('span', { class: 'entry-avatar', aria: { hidden: 'true' } }, mark),
    el('h1', { class: 'entry-title' }, 'Offline'),
    el('p', { class: 'muted' }, 'Your tools on this machine only. Nothing syncs.'),
  );

  const email = input('email', { type: 'email', autocomplete: 'username', value: offline.email ?? '' });
  const password = input('password', { type: 'password', autocomplete: 'current-password', required: true });
  const wait = el('div', { class: 'auth-wait' });
  const error = el('div', { class: 'auth-error' });
  const submit = el(
    'button',
    { class: 'button button-primary', data: { action: 'enter-offline' }, attrs: { type: 'submit' } },
    'Enter offline',
  );
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
    void submitUnlock(email.value.trim(), password.value, { kind: 'offline' }, { submit, error, wait });
  });
  card.append(form);

  if (biometric) {
    const label = handlers !== null && handlers.info !== null && handlers.info.os === 'macos'
      ? 'Unlock with Touch ID'
      : 'Unlock with biometrics';
    card.append(button(label, () => submitBiometric({ kind: 'offline' }, { submit, error }), { kind: 'ghost' }));
  }
  card.append(
    button('I have an invite code', () => {
      creating = true;
      render();
    }, { kind: 'ghost', title: 'Create an account on this machine with an invite code' }),
  );
  if (waitMs > 0) armWait(waitMs, submit, wait);
  return card;
}

/** One guild tile: its icon, its name, the account on this machine, and the password. */
function guildPane(guild: GuildProfile, biometric: boolean): HTMLElement {
  const card = el(
    'section',
    { class: 'card stack entry-card' },
    guild.icon !== null
      ? el('img', { class: 'entry-guild-icon', attrs: { src: guild.icon, alt: '' } })
      : el('span', { class: 'entry-avatar', aria: { hidden: 'true' } }, initials(guild.guild)),
    el('h1', { class: 'entry-title' }, guild.guild),
    el('p', { class: 'entry-signed-in muted' }, `Signed in as ${guild.name} · ${guild.email}`),
  );

  if (guild.updateRequired) {
    const why = el('div', { class: 'stack' });
    const line = el('div');
    message(line, 'error', `${guild.guild} needs a newer Nod. Update the app and come back.`);
    why.append(
      line,
      el(
        'p',
        { class: 'muted' },
        'The guild stays disconnected until then — the Offline tile still works on this machine.',
      ),
    );
    card.append(why);
    return card;
  }

  if (guild.status === 'signed-out') {
    card.append(
      el(
        'p',
        { class: 'muted' },
        `${guild.guild} signed this Nod out. Sign in again to sync with it.`,
      ),
      el(
        'div',
        { class: 'row' },
        button('Sign in again', () => {
          tile = { kind: 'signin', id: guild.id };
          joinBox = null;
          joinKey = null;
          render();
        }, { kind: 'primary' }),
      ),
    );
    return card;
  }

  const password = input('password', { type: 'password', autocomplete: 'current-password', required: true });
  const wait = el('div', { class: 'auth-wait' });
  const error = el('div', { class: 'auth-error' });
  const submit = el(
    'button',
    { class: 'button button-primary', data: { action: 'enter' }, attrs: { type: 'submit' } },
    `Enter ${guild.guild}`,
  );
  const form = el(
    'form',
    { class: 'stack', attrs: { novalidate: '' } },
    field('Password', password),
    wait,
    submit,
    error,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    void submitUnlock(guild.email, password.value, { kind: 'guild', id: guild.id }, { submit, error, wait });
  });
  card.append(form);

  if (guild.status === 'stale') {
    card.append(el('p', { class: 'muted' }, 'The last sync with this guild failed; entering reads it again.'));
  }
  if (biometric) {
    const label = handlers !== null && handlers.info !== null && handlers.info.os === 'macos'
      ? 'Unlock with Touch ID'
      : 'Unlock with biometrics';
    card.append(button(label, () => submitBiometric({ kind: 'guild', id: guild.id }, { submit, error }), { kind: 'ghost' }));
  }
  if (waitMs > 0) armWait(waitMs, submit, wait);
  return card;
}

/** The `+` tile (and the guild tile's "Sign in again"): the join flow of ./join. */
function joinPane(current: EntryView, signIn: GuildProfile | null): HTMLElement {
  const pending = invite ?? current.invite;
  const step = signIn === null ? 'join' : 'signin';
  const prefill: JoinInvite | null = signIn === null
    ? pending
    : { address: signIn.address, fingerprint: '', code: null };
  const key = `${step}|${prefill?.address ?? ''}|${prefill?.code ?? ''}|${signIn?.email ?? ''}`;
  if (joinBox !== null && joinKey === key) return joinBox;
  const box = el('div', { class: 'entry-join' });
  joinFlow = mountJoinFlow(box, {
    step,
    prefill,
    pinned: signIn !== null,
    email: signIn === null ? null : signIn.email,
    onJoined: () => {
      // The backend pushes the session of the joined person; app.ts builds the shell from it.
      invite = null;
      joinBox = null;
      joinKey = null;
      joinFlow = null;
    },
  });
  joinBox = box;
  joinKey = key;
  return box;
}

function pane(current: EntryView, selected: Tile): HTMLElement {
  const profiles = current.profiles;
  if (profiles === null) {
    return el('div', { class: 'entry-card card' }, el('p', { class: 'muted' }, 'Reading this Nod…'));
  }
  if (selected.kind === 'offline') {
    if (creating || !profiles.offline.hasAccount) return createPane(profiles.offline);
    return offlinePane(profiles.offline, profiles.biometric);
  }
  if (selected.kind === 'join') return joinPane(current, null);
  const guild = profiles.guilds.find((item) => item.id === selected.id) ?? null;
  if (guild === null) return offlinePane(profiles.offline, profiles.biometric);
  if (selected.kind === 'signin') return joinPane(current, guild);
  return guildPane(guild, profiles.biometric);
}

// ---------------------------------------------------------------- the calls

async function submitUnlock(
  email: string,
  password: string,
  target: EntryTarget,
  controls: { submit: HTMLButtonElement; error: HTMLElement; wait: HTMLElement },
): Promise<void> {
  clear(controls.error);
  controls.submit.disabled = true;
  let next: SessionState;
  try {
    next = await call('session.unlock', { email, password, target });
  } catch (e) {
    message(controls.error, 'error', errorMessage(e));
    waitMs = await readWait();
    if (waitMs > 0) {
      armWait(waitMs, controls.submit, controls.wait);
      return;
    }
    controls.submit.disabled = false;
    return;
  }
  if (handlers !== null) handlers.onSession(next);
}

async function submitBiometric(
  target: EntryTarget,
  controls: { submit: HTMLButtonElement; error: HTMLElement },
): Promise<void> {
  clear(controls.error);
  controls.submit.disabled = true;
  let next: SessionState;
  try {
    next = await call('session.unlockBiometric', { target });
  } catch (e) {
    message(controls.error, 'error', errorMessage(e));
    controls.submit.disabled = waitTimer !== null;
    return;
  }
  if (handlers !== null) handlers.onSession(next);
}

async function submitCreate(
  values: { name: string; email: string; password: string; confirm: string; code: string },
  form: Form,
): Promise<void> {
  const params: { email: string; name: string; password: string; code?: string } = {
    email: values.email,
    name: values.name,
    password: values.password,
  };
  if (values.code !== '') params.code = values.code;
  clear(form.error);
  form.submit.disabled = true;
  let next: SessionState;
  try {
    next = await call('session.createAccount', params);
  } catch (e) {
    message(form.error, 'error', errorMessage(e));
    form.submit.disabled = false;
    return;
  }
  if (handlers !== null) handlers.onSession(next);
}

/**
 * RF-61: the seed is an import at setup now. `tiny.dialog` picks the file, the backend applies it
 * exactly as an embedded `resources/seed.json` on a first boot, and the tiles are read again — the
 * offline profile may now carry an account to unlock.
 */
async function importSeed(form: Form): Promise<void> {
  clear(form.error);
  try {
    const path = await tiny.dialog.openFile({ types: ['json'] });
    if (path === null) return;
    const state = await call('session.importSeed', { path });
    const profiles = await call('session.profiles');
    if (handlers !== null) {
      handlers.onProfiles(profiles);
      handlers.onSession(state);
    }
  } catch (e) {
    message(form.error, 'error', errorMessage(e));
  }
}

// ---------------------------------------------------------------- mounts

function render(): void {
  if (root === null || view === null) return;
  const current = view;
  stopWait();
  const profiles = current.profiles;
  const selected = tile ?? (profiles === null ? { kind: 'offline' as const } : defaultTile(profiles));
  if (profiles !== null) tile = selected;
  const offlineSuffix = profiles !== null && profiles.offline.hasAccount ? '' : ' — no account yet';
  root.replaceChildren(
    el(
      'div',
      { class: 'entry' },
      profiles === null
        ? el('nav', { class: 'entry-rail', aria: { hidden: 'true' } })
        : rail(selected, profiles, offlineSuffix),
      el('div', { class: 'entry-pane' }, pane(current, selected)),
    ),
  );
}

/** app.ts mounts the screen with the state it owns, on every render while locked. */
export function mountEntry(host: HTMLElement, next: EntryView, nextHandlers: EntryHandlers): void {
  root = host;
  view = next;
  handlers = nextHandlers;
  if (next.invite !== null) invite = next.invite;
  // The backend's backoff survives a re-render; a countdown already running on screen is not
  // restarted with the time it has already spent.
  if (waitTimer === null) waitMs = next.state.waitMs;
  render();
}

/** SP04 §1.3: a `nod://join` link arrived. The `+` tile opens with the invite already looked up. */
export function showEntryInvite(next: JoinInvite): void {
  invite = next;
  const showing = tile !== null && (tile.kind === 'join' || tile.kind === 'signin');
  tile = { kind: 'join' };
  // A dialog already on screen takes the link as it is — the half-typed form stays, and the flow
  // runs the invite's own preview (RF-59). Any other pane re-mounts on the `+` tile.
  if (showing && joinFlow !== null) {
    joinFlow.setPrefill(next);
    return;
  }
  joinBox = null;
  joinKey = null;
  joinFlow = null;
  render();
}

/** A lock or a boot: the next screen picks its tile from the profiles again (RF-60). */
export function resetEntry(): void {
  tile = null;
  invite = null;
  creating = false;
  joinBox = null;
  joinKey = null;
  joinFlow = null;
  stopWait();
}
