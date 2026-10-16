// Settings of the main window: the single place to manage the Nod account and vault (every
// person) and the catalog, roles, people, activity and seed (admin). Contract:
// docs/arquitetura.md §5; requirements: docs/canonico.md §9-§13. The page talks to the backend
// only through src/api.ts; the only other runtime surface it touches is `tiny.dialog`, to choose
// the file of an export or import (docs/arquitetura.md §2).
import { call, errorMessage, on } from './api';
import { button, clear, el, field, input, message } from './ui';
import { originOf, slug } from '../shared/catalog';
import { CODE_LENGTH, normalizeCode } from '../shared/host-api';
import type {
  AppInfo,
  AuditEvent,
  Entry,
  EntryDetails,
  EventFilter,
  EventSyncStatus,
  HostState,
  Id,
  JoinInvite,
  LoginResult,
  Person,
  Probe,
  RawIcon,
  Role,
  SessionState,
  UpdateInfo,
  View,
  VaultItem,
} from '../shared/types';

export type SettingsTab =
  | 'account'
  | 'hosts'
  | 'vault'
  | 'tools'
  | 'roles'
  | 'people'
  | 'activity'
  | 'catalog';

/** Tabs in the order of the screen; `admin` marks the ones only an admin person sees (§2). */
const TABS: ReadonlyArray<{ id: SettingsTab; label: string; admin: boolean }> = [
  { id: 'account', label: 'Account', admin: false },
  { id: 'hosts', label: 'Hosts', admin: false },
  { id: 'vault', label: 'Vault', admin: false },
  { id: 'tools', label: 'Tools', admin: true },
  { id: 'roles', label: 'Roles', admin: true },
  { id: 'people', label: 'People', admin: true },
  { id: 'activity', label: 'Activity', admin: true },
  { id: 'catalog', label: 'Catalog', admin: true },
];

/** Image types accepted for a tool icon, mapped to `RawIcon.type`. */
const ICON_TYPES: ReadonlyArray<{ mime: string; type: RawIcon['type'] }> = [
  { mime: 'image/png', type: 'png' },
  { mime: 'image/svg+xml', type: 'svg' },
  { mime: 'image/jpeg', type: 'jpeg' },
  { mime: 'image/webp', type: 'webp' },
];

/** Milliseconds a revealed credential stays on screen (canonico §11). */
const REVEAL_MS = 10_000;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Data URI of an icon, for the preview. */
function iconDataUri(icon: RawIcon): string {
  const mime = icon.type === 'svg' ? 'image/svg+xml' : `image/${icon.type}`;
  return `data:${mime};base64,${icon.base64}`;
}

/** Base64 of the file, without the `data:` prefix (`RawIcon.base64`). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

/** Text of the probe result (canonico §8). */
function describeProbe(probe: Probe): string {
  if (probe.provider !== null) return `Redirects to ${probe.provider}`;
  if (probe.hasLoginForm) return 'Has a sign-in form';
  return 'No sign-in detected';
}

/** Origin of the address, or null when it is not a valid entry address. */
function originOrNull(url: string): string | null {
  try {
    return originOf(url);
  } catch {
    return null;
  }
}

function toggleIn(list: Id[], id: Id, include: boolean): void {
  const index = list.indexOf(id);
  if (include && index < 0) list.push(id);
  else if (!include && index >= 0) list.splice(index, 1);
}

/** A checkbox whose change handler takes the new state. */
function checkbox(
  name: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  aria?: string,
): HTMLInputElement {
  const node = el('input', {
    attrs: { type: 'checkbox', name },
    aria: aria !== undefined ? { label: aria } : {},
    on: { change: (event: Event) => onChange((event.target as HTMLInputElement).checked) },
  });
  node.checked = checked;
  return node;
}

function checkboxField(label: string, control: HTMLInputElement): HTMLLabelElement {
  return el('label', { class: 'row' }, control, el('span', {}, label));
}

// ---------------------------------------------------------------- join a guild (SP05 §4)

/** What the join form holds between renders. The password is cleared on every submit. */
interface JoinDraft {
  address: string;
  /** the fingerprint an invite (or an added host) fixed, or null when the person typed the address */
  expected: string | null;
  guild: string;
  fingerprint: string;
  email: string;
  code: string;
  name: string;
  password: string;
  confirm: string;
  /** the account is already activated: sign in with the password instead of redeeming a code */
  usePassword: boolean;
  /** the address was found and the account fields are on screen */
  discovered: boolean;
  /**
   * F1: the local account of this Nod that holds the join's email, as the backend answered it —
   * `null` while the flow has not collided with one. It is what puts the choice of which account
   * wins on screen, and the next submit carries the decision (`adoptLocal`).
   */
  collision: { personId: Id; email: string; name: string } | null;
  /** F1: which account the person picked while a collision is on screen. */
  choice: 'guild' | 'local';
}

/** Case, spaces and grouping are presentation (SP04 §1.1): one key typed two ways is one string. */
function sameFingerprint(left: string, right: string): boolean {
  const plain = (value: string): string => value.toUpperCase().replaceAll('-', '').replaceAll(' ', '');
  return plain(left) === plain(right);
}

/** SP02 §3: a setup code is 16 Crockford characters, an access code 8 — the length says which. */
function isSetupCode(code: string): boolean {
  const normalized = normalizeCode(code);
  return normalized !== null && normalized.length === CODE_LENGTH.setup;
}

/** What the join screen starts with, per SP05 §4. */
export interface JoinFlowOptions {
  /** a prefilled address and fingerprint: a `nod://join` invite, or what an added host knows */
  prefill?: JoinInvite | null;
  /** the prefill is the host this machine already pinned, so another key is SP04 §1.4's refusal */
  pinned?: boolean;
  /** an account exists on this machine: the email starts filled, in the password mode */
  email?: string | null;
  /** the join went through: the backend has already pushed the new session */
  onJoined: () => void;
}

/**
 * SP05 §4's join flow, shared by the first-run screen ("Join a guild") and Settings → Hosts:
 * address → discovery (guild and fingerprint) → email + access code (or password) → set password.
 * `host.discover`, `host.activate` and `host.signIn` take no session, so this works while locked.
 *
 * The fingerprint is on screen before anything is typed, and the same one travels with the call:
 * the backend compares it against the key the host answers (SP04 §1.3–§1.4). The password never
 * leaves this module except as the parameter of that one call (RF-42).
 */
export function mountJoinFlow(
  root: HTMLElement,
  ctx: JoinFlowOptions,
): { setPrefill(invite: JoinInvite | null): void } {
  const refusal =
    ctx.pinned === true
      ? 'host key changed — remove and add the host again'
      : 'host key does not match the invite';
  const draft: JoinDraft = {
    address: ctx.prefill?.address ?? '',
    expected: ctx.prefill?.fingerprint ?? null,
    guild: '',
    fingerprint: '',
    email: ctx.email ?? '',
    code: ctx.prefill?.code ?? '',
    name: '',
    password: '',
    confirm: '',
    usePassword: ctx.pinned === true || (ctx.email ?? '') !== '',
    discovered: false,
    collision: null,
    choice: 'guild',
  };
  let status: { kind: 'info' | 'ok' | 'error'; text: string } | null = null;

  function render(): void {
    clear(root);
    const box = el('section', { class: 'stack' });
    box.append(addressCard());
    if (draft.discovered) box.append(accountCard());
    if (status !== null) {
      const line = el('div');
      message(line, status.kind, status.text);
      box.append(line);
    }
    root.append(box);
  }

  function addressCard(): HTMLElement {
    const address = input('address', { value: draft.address, placeholder: 'nod.example.com' });
    address.addEventListener('input', () => {
      draft.address = address.value;
    });
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Guild host'),
      el('p', { class: 'muted' }, 'The address of the host, and the fingerprint your admin gave you.'),
      el(
        'div',
        { class: 'row' },
        field('Address', address),
        button(
          draft.discovered ? 'Find again' : 'Find guild',
          () => void findGuild(address.value),
          { kind: 'primary' },
        ),
      ),
    );
    if (draft.discovered) {
      card.append(
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'chip' }, draft.guild),
          el('span', { class: 'mono fingerprint' }, draft.fingerprint),
        ),
        el('p', { class: 'muted' }, 'Check this fingerprint with your admin before you continue.'),
      );
    }
    return card;
  }

  /**
   * F1: the choice SP05 §4's join asks for when a local account of this Nod already holds the
   * email the join is about. The backend answered it before any host call, so the code is whole; the
   * select decides what the next submit does — the guild account (the local one becomes it) or the
   * local one (the join is cancelled and nothing is sent).
   */
  function collisionCard(): HTMLElement {
    const select = el(
      'select',
      { class: 'input', attrs: { name: 'join-choice' } },
      el('option', { attrs: { value: 'guild' } }, 'Use the guild account'),
      el('option', { attrs: { value: 'local' } }, 'Keep using the local account'),
    );
    select.value = draft.choice;
    select.addEventListener('change', () => {
      draft.choice = select.value === 'local' ? 'local' : 'guild';
    });
    const block = el(
      'section',
      { class: 'stack' },
      el(
        'p',
        {},
        `This Nod already has the account ${draft.collision === null ? '' : draft.collision.email} ` +
          `${draft.collision === null || draft.collision.name === '' ? '' : `(${draft.collision.name}) `}` +
          'saved on this machine. Which account should Nod use?',
      ),
      field('Account', select),
      el(
        'p',
        { class: 'muted' },
        'Use the guild account: your local account becomes the guild account, saved logins and ' +
          'roles come with you, and your password becomes the guild password. Keep using the local ' +
          'account: the join is cancelled and nothing is sent.',
      ),
    );
    block.hidden = draft.collision === null;
    return block;
  }

  function accountCard(): HTMLElement {
    // F1: the choice sits above the fields it decides for; the email field hides it again, because
    // another email is another question.
    const collision = collisionCard();
    const email = input('email', { type: 'email', autocomplete: 'username', value: draft.email });
    email.addEventListener('input', () => {
      draft.email = email.value;
      if (draft.collision !== null) {
        draft.collision = null;
        draft.choice = 'guild';
        collision.hidden = true;
      }
    });
    const password = input('password', {
      type: 'password',
      autocomplete: draft.usePassword ? 'current-password' : 'new-password',
    });
    password.addEventListener('input', () => {
      draft.password = password.value;
    });
    const modes = el(
      'div',
      { class: 'row' },
      button('Access code', () => setMode(false), { kind: draft.usePassword ? 'ghost' : 'primary' }),
      button('Password', () => setMode(true), { kind: draft.usePassword ? 'primary' : 'ghost' }),
    );
    // F1: with a collision on screen the button is the one that carries the decision of the select.
    const joinLabel = draft.collision === null ? 'Join the guild' : 'Continue';
    const signInLabel = draft.collision === null ? 'Sign in' : 'Continue';

    const card = el('section', { class: 'card stack' }, el('h2', {}, 'Your account'), modes, collision);
    if (draft.usePassword) {
      card.append(
        el('div', { class: 'row' }, field('Email', email), field('Password', password)),
        el('p', { class: 'muted' }, 'The password you already set for this guild.'),
        el('div', { class: 'row' }, button(signInLabel, () => void submit(), { kind: 'primary' })),
      );
      return card;
    }

    const code = input('code', { value: draft.code, placeholder: 'XXXX-XXXX' });
    const nameControl = input('name', { value: draft.name, autocomplete: 'name' });
    nameControl.addEventListener('input', () => {
      draft.name = nameControl.value;
    });
    // SP02 §3: only the 16-character setup code creates a person, and it needs a name for them.
    const nameField = field('Name', nameControl, 'The setup code creates the guild, so it needs your name.');
    nameField.hidden = !isSetupCode(draft.code);
    code.addEventListener('input', () => {
      draft.code = code.value;
      nameField.hidden = !isSetupCode(code.value);
    });
    const confirm = input('confirm', { type: 'password', autocomplete: 'new-password' });
    confirm.addEventListener('input', () => {
      draft.confirm = confirm.value;
    });
    card.append(
      el('div', { class: 'row' }, field('Email', email), field('Access code', code)),
      nameField,
      el('div', { class: 'row' }, field('Password', password), field('Confirm password', confirm)),
      el(
        'p',
        { class: 'muted' },
        'Nod derives the keys on this machine; the password itself never reaches the host.',
      ),
      el('div', { class: 'row' }, button(joinLabel, () => void submit(), { kind: 'primary' })),
    );
    return card;
  }

  function setMode(usePassword: boolean): void {
    draft.usePassword = usePassword;
    // The fields are rebuilt by the render below and a password is never written back into the
    // DOM: leaving the draft behind would submit a password the person can no longer see.
    draft.password = '';
    draft.confirm = '';
    status = null;
    render();
  }

  async function findGuild(raw: string): Promise<void> {
    const address = raw.trim();
    status = null;
    if (address === '') {
      status = { kind: 'error', text: 'enter the address of the host' };
      render();
      return;
    }
    try {
      const found = await call('host.discover', { address });
      draft.address = address;
      draft.guild = found.guild;
      draft.fingerprint = found.fingerprint;
      // SP04 §1.3: the fingerprint the invite fixed is compared here, before a password is typed.
      // The backend compares it again — over the same discovery — when the join goes out.
      draft.discovered = draft.expected === null || sameFingerprint(draft.expected, found.fingerprint);
      if (!draft.discovered) {
        draft.guild = '';
        draft.fingerprint = '';
        status = { kind: 'error', text: refusal };
      }
    } catch (e) {
      draft.discovered = false;
      draft.guild = '';
      draft.fingerprint = '';
      status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function submit(): Promise<void> {
    status = null;
    // F1: the decision the select carries. Keeping the local account cancels the join here — nothing
    // is sent, and the code the person was given is untouched.
    if (draft.collision !== null && draft.choice === 'local') {
      draft.collision = null;
      draft.choice = 'guild';
      draft.password = '';
      draft.confirm = '';
      status = { kind: 'info', text: 'the join was cancelled — nothing was sent to the guild' };
      render();
      return;
    }
    const email = draft.email.trim();
    if (email === '') {
      status = { kind: 'error', text: 'enter your email' };
      render();
      return;
    }
    if (draft.password === '') {
      status = { kind: 'error', text: 'enter your password' };
      render();
      return;
    }
    if (!draft.usePassword && draft.password !== draft.confirm) {
      status = { kind: 'error', text: 'the two passwords are not the same' };
      render();
      return;
    }
    const setup = !draft.usePassword && isSetupCode(draft.code);
    if (setup && draft.name.trim() === '') {
      status = { kind: 'error', text: 'the setup code needs your name' };
      render();
      return;
    }
    // The fingerprint the host answered is what the backend re-checks; the invite's own one wins
    // when there was an invite (it is the same string, or the flow already refused above).
    const fingerprint = draft.expected ?? draft.fingerprint;
    const password = draft.password;
    // F1: with the choice on screen this submit is the person's decision, and it is what the backend
    // reads as `adoptLocal`.
    const adoptLocal = draft.collision === null ? {} : { adoptLocal: true };
    try {
      const answer = draft.usePassword
        ? await call('host.signIn', { address: draft.address, fingerprint, email, password, ...adoptLocal })
        : await call('host.activate', {
            address: draft.address,
            fingerprint,
            email,
            code: draft.code,
            password,
            ...(setup ? { name: draft.name.trim() } : {}),
            ...adoptLocal,
          });
      if (answer.kind !== 'session') {
        // F1: the backend answered the choice — a local account of this Nod holds the email and
        // nothing was sent, so the code is whole. The password goes (the fields are rebuilt), the
        // code and the address stay.
        draft.collision = answer;
        draft.choice = 'guild';
        draft.password = '';
        draft.confirm = '';
        status = { kind: 'info', text: 'nothing was sent to the guild yet' };
        render();
        return;
      }
    } catch (e) {
      // A failed join keeps neither the password nor a half-written host.
      draft.password = '';
      draft.confirm = '';
      status = { kind: 'error', text: errorMessage(e) };
      render();
      return;
    }
    draft.password = '';
    draft.confirm = '';
    ctx.onJoined();
  }

  render();
  if (ctx.prefill !== null && ctx.prefill !== undefined) void findGuild(ctx.prefill.address);

  return {
    setPrefill(invite: JoinInvite | null): void {
      if (invite === null) return;
      draft.address = invite.address;
      draft.expected = invite.fingerprint;
      draft.code = invite.code ?? '';
      status = null;
      render();
      void findGuild(invite.address);
    },
  };
}

export function mountSettings(
  root: HTMLElement,
  ctx: {
    session: SessionState;
    info: AppInfo;
    tab?: SettingsTab;
    /** SP05 §3: the last host state the page knows, before this tab reads one of its own */
    host?: HostState | null;
    /** SP04 §1.3: the invite a `nod://join` link carried, for the Hosts tab to prefill */
    join?: JoinInvite | null;
  },
): {
  setTab(tab: SettingsTab): void;
  update(session: SessionState): void;
  destroy(): void;
} {
  type StatusKind = 'info' | 'ok' | 'error';

  interface Status {
    kind: StatusKind;
    text: string;
  }

  /** Form of one tool, new or being edited. Holds no secret. */
  interface ToolEditor {
    isNew: boolean;
    url: string;
    id: string;
    title: string;
    order: string;
    roles: Id[];
    active: boolean;
    views: View[];
    noFill: boolean;
    /** icon picked in this edition (probe or file); null means none was picked */
    icon: RawIcon | null;
    /** true when the icon differs from the saved one — removing it is a change too */
    iconChanged: boolean;
    /** data URI of the saved icon, for the preview */
    savedIcon: string | null;
    probe: Probe | null;
    usualLogin: LoginResult | null;
    /** text of the probe result; '' while there is none */
    probeNote: string;
  }

  const state = {
    session: ctx.session,
    info: ctx.info,
    tab: 'account' as SettingsTab,
    status: null as Status | null,
    entries: [] as Entry[],
    roles: [] as Role[],
    people: [] as Person[],
    vault: [] as VaultItem[],
    events: [] as AuditEvent[],
    /** result values already seen, for the Activity filter */
    results: [] as string[],
    editor: null as ToolEditor | null,
    invite: null as { code: string; expiresAt: string } | null,
    /** which card the code block belongs to: the new-person card ('new') or one person's id */
    inviteFor: null as 'new' | Id | null,
    inviteRoles: [] as Id[],
    inviteDays: '7',
    /** connected People tab: the half-typed new person, cleared once the host created them */
    personEmail: '',
    personName: '',
    /** B8a: set once the publish offer was answered — it is offered at most one time */
    publishClosed: false,
    revealed: null as { toolId: Id; username: string; secret: string } | null,
    filterTool: '',
    filterResult: '',
    seedMode: 'merge' as 'merge' | 'overwrite',
    update: null as UpdateInfo | null,
    vaultTool: '',
    vaultUsername: '',
    vaultLabel: '',
    /** SP05 §3: the one host, as `host.state` or the push `host` last answered. */
    host: ctx.host ?? null,
    /** SP04 §5: sent vs pending of the Activity tab, read while a host is known; null without one. */
    eventSync: null as EventSyncStatus | null,
    /** SP04 §1.3: the invite a `nod://join` link carried, spent by the join flow on mount. */
    join: ctx.join ?? null,
  };

  let alive = true;
  let revealTimer: number | null = null;
  /**
   * The join flow owns its DOM and its half-typed form, so the Hosts tab re-attaches this element
   * instead of building a new one on every render.
   */
  let joinBox: HTMLElement | null = null;
  let joinMode: 'join' | 'signin' | null = null;

  // ---------------------------------------------------------------- gate of session and tabs

  /** Unlocked person of this window; null when the session is locked. */
  function person(): Person | null {
    return state.session.unlocked && state.session.person !== null ? state.session.person : null;
  }

  function isAdmin(): boolean {
    return person()?.admin === true;
  }

  /** Entry tab: Tools for an admin, Account for everyone else (arquitetura §5). */
  function defaultTab(): SettingsTab {
    return isAdmin() ? 'tools' : 'account';
  }

  /** Tools and everything else needs `admin = true`; without it no admin method is ever called. */
  function canShow(tab: SettingsTab): boolean {
    const found = TABS.find((item) => item.id === tab);
    return found !== undefined && (!found.admin || isAdmin());
  }

  function roleName(id: Id): string {
    return state.roles.find((role) => role.id === id)?.name ?? id;
  }

  function roleNames(ids: Id[]): string {
    return ids.length === 0 ? 'none' : ids.map((id) => roleName(id)).join(', ');
  }

  function toolTitle(id: Id): string {
    return state.entries.find((entry) => entry.id === id)?.title ?? id;
  }

  function personName(id: Id): string {
    return state.people.find((item) => item.id === id)?.name ?? id;
  }

  // ---------------------------------------------------------------- dom vocabulary

  function select(
    name: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    value: string,
    onChange?: (value: string) => void,
  ): HTMLSelectElement {
    const node = el(
      'select',
      {
        class: 'input',
        attrs: { name },
        on:
          onChange !== undefined
            ? { change: (event: Event) => onChange((event.target as HTMLSelectElement).value) }
            : {},
      },
      ...options.map((option) => el('option', { attrs: { value: option.value } }, option.label)),
    );
    node.value = value;
    return node;
  }

  function radio(
    name: string,
    value: string,
    checked: boolean,
    onChange: () => void,
  ): HTMLInputElement {
    const node = el('input', {
      attrs: { type: 'radio', name, value },
      on: { change: onChange },
    });
    node.checked = checked;
    return node;
  }

  function label(text: string): HTMLElement {
    return el('span', { class: 'muted' }, text);
  }

  function roleCheckboxes(
    nameOf: (role: Role) => string,
    isOn: (role: Role) => boolean,
    onToggle: (role: Role, on: boolean) => void,
  ): HTMLElement {
    const row = el('div', { class: 'row' });
    for (const role of state.roles) {
      row.append(
        checkboxField(
          role.name,
          checkbox(nameOf(role), isOn(role), (on) => onToggle(role, on)),
        ),
      );
    }
    if (state.roles.length === 0) row.append(el('span', { class: 'empty' }, 'No roles.'));
    return row;
  }

  // ---------------------------------------------------------------- drawing

  function render(): void {
    if (!alive) return;
    clear(root);

    const owner = person();
    if (owner === null) {
      root.append(el('p', { class: 'muted' }, 'Session locked'));
      return;
    }

    const tabs = el('nav', { class: 'tabs', role: 'tablist' });
    for (const tab of TABS) {
      if (tab.admin && !isAdmin()) continue;
      const active = tab.id === state.tab;
      tabs.append(
        el(
          'button',
          {
            class: active ? 'tab tab-active' : 'tab',
            role: 'tab',
            attrs: { type: 'button' },
            aria: { selected: active ? 'true' : 'false' },
            on: { click: () => void selectTab(tab.id) },
          },
          tab.label,
        ),
      );
    }

    const status = el('div');
    if (state.status !== null) message(status, state.status.kind, state.status.text);

    root.append(el('div', { class: 'stack' }, tabs, status, tabContent(owner)));
  }

  function tabContent(owner: Person): HTMLElement {
    switch (state.tab) {
      case 'account':
        return viewAccount(owner);
      case 'hosts':
        return viewHosts();
      case 'vault':
        return viewVault();
      case 'tools':
        return viewTools();
      case 'roles':
        return viewRoles();
      case 'people':
        return viewPeople(owner);
      case 'activity':
        return viewActivity();
      case 'catalog':
        return viewCatalog();
    }
  }

  async function selectTab(tab: SettingsTab): Promise<void> {
    // Only the tabs on screen are clickable; the guard covers any call outside the drawing.
    if (!canShow(tab)) return;
    state.tab = tab;
    state.status = null;
    // The invite code lives only while the People tab is on screen (canonico §9).
    state.invite = null;
    state.inviteFor = null;
    state.editor = null;
    hideRevealed();
    render();
    await load();
  }

  // ---------------------------------------------------------------- loading

  async function load(): Promise<void> {
    // Outside the visible tabs there is no load: that is what keeps an admin method from a
    // person without `admin` (§2).
    if (person() === null || !canShow(state.tab)) return;
    try {
      switch (state.tab) {
        case 'account':
          state.roles = await call('roles.list');
          break;
        case 'hosts':
          // SP05 §3: the tab reads the state itself instead of waiting for a push.
          state.host = await call('host.state');
          // B8a: whether the publish offer still applies is a question about the entries the
          // snapshot carries (RF-40), so the tab reads the same list the sidebar shows.
          state.entries = await call('catalog.list');
          break;
        case 'vault':
          state.vault = await call('vault.list');
          state.entries = await call('catalog.list');
          break;
        case 'tools':
          state.entries = await call('catalog.list');
          state.roles = await call('roles.list');
          break;
        case 'roles':
          state.roles = await call('roles.list');
          state.entries = await call('catalog.list');
          break;
        case 'people':
          state.people = await call('people.list');
          state.roles = await call('roles.list');
          break;
        case 'activity':
          state.entries = await call('catalog.list');
          state.people = await call('people.list');
          // SP04 §5's sent/pending only means anything with a host: without one every event is local.
          state.eventSync = hasHost() ? await call('events.syncStatus') : null;
          await loadEvents();
          break;
        case 'catalog':
          break;
      }
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function loadEvents(): Promise<void> {
    const filter: EventFilter = {};
    if (state.filterTool !== '') filter.toolId = state.filterTool;
    if (state.filterResult !== '') filter.result = state.filterResult;
    state.events = await call('events.list', filter);
    if (state.filterResult === '') {
      for (const event of state.events) {
        if (event.result !== null && !state.results.includes(event.result)) {
          state.results.push(event.result);
        }
      }
      state.results.sort();
    }
  }

  // ---------------------------------------------------------------- tab: hosts (SP05 §4)

  /** One labelled line of the host card. */
  function hostLine(label: string, value: string): HTMLElement {
    return el(
      'div',
      { class: 'row host-line' },
      el('span', { class: 'muted host-label' }, label),
      el('span', { class: 'mono' }, value),
    );
  }

  /**
   * SP05 §4's "with a host" half: guild, address, fingerprint, last sync, pending writes, "Sync
   * now", "Remove host".
   */
  function hostCard(host: HostState): HTMLElement {
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, host.guild ?? 'Guild'),
      hostLine('Address', host.address ?? '—'),
      hostLine('Fingerprint', host.fingerprint ?? '—'),
      hostLine('Last sync', host.lastSyncAt ?? 'never'),
      hostLine('Pending writes', String(host.pendingWrites)),
    );
    if (host.status === 'signed-out') {
      card.append(
        el('p', { class: 'message message-info' }, 'Signed out — sign in again to keep syncing this guild.'),
      );
    } else if (host.status === 'stale') {
      card.append(
        el(
          'p',
          { class: 'message message-info' },
          `Offline — Nod is showing the cached guild${host.lastError === null ? '' : ` (${host.lastError})`}.`,
        ),
      );
    } else if (host.lastError !== null) {
      card.append(el('p', { class: 'message message-error' }, host.lastError));
    }
    card.append(
      el('div', { class: 'row' }, button('Sync now', () => void syncNow(), { kind: 'primary' })),
    );
    return card;
  }

  function removeCard(host: HostState): HTMLElement {
    let keepPersonal = true;
    const keep = checkbox('keepPersonal', true, (on) => {
      keepPersonal = on;
    });
    return el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Remove host'),
      el(
        'p',
        { class: 'muted' },
        `Nod goes back to its local catalog and stops showing anything from ${host.guild ?? 'the guild'}.`,
      ),
      checkboxField('Keep my personal tools', keep),
      el(
        'p',
        { class: 'field-hint' },
        'Default. Nothing in the keychain or in the local catalog is deleted either way.',
      ),
      el(
        'div',
        { class: 'row' },
        button('Remove host', () => void removeHost(keepPersonal), { kind: 'danger' }),
      ),
    );
  }

  /**
   * The join flow, mounted once per mode: it holds a half-typed form (and the password field with
   * it), so a re-render of the tab re-attaches it instead of building a new one.
   */
  function joinSection(mode: 'join' | 'signin'): HTMLElement {
    if (joinBox === null || joinMode !== mode) {
      const owner = person();
      const host = state.host;
      const box = el('div');
      mountJoinFlow(box, {
        // A pinned host is what the sign-in mode has: its address and key are already on record.
        prefill:
          mode === 'signin' && host !== null
            ? { address: host.address ?? '', fingerprint: host.fingerprint ?? '', code: null }
            : state.join,
        pinned: mode === 'signin',
        email: mode === 'signin' ? (owner === null ? null : owner.email) : null,
        onJoined: () => {
          state.status = { kind: 'ok', text: 'Connected' };
          // B8a: a host just joined — the offer belongs to its own snapshot, not to the last one.
          state.publishClosed = false;
        },
      });
      joinBox = box;
      joinMode = mode;
    }
    return joinBox;
  }

  /**
   * B8a (RF-40, SP05 §4): the offer belongs to the first admin of a host that has no org tool yet —
   * the snapshot's org half is what says so. It is offered once: a successful publish fills the
   * guild, and the host's own `409` (the window closed between this screen and the call) ends it too.
   */
  function publishOffer(): HTMLElement | null {
    const host = state.host;
    if (host === null || !isAdmin() || state.publishClosed) return null;
    if (host.status === 'none' || host.status === 'signed-out') return null;
    if (state.entries.some((entry) => (entry.scope ?? 'org') === 'org')) return null;
    return el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Publish local tools to the guild'),
      el(
        'p',
        { class: 'muted' },
        `This guild has no org tool yet. Nod can publish the tools and roles of this machine to ${host.guild ?? 'it'} — once; from then on the guild catalog belongs to the host.`,
      ),
      el(
        'div',
        { class: 'row' },
        button('Publish local tools', () => void publishLocalTools(), { kind: 'primary' }),
      ),
    );
  }

  function viewHosts(): HTMLElement {
    const box = el('section', { class: 'stack' });
    const host = state.host;
    if (host === null) {
      box.append(el('p', { class: 'muted' }, 'Reading the host…'));
      return box;
    }
    if (host.status === 'none') {
      box.append(
        el(
          'p',
          { class: 'muted' },
          'This Nod is not connected to a guild. Join one with the address and the fingerprint your admin gave you.',
        ),
        joinSection('join'),
      );
      return box;
    }
    box.append(hostCard(host));
    const offer = publishOffer();
    if (offer !== null) box.append(offer);
    // SP04 §3: signed out asks for a sign-in; on the same screen, the host can also be removed.
    if (host.status === 'signed-out') box.append(joinSection('signin'));
    box.append(removeCard(host));
    return box;
  }

  async function publishLocalTools(): Promise<void> {
    state.status = null;
    try {
      const answer = await call('host.bootstrap');
      // The offer is spent either way: the window is closed once org tools exist.
      state.publishClosed = true;
      state.status = answer.refused
        ? { kind: 'info', text: 'The guild already has org tools — publishing is closed.' }
        : {
            kind: 'ok',
            text: `Published ${plural(answer.created, 'tool', 'tools')} to ${state.host?.guild ?? 'the guild'}`,
          };
      state.entries = await call('catalog.list');
      state.host = await call('host.state');
    } catch (e) {
      // A host that could not be reached keeps the offer: nothing was published.
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function syncNow(): Promise<void> {
    state.status = null;
    try {
      state.host = await call('host.syncNow');
      state.status = { kind: 'ok', text: 'Synced' };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function removeHost(keepPersonal: boolean): Promise<void> {
    state.status = null;
    try {
      state.host = await call('host.remove', { keepPersonal });
      // A host that left takes the offer's history with it: another host starts from its own state.
      state.publishClosed = false;
      state.status = { kind: 'ok', text: 'Host removed' };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  // ---------------------------------------------------------------- tab: account

  function changePasswordCard(): HTMLElement {
    const current = input('current', { type: 'password', autocomplete: 'current-password' });
    const next = input('next', { type: 'password', autocomplete: 'new-password' });
    const confirmation = input('confirm', { type: 'password', autocomplete: 'new-password' });
    return el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Change password'),
      el(
        'p',
        { class: 'muted' },
        'Changing it rewrites the local hash; the credentials in the keychain stay as they are.',
      ),
      el(
        'div',
        { class: 'row' },
        field('Current password', current),
        field('New password', next),
        field('Confirm new password', confirmation),
        button(
          'Change password',
          () => void changePassword(current, next, confirmation),
          { kind: 'primary' },
        ),
      ),
    );
  }

  function biometricCard(): HTMLElement {
    const enabled = state.session.biometric;
    const password = input('password', { type: 'password', autocomplete: 'current-password' });
    return el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Biometrics'),
      el(
        'p',
        { class: 'muted' },
        enabled ? 'Biometrics enabled on this machine.' : 'Biometrics not enabled.',
      ),
      el('p', { class: 'muted' }, 'The local password confirms who enables the unlock shortcut.'),
      el(
        'div',
        { class: 'row' },
        field('Local password', password),
        button('Enable biometrics', () => void enableBiometric(password), { kind: 'primary' }),
      ),
    );
  }

  function versionCard(): HTMLElement {
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Version'),
      el(
        'p',
        { class: 'muted' },
        `Nod ${state.info.version} · seed ${state.info.seedVersion ?? 'none'} · ${state.info.os}`,
      ),
      el(
        'div',
        { class: 'row' },
        button('Check for updates', () => void checkUpdate()),
      ),
    );

    const update = state.update;
    if (update !== null) {
      if (update.available) {
        const row = el(
          'div',
          { class: 'row' },
          el(
            'p',
            { class: 'muted' },
            `Version ${update.latest ?? '?'} available (current ${update.current})`,
          ),
        );
        // Installing is an admin method (§2): a person without it never sees the button.
        if (isAdmin()) row.append(button('Install', () => void installUpdate(), { kind: 'primary' }));
        card.append(row);
        if (update.notes !== null) card.append(el('p', { class: 'muted' }, update.notes));
      } else {
        card.append(el('p', { class: 'muted' }, `No update (current ${update.current})`));
      }
    }

    if (!state.info.tray) {
      card.append(el('p', { class: 'muted' }, 'Closing the window quits Nod on this system.'));
    }
    return card;
  }

  function viewAccount(owner: Person): HTMLElement {
    const box = el('section', { class: 'stack' });
    box.append(
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Account'),
        el('p', {}, `${owner.name} · ${owner.email}`),
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'chip' }, owner.admin ? 'admin' : 'member'),
          el('span', { class: 'muted' }, roleNames(owner.roles)),
        ),
      ),
    );
    box.append(changePasswordCard());
    // There is no biometrics on Linux (canonico §9): the shortcut is not even offered.
    if (state.info.os !== 'linux') box.append(biometricCard());
    box.append(versionCard());
    return box;
  }

  async function changePassword(
    current: HTMLInputElement,
    next: HTMLInputElement,
    confirmation: HTMLInputElement,
  ): Promise<void> {
    state.status = null;
    // A mismatched confirmation is a local error: the backend only ever sees the new password.
    if (next.value !== confirmation.value) {
      state.status = { kind: 'error', text: 'The new password and its confirmation do not match' };
      render();
      return;
    }
    try {
      await call('session.changePassword', { current: current.value, next: next.value });
      // The card is rebuilt, so the three fields come back empty.
      state.status = { kind: 'ok', text: 'Password changed' };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function enableBiometric(password: HTMLInputElement): Promise<void> {
    state.status = null;
    try {
      const updated = await call('session.enableBiometric', { password: password.value });
      state.session = updated;
      state.status = updated.biometric
        ? { kind: 'ok', text: 'Biometrics enabled' }
        : { kind: 'info', text: 'Biometrics could not be enabled on this platform' };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function checkUpdate(): Promise<void> {
    state.status = { kind: 'info', text: 'Checking for updates…' };
    render();
    try {
      state.update = await call('nod.checkUpdate');
      state.status = null;
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function installUpdate(): Promise<void> {
    state.status = { kind: 'info', text: 'Installing the update…' };
    render();
    try {
      await call('nod.installUpdate');
      state.status = { kind: 'ok', text: 'Update installed' };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  // ---------------------------------------------------------------- tab: vault

  function saveCredentialCard(): HTMLElement {
    const tool = select(
      'tool',
      [
        { value: '', label: 'Choose a tool' },
        ...state.entries.map((entry) => ({ value: entry.id, label: entry.title })),
      ],
      state.vaultTool,
      (value) => {
        state.vaultTool = value;
      },
    );
    const username = input('username', { value: state.vaultUsername });
    username.addEventListener('input', (event) => {
      state.vaultUsername = (event.target as HTMLInputElement).value;
    });
    const secret = input('secret', { type: 'password', autocomplete: 'new-password' });
    const label = input('label', { value: state.vaultLabel });
    label.addEventListener('input', (event) => {
      state.vaultLabel = (event.target as HTMLInputElement).value;
    });

    return el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Save credential'),
      el(
        'div',
        { class: 'row' },
        field('Tool', tool),
        field('Username', username),
        field('Password', secret),
        field('Label', label),
        button(
          'Save credential',
          () => void saveCredential(tool.value, username.value, secret.value, label.value),
          { kind: 'primary' },
        ),
      ),
      el('p', { class: 'muted' }, 'The value goes to the system keychain; the local database keeps only the index.'),
    );
  }

  function vaultTransferCard(): HTMLElement {
    const exportPassword = input('export-password', {
      type: 'password',
      autocomplete: 'current-password',
    });
    const importPassword = input('import-password', {
      type: 'password',
      autocomplete: 'current-password',
    });
    return el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Export and import'),
      el(
        'div',
        { class: 'row' },
        field('Local password', exportPassword),
        button('Export', () => void exportVault(exportPassword)),
      ),
      el(
        'div',
        { class: 'row' },
        field('Local password', importPassword),
        button('Import', () => void importVault(importPassword)),
      ),
      el('p', { class: 'muted' }, 'The file is encrypted with the local password; without it it does not open.'),
    );
  }

  function vaultItem(item: VaultItem): HTMLElement {
    const revealed =
      state.revealed !== null && state.revealed.toolId === item.toolId ? state.revealed : null;
    const card = el(
      'div',
      { class: 'card stack' },
      el(
        'div',
        { class: 'row' },
        el('strong', {}, toolTitle(item.toolId)),
        el('span', { class: 'muted' }, item.username),
        item.label !== '' ? el('span', { class: 'chip' }, item.label) : null,
      ),
    );
    if (revealed !== null) {
      // On screen for 10 s; the timer hides it and nothing else keeps the value.
      card.append(
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'muted' }, `user ${revealed.username}`),
          el('span', {}, revealed.secret),
        ),
      );
    }
    card.append(
      el(
        'div',
        { class: 'row' },
        button(revealed !== null ? 'Hide' : 'Reveal', () => {
          if (revealed !== null) {
            hideRevealed();
            render();
          } else {
            void reveal(item.toolId);
          }
        }),
        button('Remove', () => void removeCredential(item), { kind: 'danger' }),
      ),
    );
    return card;
  }

  function viewVault(): HTMLElement {
    const box = el('section', { class: 'stack' });
    box.append(el('p', { class: 'muted' }, 'Your credentials for the tools of the catalog.'));
    box.append(saveCredentialCard());
    box.append(vaultTransferCard());
    if (state.vault.length === 0) {
      box.append(el('p', { class: 'empty' }, 'No credentials saved.'));
      return box;
    }
    const list = el('div', { class: 'stack' });
    for (const item of state.vault) list.append(vaultItem(item));
    box.append(list);
    return box;
  }

  function hideRevealed(): void {
    if (revealTimer !== null) {
      window.clearTimeout(revealTimer);
      revealTimer = null;
    }
    state.revealed = null;
  }

  async function reveal(toolId: Id): Promise<void> {
    state.status = null;
    try {
      const open = await call('vault.reveal', { toolId });
      hideRevealed();
      state.revealed = { toolId, username: open.username, secret: open.secret };
      revealTimer = window.setTimeout(() => {
        revealTimer = null;
        state.revealed = null;
        render();
      }, REVEAL_MS);
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function saveCredential(
    toolId: string,
    username: string,
    secret: string,
    label: string,
  ): Promise<void> {
    state.status = null;
    if (toolId === '') {
      state.status = { kind: 'error', text: 'Choose the tool of the credential' };
      render();
      return;
    }
    const params: { toolId: Id; username: string; secret: string; label?: string } = {
      toolId,
      username,
      secret,
    };
    const trimmed = label.trim();
    if (trimmed !== '') params.label = trimmed;
    try {
      await call('vault.save', params);
      // The card is rebuilt, so the password field comes back empty.
      state.status = { kind: 'ok', text: 'Credential saved in the keychain' };
      state.vault = await call('vault.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function removeCredential(item: VaultItem): Promise<void> {
    if (!confirm(`Remove ${toolTitle(item.toolId)} from the keychain?`)) return;
    state.status = null;
    try {
      await call('vault.remove', { toolId: item.toolId });
      hideRevealed();
      state.status = { kind: 'ok', text: 'Credential removed from the keychain' };
      state.vault = await call('vault.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function exportVault(password: HTMLInputElement): Promise<void> {
    state.status = null;
    if (password.value === '') {
      state.status = { kind: 'error', text: 'Enter the local password to export' };
      render();
      return;
    }
    try {
      const path = await tiny.dialog.saveFile({ types: ['nodvault'], name: 'nod-vault.nodvault' });
      if (path === null) {
        render();
        return;
      }
      await call('vault.exportToFile', { password: password.value, path });
      state.status = { kind: 'ok', text: `Vault exported to ${path}` };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function importVault(password: HTMLInputElement): Promise<void> {
    state.status = null;
    if (password.value === '') {
      state.status = { kind: 'error', text: 'Enter the local password of the file' };
      render();
      return;
    }
    try {
      const path = await tiny.dialog.openFile({ types: ['nodvault'] });
      if (path === null) {
        render();
        return;
      }
      const result = await call('vault.importFromFile', { password: password.value, path });
      state.status = {
        kind: 'ok',
        text: `${plural(result.items, 'credential', 'credentials')} imported`,
      };
      state.vault = await call('vault.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  // ---------------------------------------------------------------- tab: tools

  function newEditor(): ToolEditor {
    return {
      isNew: true,
      url: '',
      id: '',
      title: '',
      order: '0',
      roles: [],
      active: true,
      views: [],
      noFill: false,
      icon: null,
      iconChanged: false,
      savedIcon: null,
      probe: null,
      usualLogin: null,
      probeNote: '',
    };
  }

  /** Editor of an entry that already exists, from `catalog.get`. */
  function editorFrom(details: EntryDetails): ToolEditor {
    const entry = details.entry;
    return {
      isNew: false,
      url: entry.url,
      id: entry.id,
      title: entry.title,
      order: String(entry.order),
      roles: [...entry.roles],
      active: entry.active,
      views: entry.views.map((view) => ({ ...view })),
      noFill: entry.auth?.noFill === true,
      icon: null,
      iconChanged: false,
      savedIcon: entry.icon,
      probe: details.probe,
      usualLogin: details.usualLogin,
      probeNote: details.probe !== null ? describeProbe(details.probe) : '',
    };
  }

  function toolEditorCard(editor: ToolEditor): HTMLElement {
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, editor.isNew ? 'New tool' : `Edit ${editor.id !== '' ? editor.id : 'tool'}`),
    );

    const address = input('url', {
      type: 'url',
      value: editor.url,
      placeholder: 'https://tool.example.com',
    });
    address.addEventListener('input', (event) => {
      editor.url = (event.target as HTMLInputElement).value;
    });
    card.append(
      el(
        'div',
        { class: 'row' },
        field('Address', address),
        button(editor.isNew ? 'Probe' : 'Probe again', () => void probe(editor)),
      ),
    );
    if (editor.probeNote !== '') card.append(el('p', { class: 'muted' }, editor.probeNote));

    const id = input('id', { value: editor.id });
    id.addEventListener('input', (event) => {
      editor.id = (event.target as HTMLInputElement).value;
    });
    const title = input('title', { value: editor.title });
    title.addEventListener('input', (event) => {
      editor.title = (event.target as HTMLInputElement).value;
    });
    const order = input('order', { type: 'number', value: editor.order });
    order.addEventListener('input', (event) => {
      editor.order = (event.target as HTMLInputElement).value;
    });
    card.append(el('div', { class: 'row' }, field('Id', id), field('Title', title), field('Order', order)));

    const preview = editor.icon !== null ? iconDataUri(editor.icon) : editor.savedIcon;
    const file = el('input', {
      class: 'input',
      attrs: {
        type: 'file',
        name: 'icon',
        accept: 'image/png,image/svg+xml,image/jpeg,image/webp',
      },
      on: {
        change: (event: Event) => {
          const chosen = (event.target as HTMLInputElement).files?.[0];
          if (chosen !== undefined) void chooseIcon(editor, chosen);
        },
      },
    });
    card.append(
      el(
        'div',
        { class: 'row' },
        label('Icon'),
        preview !== null
          ? el('img', { attrs: { src: preview, alt: 'Tool icon', width: '24', height: '24' } })
          : el('span', { class: 'empty' }, 'No icon'),
        file,
        button(
          'Remove icon',
          () => {
            editor.icon = null;
            editor.iconChanged = true;
            editor.savedIcon = null;
            render();
          },
          { kind: 'ghost' },
        ),
      ),
    );

    card.append(
      el(
        'div',
        { class: 'stack' },
        label('Roles'),
        roleCheckboxes(
          (role) => `tool-role-${role.id}`,
          (role) => editor.roles.includes(role.id),
          (role, on) => toggleIn(editor.roles, role.id, on),
        ),
      ),
    );

    const views = el('div', { class: 'stack' });
    editor.views.forEach((view, index) => {
      const viewLabel = input('view-label', { value: view.label, placeholder: 'Label' });
      viewLabel.addEventListener('input', (event) => {
        view.label = (event.target as HTMLInputElement).value;
      });
      const viewUrl = input('view-url', { type: 'url', value: view.url, placeholder: 'Address' });
      viewUrl.addEventListener('input', (event) => {
        view.url = (event.target as HTMLInputElement).value;
      });
      views.append(
        el(
          'div',
          { class: 'row' },
          viewLabel,
          viewUrl,
          select(
            'view-mode',
            [
              { value: 'window', label: 'window' },
              { value: 'navigate', label: 'navigate' },
            ],
            view.mode,
            (value) => {
              view.mode = value === 'navigate' ? 'navigate' : 'window';
            },
          ),
          button(
            'Remove',
            () => {
              editor.views.splice(index, 1);
              render();
            },
            { kind: 'danger' },
          ),
        ),
      );
    });
    card.append(
      el(
        'div',
        { class: 'stack' },
        label('Views'),
        views,
        button('Add view', () => {
          editor.views.push({ label: '', url: '', mode: 'window' });
          render();
        }),
      ),
    );

    card.append(
      el(
        'div',
        { class: 'row' },
        checkboxField(
          'Active',
          checkbox('active', editor.active, (on) => {
            editor.active = on;
          }),
        ),
        checkboxField(
          'Never fill the sign-in form',
          checkbox('no-fill', editor.noFill, (on) => {
            editor.noFill = on;
          }),
        ),
      ),
    );

    if (editor.usualLogin !== null) {
      card.append(el('p', { class: 'muted' }, `Usually signs in via: ${editor.usualLogin}`));
    }
    const origin = originOrNull(editor.url);
    if (origin !== null && !state.info.gateOrigins.includes(origin)) {
      card.append(
        el(
          'p',
          { class: 'muted' },
          'This tool will report sign-in results after the next release includes it in the seed.',
        ),
      );
    }

    card.append(
      el(
        'div',
        { class: 'row' },
        button('Save', () => void saveTool(editor), { kind: 'primary' }),
        button('Cancel', () => {
          state.editor = null;
          state.status = null;
          render();
        }),
      ),
    );
    return card;
  }

  function toolItem(entry: Entry): HTMLElement {
    const noFill = entry.auth?.noFill === true;
    return el(
      'div',
      { class: 'card stack' },
      el(
        'div',
        { class: 'row' },
        el('strong', {}, entry.title),
        el('span', { class: 'muted' }, entry.id),
        el('span', { class: 'chip' }, entry.active ? 'active' : 'inactive'),
      ),
      el('p', { class: 'muted' }, entry.url),
      el('p', { class: 'muted' }, `Roles: ${roleNames(entry.roles)}`),
      el(
        'p',
        { class: 'muted' },
        `${plural(entry.views.length, 'view', 'views')}${noFill ? ' · never fills the sign-in form' : ''}`,
      ),
      el(
        'div',
        { class: 'row' },
        button('Edit', () => void editEntry(entry)),
        button('Open', () => void openTool(entry)),
        button('Remove', () => void removeTool(entry), { kind: 'danger' }),
      ),
    );
  }

  function viewTools(): HTMLElement {
    const box = el('section', { class: 'stack' });
    box.append(
      el(
        'div',
        { class: 'row' },
        button(
          'Add tool',
          () => {
            state.editor = newEditor();
            state.status = null;
            render();
          },
          { kind: 'primary' },
        ),
      ),
    );
    if (state.editor !== null) box.append(toolEditorCard(state.editor));
    const entries = guildEntries();
    if (entries.length === 0) {
      box.append(el('p', { class: 'empty' }, 'No tools in the catalog.'));
      return box;
    }
    const list = el('div', { class: 'stack' });
    for (const entry of entries) list.append(toolItem(entry));
    box.append(list);
    return box;
  }

  async function probe(editor: ToolEditor): Promise<void> {
    state.status = null;
    const address = editor.url.trim();
    if (address === '') {
      state.status = { kind: 'error', text: 'Enter the address to probe' };
      render();
      return;
    }
    state.status = { kind: 'info', text: 'Probing…' };
    render();
    try {
      const result = await call('catalog.probe', { url: address });
      editor.url = result.url;
      if (result.title !== null && result.title.trim() !== '') {
        editor.title = result.title;
        if (editor.id.trim() === '') editor.id = slug(result.title);
      }
      if (result.icon !== null) {
        editor.icon = result.icon;
        editor.iconChanged = true;
        editor.savedIcon = null;
      }
      editor.probe = result;
      editor.probeNote = describeProbe(result);
      state.status = null;
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function chooseIcon(editor: ToolEditor, file: File): Promise<void> {
    state.status = null;
    const type = ICON_TYPES.find((item) => item.mime === file.type)?.type;
    if (type === undefined) {
      state.status = { kind: 'error', text: 'Image format not accepted: use PNG, SVG, JPEG or WebP' };
      render();
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      editor.icon = { type, base64 };
      editor.iconChanged = true;
      editor.savedIcon = null;
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function editEntry(entry: Entry): Promise<void> {
    state.status = null;
    try {
      state.editor = editorFrom(await call('catalog.get', { id: entry.id }));
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function saveTool(editor: ToolEditor): Promise<void> {
    state.status = null;
    const entry: Entry = {
      id: editor.id.trim() !== '' ? editor.id.trim() : slug(editor.title),
      title: editor.title.trim(),
      url: editor.url.trim(),
      // The saved icon only changes when the admin picked another one; then it goes explicit.
      icon: editor.iconChanged ? null : editor.savedIcon,
      order: Number.parseInt(editor.order, 10) || 0,
      roles: [...editor.roles],
      views: editor.views.map((view) => ({
        label: view.label.trim(),
        url: view.url.trim(),
        mode: view.mode,
      })),
      auth: editor.noFill ? { noFill: true } : null,
      active: editor.active,
    };
    const params: { entry: Entry; icon?: RawIcon | null; probe?: Probe | null } = { entry };
    if (editor.iconChanged) params.icon = editor.icon;
    if (editor.probe !== null) params.probe = editor.probe;
    try {
      const saved = await call('catalog.save', params);
      state.editor = null;
      state.status = { kind: 'ok', text: `Tool "${saved.title}" saved` };
      state.entries = await call('catalog.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function openTool(entry: Entry): Promise<void> {
    state.status = null;
    try {
      await call('tools.open', { id: entry.id });
      state.status = { kind: 'ok', text: `Opened "${entry.title}"` };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function removeTool(entry: Entry): Promise<void> {
    if (!confirm(`Remove "${entry.title}" from the catalog?`)) return;
    state.status = null;
    try {
      await call('catalog.remove', { id: entry.id });
      state.status = { kind: 'ok', text: `Tool "${entry.title}" removed` };
      state.entries = await call('catalog.list');
      if (state.editor !== null && !state.editor.isNew && state.editor.id === entry.id) {
        state.editor = null;
      }
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  // ---------------------------------------------------------------- tab: roles

  function roleItem(role: Role): HTMLElement {
    const name = input(`role-name-${role.id}`, { value: role.name });
    return el(
      'div',
      { class: 'card row' },
      el('span', { class: 'muted' }, role.id),
      name,
      role.admin ? el('span', { class: 'chip' }, 'admin') : null,
      button('Rename', () => void renameRole(role, name.value)),
      role.admin ? null : button('Remove', () => void removeRole(role), { kind: 'danger' }),
    );
  }

  function grantGrid(): HTMLElement {
    const head = el('tr', {}, el('th', {}, 'Tool'));
    for (const role of state.roles) head.append(el('th', {}, role.name));
    const body = el('tbody');
    for (const entry of guildEntries()) {
      const row = el('tr', {}, el('td', {}, entry.title));
      for (const role of state.roles) {
        row.append(
          el(
            'td',
            {},
            checkbox(
              `grant-${role.id}-${entry.id}`,
              entry.roles.includes(role.id),
              (on) => void grant(role, entry, on),
              `${role.name} on ${entry.title}`,
            ),
          ),
        );
      }
      body.append(row);
    }
    return el(
      'div',
      { class: 'grid' },
      el('table', { class: 'table' }, el('thead', {}, head), body),
    );
  }

  function viewRoles(): HTMLElement {
    const box = el('section', { class: 'stack' });
    const name = input('role-name', { placeholder: 'Role name' });
    box.append(
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Roles'),
        el(
          'div',
          { class: 'row' },
          field('New role', name),
          button('Create role', () => void createRole(name.value), { kind: 'primary' }),
        ),
      ),
    );
    if (state.roles.length === 0) {
      box.append(el('p', { class: 'empty' }, 'No roles.'));
    } else {
      const list = el('div', { class: 'stack' });
      for (const role of state.roles) list.append(roleItem(role));
      box.append(list);
    }
    if (state.roles.length > 0 && guildEntries().length > 0) {
      box.append(
        el(
          'section',
          { class: 'card stack' },
          el('h2', {}, 'Grants'),
          el('p', { class: 'muted' }, 'Checking a box grants the role the tool.'),
          grantGrid(),
        ),
      );
    }
    return box;
  }

  async function createRole(name: string): Promise<void> {
    state.status = null;
    const clean = name.trim();
    const id = slug(clean);
    if (id === '') {
      state.status = { kind: 'error', text: 'Enter a name with letters or digits' };
      render();
      return;
    }
    try {
      await call('roles.save', { role: { id, name: clean, admin: false } });
      state.status = { kind: 'ok', text: `Role "${clean}" created` };
      state.roles = await call('roles.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function renameRole(role: Role, name: string): Promise<void> {
    state.status = null;
    const clean = name.trim();
    if (clean === '') {
      state.status = { kind: 'error', text: 'Enter the name of the role' };
      render();
      return;
    }
    try {
      await call('roles.save', { role: { ...role, name: clean } });
      state.status = { kind: 'ok', text: `Role "${clean}" renamed` };
      state.roles = await call('roles.list');
      state.entries = await call('catalog.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function removeRole(role: Role): Promise<void> {
    if (!confirm(`Remove the role "${role.name}"? Its grants go away.`)) return;
    state.status = null;
    try {
      await call('roles.remove', { id: role.id });
      state.status = { kind: 'ok', text: `Role "${role.name}" removed` };
      state.roles = await call('roles.list');
      state.entries = await call('catalog.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function grant(role: Role, entry: Entry, granted: boolean): Promise<void> {
    state.status = null;
    try {
      await call('roles.grant', { roleId: role.id, toolId: entry.id, granted });
      state.entries = await call('catalog.list');
      state.status = {
        kind: 'ok',
        text: granted
          ? `${entry.title} granted to "${role.name}"`
          : `${entry.title} revoked from "${role.name}"`,
      };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  // ---------------------------------------------------------------- tab: people

  function inviteCodeBlock(invite: { code: string; expiresAt: string }): HTMLElement {
    const code = input('invite-code', { value: invite.code });
    code.readOnly = true;
    code.addEventListener('focus', () => code.select());
    return el(
      'div',
      { class: 'stack' },
      el('div', { class: 'row' }, code, button('Copy', () => void copy(invite.code), { kind: 'primary' })),
      el('p', { class: 'muted' }, 'Save it now: this code will not be shown again.'),
      el('p', { class: 'muted' }, `Expires at ${invite.expiresAt}`),
    );
  }

  function inviteCard(): HTMLElement {
    const days = input('days', { type: 'number', value: state.inviteDays });
    days.addEventListener('input', (event) => {
      state.inviteDays = (event.target as HTMLInputElement).value;
    });
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Issue invite'),
      roleCheckboxes(
        (role) => `invite-role-${role.id}`,
        (role) => state.inviteRoles.includes(role.id),
        (role, on) => toggleIn(state.inviteRoles, role.id, on),
      ),
      el(
        'div',
        { class: 'row' },
        field('Days', days),
        button('Issue invite', () => void issueInvite(), { kind: 'primary' }),
      ),
    );
    if (state.invite !== null) card.append(inviteCodeBlock(state.invite));
    return card;
  }

  /**
   * SP05 §4, connected: the guild's people are the host's, so "a code to hand over" is the host
   * asking for a person (`invites.issue` → `POST /v1/admin/people`). The email and the name are what
   * creates them; the roles are the ones they start with.
   */
  function newPersonCard(): HTMLElement {
    const email = input('person-email', {
      type: 'email',
      value: state.personEmail,
      placeholder: 'person@example.com',
    });
    email.addEventListener('input', (event) => {
      state.personEmail = (event.target as HTMLInputElement).value;
    });
    const name = input('person-name', { value: state.personName, placeholder: 'Name' });
    name.addEventListener('input', (event) => {
      state.personName = (event.target as HTMLInputElement).value;
    });
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'New person'),
      el(
        'p',
        { class: 'muted' },
        'Nod creates the person on the host and answers one access code. Hand it over now: the host will not show it again.',
      ),
      el('div', { class: 'row' }, field('Email', email), field('Name', name)),
      roleCheckboxes(
        (role) => `invite-role-${role.id}`,
        (role) => state.inviteRoles.includes(role.id),
        (role, on) => toggleIn(state.inviteRoles, role.id, on),
      ),
      el(
        'div',
        { class: 'row' },
        button('New access code', () => void createPerson(), { kind: 'primary' }),
      ),
    );
    if (state.invite !== null && state.inviteFor === 'new') card.append(inviteCodeBlock(state.invite));
    return card;
  }

  function personItem(target: Person, owner: Person): HTMLElement {
    const card = el(
      'div',
      { class: 'card stack' },
      el(
        'div',
        { class: 'row' },
        el('strong', {}, target.name),
        el('span', { class: 'muted' }, target.email),
        target.admin ? el('span', { class: 'chip' }, 'admin') : null,
        // The two columns only the host keeps (SP03 §2): undefined in local mode.
        target.disabledAt != null ? el('span', { class: 'chip' }, 'revoked') : null,
        target.activatedAt === null ? el('span', { class: 'chip' }, 'not activated') : null,
      ),
      roleCheckboxes(
        (role) => `person-${target.id}-role-${role.id}`,
        (role) => target.roles.includes(role.id),
        (role, on) => void togglePersonRole(target, role.id, on),
      ),
    );
    // SP05 §4: "New access code" while connected — the host reissues the code, revoking the previous
    // one (SP02 §3). A person the host disabled is offered no code: it would not sign them in.
    if (hasHost() && target.disabledAt == null) {
      card.append(
        el(
          'div',
          { class: 'row' },
          button('New access code', () => void issuePersonCode(target)),
          target.activatedAt !== null && target.activatedAt !== undefined
            ? null
            : el('span', { class: 'muted' }, 'Has not set a password yet'),
        ),
      );
    }
    // Revoking yourself is refused by the backend; the button is not even offered.
    if (target.disabledAt == null && target.id !== owner.id) {
      const deleteCredentials = checkbox(`person-${target.id}-delete`, false, () => {});
      card.append(
        el(
          'div',
          { class: 'row' },
          checkboxField('Also delete their saved credentials', deleteCredentials),
          button('Revoke', () => void revokePerson(target, deleteCredentials.checked), { kind: 'danger' }),
        ),
      );
    }
    if (state.invite !== null && state.inviteFor === target.id) card.append(inviteCodeBlock(state.invite));
    return card;
  }

  function viewPeople(owner: Person): HTMLElement {
    const box = el('section', { class: 'stack' });
    // SP05 §4: connected, the People tab belongs to the host — a person and their code come from
    // `POST /v1/admin/people`, not from a local invite.
    box.append(hasHost() ? newPersonCard() : inviteCard());
    if (state.people.length === 0) {
      box.append(el('p', { class: 'empty' }, 'No people.'));
      return box;
    }
    const list = el('div', { class: 'stack' });
    for (const item of state.people) list.append(personItem(item, owner));
    box.append(list);
    return box;
  }

  /** Connected only: the host answers a fresh code for a person who already exists (SP02 §3). */
  async function issuePersonCode(target: Person): Promise<void> {
    state.status = null;
    try {
      state.invite = await call('invites.issue', { personId: target.id, roles: [...target.roles] });
      state.inviteFor = target.id;
      state.status = { kind: 'ok', text: `New code for ${target.name}` };
      state.people = await call('people.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  /** Connected only: the person and their one code, in a single call to the host (RF-33). */
  async function createPerson(): Promise<void> {
    state.status = null;
    try {
      state.invite = await call('invites.issue', {
        email: state.personEmail.trim(),
        name: state.personName.trim(),
        roles: [...state.inviteRoles],
      });
      state.inviteFor = 'new';
      state.personEmail = '';
      state.personName = '';
      state.status = { kind: 'ok', text: 'Person created — hand over the code' };
      state.people = await call('people.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function togglePersonRole(target: Person, roleId: Id, include: boolean): Promise<void> {
    state.status = null;
    const roles = [...target.roles];
    toggleIn(roles, roleId, include);
    try {
      await call('people.setRoles', { personId: target.id, roles });
      state.status = { kind: 'ok', text: `Roles of ${target.name} updated` };
      state.people = await call('people.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function issueInvite(): Promise<void> {
    state.status = null;
    const days = Number.parseInt(state.inviteDays, 10);
    try {
      state.invite = await call('invites.issue', {
        roles: [...state.inviteRoles],
        days: Number.isFinite(days) && days > 0 ? days : 7,
      });
      state.status = { kind: 'ok', text: 'Invite issued' };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function revokePerson(target: Person, deleteCredentials: boolean): Promise<void> {
    const warning = deleteCredentials
      ? `Revoke ${target.name}'s access and delete their saved credentials?`
      : `Revoke ${target.name}'s access?`;
    if (!confirm(warning)) return;
    state.status = null;
    try {
      await call('people.revoke', { personId: target.id, deleteCredentials });
      state.status = { kind: 'ok', text: `Access of ${target.name} revoked` };
      state.people = await call('people.list');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function copy(text: string): Promise<void> {
    state.status = null;
    try {
      await navigator.clipboard.writeText(text);
      state.status = { kind: 'ok', text: 'Code copied' };
    } catch {
      state.status = { kind: 'error', text: 'Could not copy; select the code and copy it by hand' };
    }
    render();
  }

  // ---------------------------------------------------------------- tab: activity

  /**
   * Whether the Nod knows a host at all. `host.state` answers `none` rather than `null` for a Nod
   * that was never connected — and `host.remove` leaves the same shape — so the absence of a host is
   * this status, not a missing object (SP05 §3).
   */
  function hasHost(): boolean {
    return state.host !== null && state.host.status !== 'none';
  }

  /**
   * SP05 §4: the Tools and Roles tabs edit the guild's catalog — the effective list without the
   * person's own tools, which the host keeps apart (SP04 §2's `personalTools`) and whose own screens
   * are block 2's. In local mode the list is already the catalog.
   */
  function guildEntries(): Entry[] {
    return hasHost()
      ? state.entries.filter((entry) => (entry.scope ?? 'org') !== 'personal')
      : state.entries;
  }

  function viewActivity(): HTMLElement {
    const box = el('section', { class: 'stack' });
    box.append(
      el(
        'div',
        { class: 'row' },
        field(
          'Tool',
          select(
            'activity-tool',
            [
              { value: '', label: 'All tools' },
              ...state.entries.map((entry) => ({ value: entry.id, label: entry.title })),
            ],
            state.filterTool,
            (value) => void filterEvents('tool', value),
          ),
        ),
        field(
          'Result',
          select(
            'activity-result',
            [
              { value: '', label: 'All results' },
              ...state.results.map((value) => ({ value, label: value })),
            ],
            state.filterResult,
            (value) => void filterEvents('result', value),
          ),
        ),
        button('Export JSONL', () => void exportEvents()),
      ),
    );

    // SP04 §5's "what was sent": the counters and, per event, the ack time. Without a host every
    // event is local and private (canonico §13), so there is nothing to show per row.
    const eventSync = hasHost() ? state.eventSync : null;
    if (eventSync !== null) {
      box.append(el('p', { class: 'muted' }, `Sent ${eventSync.sent} · pending ${eventSync.pending}`));
    }

    if (state.events.length === 0) {
      box.append(el('p', { class: 'empty' }, 'No events.'));
      return box;
    }

    const body = el('tbody');
    for (const event of state.events) {
      body.append(
        el(
          'tr',
          {},
          el('td', { class: 'muted' }, event.at),
          el('td', {}, event.personId !== null ? personName(event.personId) : '—'),
          el('td', {}, event.toolId !== null ? toolTitle(event.toolId) : '—'),
          el('td', {}, event.type),
          el('td', {}, event.result ?? '—'),
          el('td', { class: 'muted' }, event.url ?? '—'),
          eventSync === null ? null : el('td', { class: 'muted' }, event.sentAt ?? 'pending'),
        ),
      );
    }
    box.append(
      el(
        'table',
        { class: 'table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Time'),
            el('th', {}, 'Person'),
            el('th', {}, 'Tool'),
            el('th', {}, 'Type'),
            el('th', {}, 'Result'),
            el('th', {}, 'URL'),
            eventSync === null ? null : el('th', {}, 'Sent'),
          ),
        ),
        body,
      ),
    );
    return box;
  }

  async function filterEvents(kind: 'tool' | 'result', value: string): Promise<void> {
    state.status = null;
    if (kind === 'tool') state.filterTool = value;
    else state.filterResult = value;
    try {
      await loadEvents();
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function exportEvents(): Promise<void> {
    state.status = null;
    try {
      const path = await tiny.dialog.saveFile({ types: ['jsonl'], name: 'nod-activity.jsonl' });
      if (path === null) {
        render();
        return;
      }
      await call('events.exportToFile', { path });
      state.status = { kind: 'ok', text: `Events exported to ${path}` };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  // ---------------------------------------------------------------- tab: catalog

  function viewCatalog(): HTMLElement {
    return el(
      'section',
      { class: 'stack' },
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Seed'),
        el('div', { class: 'row' }, button('Export seed', () => void exportSeed())),
        el(
          'div',
          { class: 'row' },
          button('Import seed', () => void importSeed(), { kind: 'danger' }),
          checkboxField(
            'Merge (add new only)',
            radio('seed-mode', 'merge', state.seedMode === 'merge', () => {
              state.seedMode = 'merge';
            }),
          ),
          checkboxField(
            'Overwrite existing',
            radio('seed-mode', 'overwrite', state.seedMode === 'overwrite', () => {
              state.seedMode = 'overwrite';
            }),
          ),
        ),
        el(
          'p',
          { class: 'muted' },
          'Merge adds what the local catalog does not have yet; overwrite also replaces existing entries and roles.',
        ),
      ),
    );
  }

  async function exportSeed(): Promise<void> {
    state.status = null;
    try {
      const path = await tiny.dialog.saveFile({ types: ['json'], name: 'seed.json' });
      if (path === null) {
        render();
        return;
      }
      await call('catalog.exportToFile', { path });
      state.status = { kind: 'ok', text: `Seed exported to ${path}` };
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  async function importSeed(): Promise<void> {
    state.status = null;
    try {
      const path = await tiny.dialog.openFile({ types: ['json'] });
      if (path === null) {
        render();
        return;
      }
      const counts = await call('catalog.importFromFile', { path, mode: state.seedMode });
      state.status = {
        kind: 'ok',
        text: `Seed imported: ${plural(counts.entries, 'entry', 'entries')}, ${plural(counts.roles, 'role', 'roles')}, ${plural(counts.invites, 'invite', 'invites')}`,
      };
      state.entries = await call('catalog.list');
      state.roles = await call('roles.list');
      // The seed version shown by the Account tab is a property of the backend, not of the mount.
      state.info = await call('nod.info');
    } catch (e) {
      state.status = { kind: 'error', text: errorMessage(e) };
    }
    render();
  }

  // ---------------------------------------------------------------- session and lifecycle

  function updateSession(session: SessionState): void {
    state.session = session;
    if (person() === null) {
      // A locked session keeps neither a revealed credential nor half-finished screen state.
      hideRevealed();
      state.invite = null;
      state.inviteRoles = [];
      state.editor = null;
      state.status = null;
      render();
      return;
    }
    // A tab the person lost (role revoked, grant removed) falls back to the entry tab.
    if (!canShow(state.tab)) state.tab = defaultTab();
    render();
    void load();
  }

  // The catalog changed (by this window or by another): the lists are read again.
  const offCatalog = on('catalog', () => {
    void load();
  });

  // SP05 §3: the sync pushed a new host state — the tab shows it without a refresh of its own.
  let knownStatus: HostState['status'] | null = state.host === null ? null : state.host.status;
  const offHost = on('host', (next) => {
    // A host that just arrived, left or was signed out makes a half-typed join form stale: it is
    // rebuilt from the new state on the next render.
    if (next.status !== knownStatus) {
      joinBox = null;
      joinMode = null;
      knownStatus = next.status;
    }
    state.host = next;
    if (state.tab === 'hosts') render();
    // SP04 §5: a run that pushed events moved rows from pending to sent, so an open Activity tab
    // reads the list and the counters again — the same thing a catalog change makes it do.
    else if (state.tab === 'activity') void load();
  });

  state.tab = ctx.tab !== undefined && canShow(ctx.tab) ? ctx.tab : defaultTab();
  render();
  void load();

  return {
    setTab(tab: SettingsTab): void {
      void selectTab(tab);
    },
    update(session: SessionState): void {
      updateSession(session);
    },
    destroy(): void {
      alive = false;
      offCatalog();
      offHost();
      hideRevealed();
      clear(root);
      // The join flow is a child of this tree: it is rebuilt from `ctx` on the next mount.
      joinBox = null;
      joinMode = null;
    },
  };
}
