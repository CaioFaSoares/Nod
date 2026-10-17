// Driver of the real-page UI smoke (`test/smoke/ui.ts`, story checks #24, #25, #27–#35).
//
// The generated page imports `src/app.ts` exactly as `index.html` does, then this module. It runs
// after the app has booted and drives the real screens with DOM events: every acceptance check
// below reads what the page shows and clicks or types on it. `call` is used only to set the world
// up (create the account, publish tools, create people, save and share credentials, restart the
// host); a check never asserts an RPC answer.
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
  adminName: string;
  personName: string;
  otherName: string;
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
const LOCAL_TOOL_TITLE = 'Local Notes';
const LOCAL_DESK_TITLE = 'Local Desk';
/** The host's O2 minimum for the last check. Above `tinyjs.json`'s version. */
const UPDATE_MIN_VERSION = '9.9.9';

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

function setValue(field: HTMLInputElement, value: string): void {
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

async function handover(who: 'person' | 'other' | 'person2'): Promise<string> {
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

/** A fresh session on the real shell: the app answers the push by building its sidebar and Home. */
async function unlock(email: string): Promise<void> {
  const state = await call('session.unlock', { email, password: PASSWORD });
  expect(state.unlocked === true, `session.unlock answered unlocked=${JSON.stringify(state.unlocked)}`);
  await waitForValue('the unlocked shell', () => document.querySelector('.shell'));
  await waitForValue('the Home screen', () => {
    const title = document.querySelector('.content-title');
    return title !== null && text(title) === 'Tools' ? title : null;
  });
}

async function synced(): Promise<void> {
  const state = await call('host.syncNow');
  expect(state.status === 'connected', `host.state.status = ${JSON.stringify(state.status)}`);
}

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
  for (const [email, name, who] of [
    [CONFIG.personEmail, CONFIG.personName, 'person'],
    [CONFIG.otherEmail, CONFIG.otherName, 'other'],
  ] as const) {
    const answer = await call('invites.issue', { email, name, roles: ['team'], days: 1 });
    expect(
      typeof answer.code === 'string' && answer.code.length > 0,
      `invites.issue answered no code for ${email}`,
    );
    await desk('/desk/code', { who, code: answer.code });
  }

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
  await activateWithCode(CONFIG.personEmail, code);
  await waitForValue('the person sidebar', () => document.querySelector('.sidebar'));
  await synced();
  const mine = await call('keys.mine');
  expect(mine.fingerprint !== null, 'the person machine has no key pair after the activation');
}

async function joinOther(): Promise<void> {
  const state = await call('session.state');
  expect(state.hasAccount === false, 'the second member app id is not a fresh installation');
  const code = await handover('other');
  await activateWithCode(CONFIG.otherEmail, code);
  await waitForValue('the second member sidebar', () => document.querySelector('.sidebar'));
  await synced();
  const mine = await call('keys.mine');
  expect(mine.fingerprint !== null, 'the second member machine has no key pair after the activation');
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

async function prepareShares(): Promise<void> {
  const list = (await call('catalog.list')) as unknown as EntryLite[];
  const a = list.find((entry) => entry.title === 'Tool A');
  const b = list.find((entry) => entry.title === 'Tool B');
  expect(a !== undefined && b !== undefined, 'the published tools left the catalog');

  await call('vault.save', {
    toolId: a.id,
    username: ROLE_USERNAME,
    secret: SHARED_SECRET,
  });
  await call('vault.save', {
    toolId: b.id,
    username: BLOCKED_USERNAME,
    secret: BLOCKED_SECRET,
  });
  await call('vault.setScope', { toolId: a.id, scope: 'role' });
  await call('vault.setScope', { toolId: b.id, scope: 'blocked' });

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
    toolId: a.id,
    to: [person.id, other.id],
    password: PASSWORD,
  });
  expect(sent.sent === 2, `shares.send answered ${JSON.stringify(sent)}`);
  await synced();
}

async function checkBlockedAndSend(): Promise<string> {
  await openSettingsTab('Vault');
  const blocked = await waitForValue('the blocked credential card', () =>
    cardOf('Tool B', BLOCKED_USERNAME),
  );
  const blockedSend = all<HTMLButtonElement>('button', blocked).find(textIs('Send'));
  expect(blockedSend === undefined, 'the blocked credential still offers Send');
  const scope = blocked.querySelector('select[name=scope]') as HTMLSelectElement | null;
  expect(scope !== null && scope.value === 'blocked', 'the blocked credential is not on Blocked');

  const role = await waitForValue('the role credential card', () => cardOf('Tool A', ROLE_USERNAME));
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

async function checkHolders(): Promise<string> {
  await openSettingsTab('Vault');
  const lines = await waitForValue('the holders list', () => {
    const card = cardOf('Tool A', ROLE_USERNAME);
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
  await waitForValue('the accepted credential', () => cardOf('Tool A', ROLE_USERNAME));
  expect(document.body.textContent?.includes(SHARED_SECRET) !== true, 'accepting put the secret in the DOM');
  return 'the share is accepted and the credential is in the vault';
}

async function revealAndCopy(): Promise<string> {
  const reveal = await waitForValue('the Reveal button', () => {
    const card = cardOf('Tool A', ROLE_USERNAME);
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
    const card = cardOf('Tool A', ROLE_USERNAME);
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

/**
 * #35 needs both people in the holders list, and a holder row is written when the recipient accepts
 * (the host only records the owner at send). Q's side is setup, not a check: the RPC path is the
 * same one the real page drives, and no screen of Q's is under test.
 */
async function otherAccepts(): Promise<void> {
  await unlock(CONFIG.otherEmail);
  await synced();
  const inbox = (await call('shares.inbox')) as unknown as { id: string }[];
  expect(inbox.length >= 1, 'the second member has no share waiting');
  for (const share of inbox) {
    await call('shares.accept', { id: share.id, password: PASSWORD });
  }
  await synced();
}

// ------------------------------------------------------------- phase: second machine

async function secondPersonMachine(): Promise<void> {
  const state = await call('session.state');
  expect(state.hasAccount === false, 'the second person app id is not a fresh installation');
  const code = await handover('person2');
  await activateWithCode(CONFIG.personEmail, code);
  await waitForValue('the second machine sidebar', () => document.querySelector('.sidebar'));
  await synced();
  const mine = await call('keys.mine');
  expect(mine.fingerprint !== null, 'the second machine has no key pair after the activation');
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

async function checkAdminDevices(): Promise<string> {
  await openSettingsTab('People');
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
  return `${rows.length} device row(s) with Revoke`;
}

async function updateRequiredBanner(): Promise<string> {
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
  expect(controlByText('Check for updates', banner) !== null, 'the banner has no update action');
  return `banner: ${sentence}`;
}

async function adminFinal(): Promise<void> {
  await unlock(CONFIG.adminEmail);
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
  'person2-join': {
    setup: joinOther,
    checks: [['setup: the second member joined', () => 'Q is a member with keys']],
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
    ],
  },
  'person-inbox': {
    setup: personInbox,
    checks: [
      ['#32 accept the incoming share', acceptShare],
      ['#33 reveal countdown and copy', revealAndCopy],
    ],
  },
  'other-accept': {
    setup: otherAccepts,
    checks: [['setup: the second member accepted', () => 'Q holds the credential']],
  },
  'person-second-machine': {
    setup: secondPersonMachine,
    checks: [['setup: the second machine activated with a new code', () => 'P has a new key']],
  },
  'admin-final': {
    setup: adminFinal,
    checks: [
      ['#35 holders list and admin card', checkHolders],
      ['#30 changed colleague key', confirmChangedKey],
      ['#27 admin sees the person devices', checkAdminDevices],
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
