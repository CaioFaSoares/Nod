// Tool windows, login cascade and global shortcuts (docs/arquitetura.md §4; canonico §7, §8, §11).
//
// One window per tool — `tool_<entry>` — and one per view in `window` mode — `tool_<entry>_<index>`
// (`toolWindowId` in shared/types.ts). Opening a tool that is already open only shows and focuses
// its window: nothing reloads (RF-19).
//
// Every runtime call goes through a guard: a window that vanished, a refused `eval` or an
// unsupported global shortcut may not take the backend down — the effect of the failure lands in
// the tool state the sidebar reads (docs/arquitetura.md §2, §4).

import { adapterScript } from './login-adapter';
import { auditUrl, originOf } from '../shared/catalog';
import { newCascade, stepCascade } from '../shared/login-cascade';
import { isIdentityPath } from '../shared/probe';
import { combo, digits } from '../shared/shortcuts';
import { MAIN_WINDOW, toolOfWindow, toolWindowId } from '../shared/types';
import type { CascadeAction, CascadeSignal, CascadeState } from '../shared/login-cascade';
import type {
  AuditEvent,
  Entry,
  EventType,
  Id,
  LoginResult,
  ReportState,
  ToolStatus,
  ToolsState,
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
/** Key of the persisted list of open windows in the store. */
const STORE_KEY = 'open_tools';

export interface ToolWindowsDeps {
  /** entries visible to the current person (empty when locked) */
  entries(): Entry[];
  /** icon of the entry as a data URI */
  icon(id: Id): string | null;
  credential(toolId: Id): Promise<{ username: string; secret: string } | null>;
  /**
   * The origin the person's credential for this tool was saved for (SP02 §8, RF-38); `null` when
   * the vault index holds no item — or one with no origin on record, which no fill may use either.
   * Synchronous on purpose: the cascade needs the answer before it decides to inject
   * (`shared/login-cascade.ts` rule 4), and the attempt it counts decides whether a `no-form` report
   * reads `filled` or `session` (rule 5).
   */
  vaultOrigin(toolId: Id): string | null;
  /** audit (canonico §13); the person goes in here, not in the window */
  record(e: Omit<AuditEvent, 'id' | 'at'>): void;
  store: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<boolean> };
  os: 'macos' | 'windows' | 'linux';
  hotkeys: boolean;
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
  onFocus(windowId: string, focused: boolean): void;
  onHotkey(id: string): void;
}

/**
 * A live tool window. `origin` is the only origin the adapter may run in inside this window
 * (docs/arquitetura.md §2); `loading` holds until the first `finish`.
 */
interface ToolWindow {
  windowId: string;
  toolId: Id;
  /** view index when this window carries a `window`-mode view; null for the tool's own window */
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
}

/** One window of the persisted list (`open_tools` in the store). */
interface OpenWindow {
  toolId: Id;
  view?: number;
}

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Narrowing guard for what the store hands back: the app writes it, but the store is data. */
function isOpenWindow(value: unknown): value is OpenWindow {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { toolId?: unknown; view?: unknown };
  if (typeof item.toolId !== 'string' || item.toolId === '') return false;
  return (
    item.view === undefined ||
    (typeof item.view === 'number' && Number.isInteger(item.view) && item.view >= 0)
  );
}

export function createToolWindows(app: TinyApp, deps: ToolWindowsDeps): ToolWindows {
  const windows = new Map<string, ToolWindow>();
  /** Last cascade result in this session, per tool (`ToolStatus.login`). */
  const logins = new Map<Id, LoginResult>();
  /** Failures with no live window behind them (the window never opened). */
  const failures = new Map<Id, string>();
  /** Nod windows focused right now: only with one focused do the shortcuts exist (canonico §7). */
  const focused = new Set<string>();
  /** Popup windows a tool window opened and that are still live: closed on lock (D1). */
  const popups = new Set<string>();
  /** Windows being opened: repeated calls for the same id may not open two windows. */
  const opening = new Set<string>();
  /** Shortcuts this module registered — the same id is never registered twice. */
  const registered = new Set<string>();

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

  function showWindow(id: string): void {
    const window = handle(id);
    if (window === null) return;
    try {
      window.show();
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
   * Audit (canonico §13). `personId` leaves as `null` on purpose: the session is who knows the
   * person (`backend/main.ts`), which overwrites that field in the `record` it passes down here.
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
   * Default geometry of a tool window: 1280×800 capped at 90% of the usable area of the screen
   * holding `main`, cascaded +28 px from the main window's top-left. `null` when the runtime cannot
   * tell the screens — then the launcher decides where the window lands.
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

  // ------------------------------------------------------------ opening and closing

  /**
   * Creates the window and registers the cascade that runs inside it. Returns true only when the
   * window was opened now (the launcher took the call).
   */
  async function createWindow(
    entry: Entry,
    windowId: string,
    address: string,
    title: string,
    view: number | null,
  ): Promise<boolean> {
    const rect = await geometry();
    const options: TinyOpenWindowOptions = { page: address, title };
    if (rect !== null) {
      options.x = rect.x;
      options.y = rect.y;
      options.size = `${rect.width}x${rect.height}`;
    }
    if (!openWindow(windowId, options)) {
      failures.set(entry.id, OPEN_FAILED);
      record(entry.id, 'load_failed', auditUrl(address), 'failed', OPEN_FAILED);
      publish();
      return false;
    }
    failures.delete(entry.id);
    const origin = entryOrigin(entry.url);
    windows.set(windowId, {
      windowId,
      toolId: entry.id,
      view,
      url: address,
      origin,
      cascade: newCascade(origin),
      loading: true,
      error: null,
      seenOrigins: new Set(),
      cancelFillCheck: null,
    });
    // The launcher ignored `x`/`size` of `win.open` in the v1 (observed by execution): the geometry
    // goes onto the handle right after the window exists.
    if (rect !== null) {
      const window = handle(windowId);
      if (window !== null) {
        try {
          window.setPosition(rect.x, rect.y);
          window.setSize(rect.width, rect.height);
        } catch {
          // the window may have closed before the geometry landed
        }
      }
    }
    publish();
    return true;
  }

  /** Opens the tool's own window (or shows it), auditing `tool_opened` when the window is born. */
  async function openTool(entry: Entry, address?: string): Promise<boolean> {
    const windowId = toolWindowId(entry.id);
    if (windows.has(windowId)) {
      showWindow(windowId); // focus, no reload (RF-19)
      return false;
    }
    if (opening.has(windowId)) return false; // another call is already opening this window
    opening.add(windowId);
    try {
      const created = await createWindow(
        entry,
        windowId,
        address ?? entry.url,
        entry.title,
        null,
      );
      if (created) record(entry.id, 'tool_opened', auditUrl(entry.url), null, null);
      return created;
    } finally {
      opening.delete(windowId);
    }
  }

  /** Opens a `window`-mode view window (or shows it), auditing `view_opened` when it is born. */
  async function openViewWindow(
    entry: Entry,
    index: number,
    address: string,
    title: string,
  ): Promise<boolean> {
    const windowId = toolWindowId(entry.id, index);
    if (windows.has(windowId)) {
      showWindow(windowId);
      return false;
    }
    if (opening.has(windowId)) return false;
    opening.add(windowId);
    try {
      const created = await createWindow(entry, windowId, address, title, index);
      if (created) record(entry.id, 'view_opened', auditUrl(address), null, viewLabel(entry, index));
      return created;
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

  // ------------------------------------------------------------ persistence

  /** Rewrites `open_tools` from the live windows: every open and every close lands here. */
  function persist(): void {
    const list: OpenWindow[] = [];
    for (const window of windows.values()) {
      list.push(
        window.view === null ? { toolId: window.toolId } : { toolId: window.toolId, view: window.view },
      );
    }
    try {
      void deps.store.set(STORE_KEY, list).catch(() => undefined);
    } catch {
      // a store failure may not take a window down
    }
  }

  async function readPersisted(): Promise<OpenWindow[]> {
    let raw: unknown = null;
    try {
      raw = await deps.store.get(STORE_KEY);
    } catch {
      raw = null; // an unreadable store restores nothing, and does not break the unlock
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter(isOpenWindow).map((item) =>
      item.view === undefined ? { toolId: item.toolId } : { toolId: item.toolId, view: item.view },
    );
  }

  // ------------------------------------------------------------ state

  function state(): ToolsState {
    const entries = visible();
    const digitOf = new Map<Id, number>();
    for (const [digit, id] of digits(entries.map((entry) => entry.id))) digitOf.set(id, digit);
    const tools: ToolStatus[] = entries.map((entry): ToolStatus => {
      const live = [...windows.values()].filter((window) => window.toolId === entry.id);
      const failing = live.find((window) => window.error !== null);
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
        loading: live.some((window) => window.loading),
        error: failing?.error ?? failures.get(entry.id) ?? null,
        login: logins.get(entry.id) ?? null,
      };
    });
    return { tools };
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
  function cascadeContext(window: ToolWindow): { hasCredential: boolean; noFill: boolean } {
    const entry = entryOf(window.toolId);
    const savedOrigin = deps.vaultOrigin(window.toolId);
    return {
      hasCredential: savedOrigin !== null && savedOrigin === window.origin,
      noFill: entry?.auth?.noFill === true,
    };
  }

  /** Feeds the cascade, synchronously, and fires the action it asks for. */
  function signal(window: ToolWindow, input: CascadeSignal): void {
    try {
      const step = stepCascade(window.cascade, input, cascadeContext(window));
      window.cascade = step.state;
      void apply(window, step.action, step.state);
    } catch {
      return; // a broken cascade never takes the window down
    }
  }

  /** The last URL seen still sits on the entry origin: the only place `eval` may run (D3). */
  function atEntryOrigin(window: ToolWindow): boolean {
    return window.origin !== '' && urlOrigin(window.url) === window.origin;
  }

  /** A7: a fill that the page never reported (an XHR login) gets a `finished` re-check later. */
  function armFillCheck(window: ToolWindow): void {
    clearFillCheck(window);
    const timer = setTimeout(() => {
      window.cancelFillCheck = null;
      if (windows.get(window.windowId) !== window) return;
      signal(window, { type: 'finished', url: window.url });
    }, FILL_CHECK_MS);
    window.cancelFillCheck = () => clearTimeout(timer);
  }

  function clearFillCheck(window: ToolWindow): void {
    if (window.cancelFillCheck === null) return;
    window.cancelFillCheck();
    window.cancelFillCheck = null;
  }

  /**
   * Applies the action the last step asked for. `stepped` is the cascade state that step produced:
   * it is what the give-back below reads while it is still the window's state.
   */
  async function apply(
    window: ToolWindow,
    action: CascadeAction,
    stepped: CascadeState,
  ): Promise<void> {
    if (action.type === 'none') return;
    if (action.type === 'result') {
      logins.set(window.toolId, action.result);
      record(window.toolId, 'login', auditUrl(window.url), action.result, null);
      publish();
      return;
    }
    // The adapter runs only in the entry origin (docs/arquitetura.md §2); the cascade already
    // guarantees it, but `eval` is too late to bet on.
    if (!atEntryOrigin(window)) return;
    let fill = action.fill;
    let username: string | undefined;
    let secret: string | undefined;
    if (fill) {
      let credential: { username: string; secret: string } | null = null;
      try {
        credential = await deps.credential(window.toolId);
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
        if (window.cascade === stepped) {
          window.cascade = { ...stepped, attempts: stepped.attempts - 1 };
        }
      } else {
        username = credential.username;
        secret = credential.secret;
      }
    }
    // D3: after the await, the window must still exist and the last URL seen must still carry the
    // entry origin before the eval.
    if (windows.get(window.windowId) !== window || !atEntryOrigin(window)) return;
    const script =
      fill && username !== undefined && secret !== undefined
        ? adapterScript({ fill: true, origin: window.origin, username, secret })
        : adapterScript({ fill: false, origin: window.origin });
    if (!evaluate(window.windowId, script)) {
      // A10: a refused eval is audited as a failed login.
      record(window.toolId, 'login', auditUrl(window.url), 'failed', EVAL_FAILED);
      return;
    }
    if (fill) armFillCheck(window);
  }

  // ------------------------------------------------------------ navigation and popups

  /** Records the origin of a main-frame navigation outside the entry origin (the provider). */
  function noteOrigin(window: ToolWindow, url: string): void {
    const origin = urlOrigin(url);
    if (origin === '' || origin === 'null' || origin === window.origin) return;
    if (schemeOf(url) !== 'https:' && schemeOf(url) !== 'http:') return;
    window.seenOrigins.add(origin);
  }

  /** A main-frame navigation: the cascade sees every redirect hop through it. */
  function navigated(window: ToolWindow, url: string): void {
    window.url = url;
    noteOrigin(window, url);
    signal(window, { type: 'navigated', url });
  }

  function finished(window: ToolWindow, url: string): void {
    clearFillCheck(window);
    window.url = url;
    noteOrigin(window, url);
    window.error = null;
    window.loading = false;
    signal(window, { type: 'finished', url });
    publish();
  }

  function loadFailed(window: ToolWindow, url: string, reason: string | undefined): void {
    clearFillCheck(window);
    window.loading = false;
    window.error = LOAD_FAILED;
    record(window.toolId, 'load_failed', auditUrl(url), 'failed', reason ?? null);
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
    // Only tool windows: the main window's own navigation is not this module's business.
    if (toolOfWindow(ev.window) === null) return undefined;
    const window = windows.get(ev.window);
    if (window === undefined) return undefined;
    const scheme = schemeOf(ev.url);
    if (ev.kind === 'policy') {
      if (scheme === 'http:' && !isLoopback(ev.url)) {
        // A20: plain http outside loopback never loads.
        record(window.toolId, 'navigation_blocked', auditUrl(ev.url), 'denied', scheme);
        return 'deny';
      }
      if (scheme === 'https:' || scheme === 'http:') {
        if (ev.isMainFrame !== false) navigated(window, ev.url);
        return undefined;
      }
      if ((scheme === 'mailto:' || scheme === 'tel:') && ev.isMainFrame !== false) {
        record(window.toolId, 'external_opened', auditUrl(ev.url), 'external', scheme);
        return 'external'; // it goes to the system browser, never into the webview
      }
      // D2: every other scheme is denied — and audited.
      record(window.toolId, 'navigation_blocked', auditUrl(ev.url), 'denied', scheme);
      return 'deny';
    }
    if (ev.kind === 'start') {
      // The same main-frame signal: the navigation that in fact started (the `policy` also asks
      // about other frames and about schemes the webview never loads).
      if (ev.isMainFrame !== false) navigated(window, ev.url);
      return undefined;
    }
    if (ev.kind === 'finish') {
      if (ev.isMainFrame === false) return undefined; // only the top frame drives the cascade
      finished(window, ev.url);
      return undefined;
    }
    if (ev.kind === 'fail' || ev.kind === 'crash') {
      loadFailed(window, ev.url, ev.error);
      return undefined;
    }
    return undefined;
  }

  function onReport(windowId: string, report: ReportState, origin: string | undefined): void {
    if (toolOfWindow(windowId) === null) return;
    const window = windows.get(windowId);
    if (window === undefined) return;
    // P9: a report that claims an origin other than the entry origin is ignored.
    if (origin !== undefined && origin !== window.origin) return;
    signal(window, { type: 'report', state: report });
  }

  function onPopup(info: TinyPopupEvent): 'window' | 'external' | 'deny' | undefined {
    if (info.kind === 'open') {
      // D1: a popup that became a window is tracked, so the lock closes it.
      if (info.action === 'window' && info.window !== null) popups.add(info.window);
      return undefined;
    }
    if (info.kind !== 'policy') return undefined;
    const opener = info.opener;
    if (opener === undefined || toolOfWindow(opener) === null) return undefined;
    const window = windows.get(opener);
    if (window === undefined) return undefined;
    const scheme = schemeOf(info.url);
    if (scheme !== 'https:' && scheme !== 'http:') {
      record(window.toolId, 'navigation_blocked', auditUrl(info.url), 'denied', scheme);
      return 'deny';
    }
    const target = urlOrigin(info.url);
    const known =
      target !== '' &&
      (target === window.origin || window.seenOrigins.has(target) || isIdentityPath(info.url));
    if (known) return 'window';
    record(window.toolId, 'external_opened', auditUrl(info.url), 'external', null);
    return 'external';
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

  /** Global shortcuts exist only while some Nod window is focused (canonico §7). */
  function updateHotkeys(): void {
    if (deps.hotkeys && focused.size > 0) {
      for (let n = 1; n <= 9; n += 1) registerHotkey(`digit-${n}`, combo(String(n), deps.os));
      registerHotkey('palette', combo('k', deps.os));
      return;
    }
    for (const id of [...registered]) {
      try {
        app.hotkey.unregister(id);
      } catch {
        // it was already gone
      }
      registered.delete(id);
    }
  }

  function onFocus(windowId: string, isFocused: boolean): void {
    const isNodWindow =
      windowId === MAIN_WINDOW || windows.has(windowId) || popups.has(windowId);
    if (!isNodWindow) return;
    if (isFocused) focused.add(windowId);
    else focused.delete(windowId);
    updateHotkeys();
  }

  function onHotkey(id: string): void {
    if (id === 'palette') {
      showWindow(MAIN_WINDOW);
      try {
        app.push('palette', null);
      } catch {
        // best effort: the palette listens in the main window
      }
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

  /** Drops every window of a tool from the maps and closes it; returns whether any was dropped. */
  function dropToolWindows(toolId: Id): boolean {
    let dropped = false;
    for (const [windowId, window] of [...windows]) {
      if (window.toolId !== toolId) continue;
      windows.delete(windowId);
      clearFillCheck(window);
      focused.delete(windowId);
      closeWindow(windowId);
      dropped = true;
    }
    return dropped;
  }

  function close(id: Id): ToolsState {
    dropToolWindows(id);
    failures.delete(id);
    updateHotkeys();
    persist();
    publish();
    return state();
  }

  function closeAll(): void {
    for (const [windowId, window] of [...windows]) {
      windows.delete(windowId);
      clearFillCheck(window);
      focused.delete(windowId);
      closeWindow(windowId);
    }
    for (const popup of [...popups]) {
      popups.delete(popup);
      focused.delete(popup);
      closeWindow(popup);
    }
    logins.clear();
    failures.clear();
    updateHotkeys();
    publish();
    // The persisted list stays on purpose: `restore()` reopens it at the next unlock (RF-06).
  }

  function onWindowClosed(id: string): void {
    if (popups.delete(id)) return; // a tracked popup the person closed
    const window = windows.get(id);
    // Not a live window of ours: the main window, or a window this module closed itself (close,
    // reload, closeAll) — and in that case the persisted list was already handled.
    if (window === undefined) return;
    windows.delete(id);
    clearFillCheck(window);
    focused.delete(id);
    updateHotkeys();
    persist();
    publish();
  }

  // ------------------------------------------------------------ surface

  async function open(id: Id): Promise<ToolsState> {
    const entry = entryOf(id);
    if (entry === null) throw new Error('unknown tool');
    await openTool(entry);
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
    if (view.mode === 'window') {
      // A view window is its own window: `tool_<entry>_<index>`.
      await openViewWindow(entry, index, view.url, viewTitle(entry, index));
    } else {
      const windowId = toolWindowId(toolId);
      const live = windows.get(windowId);
      if (live === undefined) {
        // A8: cold, the tool window opens straight at the view's address.
        await openTool(entry, view.url);
      } else {
        showWindow(windowId);
        if (!evaluate(windowId, `location.href = ${JSON.stringify(view.url)}`)) {
          live.error = EVAL_FAILED;
        }
      }
      record(toolId, 'view_opened', auditUrl(view.url), null, view.label);
    }
    persist();
    publish();
    return state();
  }

  async function reload(id: Id): Promise<ToolsState> {
    const entry = entryOf(id);
    if (entry === null) throw new Error('unknown tool');
    // Cold again: closes what is left of the tool (its window and its `window`-mode views) and
    // opens it anew.
    dropToolWindows(id);
    failures.delete(id);
    updateHotkeys();
    await openTool(entry);
    persist();
    publish();
    return state();
  }

  async function restore(): Promise<void> {
    const persisted = await readPersisted();
    for (const item of persisted) {
      const entry = entryOf(item.toolId);
      if (entry === null) continue; // no longer visible for this person (RF-06)
      if (item.view === undefined) {
        await openTool(entry);
        continue;
      }
      const view = entry.views[item.view];
      if (view === undefined) {
        // The view is gone (or its index moved): the tool itself still reopens.
        await openTool(entry);
        continue;
      }
      if (view.mode === 'window') {
        await openViewWindow(entry, item.view, view.url, viewTitle(entry, item.view));
      } else {
        await openTool(entry);
      }
    }
    persist();
    publish();
  }

  function reconcile(): void {
    const visibleIds = new Set(visible().map((entry) => entry.id));
    let dropped = false;
    for (const [windowId, window] of [...windows]) {
      if (visibleIds.has(window.toolId)) continue;
      windows.delete(windowId);
      clearFillCheck(window);
      focused.delete(windowId);
      closeWindow(windowId);
      dropped = true;
    }
    for (const id of [...failures.keys()]) if (!visibleIds.has(id)) failures.delete(id);
    for (const id of [...logins.keys()]) if (!visibleIds.has(id)) logins.delete(id);
    if (!dropped) return;
    updateHotkeys();
    persist();
    publish();
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
    onFocus,
    onHotkey,
  };
}
