// Driver of the real-page UI smoke (`test/smoke/ui.ts`, story checks #24, #25, #27–#38, RF-62's
// grouped tool categories, the RF-64 owner steps and the RF-65 second credential of a tool with its
// default mark).
//
// The generated page imports `src/app.ts` exactly as `index.html` does, then this module. It runs
// after the app has booted and drives the real screens with DOM events: every acceptance check
// below reads what the page shows and clicks or types on it. `call` is used only to set the world
// up (create the account, publish tools, create people, save and share credentials, restart the
// host) and to read the states a screen cannot show by itself (the session's mode for #36/#37, the
// seed version for #38, and the roster the host holds for RF-64); a check never asserts an RPC
// answer otherwise.
//
// Only the machines whose screens are checked run this page (the admin, P, #37's invite joiner and
// #38's seed importer). The second member Q, the throwaway member the owner renames and deletes
// (RF-64) and P's second machine are headless Bun calls in the runner (`test/smoke/headless.ts`):
// they had no check of their own, and a `tinyjs dev` launch each was most of the smoke's time.
//
// Nothing here prints a code, a password or a credential value: the codes arrive through the
// runner's desk and live in memory, and the driver's own throwaway values are never echoed. The
// result goes to the app store under `ui_smoke_result`, which the runner reads.
import { call } from '../../src/api';

/** The generated page hands this in before the modules load. */
interface DriverConfig {
  phase: string;
  nonce: string;
  address: string;
  desk: string;
  originC: string;
  adminEmail: string;
  personEmail: string;
  otherEmail: string;
  thirdEmail: string;
  /** RF-64: the throwaway member the owner renames and deletes on the People tab. */
  extraEmail: string;
  adminName: string;
  personName: string;
  otherName: string;
  thirdName: string;
  extraName: string;
  /** The guild's name on the host, as the invite card and the offline banner print it. */
  guildName: string;
  /** #37: the PNG the admin uploads (`resources/tray.png`), base64url, as `host.setGuildIcon` takes. */
  iconPng: string;
  /** #38: the fake seed file the runner wrote under `test/smoke/.gerado/`. */
  seedPath: string;
}

const smokeWindow = window as unknown as {
  /** Injected by the generated page before the modules load. */
  __NOD_UI_SMOKE__?: DriverConfig;
  /** The tinyjs bridge, present once the runtime has injected its page script. */
  tiny?: typeof tiny;
};
const CONFIG = smokeWindow.__NOD_UI_SMOKE__;
if (CONFIG === undefined) throw new Error('the generated page carries no ui-smoke config');

/**
 * Throwaway values of throwaway app data dirs under the smoke's own ids. Not secrets (they guard
 * nothing real), and never printed — the same rule the connected smoke keeps.
 */
const PASSWORD = 'smoke-ui-1';
const SHARED_SECRET = 'smoke-ui-shared-1';
const BLOCKED_SECRET = 'smoke-ui-blocked-1';

const PERSONAL_TITLE = 'Mine (UI smoke)';
const ROLE_USERNAME = 'role-user';
const BLOCKED_USERNAME = 'blocked-user';
/**
 * RF-65: the second credential of Tool A the Vault tab check adds through the form, beside the role
 * one — a different username (and so a different card), so a collapse into one credential fails.
 */
const SECOND_USERNAME = 'role-user-2';
const SECOND_SECRET = 'smoke-ui-second-1';
const LOCAL_TOOL_TITLE = 'Local Notes';
const LOCAL_DESK_TITLE = 'Local Desk';
/** The guild's own tool of #28: created on the host, never in this machine's local tables. */
const GUILD_ONLY_TITLE = 'Guild Only';
/** RF-62: the two categories the Tools tab check files its own tools under, and their titles. */
const CATEGORY_A = 'Support';
const CATEGORY_B = 'Engineering';
const CATEGORIZED_A_TITLE = 'Categorized A';
const CATEGORIZED_B_TITLE = 'Categorized B';
/** The host's O2 minimum for the last check. Above `tinyjs.json`'s version. */
const UPDATE_MIN_VERSION = '9.9.9';
/** #37: the guild's non-admin role of the smoke (`setupAdmin` creates it), as the invite names it. */
const TEAM_ROLE_NAME = 'Team';
/** #38: the role and the tool the imported seed brings — the tool shows only with that role. */
const IMPORT_ROLE_ID = 'imported';
const IMPORT_TOOL_TITLE = 'Imported One';
/** RF-64: the name and the address the owner gives the throwaway member before deleting them. */
const EXTRA_NEW_NAME = 'Smoke Extra Renamed';
const EXTRA_NEW_EMAIL = 'extra-renamed@ui.test';

const POLL_MS = 100;
const STATE_TIMEOUT_MS = 20_000;
const REVEAL_TIMEOUT_MS = 16_000;

interface Step {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const steps: Step[] = [];

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function expect(condition: unknown, text: string): void {
  if (!condition) throw new Error(text);
}

function text(node: Element | null): string {
  return node === null ? '' : (node.textContent ?? '').trim();
}

function record(step: string, ok: boolean, detail: string, ms: number): void {
  steps.push({ step, ok, detail, ms: Math.max(0, Math.round(ms)) });
}

async function writeResult(done: boolean, error: string | null): Promise<void> {
  try {
    await tiny.store.set('ui_smoke_result', {
      done,
      phase: CONFIG?.phase ?? 'unknown',
      nonce: CONFIG?.nonce ?? '',
      steps,
      error,
    });
  } catch {
    /* without the store there is no result; the runner falls back to the timeout */
  }
}

// ------------------------------------------------------------- the real page's DOM

async function waitForTiny(): Promise<void> {
  const start = Date.now();
  while (smokeWindow.tiny === undefined) {
    if (Date.now() - start > STATE_TIMEOUT_MS) {
      throw new Error(`the tiny global did not show up in ${STATE_TIMEOUT_MS} ms`);
    }
    await sleep(POLL_MS);
  }
}

async function waitForValue<T>(
  label: string,
  read: () => T | null | Promise<T | null>,
  accept: (value: T) => boolean = (value) => value !== null && value !== undefined,
  timeoutMs = STATE_TIMEOUT_MS,
): Promise<T> {
  const start = Date.now();
  let last = 'nothing yet';
  for (;;) {
    const value = await read();
    if (value !== null && accept(value)) return value;
    last = JSON.stringify(value)?.slice(0, 160) ?? String(value);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout (${timeoutMs} ms) waiting for ${label}; last: ${last}`);
    }
    await sleep(POLL_MS);
  }
}

function all<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

function textIs(label: string) {
  return (node: Element): boolean => text(node) === label;
}

function controlByText(label: string, root: ParentNode = document): HTMLButtonElement | null {
  return all<HTMLButtonElement>('button', root).find(textIs(label)) ?? null;
}

/** The tool titles the sidebar shows, in order: the tool button's `title` is the entry's own. */
function sidebarTitles(): string[] {
  return all<HTMLButtonElement>('.sidebar-tools .tool-icon').map(
    (button) => button.getAttribute('title') ?? '',
  );
}

function setValue(field: HTMLInputElement | HTMLSelectElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitForControl(label: string, root: ParentNode = document): Promise<HTMLButtonElement> {
  return await waitForValue(
    `the button "${label}"`,
    () => {
      const found = controlByText(label, root);
      return found !== null && !found.disabled ? found : null;
    },
  );
}

/** Settings → the tab; the app's own `go`/`selectTab` path, driven by the sidebar and the tabs. */
async function openSettingsTab(label: string): Promise<void> {
  const settings = all<HTMLButtonElement>('.sidebar-action').find((button) =>
    text(button).includes('Settings'),
  );
  expect(settings !== undefined, 'the sidebar has no Settings action');
  settings.click();
  await waitForValue('the Settings tabs', () => document.querySelector('.settings-view .tabs'));
  const tab = await waitForValue(`the ${label} tab`, () =>
    all<HTMLButtonElement>('.tabs .tab').find(textIs(label)) ?? null,
  );
  tab.click();
  await waitForValue(`the active ${label} tab`, () => {
    const active = document.querySelector('.tabs .tab-active');
    return active !== null && text(active) === label ? active : null;
  });
}

async function openHome(): Promise<void> {
  const mark = document.querySelector<HTMLButtonElement>('.mark');
  expect(mark !== null, 'the sidebar has no Home mark');
  mark.click();
  await waitForValue('Home', () => document.querySelector('.home'));
}

/** The card whose first direct row names this title (a vault item, a person, a credential). */
function cardOf(title: string, extraText = ''): HTMLElement | null {
  return (
    all<HTMLElement>('.card').find((card) => {
      const head = card.querySelector(':scope > .row > strong');
      return text(head) === title && (extraText === '' || text(card).includes(extraText));
    }) ?? null
  );
}

function cardHeading(title: string): HTMLElement | null {
  return (
    all<HTMLElement>('section.card').find((card) => {
      const heading = card.querySelector(':scope > h2');
      return text(heading) === title;
    }) ?? null
  );
}

/**
 * RF-65: the Vault tab groups a tool's credentials under one heading — `section.vault-tool` with its
 * `<h3>` title, then one card per credential. These read that shape, because a tool may hold several
 * and `cardOf`'s "the tool title is the card's head" no longer holds.
 */
function vaultCards(toolTitle: string): HTMLElement[] {
  const group = all<HTMLElement>('.vault-tool').find(
    (section) => text(section.querySelector(':scope > h3')) === toolTitle,
  );
  return group === undefined ? [] : all<HTMLElement>(':scope > .card', group);
}

/**
 * The card of a tool that names this username: its head is the label (or the username when the
 * label is empty), and a labelled card carries the username in the muted span beside it. Exact, not
 * a substring — the second credential of a tool must never answer for the first one.
 */
function vaultCard(toolTitle: string, username: string): HTMLElement | null {
  return (
    vaultCards(toolTitle).find((card) => {
      const row = card.querySelector(':scope > .row');
      if (row === null) return false;
      if (text(row.querySelector(':scope > strong')) === username) return true;
      return all<HTMLElement>(':scope > span.muted', row).some((span) => text(span) === username);
    }) ?? null
  );
}

async function waitForStatus(fragment: string): Promise<HTMLElement> {
  return await waitForValue(`the status "${fragment}"`, () => {
    const found = all<HTMLElement>('.message-ok, .message-info, .message-error').find((node) =>
      text(node).includes(fragment),
    );
    return found ?? null;
  });
}

/** The inline gate of a dev run: type the local password and press the row's Confirm. */
async function passGate(): Promise<void> {
  const field = await waitForValue('the password prompt', () =>
    document.querySelector<HTMLInputElement>('input.gate-password'),
  );
  setValue(field, PASSWORD);
  const gate = field.closest('.gate');
  const confirm = controlByText('Confirm', gate ?? document);
  expect(confirm !== null, 'the password prompt has no Confirm button');
  confirm.click();
  await waitForValue('the password prompt to close', () =>
    document.querySelector('input.gate-password') === null ? true : null,
  );
}

// ------------------------------------------------------------- the desk and RPC setup

async function desk(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init =
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const response = await tiny.fetch(`${CONFIG.desk}${path}`, init);
  const raw: unknown = await response.json();
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`desk ${path} answered a non-object body`);
  }
  const payload = raw as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    const why = typeof payload.error === 'string' ? payload.error : `status ${response.status}`;
    throw new Error(`desk ${path} refused: ${why}`);
  }
  return payload;
}

/**
 * The desk's handover. `person`, `other` and `person2` carry a code; `third` (#37) carries the whole
 * `nod://join` link of the invite the admin created — the joiner pastes a link, so the check must not
 * rebuild one.
 */
async function handover(who: 'person' | 'other' | 'person2' | 'third' | 'import' | 'extra'): Promise<string> {
  const answer = await desk(`/desk/code?who=${who}`);
  const code = answer.code;
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error(`the desk carries no code for ${who}`);
  }
  return code;
}

interface EntryLite {
  id: string;
  title: string;
  url: string;
  scope?: 'org' | 'personal';
}

interface PersonLite {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

async function personOfEmail(email: string): Promise<PersonLite> {
  const people = (await call('people.list')) as unknown as PersonLite[];
  const found = people.find((person) => person.email === email);
  expect(found !== undefined, `${email} is not a person of the guild`);
  return found;
}

/**
 * 0.5.0 (RF-60): the page opens on the entry screen, and its default entry is Offline. Every check
 * below needs the **guild** session, so this drives the real screen: the guild tile of the rail, the
 * password, "Enter <guild>".
 */
async function unlock(email: string): Promise<void> {
  const tile = await waitForValue('the guild tile of the entry rail', () => {
    const found = all<HTMLButtonElement>('.entry-rail .tile').find(
      (node) => node.querySelector('.tile-dot') !== null,
    );
    return found ?? null;
  });
  tile.click();
  // The pane names the account on this machine: the person the tile unlocks, prefilled by the
  // backend's own answer (`session.profiles`).
  const account = await waitForValue('the guild account line', () => {
    const line = document.querySelector('.entry-pane .entry-signed-in');
    return line !== null && text(line).includes(email) ? line : null;
  });
  expect(text(account).includes(email), `the guild pane says ${JSON.stringify(text(account))}`);
  const password = await waitForValue('the guild password field', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=password]'),
  );
  setValue(password, PASSWORD);
  const enter = await waitForValue('the Enter button', () =>
    document.querySelector<HTMLButtonElement>('.entry-pane [data-action=enter]'),
  );
  enter.click();
  await waitForValue('the unlocked shell', () => document.querySelector('.shell')).catch((error: unknown) => {
    const why = all<HTMLElement>('.entry-pane .message-error').map(text).join(' | ');
    throw new Error(`${message(error)}; the entry pane says ${why || '(nothing)'}`);
  });
  await waitForValue('the Home screen', () => {
    const title = document.querySelector('.content-title');
    return title !== null && text(title) === 'Tools' ? title : null;
  });
}

async function synced(): Promise<void> {
  const state = await call('host.syncNow');
  expect(state.status === 'connected', `host.state.status = ${JSON.stringify(state.status)}`);
}

/**
 * Setup only — the join screens are driven by the checks themselves. `name` is required with a setup
 * code (it creates the first admin) and with an invite code (RF-59: the host creates the person the
 * invite was redeemed by); an access code carries none.
 */
async function activateWithCode(email: string, code: string, name?: string): Promise<void> {
  const found = await call('host.discover', { address: CONFIG.address });
  const answer = await call('host.activate', {
    address: CONFIG.address,
    fingerprint: found.fingerprint,
    email,
    code,
    password: PASSWORD,
    ...(name === undefined ? {} : { name }),
  });
  expect(answer.kind === 'session', `host.activate answered ${JSON.stringify(answer.kind)}`);
  expect(answer.session.unlocked === true, 'the join did not unlock the session');
}

// ------------------------------------------------------------- phase: admin setup

async function setupAdmin(): Promise<void> {
  const state = await call('session.state');
  expect(state.hasAccount === false, 'the admin app id is not a fresh installation');
  const setup = await desk('/desk/setup');
  const code = setup.code;
  if (typeof code !== 'string' || code.length === 0) throw new Error('the desk carries no setup code');
  await activateWithCode(CONFIG.adminEmail, code, CONFIG.adminName);
  await waitForValue('the admin sidebar', () => document.querySelector('.sidebar'));

  const published = await call('host.bootstrap');
  expect(published.refused !== true, 'the host refused the first publish');
  await synced();

  await call('roles.save', { role: { id: 'team', name: 'Team', admin: false } });
  // 0.5.0 (RF-59): the way in for a member is a guild invite — the roles it grants, one use and a
  // day to use it. The code travels through the desk; the join redeems it with the name the person
  // chose, which `activateWithCode` carries.
  for (const [name, who] of [
    [CONFIG.personName, 'person'],
    [CONFIG.otherName, 'other'],
    // RF-64: one more invite, for the throwaway member the owner renames and deletes. Joining them
    // through the same path keeps P and Q — the names the later checks read — untouched.
    [CONFIG.extraName, 'extra'],
  ] as const) {
    const answer = await call('guildInvites.create', {
      roles: ['team'],
      maxUses: 1,
      expiresInMinutes: 1440,
    });
    expect(
      typeof answer.code === 'string' && answer.code.length > 0,
      `guildInvites.create answered no code for ${name}`,
    );
    await desk('/desk/code', { who, code: answer.code });
  }

  // #37's guild icon: the invite card shows the icon of a guild the person has not joined yet, so the
  // host must hold one. The digest comes back; the bytes are the runner's own PNG.
  const icon = await call('host.setGuildIcon', { png: CONFIG.iconPng });
  expect(typeof icon.sha256 === 'string' && icon.sha256.length === 64, 'the host did not store the icon');

  // #37: one more invite, for the Nod that joins through the entry screen's `+` tile. The desk
  // carries the whole link — the check pastes exactly what the admin's screen would hand over.
  const third = await call('guildInvites.create', {
    roles: ['team'],
    maxUses: 1,
    expiresInMinutes: 1440,
  });
  expect(
    typeof third.link === 'string' && third.link.startsWith('nod://join?'),
    `guildInvites.create answered no link: ${JSON.stringify(third.link)}`,
  );
  await desk('/desk/code', { who: 'third', code: third.link });

  // Both published tools are granted to team (the loop reads them by their origins).
  const list = (await call('catalog.list')) as unknown as EntryLite[];
  expect(list.length >= 2, `the host carries ${list.length} org tool(s)`);
  for (const entry of list.filter((row) => (row.scope ?? 'org') === 'org')) {
    await call('roles.grant', { roleId: 'team', toolId: entry.id, granted: true });
  }

  const me = await personOfEmail(CONFIG.adminEmail);
  const roles = me.roles.includes('team') ? me.roles : [...me.roles, 'team'];
  await call('people.setRoles', { personId: me.id, roles });
  await synced();

  const mine = await call('keys.mine');
  expect(mine.fingerprint !== null, 'the admin machine has no key pair after the activation');
}

// ------------------------------------------------------------- phase: person join

async function checkKeepLocalTools(): Promise<string> {
  await openSettingsTab('Hosts');
  const boxes = await waitForValue('the leftover checkboxes', () => {
    const card = cardHeading('Keep your local tools');
    if (card === null) return null;
    const found = all<HTMLInputElement>('input[type=checkbox]', card);
    return found.length === 2 ? found : null;
  });
  expect(boxes.every((box) => box.checked), 'a leftover tool is not checked');
  const card = cardHeading('Keep your local tools');
  expect(card !== null, 'the leftover card left the screen');
  const names = all<HTMLElement>('label', card).map(text);
  expect(
    names.includes(LOCAL_TOOL_TITLE) && names.includes(LOCAL_DESK_TITLE),
    `the leftover card names ${JSON.stringify(names)}`,
  );
  const keep = await waitForControl('Keep as personal tools', card);
  keep.click();
  const status = await waitForStatus('Kept 2 tools as personal');
  expect(text(status).includes('Kept 2 tools as personal'), `status = ${text(status)}`);
  await waitForValue('the leftover card to go', () =>
    cardHeading('Keep your local tools') === null ? true : null,
  );

  await openHome();
  const personal = await waitForValue('the two personal cards', () => {
    const cards = all<HTMLElement>('.tool-card-personal');
    return cards.length === 2 ? cards : null;
  });
  const titles = personal.map((card) => text(card.querySelector('h2')));
  expect(
    titles.includes(LOCAL_TOOL_TITLE) && titles.includes(LOCAL_DESK_TITLE),
    `the Home cards are ${JSON.stringify(titles)}`,
  );
  for (const card of personal) {
    const warning = card.querySelector('.tool-warning');
    expect(
      warning !== null && text(warning).includes('Not from your org'),
      'a kept tool has no "Not from your org" warning',
    );
  }
  return `${personal.length} kept tools are personal and warn they are not from the org`;
}

async function checkPersonDevices(): Promise<string> {
  await openSettingsTab('Account');
  const rows = await waitForValue('the device rows', () => {
    const card = cardHeading('Devices');
    if (card === null) return null;
    const found = all<HTMLElement>(':scope > .row', card).filter(
      (row) => controlByText('Revoke', row) !== null,
    );
    return found.length > 0 ? found : null;
  });
  const why = all<HTMLElement>('.message-error').map(text).join(' | ');
  expect(why === '', `the devices read failed: ${why}`);
  return `${rows.length} device row(s), each with Revoke`;
}

async function checkFingerprint(): Promise<string> {
  const shown = await waitForValue('the key fingerprint', () => {
    const card = cardHeading('Your key fingerprint');
    const value = card?.querySelector('.fingerprint');
    return value === null || value === undefined ? null : text(value);
  });
  expect(
    /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(shown),
    `the fingerprint reads ${JSON.stringify(shown)}`,
  );
  const status = await waitForValue('the key status', () => {
    const card = cardHeading('Your key fingerprint');
    const chip = card?.querySelector('.key-status');
    return chip === null || chip === undefined ? null : text(chip);
  });
  expect(status.length > 0, 'the fingerprint status is empty');
  return `fingerprint ${shown.slice(0, 4)}-…-${shown.slice(-4)} with status "${status}"`;
}

async function joinPerson(): Promise<void> {
  const state = await call('session.state');
  expect(state.hasAccount === false, 'the person app id is not a fresh installation');
  const code = await handover('person');
  await activateWithCode(CONFIG.personEmail, code, CONFIG.personName);
  await waitForValue('the person sidebar', () => document.querySelector('.sidebar'));
  await synced();
  const mine = await call('keys.mine');
  expect(mine.fingerprint !== null, 'the person machine has no key pair after the activation');
}

// ------------------------------------------------------------- phase: admin work

async function addPersonalTool(): Promise<string> {
  await openHome();
  const add = await waitForControl('Add personal tool');
  add.click();
  const dialog = await waitForValue('the Add personal tool dialog', () =>
    document.getElementById('personal-tool-dialog'),
  );
  const title = dialog.querySelector<HTMLInputElement>('input[name=title]');
  const url = dialog.querySelector<HTMLInputElement>('input[name=url]');
  expect(title !== null && url !== null, 'the dialog has no title/address fields');
  setValue(title, PERSONAL_TITLE);
  setValue(url, `${CONFIG.originC}/mine`);
  const addButton = await waitForControl('Add', dialog);
  addButton.click();
  await waitForValue('the dialog to close', () =>
    document.getElementById('personal-tool-dialog') === null ? true : null,
  );
  return 'the dialog added the tool';
}

async function checkSidebarOrder(): Promise<string> {
  const personal = await waitForValue('the personal tool in the sidebar', () =>
    all<HTMLButtonElement>('.sidebar-tools .tool-icon').find((button) =>
      (button.getAttribute('title') ?? '').includes(PERSONAL_TITLE),
    ) ?? null,
  );
  const ids = all<HTMLButtonElement>('.sidebar-tools .tool-icon').map(
    (button) => button.getAttribute('data-tool') ?? '',
  );
  const personalId = personal.getAttribute('data-tool') ?? '';
  expect(ids.length >= 3, `the sidebar lists ${ids.length} tool(s)`);
  expect(ids[ids.length - 1] === personalId, 'the personal tool is not after the org tools');

  await openHome();
  const card = await waitForValue('the personal card', () =>
    all<HTMLElement>('.tool-card-personal').find(
      (node) => text(node.querySelector('h2')) === PERSONAL_TITLE,
    ) ?? null,
  );
  const warning = card.querySelector('.tool-warning');
  expect(
    warning !== null && text(warning).includes('Not from your org'),
    'the personal card has no "Not from your org" warning',
  );
  const favorite = card.querySelector<HTMLButtonElement>('button.favorite');
  expect(favorite !== null, 'the personal card has no favorite toggle');
  favorite.click();

  const first = await waitForValue('the favorite to lead the sidebar', () => {
    const buttons = all<HTMLButtonElement>('.sidebar-tools .tool-icon');
    const lead = buttons[0];
    return lead !== undefined && lead.getAttribute('data-tool') === personalId ? lead : null;
  });
  expect(first.classList.contains('favorite'), 'the first sidebar tool is not a favorite');
  await waitForValue('the card to show the favorite', () => {
    const current = all<HTMLElement>('.tool-card-personal').find(
      (node) => text(node.querySelector('h2')) === PERSONAL_TITLE,
    );
    const toggle = current?.querySelector('button.favorite');
    return toggle !== null && toggle !== undefined && toggle.classList.contains('favorite-on')
      ? toggle
      : null;
  });
  return `sidebar order: favorite ${personalId} first, org tools next; personal card warns`;
}

/**
 * RF-62, on the real surface while the guild is connected: the Tools tab's own form files two org
 * tools under two categories, then both screens draw one group per category with its tool under it.
 * What is asserted is the DOM — the Tools tab's headings and the cards beneath them, Home's section
 * headings and its cards — so a category that never reached the host fails here, as it would on the
 * screen: the screens read the category back from the snapshot, not from the form.
 */
async function checkToolCategories(): Promise<string> {
  await fileToolUnderCategory('cat-a', CATEGORIZED_A_TITLE, CATEGORY_A);
  await fileToolUnderCategory('cat-b', CATEGORIZED_B_TITLE, CATEGORY_B);

  // The Tools tab: one heading per category, each with its own tool's card under it.
  const groups = await waitForValue('both category groups in the Tools tab', () => {
    const found = all<HTMLElement>('.tool-group');
    const names = found.map((group) => text(group.querySelector(':scope > h3')));
    return names.includes(CATEGORY_A) && names.includes(CATEGORY_B) ? found : null;
  });
  for (const [category, title] of [
    [CATEGORY_A, CATEGORIZED_A_TITLE],
    [CATEGORY_B, CATEGORIZED_B_TITLE],
  ] as const) {
    const group = groups.find((node) => text(node.querySelector(':scope > h3')) === category);
    expect(group !== undefined, `the Tools tab has no heading for ${category}`);
    const cards = all<HTMLElement>(':scope > .card', group);
    expect(
      cards.some((card) => text(card).includes(title)),
      `the ${category} group of the Tools tab does not hold ${title}`,
    );
  }

  // Home: the same categories, one section each, its tool's card under it.
  await openHome();
  const sections = await waitForValue('both category sections in Home', () => {
    const found = all<HTMLElement>('.home-section');
    const names = found.map((section) => text(section.querySelector(':scope > .home-section-title')));
    return names.includes(CATEGORY_A) && names.includes(CATEGORY_B) ? found : null;
  });
  for (const [category, title] of [
    [CATEGORY_A, CATEGORIZED_A_TITLE],
    [CATEGORY_B, CATEGORIZED_B_TITLE],
  ] as const) {
    const section = sections.find(
      (node) => text(node.querySelector(':scope > .home-section-title')) === category,
    );
    expect(section !== undefined, `Home has no section for ${category}`);
    const cards = all<HTMLElement>('.tool-card', section);
    expect(
      cards.some((card) => text(card.querySelector('.tool-title')) === title),
      `Home's ${category} section does not hold ${title}`,
    );
  }
  return `Tools and Home group ${CATEGORY_A} and ${CATEGORY_B} with their tools`;
}

/** RF-62: the Tools tab's own form adds one org tool under a category, and waits for the save. */
async function fileToolUnderCategory(id: string, title: string, category: string): Promise<void> {
  await openSettingsTab('Tools');
  const add = await waitForControl('Add tool');
  add.click();
  const card = await waitForValue('the new tool card', () => cardHeading('New tool'));
  const url = card.querySelector<HTMLInputElement>('input[name=url]');
  const idField = card.querySelector<HTMLInputElement>('input[name=id]');
  const titleField = card.querySelector<HTMLInputElement>('input[name=title]');
  const categoryField = card.querySelector<HTMLInputElement>('input[name=category]');
  expect(
    url !== null && idField !== null && titleField !== null && categoryField !== null,
    'the tool form has no url/id/title/category field',
  );
  setValue(url, `${CONFIG.originC}/${id}`);
  setValue(idField, id);
  setValue(titleField, title);
  setValue(categoryField, category);
  const save = await waitForControl('Save', card);
  save.click();
  await waitForStatus(`Tool "${title}" saved`);
}

async function prepareShares(): Promise<void> {
  const list = (await call('catalog.list')) as unknown as EntryLite[];
  const a = list.find((entry) => entry.title === 'Tool A');
  const b = list.find((entry) => entry.title === 'Tool B');
  expect(a !== undefined && b !== undefined, 'the published tools left the catalog');

  // RF-65: `vault.save` without an `itemId` adds a credential (the tool's first one becomes its
  // default); every later call names the one it means by `itemId`, never by the tool.
  const role = await call('vault.save', {
    toolId: a.id,
    username: ROLE_USERNAME,
    secret: SHARED_SECRET,
  });
  const blocked = await call('vault.save', {
    toolId: b.id,
    username: BLOCKED_USERNAME,
    secret: BLOCKED_SECRET,
  });
  await call('vault.setScope', { itemId: role.id, scope: 'role' });
  await call('vault.setScope', { itemId: blocked.id, scope: 'blocked' });

  const person = await personOfEmail(CONFIG.personEmail);
  const other = await personOfEmail(CONFIG.otherEmail);
  await waitForValue('both colleagues pinned', async () => {
    const peers = await call('peers.list');
    const wanted = peers.filter(
      (peer) => peer.name === person.name || peer.name === other.name,
    );
    return wanted.length === 2 && wanted.every((peer) => peer.status === 'pinned') ? true : null;
  });
  const sent = await call('shares.send', {
    itemId: role.id,
    to: [person.id, other.id],
    password: PASSWORD,
  });
  expect(sent.sent === 2, `shares.send answered ${JSON.stringify(sent)}`);
  await synced();
}

async function checkBlockedAndSend(): Promise<string> {
  await openSettingsTab('Vault');
  const blocked = await waitForValue('the blocked credential card', () =>
    vaultCard('Tool B', BLOCKED_USERNAME),
  );
  const blockedSend = all<HTMLButtonElement>('button', blocked).find(textIs('Send'));
  expect(blockedSend === undefined, 'the blocked credential still offers Send');
  const scope = blocked.querySelector('select[name=scope]') as HTMLSelectElement | null;
  expect(scope !== null && scope.value === 'blocked', 'the blocked credential is not on Blocked');

  const role = await waitForValue('the role credential card', () => vaultCard('Tool A', ROLE_USERNAME));
  const send = await waitForControl('Send', role);
  send.click();
  const recipients = await waitForValue('the send dialog recipients', () => {
    const dialog = all<HTMLElement>('.send-dialog')[0];
    if (dialog === undefined) return null;
    const rows = all<HTMLElement>('.recipient', dialog);
    return rows.length >= 2 ? rows : null;
  }).catch((error: unknown) => {
    const why = all<HTMLElement>('.message-error').map(text).join(' | ');
    throw new Error(`${message(error)}; status: ${why || '(none)'}`);
  });
  const names = recipients.map(text);
  expect(
    names.some((line) => line.includes(CONFIG.personName)) &&
      names.some((line) => line.includes(CONFIG.otherName)),
    `the dialog lists ${JSON.stringify(names)}`,
  );
  await waitForValue('the send dialog Close', () => {
    const dialog = all<HTMLElement>('.send-dialog')[0];
    return dialog === undefined ? null : controlByText('Close', dialog);
  });
  const dialog = all<HTMLElement>('.send-dialog')[0];
  const close = controlByText('Close', dialog);
  expect(close !== null, 'the send dialog has no Close');
  close.click();
  return `blocked credential has no Send; the Role dialog lists ${recipients.length} recipients`;
}

/**
 * RF-65, on the real Vault tab: a tool may hold several credentials, and the person picks which one
 * autofill uses. The role credential of Tool A is already there (and is the tool's default, being
 * its first); save a second one through the form (a different username), the tool draws both under
 * one heading with exactly one "Default" chip on the first, "Use for autofill" on the second moves
 * the chip, and `vault.list` — the backend's own answer — marks the same one. Two credentials
 * collapsing into one, or the default not moving, fails here.
 */
async function checkSecondCredential(): Promise<string> {
  const list = (await call('catalog.list')) as unknown as EntryLite[];
  const a = list.find((entry) => entry.title === 'Tool A');
  expect(a !== undefined, 'the published tool left the catalog');
  await openSettingsTab('Vault');

  const form = await waitForValue('the Save credential card', () => cardHeading('Save credential'));
  const tool = form.querySelector<HTMLSelectElement>('select[name=tool]');
  const username = form.querySelector<HTMLInputElement>('input[name=username]');
  const secret = form.querySelector<HTMLInputElement>('input[name=secret]');
  expect(tool !== null && username !== null && secret !== null, 'the save form is missing a field');
  setValue(tool, a.id);
  setValue(username, SECOND_USERNAME);
  setValue(secret, SECOND_SECRET);
  (await waitForControl('Save credential', form)).click();

  const cards = await waitForValue('the two credentials of Tool A', () => {
    const found = vaultCards('Tool A');
    return found.length === 2 ? found : null;
  });
  const firstCard = vaultCard('Tool A', ROLE_USERNAME);
  const secondCard = vaultCard('Tool A', SECOND_USERNAME);
  expect(
    firstCard !== null && secondCard !== null && firstCard !== secondCard,
    'both credentials do not draw their own card',
  );
  const isDefault = (card: HTMLElement): boolean =>
    all<HTMLElement>('.chip', card).some((chip) => text(chip) === 'Default');
  const markedNow = cards.filter(isDefault);
  expect(markedNow.length === 1, `Tool A draws ${markedNow.length} "Default" chip(s)`);
  expect(markedNow[0] === firstCard, 'the "Default" chip is not on the first credential');
  expect(!isDefault(secondCard!), 'the second credential came out as the default');

  const use = await waitForControl('Use for autofill', secondCard!);
  use.click();
  await waitForValue('the "Default" chip to move to the second credential', () => {
    const marked = vaultCards('Tool A').filter(isDefault);
    return marked.length === 1 && marked[0] === vaultCard('Tool A', SECOND_USERNAME) ? true : null;
  });

  const items = (await call('vault.list')) as unknown as {
    toolId: string;
    username: string;
    isDefault: boolean;
  }[];
  const mine = items.filter((item) => item.toolId === a.id);
  expect(mine.length === 2, `vault.list holds ${mine.length} credential(s) of Tool A`);
  const marked = mine.filter((item) => item.isDefault);
  expect(
    marked.length === 1 && marked[0].username === SECOND_USERNAME,
    `the backend's default is ${JSON.stringify(marked.map((item) => item.username))}`,
  );
  expect(document.body.textContent?.includes(SECOND_SECRET) !== true, 'the second secret reached the DOM');
  return `Tool A holds 2 credentials under one heading; "Default" moved to ${SECOND_USERNAME}`;
}

async function checkHolders(): Promise<string> {
  await openSettingsTab('Vault');
  const lines = await waitForValue('the holders list', () => {
    const card = vaultCard('Tool A', ROLE_USERNAME);
    if (card === null) return null;
    const rows = all<HTMLElement>('.holders-list .holder', card);
    return rows.length >= 2 ? rows.map(text) : null;
  });
  for (const name of [CONFIG.personName, CONFIG.otherName]) {
    expect(lines.some((line) => line.includes(name)), `the holders list has no ${name}`);
  }
  expect(
    lines.some((line) => /Role · since \d{4}-\d{2}-\d{2}/.test(line)),
    `no holder row carries "Role · since <date>": ${JSON.stringify(lines)}`,
  );

  const adminText = await waitForValue('the admin credential holders card', () => {
    const admin = document.getElementById('credential-holders');
    if (admin === null) return null;
    if (!text(admin).includes('Tool A')) return null;
    return text(admin);
  });
  expect(
    adminText.includes(CONFIG.personName) && adminText.includes(CONFIG.otherName),
    'the admin holders card does not list both people',
  );
  expect(
    /Role · since \d{4}-\d{2}-\d{2}/.test(adminText),
    'the admin holders card carries no scope and date',
  );
  return 'both people hold Tool A with date and scope; the admin card lists it';
}

async function adminWork(): Promise<void> {
  await unlock(CONFIG.adminEmail);
  await synced();
  await waitForValue('both colleagues pinned', async () => {
    const peers = await call('peers.list');
    const wanted = peers.filter(
      (peer) => peer.name === CONFIG.personName || peer.name === CONFIG.otherName,
    );
    return wanted.length === 2 && wanted.every((peer) => peer.status === 'pinned') ? true : null;
  });
  // #30: a new access code for P, redeemed by the second machine after this launch. Reissuing does
  // not touch P's current session; the activation that redeems it is what re-keys the account.
  const person = await personOfEmail(CONFIG.personEmail);
  const code = await call('invites.issue', { personId: person.id, roles: ['team'] });
  expect(typeof code.code === 'string' && code.code.length > 0, 'no code for the second machine');
  await desk('/desk/code', { who: 'person2', code: code.code });
}

// ------------------------------------------------------------- phase: person inbox

async function acceptShare(): Promise<string> {
  await openSettingsTab('Vault');
  const row = await waitForValue('the incoming share', () => {
    const inbox = document.getElementById('vault-inbox');
    if (inbox === null) return null;
    return all<HTMLElement>('.inbox-row', inbox).find((node) =>
      text(node).includes('shared with you'),
    ) ?? null;
  }).catch((error: unknown) => {
    const inbox = document.getElementById('vault-inbox');
    throw new Error(
      `${message(error)}; inbox says ${JSON.stringify(inbox === null ? '(no inbox)' : text(inbox))}`,
    );
  });
  expect(text(row).includes('Tool A'), `the inbox row says ${JSON.stringify(text(row))}`);
  expect(text(row).includes(CONFIG.adminName), 'the inbox row does not name the sender');
  expect(document.body.textContent?.includes(SHARED_SECRET) !== true, 'the secret is already in the DOM');

  const accept = await waitForControl('Accept', row);
  accept.click();
  await passGate();
  await waitForValue('the share to leave the inbox', () => {
    const inbox = document.getElementById('vault-inbox');
    return inbox !== null && text(inbox).includes('No share is waiting.') ? true : null;
  });
  await waitForValue('the accepted credential', () => vaultCard('Tool A', ROLE_USERNAME));
  expect(document.body.textContent?.includes(SHARED_SECRET) !== true, 'accepting put the secret in the DOM');
  return 'the share is accepted and the credential is in the vault';
}

async function revealAndCopy(): Promise<string> {
  const reveal = await waitForValue('the Reveal button', () => {
    const card = vaultCard('Tool A', ROLE_USERNAME);
    return card === null ? null : controlByText('Reveal', card);
  });
  reveal.click();
  await passGate();
  const secret = await waitForValue('the revealed secret', () =>
    document.querySelector<HTMLElement>('.secret'),
  );
  expect(text(secret) === SHARED_SECRET, 'the revealed secret is not the sender\'s value');
  const countdown = document.querySelector('.reveal-count');
  expect(countdown !== null, 'the countdown did not appear with the secret');
  expect(/hides in \d+ s/.test(text(countdown)), `countdown = ${JSON.stringify(text(countdown))}`);

  await waitForValue(
    'the countdown to clear the secret',
    () => (document.querySelector('.secret') === null ? true : null),
    (value) => value === true,
    REVEAL_TIMEOUT_MS,
  );
  expect(
    document.body.textContent?.includes(SHARED_SECRET) !== true,
    'the secret is still in the DOM after the countdown',
  );

  const copy = await waitForValue('the Copy button', () => {
    const card = vaultCard('Tool A', ROLE_USERNAME);
    return card === null ? null : controlByText('Copy', card);
  });
  copy.click();
  await passGate();
  const status = await waitForStatus('Copied');
  expect(text(status).includes('never held it'), `copy status = ${text(status)}`);
  expect(document.querySelector('.secret') === null, 'Copy put the secret on screen');
  expect(document.body.textContent?.includes(SHARED_SECRET) !== true, 'Copy put the secret in the DOM');
  return 'revealed with a countdown, cleared at zero; Copy never rendered the value';
}

async function personInbox(): Promise<void> {
  await unlock(CONFIG.personEmail);
  await synced();
}

// ------------------------------------------------------------- phase: colleague key

async function confirmChangedKey(): Promise<string> {
  await openSettingsTab('Account');
  const row = await waitForValue('the changed colleague', () => {
    const card = cardHeading('Colleagues');
    if (card === null) return null;
    return all<HTMLElement>('.row', card).find(
      (node) => text(node).includes(CONFIG.personName) && text(node).includes('key changed'),
    ) ?? null;
  });
  const confirm = await waitForControl('Confirm', row);
  confirm.click();
  await waitForStatus('key confirmed');
  await waitForValue('the warning to clear', () => {
    const card = cardHeading('Colleagues');
    if (card === null) return null;
    const warns = all<HTMLElement>('.chip-warn', card).filter((node) =>
      text(node).includes('key changed'),
    );
    return warns.length === 0 ? true : null;
  });
  return 'the changed key is shown, Confirmed and the warning clears';
}

/**
 * The People tab carries the person's devices (#27) and, connected, the invites card of RF-59 — the
 * two codes the setup created are spent by now, so the list shows them used up.
 */
async function checkAdminDevices(): Promise<string> {
  await openSettingsTab('People');
  const invites = await waitForValue('the invites card', () => {
    const card = cardHeading('Invites');
    if (card === null) return null;
    return controlByText('Create invite', card) === null ? null : card;
  });
  await waitForValue('the invite list', () => {
    const rows = all<HTMLElement>('.invite-row');
    return rows.length >= 1 ? rows : null;
  });
  const statuses = all<HTMLElement>('.invite-row > .row > strong').map(text);
  const personCard = () =>
    all<HTMLElement>('.card').find(
      (node) =>
        text(node.querySelector(':scope > .row > strong')) === CONFIG.personName &&
        (controlByText('Devices', node) !== null || controlByText('Hide devices', node) !== null),
    );
  const devices = await waitForValue('the person devices button', () => {
    const card = personCard();
    return card === undefined ? null : controlByText('Devices', card);
  }).catch(async (error: unknown) => {
    let rpc = '';
    try {
      const list = (await call('people.list')) as unknown as { name: string }[];
      rpc = `people.list: ${list.map((person) => person.name).join(', ') || '(none)'}`;
    } catch (failure) {
      rpc = `people.list failed: ${message(failure)}`;
    }
    throw new Error(`${message(error)}; ${rpc}`);
  });
  devices.click();
  const rows = await waitForValue('the person device rows', () => {
    const card = personCard();
    if (card === undefined) return null;
    const found = all<HTMLElement>(':scope > .row', card).filter(
      (row) => controlByText('Revoke', row) !== null,
    );
    return found.length >= 1 ? found : null;
  }).catch((error: unknown) => {
    const card = personCard();
    const status = all<HTMLElement>('.message-error').map(text).join(' | ');
    throw new Error(
      `${message(error)}; card: ${JSON.stringify(card === undefined ? '(none)' : text(card))}; status: ${status || '(none)'}`,
    );
  });
  return `${rows.length} device row(s) with Revoke; invites card "${text(invites.querySelector('h2'))}" with ${statuses.length} row(s): ${statuses.join(', ')}`;
}

/**
 * #36 (RF-60): the Offline tile of the entry screen, on the real surface. Lock, enter through
 * Offline, and the guild is disconnected for the session exactly as O2 disconnects it: the banner
 * says so, the sidebar's top mark is the Offline glyph, and the guild's own tool (a row only the
 * snapshot carries) is gone from the sidebar while this machine's local tools stay. "Switch to
 * <guild>" locks again, and the guild tile brings the session back with that tool.
 *
 * `session.state().mode` and `host.state().offlineSession` are the backend's own answer to the same
 * question — the two reads below are the world state; everything else here is what the page draws.
 */
async function offlineEntry(): Promise<string> {
  const lockAction = all<HTMLButtonElement>('.sidebar-action').find((item) => text(item).includes('Lock'));
  expect(lockAction !== undefined, 'the sidebar has no Lock action');
  lockAction.click();
  await waitForValue('the entry rail after the lock', () => document.querySelector('.entry-rail .tile'));

  const offlineTile = await waitForValue('the Offline tile', () =>
    document.querySelector<HTMLButtonElement>('.entry-rail [data-tile=offline]'),
  );
  offlineTile.click();
  const password = await waitForValue('the offline password field', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=password]'),
  );
  setValue(password, PASSWORD);
  const enter = await waitForValue('the Enter offline button', () =>
    document.querySelector<HTMLButtonElement>('.entry-pane [data-action=enter-offline]'),
  );
  enter.click();
  await waitForValue('the offline shell', () => document.querySelector('.shell')).catch((error: unknown) => {
    const why = all<HTMLElement>('.entry-pane .message-error').map(text).join(' | ');
    throw new Error(`${message(error)}; the entry pane says ${why || '(nothing)'}`);
  });

  const state = (await call('session.state')) as unknown as { mode: string | null };
  const host = (await call('host.state')) as unknown as { offlineSession: boolean };
  expect(state.mode === 'offline', `session.state().mode = ${JSON.stringify(state.mode)}`);
  expect(host.offlineSession === true, `host.state().offlineSession = ${JSON.stringify(host.offlineSession)}`);
  const mark = text(document.querySelector('.sidebar .mark'));
  expect(mark === '⌂', `the sidebar mark reads ${JSON.stringify(mark)}`);

  const sentence = text(
    await waitForValue('the offline banner', () => {
      const line = all<HTMLElement>('.notice-text').find((node) => text(node).includes('is not syncing'));
      return line ?? null;
    }),
  );
  const switchTo = await waitForValue('the Switch to button', () =>
    all<HTMLButtonElement>('.notice button').find((item) => text(item).startsWith('Switch to ')) ?? null,
  );

  // Local mode on the sidebar: this machine's own tools are the catalog, the guild's is not there.
  const localTitles = await waitForValue('the local tools without the guild tool', () => {
    const titles = sidebarTitles();
    const local = titles.some((title) => title.startsWith('Tool A'));
    const foreign = titles.some((title) => title.includes(GUILD_ONLY_TITLE));
    return local && !foreign ? titles : null;
  });

  const label = text(switchTo);
  switchTo.click();
  await waitForValue('the entry rail after the switch', () => document.querySelector('.entry-rail .tile'));
  await unlock(CONFIG.adminEmail);

  const back = (await call('session.state')) as unknown as { mode: string | null };
  const backHost = (await call('host.state')) as unknown as { offlineSession: boolean };
  expect(back.mode === 'guild', `session.state().mode = ${JSON.stringify(back.mode)}`);
  expect(backHost.offlineSession === false, `host.state().offlineSession = ${JSON.stringify(backHost.offlineSession)}`);
  const backTitles = await waitForValue('the guild tool back in the sidebar', () => {
    const titles = sidebarTitles();
    return titles.some((title) => title.includes(GUILD_ONLY_TITLE)) ? titles : null;
  });
  return `banner "${sentence}" with "${label}"; offline sidebar ${localTitles.length} tool(s) without the guild's; back in guild mode with ${backTitles.length} tool(s)`;
}

// ------------------------------------------- phase: the invite and the seed (a Nod each)

/**
 * #37 (RF-59), on a Nod with no account and no host: the whole invite flow through the real entry
 * screen. `setupAdmin` created this invite through `guildInvites.create` (the non-admin `team` role)
 * and left its `nod://join` link on the desk with the guild icon stored; here the `+` tile takes the
 * pasted link, the card is read (guild name, role chip, the guild's icon as a data URI, the
 * fingerprint), and the account form that follows creates the person.
 *
 * `session.state().mode` and `people.list` are the backend's answer to what the join did; the
 * sidebar's own tools are the page's — a tool the invite's role is granted shows only because the
 * host gave this person that role.
 */
async function inviteJoinThroughUi(): Promise<string> {
  await waitForValue('the entry rail of a fresh Nod', () => document.querySelector('.entry-rail .tile'));
  expect(
    all('.entry-rail .tile-dot').length === 0,
    'a Nod with no host already shows a guild tile',
  );
  const joinTile = await waitForValue('the + tile', () =>
    document.querySelector<HTMLButtonElement>('.entry-rail [data-tile=join]'),
  );
  joinTile.click();

  const linkField = await waitForValue('the invite link field', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=join-link]'),
  );
  setValue(linkField, await handover('third'));
  (await waitForControl('Continue')).click();

  const card = await waitForValue('the invite card', () => document.querySelector('.invite-card')).catch(
    (error: unknown) => {
      const why = all<HTMLElement>('.entry-pane .message-error').map(text).join(' | ');
      throw new Error(`${message(error)}; the entry pane says ${why || '(nothing)'}`);
    },
  );
  const head = text(card.querySelector('.invite-head h2'));
  expect(head === CONFIG.guildName, `the card names ${JSON.stringify(head)}`);
  const invited = text(card.querySelector('.invite-head .muted'));
  expect(invited.includes("You've been invited"), `the card says ${JSON.stringify(invited)}`);
  const roles = all<HTMLElement>('.invite-roles .chip').map(text);
  expect(roles.includes(TEAM_ROLE_NAME), `the card lists roles ${JSON.stringify(roles)}`);
  expect(
    !roles.some((role) => role.toLowerCase() === 'admin'),
    `the invite card offers an admin role: ${JSON.stringify(roles)}`,
  );
  const icon = card.querySelector<HTMLImageElement>('img.invite-icon');
  expect(icon !== null, 'the invite card shows no guild icon');
  const src = icon.getAttribute('src') ?? '';
  expect(
    src.startsWith('data:image/png;base64,') && src.length > 32,
    `the guild icon src is ${JSON.stringify(src.slice(0, 32))}…`,
  );
  const fingerprint = text(card.querySelector('.fingerprint'));
  expect(fingerprint.length >= 8 && fingerprint.includes('-'), `the card fingerprint is ${JSON.stringify(fingerprint)}`);

  (await waitForControl('Accept invite', card)).click();
  const name = await waitForValue('the name field of the account form', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=name]'),
  );
  const email = document.querySelector<HTMLInputElement>('.entry-pane input[name=email]');
  const password = document.querySelector<HTMLInputElement>('.entry-pane input[name=password]');
  const confirm = document.querySelector<HTMLInputElement>('.entry-pane input[name=confirm]');
  expect(email !== null && password !== null && confirm !== null, 'the account form is missing a field');
  setValue(name, CONFIG.thirdName);
  setValue(email, CONFIG.thirdEmail);
  setValue(password, PASSWORD);
  setValue(confirm, PASSWORD);
  (await waitForControl('Join the guild')).click();
  await waitForValue('the joined shell', () => document.querySelector('.shell')).catch((error: unknown) => {
    const why = all<HTMLElement>('.entry-pane .message-error').map(text).join(' | ');
    throw new Error(`${message(error)}; the entry pane says ${why || '(nothing)'}`);
  });

  // The same nudge every other join path of this smoke takes: the first snapshot is what fills the
  // sidebar of this new member (its own catalog is empty), and `host.syncNow` is every person's call.
  await synced();
  const state = (await call('session.state')) as unknown as {
    mode: string | null;
    person: { email: string; roles: string[] } | null;
  };
  expect(state.mode === 'guild', `session.state().mode = ${JSON.stringify(state.mode)}`);
  expect(
    state.person !== null && state.person.email === CONFIG.thirdEmail,
    `the joined person is ${JSON.stringify(state.person === null ? null : state.person.email)}`,
  );
  const host = (await call('host.state')) as unknown as { offlineSession: boolean };
  expect(host.offlineSession === false, `host.state().offlineSession = ${JSON.stringify(host.offlineSession)}`);
  // The role the invite granted, as its effect on the member's own screen: the guild's tools are
  // granted to `team` alone (`setupAdmin`), so a sidebar that carries them is a person the host put
  // in that role. The roster itself is read again on the admin's page (`admin-final`), because a
  // member's local person row carries no roles while connected (the host is the one that holds them)
  // and `people.list` is the admin's call.
  const titles = await waitForValue("the team role's tools in the new member's sidebar", () => {
    const list = sidebarTitles();
    return list.some((title) => title.includes('Tool A')) ? list : null;
  }).catch(async (error: unknown) => {
    // What the page and the backend say when the sidebar stays empty: whether the catalog and the
    // tools are there and the screen is stale, or neither of them arrived at all.
    const timed = async <T>(run: Promise<T>): Promise<T | string> =>
      await Promise.race([run, sleep(3000).then(() => 'no answer in 3000 ms')]).catch(
        (why: unknown) => `error: ${message(why)}`,
      );
    const page = await timed(call('tools.state'));
    const tools =
      typeof page === 'object' && page !== null && 'tools' in page && Array.isArray(page.tools)
        ? page.tools.length
        : null;
    const entries = await timed(call('catalog.list'));
    const sizes = Array.isArray(entries) ? `${entries.length} entry(ies)` : String(entries);
    const banner = all<HTMLElement>('.shell .banner .message, .shell .notice')
      .map(text)
      .join(' | ');
    throw new Error(
      `${message(error)}; the shell has ${all('.sidebar-tools > *').length} sidebar node(s) ` +
        `and titles ${JSON.stringify(sidebarTitles())}; tools.state ${
          tools === null ? String(page) : `${tools} tool(s)`
        }; catalog.list ${sizes}; banner ${banner || '(nothing)'}`,
    );
  });
  return `card "${head}" with role ${TEAM_ROLE_NAME} and the guild icon; joined in ${state.mode} mode as ${state.person?.email}; ${titles.length} tool(s) of the team role in the sidebar`;
}

/**
 * #38 (RF-61), on a Nod with no account, no host and no tool of its own: the optional seed import of
 * the first run. The check clicks "Import a seed file" on the Offline pane. **The file picker itself
 * is not driven** — a native dialog cannot be answered headlessly, so `tiny.dialog.openFile` is
 * answered here with the runner's fake seed file (`.gerado/import-seed.json`, version 2); the call,
 * the re-read of `session.profiles`, the pane and the account that follows are the page's own.
 *
 * The imported seed carries an invite and a tool behind that invite's role, which is what makes the
 * import observable on screen: the form gains the invite code the seed brought, and after the
 * account is created with that code the imported tool is in the sidebar — it shows for that role
 * alone. Nothing is restored on the dialog: the launch ends with this check.
 */
async function seedImport(): Promise<string> {
  const title = await waitForValue('the first-run Offline pane', () => {
    const head = document.querySelector('.entry-pane .entry-title');
    return head !== null && text(head) === 'Set up Nod on this machine' ? head : null;
  });
  expect(
    document.querySelector('.entry-pane input[name=code]') === null,
    'a fresh Nod already asks for an invite code',
  );
  const importButton = await waitForControl('Import a seed file');

  // The picker is the one thing this smoke cannot drive: a native dialog has no headless answer. The
  // check answers `tiny.dialog.openFile` in place when the runtime lets it be replaced — so the
  // button, its handler and everything after it are the real ones — and falls back to calling
  // `session.importSeed` itself (the page still re-reads the tiles, which is what the backend's
  // `session` push makes it do) when it does not. Either way the file picker is not driven, and the
  // detail below says which of the two ran.
  const dialog: unknown = smokeWindow.tiny?.dialog;
  let picker = '`session.importSeed` called by the check (no `tiny.dialog` to answer; the picker is not driven)';
  let pickerPatched = false;
  if (
    dialog !== null &&
    dialog !== undefined &&
    typeof dialog === 'object' &&
    'openFile' in dialog &&
    typeof dialog.openFile === 'function'
  ) {
    // The runtime's own bridge object: this named cast is where the file says what the one member it
    // touches takes, and the guard above is what proved the member is there.
    const bridge = dialog as { openFile: () => Promise<string | null> };
    try {
      bridge.openFile = async () => CONFIG.seedPath;
      pickerPatched = true;
      picker =
        'the button clicked, `tiny.dialog.openFile` answered by the check (the picker itself is not driven)';
    } catch {
      picker =
        '`session.importSeed` called by the check (the picker cannot be answered in place; it is not driven)';
    }
  }
  if (pickerPatched) importButton.click();
  else await call('session.importSeed', { path: CONFIG.seedPath });

  // The pane read the tiles again: the seed's own open invite is what puts the code field there.
  const code = await waitForValue('the account form of the imported seed', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=code]'),
  ).catch((error: unknown) => {
    const why = all<HTMLElement>('.entry-pane .message-error').map(text).join(' | ');
    throw new Error(`${message(error)}; the entry pane says ${why || '(nothing)'}`);
  });
  const fields = [...document.querySelectorAll('.entry-pane .field-label')].map((node) => text(node));
  expect(fields.includes('Invite code'), `the form says ${JSON.stringify(fields)}`);

  const name = document.querySelector<HTMLInputElement>('.entry-pane input[name=name]');
  const email = document.querySelector<HTMLInputElement>('.entry-pane input[name=email]');
  const password = document.querySelector<HTMLInputElement>('.entry-pane input[name=password]');
  const confirm = document.querySelector<HTMLInputElement>('.entry-pane input[name=confirm]');
  expect(
    name !== null && email !== null && password !== null && confirm !== null,
    'the create form is missing a field',
  );
  setValue(name, CONFIG.thirdName);
  setValue(email, CONFIG.thirdEmail);
  setValue(password, PASSWORD);
  setValue(confirm, PASSWORD);
  // The code of the seed's own invite, from the desk: the generated page carries it nowhere.
  setValue(code, await handover('import'));
  const create = await waitForValue('the Create account button', () =>
    document.querySelector<HTMLButtonElement>('.entry-pane [data-action=create]'),
  );
  create.click();
  await waitForValue('the shell of the created account', () => document.querySelector('.shell')).catch(
    (error: unknown) => {
      const why = all<HTMLElement>('.entry-pane .message-error').map(text).join(' | ');
      throw new Error(`${message(error)}; the entry pane says ${why || '(nothing)'}`);
    },
  );

  const titles = await waitForValue('the imported tool in the sidebar', () => {
    const list = sidebarTitles();
    return list.some((title) => title.includes(IMPORT_TOOL_TITLE)) ? list : null;
  });
  const state = (await call('session.state')) as unknown as {
    mode: string | null;
    person: { roles: string[] } | null;
  };
  expect(
    state.person !== null && state.person.roles.includes(IMPORT_ROLE_ID),
    `the created person's roles are ${JSON.stringify(state.person?.roles ?? null)}`,
  );
  const info = (await call('nod.info')) as unknown as { seedVersion: number | null };
  expect(info.seedVersion === 2, `nod.info().seedVersion = ${JSON.stringify(info.seedVersion)}`);
  return `pane "${text(title)}" → imported ${CONFIG.seedPath} (${picker}) → the form asked for the seed's invite code → account created in ${state.mode} mode with role ${IMPORT_ROLE_ID}, ${titles.length} tool(s) in the sidebar incl. ${IMPORT_TOOL_TITLE}; seedVersion ${info.seedVersion}`;
}

/**
 * #37's other half, on the admin's own page: the roster holds the member the invite created, with the
 * role the invite granted. The member's own sidebar (the check before this one) shows the effect; this
 * shows the fact, on the screen that reads the host's people — the third member joined after the work
 * of `admin-work` and before this stage, so the People tab lists them here.
 */
async function thirdMemberOnRoster(): Promise<string> {
  await openSettingsTab('People');
  const card = await waitForValue('the roster card of the invited member', () => {
    const found = all<HTMLElement>('.card').find(
      (node) => text(node.querySelector(':scope > .row > strong')) === CONFIG.thirdName,
    );
    return found ?? null;
  });
  const boxes = all<HTMLInputElement>('input[type=checkbox]', card).map((box) => ({
    role: text(box.parentElement),
    checked: box.checked,
  }));
  // The host's own answer for the same person, so a failure says which half disagreed.
  const roster = (await call('people.list')) as unknown as {
    name: string;
    email: string;
    roles: string[];
    admin: boolean;
  }[];
  const invited = roster.find((person) => person.email === CONFIG.thirdEmail) ?? null;
  const why = JSON.stringify({
    boxes: boxes.map((box) => `${box.role}:${box.checked}`),
    roster: invited,
    card: text(card).slice(0, 160),
  });
  expect(
    boxes.some((box) => box.role === TEAM_ROLE_NAME && box.checked),
    `the invite's role is not ticked — ${why}`,
  );
  expect(
    !boxes.some((box) => box.role === 'Admin' && box.checked),
    `an invite granted the admin role — ${why}`,
  );
  return `${CONFIG.thirdName} is on the roster with ${TEAM_ROLE_NAME} ticked and Admin not`;
}

/**
 * RF-64 (0.5.3), on the real People tab: the guild owner — the person the setup code created — is
 * the one the roster badges, and the only one the cards let manage a person. The checks below drive
 * the owner's card, Edit and Delete through the page; `people.list` is the host's own answer to the
 * same question (the list the tab reloads after each write), read beside the screen.
 */
async function checkOwnerChip(): Promise<string> {
  await openSettingsTab('People');
  const card = await waitForValue('the owner card', () => {
    const found = cardOf(CONFIG.adminName, CONFIG.adminEmail);
    return found !== null && controlByText('Edit', found) !== null ? found : null;
  });
  const chips = all<HTMLElement>('.chip', card).map(text);
  expect(chips.includes('Owner'), `the owner card carries ${JSON.stringify(chips)}`);
  // The owner's own row has no Delete: the host refuses deleting the owner, and the page knows it.
  expect(controlByText('Delete', card) === null, 'the owner card offers Delete');

  const extra = await waitForValue('the throwaway member card', () =>
    cardOf(CONFIG.extraName, CONFIG.extraEmail),
  );
  const extraChips = all<HTMLElement>('.chip', extra).map(text);
  expect(
    !extraChips.includes('Owner'),
    `the throwaway member is badged Owner: ${JSON.stringify(extraChips)}`,
  );
  expect(controlByText('Delete', extra) !== null, 'the throwaway member offers no Delete');
  return `the owner card carries ${JSON.stringify(chips)} and no Delete; ${CONFIG.extraName} carries no Owner chip and offers Edit and Delete`;
}

/** RF-64: the owner opens Edit on a member card, changes the name and the email, and saves. */
async function renamePerson(): Promise<string> {
  await openSettingsTab('People');
  const edit = await waitForValue('the Edit button of the throwaway member', () => {
    const card = cardOf(CONFIG.extraName, CONFIG.extraEmail);
    return card === null ? null : controlByText('Edit', card);
  });
  edit.click();
  // The form is the card's own; the two fields come prefilled with what the host holds.
  const form = await waitForValue('the person editor', () => {
    const card = cardOf(CONFIG.extraName, CONFIG.extraEmail);
    if (card === null) return null;
    const name = card.querySelector<HTMLInputElement>('input[name=person-edit-name]');
    const email = card.querySelector<HTMLInputElement>('input[name=person-edit-email]');
    return name !== null && email !== null ? { card, name, email } : null;
  });
  expect(form.name.value === CONFIG.extraName, `the name field reads ${JSON.stringify(form.name.value)}`);
  expect(form.email.value === CONFIG.extraEmail, `the email field reads ${JSON.stringify(form.email.value)}`);
  setValue(form.name, EXTRA_NEW_NAME);
  setValue(form.email, EXTRA_NEW_EMAIL);
  (await waitForValue('the Save button of the person editor', () => controlByText('Save', form.card))).click();
  await waitForStatus('Saved');

  // The card the tab reloaded carries the new name and email, and the host holds the same person.
  const card = await waitForValue('the renamed member card', () =>
    cardOf(EXTRA_NEW_NAME, EXTRA_NEW_EMAIL),
  );
  expect(controlByText('Edit', card) !== null, 'the renamed card lost its Edit');
  const roster = (await call('people.list')) as unknown as { name: string; email: string }[];
  const renamed = roster.find((person) => person.email === EXTRA_NEW_EMAIL) ?? null;
  expect(
    renamed !== null && renamed.name === EXTRA_NEW_NAME,
    `the host lists ${JSON.stringify(renamed)}`,
  );
  expect(
    !roster.some((person) => person.email === CONFIG.extraEmail),
    'the host still lists the old email',
  );
  return `the card shows ${EXTRA_NEW_NAME} <${EXTRA_NEW_EMAIL}> and the host lists the same name and email`;
}

/** RF-64: the owner deletes a member — a native `confirm` the driver answers, then the card goes. */
async function deletePerson(): Promise<string> {
  await openSettingsTab('People');
  const remove = await waitForValue('the Delete button of the renamed member', () => {
    const card = cardOf(EXTRA_NEW_NAME, EXTRA_NEW_EMAIL);
    return card === null ? null : controlByText('Delete', card);
  });
  remove.click();
  await waitForStatus('Removed');
  await waitForValue('the card to leave the roster', () =>
    cardOf(EXTRA_NEW_NAME, EXTRA_NEW_EMAIL) === null ? true : null,
  );
  const roster = (await call('people.list')) as unknown as { email: string }[];
  expect(
    !roster.some((person) => person.email === EXTRA_NEW_EMAIL),
    'the host still lists the deleted member',
  );
  return `${EXTRA_NEW_NAME} left the roster and the host's people list`;
}

async function updateRequiredBanner(): Promise<string> {
  // The tool this check turns on: an org tool of the guild's catalog that this machine's local
  // tables never held. The store's own A and B are local rows too, so they stay in the sidebar either
  // way (`temporarySeed`); this one can only come from the snapshot.
  const before = await waitForValue('the guild tool in the sidebar', () => {
    const titles = sidebarTitles();
    return titles.some((title) => title.includes(GUILD_ONLY_TITLE)) ? titles : null;
  });

  const stopped = await desk('/desk/host', { action: 'stop' });
  expect(String(stopped.detail ?? '').includes('stopped'), `host stop: ${String(stopped.detail)}`);
  const started = await desk('/desk/host', {
    action: 'start',
    minAppVersion: UPDATE_MIN_VERSION,
  });
  expect(String(started.detail ?? '').includes('up'), `host start: ${String(started.detail)}`);

  await openSettingsTab('Hosts');
  const sync = await waitForValue('the Sync now button', () => {
    const card = all<HTMLElement>('section.card').find(
      (node) => controlByText('Sync now', node) !== null,
    );
    return card === undefined ? null : controlByText('Sync now', card);
  });
  sync.click();
  const banner = await waitForValue('the update-required banner', () =>
    document.querySelector('.notice-danger'),
  );
  const sentence = text(banner);
  expect(sentence.includes('needs a newer Nod'), `banner = ${JSON.stringify(sentence)}`);
  expect(sentence.includes(UPDATE_MIN_VERSION), 'the banner does not name the required version');
  expect(sentence.includes('disconnected'), `banner = ${JSON.stringify(sentence)}`);
  expect(!sentence.includes('read-only'), `the banner still says read-only: ${JSON.stringify(sentence)}`);
  expect(controlByText('Check for updates', banner) !== null, 'the banner has no update action');

  // The guild is disconnected: its own tool left the sidebar and the local catalog took over — the
  // personal tool of the snapshot went with it, and the local rows are what is left.
  const after = await waitForValue('the guild tool to leave the sidebar', () => {
    const titles = sidebarTitles();
    return titles.some((title) => title.includes(GUILD_ONLY_TITLE)) ? null : titles;
  });
  expect(
    after.some((title) => title.includes('Tool A')) && after.some((title) => title.includes('Tool B')),
    `the local catalog is not what the sidebar shows: ${JSON.stringify(after)}`,
  );
  expect(
    !after.some((title) => title.includes(PERSONAL_TITLE)),
    `a personal tool of the snapshot is still shown: ${JSON.stringify(after)}`,
  );
  // Settings → Hosts is the one screen that still shows the guild, with the reason on its card.
  const reason = all<HTMLElement>('.message-error')
    .map(text)
    .find((line) => line.includes('needs a newer Nod'));
  expect(reason !== undefined, 'the host card does not say why the guild is disconnected');

  return `banner: ${sentence}; sidebar ${before.length} → ${after.length} tool(s), guild tool gone`;
}

async function adminFinal(): Promise<void> {
  await unlock(CONFIG.adminEmail);
  await synced();
  // O2/#28: one org tool this machine has never had locally, so the sidebar can show the guild's
  // catalog leaving when the guild asks for a newer Nod.
  await call('catalog.save', {
    entry: {
      id: 'guild-only',
      title: GUILD_ONLY_TITLE,
      url: `${CONFIG.originC}/guild-only`,
      icon: null,
      order: 15,
      roles: [],
      views: [],
      auth: null,
      active: true,
    },
  });
  await synced();
  const start = Date.now();
  let last = '';
  for (;;) {
    const peers = await call('peers.list');
    const person = peers.find((peer) => peer.name === CONFIG.personName);
    last = peers.map((peer) => `${peer.name}:${peer.status}`).join(', ') || '(none)';
    if (person !== undefined && person.status === 'changed') break;
    if (Date.now() - start > STATE_TIMEOUT_MS) {
      throw new Error(`timeout (${STATE_TIMEOUT_MS} ms) waiting for the changed key; peers: ${last}`);
    }
    await sleep(POLL_MS);
  }
}

// ------------------------------------------------------------- harness

type Steps = ReadonlyArray<readonly [string, () => Promise<string> | string]>;

const PHASES: Record<string, { setup?: () => Promise<void>; checks: Steps }> = {
  'admin-setup': {
    setup: setupAdmin,
    checks: [['setup: activate, publish, people and codes', () => 'admin world ready']],
  },
  'person-join': {
    setup: joinPerson,
    checks: [
      ['#25 keep local tools', checkKeepLocalTools],
      ['#27 account devices', checkPersonDevices],
      ['#29 key fingerprint', checkFingerprint],
    ],
  },
  'admin-work': {
    setup: adminWork,
    checks: [
      ['#24 add personal tool dialog', addPersonalTool],
      ['#24 sidebar order and favorite', checkSidebarOrder],
      ['#34 blocked and role send', async () => {
        await prepareShares();
        return await checkBlockedAndSend();
      }],
      ['RF-65 second credential and the default chip', checkSecondCredential],
      ['RF-62 tools grouped by category', checkToolCategories],
    ],
  },
  'person-inbox': {
    setup: personInbox,
    checks: [
      ['#32 accept the incoming share', acceptShare],
      ['#33 reveal countdown and copy', revealAndCopy],
    ],
  },
  'third-join': {
    checks: [['#37 invite join through the entry screen', inviteJoinThroughUi]],
  },
  'seed-import': {
    checks: [['#38 seed import at first run', seedImport]],
  },
  'admin-final': {
    setup: adminFinal,
    checks: [
      ['#35 holders list and admin card', checkHolders],
      ['#30 changed colleague key', confirmChangedKey],
      ['#27 admin sees the person devices', checkAdminDevices],
      ["#37 the invite's role on the roster", thirdMemberOnRoster],
      // RF-64 runs while the guild is connected: the two steps after these take the host's version
      // away (the O2 banner), and `people.*` needs the guild.
      ['RF-64 owner chip on the roster', checkOwnerChip],
      ['RF-64 the owner renames a member', renamePerson],
      ['RF-64 the owner deletes a member', deletePerson],
      ['#36 offline tile entry', offlineEntry],
      ['#28 update-required banner', updateRequiredBanner],
    ],
  },
};

async function run(): Promise<void> {
  const phase = PHASES[CONFIG.phase];
  if (phase === undefined) throw new Error(`unknown phase ${CONFIG.phase}`);
  if (phase.setup !== undefined) {
    await phase.setup();
  }
  let stopped = false;
  for (const [name, fn] of phase.checks) {
    if (stopped) {
      record(name, false, 'did not run', 0);
      continue;
    }
    const start = Date.now();
    let ok = false;
    let detail = '';
    try {
      detail = await fn();
      ok = true;
    } catch (error) {
      detail = `error: ${message(error)}`;
    }
    record(name, ok, detail, Date.now() - start);
    stopped = !ok;
    await writeResult(false, null);
  }
}

(async function () {
  'use strict';
  // A dev-run flow may ask for native confirmation (`peers.confirm`, holder revoke). This page is
  // unattended: answer it, as the person at the screen would.
  window.confirm = () => true;
  try {
    await waitForTiny();
    // The runtime throttles an occluded or hidden window (`docs/tinyjs.md` §3, §10.11), and a
    // scripted run's window sits behind whatever the person has on screen. There the reveal's
    // ten-second countdown — ten seconds with nothing crossing the native bridge — was followed by
    // calls that never returned, and the smoke stalled in `person-inbox` after `#32`. The driver
    // brings its own app up front first, so the page it drives is the live surface the checks read.
    await tiny.win.show({ activate: true });
    window.confirm = () => true;
    await waitForValue('the app root', () =>
      document.getElementById('app')?.childElementCount !== undefined &&
      document.getElementById('app')!.childElementCount > 0
        ? document.getElementById('app')
        : null,
    );
    await run();
    await writeResult(true, null);
  } catch (error) {
    record('0 setup', false, `error: ${message(error)}`, 0);
    await writeResult(true, message(error));
  }
})();
