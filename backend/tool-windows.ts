// Tool windows, tabs, docked mode, the login cascade and global shortcuts
// (docs/arquitetura.md §4; canonico §7, §8, §11, §14; epic E03, `docs/epics/E03-docked-tabs.md`).
//
// Every tool window is a **tab**. The first tab of a tool keeps the day-one id — `tool_<entry>`, or
// `tool_<entry>_<viewIndex>` for a `window` view — and every further one is `tool_<entry>_t<n>`
// (`shared/tabs.ts`), so `toolOfWindow` keeps answering the same tool for every tab. A tab may also
// belong to no entry: an **ad-hoc tab** (`link_<n>`, or a popup the site opened and the Nod adopted)
// is never persisted, never counted for a tool, never cascaded and never gets `eval` (RF-66, RF-68).
//
// Two modes, never chosen by a person (RF-52): **docked** wherever the runtime can position windows,
// where the active tab lies frameless on the slot the main page reports, follows the main window and
// hides with it; and **windows** only where the runtime cannot position windows at all (Wayland),
// the day-one behavior — one framed window per tool, opening an open tool only focuses it, nothing
// reloads (RF-19). Only the active docked tab is visible; the others keep their page alive, hidden
// (RF-50), and detaching or docking is a `setChrome` on the same window — never a reload (RF-51).
// The geometry, the poll and the stacking recipe are `docs/handovers/e03-spikes.md` §8.
//
// Every runtime call goes through a guard: a window that vanished, a refused `eval` or an
// unsupported global shortcut may not take the backend down — the effect of the failure lands in
// the tool state the sidebar reads (docs/arquitetura.md §2, §4).

import { adapterScript } from './login-adapter';
import { auditUrl, originOf } from '../shared/catalog';
import { newCascade, stepCascade } from '../shared/login-cascade';
import { isIdentityPath } from '../shared/probe';
import { combo, ctrlCombo, digits, shiftCombo } from '../shared/shortcuts';
import {
  insertAfter,
  linkWindowId,
  neighbourAfterClose,
  nextLinkNumber,
  nextTabNumber,
  parseLinkUrl,
  parsePersistedTabs,
  rectEquals,
  slotToScreen,
  stepTab,
  tabWindowId,
} from '../shared/tabs';
import { MAIN_WINDOW, toolWindowId } from '../shared/types';
import type { CascadeAction, CascadeSignal, CascadeState } from '../shared/login-cascade';
import type { PersistedTab } from '../shared/tabs';
import type {
  AuditEvent,
  Entry,
  EventType,
  Id,
  LoginResult,
  ReportState,
  SaveTabResult,
  SlotRect,
  TabState,
  ToolStatus,
  ToolsState,
  View,
  WindowMode,
} from '../shared/types';

/** Failure reasons the sidebar shows; never a raw runtime message. */
const OPEN_FAILED = 'could not open the tool window';
const LOAD_FAILED = 'failed to load';
const EVAL_FAILED = 'could not reach the tool window';
/** Default tool window: 1280×800, capped at 90% of the usable area of the main window's screen. */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const SCREEN_LIMIT = 0.9;
/** Cascade away from the main window's top-left corner, in screen coordinates. */
const CASCADE_OFFSET = 28;
/** The cascade re-checks a fill that the page never reported after this long (A7). */
const FILL_CHECK_MS = 4000;
/** Key of the persisted list of open tabs in the store. */
const STORE_KEY = 'open_tools';
/** The docked tab follows the main window by polling it: 50 ms lag, ~0.04 ms a read (S2). */
const MOVE_POLL_MS = 50;

/** What the window of a link that did not come from the org is titled (canonico §22, B7). */
const FOREIGN_TITLE = 'Not from your org';

/** The id of the banner `warningScript` puts in the page: it is how the script stays idempotent. */
const WARNING_BANNER_ID = 'nod-not-from-org';

/**
 * canonico §22, owner 2026-10-16: "Org tools — the entries of the release seed — get camera and
 * microphone without a prompt. Any other origin keeps the engine's own prompt … and the Nod warns
 * when a link didn't come from the org."
 *
 * The warning is the banner above: a bar the window shows once it has loaded, in the tool window
 * itself, which is where the person is about to grant a camera. It is the only thing this module
 * injects into a tool page besides the login adapter, and it follows the same rules
 * (`docs/arquitetura.md` §2): the top frame only, nothing read from the page, nothing thrown out,
 * and the text is this side's — the page's own strings never enter it. An ad-hoc tab (RF-66) never
 * gets it: it is not a tool of anybody's catalog.
 *
 * The camera/microphone half is not a runtime call: `tinyjs.json`'s origin gate opens `media.camera`
 * and `media.microphone` for the origins of the release seed's entries alone (`scripts/gen-config.ts`)
 * and a personal tool is not one of them, so its window keeps the engine's own prompt. This banner is
 * what the person sees beside it.
 */
export function warningScript(): string {
  const data = { id: WARNING_BANNER_ID, title: FOREIGN_TITLE, text: 'This link was not added by your organization. Camera and microphone need your permission.', close: 'Dismiss' };
  return `(() => { try {
  if (window.top !== window) return;
  if (document.getElementById(${JSON.stringify(data.id)}) !== null) return;
  const bar = document.createElement('div');
  bar.id = ${JSON.stringify(data.id)};
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;box-sizing:border-box;display:flex;gap:8px;align-items:center;justify-content:center;padding:6px 10px;background:#7a1d1d;color:#fff;font:13px/1.4 system-ui,sans-serif;';
  const text = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = ${JSON.stringify(data.title)};
  text.append(strong, document.createTextNode(' — ' + ${JSON.stringify(data.text)}));
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = ${JSON.stringify(data.close)};
  close.style.cssText = 'all:unset;cursor:pointer;padding:2px 8px;border:1px solid rgba(255,255,255,0.6);border-radius:4px;';
  close.addEventListener('click', () => bar.remove());
  bar.append(text, close);
  (document.body || document.documentElement).appendChild(bar);
} catch { /* the warning is best effort: the window keeps working without it */ } })();`;
}

export interface ToolWindowsDeps {
  /** entries visible to the current person (empty when locked) */
  entries(): Entry[];
  /** icon of the entry as a data URI */
  icon(id: Id): string | null;
  /**
   * RF-65: the credential this tool's window fills with — the default of the tool, because a person
   * may hold several of one and which one fills is their own choice (`backend/main.ts`'s
   * `credentialOf` reads `Vault.readDefault`). The window knows its tool, never a credential id.
   */
  credential(toolId: Id): Promise<{ username: string; secret: string } | null>;
  /**
   * The origin the default credential of this tool was saved for (SP02 §8, RF-38, RF-65); `null`
   * when the person holds no credential of the tool — or one with no origin on record, which no fill
   * may use either. Synchronous on purpose: the cascade needs the answer before it decides to inject
   * (`shared/login-cascade.ts` rule 4), and the attempt it counts decides whether a `no-form` report
   * reads `filled` or `session` (rule 5).
   */
  vaultOrigin(toolId: Id): string | null;
  /** audit (canonico §13); the person goes in here, not in the window */
  record(e: Omit<AuditEvent, 'id' | 'at'>): void;
  store: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<boolean> };
  os: 'macos' | 'windows' | 'linux';
  hotkeys: boolean;
  /**
   * E03/RF-67: what ⌘D does — `backend/main.ts`'s `tabs.save` body, which needs the catalog, the
   * probe and the personal layer. Only the tab id crosses (`tabForSave` gave it the address) and the
   * answer is ignored here: the page learns from the pushed state.
   */
  saveTab(id: string): Promise<SaveTabResult>;
}

/** Surface of `backend/tool-windows.ts` (docs/arquitetura.md §4). */
export interface ToolWindows {
  state(): ToolsState;
  /** window open → `show()` (focus, no reload); otherwise opens it */
  open(id: Id): Promise<ToolsState>;
  openView(toolId: Id, index: number): Promise<ToolsState>;
  /** closes every window of the tool */
  close(id: Id): ToolsState;
  reload(id: Id): Promise<ToolsState>;
  /** tool windows + tracked popups (on lock — D1); keeps the persisted list for `restore()` */
  closeAll(): void;
  restore(): Promise<void>;
  /** closes windows of tools that are no longer visible (canonico §10) */
  reconcile(): void;
  onNavigate(ev: TinyNavEvent): 'deny' | 'external' | undefined;
  onReport(windowId: string, state: ReportState, origin: string | undefined): void;
  onPopup(info: TinyPopupEvent): 'window' | 'external' | 'deny' | undefined;
  onWindowClosed(id: string): void;
  /** focus, minimize and visibility of every window of ours (`backend/main.ts`'s `onWindowState`) */
  onWindowState(ev: TinyWindowStateEvent): void;
  onHotkey(id: string): void;

  // ---------------------------------------------------------------- E03 (RF-49…RF-52, RF-66…RF-68)

  /** `tabs.new` (⌘T): one more tab of the tool, on the tool's own address */
  newTab(toolId: Id): Promise<ToolsState>;
  /** `tabs.activate`: a docked tab goes on the slot, a detached one comes forward */
  activate(id: string): Promise<ToolsState>;
  /** `tabs.close` (⌘W): closes one tab; an ad-hoc one is forgotten (RF-66) */
  closeTab(id: string): ToolsState;
  /** `tabs.next` (⌃Tab / ⌃⇧Tab): the next or previous tab of the strip, wrapping */
  next(step: 1 | -1): ToolsState;
  /** `tabs.detach` (RF-51): the tab leaves the panel into its own framed window, same page */
  detach(id: string): ToolsState;
  /** `tabs.dock` (RF-51): a detached tab snaps back onto the slot and becomes the active one */
  dock(id: string): ToolsState;
  /** `tabs.slot` (RF-49): the center panel's rect in CSS px, or `null` when nothing may show */
  setSlot(rect: SlotRect | null): true;
  /** `tabs.openLink` (RF-66): an `http(s)` link as an ad-hoc tab after the active one */
  openLink(url: string): Promise<ToolsState>;
  /** E03/RF-67: what `tabs.save` reads of a tab — its address as the page has it, or nothing */
  tabForSave(id: string): { id: string; toolId: Id | null; url: string } | null;
  /** E03/RF-67: the tab that just became a personal tool is a tool tab of the new entry */
  adoptSavedTab(id: string, toolId: Id): ToolsState;
}

/**
 * A live tab. `origin` is the only origin the adapter may run in inside this window
 * (docs/arquitetura.md §2); `loading` holds until the first `finish`. An ad-hoc tab (`toolId: null`)
 * has no cascade, no origin and never sees `eval` (RF-68).
 */
interface TabWindow {
  windowId: string;
  /** null: an ad-hoc tab — a hand-opened link, or a popup the site opened and the Nod adopted */
  toolId: Id | null;
  /** view index when this tab carries a `window`-mode view; null for the tool's own tab */
  view: number | null;
  /** last main-frame URL seen */
  url: string;
  /** canonical origin of the entry address; '' when the address is outside the catalog contract */
  origin: string;
  cascade: CascadeState;
  loading: boolean;
  error: string | null;
  /** origins seen in this window outside the entry origin (the identity provider) */
  seenOrigins: Set<string>;
  /** cancels the pending re-check of a fill the page never reported (A7); null when none is armed */
  cancelFillCheck: (() => void) | null;
  /**
   * canonico §22, B7: neither the entry nor the view is the org's own (a personal tool, or a personal
   * view), so the window says so and never gets the org's camera/microphone grant.
   */
  foreign: boolean;
  /** RF-66: not saved, not restored, no method, no autofill — an address of no catalog at all */
  adhoc: boolean;
  /** false: detached — its own framed window, off the panel (RF-51) */
  docked: boolean;
  /** whether we last showed it; a hidden tab keeps its page alive (RF-50) */
  shown: boolean;
  /** the slot rect the window sits on, so a re-place is skipped while nothing moved (S2) */
  placed: SlotRect | null;
}

/** One tab the module is about to open: everything `spawn` needs before the window exists. */
interface SpawnSpec {
  windowId: string;
  toolId: Id | null;
  view: number | null;
  /** the address the tab opens with */
  address: string;
  /** the window title */
  title: string;
  /** the address whose origin the tab belongs to; '' for an ad-hoc tab */
  entryUrl: string;
  foreign: boolean;
  /** insert right after this tab (a link, an adopted popup); null appends at the end */
  after: string | null;
  /** off the panel from birth: a windows-mode window, or a restored detached tab */
  detached: boolean;
  /** the tab becomes the active one when it lands docked (RF-49) */
  activate: boolean;
}

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** canonico §22: a personal tool — or a personal view under any entry — is not from the org. */
function isForeign(entry: Entry, view: number | null): boolean {
  return entry.scope === 'personal' || (view !== null && entry.views[view]?.scope === 'personal');
}

export function createToolWindows(app: TinyApp, deps: ToolWindowsDeps): ToolWindows {
  /** The live tabs, by window id. */
  const tabs = new Map<string, TabWindow>();
  /** The strip order (E03): every live tab, tool or ad-hoc, in the order the person sees them. */
  let order: string[] = [];
  /** The tabs by use, most recent first: which tab of a tool `tools.open` reaches for. */
  let recent: string[] = [];
  /** The active tab — the one a docked mode shows on the slot; null while in windows mode. */
  let active: string | null = null;
  /** Whether the runtime can position windows here (`canPosition !== false`, i.e. not Wayland). */
  let dockable = true;
  let capabilitiesLoaded: Promise<void> | null = null;
  /** The slot the main page reported: page coordinates, and the screen rect they land on. */
  let slotPage: SlotRect | null = null;
  let slotScreen: SlotRect | null = null;
  /** The main window, as the last state event and `getState()` told it (RF-49, RF-15). */
  let mainMinimized = false;
  let mainVisible = true;
  /** The move poll (S2): armed while a docked tab is on the slot and main is there to follow. */
  let poll: ReturnType<typeof setInterval> | null = null;
  /** Last cascade result in this session, per tool (`ToolStatus.login`). */
  const logins = new Map<Id, LoginResult>();
  /** Failures with no live window behind them (the window never opened). */
  const failures = new Map<Id, string>();
  /** Nod windows focused right now: only with one focused do the shortcuts exist (canonico §7). */
  const focused = new Set<string>();
  /** Popup windows a tool window opened and that are still live: closed on lock (D1). */
  const popups = new Set<string>();
  /**
   * The popups the docked policy answered `'window'` for, and the tab that opened them (S4: the
   * `open` event carries no `opener`): what `onPopup` adopts once the window exists.
   */
  const adopting = new Map<string, string>();
  /** Windows being opened: repeated calls for the same id may not open two windows. */
  const opening = new Set<string>();
  /** Shortcuts this module registered — the same id is never registered twice. */
  const registered = new Set<string>();

  // This machine's capability of positioning windows comes from main's own state, and `state()` is
  // synchronous: it is read once, here, so the answer is in place long before the page's first call
  // (and every entry point awaits the same promise).
  void loadCapabilities();

  // ------------------------------------------------------------ runtime, always under a guard

  function handle(id: string): TinyWindowHandle | null {
    try {
      return app.window(id);
    } catch {
      return null;
    }
  }

  function openWindow(id: string, options: TinyOpenWindowOptions): boolean {
    try {
      app.win.open(id, options);
      return true;
    } catch {
      return false;
    }
  }

  function closeWindow(id: string): void {
    const window = handle(id);
    if (window === null) return;
    try {
      window.close();
    } catch {
      // the window was already gone
    }
  }

  /**
   * E03: `activate` is the plain `show()` — a tab the person asked for comes forward and takes
   * focus. A docked tab is only ever raised with `{ activate: false }`, which puts it back above
   * main without stealing the focus (S3, `docs/handovers/e03-spikes.md` §5).
   */
  function showTab(id: string, activate: boolean): void {
    const window = handle(id);
    if (window === null) return;
    try {
      if (activate) window.show();
      else window.show({ activate: false });
    } catch {
      // the window was already gone
    }
  }

  /** Puts a docked tab away **without the app**: its page stays alive, so nothing reloads (RF-50). */
  function hideTab(id: string): void {
    const window = handle(id);
    if (window === null) return;
    try {
      window.hide({ app: false });
    } catch {
      // the window was already gone
    }
  }

  function evaluate(id: string, js: string): boolean {
    const window = handle(id);
    if (window === null) return false;
    try {
      window.eval(js);
      return true;
    } catch {
      return false;
    }
  }

  /** Best effort: with no window to receive it, the state stays in the backend. */
  function publish(): void {
    try {
      app.push('tools', state());
    } catch {
      // push is best effort
    }
  }

  /**
   * E03: the backend itself opened or moved to a tab — a hotkey, an adopted popup, a `nod://open`
   * link, `tools.open` in docked mode — so the page shows it (`PushEvents.tab`). Nothing is pushed
   * in windows mode: there is no strip to move.
   */
  function announce(id: string | null): void {
    if (id === null || effectiveMode() !== 'docked') return;
    try {
      app.push('tab', id);
    } catch {
      // best effort: the page reads the same answer from the next `tools` push
    }
  }

  /**
   * Audit (canonico §13). `personId` leaves as `null` on purpose: the session is who knows the
   * person (`backend/main.ts`), which overwrites that field in the `record` it passes down here.
   * An ad-hoc tab audits `toolId: null` (RF-66): it belongs to no catalog entry.
   */
  function record(
    toolId: Id | null,
    type: EventType,
    url: string | null,
    result: string | null,
    detail: string | null,
  ): void {
    try {
      deps.record({ personId: null, toolId, type, url, result, detail });
    } catch {
      // auditing never takes a window down: the problem is the database, not the window
    }
  }

  /** Canonical origin of an address: '' when the address is outside the catalog contract. */
  function entryOrigin(url: string): string {
    try {
      return originOf(url);
    } catch {
      return '';
    }
  }

  /** Raw origin of a URL the page navigated to (the cascade compares raw origins). */
  function urlOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  function schemeOf(url: string): string {
    try {
      return new URL(url).protocol;
    } catch {
      return '';
    }
  }

  /** The host of an address, which is what an ad-hoc tab is titled with; '' when unreadable. */
  function hostOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /** `deps.entries()` under a guard: a throwing source may not take a runtime hook down. */
  function visible(): Entry[] {
    try {
      return deps.entries();
    } catch {
      return [];
    }
  }

  function entryOf(toolId: Id): Entry | null {
    return visible().find((entry) => entry.id === toolId) ?? null;
  }

  // ------------------------------------------------------------ mode and the main window (RF-49, RF-52)

  /**
   * The mode in force: `docked` wherever the runtime can position a window, `windows` where it
   * cannot (Wayland). Nothing stores it and no person chooses it (RF-52).
   */
  function effectiveMode(): WindowMode {
    return dockable ? 'docked' : 'windows';
  }

  /** This machine's capability of positioning windows, once; every entry point calls it. */
  async function loadCapabilities(): Promise<void> {
    if (capabilitiesLoaded !== null) return await capabilitiesLoaded;
    capabilitiesLoaded = (async (): Promise<void> => {
      const state = await mainState();
      if (state !== null) dockable = state.canPosition !== false;
    })();
    return await capabilitiesLoaded;
  }

  /** The main window's own state, under the guard every runtime call goes through. */
  async function mainState(): Promise<TinyWinState | null> {
    try {
      return await app.win.getState();
    } catch {
      return null;
    }
  }

  /** What `getState()` says of main: whether it is on screen at all (the tray-close case). */
  function applyMainState(state: TinyWinState): void {
    mainMinimized = state.minimized;
    mainVisible = state.visible;
  }

  /** Re-reads main and puts the docked tabs where they belong (RF-49). */
  async function readMainState(): Promise<void> {
    const state = await mainState();
    if (state === null) return;
    applyMainState(state);
    syncDocked();
    updatePoll();
  }

  // ------------------------------------------------------------ geometry

  /** Shared area between a window rectangle and a screen frame, in square pixels. */
  function overlap(rect: WindowRect, screen: TinyScreen): number {
    const left = Math.max(rect.x, screen.x);
    const right = Math.min(rect.x + rect.width, screen.x + screen.width);
    const top = Math.max(rect.y, screen.y);
    const bottom = Math.min(rect.y + rect.height, screen.y + screen.height);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  function primaryScreen(screens: TinyScreen[]): TinyScreen {
    return screens.find((screen) => screen.primary) ?? screens[0];
  }

  /** The screen holding the main window; the primary when it sits on none (or overlaps equally). */
  function screenOf(screens: TinyScreen[], main: TinyWinState): TinyScreen {
    let best = primaryScreen(screens);
    let bestArea = 0;
    for (const screen of screens) {
      const area = overlap(main, screen);
      if (area > bestArea) {
        bestArea = area;
        best = screen;
      }
    }
    return best;
  }

  /**
   * Default geometry of a windows-mode tool window: 1280×800 capped at 90% of the usable area of the
   * screen holding `main`, cascaded +28 px from the main window's top-left. `null` when the runtime
   * cannot tell the screens — then the launcher decides where the window lands.
   */
  async function geometry(): Promise<WindowRect | null> {
    try {
      const screens = await app.screens();
      if (screens.length === 0) return null;
      const main = await app.win.getState();
      const screen = main === null ? primaryScreen(screens) : screenOf(screens, main);
      return {
        x: Math.round(main === null ? screen.visible.x : main.x + CASCADE_OFFSET),
        y: Math.round(main === null ? screen.visible.y : main.y + CASCADE_OFFSET),
        width: Math.min(DEFAULT_WIDTH, Math.round(screen.visible.width * SCREEN_LIMIT)),
        height: Math.min(DEFAULT_HEIGHT, Math.round(screen.visible.height * SCREEN_LIMIT)),
      };
    } catch {
      return null;
    }
  }

  /**
   * Where a detached tab goes: a step off the panel, every further tab another step. `null` while
   * the page has reported no slot — then the caller keeps the cascade of `geometry()`.
   */
  function detachRect(step = 0): WindowRect | null {
    if (slotScreen === null) return null;
    const shift = CASCADE_OFFSET * (step + 1);
    return {
      x: slotScreen.x + shift,
      y: slotScreen.y + shift,
      width: slotScreen.width,
      height: slotScreen.height,
    };
  }

  /**
   * E03/RF-49: puts a docked tab exactly on the slot. A place that would not move the window is
   * skipped (S2): the poll runs every 50 ms and the person may be resizing the slot right now.
   */
  function place(tab: TabWindow): void {
    const rect = slotScreen;
    if (rect === null || rectEquals(rect, tab.placed)) return;
    const window = handle(tab.windowId);
    if (window === null) return;
    try {
      window.setPosition(rect.x, rect.y);
      window.setSize(rect.width, rect.height);
      tab.placed = rect;
    } catch {
      // the window may have closed between the read and the call
    }
  }

  /** The active tab, or null in windows mode where nothing is on the panel. */
  function activeTab(): TabWindow | null {
    const tab = active === null ? undefined : tabs.get(active);
    return tab ?? null;
  }

  /** The active tab while it is docked (RF-49: only a docked tab has a place on the slot). */
  function activeDockedTab(): TabWindow | null {
    const tab = activeTab();
    return tab !== null && tab.docked ? tab : null;
  }

  /** The first docked tab of the strip, in order. */
  function firstDocked(): TabWindow | null {
    for (const id of order) {
      const tab = tabs.get(id);
      if (tab !== undefined && tab.docked) return tab;
    }
    return null;
  }

  /** The tab the slot may show right now: the active one, and only while the panel is up (RF-49). */
  function showableTab(): TabWindow | null {
    if (effectiveMode() !== 'docked' || slotScreen === null || !mainVisible || mainMinimized) {
      return null;
    }
    return activeDockedTab();
  }

  /**
   * RF-50: only the active docked tab is visible, the rest stay hidden with their page alive. The
   * window that was just opened is visible already; the hidden ones come back with the slot.
   * `raise` is S3: main just took focus, so the active tab goes back **above** it — `show({
   * activate: false })` re-orders without stealing the focus (`docs/handovers/e03-spikes.md` §5).
   */
  function syncDocked(raise = false): void {
    const wanted = showableTab();
    for (const tab of tabs.values()) {
      if (!tab.docked) continue;
      if (tab === wanted) {
        place(tab);
        if (!tab.shown || raise) {
          showTab(tab.windowId, false);
          tab.shown = true;
        }
      } else if (tab.shown) {
        hideTab(tab.windowId);
        tab.shown = false;
      }
    }
  }

  // ------------------------------------------------------------ following the main window (RF-49)

  /** Arms or drops the 50 ms poll: only while main is focused with a docked tab to hold (S2). */
  function updatePoll(): void {
    // S2: the runtime reports no move, so the tab is held by polling main. The poll must not wait on
    // focus: a tiling WM, a Space or monitor change and a WM shortcut all move main without giving it
    // the focus, and the tab would be left behind. What ends it is main going away (minimized or
    // hidden) or nothing docked being shown any more — then there is nothing to hold.
    const wanted =
      effectiveMode() === 'docked' &&
      !mainMinimized &&
      mainVisible &&
      slotPage !== null;
    if (!wanted) {
      stopPoll();
      return;
    }
    if (poll === null) poll = setInterval(() => void pollSlot(), MOVE_POLL_MS);
  }

  function stopPoll(): void {
    if (poll === null) return;
    clearInterval(poll);
    poll = null;
  }

  /** One poll tick: re-derive the slot's screen rect from main and re-place when it moved. */
  async function pollSlot(): Promise<void> {
    const state = await mainState();
    if (state === null) return;
    applyMainState(state);
    if (slotPage === null) return;
    slotScreen = slotToScreen(state, slotPage);
    syncDocked();
  }

  /** `tabs.slot` (RF-49): the center panel as the page sees it, or `null` for "nothing may show". */
  function setSlot(rect: SlotRect | null): true {
    slotPage = rect === null ? null : { ...rect };
    if (rect === null) {
      slotScreen = null;
      syncDocked();
      updatePoll();
      return true;
    }
    void refreshSlot();
    return true;
  }

  /** The page moved (or opened) the panel: the screen rect comes from main's own state. */
  async function refreshSlot(): Promise<void> {
    const state = await mainState();
    if (state !== null) applyMainState(state);
    slotScreen = state === null || slotPage === null ? null : slotToScreen(state, slotPage);
    syncDocked();
    updatePoll();
  }

  // ------------------------------------------------------------ the tab list

  /** Moves a tab to the front of the use order. */
  function touch(id: string): void {
    recent = [id, ...recent.filter((entry) => entry !== id)];
  }

  /** The live tabs of one tool, in strip order. */
  function tabsOf(toolId: Id): TabWindow[] {
    const list: TabWindow[] = [];
    for (const id of order) {
      const tab = tabs.get(id);
      if (tab !== undefined && tab.toolId === toolId) list.push(tab);
    }
    return list;
  }

  /** The tab of `list` used most recently — what `tools.open` reaches for first. */
  function mostRecent(list: TabWindow[]): TabWindow | null {
    for (const id of recent) {
      const found = list.find((tab) => tab.windowId === id);
      if (found !== undefined) return found;
    }
    return list[0] ?? null;
  }

  /**
   * E03: the window id a new tab of the tool takes — `tool_<entry>`, or `tool_<entry>_t<n>` from the
   * second tab on (`shared/tabs.ts`); the first tab of a `window` view keeps `tool_<entry>_<i>`.
   */
  function freeTabId(toolId: Id, view: number | null): string {
    const first = view === null ? toolWindowId(toolId) : toolWindowId(toolId, view);
    if (!tabs.has(first)) return first;
    return tabWindowId(toolId, nextTabNumber(toolId, order));
  }

  /**
   * E03/RF-49: the docked tab that takes the slot when `id` leaves it — the strip's right neighbour
   * when that one is docked, else the left one, else the first docked tab left (`shared/tabs.ts`
   * `neighbourAfterClose` is the strip rule; a detached neighbour has no place on the panel).
   * Called while `id` is still in the strip (close, the person's own close) or already detached.
   */
  function successorTab(id: string): TabWindow | null {
    const neighbour = neighbourAfterClose(order, id);
    const found = neighbour === null ? undefined : tabs.get(neighbour);
    if (found !== undefined && found.docked) return found;
    for (const candidate of order) {
      if (candidate === id) continue;
      const tab = tabs.get(candidate);
      if (tab !== undefined && tab.docked) return tab;
    }
    return null;
  }

  /** Takes a tab out of the strip and the maps; the caller closes its window (or it is gone). */
  function dropTab(id: string): TabWindow | null {
    const tab = tabs.get(id);
    if (tab === undefined) return null;
    tabs.delete(id);
    order = order.filter((entry) => entry !== id);
    recent = recent.filter((entry) => entry !== id);
    clearFillCheck(tab);
    focused.delete(id);
    if (active === id) active = null;
    return tab;
  }

  /** E03/RF-49: makes a docked tab the one on the slot — its window is not touched (no reload). */
  function activateTab(tab: TabWindow): void {
    if (!tab.docked) {
      focusTab(tab);
      return;
    }
    active = tab.windowId;
    touch(tab.windowId);
    syncDocked();
    updatePoll();
  }

  /** A tab the person asked for comes forward with focus (its window, its place). */
  function focusTab(tab: TabWindow): void {
    showTab(tab.windowId, true);
    tab.shown = true;
    touch(tab.windowId);
  }

  /** The shared body of `tabs.activate` and ⌃Tab: docked goes on the slot, detached comes forward. */
  function selectTab(id: string): TabWindow | null {
    const tab = tabs.get(id) ?? null;
    if (tab === null) return null;
    if (tab.docked && effectiveMode() === 'docked') activateTab(tab);
    else focusTab(tab);
    return tab;
  }

  // ------------------------------------------------------------ opening

  /**
   * Creates the window and registers it as a tab. Returns true only when the window was opened now
   * (the launcher took the call).
   */
  async function spawn(spec: SpawnSpec): Promise<boolean> {
    const mode = effectiveMode();
    const docked = !spec.detached && mode === 'docked';
    let rect: WindowRect | null;
    if (docked) {
      // On the slot right away when the page has reported one (S1); the cascade only covers the
      // moment before the panel exists, and the tab follows the slot as soon as it does.
      rect = slotScreen ?? (await geometry());
    } else if (mode === 'docked') {
      rect = detachRect() ?? (await geometry());
    } else {
      rect = await geometry(); // windows mode: the day-one cascade
    }
    const options: TinyOpenWindowOptions = {
      page: spec.address,
      // canonico §22: a tool that is not the org's says so before the page loads (B7).
      title: spec.foreign ? `${FOREIGN_TITLE} — ${spec.title}` : spec.title,
    };
    if (rect !== null) {
      options.x = rect.x;
      options.y = rect.y;
      options.size = `${rect.width}x${rect.height}`;
    }
    // Frameless at open, before the first paint (S1): a detach later is a `setChrome` on a live
    // window, which the page survives with its state.
    if (docked) options.chrome = { frame: false };
    if (!openWindow(spec.windowId, options)) {
      if (spec.toolId !== null) failures.set(spec.toolId, OPEN_FAILED);
      record(spec.toolId, 'load_failed', auditUrl(spec.address), 'failed', OPEN_FAILED);
      publish();
      return false;
    }
    if (spec.toolId !== null) failures.delete(spec.toolId);
    const origin = spec.entryUrl === '' ? '' : entryOrigin(spec.entryUrl);
    const tab: TabWindow = {
      windowId: spec.windowId,
      toolId: spec.toolId,
      view: spec.view,
      url: spec.address,
      origin,
      cascade: newCascade(origin),
      loading: true,
      error: null,
      seenOrigins: new Set(),
      cancelFillCheck: null,
      foreign: spec.foreign,
      adhoc: spec.toolId === null,
      docked,
      shown: true,
      placed: null,
    };
    tabs.set(spec.windowId, tab);
    order = insertAfter(order, spec.after, spec.windowId);
    touch(spec.windowId);
    if (docked && spec.activate) active = spec.windowId;
    // The launcher ignored `x`/`size` of `win.open` in the v1 (observed by execution, S0): the
    // geometry goes onto the handle right after the window exists, in the same tick.
    if (rect !== null) {
      const window = handle(spec.windowId);
      if (window !== null) {
        try {
          window.setPosition(rect.x, rect.y);
          window.setSize(rect.width, rect.height);
          if (docked) tab.placed = rect;
        } catch {
          // the window may have closed before the geometry landed
        }
      }
    }
    syncDocked();
    updatePoll();
    publish();
    return true;
  }

  /** Opens the tool's own tab, cold, at `address` (A8) — docked or as a framed window. */
  async function openColdTab(entry: Entry, address: string, docked: boolean): Promise<string | null> {
    const windowId = toolWindowId(entry.id);
    if (opening.has(windowId)) return null;
    opening.add(windowId);
    try {
      const created = await spawn({
        windowId,
        toolId: entry.id,
        view: null,
        address,
        title: entry.title,
        entryUrl: entry.url,
        foreign: entry.scope === 'personal',
        after: null,
        detached: !docked,
        activate: docked,
      });
      return created ? windowId : null;
    } finally {
      opening.delete(windowId);
    }
  }

  /**
   * Windows mode `tools.open` (RF-19): the tool's window is focused, or opened framed. `address`
   * carries the address of a `navigate`-mode view the tab opens straight at (A8).
   */
  async function openTool(entry: Entry, address?: string): Promise<boolean> {
    const windowId = toolWindowId(entry.id);
    const live = tabs.get(windowId);
    if (live !== undefined) {
      focusTab(live); // focus, no reload (RF-19)
      return false;
    }
    const opened = await openColdTab(entry, address ?? entry.url, false);
    if (opened === null) return false;
    record(entry.id, 'tool_opened', auditUrl(entry.url), null, null);
    return true;
  }

  /**
   * Docked `tools.open` (RF-49): the tool's docked tab becomes the active one, its detached tab
   * comes forward, and only a tool with no tab at all opens another.
   */
  async function openToolDocked(entry: Entry): Promise<string | null> {
    const list = tabsOf(entry.id);
    const onPanel = mostRecent(list.filter((tab) => tab.docked));
    if (onPanel !== null) {
      activateTab(onPanel);
      return onPanel.windowId;
    }
    const away = mostRecent(list.filter((tab) => !tab.docked));
    if (away !== null) {
      focusTab(away);
      return away.windowId;
    }
    const opened = await openColdTab(entry, entry.url, true);
    if (opened !== null) record(entry.id, 'tool_opened', auditUrl(entry.url), null, null);
    return opened;
  }

  /** ⌘T / `tabs.new` (RF-50): one more tab of the tool, on the tool's own address. */
  async function addTab(toolId: Id): Promise<string | null> {
    const entry = entryOf(toolId);
    if (entry === null) throw new Error('unknown tool');
    await loadCapabilities();
    const docked = effectiveMode() === 'docked';
    const windowId = freeTabId(entry.id, null);
    if (opening.has(windowId)) return null;
    opening.add(windowId);
    try {
      const created = await spawn({
        windowId,
        toolId: entry.id,
        view: null,
        address: entry.url,
        title: entry.title,
        entryUrl: entry.url,
        foreign: entry.scope === 'personal',
        after: null,
        detached: !docked,
        activate: docked,
      });
      if (!created) return null;
      record(entry.id, 'tool_opened', auditUrl(entry.url), null, null);
      persist();
      publish();
      return windowId;
    } finally {
      opening.delete(windowId);
    }
  }

  /** A `window`-mode view tab (`tool_<entry>_<viewIndex>`, E03): focused when it is already open. */
  async function openViewTab(
    entry: Entry,
    index: number,
    address: string,
    title: string,
    docked: boolean,
  ): Promise<string | null> {
    const windowId = toolWindowId(entry.id, index);
    if (tabs.has(windowId)) {
      selectTab(windowId);
      return windowId;
    }
    if (opening.has(windowId)) return null;
    opening.add(windowId);
    try {
      const created = await spawn({
        windowId,
        toolId: entry.id,
        view: index,
        address,
        title,
        entryUrl: entry.url,
        foreign: isForeign(entry, index),
        after: null,
        detached: !docked,
        activate: docked,
      });
      if (!created) return null;
      record(entry.id, 'view_opened', auditUrl(address), null, viewLabel(entry, index));
      return windowId;
    } finally {
      opening.delete(windowId);
    }
  }

  function viewLabel(entry: Entry, index: number): string | null {
    const view = entry.views[index];
    return view === undefined ? null : view.label;
  }

  function viewTitle(entry: Entry, index: number): string {
    const label = viewLabel(entry, index);
    return label === null ? entry.title : `${entry.title} · ${label}`;
  }

  /** E03 (RF-66): an ad-hoc tab of a link opened by hand (`tabs.openLink`, `nod://open?url=`). */
  async function openLink(url: string): Promise<ToolsState> {
    // E03/RF-66: the shared parser is the one rule — `http(s)` (or a bare host) and nothing else, no
    // credentials in the address, within 2048 characters. It answers the normalized href, which is
    // what opens; the caller (`tabs.openLink`, `onOpenUrl`) may have parsed the same way already.
    const href = parseLinkUrl(url);
    if (href === null) throw new Error('invalid link');
    await loadCapabilities();
    const docked = effectiveMode() === 'docked';
    const windowId = linkWindowId(nextLinkNumber(order));
    let opened = false;
    if (!opening.has(windowId)) {
      opening.add(windowId);
      try {
        opened = await spawn({
          windowId,
          toolId: null,
          view: null,
          address: href,
          title: hostOf(href),
          entryUrl: '',
          foreign: false,
          after: active, // right after the tab the person is on (RF-66)
          detached: !docked,
          activate: docked,
        });
      } finally {
        opening.delete(windowId);
      }
    }
    if (opened) announce(windowId); // a `nod://open?url=` link is the backend acting on its own
    persist();
    publish();
    return state();
  }

  /** E03/RF-67: the address `tabs.save` acts on — the tab's own, as the page has it. */
  function tabForSave(id: string): { id: string; toolId: Id | null; url: string } | null {
    const tab = tabs.get(id);
    if (tab === undefined) return null;
    return { id, toolId: tab.toolId, url: tab.url };
  }

  /**
   * E03/RF-67: the tab that just became a personal tool is a tool tab of the new entry — the same
   * window, the same page, nothing reloads. Only an ad-hoc tab (`toolId === null`) is relabelled: a
   * tool tab keeps its own tool, its count and its strip label, and the save is just a new sidebar
   * item next to it. The window id keeps its `link_`/`popup` name: renaming it would mean reopening
   * the window, which is the one thing detaching may never do (RF-51).
   */
  function adoptSavedTab(id: string, toolId: Id): ToolsState {
    const tab = tabs.get(id);
    if (tab !== undefined && tab.adhoc && tab.toolId === null) {
      const entry = entryOf(toolId);
      const origin = entryOrigin(entry?.url ?? '');
      tab.toolId = toolId;
      tab.adhoc = false;
      tab.origin = origin;
      tab.cascade = newCascade(origin);
      // canonico §22, B7: it is a personal tool's window now, so it carries the warning like any
      // other one. The page is already on that origin, which is where the banner belongs.
      tab.foreign = entry?.scope === 'personal';
      warnForeign(tab);
      persist();
      publish();
    }
    return state();
  }

  // ------------------------------------------------------------ persistence

  /**
   * E03: the tab's address as `open_tools` keeps it — origin + path, no query or fragment, and only
   * while it still sits on the entry's own origin (a tab that went somewhere else restores at the
   * tool's address). An ad-hoc tab is never persisted (RF-66).
   */
  function keptUrl(tab: TabWindow): string | null {
    if (tab.toolId === null) return null;
    const entry = entryOf(tab.toolId);
    if (entry === null) return null;
    const audit = auditUrl(tab.url);
    if (audit === null || audit === '') return null;
    return urlOrigin(audit) === entryOrigin(entry.url) ? audit : null;
  }

  /** Rewrites `open_tools` from the live tabs: every open, close, dock and detach lands here. */
  function persist(): void {
    const list: PersistedTab[] = [];
    const docked = effectiveMode() === 'docked';
    for (const id of order) {
      const tab = tabs.get(id);
      if (tab === undefined) continue;
      const toolId = tab.toolId;
      if (toolId === null) continue; // ad-hoc tabs are not persisted
      const item: PersistedTab = { toolId };
      if (tab.view !== null) item.view = tab.view;
      const url = keptUrl(tab);
      if (url !== null) item.url = url;
      // In windows mode every tab is a window of its own: `detached` would say nothing.
      if (docked && !tab.docked) item.detached = true;
      if (id === active) item.active = true;
      list.push(item);
    }
    try {
      void deps.store.set(STORE_KEY, list).catch(() => undefined);
    } catch {
      // a store failure may not take a window down
    }
  }

  async function readPersisted(): Promise<PersistedTab[]> {
    let raw: unknown = null;
    try {
      raw = await deps.store.get(STORE_KEY);
    } catch {
      raw = null; // an unreadable store restores nothing, and does not break the unlock
    }
    return parsePersistedTabs(raw);
  }

  // ------------------------------------------------------------ state

  /** E03: the entry title (with the view label), or the host of a tab that belongs to no entry. */
  function tabTitle(tab: TabWindow): string {
    if (tab.toolId === null) return hostOf(tab.url);
    const entry = entryOf(tab.toolId);
    if (entry === null) return hostOf(tab.url);
    return tab.view === null ? entry.title : viewTitle(entry, tab.view);
  }

  function tabState(tab: TabWindow): TabState {
    return {
      id: tab.windowId,
      toolId: tab.toolId,
      title: tabTitle(tab),
      // RF-69: the iframe loads the full address; a window tab keeps the audit form.
      url: auditUrl(tab.url) ?? '',
      docked: tab.docked,
      adhoc: tab.adhoc,
      loading: tab.loading,
      error: tab.error,
    };
  }

  function state(): ToolsState {
    const entries = visible();
    const digitOf = new Map<Id, number>();
    for (const [digit, id] of digits(entries.map((entry) => entry.id))) digitOf.set(id, digit);
    const tools: ToolStatus[] = entries.map((entry): ToolStatus => {
      const live = [...tabs.values()].filter((tab) => tab.toolId === entry.id);
      const failing = live.find((tab) => tab.error !== null);
      let icon: string | null = null;
      try {
        icon = deps.icon(entry.id);
      } catch {
        icon = null;
      }
      return {
        id: entry.id,
        title: entry.title,
        icon,
        digit: digitOf.get(entry.id) ?? null,
        openWindows: live.length,
        loading: live.some((tab) => tab.loading),
        error: failing?.error ?? failures.get(entry.id) ?? null,
        login: logins.get(entry.id) ?? null,
      };
    });
    const current = effectiveMode();
    const list: TabState[] = [];
    for (const id of order) {
      const tab = tabs.get(id);
      if (tab !== undefined) list.push(tabState(tab));
    }
    return {
      tools,
      tabs: list,
      // Only a docked mode has a tab on the slot; `active` is never a detached or windows-mode tab.
      active: current === 'docked' ? (activeDockedTab()?.windowId ?? null) : null,
      mode: current,
      tabHotkeys: deps.hotkeys && current === 'docked',
    };
  }

  // ------------------------------------------------------------ login cascade

  /**
   * The context of one cascade step: whether the person holds a credential this window may use, and
   * whether the entry refuses the fill. A credential counts only for the origin it was saved for
   * (SP02 §8, RF-38): a tool whose address moved — a local edit or a host snapshot rewriting the
   * entry — has another entry origin, and the cascade reads it as a tool with no credential. It
   * then never counts an attempt and ends in `manual` (`shared/login-cascade.ts` rules 4, 5, 7),
   * and the keychain is never read: nothing secret is loaded for an origin the person did not save
   * it for.
   */
  function cascadeContext(tab: TabWindow): { hasCredential: boolean; noFill: boolean } {
    const toolId = tab.toolId;
    if (toolId === null) return { hasCredential: false, noFill: true };
    const entry = entryOf(toolId);
    const savedOrigin = deps.vaultOrigin(toolId);
    return {
      hasCredential: savedOrigin !== null && savedOrigin === tab.origin,
      noFill: entry?.auth?.noFill === true,
    };
  }

  /** Feeds the cascade, synchronously, and fires the action it asks for. An ad-hoc tab has none. */
  function signal(tab: TabWindow, input: CascadeSignal): void {
    if (tab.toolId === null) return;
    try {
      const step = stepCascade(tab.cascade, input, cascadeContext(tab));
      tab.cascade = step.state;
      void apply(tab, step.action, step.state);
    } catch {
      return; // a broken cascade never takes the window down
    }
  }

  /** The last URL seen still sits on the entry origin: the only place `eval` may run (D3). */
  function atEntryOrigin(tab: TabWindow): boolean {
    return tab.origin !== '' && urlOrigin(tab.url) === tab.origin;
  }

  /**
   * canonico §22 (owner, 2026-10-16), B7: the window of a link that did not come from the org shows
   * the warning. It is injected into the page once per navigation and only in the top frame of the
   * entry origin, the rule `eval` follows everywhere else in this module (D3) — a redirect to the
   * identity provider is the provider's page, not the tool's.
   *
   * A refused `eval` is not a failure of the window: the title already carries the warning
   * (`spawn`), and the sidebar and Home mark the entry too. An ad-hoc tab never gets it (RF-66).
   */
  function warnForeign(tab: TabWindow): void {
    if (tab.toolId === null) return;
    if (!tab.foreign || !atEntryOrigin(tab)) return;
    evaluate(tab.windowId, warningScript());
  }

  /** A7: a fill that the page never reported (an XHR login) gets a `finished` re-check later. */
  function armFillCheck(tab: TabWindow): void {
    clearFillCheck(tab);
    const timer = setTimeout(() => {
      tab.cancelFillCheck = null;
      if (tabs.get(tab.windowId) !== tab) return;
      signal(tab, { type: 'finished', url: tab.url });
    }, FILL_CHECK_MS);
    tab.cancelFillCheck = () => clearTimeout(timer);
  }

  function clearFillCheck(tab: TabWindow): void {
    if (tab.cancelFillCheck === null) return;
    tab.cancelFillCheck();
    tab.cancelFillCheck = null;
  }

  /**
   * Applies the action the last step asked for. `stepped` is the cascade state that step produced:
   * it is what the give-back below reads while it is still the window's state.
   */
  async function apply(
    tab: TabWindow,
    action: CascadeAction,
    stepped: CascadeState,
  ): Promise<void> {
    const toolId = tab.toolId;
    if (action.type === 'none' || toolId === null) return;
    if (action.type === 'result') {
      logins.set(toolId, action.result);
      record(toolId, 'login', auditUrl(tab.url), action.result, null);
      publish();
      return;
    }
    // The adapter runs only in the entry origin (docs/arquitetura.md §2); the cascade already
    // guarantees it, but `eval` is too late to bet on.
    if (!atEntryOrigin(tab)) return;
    let fill = action.fill;
    let username: string | undefined;
    let secret: string | undefined;
    if (fill) {
      let credential: { username: string; secret: string } | null = null;
      try {
        credential = await deps.credential(toolId);
      } catch {
        credential = null; // keychain unavailable: the tool's own login screen stays usable (RF-10)
      }
      if (credential === null || credential.username === '' || credential.secret === '') {
        fill = false;
        // The vault index said there was a credential and the keychain had none (a lost key, a
        // vault written elsewhere). The fill never happens, so the attempt the step counted goes
        // back: without it a `no-form` report would read `filled`/`failed` for a tool that has no
        // credential, when the answer is `session`/`manual` (shared/login-cascade.ts rules 4, 5, 7).
        // Only while `stepped` is still the current state — a signal that arrived during the await
        // owns the cascade now.
        if (tab.cascade === stepped) {
          tab.cascade = { ...stepped, attempts: stepped.attempts - 1 };
        }
      } else {
        username = credential.username;
        secret = credential.secret;
      }
    }
    // D3: after the await, the window must still exist and the last URL seen must still carry the
    // entry origin before the eval.
    if (tabs.get(tab.windowId) !== tab || !atEntryOrigin(tab)) return;
    const script =
      fill && username !== undefined && secret !== undefined
        ? adapterScript({ fill: true, origin: tab.origin, username, secret })
        : adapterScript({ fill: false, origin: tab.origin });
    if (!evaluate(tab.windowId, script)) {
      // A10: a refused eval is audited as a failed login.
      record(toolId, 'login', auditUrl(tab.url), 'failed', EVAL_FAILED);
      return;
    }
    if (fill) armFillCheck(tab);
  }

  // ------------------------------------------------------------ navigation and popups

  /** Records the origin of a main-frame navigation outside the entry origin (the provider). */
  function noteOrigin(tab: TabWindow, url: string): void {
    const origin = urlOrigin(url);
    if (origin === '' || origin === 'null' || origin === tab.origin) return;
    if (schemeOf(url) !== 'https:' && schemeOf(url) !== 'http:') return;
    tab.seenOrigins.add(origin);
  }

  /** A main-frame navigation: the cascade sees every redirect hop through it. */
  function navigated(tab: TabWindow, url: string): void {
    tab.url = url;
    if (tab.toolId === null) return; // RF-68: an ad-hoc tab has no cascade to feed
    noteOrigin(tab, url);
    signal(tab, { type: 'navigated', url });
  }

  function finished(tab: TabWindow, url: string): void {
    clearFillCheck(tab);
    tab.url = url;
    tab.error = null;
    tab.loading = false;
    if (tab.toolId !== null) {
      noteOrigin(tab, url);
      signal(tab, { type: 'finished', url });
      warnForeign(tab);
    }
    // The address of the tab is what `open_tools` remembers for the next unlock (E03, T6).
    persist();
    publish();
  }

  function loadFailed(tab: TabWindow, url: string, reason: string | undefined): void {
    clearFillCheck(tab);
    tab.loading = false;
    tab.error = LOAD_FAILED;
    record(tab.toolId, 'load_failed', auditUrl(url), 'failed', reason ?? null);
    publish();
  }

  function isLoopback(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '[::1]' ||
        /^127(\.\d{1,3}){3}$/.test(host)
      );
    } catch {
      return false;
    }
  }

  function onNavigate(ev: TinyNavEvent): 'deny' | 'external' | undefined {
    // Only the tabs of this module: the main window's own navigation is not its business, and a
    // popup left floating is the runtime's (E03 §5).
    const tab = tabs.get(ev.window);
    if (tab === undefined) return undefined;
    const scheme = schemeOf(ev.url);
    if (ev.kind === 'policy') {
      if (scheme === 'http:' && !isLoopback(ev.url)) {
        // A20: plain http outside loopback never loads.
        record(tab.toolId, 'navigation_blocked', auditUrl(ev.url), 'denied', scheme);
        return 'deny';
      }
      if (scheme === 'https:' || scheme === 'http:') {
        if (ev.isMainFrame !== false) navigated(tab, ev.url);
        return undefined;
      }
      if ((scheme === 'mailto:' || scheme === 'tel:') && ev.isMainFrame !== false) {
        record(tab.toolId, 'external_opened', auditUrl(ev.url), 'external', scheme);
        return 'external'; // it goes to the system browser, never into the webview
      }
      // D2: every other scheme is denied — and audited.
      record(tab.toolId, 'navigation_blocked', auditUrl(ev.url), 'denied', scheme);
      return 'deny';
    }
    if (ev.kind === 'start') {
      // The same main-frame signal: the navigation that in fact started (the `policy` also asks
      // about other frames and about schemes the webview never loads).
      if (ev.isMainFrame !== false) navigated(tab, ev.url);
      return undefined;
    }
    if (ev.kind === 'finish') {
      if (ev.isMainFrame === false) return undefined; // only the top frame drives the cascade
      finished(tab, ev.url);
      return undefined;
    }
    if (ev.kind === 'fail' || ev.kind === 'crash') {
      loadFailed(tab, ev.url, ev.error);
      return undefined;
    }
    return undefined;
  }

  function onReport(windowId: string, report: ReportState, origin: string | undefined): void {
    const tab = tabs.get(windowId);
    // RF-68: only a tool window reports a login; an ad-hoc tab has no adapter.
    if (tab === undefined || tab.toolId === null) return;
    // P9: a report that claims an origin other than the entry origin is ignored.
    if (origin !== undefined && origin !== tab.origin) return;
    signal(tab, { type: 'report', state: report });
  }

  /**
   * E03 §5: in docked mode a popup a tab opened is adopted as an ad-hoc tab right after its opener
   * (the `open` event carries no opener, so the `policy` answer remembers it). An identity path —
   * the OAuth windows of S4 — stays a floating popup in both modes: a popup the backend re-chromed
   * no longer honours its own `window.close()` (S4's caution).
   */
  function onPopup(info: TinyPopupEvent): 'window' | 'external' | 'deny' | undefined {
    if (info.kind === 'open') {
      if (info.action !== 'window' || info.window === null) return undefined;
      const opener = adopting.get(info.window) ?? null;
      adopting.delete(info.window);
      if (opener !== null && effectiveMode() === 'docked') {
        adopt(info.window, opener, info.url);
        return undefined;
      }
      // D1: a popup that became a window is tracked, so the lock closes it.
      popups.add(info.window);
      return undefined;
    }
    if (info.kind !== 'policy') return undefined;
    const opener = info.opener;
    if (opener === undefined) return undefined;
    const tab = tabs.get(opener);
    if (tab === undefined) return undefined;
    const scheme = schemeOf(info.url);
    if (scheme !== 'https:' && scheme !== 'http:') {
      record(tab.toolId, 'navigation_blocked', auditUrl(info.url), 'denied', scheme);
      return 'deny';
    }
    if (effectiveMode() === 'docked') {
      // RF-66: a link clicked inside a tab opens next to it — the whole point of the docked panel.
      // The identity providers keep today's floating popup (S4), which is what their flow needs.
      if (isIdentityPath(info.url)) return 'window';
      if (info.window !== null) adopting.set(info.window, tab.windowId);
      return 'window';
    }
    const target = urlOrigin(info.url);
    const known =
      target !== '' &&
      (target === tab.origin || tab.seenOrigins.has(target) || isIdentityPath(info.url));
    if (known) return 'window';
    record(tab.toolId, 'external_opened', auditUrl(info.url), 'external', null);
    return 'external';
  }

  /** E03 (RF-66): the popup the site opened becomes a docked ad-hoc tab right after its opener. */
  function adopt(id: string, opener: string, url: string): void {
    if (tabs.has(id)) return;
    const tab: TabWindow = {
      windowId: id,
      toolId: null,
      view: null,
      url,
      origin: '',
      cascade: newCascade(''),
      loading: true,
      error: null,
      seenOrigins: new Set(),
      cancelFillCheck: null,
      foreign: false,
      adhoc: true,
      docked: true,
      shown: true,
      placed: null,
    };
    tabs.set(id, tab);
    order = insertAfter(order, opener, id);
    touch(id);
    active = id;
    const window = handle(id);
    const rect = slotScreen;
    if (window !== null) {
      try {
        window.setChrome({ frame: false });
      } catch {
        // the window may have closed between the event and the adoption
      }
      if (rect !== null) {
        try {
          window.setPosition(rect.x, rect.y);
          window.setSize(rect.width, rect.height);
          tab.placed = rect;
        } catch {
          // ditto: the tab still follows the slot from the next place on
        }
      }
    }
    syncDocked();
    updatePoll();
    persist();
    publish();
    announce(id);
  }

  // ------------------------------------------------------------ global shortcuts

  function registerHotkey(id: string, key: string): void {
    if (registered.has(id)) return; // never registers the same id twice
    try {
      app.hotkey.register(id, key);
      registered.add(id);
    } catch {
      // the global shortcut is unavailable here: the rest of the app goes on (RNF-01)
    }
  }

  function unregisterHotkey(id: string): void {
    if (!registered.has(id)) return;
    try {
      app.hotkey.unregister(id);
    } catch {
      // it was already gone
    }
    registered.delete(id);
  }

  /**
   * Global shortcuts exist only while some Nod window is focused (canonico §7). Docked mode adds the
   * tab ones (E03): ⌘T, ⌘W, ⌘⇧D, ⌃Tab, ⌃⇧Tab, ⌘L and ⌘D. Windows mode (Wayland) has no strip, so
   * it keeps exactly the day-one set (RF-52).
   */
  function updateHotkeys(): void {
    if (!(deps.hotkeys && focused.size > 0)) {
      for (const id of [...registered]) unregisterHotkey(id);
      return;
    }
    for (let n = 1; n <= 9; n += 1) registerHotkey(`digit-${n}`, combo(String(n), deps.os));
    registerHotkey('palette', combo('k', deps.os));
    const strip = effectiveMode() === 'docked';
    const tabKeys: Array<[string, string]> = [
      ['tab-new', combo('t', deps.os)],
      ['tab-close', combo('w', deps.os)],
      ['tab-detach', shiftCombo('d', deps.os)],
      // ⌃Tab / ⌃⇧Tab are Control on every OS: the runtime's own chord, not the platform modifier.
      ['tab-next', ctrlCombo('tab')],
      ['tab-prev', ctrlCombo('tab', true)],
      ['open-link', combo('l', deps.os)],
      ['tab-save', combo('d', deps.os)],
    ];
    for (const [id, key] of tabKeys) {
      if (strip) registerHotkey(id, key);
      else unregisterHotkey(id);
    }
  }

  /**
   * E03/RF-49: main's focus, minimize and visibility. Focusing main puts it in front of a docked
   * tab, so the active one is re-placed and raised without activation (S3); minimizing or hiding
   * main takes the docked tabs with it and brings them back with it.
   */
  function onWindowState(ev: TinyWindowStateEvent): void {
    const ours = ev.win === MAIN_WINDOW || tabs.has(ev.win) || popups.has(ev.win);
    if (!ours) return;
    if (ev.focused) focused.add(ev.win);
    else focused.delete(ev.win);
    updateHotkeys();
    if (ev.win !== MAIN_WINDOW) return;
    mainMinimized = ev.minimized;
    if (ev.focused) {
      // RF-15: a window that took focus is on screen again — the tray had put it away, and without
      // this the tabs would stay hidden behind a cached `visible: false`.
      mainVisible = true;
      // S3: main is in front now, so the active tab is re-placed and raised above it.
      syncDocked(true);
    } else {
      // The window may have gone away with the tray (RF-15) rather than just losing focus.
      syncDocked();
      void readMainState();
    }
    updatePoll();
  }

  /**
   * E03: the tab a global tab hotkey acts on. The window the person is in wins (a detached tab, or
   * the docked one they clicked); with main focused it is the tab on the slot, and only while the
   * page is actually showing one (`slotScreen !== null` — Home, Settings, a dialog or the palette
   * report no slot). Any other focus (an identity popup, another app) has no target: a hotkey must
   * never close or detach a tab the person cannot see.
   */
  function hotkeyTab(): TabWindow | null {
    for (const id of focused) {
      if (id === MAIN_WINDOW) continue;
      const tab = tabs.get(id);
      if (tab !== undefined) return tab;
    }
    if (focused.has(MAIN_WINDOW) && slotScreen !== null) return activeDockedTab();
    return null;
  }

  function onHotkey(id: string): void {
    if (id === 'palette') {
      showTab(MAIN_WINDOW, true);
      try {
        app.push('palette', null);
      } catch {
        // best effort: the palette listens in the main window
      }
      return;
    }
    if (id === 'open-link') {
      // RF-66: the page opens "Open link…" and `tabs.openLink` does the rest.
      showTab(MAIN_WINDOW, true);
      try {
        app.push('openLink', null);
      } catch {
        // best effort, like the palette
      }
      return;
    }
    if (id === 'tab-new') {
      const tab = hotkeyTab();
      // ⌘T acts on the tool of the tab the person is in; an ad-hoc tab has no tool to repeat.
      if (tab === null || tab.toolId === null) return;
      void addTab(tab.toolId)
        .then((created) => announce(created))
        .catch(() => undefined);
      return;
    }
    if (id === 'tab-close') {
      const tab = hotkeyTab();
      if (tab === null) return;
      const wasActive = active === tab.windowId;
      closeTab(tab.windowId);
      if (wasActive) announce(active); // the neighbour took the slot: the page shows it too
      return;
    }
    if (id === 'tab-detach') {
      const tab = hotkeyTab();
      if (tab === null) return;
      // The palette offers one toggle row for this (RF-51): a docked tab leaves the panel and a
      // detached one comes back to it, whichever the person is looking at.
      if (tab.docked) {
        const wasActive = active === tab.windowId;
        detach(tab.windowId);
        if (wasActive) announce(active); // the panel moved to the neighbour
      } else {
        dock(tab.windowId);
        announce(tab.windowId);
      }
      return;
    }
    if (id === 'tab-next' || id === 'tab-prev') {
      const target = stepTo(id === 'tab-next' ? 1 : -1);
      if (target === null) return;
      persist();
      publish();
      announce(target);
      return;
    }
    if (id === 'tab-save') {
      // RF-67: one step to the sidebar. The save itself is `backend/main.ts`'s (catalog, probe and
      // personal layer), and the page reads the outcome from the pushed state.
      showTab(MAIN_WINDOW, true);
      const tab = hotkeyTab();
      if (tab === null) return;
      void deps
        .saveTab(tab.windowId)
        .then(() => publish())
        .catch(() => undefined);
      return;
    }
    if (!id.startsWith('digit-')) return;
    const number = Number(id.slice('digit-'.length));
    if (!Number.isInteger(number) || number < 1 || number > 9) return;
    const target = digits(visible().map((entry) => entry.id)).get(number);
    if (target === undefined) return;
    // The id comes from `deps.entries()`: allowed by construction; a window failure becomes state.
    void open(target).catch(() => undefined);
  }

  // ------------------------------------------------------------ closing

  /** Closes and drops every tab of a tool; returns whether any was dropped. */
  function dropToolTabs(toolId: Id): boolean {
    let dropped = false;
    for (const [windowId, tab] of [...tabs]) {
      if (tab.toolId !== toolId) continue;
      dropTab(windowId);
      closeWindow(windowId);
      dropped = true;
    }
    return dropped;
  }

  function close(id: Id): ToolsState {
    dropToolTabs(id);
    if (active === null) active = firstDocked()?.windowId ?? null;
    failures.delete(id);
    updateHotkeys();
    syncDocked();
    updatePoll();
    persist();
    publish();
    return state();
  }

  /** E03 (⌘W, `tabs.close`): one tab goes away and its neighbour takes the slot (RF-49). */
  function closeTab(id: string): ToolsState {
    const tab = tabs.get(id);
    if (tab === undefined) throw new Error('unknown tab');
    const heir = successorTab(id)?.windowId ?? null;
    dropTab(id);
    closeWindow(id);
    if (active === null) active = heir;
    updateHotkeys();
    syncDocked();
    updatePoll();
    persist();
    publish();
    return state();
  }

  /**
   * E03 (⌃Tab, `tabs.next`): the tab `step` away, wrapping; answers its id. It steps from the tab
   * the person used last — `focusTab` on a detached tab does not change `active`, so stepping from
   * the slot alone would land on the same detached tab for ever.
   */
  function stepTo(step: 1 | -1): string | null {
    const current = recent[0] ?? active;
    const target = stepTab(order, current, step);
    if (target === null) return null;
    selectTab(target);
    return target;
  }

  function next(step: 1 | -1): ToolsState {
    stepTo(step);
    persist();
    publish();
    return state();
  }

  /** E03/RF-51: the tab leaves the panel as its own framed window — the same page, no reload. */
  function detach(id: string): ToolsState {
    const tab = tabs.get(id);
    if (tab === undefined) throw new Error('unknown tab');
    if (tab.docked) {
      const wasActive = active === id;
      detachTab(tab, true, 0);
      // The panel keeps showing a tab: the strip's next docked one takes the slot (RF-49).
      if (wasActive) active = successorTab(id)?.windowId ?? null;
    }
    syncDocked();
    updatePoll();
    persist();
    publish();
    return state();
  }

  /** E03/RF-51: `setChrome({ frame: true })` and a step off the panel, on the same window. */
  function detachTab(tab: TabWindow, focus: boolean, step: number): void {
    tab.docked = false;
    tab.placed = null;
    const window = handle(tab.windowId);
    if (window === null) return;
    try {
      window.setChrome({ frame: true });
    } catch {
      // the window was already gone
    }
    const rect = detachRect(step);
    if (rect !== null) {
      try {
        window.setPosition(rect.x, rect.y);
        window.setSize(rect.width, rect.height);
      } catch {
        // it keeps the rect it had
      }
    }
    try {
      if (focus) window.show();
      else window.show({ activate: false });
    } catch {
      // the window was already gone
    }
    tab.shown = true;
  }

  /** E03/RF-51: a detached tab snaps onto the slot and becomes the active one — same window. */
  function dock(id: string): ToolsState {
    const tab = tabs.get(id);
    if (tab === undefined) throw new Error('unknown tab');
    if (!tab.docked) {
      tab.docked = true;
      tab.placed = null;
      const window = handle(tab.windowId);
      if (window !== null) {
        place(tab); // onto the slot first, then the frame comes off (S1's recipe)
        try {
          window.setChrome({ frame: false });
        } catch {
          // the window was already gone
        }
      }
      active = tab.windowId;
      touch(tab.windowId);
    }
    syncDocked();
    updatePoll();
    persist();
    publish();
    return state();
  }

  /** E03 (RF-66): closes one tab — an ad-hoc one is forgotten here and nowhere else. */
  function closeAll(): void {
    stopPoll();
    for (const windowId of [...tabs.keys()]) {
      dropTab(windowId);
      closeWindow(windowId);
    }
    for (const popup of [...popups]) {
      popups.delete(popup);
      focused.delete(popup);
      closeWindow(popup);
    }
    adopting.clear();
    order = [];
    recent = [];
    active = null;
    // The slot goes with the tabs: the page's own `tabs.slot(null)` from `teardownShell` arrives
    // after the lock and is refused by the guard, so a stale rect would place the tabs of the next
    // unlock on a panel that Home — which reports no slot — is covering (RF-49).
    slotPage = null;
    slotScreen = null;
    logins.clear();
    failures.clear();
    updateHotkeys();
    publish();
    // The persisted list stays on purpose: `restore()` reopens it at the next unlock (RF-06).
  }

  function onWindowClosed(id: string): void {
    if (popups.delete(id)) return; // a tracked popup the person closed
    const tab = tabs.get(id);
    // Not a live tab of ours: the main window, or a window this module closed itself (close,
    // closeTab, reload, closeAll) — and in that case the persisted list was already handled.
    if (tab === undefined) return;
    const heir = successorTab(id)?.windowId ?? null;
    dropTab(id);
    if (active === null) active = heir;
    updateHotkeys();
    syncDocked();
    updatePoll();
    persist();
    publish();
  }

  // ------------------------------------------------------------ surface

  async function open(id: Id): Promise<ToolsState> {
    const entry = entryOf(id);
    if (entry === null) throw new Error('unknown tool');
    await loadCapabilities();
    if (effectiveMode() === 'docked') announce(await openToolDocked(entry));
    else await openTool(entry);
    persist();
    publish();
    return state();
  }

  async function openView(toolId: Id, index: number): Promise<ToolsState> {
    const entry = entryOf(toolId);
    if (entry === null) throw new Error('unknown tool');
    if (!Number.isInteger(index) || index < 0 || index >= entry.views.length) {
      throw new Error('view not found');
    }
    const view = entry.views[index];
    await loadCapabilities();
    const docked = effectiveMode() === 'docked';
    const acted =
      view.mode === 'window'
        ? // A view window is its own tab: `tool_<entry>_<index>`.
          await openViewTab(entry, index, view.url, viewTitle(entry, index), docked)
        : await openViewNavigate(entry, view, docked);
    announce(acted);
    persist();
    publish();
    return state();
  }

  /**
   * A `navigate` view: it navigates the tool's current tab, activating it; cold, a tab opens
   * straight at the view's address (A8). Docked, the "current tab" is the tool's most recent one.
   */
  async function openViewNavigate(
    entry: Entry,
    view: View,
    docked: boolean,
  ): Promise<string | null> {
    const current = docked ? mostRecent(tabsOf(entry.id)) : tabs.get(toolWindowId(entry.id)) ?? null;
    if (current === null) {
      const opened = await openColdTab(entry, view.url, docked);
      if (opened === null) return null;
      record(entry.id, 'tool_opened', auditUrl(entry.url), null, null);
      record(entry.id, 'view_opened', auditUrl(view.url), null, view.label);
      return opened;
    }
    selectTab(current.windowId);
    if (current.toolId !== null && !evaluate(current.windowId, `location.href = ${JSON.stringify(view.url)}`)) {
      current.error = EVAL_FAILED;
    }
    record(entry.id, 'view_opened', auditUrl(view.url), null, view.label);
    return current.windowId;
  }

  /** E03/RF-50: one more tab of the tool, without reloading the ones it already has. */
  async function newTab(toolId: Id): Promise<ToolsState> {
    await addTab(toolId);
    return state();
  }

  /** E03: a docked tab goes on the slot, a detached one comes forward with focus. */
  async function activate(id: string): Promise<ToolsState> {
    const tab = selectTab(id);
    if (tab === null) throw new Error('unknown tab');
    persist();
    publish();
    return state();
  }

  /** E03 (T6): reopens the tabs of `open_tools` in order, docked/detached and active as saved. */
  async function restore(): Promise<void> {
    await loadCapabilities();
    const persisted = await readPersisted();
    for (const item of persisted) {
      const entry = entryOf(item.toolId);
      if (entry === null) continue; // no longer visible for this person (RF-06)
      let view: number | null = null;
      let address = entry.url;
      let title = entry.title;
      if (item.view !== undefined) {
        const found = entry.views[item.view];
        if (found !== undefined && found.mode === 'window') {
          view = item.view;
          address = found.url;
          title = viewTitle(entry, item.view);
        }
        // A view that is gone, or one in `navigate` mode, reopens as the tool itself (A8).
      }
      if (item.url !== undefined) address = item.url; // where the tab was, when it is its own
      const windowId = freeTabId(entry.id, view);
      // A ⌘1 or a click can reach the same tool while the geometry of this one is still being
      // read: the id is claimed here, as every other open path claims it.
      if (opening.has(windowId)) continue;
      opening.add(windowId);
      try {
        const detached = item.detached === true || effectiveMode() !== 'docked';
        const created = await spawn({
          windowId,
          toolId: entry.id,
          view,
          address,
          title,
          entryUrl: entry.url,
          foreign: isForeign(entry, view),
          after: null,
          detached,
          activate: item.active === true && !detached,
        });
        if (!created) continue;
        record(
          entry.id,
          view === null ? 'tool_opened' : 'view_opened',
          auditUrl(address),
          null,
          view === null ? null : viewLabel(entry, view),
        );
      } finally {
        opening.delete(windowId);
      }
    }
    // A docked mode with tabs on the panel always has an active one; with nobody marked active the
    // first docked tab takes the slot.
    if (active === null) active = firstDocked()?.windowId ?? null;
    syncDocked();
    updatePoll();
    persist();
    publish();
  }

  function reconcile(): void {
    const visibleIds = new Set(visible().map((entry) => entry.id));
    let dropped = false;
    for (const [windowId, tab] of [...tabs]) {
      // An ad-hoc tab belongs to no catalog (RF-66): an entry going away does not take it.
      if (tab.toolId === null || visibleIds.has(tab.toolId)) continue;
      dropTab(windowId);
      closeWindow(windowId);
      dropped = true;
    }
    for (const id of [...failures.keys()]) if (!visibleIds.has(id)) failures.delete(id);
    for (const id of [...logins.keys()]) if (!visibleIds.has(id)) logins.delete(id);
    if (active === null) active = firstDocked()?.windowId ?? null;
    if (!dropped) return;
    updateHotkeys();
    syncDocked();
    updatePoll();
    persist();
    publish();
  }

  async function reload(id: Id): Promise<ToolsState> {
    const entry = entryOf(id);
    if (entry === null) throw new Error('unknown tool');
    // Cold again: closes every tab of the tool (its own and its `window`-mode views) and opens it
    // anew, in the mode in force (RF-52).
    dropToolTabs(id);
    if (active === null) active = firstDocked()?.windowId ?? null;
    failures.delete(id);
    updateHotkeys();
    await loadCapabilities();
    if (effectiveMode() === 'docked') announce(await openToolDocked(entry));
    else await openTool(entry);
    persist();
    publish();
    return state();
  }

  return {
    state,
    open,
    openView,
    close,
    reload,
    closeAll,
    restore,
    reconcile,
    onNavigate,
    onReport,
    onPopup,
    onWindowClosed,
    onWindowState,
    onHotkey,
    newTab,
    activate,
    closeTab,
    next,
    detach,
    dock,
    setSlot,
    openLink,
    tabForSave,
    adoptSavedTab,
  };
}
