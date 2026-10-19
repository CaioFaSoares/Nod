// Driver of the real-surface E03 smoke (`test/smoke/tabs.ts`): RF-49…RF-52 and RF-66…RF-68 on the
// real page inside tinyjs, with a real tool window per tab.
//
// The generated page imports `src/app.ts` exactly as `index.html` does, then this module. Everything
// below reads what the page shows and clicks or types on it; `call` is used only where a screen cannot
// answer by itself (the tab list, the catalog, the session) and to set the account up. The tool
// windows are driven through their own reporting pages (`startTabTools`): the driver queues one-shot
// commands through the runner's desk and reads the reports back.
//
// Geometry, and why it is measured the way it is (all of it `execucao`, this machine):
//
// - a tool page cannot read its own window: `tiny.win.getState()` is an api-gated bridge method and
//   `scripts/gen-config.ts` gives a tool origin only `login.report`/`media.*`, so the call comes back
//   `"win.getState" is disabled by tinyjs.json "api"` (the step details carry the exact sentence);
//   `window.screenX/screenY` are `0,1490` and `window.outerWidth/outerHeight` are `0x0` in a WKWebView
//   (`backend/tiny.d.ts`, `TinyWinState.outer`). What a tool page *can* report of itself is therefore
//   its page box (`window.innerWidth/innerHeight`), its `performance.timeOrigin` and its draft.
// - the slot's screen rect comes from this page: `tiny.win.getState()` of the main window plus the
//   slot's `getBoundingClientRect()`, exactly the `slotToScreen` the backend runs (`shared/tabs.ts`).
// - the real frame of a tool window comes from `CGWindowListCopyWindowInfo` (the runner's
//   `test/smoke/winlist.swift`), which is what makes the comparison land on the screen. That list is
//   in the window server's units, which are not this app's points on this display: the map between
//   the two is read at every measurement from the main window itself (its real frame against its own
//   `getState()`), and applied to the tool window's frame.
import { call } from '../../src/api';
import type { TabReport } from './tools';
import type { Entry, TabState, ToolsState } from '../../shared/types';

/** The generated page hands this in before the modules load. */
interface DriverConfig {
  nonce: string;
  desk: string;
  originA: string;
  originB: string;
  originC: string;
  /** RF-69: the tool that answers `X-Frame-Options: SAMEORIGIN`. */
  originD: string;
}

const smokeWindow = window as unknown as { __NOD_TABS_SMOKE__?: DriverConfig };
const CONFIG = smokeWindow.__NOD_TABS_SMOKE__;
if (CONFIG === undefined) throw new Error('the generated page carries no tabs-smoke config');

/** Throwaway values of a throwaway app data dir. Never printed, and they guard nothing real. */
const EMAIL = 'tabs@nod.test';
const NAME = 'Smoke Tabs';
const PASSWORD = 'smoke-tabs-1';

const POLL_MS = 100;
const STATE_TIMEOUT_MS = 20_000;
const REPORT_TIMEOUT_MS = 20_000;
/** A bridge call that never answers must not hang the driver: the runtime stalls a hidden window. */
const CALL_BUDGET_MS = 25_000;
/** The desk is loopback HTTP; an answer that never comes is a stalled runner, not a slow one. */
const DESK_BUDGET_MS = 15_000;
/** Nothing inside one check may take longer than this before the smoke writes what it has. */
const STEP_BUDGET_MS = 60_000;
/** RF-49: what the tab is given to follow a resize or a click of the sidebar. */
const FOLLOW_BUDGET_MS = 2_000;
/** The main window's title, which is how the window server's list is told from the tool windows. */
const MAIN_TITLE = 'Nod';

interface Step {
  step: string;
  ok: boolean;
  /** a subject the session made unobservable: not a pass, and not the product's failure either */
  blocked: boolean;
  detail: string;
  ms: number;
}

const steps: Step[] = [];

/** What a tool page reported of itself: enough to prove a page never reloaded. */
interface Tracked {
  pid: string;
  win: string | null;
  timeOrigin: number;
  draft: string;
}

/** A rect: the slot's on the screen, or a window's frame in the app's own points. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The main window, from `tiny.win.getState()` in this page. */
interface WinState {
  x: number;
  y: number;
  width: number;
  height: number;
  outer: { width: number; height: number };
  frame: boolean;
}

/** One window of this run the window server is really showing (the runner's `winlist`). */
interface OnScreen {
  pid: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The window server's units as a function of this app's points, read from the main window. */
interface Space {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/** One measurement of one tab: the runtime's own numbers, the page's, and the screen's. */
interface Measured {
  report: TabReport;
  slot: Rect;
  main: WinState;
  /** this run's windows the window server shows, the main window excluded */
  toolWindows: OnScreen[];
  /** the map from points to the window server's units, or null when it could not be read */
  space: Space | null;
  /** why the window server could not be read (empty when it could) */
  why: string;
  /** how long the window server's list took to stop changing, and whether it did */
  settleMs: number;
  settled: boolean;
}

let a1: Tracked | null = null;
let a2: Tracked | null = null;
let popup: Tracked | null = null;
let link1: Tracked | null = null;
let link2: Tracked | null = null;
let popupId = '';
let link1Id = '';
let link2Id = '';
/** The personal tool `tabs.save` creates for the origin no catalog names (RF-67). */
let personalId = '';
/** RF-69: the framed page of the embedded Tool A tab, once "Show inside Nod" ran. */
let framed: Tracked | null = null;
/** The slot's screen rect as of the last measurement, which is what the docked tab must match. */
let layout: Rect = { x: 0, y: 0, width: 0, height: 0 };

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expect(condition: unknown, text: string): void {
  if (!condition) throw new Error(text);
}

function text(node: Element | null): string {
  return node === null ? '' : (node.textContent ?? '').trim();
}

function all<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

function record(step: string, ok: boolean, detail: string, ms: number, blocked = false): void {
  steps.push({ step, ok, detail, blocked, ms: Math.max(0, Math.round(ms)) });
}

/** The step the driver is inside right now, so a stall says where it stopped. */
let currentStep = 'setup';

/** The last moment the page proved it was still running: a hidden window may be frozen mid-step. */
const alive = { step: 'setup', at: Date.now() };

async function writeResult(done: boolean, error: string | null): Promise<void> {
  try {
    await tiny.store.set('tabs_smoke_result', {
      done,
      nonce: CONFIG?.nonce ?? '',
      steps,
      error,
      alive: { step: alive.step, at: alive.at },
    });
  } catch {
    /* without the store there is no result; the runner falls back to the timeout */
  }
}

/** One write every two seconds while a step runs: the runner prints it, a freeze stops it. */
function startHeartbeat(): void {
  setInterval(() => {
    alive.step = currentStep;
    alive.at = Date.now();
    void writeResult(false, null);
  }, 2_000);
}

/** The `tabs.*` calls this page makes, so a slot that never lands can say what was answered. */
interface CallLog {
  method: string;
  params: unknown;
  ok: boolean;
  error: string | null;
}

const calls: CallLog[] = [];

/**
 * Watches `tiny.api.call`: `reportSlot` swallows a refusal (RNF-01), and this is where it shows. It
 * also puts a deadline on every call — the runtime throttles a window nothing is looking at, and a
 * call that never answers would hang a `waitForValue` whose timeout is only read after the answer.
 */
function watchCalls(): void {
  const bridge = tiny.api;
  const original = bridge.call.bind(bridge);
  bridge.call = async (method: string, params?: unknown): Promise<unknown> => {
    try {
      const expired = Promise.withResolvers<never>();
      const timer = setTimeout(
        () => expired.reject(new Error(`the call ${method} did not answer within ${CALL_BUDGET_MS} ms`)),
        CALL_BUDGET_MS,
      );
      let result: unknown;
      try {
        result = await Promise.race([original(method, params), expired.promise]);
      } finally {
        clearTimeout(timer);
      }
      if (method.startsWith('tabs.')) calls.push({ method, params, ok: true, error: null });
      return result;
    } catch (error) {
      if (method.startsWith('tabs.')) calls.push({ method, params, ok: false, error: message(error) });
      throw error;
    }
  };
}

function callsText(): string {
  const last = calls.filter((call) => call.method === 'tabs.slot').slice(-3);
  return last.length === 0
    ? 'no tabs.slot call from this page'
    : last
        .map((call) => `${call.ok ? 'ok' : 'REFUSED'} ${JSON.stringify(call.params)}${call.error === null ? '' : ` → ${call.error}`}`)
        .join(' | ');
}

// ------------------------------------------------------------- the page and the desk

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
  timeoutMs = STATE_TIMEOUT_MS,
): Promise<T> {
  const start = Date.now();
  let last = 'nothing yet';
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    last = JSON.stringify(value)?.slice(0, 160) ?? String(value);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout (${timeoutMs} ms) waiting for ${label}; last: ${last}`);
    }
    await sleep(POLL_MS);
  }
}

/** The runner's desk: the tool pages' reports, the commands they poll for, the WM's view. */
async function desk(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init =
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => expired.reject(new Error(`the desk ${path} did not answer within ${DESK_BUDGET_MS} ms`)),
    DESK_BUDGET_MS,
  );
  let response: Response;
  try {
    response = await Promise.race([tiny.fetch(`${CONFIG.desk}${path}`, init), expired.promise]);
  } finally {
    clearTimeout(timer);
  }
  const raw: unknown = await response.json();
  if (typeof raw !== 'object' || raw === null) throw new Error(`desk ${path} answered a non-object body`);
  const payload = raw as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    const why = typeof payload.error === 'string' ? payload.error : `status ${response.status}`;
    throw new Error(`desk ${path} refused: ${why}`);
  }
  return payload;
}

async function reports(): Promise<TabReport[]> {
  const payload = await desk('/desk/reports');
  const list = payload.reports;
  if (!Array.isArray(list)) throw new Error('the desk carried no reports');
  return list as TabReport[];
}

/** Waits for a report the pages themselves post (a load, a resize), newest first. */
async function waitForReport(
  label: string,
  match: (report: TabReport) => boolean,
  timeoutMs = REPORT_TIMEOUT_MS,
): Promise<TabReport> {
  return await waitForValue(
    label,
    async () => {
      const found = (await reports()).filter(match);
      return found.length === 0 ? null : (found[found.length - 1] as TabReport);
    },
    timeoutMs,
  );
}

/** The newest report of one page, without asking it for another. */
async function latestReport(pid: string): Promise<TabReport | null> {
  const mine = (await reports()).filter((report) => report.pid === pid);
  return mine.length === 0 ? null : (mine[mine.length - 1] as TabReport);
}

/** One command to one page, answered by its own report: the tag is what tells that answer apart. */
async function ask(pid: string, cmd: string, arg?: string): Promise<TabReport> {
  const tag = `t${Math.random().toString(36).slice(2, 10)}`;
  await desk('/desk/cmd', { pid, cmd, arg, tag });
  return await waitForReport(`the ${cmd} answer of ${pid}`, (report) => report.tag === tag);
}

function track(report: TabReport): Tracked {
  return { pid: report.pid, win: report.win, timeOrigin: report.timeOrigin, draft: report.draft };
}

/** Floats this run's own windows and reports the tiler's view of them (numbers, not a verdict). */
async function floatWm(): Promise<string> {
  const payload = await desk('/desk/float', {});
  const floated = Array.isArray(payload.floated) ? (payload.floated as string[]) : [];
  const snapshot = typeof payload.snapshot === 'string' ? payload.snapshot : '';
  const told =
    floated.length === 0
      ? 'nothing of this run was tiled'
      : `floated ${floated.length} window(s): ${floated.join(', ')}`;
  return `${told}; omniwm: ${snapshot}`;
}

/** The windows of this run the window server is showing, from the runner's `CGWindowList` helper. */
async function onScreen(): Promise<{ windows: OnScreen[]; why: string; locked: boolean; frontmost: string }> {
  const payload = await desk('/desk/onscreen');
  const raw = payload.windows;
  const windows: OnScreen[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      if (!('pid' in item && 'title' in item && 'x' in item && 'y' in item && 'width' in item && 'height' in item)) {
        continue;
      }
      const { pid, title, x, y, width, height } = item;
      if (
        typeof pid !== 'number' ||
        typeof title !== 'string' ||
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof width !== 'number' ||
        typeof height !== 'number'
      ) {
        continue;
      }
      windows.push({ pid, title, x, y, width, height });
    }
  }
  return {
    windows,
    why: typeof payload.why === 'string' ? payload.why : '',
    locked: payload.screenLocked === true,
    frontmost: typeof payload.frontmost === 'string' ? payload.frontmost : '',
  };
}

/** The run's own windows the WM has taken over (`mode: tiling`), as the desk reports them. */
async function wmTiled(): Promise<string[]> {
  const payload = await desk('/desk/onscreen');
  const tiled = payload.tiled;
  if (!Array.isArray(tiled)) return [];
  return tiled.filter((item): item is string => typeof item === 'string');
}

/** `blocked by the tiling WM`, with the windows the WM took over and where the tab really is. */
async function blockedByTiler(tab: Tracked, why: string): Promise<Blocked> {
  const tiled = await wmTiled();
  return blocked(
    `blocked by the tiling WM (${tiled.join('; ')}): the tool window is on an OmniWM tile, not on the ` +
      `slot, so ${why}; ${await placementNumbers(tab)}`,
  );
}

/**
 * Why nothing can be placed right now, or null. `src/tabs.ts` reports no slot while the page is
 * hidden (`currentRect`), so on a locked or covered desktop the backend has nothing to put a docked
 * tab on — the product behaving as designed, and a geometry check that must say so.
 */
async function hiddenNow(): Promise<string | null> {
  if (document.visibilityState === 'visible') return null;
  const payload = await desk('/desk/onscreen');
  const locked = payload.screenLocked === true;
  const frontmost = typeof payload.frontmost === 'string' ? payload.frontmost : '';
  return (
    `this page is hidden (visibilityState ${document.visibilityState}, focused ${document.hasFocus()}` +
    `${locked ? ', the screen is locked' : ''}` +
    `${frontmost === '' ? '' : `, frontmost ${JSON.stringify(frontmost)}`}) — src/tabs.ts reports the ` +
    `empty slot while the page is hidden, so the backend has no rect to place a docked tab on`
  );
}

// ------------------------------------------------------------- the real page's DOM

function controlByText(label: string, root: ParentNode = document): HTMLButtonElement | null {
  return all<HTMLButtonElement>('button', root).find((node) => text(node) === label) ?? null;
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

/** The tool titles the sidebar shows, in order: the tool button's `title` is the entry's own. */
function sidebarTitles(): string[] {
  return all<HTMLButtonElement>('.sidebar-tools .tool-icon').map(
    (button) => button.getAttribute('title') ?? '',
  );
}

async function clickSidebarTool(title: string): Promise<void> {
  const button = await waitForValue(`the sidebar row "${title}"`, () => {
    const found = all<HTMLButtonElement>('.sidebar-tools .tool-icon').find((node) =>
      (node.getAttribute('title') ?? '').startsWith(title),
    );
    return found ?? null;
  });
  button.click();
}

function setValue(field: HTMLInputElement | HTMLSelectElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Settings → the tab; the app's own path, driven by the sidebar and the tab row. */
async function openSettingsTab(label: string): Promise<void> {
  const settings = all<HTMLButtonElement>('.sidebar-action').find((button) =>
    text(button).includes('Settings'),
  );
  expect(settings !== undefined, 'the sidebar has no Settings action');
  settings.click();
  await waitForValue('the Settings tabs', () => document.querySelector('.settings-view .tabs'));
  const tab = await waitForValue(`the ${label} tab`, () =>
    all<HTMLButtonElement>('.tabs .tab').find((node) => text(node) === label) ?? null,
  );
  tab.click();
  await waitForValue(`the active ${label} tab`, () => {
    const active = document.querySelector('.tabs .tab-active');
    return active !== null && text(active) === label ? active : null;
  });
}

async function openHome(): Promise<void> {
  const mark = await waitForValue('the Home mark', () => document.querySelector<HTMLButtonElement>('.mark'));
  mark.click();
  await waitForValue('Home', () => document.querySelector('.home'));
}

/** The card whose heading is this title (the Window mode card, RF-52). */
function sectionCard(heading: string): HTMLElement | null {
  return (
    all<HTMLElement>('section.card').find((card) => text(card.querySelector(':scope > h2')) === heading) ??
    null
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

// ------------------------------------------------------------- tabs, the strip and the slot

async function stateOf(): Promise<ToolsState> {
  return await call('tools.state');
}

async function waitForState(label: string, accept: (state: ToolsState) => boolean): Promise<ToolsState> {
  return await waitForValue(label, async () => {
    const state = await call('tools.state');
    return accept(state) ? state : null;
  });
}

/** The strip rows, in the order the state says — the DOM may lag one push behind the answer. */
async function stripRows(): Promise<HTMLElement[]> {
  const state = await stateOf();
  return await waitForValue(`the ${state.tabs.length} strip row(s)`, () => {
    const rows = all<HTMLElement>('.tab-strip .tab-item');
    return rows.length === state.tabs.length ? rows : null;
  });
}

function rowIndex(state: ToolsState, id: string): number {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  expect(at >= 0, `no tab ${id} in the strip`);
  return at;
}

function tabOf(state: ToolsState, id: string): TabState {
  const found = state.tabs.find((tab) => tab.id === id);
  expect(found !== undefined, `no tab ${id} in the state`);
  return found as TabState;
}

/** Activates a tab through its own row — the strip click the person makes (RF-49/RF-50). */
async function activateRow(id: string): Promise<void> {
  let state = await stateOf();
  if (document.querySelector('.tab-strip') === null) {
    // Home or Settings has the panel (a lock/unlock leaves it there): the strip is the way back.
    const tab = tabOf(state, id);
    const title = state.tools.find((tool) => tool.id === tab.toolId)?.title ?? '';
    expect(title !== '', `no tool title for ${id} to bring the panel back from`);
    await clickSidebarTool(title);
    await waitForValue('the tab strip', () => document.querySelector('.tab-strip'));
    state = await stateOf();
  }
  const rows = await stripRows();
  const row = rows[rowIndex(state, id)];
  expect(row !== undefined, `the strip has no row for ${id}`);
  row.click();
  await waitForState(`${id} to be active`, (next) => next.active === id);
}

async function clickToolbar(label: string): Promise<void> {
  const button = await waitForControl(label);
  button.click();
}

/** One dialog with one field: type the address and press Enter (`src/app.ts` `openLinkDialog`). */
async function typeOpenLink(url: string): Promise<void> {
  await clickToolbar('Open link…');
  const field = await waitForValue('the Open link field', () =>
    document.querySelector<HTMLInputElement>('#open-link-dialog input'),
  );
  setValue(field, url);
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

// ------------------------------------------------------------- geometry

/** The main window's own state, from this page's bridge. */
async function mainState(): Promise<WinState | null> {
  const state = await tiny.win.getState();
  if (state === null) return null;
  return {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    outer: { width: state.outer.width, height: state.outer.height },
    frame: state.chrome.frame,
  };
}

/** The slot's rect on the screen: `slotToScreen` of the design, with the runtime's own numbers. */
function slotRectOf(main: WinState): Rect {
  const slot = document.querySelector('.tab-slot');
  expect(slot !== null, 'the panel has no slot');
  const box = slot.getBoundingClientRect();
  const dx = main.outer.width - main.width;
  const dy = main.outer.height - main.height;
  return {
    x: Math.round(main.x + dx / 2 + box.x),
    y: Math.round(main.y + dy + box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

async function slotScreenRect(): Promise<Rect> {
  const main = await mainState();
  expect(main !== null, 'the main window reported no state');
  return slotRectOf(main as WinState);
}

function near(a: number, b: number, tolerance = 2): boolean {
  return Math.abs(a - b) <= tolerance;
}

function sameRect(a: Rect, b: Rect): boolean {
  return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

function rectText(rect: Rect): string {
  return `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
}

function rawText(report: TabReport): string {
  return (
    `window.screenX/Y ${report.screenX},${report.screenY} window.outer ` +
    `${report.outerWidth}x${report.outerHeight} page ${report.innerWidth}x${report.innerHeight}`
  );
}

/**
 * The map between this app's points and the window server's units, read from the main window: the
 * same window, measured by both, at the same moment. On this display the server's units are smaller
 * than a point (a 1100 pt window is 990 of them), so a real frame is only comparable to the slot
 * after this; where the two spaces are the same the map comes out as identity.
 */
function spaceFrom(main: WinState, mainWindow: OnScreen): Space | null {
  if (main.outer.width === 0 || main.outer.height === 0) return null;
  // One scale for both axes: the display's, read across the X axis, where the window server's width
  // and the outer width are the same measurement. The Y axis cannot give it — the server's height
  // carries the title bar (678 = 648 + 30 on this machine), so a per-axis scale would be off by that.
  const scale = mainWindow.width / main.outer.width;
  if (scale === 0) return null;
  return {
    scaleX: scale,
    scaleY: scale,
    offsetX: mainWindow.x - main.x * scale,
    offsetY: mainWindow.y - main.y * scale,
  };
}

/** A window from the window server, in this app's points. */
function toPoints(window: OnScreen, space: Space): Rect {
  return {
    x: (window.x - space.offsetX) / space.scaleX,
    y: (window.y - space.offsetY) / space.scaleY,
    width: window.width / space.scaleX,
    height: window.height / space.scaleY,
  };
}

function spaceText(space: Space | null, mainWindow: OnScreen | undefined, main: WinState): string {
  if (space === null || mainWindow === undefined) {
    return `main ${main.x},${main.y} ${main.outer.width}x${main.outer.height} (no window-server frame)`;
  }
  return (
    `main ${main.x},${main.y} ${main.outer.width}x${main.outer.height} vs server ` +
    `${mainWindow.x},${mainWindow.y} ${mainWindow.width}x${mainWindow.height} → scale ` +
    `${space.scaleX.toFixed(4)} offset ${Math.round(space.offsetX)},${Math.round(space.offsetY)}`
  );
}

function screenText(measured: Measured): string {
  if (measured.why !== '') return `CGWindowList not read — ${measured.why}`;
  const list = measured.toolWindows
    .map((window) => {
      const frame = measured.space === null ? null : toPoints(window, measured.space);
      return (
        `${JSON.stringify(window.title)} ${window.width}x${window.height}@${window.x},${window.y}` +
        (frame === null ? '' : ` = ${rectText(frame)} pt`)
      );
    })
    .join('; ');
  return (
    `CGWindowList: ${measured.toolWindows.length} tool window(s) ${list || '(none)'}` +
    ` (settled in ${measured.settleMs} ms${measured.settled ? '' : ', STILL MOVING'})`
  );
}

function measuredText(measured: Measured): string {
  return (
    `page ${measured.report.innerWidth}x${measured.report.innerHeight} on the slot ${rectText(measured.slot)}; ` +
    `${screenText(measured)}; ${spaceText(measured.space, undefined, measured.main)}; ` +
    `the tool page's own numbers: ${rawText(measured.report)}`
  );
}

/** What the panel's own layout says: the stylesheet that arrived and the boxes that decide it. */
function layoutText(): string {
  const sheets = [...document.styleSheets]
    .map((sheet) => sheet.href ?? '(inline)')
    .join(', ');
  const box = (selector: string): string => {
    const node = document.querySelector(selector);
    if (node === null) return `${selector}: none`;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return `${selector}: ${Math.round(rect.width)}x${Math.round(rect.height)} display ${style.display} position ${style.position}`;
  };
  const rows = ['grid-template-rows', 'overflow'].map((name) =>
    name === 'grid-template-rows'
      ? `rows ${getComputedStyle(document.querySelector('.main') ?? document.body).gridTemplateRows}`
      : `content overflow ${getComputedStyle(document.querySelector('.content') ?? document.body).overflow}`,
  );
  const said = (selector: string): string =>
    `${selector} says ${JSON.stringify(text(document.querySelector(selector)).slice(0, 90))}`;
  return (
    `page ${window.innerWidth}x${window.innerHeight} visibility ${document.visibilityState} focused ` +
    `${document.hasFocus()}; sheets [${sheets}]; ` +
    [
      box('.shell'),
      box('.main'),
      box('.notice-slot'),
      box('.banner'),
      box('.content'),
      box('.tab-view'),
      box('.tab-slot'),
    ].join('; ') +
    `; ${rows.join('; ')}; ${said('.notice-slot')}; ${said('.banner')}`
  );
}

/** What a window-server reading is, in one string, so two readings can be compared. */
function screenSignature(windows: OnScreen[]): string {
  return windows
    .map((window) => `${window.title}|${window.x},${window.y},${window.width},${window.height}`)
    .sort()
    .join(';');
}

/**
 * The window server's list once it has stopped changing: macOS animates a window out (a hidden
 * docked tab shrinks away), and a reading taken mid-animation reports two tool windows where the
 * product has one. `quietMs` of identical readings is "settled"; `budgetMs` without one is not,
 * and the caller's own assertions then fail with the numbers — a real failure, not noise.
 */
async function settleScreen(
  quietMs = 300,
  budgetMs = 2_000,
): Promise<{ reading: { windows: OnScreen[]; why: string }; ms: number; stable: boolean }> {
  const started = Date.now();
  let last = await onScreen();
  let signature = screenSignature(last.windows);
  let since = Date.now();
  for (;;) {
    await sleep(60);
    const next = await onScreen();
    const now = screenSignature(next.windows);
    if (now === signature) {
      if (Date.now() - since >= quietMs) {
        return { reading: next, ms: Date.now() - started, stable: true };
      }
    } else {
      signature = now;
      since = Date.now();
    }
    last = next;
    if (Date.now() - started >= budgetMs) {
      return { reading: last, ms: Date.now() - started, stable: false };
    }
  }
}

/**
 * One measurement: the tool page's own report (its page box, timeOrigin and draft), the slot the
 * backend aims at, and the window server's view of what is on screen.
 */
async function measure(tab: Tracked, what: string, fresh = true): Promise<Measured> {
  const report = fresh ? await ask(tab.pid, 'report') : await latestReport(tab.pid);
  if (report === null) throw new Error(`${what}: the page never reported`);
  const main = await mainState();
  if (main === null) throw new Error(`${what}: the main window has no state`);
  const slot = slotRectOf(main);
  layout = slot;
  const settled = await settleScreen();
  const screen = settled.reading;
  const mainWindow = screen.windows.find((window) => window.title === MAIN_TITLE);
  const space = mainWindow === undefined ? null : spaceFrom(main, mainWindow);
  const toolWindows = screen.windows.filter((window) => window.title !== MAIN_TITLE);
  void what;
  return {
    report,
    slot,
    main,
    toolWindows,
    space,
    why: screen.why,
    settleMs: settled.ms,
    settled: settled.stable,
  };
}

/** The docked tab's page box must be the slot's size — the half of RF-49 a page can report itself. */
function expectPageBox(measured: Measured, what: string): void {
  expect(
    near(measured.report.innerWidth, measured.slot.width) &&
      near(measured.report.innerHeight, measured.slot.height),
    `${what}: the page box is ${measured.report.innerWidth}x${measured.report.innerHeight} and the slot ` +
      `is ${measured.slot.width}x${measured.slot.height}; ${measuredText(measured)}`,
  );
}

/** What a placement check measured while it could not place anything. */
async function placementNumbers(tab: Tracked): Promise<string> {
  const report = await latestReport(tab.pid);
  const measured = await measure(tab, 'the blocked measurement', false);
  const frame = toolFrame(measured);
  return (
    `the slot box is ${rectText(measured.slot)}, the tab's page is ` +
    `${report === null ? 'silent' : `${report.innerWidth}x${report.innerHeight}`} and the real frame is ` +
    `${frame === null ? 'unread from the window server' : rectText(frame.frame)}`
  );
}

/** RF-49: the one tab that may show is the one on the slot, and the screen agrees on the frame. */
function expectOnSlot(measured: Measured, what: string): void {
  if (measured.why !== '') return;
  expect(
    measured.toolWindows.length === 1,
    `${what}: the window server shows ${measured.toolWindows.length} tool window(s), not 1: ${screenText(measured)}`,
  );
  if (measured.space === null) return;
  const frame = toPoints(measured.toolWindows[0] as OnScreen, measured.space);
  expect(
    near(frame.x, measured.slot.x) && near(frame.y, measured.slot.y),
    `${what}: the real frame is at ${frame.x},${frame.y} and the slot is at ${rectText(measured.slot)}; ` +
      `${screenText(measured)}; ${spaceText(measured.space, undefined, measured.main)}`,
  );
  expect(
    near(frame.width, measured.slot.width) && near(frame.height, measured.slot.height),
    `${what}: the real frame is ${frame.width}x${frame.height} and the slot is ` +
      `${measured.slot.width}x${measured.slot.height}; ${screenText(measured)}`,
  );
}

/** Every tool window of this run the window server shows, in points, with the frame around it. */
function toolFrames(measured: Measured): Array<{ frame: Rect; border: number }> {
  if (measured.space === null) return [];
  return measured.toolWindows.map((window) => {
    const frame = toPoints(window, measured.space as Space);
    return { frame, border: frame.height - measured.report.innerHeight };
  });
}

/** The one tool window a docked panel shows, or null. */
function toolFrame(measured: Measured): { frame: Rect; border: number } | null {
  const frames = toolFrames(measured);
  return frames.length === 0 ? null : (frames[0] as { frame: Rect; border: number });
}

function framesText(frames: Array<{ frame: Rect; border: number }>): string {
  return frames.length === 0
    ? 'none'
    : frames
        .map(
          (item) =>
            `${Math.round(item.frame.x)},${Math.round(item.frame.y)} ${Math.round(item.frame.width)}x` +
            `${Math.round(item.frame.height)} with a ${Math.round(item.border)} pt frame`,
        )
        .join('; ');
}

/** Waits for the tab of `pid` to land on the slot after a resize or a click. */
async function waitPlaced(
  pid: string,
  previous: Rect | null,
  budgetMs = FOLLOW_BUDGET_MS,
): Promise<{ report: TabReport; slot: Rect; ms: number; screen: string }> {
  const started = Date.now();
  for (;;) {
    const main = await mainState();
    if (main === null) throw new Error('the main window reported no state');
    const slot = slotRectOf(main);
    const report = await latestReport(pid);
    const screen = await onScreen();
    const mainWindow = screen.windows.find((window) => window.title === MAIN_TITLE);
    const space = mainWindow === undefined ? null : spaceFrom(main, mainWindow);
    const tool = screen.windows.find((window) => window.title !== MAIN_TITLE);
    const frame = space === null || tool === undefined ? null : toPoints(tool, space);
    const sized =
      report !== null && near(report.innerWidth, slot.width) && near(report.innerHeight, slot.height);
    const placed = frame === null || (near(frame.x, slot.x) && near(frame.y, slot.y));
    const settled = previous === null || !sameRect(slot, previous);
    if (sized && placed && settled && report !== null) {
      return {
        report,
        slot,
        ms: Date.now() - started,
        screen:
          frame === null ? 'no window-server frame' : `real frame ${rectText(frame)} = the slot ${rectText(slot)}`,
      };
    }
    if (Date.now() - started > budgetMs) {
      throw new Error(
        `the tab did not land on the slot within ${budgetMs} ms: the slot is ${rectText(slot)}, the ` +
          `page box is ${report === null ? 'silent' : `${report.innerWidth}x${report.innerHeight}`}, ` +
          `the real frame is ${frame === null ? 'unread' : rectText(frame)}; ${layoutText()}; ` +
          `slot reports: ${callsText()}`,
      );
    }
    await sleep(50);
  }
}

/**
 * Floats this run's own windows and reseats the panel before a measurement.
 *
 * On this machine the tiler does not manage this run's windows (they are not in `omniwmctl`'s list),
 * so a placed rect holds by itself; the float is what would give it a chance where the tiler does
 * manage them. The one-pixel resize re-reports the slot, which makes the backend place the active
 * tab again even though it had cached the rect it asked for before anything moved the window.
 */
async function reseat(): Promise<string> {
  const floated = await floatWm();
  const width = window.innerWidth;
  const height = window.innerHeight;
  await tiny.win.setSize(width, height - 1);
  await sleep(150);
  await tiny.win.setSize(width, height);
  await sleep(250);
  await floatWm();
  await sleep(150);
  layout = await slotScreenRect();
  return floated;
}

/** WKWebView's `performance.timeOrigin` jitters by a millisecond between reads; a reload is not. */
const ORIGIN_TOLERANCE_MS = 2;

function expectSame(tab: Tracked, report: TabReport, what: string): void {
  expect(
    Math.abs(report.timeOrigin - tab.timeOrigin) <= ORIGIN_TOLERANCE_MS,
    `${what} reloaded the page: timeOrigin ${tab.timeOrigin} → ${report.timeOrigin} ` +
      `(+${Math.round(report.timeOrigin - tab.timeOrigin)} ms)`,
  );
  expect(
    report.draft === tab.draft,
    `${what} lost the draft: ${JSON.stringify(tab.draft)} → ${JSON.stringify(report.draft)}`,
  );
}

function loadedTimes(list: TabReport[], pid: string): number {
  return list.filter((report) => report.pid === pid && report.note === 'load').length;
}

// ------------------------------------------------------------- setup

async function setupLocalAccount(): Promise<void> {
  const state = (await call('session.state')) as unknown as { hasAccount: boolean };
  expect(state.hasAccount === false, 'this app id is not a fresh installation');
  // The real API path of the entry screen's own "Set up Nod on this machine" form (RF-60): a local
  // account, no host, no code. `afterUnlock` is what the page waits for.
  const created = await call('session.createAccount', { email: EMAIL, name: NAME, password: PASSWORD });
  expect(created.unlocked === true, 'the local account did not unlock');
  await waitForValue('the unlocked shell', () => document.querySelector('.shell'));
  await waitForValue('the Home screen', () => {
    const title = document.querySelector('.content-title');
    return title !== null && text(title) === 'Tools' ? title : null;
  });
  // The runtime throttles an occluded window: WKWebView reports `visibilityState === 'hidden'` while
  // this window is covered (a locked screen covers everything), and `src/tabs.ts` then reports no slot
  // at all — so the app places no docked tab, which is the product behaving as designed. The window is
  // brought up front and the visibility is recorded; a geometry step whose subject needs the slot
  // says it was blocked instead of pretending the numbers mean the same thing.
  await tiny.win.show({ activate: true });
  await sleep(300);
}

// ------------------------------------------------------------- RF-52: the mode it starts in

async function checkDefaultMode(): Promise<string> {
  const state = await stateOf();
  expect(state.mode === 'docked', `tools.state().mode = ${JSON.stringify(state.mode)}`);
  expect(state.dockable === true, `tools.state().dockable = ${JSON.stringify(state.dockable)}`);
  expect(
    state.tabs.length === 0,
    `a fresh unlock already has ${state.tabs.length} tab(s): ${state.tabs
      .map((tab) => `${tab.id}(${tab.title})`)
      .join(', ')}`,
  );
  expect(state.active === null, `active = ${JSON.stringify(state.active)} with no tab`);
  expect(document.querySelector('.tab-strip') === null, 'the panel draws a strip with no tab open');
  const main = await mainState();
  expect(main !== null, 'the main window reported no state');
  const screen = await onScreen();
  const mainWindow = screen.windows.find((window) => window.title === MAIN_TITLE);
  return (
    `tools.state(): mode=docked dockable=true tabs=0, active=null; the panel draws no strip; ` +
    `${spaceText(mainWindow === undefined ? null : spaceFrom(main as WinState, mainWindow), mainWindow, main as WinState)}`
  );
}

// ------------------------------------------------------------- RF-49: the tab on the slot

/** A placement check: measure the slot and the real frame, or say why the session blocked it. */
async function checkOnSlot(tab: Tracked, what: string, count = 1): Promise<Outcome> {
  const hidden = await hiddenNow();
  if (hidden !== null) return blocked(`${hidden}; ${await placementNumbers(tab)}`);
  if ((await wmTiled()).length > 0) return await blockedByTiler(tab, 'this tab cannot be measured');
  // The tiler moves a fresh window off the rect the backend placed it on, so the run's own windows
  // are floated and the panel reseated first — the same recipe the design gives the Nod itself: it
  // places the active tab again whenever the slot is reported.
  await reseat();
  const measured = await measure(tab, what, false);
  expectPageBox(measured, what);
  expectOnSlot(measured, what);
  return `${measuredText(measured)}; ${count === 1 ? 'the strip shows one tab' : `${count} tabs`}`;
}

async function checkOpenDocked(): Promise<string> {
  const clicked = Date.now();
  await clickSidebarTool('Tool A');
  await waitForState('one tab of Tool A', (state) => state.tabs.length === 1 && state.active !== null);
  const state = await stateOf();
  const tab = tabOf(state, 'tool_tool-a');
  expect(tab.docked === true, 'the first tab is not docked');
  expect(tab.toolId === 'tool-a', `the tab's toolId is ${JSON.stringify(tab.toolId)}`);
  expect(state.active === tab.id, `active = ${JSON.stringify(state.active)}`);
  const rows = await stripRows();
  expect(
    rows.length === 1 && rows[0].classList.contains('tab-item-active'),
    'the strip does not show exactly one active row',
  );
  const slot = document.querySelector('.tab-slot');
  expect(slot !== null, 'the panel has no slot');
  const box = slot.getBoundingClientRect();
  expect(box.width > 0 && box.height > 0, `the slot box is ${box.width}x${box.height}`);
  const load = await waitForReport('the tool A page', (item) => item.tool === 'A' && item.note === 'load');
  a1 = track(load);
  const measured = await measure(a1, 'the first tab just opened', false);
  return (
    `sidebar click → one tab ${tab.id} (docked, active, one active strip row), the panel's slot is ` +
    `${Math.round(box.width)}x${Math.round(box.height)}; the tab's page loaded at ` +
    `${measured.report.innerWidth}x${measured.report.innerHeight} ${Date.now() - clicked} ms after the ` +
    `click; the tool page cannot read the window it lives in (${JSON.stringify(measured.report.stateError)}, ` +
    `${rawText(measured.report)})`
  );
}

async function checkOpenOnSlot(): Promise<Outcome> {
  expect(a1 !== null, 'the first tab was never tracked');
  return await checkOnSlot(a1 as Tracked, 'the first tab on open');
}

// ------------------------------------------------------------- RF-49: it follows a resize

async function checkResizeFollow(): Promise<Outcome> {
  const first = a1;
  expect(first !== null, 'the first tab was never tracked');
  const hidden = await hiddenNow();
  if (hidden === null && (await wmTiled()).length > 0) {
    return await blockedByTiler(first, 'the resize cannot be followed');
  }
  if (hidden !== null) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    await tiny.win.setSize(width - 160, height - 140);
    await sleep(400);
    const after = await placementNumbers(first);
    await tiny.win.setSize(width, height);
    await sleep(300);
    return blocked(
      `${hidden}; the main window was resized ${width}x${height} → ${width - 160}x${height - 140} and ` +
        `nothing followed: ${after}`,
    );
  }
  const wm = await reseat();
  const before = layout;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const smaller = { width: Math.max(720, width - 160), height: Math.max(520, height - 140) };

  await tiny.win.setSize(smaller.width, smaller.height);
  const grew = await waitPlaced(first.pid, before);
  const small = await measure(first, 'after the resize to the smaller window', false);
  expectPageBox(small, 'after the resize to the smaller window');
  expectOnSlot(small, 'after the resize to the smaller window');
  expectSame(first, small.report, 'the resize');

  await tiny.win.setSize(width, height);
  const back = await waitPlaced(first.pid, grew.slot);
  const larger = await measure(first, 'after the resize back', false);
  expectPageBox(larger, 'after the resize back');
  expectOnSlot(larger, 'after the resize back');
  expectSame(first, larger.report, 'the resize back');
  return (
    `main ${width}x${height} → ${smaller.width}x${smaller.height}: the tab followed in ${grew.ms} ms to ` +
    `${rectText(grew.slot)} (${grew.screen}); back in ${back.ms} ms to ${rectText(back.slot)}; ` +
    `${measuredText(larger)}; ${wm}`
  );
}

// ------------------------------------------------------------- RF-50: several tabs, no reload

async function checkSecondTab(): Promise<string> {
  const first = a1;
  expect(first !== null, 'the first tab was never tracked');
  // ⌘T's own button: the "+" that ends the strip.
  const plus = await waitForValue('the strip + button', () => {
    const button = document.querySelector<HTMLButtonElement>('.tab-strip .tab-new');
    return button !== null && !button.disabled ? button : null;
  });
  plus.click();
  const state = await waitForState('a second tab', (next) => next.tabs.length === 2);
  const ids = state.tabs.map((item) => item.id);
  expect(ids[0] === 'tool_tool-a' && ids[1] === 'tool_tool-a_t2', `tabs = ${ids.join(', ')}`);
  expect(state.active === 'tool_tool-a_t2', `active = ${JSON.stringify(state.active)}`);
  const rows = await stripRows();
  expect(rows.length === 2, `the strip shows ${rows.length} row(s)`);

  const load = await waitForReport(
    'the second tab to load',
    (report) => report.tool === 'A' && report.note === 'load' && report.pid !== first.pid,
  );
  a2 = track(load);
  const second = a2;
  expect(
    second.timeOrigin !== first.timeOrigin,
    `the second tab reused the first page (timeOrigin ${second.timeOrigin})`,
  );
  expect(second.draft !== first.draft, 'the second tab carries the first tab draft');
  return (
    `the strip's + → ${ids.join(', ')} with ${ids[1]} active; its own page (timeOrigin ` +
    `${Math.round(second.timeOrigin)}, draft ${second.draft}) is not tab 1's (timeOrigin ` +
    `${Math.round(first.timeOrigin)}, draft ${first.draft})`
  );
}

async function checkSecondOnSlot(): Promise<Outcome> {
  const second = a2;
  expect(second !== null, 'the second tab was never tracked');
  return await checkOnSlot(second, 'the second tab on open', 2);
}

async function checkSwitchKeepsDraft(): Promise<string> {
  const first = a1;
  const second = a2;
  expect(first !== null && second !== null, 'both tabs were never tracked');
  await activateRow('tool_tool-a');
  await activateRow('tool_tool-a_t2');
  await activateRow('tool_tool-a');
  const again = await ask(first.pid, 'report');
  expectSame(first, again, 'switching away and back');
  const loads = loadedTimes(await reports(), first.pid);
  expect(loads === 1, `the first page loaded ${loads} times across the switches`);
  const rows = await stripRows();
  expect(rows[0].classList.contains('tab-item-active'), 'the strip does not mark tab 1 active');
  const state = await stateOf();
  expect(state.active === 'tool_tool-a', `active = ${JSON.stringify(state.active)} after the switches`);
  return (
    `three strip clicks (1 → 2 → 1): tab 1 keeps timeOrigin ${Math.round(again.timeOrigin)} and draft ` +
    `${again.draft}, ${loads} load, and the strip marks it active again (the slot it takes back is the ` +
    `step "the docked tab lands on the slot")`
  );
}

// ------------------------------------------------------------- RF-51: detach and dock

async function checkDetach(): Promise<string> {
  const first = a1;
  expect(first !== null, 'the first tab was never tracked');
  await activateRow('tool_tool-a');
  await reseat();
  const before = await measure(first, 'before the detach');
  const dockedFrame = toolFrame(before);
  expect(dockedFrame !== null, `the window server did not show the docked tab: ${screenText(before)}`);
  const docked = dockedFrame as { frame: Rect; border: number };

  await clickToolbar('Detach');
  const state = await waitForState('the tab to detach', (next) => {
    const tab = next.tabs.find((item) => item.id === 'tool_tool-a');
    return tab !== undefined && tab.docked === false ? next : null;
  });
  expect(state.active !== 'tool_tool-a', 'a detached tab is still the active one');
  const rows = await stripRows();
  const row = rows[rowIndex(state, 'tool_tool-a')];
  expect(row.querySelector('.tab-detached') !== null, 'the strip does not mark the tab as detached');
  const wm = await floatWm();
  await sleep(400);
  const after = await ask(first.pid, 'report');
  const away = await measure(first, 'after the detach', false);
  const frames = toolFrames(away);
  expect(frames.length >= 1, `the window server did not show the detached tab: ${screenText(away)}`);
  const framed = frames.filter((item) => item.border >= 20);
  expect(
    framed.length >= 1,
    `no tool window carries a frame after the detach: ${framesText(frames)} (before: ` +
      `${Math.round(docked.border)} pt)`,
  );
  expectSame(first, after, 'detaching');
  // A detached tab is placed a step off the slot; with the page hidden there is no slot, so the
  // window keeps its own rect — the product's answer to "the slot is gone", said out loud here.
  const detachedFrame = framed[0] as { frame: Rect; border: number };
  const moved =
    detachedFrame.frame.x !== docked.frame.x || detachedFrame.frame.y !== docked.frame.y;
  return (
    `Detach: ${frames.length} tool window(s) on screen, one of them with a ` +
    `${Math.round(detachedFrame.border)} pt frame (the docked one had ${Math.round(docked.border)} pt); ` +
    `timeOrigin and draft kept, 1 load; ` +
    (moved
      ? `the window left its place (${rectText(docked.frame)} → ${rectText(detachedFrame.frame)})`
      : `the window kept its rect (${rectText(detachedFrame.frame)}) — there was no slot to step off`) +
    `; ${screenText(away)}; ${wm}`
  );
}

async function checkDockBack(): Promise<Outcome> {
  const first = a1;
  expect(first !== null, 'the first tab was never tracked');
  const state = await stateOf();
  const rows = await stripRows();
  const row = rows[rowIndex(state, 'tool_tool-a')];
  const dock = row.querySelector<HTMLButtonElement>('.tab-dock');
  expect(dock !== null, 'the detached row carries no ⛚ button');
  dock.click();
  await waitForState('the tab to dock back', (next) => {
    const tab = next.tabs.find((item) => item.id === 'tool_tool-a');
    return tab !== undefined && tab.docked === true && next.active === 'tool_tool-a' ? next : null;
  });
  const report = await ask(first.pid, 'report');
  expectSame(first, report, 'docking back');
  const loads = loadedTimes(await reports(), first.pid);
  expect(loads === 1, `the page loaded ${loads} times across detach and dock`);
  const hidden = await hiddenNow();
  if (hidden === null && (await wmTiled()).length > 0) {
    return await blockedByTiler(first, 'the dock cannot be measured on the slot');
  }
  if (hidden !== null) {
    const after = await latestReport(first.pid);
    const measured = await measure(first, 'after the dock', false);
    const frame = toolFrame(measured);
    return blocked(
      `${hidden}; the tab is docked and active again with the same timeOrigin and draft and ` +
        `${loads} load, but the snap onto the slot was not observable: the slot box is ` +
        `${rectText(measured.slot)}, the page ${after === null ? 'silent' : `${after.innerWidth}x${after.innerHeight}`}` +
        `, the real frame ${frame === null ? 'unread' : rectText(frame.frame)}`,
    );
  }
  await reseat();
  const back = await measure(first, 'after the dock');
  expectPageBox(back, 'after the dock');
  expectOnSlot(back, 'after the dock');
  return (
    `⛚ docked it back onto ${rectText(back.slot)}: ${measuredText(back)}; timeOrigin and draft kept, ` +
    `${loads} load`
  );
}

// ------------------------------------------------------------- RF-66: links as tabs

async function checkPopupAdoption(): Promise<string> {
  const first = a1;
  expect(first !== null, 'the first tab was never tracked');
  await activateRow('tool_tool-a');
  const opened = await ask(first.pid, 'open', `${CONFIG.originB}/doc`);
  expect(opened.note === 'open', `the Tool A page answered ${JSON.stringify(opened.note)}`);
  const state = await waitForState('the adopted popup tab', (next) => next.tabs.some((tab) => tab.adhoc));
  const ids = state.tabs.map((item) => item.id);
  const found = state.tabs.find((item) => item.adhoc);
  expect(found !== undefined, 'no ad-hoc tab came back');
  const tab = found as TabState;
  expect(tab.toolId === null, `the adopted tab has toolId ${JSON.stringify(tab.toolId)}`);
  expect(tab.id.startsWith('popup'), `the adopted window id is ${tab.id}`);
  const at = rowIndex(state, tab.id);
  expect(ids[at - 1] === 'tool_tool-a', `the ad-hoc tab is at ${at} of ${ids.join(', ')}`);
  expect(state.active === tab.id, `active = ${JSON.stringify(state.active)}`);
  popupId = tab.id;
  const rows = await stripRows();
  expect(rows[at].querySelector('.tab-unsaved') !== null, 'the strip does not mark the tab as not saved');
  expect(rows[at].classList.contains('tab-item-active'), 'the strip does not mark the adopted tab active');

  const report = await waitForReport(
    'the popup page',
    (item) => item.tool === 'B' && item.note === 'load' && item.href.endsWith('/doc'),
  );
  popup = track(report);
  const hidden = await hiddenNow();
  const took =
    hidden === null
      ? `it took the slot in ${(await waitPlaced(popup.pid, null, FOLLOW_BUDGET_MS)).ms} ms`
      : 'the tab is docked (the slot was not reported: the page is hidden)';
  return (
    `window.open('${CONFIG.originB}/doc') from the Tool A page → ${tab.id} (the page's own ` +
    `tiny.win.id is ${JSON.stringify(report.win)}) right after tool_tool-a: ${ids.join(', ')}; ${took}`
  );
}

async function checkOpenLinkByHand(): Promise<string> {
  const before = await stateOf();
  const active = before.active as string;
  await typeOpenLink(`${CONFIG.originC}/doc`);
  const state = await waitForState('the link tab', (next) => next.tabs.some((tab) => tab.id === 'link_1'));
  const ids = state.tabs.map((item) => item.id);
  expect(document.getElementById('open-link-dialog') === null, 'the dialog stayed open');
  expect(
    ids[rowIndex(state, active) + 1] === 'link_1',
    `link_1 sits at ${ids.indexOf('link_1')} of ${ids.join(', ')} (after ${active})`,
  );
  link1Id = 'link_1';
  const report = await waitForReport(
    'the link page',
    (item) => item.tool === 'C' && item.note === 'load' && item.href.endsWith('/doc'),
  );
  link1 = track(report);
  const linkWindow = link1.win ?? '';
  expect(linkWindow.startsWith('link_'), `the window id is ${JSON.stringify(link1.win)}`);

  // One more by hand, never saved: RF-66's "temporary" and T6's "not restored".
  await typeOpenLink(`${CONFIG.originC}/doc2`);
  const after = await waitForState('the second link tab', (next) =>
    next.tabs.some((tab) => tab.id === 'link_2'),
  );
  link2Id = 'link_2';
  const report2 = await waitForReport(
    'the second link page',
    (item) => item.tool === 'C' && item.note === 'load' && item.pid !== link1.pid,
  );
  link2 = track(report2);
  return (
    `"Open link…" with Enter in the field: ${after.tabs.map((tab) => tab.id).join(', ')} — link_1 ` +
    `(${JSON.stringify(link1.win)}) right after ${active}, link_2 (${JSON.stringify(link2.win)}) ` +
    `right after it`
  );
}

// ------------------------------------------------------------- RF-68: no API for an ad-hoc tab

async function checkAdhocNoApi(): Promise<string> {
  const first = a1;
  const adopted = popup;
  const hand = link1;
  expect(first !== null && adopted !== null && hand !== null, 'the tabs were never tracked');
  await activateRow('tool_tool-a');
  const tool = await ask(first.pid, 'api', 'login.report');
  expect(tool.apiError === 'ok', `the tool tab's login.report was refused: ${JSON.stringify(tool.apiError)}`);
  await activateRow(popupId);
  const adhoc = await ask(adopted.pid, 'api', 'login.report');
  expect(
    adhoc.apiError !== null && adhoc.apiError !== 'ok',
    `the ad-hoc tab's login.report was answered ${JSON.stringify(adhoc.apiError)}`,
  );
  await activateRow(link1Id);
  const link = await ask(hand.pid, 'api', 'login.report');
  expect(
    link.apiError !== null && link.apiError !== 'ok',
    `the hand-opened ad-hoc tab's login.report was answered ${JSON.stringify(link.apiError)}`,
  );
  const ids = (await stateOf()).tabs.filter((tab) => tab.adhoc).map((tab) => tab.id);
  expect(
    ids.every((id) => !id.startsWith('tool_')),
    `an ad-hoc tab wears a tool window id: ${ids.join(', ')}`,
  );
  return (
    `the same method on the same runtime: the tool tab ${JSON.stringify(first.win)} answered "ok"; the ` +
    `adopted ${JSON.stringify(adopted.win)} → ${JSON.stringify(adhoc.apiError)}; the hand-opened ` +
    `${JSON.stringify(hand.win)} → ${JSON.stringify(link.apiError)}`
  );
}

// ------------------------------------------------------------- RF-67: save in one step

async function checkSaveView(): Promise<string> {
  const adopted = popup;
  expect(adopted !== null, 'the adopted tab was never tracked');
  const before = await waitForValue('Tool B in the catalog', async () => {
    const list = (await call('catalog.list')) as Entry[];
    return list.find((entry) => entry.id === 'tool-b') ?? null;
  });
  await activateRow(popupId);
  await clickToolbar('Save to sidebar');
  const entry = await waitForValue('Tool B to gain a view', async () => {
    const list = (await call('catalog.list')) as Entry[];
    const found = list.find((item) => item.id === 'tool-b');
    return found !== undefined && found.views.length > before.views.length ? found : null;
  });
  const view = entry.views[entry.views.length - 1];
  expect(view.url === `${CONFIG.originB}/doc`, `the saved view is at ${view.url}`);
  expect(view.mode === 'window', `the saved view mode is ${JSON.stringify(view.mode)}`);
  const banner = await waitForStatus('Saved as a view of');
  const tab = tabOf(await stateOf(), popupId);
  expect(tab.adhoc === true, 'saving a view turned the ad-hoc tab into a tool tab');
  return (
    `${popupId} (${CONFIG.originB}/doc, the origin of Tool B) saved as view "${view.label}" of tool-b ` +
    `(${view.url}, mode ${view.mode}); tool-b ${before.views.length} → ${entry.views.length} view(s), ` +
    `the tab stays ad-hoc; banner ${JSON.stringify(text(banner))}`
  );
}

async function checkSaveTool(): Promise<string> {
  const hand = link1;
  expect(hand !== null, 'the hand-opened tab was never tracked');
  await activateRow(link1Id);
  const before = await waitForValue('the sidebar rows', () => {
    const titles = sidebarTitles();
    return titles.length > 0 ? titles : null;
  });
  await clickToolbar('Save to sidebar');
  const entry = await waitForValue('the new personal tool', async () => {
    const list = (await call('catalog.list')) as Entry[];
    return list.find((item) => item.url === `${CONFIG.originC}/doc`) ?? null;
  });
  expect(entry.scope === 'personal', `the saved entry's scope is ${JSON.stringify(entry.scope)}`);
  personalId = entry.id;
  const titles = await waitForValue('the sidebar row', () => {
    const found = sidebarTitles();
    return found.some((title) => title.includes(entry.title)) ? found : null;
  }).catch(async (error: unknown) => {
    const all = (await call('catalog.list')) as Entry[];
    throw new Error(
      `${message(error)}; the sidebar shows ${JSON.stringify(sidebarTitles())} and the new entry is ` +
        `${entry.id} ${JSON.stringify(entry.title)} scope ${JSON.stringify(entry.scope)}; the tools are ` +
        `${JSON.stringify((await stateOf()).tools.map((tool) => `${tool.id}:${tool.title}`))}; the ` +
        `catalog has ${JSON.stringify(all.map((item) => `${item.id}:${item.title}`))}`,
    );
  });
  const state = await waitForState('the tab to become a tool tab', (next) => {
    const tab = next.tabs.find((item) => item.id === link1Id);
    return tab !== undefined && tab.toolId === entry.id ? next : null;
  });
  const tab = tabOf(state, link1Id);
  expect(tab.adhoc === false, 'the saved tab is still ad-hoc');
  expect(tab.docked === true, 'the saved tab left the panel');
  const report = await ask(hand.pid, 'report');
  expectSame(hand, report, 'saving the tab');
  const banner = await waitForStatus('to the sidebar');
  return (
    `${link1Id} (${CONFIG.originC}/doc, an origin no catalog names) → personal tool ${entry.id} ` +
    `${JSON.stringify(entry.title)} with its probed title, sidebar ${before.length} → ${titles.length} ` +
    `row(s); the tab became its tool tab (${tab.id}, adhoc ${tab.adhoc}) without reloading; banner ` +
    `${JSON.stringify(text(banner))}`
  );
}

// ------------------------------------------------------------- RF-52/RF-19: windows mode

async function checkWindowsMode(): Promise<string> {
  const before = await stateOf();
  const saved = before.tabs.length;
  await openSettingsTab('Account');
  const card = await waitForValue('the Window mode card', () => sectionCard('Window mode'));
  const windows = card.querySelector<HTMLInputElement>('input[name=window-mode][value=windows]');
  const docked = card.querySelector<HTMLInputElement>('input[name=window-mode][value=docked]');
  expect(docked !== null && !docked.disabled, 'the Docked option is not offered on this machine');
  expect(windows !== null, 'the Window mode card has no Windows option');
  windows.click();
  const state = await waitForState('windows mode', (next) => next.mode === 'windows');
  expect(state.active === null, `active = ${JSON.stringify(state.active)} in windows mode`);
  const stillDocked = state.tabs.filter((tab) => tab.docked).length;
  expect(stillDocked === 0, `${stillDocked} tab(s) are still docked in windows mode`);
  await openHome();
  expect(document.querySelector('.tab-strip') === null, 'the panel still draws a tab strip');
  expect(document.querySelector('.tab-slot') === null, 'the panel still carries a slot');

  await call('tools.open', { id: 'tool-b' });
  const opened = await waitForState('the Tool B window', (next) =>
    next.tabs.some((tab) => tab.id === 'tool_tool-b'),
  );
  expect(opened.active === null, 'a windows-mode tool window took the panel');
  const wm = await floatWm();
  await sleep(300);
  const page = await waitForReport(
    'the Tool B window page',
    (report) => report.tool === 'B' && report.note === 'load' && report.href.endsWith('/tab'),
  );
  const main = await mainState();
  if (main === null) throw new Error('the main window reported no state');
  const screen = await onScreen();
  const mainWindow = screen.windows.find((window) => window.title === MAIN_TITLE);
  const space = mainWindow === undefined ? null : spaceFrom(main, mainWindow);
  const toolWindows = screen.windows.filter((window) => window.title !== MAIN_TITLE);
  // Several tool windows are on screen in this mode: the one under test is the tool's own, by title.
  const tool = toolWindows.find((window) => window.title === 'Tool B') ?? toolWindows[0];
  const frame = space === null || tool === undefined ? null : toPoints(tool, space);
  const border = frame === null ? null : frame.height - page.innerHeight;
  expect(border !== null, `the Tool B window is not on screen; ${screen.windows.length} window(s)`);
  expect((border as number) >= 20, `the windows-mode window has no frame (${border} pt of border)`);
  return (
    `Account → Window mode → Windows: mode=windows, active=null, the ${saved} tab(s) left the panel ` +
    `(no strip, no slot); tools.open(tool-b) → a window of ${page.innerWidth}x${page.innerHeight} pt ` +
    `with ${border} pt of frame at ${frame === null ? '?' : rectText(frame)}, while the main window ` +
    `sits at ${main.x},${main.y}; ${toolWindows.length} tool window(s) on screen; ${wm}`
  );
}

async function checkRf19(): Promise<string> {
  const page = await waitForReport(
    'the Tool B window page',
    (report) => report.tool === 'B' && report.note === 'load' && report.href.endsWith('/tab'),
  );
  await call('tools.open', { id: 'tool-b' });
  const again = await ask(page.pid, 'report');
  expect(
    again.timeOrigin === page.timeOrigin,
    `RF-19: the window reloaded (timeOrigin ${page.timeOrigin} → ${again.timeOrigin})`,
  );
  const loads = loadedTimes(await reports(), page.pid);
  expect(loads === 1, `the Tool B window loaded ${loads} times`);
  const after = await stateOf();
  expect(
    after.tabs.filter((tab) => tab.id === 'tool_tool-b').length === 1,
    'a second window was opened for the same tool',
  );
  return (
    `tools.open(tool-b) a second time: the window is the same one (1 tab of tool-b, ${loads} load) and ` +
    `its page kept timeOrigin ${Math.round(again.timeOrigin)}`
  );
}

// ------------------------------------------------------------- T6: lock and unlock

async function checkRestore(): Promise<string> {
  const before = await stateOf();
  const saved = before.tabs.filter((tab) => !tab.adhoc);
  const adhocIds = before.tabs.filter((tab) => tab.adhoc).map((tab) => tab.id);
  const titles = saved.map((tab) => tab.title);
  expect(adhocIds.length >= 2, `only ${adhocIds.length} ad-hoc tab(s) before the lock`);
  expect(personalId !== '', 'no personal tool was saved');

  const lock = all<HTMLButtonElement>('.sidebar-action').find((button) =>
    text(button).includes('Lock'),
  );
  expect(lock !== undefined, 'the sidebar has no Lock action');
  lock.click();
  await waitForValue('the entry rail', () => document.querySelector('.entry-rail .tile'));
  expect(document.querySelector('.shell') === null, 'the shell survived the lock');

  const tile = await waitForValue('the Offline tile', () =>
    document.querySelector<HTMLButtonElement>('.entry-rail [data-tile=offline]'),
  );
  tile.click();
  const email = await waitForValue('the offline email field', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=email]'),
  );
  setValue(email, EMAIL);
  const password = await waitForValue('the offline password field', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=password]'),
  );
  setValue(password, PASSWORD);
  const enter = await waitForValue('the Enter offline button', () =>
    document.querySelector<HTMLButtonElement>('.entry-pane [data-action=enter-offline]'),
  );
  enter.click();
  await waitForValue('the unlocked shell', () => document.querySelector('.shell')).catch(
    (error: unknown) => {
      const why = all<HTMLElement>('.entry-pane .message-error').map(text).join(' | ');
      throw new Error(`${message(error)}; the entry pane says ${why || '(nothing)'}`);
    },
  );

  const restored = await waitForState(`${saved.length} restored tab(s)`, (state) =>
    state.tabs.length === saved.length ? state : null,
  );
  const ids = restored.tabs.map((tab) => tab.id);
  const back = restored.tabs.map((tab) => tab.title);
  expect(
    back.join(' | ') === titles.join(' | '),
    `the restored order is ${back.join(' | ')}; before the lock it was ${titles.join(' | ')}`,
  );
  expect(
    ids.every((id) => !adhocIds.includes(id) && !id.startsWith('popup_') && !id.startsWith('link_')),
    `an ad-hoc tab came back: ${ids.join(', ')}`,
  );
  expect(ids[0] === 'tool_tool-a', `the first restored tab is ${ids[0]}`);
  expect(ids.includes(`tool_${personalId}`), `the personal tool did not reopen: ${ids.join(', ')}`);
  const loads = (await reports()).filter((report) => report.note === 'load').length;
  return (
    `locked from the sidebar, entered again through the Offline tile: ${ids.join(', ')} reopened in the ` +
    `saved order (${back.join(' | ')}); the ${adhocIds.length} ad-hoc tab(s) ${adhocIds.join(', ')} did ` +
    `not come back; ${loads} page load(s) in the whole run`
  );
}

// ------------------------------------------------------------- RF-69 embedded tabs

/**
 * Closes every tab so the RF-69 steps start from an empty strip: through each row's × while the
 * strip is on screen. Switching Windows→Docked leaves every tab detached and the panel on Home, so
 * there is no strip to click — the same `tabs.close` the × runs is called instead (setup only).
 */
async function closeAllTabs(): Promise<number> {
  let closed = 0;
  const strip = document.querySelector('.tab-strip') !== null;
  for (let guard = 0; guard < 12; guard += 1) {
    const state = await stateOf();
    if (state.tabs.length === 0) return closed;
    if (strip) {
      const rows = await stripRows();
      const close = rows[0]?.querySelector<HTMLButtonElement>('.tab-close');
      if (close === null || close === undefined) return closed;
      close.click();
    } else {
      await call('tabs.close', { id: state.tabs[0].id });
    }
    await waitForState(`one fewer tab (${state.tabs.length - 1})`, (next) => next.tabs.length < state.tabs.length);
    closed += 1;
  }
  return closed;
}

/** The visible iframe of an embedded tab, and its box against the slot's. */
async function embeddedGeometry(what: string): Promise<{ frame: HTMLIFrameElement; rect: Rect; slot: Rect }> {
  const frame = await waitForValue('the embedded iframe', () => {
    const found = document.querySelector<HTMLIFrameElement>('iframe.tab-embed');
    return found !== null && !found.hidden ? found : null;
  });
  const slotNode = document.querySelector('.tab-slot');
  expect(slotNode !== null, `${what}: the panel has no slot`);
  const slot = slotNode.getBoundingClientRect();
  const rect = frame.getBoundingClientRect();
  expect(
    near(rect.x, slot.x) && near(rect.y, slot.y) && near(rect.width, slot.width) && near(rect.height, slot.height),
    `${what}: the iframe is at ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x` +
      `${Math.round(rect.height)} and the slot at ${Math.round(slot.x)},${Math.round(slot.y)} ` +
      `${Math.round(slot.width)}x${Math.round(slot.height)}`,
  );
  return {
    frame,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    slot: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
  };
}

async function checkDockedAgain(): Promise<string> {
  await openSettingsTab('Account');
  const card = await waitForValue('the Window mode card', () => sectionCard('Window mode'));
  const docked = card.querySelector<HTMLInputElement>('input[name=window-mode][value=docked]');
  expect(docked !== null && !docked.disabled, 'the Docked option is not offered on this machine');
  docked.click();
  await waitForState('docked mode', (state) => state.mode === 'docked');
  const closed = await closeAllTabs();
  await clickSidebarTool('Tool A');
  const state = await waitForState('one docked Tool A tab', (next) =>
    next.tabs.length === 1 && next.active === 'tool_tool-a' ? next : null,
  );
  return (
    `Docked back from the Account card, ${closed} old tab(s) closed through their ×, ` +
    `${state.tabs.map((tab) => tab.id).join(', ')} (one docked tab); embedded list ` +
    `${JSON.stringify(state.embedded)}`
  );
}

async function checkEmbedOnSlot(): Promise<string> {
  await activateRow('tool_tool-a');
  await reseat();
  const slotBox = document.querySelector('.tab-slot');
  expect(slotBox !== null, 'the panel has no slot');
  await clickToolbar('Show inside Nod');
  const state = await waitForState('the tab to become embedded', (next) =>
    next.tabs.some((tab) => tab.embedded) ? next : null,
  );
  const tab = state.tabs.find((item) => item.embedded);
  expect(tab !== undefined, 'no embedded tab came back');
  const embeddedTab = tab as TabState;
  expect(embeddedTab.id === 'embed_tool-a', `the embedded id is ${embeddedTab.id}`);
  expect(state.active === embeddedTab.id, `active = ${JSON.stringify(state.active)}`);
  expect(state.embedded.includes('tool-a'), `embedded list = ${JSON.stringify(state.embedded)}`);
  const rows = await stripRows();
  const row = rows[rowIndex(state, embeddedTab.id)];
  expect(row.querySelector('.tab-embedded') !== null, 'the strip does not mark it ▣ (inside Nod)');
  expect(row.querySelector('.tab-dock') === null, 'an embedded tab offers a dock button');

  const settled = await settleScreen();
  const windows = settled.reading.windows.filter((window) => window.title !== MAIN_TITLE);
  expect(
    windows.length === 0,
    `${windows.length} tool window(s) still on screen for an embedded tab: ` +
      windows.map((window) => `${JSON.stringify(window.title)} ${window.width}x${window.height}`).join('; '),
  );
  const geometry = await embeddedGeometry('show inside Nod');
  const src = geometry.frame.getAttribute('src') ?? '';
  expect(src === `${CONFIG.originA}/tab`, `the iframe src is ${src}`);

  const report = await waitForReport(
    'the framed Tool A page',
    (item) => item.tool === 'A' && item.note === 'load' && item.pid !== (a1?.pid ?? ''),
  );
  framed = track(report);
  expect(report.href === `${CONFIG.originA}/tab`, `the framed page is at ${report.href}`);
  geometry.frame.dataset.smoke = 'framed';
  return (
    `Show inside Nod → ${embeddedTab.id} (▣, no dock button), active; the window server shows ` +
    `${windows.length} tool window(s) (settled in ${settled.ms} ms); the iframe is ` +
    `${Math.round(geometry.rect.width)}x${Math.round(geometry.rect.height)} at ` +
    `${Math.round(geometry.rect.x)},${Math.round(geometry.rect.y)} = the slot; src ${src}; the framed ` +
    `page reported itself (timeOrigin ${Math.round(report.timeOrigin)}, draft ${report.draft})`
  );
}

async function checkEmbedSurvives(): Promise<string> {
  const page = framed;
  expect(page !== null, 'the embedded page was never tracked');
  const marked = document.querySelector<HTMLIFrameElement>('iframe.tab-embed');
  expect(marked !== null, 'the iframe is gone before the switches');
  // Another tab on the panel, then the embedded one again; then Home and back through the sidebar.
  await clickSidebarTool('Tool B');
  await waitForState('Tool B on the panel', (next) => next.active === 'tool_tool-b');
  await activateRow('embed_tool-a');
  const afterSwitch = document.querySelector<HTMLIFrameElement>('iframe.tab-embed');
  expect(afterSwitch === marked, 'the iframe was re-created by the tab switch');
  await openHome();
  const layer = document.querySelector<HTMLElement>('.tab-embeds');
  expect(layer === null || layer.hidden, 'the iframe layer is still shown on Home');
  await clickSidebarTool('Tool A');
  await waitForState('the embedded tab back on the panel', (next) => next.active === 'embed_tool-a');
  const back = document.querySelector<HTMLIFrameElement>('iframe.tab-embed');
  expect(back === marked, 'the iframe is not the same node after Home');
  expect(back.dataset.smoke === 'framed', 'the iframe lost the marker the driver set');
  const again = await ask(page.pid, 'report');
  expectSame(page, again, 'the switches and Home');
  const loads = loadedTimes(await reports(), page.pid);
  expect(loads === 1, `the framed page loaded ${loads} times`);
  return (
    `tab switch + Home + sidebar back: the same iframe node (data-smoke kept), timeOrigin ` +
    `${Math.round(again.timeOrigin)} and draft ${again.draft} unchanged, ${loads} load`
  );
}

async function checkEmbedRefused(): Promise<string> {
  await clickSidebarTool('Tool D');
  const opened = await waitForState('the Tool D window', (next) =>
    next.tabs.some((tab) => tab.id === 'tool_tool-d') && next.active === 'tool_tool-d' ? next : null,
  );
  const before = opened.tabs.find((tab) => tab.id === 'tool_tool-d') as TabState;
  expect(before.embedded === false, 'Tool D opened embedded');
  await clickToolbar('Show inside Nod');
  const banner = await waitForStatus('cannot be shown inside Nod');
  const said = text(banner);
  expect(/x-frame-options/i.test(said), `the banner says ${JSON.stringify(said)}`);
  const state = await stateOf();
  const tab = state.tabs.find((item) => item.id === 'tool_tool-d') as TabState;
  expect(tab.embedded === false, 'Tool D became embedded anyway');
  expect(!state.embedded.includes('tool-d'), `the preference was stored: ${JSON.stringify(state.embedded)}`);
  const frame = document.querySelector('iframe.tab-embed');
  return (
    `Tool D (${CONFIG.originD}/tab, X-Frame-Options: SAMEORIGIN) → "Show inside Nod" refused: ` +
    `${JSON.stringify(said)}; the tab stays a window (embedded ${tab.embedded}, embedded list ` +
    `${JSON.stringify(state.embedded)}); iframes on the page: ${frame === null ? 0 : 1}`
  );
}

async function checkOpenAsWindow(): Promise<Outcome> {
  const before = await stateOf();
  const open = before.tabs.find((tab) => tab.toolId === 'tool-a');
  expect(open !== undefined, 'no Tool A tab is open to bring back');
  await activateRow((open as TabState).id);
  await clickToolbar('Open as window');
  const state = await waitForState('the tab to become a window again', (next) =>
    next.tabs.some((tab) => tab.id === 'tool_tool-a' && !tab.embedded) ? next : null,
  );
  expect(!state.embedded.includes('tool-a'), `the preference stayed: ${JSON.stringify(state.embedded)}`);
  const tab = tabOf(state, 'tool_tool-a');
  expect(tab.toolId === 'tool-a', `the docked tab is ${tab.id}`);
  if ((await wmTiled()).length > 0) return await blockedByTiler(a1 as Tracked, 'the window cannot be measured on the slot');
  await reseat();
  const measured = await measure(a1 as Tracked, 'after Open as window', false);
  expectPageBox(measured, 'after Open as window');
  expectOnSlot(measured, 'after Open as window');
  expect(
    document.querySelector('iframe.tab-embed') === null,
    'the iframe of the converted tab is still in the document',
  );
  const loads = loadedTimes(await reports(), (a1 as Tracked).pid);
  return (
    `Open as window → ${tab.id} (docked, active), the iframe removed; the real window is on the slot: ` +
    `${measuredText(measured)}; tab 1's own page still has ${loads} load`
  );
}

async function checkEmbedRestored(): Promise<string> {
  const before = await stateOf();
  const open = before.tabs.find((tab) => tab.toolId === 'tool-a');
  expect(open !== undefined, 'no Tool A tab is open to embed');
  await activateRow((open as TabState).id);
  await clickToolbar('Show inside Nod');
  await waitForState('the tab embedded again', (next) =>
    next.tabs.some((tab) => tab.embedded && tab.id === 'embed_tool-a') ? next : null,
  );
  const geometry = await embeddedGeometry('before the lock');
  const page = framed;
  expect(page !== null, 'the embedded page was never tracked');
  geometry.frame.dataset.smoke = 'before-lock';

  const lock = all<HTMLButtonElement>('.sidebar-action').find((button) =>
    text(button).includes('Lock'),
  );
  expect(lock !== undefined, 'the sidebar has no Lock action');
  lock.click();
  await waitForValue('the entry rail', () => document.querySelector('.entry-rail .tile'));
  const tile = await waitForValue('the Offline tile', () =>
    document.querySelector<HTMLButtonElement>('.entry-rail [data-tile=offline]'),
  );
  tile.click();
  const email = await waitForValue('the offline email field', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=email]'),
  );
  setValue(email, EMAIL);
  const password = await waitForValue('the offline password field', () =>
    document.querySelector<HTMLInputElement>('.entry-pane input[name=password]'),
  );
  setValue(password, PASSWORD);
  const enter = await waitForValue('the Enter offline button', () =>
    document.querySelector<HTMLButtonElement>('.entry-pane [data-action=enter-offline]'),
  );
  enter.click();
  await waitForValue('the unlocked shell', () => document.querySelector('.shell'));

  const restored = await waitForState('the embedded tab restored', (next) =>
    next.tabs.some((tab) => tab.embedded) ? next : null,
  );
  const tab = restored.tabs.find((item) => item.embedded) as TabState;
  expect(tab.id === 'embed_tool-a', `the restored embedded id is ${tab.id}`);
  expect(tab.toolId === 'tool-a', `the restored embedded tab has toolId ${JSON.stringify(tab.toolId)}`);
  const frame = await waitForValue('the restored iframe', () =>
    document.querySelector<HTMLIFrameElement>('iframe.tab-embed'),
  );
  expect(
    (frame.getAttribute('src') ?? '') === `${CONFIG.originA}/tab`,
    `the restored iframe src is ${frame.getAttribute('src')}`,
  );
  const report = await waitForReport(
    'the restored framed page',
    (item) => item.tool === 'A' && item.note === 'load' && item.pid !== page.pid,
  );
  framed = track(report);
  return (
    `locked and entered again: ${tab.id} (embedded, tool-a) reopened with its iframe ` +
    `(${frame === null ? 'missing' : 'src ' + (frame.getAttribute('src') ?? '')}); the new framed page ` +
    `loaded (timeOrigin ${Math.round(report.timeOrigin)}) — the frame is a fresh page after the lock, ` +
    `as every tab is`
  );
}

// ------------------------------------------------------------- harness

/** A check's answer: the step's detail, or the reason the session made its subject unobservable. */
interface Blocked {
  blocked: string;
}

type Outcome = string | Blocked;
type Checks = ReadonlyArray<readonly [string, () => Promise<Outcome>]>;

function blocked(why: string): Blocked {
  return { blocked: why };
}

const CHECKS: Checks = [
  ['RF-52 default mode on macOS', checkDefaultMode],
  ['RF-49 a sidebar click opens one docked tab on the panel', checkOpenDocked],
  ['RF-49 the docked tab lands on the slot', checkOpenOnSlot],
  ['RF-49 the docked tab follows a resize', checkResizeFollow],
  ['RF-50 + opens a second tab of the tool', checkSecondTab],
  ['RF-50 the second tab takes the slot', checkSecondOnSlot],
  ['RF-50 switching tabs keeps the draft', checkSwitchKeepsDraft],
  ['RF-51 detach brings the frame back without reloading', checkDetach],
  ['RF-51 the strip docks it back without reloading', checkDockBack],
  ['RF-66 a tool popup becomes a tab beside its opener', checkPopupAdoption],
  ['RF-66 Open link… opens one by hand', checkOpenLinkByHand],
  ['RF-68 an ad-hoc tab gets no API', checkAdhocNoApi],
  ['RF-67 save a tab of a known origin (view)', checkSaveView],
  ['RF-67 save a tab of a new origin (tool)', checkSaveTool],
  ['RF-52 Windows mode: framed windows, no panel', checkWindowsMode],
  ['RF-19 a second open focuses, never reloads', checkRf19],
  ['T6 lock and unlock restore the tabs', checkRestore],
  ['RF-69 docked again with one tab to embed', checkDockedAgain],
  ['RF-69 Show inside Nod: no window, an iframe on the slot', checkEmbedOnSlot],
  ['RF-69 switches and Home never reload the frame', checkEmbedSurvives],
  ['RF-69 an X-Frame-Options tool is refused', checkEmbedRefused],
  ['RF-69 lock and unlock restore it embedded', checkEmbedRestored],
  ['RF-69 Open as window brings the tab back', checkOpenAsWindow],
];

async function run(): Promise<void> {
  try {
    const state = (await call('session.state')) as unknown as { hasAccount: boolean };
    if (state.hasAccount === false) await setupLocalAccount();
  } catch (error) {
    record('0 setup', false, `error: ${message(error)}`, 0);
    return;
  }
  let stopped = false;
  for (const [name, check] of CHECKS) {
    if (stopped) {
      record(name, false, 'did not run', 0);
      continue;
    }
    const start = Date.now();
    currentStep = name;
    let ok = false;
    let isBlocked = false;
    let detail = '';
    // A check that never returns (a stalled bridge, a window nobody is looking at) must not take the
    // smoke's result with it: the watchdog writes the steps collected so far and says which one hung.
    const watchdog = setTimeout(() => {
      record(name, false, `stalled: this step did not answer within ${STEP_BUDGET_MS} ms`, Date.now() - start);
      void writeResult(true, `the step "${name}" stalled`);
    }, STEP_BUDGET_MS);
    try {
      const outcome = await check();
      if (typeof outcome === 'string') {
        detail = outcome;
        ok = true;
      } else {
        detail = outcome.blocked;
        isBlocked = true;
      }
    } catch (error) {
      detail = `error: ${message(error)}`;
    } finally {
      clearTimeout(watchdog);
    }
    record(name, ok, detail, Date.now() - start, isBlocked);
    stopped = !ok && !isBlocked;
    await writeResult(false, null);
  }
}

(async function () {
  'use strict';
  try {
    await waitForTiny();
    watchCalls();
    startHeartbeat();
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
