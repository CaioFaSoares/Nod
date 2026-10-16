// Settings of the main window: the single place to manage the Bond account and vault (every
// person) and the catalog, roles, people, activity and seed (admin). Contract:
// docs/arquitetura.md §5; requirements: docs/canonico.md §9-§13. The page talks to the backend
// only through src/api.ts; the only other runtime surface it touches is `tiny.dialog`, to choose
// the file of an export or import (docs/arquitetura.md §2).
import { call, errorMessage, on } from './api';
import { button, clear, el, field, input, message } from './ui';
import { originOf, slug } from '../shared/catalog';
import type {
  AppInfo,
  AuditEvent,
  Entry,
  EntryDetails,
  EventFilter,
  Id,
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

export type SettingsTab = 'account' | 'vault' | 'tools' | 'roles' | 'people' | 'activity' | 'catalog';

/** Tabs in the order of the screen; `admin` marks the ones only an admin person sees (§2). */
const TABS: ReadonlyArray<{ id: SettingsTab; label: string; admin: boolean }> = [
  { id: 'account', label: 'Account', admin: false },
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

export function mountSettings(
  root: HTMLElement,
  ctx: { session: SessionState; info: AppInfo; tab?: SettingsTab },
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
    inviteRoles: [] as Id[],
    inviteDays: '7',
    revealed: null as { toolId: Id; username: string; secret: string } | null,
    filterTool: '',
    filterResult: '',
    seedMode: 'merge' as 'merge' | 'overwrite',
    update: null as UpdateInfo | null,
    vaultTool: '',
    vaultUsername: '',
    vaultLabel: '',
  };

  let alive = true;
  let revealTimer: number | null = null;

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
        `Bond ${state.info.version} · seed ${state.info.seedVersion ?? 'none'} · ${state.info.os}`,
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
      card.append(el('p', { class: 'muted' }, 'Closing the window quits Bond on this system.'));
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
      state.update = await call('bond.checkUpdate');
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
      await call('bond.installUpdate');
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
      const path = await tiny.dialog.saveFile({ types: ['bondvault'], name: 'bond-vault.bondvault' });
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
      const path = await tiny.dialog.openFile({ types: ['bondvault'] });
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
    if (state.entries.length === 0) {
      box.append(el('p', { class: 'empty' }, 'No tools in the catalog.'));
      return box;
    }
    const list = el('div', { class: 'stack' });
    for (const entry of state.entries) list.append(toolItem(entry));
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
    for (const entry of state.entries) {
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
    if (state.roles.length > 0 && state.entries.length > 0) {
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
      ),
      roleCheckboxes(
        (role) => `person-${target.id}-role-${role.id}`,
        (role) => target.roles.includes(role.id),
        (role, on) => void togglePersonRole(target, role.id, on),
      ),
    );
    // Revoking yourself is refused by the backend; the button is not even offered.
    if (target.id !== owner.id) {
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
    return card;
  }

  function viewPeople(owner: Person): HTMLElement {
    const box = el('section', { class: 'stack' });
    box.append(inviteCard());
    if (state.people.length === 0) {
      box.append(el('p', { class: 'empty' }, 'No people.'));
      return box;
    }
    const list = el('div', { class: 'stack' });
    for (const item of state.people) list.append(personItem(item, owner));
    box.append(list);
    return box;
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
      const path = await tiny.dialog.saveFile({ types: ['jsonl'], name: 'bond-activity.jsonl' });
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
      state.info = await call('bond.info');
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
      hideRevealed();
      clear(root);
    },
  };
}
