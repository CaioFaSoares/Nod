// Electrobun implementation of the window half of the `TinyApp` surface (contract
// `_proposto/e06-parity.md`, owner "Windows"; parity rows A12–A17, A26, all of B, hooks E4–E8 of
// `docs/handovers/e06-tinyjs-surface.md`).
//
// The Nod's backend (`backend/main.ts`, `backend/tool-windows.ts`) owns the window policy; this file
// only makes Electrobun behave like tinyjs:
//   - `win.open(id, { page, title, x, y, size, chrome })` where `size` is the PAGE box (the titlebar
//     is compensated), tool and popup views created `sandbox: true` (contract invariant);
//   - handles with `eval/close/show({activate})/hide({app})/setPosition/setSize/setChrome/
//     setMinSize`; on `main` a bare `hide()` is `NSApp.hide` (focus returns to the previous app),
//     `{ app: false }` hides the window alone; `setSize` always takes page-box units so
//     `set → getState` round-trips;
//   - `getState()` = `TinyWinState` for main and for every handle;
//   - runtime chrome toggle without a reload (Electrobun 2.0.4 has no API for it: the native helper
//     flips `styleMask` on the main queue after the FFI call returns — a synchronous `objc_msgSend`
//     kills the Bun process, which is not the thread running AppKit);
//   - window events → `onWindowState`/`onWindowClosed`, navigation → `onNavigate`
//     (policy/start/commit/finish), popups → `onWindowOpen` (policy + open), downloads →
//     `onDownload`.
//
// Measured on 2026-10-22 (throwaway app, macOS 27, Electrobun 2.0.4, Bun 1.4.0 core):
//   - a window created with 700×500 reads back 700×532 (creation takes the CONTENT rect);
//     `setSize`/`setFrame` take the FRAME rect (600×400 → page 600×368);
//   - `navigationRules` given to `createWebview` are dropped by the devkit
//     (`proc/native.ts` does not forward them); `BrowserView.setNavigationRules()` after creation is
//     the only deny path, and a denied URL never commits. `window.stop()` during `will-navigate`
//     does NOT cancel;
//   - `will-navigate` detail is `{url, allowed}` (allowed precomputed from the native rules);
//     `did-commit-navigation`/`did-navigate`/`dom-ready` carry a bare URL and are main-frame only;
//   - `new-window-open` detail is `{url, isCmdClick, modifierFlags}`, with no opener and no window;
//     `window.open()` returns null in the page, so the facade creates the popup itself;
//   - download details: started/completed `{filename, path}`, progress `{progress}`, failed
//     `{filename, path, error}` — no URL, no id, no byte counters;
//   - there is no did-fail-navigation/crash event: `kind:'fail'`/`'crash'` cannot be reported;
//   - `sandbox: true` keeps `__electrobunSendToHost` and still injects the custom preload, so the
//     tool bridge (`electrobun/view/tool-bridge.ts`) gives a sandboxed page `window.tiny` with its
//     own `tiny.win.id`; each `api.call` carries a page-local id and is settled by
//     `executeJavascript(window.__nodToolReply(...))`. A reply is dropped when the view committed a
//     navigation since the call: the new document's ids start over, so the answer could land on a
//     promise that document made;
//   - `hide()`/`showInactive()` keep the page alive (`performance.timeOrigin` unchanged).

import {
  BrowserView,
  BrowserWindow,
  Screen,
  Utils,
  type Display,
  type WindowOptionsType,
} from 'electrobun/main';
import { replySource, toolBridgeSource } from '../../view/tool-bridge';
import { createNative } from './native';
import { originOfUrl, type ViewKind } from './gate-core';
import {
  NAVIGATION_ALLOW_RULES,
  NO_DECORATION,
  cascadeRect,
  clampToMinSize,
  decorationAtCreation,
  decorationFor,
  decorationFrom,
  denyRuleFor,
  outerBoxForPage,
  pageBoxFromOuter,
  parseSize,
  sameFrameUrl,
  screenForRect,
  screenRectForView,
  viewRectForContent,
  viewRectForScreen,
  type Decoration,
  type Rect,
  type Size,
} from './geometry';

/** `BrowserWindow.new`'s RPC parameter is generic; the facade never reads it. */
type AnyWindow = BrowserWindow<any>;
type AnyView = BrowserView<any>;

const MAIN = 'main';
const DEFAULT_PAGE: Size = { width: 900, height: 700 };
const POPUP_PAGE: Size = { width: 900, height: 700 };
const POLL_MS = 300;
const CHROME_SETTLE_MS = [0, 16, 48, 120, 260];
const DOWNLOAD_PROGRESS_MS = 250;
/** How long a commit gets to become the view's top URL before it is treated as a subframe. */
const COMMIT_SETTLE_MS = 80;

/** The five runtime hooks plus the main view's committed origin. */
export interface WindowHooks {
  onNavigate?(info: TinyNavEvent): 'deny' | 'external' | undefined;
  onWindowOpen?(info: TinyPopupEvent): 'window' | 'external' | 'deny' | undefined;
  onDownload?(info: TinyDownloadEvent): void;
  onWindowClosed?(id: string): void;
  onWindowState?(info: TinyWindowStateEvent): void;
  onMainOrigin?(origin: string | null, href: string): void;
}

/** One tool-bridge answer as the facade reads it (`gate.ts` `HostReply`). */
export interface WindowsHostReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The call id and answer the gate hands back (`gate.ts` `HostRequest`). */
export interface WindowsHostRequest {
  id: number | null;
  reply: Promise<WindowsHostReply> | null;
}

/**
 * The origin gate's registry (`facade/gate.ts`). Every member is optional so a launch without a
 * gate (a probe, a test) still works: the facade creates the same sandboxed views either way.
 */
export interface WindowsGate {
  register(viewId: number, windowId: string, kind: ViewKind): void;
  forget?(viewId: number): void;
  beginNavigation?(viewId: number): void;
  commit?(viewId: number, url: string): void;
  hostMessage?(
    viewId: number,
    windowId: string,
    payload: unknown,
    observedOrigin: string | null,
  ): unknown;
  /**
   * `hostMessage` with an answer for the page: the id the tool bridge sent and the promise that
   * settles it. `null` when the gate does not implement it.
   */
  hostRequest?(
    viewId: number,
    windowId: string,
    payload: unknown,
    observedOrigin: string | null,
  ): WindowsHostRequest | null;
}

/**
 * The two native primitives the devkit lacks (`facade/native.ts`, `electrobun/native/NodNative.swift`)
 * plus the view primitives a docked tab needs: the AppKit re-parent, and the core's own
 * `resizeWebview`/`webviewSetHidden` symbols the SDK does not re-export.
 */
export interface WindowsNative {
  setWindowFrame?(target: number | bigint, frame: boolean): boolean;
  setContentMinSize?(target: number | bigint, width: number, height: number): boolean;
  /** A window's content-view children (its webviews), from the live AppKit tree. */
  listViews?(
    target: number | bigint | string,
  ): Array<{ ptr: string; url: string | null; className: string; hidden: boolean }> | null;
  /** Moves a live view into a window's content view at a top-left rect. */
  attachView?(
    view: string,
    target: number | bigint | string,
    rect: Rect,
    autoresize?: boolean,
  ): boolean;
  /** The core's `resizeWebview`: places a view inside its current content view. */
  resizeView?(viewId: number, rect: Rect): boolean;
  /** The core's `webviewSetHidden`: hides/shows a view without a reload. */
  setViewHidden?(viewId: number, hidden: boolean): boolean;
  /** The URL of a view's top document (the navigation events do not say which frame they are). */
  viewUrl?(view: string): string | null;
  /** `NSApp.hide`: the whole app goes away and focus returns to the previous app. */
  hideApp?(): boolean;
  /**
   * Opts the process out of macOS automatic termination. Armed while `setHideOnClose(true)` is in
   * effect (with a tray, a hidden `main` is the normal state), released when the hold is lifted or
   * the app quits for real; without it macOS ends an app with no visible window (RF-15).
   */
  setTerminationHold?(enabled: boolean): boolean;
}

export interface WindowsDeps {
  /** Packaged `views://…` URL or the dev server URL of the main window. */
  mainUrl?: string;
  /** `BrowserView.defineRPC(...)` owned by the entry point; attached to main only. */
  mainRpc?: unknown;
  /** Preload source for the main window (the page bridge). */
  mainPreload?: string | null;
  /** Main window page box: `'WxH'` or `{width,height}`. */
  mainSize?: string | { width: number; height: number };
  /** Already-constructed main window (alternative to `mainUrl`). */
  mainWindow?: AnyWindow;
  gate?: WindowsGate;
  hooks?: WindowHooks;
  native?: WindowsNative;
  /** `win.open`'s `page` → URL. Default: with a scheme as is, otherwise `views://<page>`. */
  resolvePage?(page: string): string;
  /** `tinyjs.json` "popups": 'external' | 'window' | 'deny' (default 'window'). */
  popupMode?(): 'window' | 'external' | 'deny';
  /** Extra chrome primitives, overriding the native helper (a test or another host). */
  chrome?: {
    setFrame?(win: AnyWindow, frame: boolean): boolean;
    setMinSize?(win: AnyWindow, width: number, height: number): boolean;
  };
  /** Start with `setHideOnClose(true)`; `win.setHideOnClose` changes it at runtime. */
  hideOnClose?: boolean;
}

/** What `facade/app.ts` composes into `TinyApp`. */
export interface WindowFacade {
  win: TinyApp['win'];
  window(id: string): TinyWindowHandle;
  screens(): Promise<TinyScreen[]>;
  mainWindow(): AnyWindow | null;
  mainView(): AnyView | null;
  ids(): string[];
  /** Quit for real: closes every window even with `setHideOnClose(true)` and terminates. */
  quit(): void;
}

/** A screen as the facade sees it: the devkit `Display` plus its usable area. */
interface DisplayRect extends Rect {
  primary: boolean;
  scale: number;
  visible: Rect;
}

/** The fields of a devkit download payload (measured shapes; every field optional there). */
interface DownloadDetail {
  filename: string;
  path: string | null;
  error: string | null;
}

/** The devkit's window/view objects expose `on` through a string-keyed emitter. */
interface EventEmitter {
  on(name: string, handler: (event: unknown) => void): void;
}

/** `will-close` carries a mutable response; `allow:false` cancels the close. */
interface CloseEvent {
  response?: unknown;
}

interface Download {
  id: number;
  filename: string;
  path: string | null;
  lastProgressAt: number;
}

interface Managed {
  id: string;
  kind: ViewKind;
  /**
   * The window that hosts `view`: the main window while the tab is docked, the carrier window
   * once it is detached. Never null — a docked tab answers with the main window.
   */
  win: AnyWindow;
  view: AnyView;
  handle: TinyWindowHandle;
  /**
   * A docked tab: `view` is a `BrowserView` laid over the main window's content view, with no
   * window of its own. Every geometry call the backend makes is in screen coordinates and is
   * translated to the main window's content view here (`viewRectForScreen`).
   */
  embedded: boolean;
  /**
   * The AppKit pointer of `view`'s NSView, resolved from the window's live content tree. The core's
   * `getWebviewPointer` is NOT that pointer (measured), so it is never used for a re-parent.
   */
  viewRef: string | null;
  /** The screen rect the backend last asked for (docked) or the window rect (detached). */
  screen: Rect | null;
  /** The rect applied inside the embedded content view (docked tabs only). */
  local: Rect | null;
  /** The carrier window of a detached tab; null for main and while docked. */
  shell: AnyWindow | null;
  /** Last title the backend set; a carrier window is created with it on detach. */
  title: string;
  /** Chrome state we applied (`chrome.frame`). */
  framed: boolean;
  /** outer - page for the current chrome state. */
  decoration: Decoration;
  /** Last framed reading; restored when the titlebar comes back. */
  framedDecoration: Decoration | null;
  /** Page box the Nod asked for (and the last one the page reported). */
  page: Size;
  minPage: Size | null;
  focused: boolean;
  minimized: boolean;
  fullscreen: boolean;
  maximized: boolean;
  visible: boolean;
  closed: boolean;
  /** Chrome change enqueued on the main queue: resize payloads are the runtime's, not the person's. */
  settling: boolean;
  committedUrl: string | null;
  committedOrigin: string | null;
  /**
   * How many main-frame navigations this view has committed. A tool-bridge reply belongs to the
   * document that made the call; the page's call ids restart at 1 on every document, so a reply
   * whose generation moved on is dropped (`facade/gate.ts` request/reply note).
   */
  generation: number;
  /** Last page that finished loading — where a denied-but-committed navigation returns to. */
  pageUrl: string | null;
  rules: string[];
  /** URLs the policy denied after the native decision had allowed them (revert once). */
  denied: Set<string>;
  popupOf: string | null;
  downloads: Download[];
  stopPoll: (() => void) | null;
  /** Cancels the pending chrome-settle ticks (a second toggle before they finish). */
  cancelSettle: (() => void) | null;
}

/**
 * `{url, allowed}` (will-navigate, JSON text) or a bare URL (the other navigation events), or null.
 * The devkit does not pre-parse `will-navigate`, and the URL of the other events is not JSON, so
 * both arrive as strings and have to be told apart here.
 */
function readNavigation(detail: unknown): { url: string; allowed: boolean } | null {
  if (typeof detail === 'string') {
    const trimmed = detail.trim();
    if (trimmed === '') return null;
    if (!trimmed.startsWith('{')) return { url: detail, allowed: true };
    try {
      return readNavigation(JSON.parse(trimmed));
    } catch {
      return { url: detail, allowed: true };
    }
  }
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  if (!('url' in detail)) return null;
  const url = detail.url;
  if (typeof url !== 'string' || url === '') return null;
  const allowed = 'allowed' in detail ? detail.allowed !== false : true;
  return { url, allowed };
}

/** `new-window-open` detail → URL (the devkit never says which view opened it, or the window). */
function readPopupUrl(detail: unknown): string | null {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  if (!('url' in detail)) return null;
  const url = detail.url;
  return typeof url === 'string' && url !== '' ? url : null;
}

/** Download payload → the fields this facade uses; `null` for anything that is not an object. */
function readDownloadDetail(value: unknown): DownloadDetail | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const filename = 'filename' in value && typeof value.filename === 'string' ? value.filename : '';
  const path =
    'path' in value && typeof value.path === 'string' && value.path !== '' ? value.path : null;
  const error = 'error' in value && typeof value.error === 'string' ? value.error : null;
  return { filename, path, error };
}

/** Every devkit event hands the payload at `data.detail`, usually as JSON text. */
function eventDetail(event: unknown): unknown {
  if (event === null || typeof event !== 'object' || !('data' in event)) return undefined;
  const data = event.data;
  if (data === null || typeof data !== 'object' || !('detail' in data)) return undefined;
  return data.detail;
}

function readJson(detail: unknown): unknown {
  if (typeof detail !== 'string') return detail;
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

function pageSize(value: string | { width: number; height: number } | undefined): Size {
  if (typeof value === 'string') {
    const parsed = parseSize(value);
    if (parsed !== null) return parsed;
  }
  if (value !== undefined && typeof value === 'object') {
    if (
      Number.isFinite(value.width) &&
      Number.isFinite(value.height) &&
      value.width > 0 &&
      value.height > 0
    ) {
      return { width: Math.round(value.width), height: Math.round(value.height) };
    }
  }
  return DEFAULT_PAGE;
}

/**
 * Builds the window facade. Shell (`electrobun/bun/index.ts`) calls it once, before the backend's
 * `init(app)`; nothing here starts the main window before that call either.
 */
export function createWindows(deps: WindowsDeps = {}): WindowFacade {
  const windows = new Map<string, Managed>();
  const hooks = deps.hooks ?? {};
  const gate = deps.gate;
  const chrome = deps.chrome ?? {};
  let nativeClient: WindowsNative | null = null;
  let hideOnClose = deps.hideOnClose === true;
  let quitting = false;
  let popupSeq = 0;
  let downloadSeq = 0;

  // A host that starts with hide-on-close (a tray-only shell) gets the hold before any window opens.
  if (hideOnClose) holdTermination();

  /**
   * Arms/releases macOS's termination hold. Only while a tray makes "main hidden" the normal state:
   * `hideOnClose` is the flag the close veto reads, so the hold cannot outlive the behavior it
   * protects; a real quit releases it first and still ends through `Utils.quit`.
   */
  function holdTermination(): void {
    const ops = nativeOps();
    ops.setTerminationHold?.(hideOnClose && !quitting);
  }

  /**
   * Another managed OS window still on screen: a tool window, a popup, a detached tab's carrier. A
   * docked tab is a view inside main and never counts (it has no window of its own).
   */
  function hasOtherWindow(except: Managed): boolean {
    for (const other of windows.values()) {
      if (other === except || other.closed || other.embedded) continue;
      if (other.visible || other.minimized) return true;
    }
    return false;
  }

  function nativeOps(): WindowsNative {
    if (deps.native !== undefined) return deps.native;
    if (nativeClient === null) nativeClient = createNative();
    return nativeClient;
  }

  function resolvePage(page: string): string {
    if (deps.resolvePage !== undefined) return deps.resolvePage(page);
    if (/^[a-z][a-z0-9+.-]*:/i.test(page)) return page;
    return `views://${page.replace(/^\/+/, '')}`;
  }

  // ------------------------------------------------------------------ docked tab views

  /**
   * The AppKit pointer of a window's content children, keyed by pointer. `null` when the native
   * side (or the platform) cannot answer — a launch without the helper then keeps today's windows.
   */
  function viewRefs(win: AnyWindow): Map<string, string | null> | null {
    const ops = nativeOps();
    if (ops.listViews === undefined) return null;
    const pointer = win.ptr;
    if (pointer === null || pointer === undefined) return null;
    try {
      const list = ops.listViews(pointer);
      if (list === null) return null;
      return new Map(list.map((entry) => [entry.ptr, entry.url]));
    } catch {
      return null;
    }
  }

  /**
   * The URL of `managed.view`'s top document, read from the live WKWebView. Electrobun's navigation
   * events also fire for subframes and none of them says which frame it was (measured: claude.ai's
   * hCaptcha iframe was reported as a commit), so this is what tells a real page change apart.
   */
  function topFrameUrl(managed: Managed): string | null {
    const ops = nativeOps();
    if (ops.viewUrl === undefined || managed.viewRef === null) return null;
    try {
      return ops.viewUrl(managed.viewRef);
    } catch {
      return null;
    }
  }

  /**
   * A `will-navigate` fires for subframes too, before the top URL can tell them apart. The backend
   * takes an `https`/`http` policy event as the URL the tab is now on, so after the event has been
   * answered the facade re-reports the view's real top URL when the two differ — a subframe leaves
   * the tab on its own address, a main-frame navigation commits and reports itself right after.
   */
  function notePolicyCorrection(managed: Managed, url: string): void {
    if (managed.viewRef === null || nativeOps().viewUrl === undefined) return;
    if (!/^https?:/i.test(url)) return;
    setTimeout(() => {
      if (managed.closed) return;
      const top = topFrameUrl(managed);
      if (top === null || sameFrameUrl(top, url)) return;
      reportNavigation(managed, 'start', top, true);
    }, COMMIT_SETTLE_MS * 2);
  }

  /**
   * Runs a navigation reading only when it belongs to the view's top document. A mismatch is
   * re-checked once after `COMMIT_SETTLE_MS` (the top URL can land a moment after the delegate
   * callback for a genuine main-frame commit) and dropped when it still does not match. Without the
   * probe (a launch on another platform, a test) the reading is taken as before.
   */
  function acceptTopFrame(managed: Managed, url: string, run: () => void): void {
    const ops = nativeOps();
    if (ops.viewUrl === undefined || managed.viewRef === null) {
      run();
      return;
    }
    const top = topFrameUrl(managed);
    if (top === null || sameFrameUrl(top, url)) {
      run();
      return;
    }
    setTimeout(() => {
      if (managed.closed) return;
      const again = topFrameUrl(managed);
      if (again === null || sameFrameUrl(again, url)) run();
    }, COMMIT_SETTLE_MS);
  }

  /**
   * The NSView a `new BrowserView` just added to `win`: the entry that was not in `before`, preferring
   * the one whose WKWebView already reports `url` (a view loads its URL as it is created).
   */
  function addedViewRef(
    before: Map<string, string | null> | null,
    after: Map<string, string | null> | null,
    url: string,
  ): string | null {
    if (before === null || after === null) return null;
    let fallback: string | null = null;
    for (const [ptr, reported] of after) {
      if (before.has(ptr)) continue;
      fallback = ptr;
      if (reported !== null && (reported === url || reported.startsWith(url))) return ptr;
    }
    return fallback;
  }

  /** Re-parents `managed.view` into `target`'s content view; false when the native side cannot. */
  function reparent(managed: Managed, target: AnyWindow, rect: Rect, autoresize: boolean): boolean {
    const ops = nativeOps();
    if (ops.attachView === undefined || managed.viewRef === null) return false;
    const pointer = target.ptr;
    if (pointer === null || pointer === undefined) return false;
    try {
      return ops.attachView(managed.viewRef, pointer, rect, autoresize) === true;
    } catch {
      return false;
    }
  }

  /** The core's own frame setter for a view — the only placement path the SDK does not re-export. */
  function placeView(managed: Managed, rect: Rect): boolean {
    const ops = nativeOps();
    if (ops.resizeView === undefined) return false;
    try {
      return ops.resizeView(managed.view.id, rect) === true;
    } catch {
      return false;
    }
  }

  /** Hides/shows a view without unloading it (`webviewSetHidden`; measured: no reload). */
  function setViewHidden(managed: Managed, hidden: boolean): boolean {
    const ops = nativeOps();
    if (ops.setViewHidden === undefined) return false;
    try {
      return ops.setViewHidden(managed.view.id, hidden) === true;
    } catch {
      return false;
    }
  }

  /** The host window's page origin on screen: what a docked tab's screen rect is relative to. */
  function hostGeometry(): { frame: Rect; page: Size } | null {
    const host = windows.get(MAIN);
    if (host === undefined) return null;
    try {
      const frame = host.win.getFrame();
      return { frame, page: host.page };
    } catch {
      return null;
    }
  }

  /**
   * Puts a docked tab on the rect the backend asked for. Re-applied after every layout pass of the
   * main window: measured, the core rewrites a window's views to fill its content view on resize.
   */
  function placeEmbedded(managed: Managed): void {
    if (managed.closed || !managed.embedded) return;
    const host = hostGeometry();
    if (host === null) return;
    const wanted = managed.screen ?? {
      x: host.frame.x,
      y: host.frame.y,
      width: managed.page.width,
      height: managed.page.height,
    };
    const local = viewRectForScreen(host.frame, host.page, wanted);
    managed.local = local;
    placeView(managed, local);
  }

  /** Re-places every docked tab (main moved or resized — the poll does the same every 50 ms). */
  function placeEmbeddedAll(): void {
    for (const managed of windows.values()) {
      if (managed.embedded) placeEmbedded(managed);
    }
    // The core lays a window's views out on its own pass; one tick later is after that pass.
    setTimeout(() => {
      for (const managed of windows.values()) {
        if (managed.embedded) placeEmbedded(managed);
      }
    }, 0);
  }

  /** A detached tab's view fills its window's content view. */
  function placeDetached(managed: Managed): void {
    if (managed.closed || managed.embedded) return;
    placeView(managed, viewRectForContent(managed.page));
  }

  /** The screen rect a tab was last laid on, with the host window as the fallback. */
  function tabScreen(managed: Managed): Rect {
    if (managed.screen !== null) return managed.screen;
    const host = hostGeometry();
    return {
      x: host?.frame.x ?? 0,
      y: host?.frame.y ?? 0,
      width: managed.page.width,
      height: managed.page.height,
    };
  }

  /** Whether this launch can host a docked tab: the re-parent plus the core's frame/hide symbols. */
  function canEmbed(): boolean {
    const ops = nativeOps();
    return (
      ops.attachView !== undefined &&
      ops.resizeView !== undefined &&
      ops.setViewHidden !== undefined
    );
  }

  /**
   * `setChrome({frame:true})` on a docked tab: a framed carrier window becomes the tab's home and the
   * live view is moved into it (measured 0.5–1.8 ms, `performance.timeOrigin` unchanged). The
   * backend positions and shows it right after — it is created hidden so `show({activate:false})`
   * can put it above main without stealing the focus.
   */
  function detachTab(managed: Managed): void {
    if (!canEmbed() || managed.viewRef === null) {
      throw new Error('runtime window chrome is unavailable');
    }
    const host = hostGeometry();
    const page = managed.page;
    const screen = tabScreen(managed);
    const display = screenForRect(displayRects(), screen);
    const rect = cascadeRect(host?.frame ?? null, display, page);
    const previous = {
      embedded: managed.embedded,
      shell: managed.shell,
      win: managed.win,
      framed: managed.framed,
      decoration: managed.decoration,
      framedDecoration: managed.framedDecoration,
      screen: managed.screen,
    };
    let shell: { win: AnyWindow; outer: Size | null; decoration: Decoration };
    try {
      shell = newShellWindow(
        { title: managed.title, left: rect.x, top: rect.y, activate: false, hidden: true },
        page,
        null,
      );
    } catch {
      throw new Error('runtime window chrome is unavailable');
    }
    try {
      shell.win.webview?.remove();
    } catch {
      // the constructor's view is already gone
    }
    managed.embedded = false;
    managed.shell = shell.win;
    managed.win = shell.win;
    managed.framed = true;
    managed.decoration = shell.decoration;
    managed.framedDecoration = shell.decoration.height > 0 ? shell.decoration : null;
    managed.screen = { x: rect.x, y: rect.y, width: page.width, height: page.height };
    if (!reparent(managed, shell.win, viewRectForContent(page), true)) {
      Object.assign(managed, previous);
      try {
        shell.win.close();
      } catch {
        // already gone
      }
      throw new Error('runtime window chrome is unavailable');
    }
    attachWindow(managed);
    startPolling(managed);
    placeDetached(managed);
    try {
      shell.win.showInactive();
    } catch {
      // the backend's show() is right behind this call
    }
    managed.visible = true;
  }

  /**
   * `setChrome({frame:false})`: the same live view docks back onto the main window at the rect the
   * backend asked for (the slot; `dock()` places before re-chroming, adoption re-places after). The
   * empty carrier window is closed on the next tick — the adoption path runs inside a native popup
   * callback, and closing a window from that stack re-enters the core.
   */
  function dockTab(managed: Managed): void {
    const host = windows.get(MAIN);
    if (host === undefined || !canEmbed() || managed.viewRef === null) {
      throw new Error('runtime window chrome is unavailable');
    }
    const shell = managed.shell;
    let shellFrame: Rect | null = null;
    try {
      shellFrame = managed.win.getFrame();
    } catch {
      shellFrame = null;
    }
    let hostFrame: Rect;
    try {
      hostFrame = host.win.getFrame();
    } catch {
      throw new Error('runtime window chrome is unavailable');
    }
    const page = currentPage(managed);
    const screen =
      managed.screen ??
      (shellFrame === null
        ? { x: hostFrame.x, y: hostFrame.y, width: page.width, height: page.height }
        : { x: shellFrame.x, y: shellFrame.y, width: page.width, height: page.height });
    const previous = {
      embedded: managed.embedded,
      shell: managed.shell,
      win: managed.win,
      framed: managed.framed,
      decoration: managed.decoration,
      framedDecoration: managed.framedDecoration,
      screen: managed.screen,
    };
    const local = viewRectForScreen(hostFrame, host.page, screen);
    managed.embedded = true;
    managed.shell = null;
    managed.win = host.win;
    managed.framed = false;
    managed.decoration = NO_DECORATION;
    managed.framedDecoration = null;
    managed.page = page;
    managed.screen = { ...screen, width: page.width, height: page.height };
    if (!reparent(managed, host.win, local, false)) {
      Object.assign(managed, previous);
      throw new Error('runtime window chrome is unavailable');
    }
    stopPolling(managed);
    // The view was visible in its window; the move may have left it hidden or laid out for the old
    // content view (measured: an https page came back to the slot without painting), so it is shown
    // again and the slot rect is applied once more after the core's own layout pass.
    setViewHidden(managed, false);
    managed.visible = true;
    placeEmbedded(managed);
    setTimeout(() => {
      if (!managed.closed && managed.embedded) placeEmbedded(managed);
    }, 0);
    if (shell !== null) {
      // The view is already back inside main; the carrier holds nothing and is closed on the next
      // tick (a native popup callback must not re-enter the core by closing a window).
      setTimeout(() => {
        try {
          shell.close();
        } catch {
          // already gone
        }
      }, 0);
    }
  }

  function displayRects(): DisplayRect[] {
    try {
      return Screen.getAllDisplays().map((display: Display) => ({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        primary: display.isPrimary === true,
        scale: display.scaleFactor,
        visible: {
          x: display.workArea.x,
          y: display.workArea.y,
          width: display.workArea.width,
          height: display.workArea.height,
        },
      }));
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ window state

  function applyFrame(managed: Managed, frame: boolean): boolean {
    if (chrome.setFrame !== undefined) {
      try {
        return chrome.setFrame(managed.win, frame) === true;
      } catch {
        return false;
      }
    }
    const ops = nativeOps();
    if (ops.setWindowFrame === undefined) return false;
    const pointer = managed.win.ptr;
    if (pointer === null || pointer === undefined) return false;
    try {
      return ops.setWindowFrame(pointer, frame) === true;
    } catch {
      return false;
    }
  }

  /** Sends the outer size that makes the page box `managed.page` under the current chrome. */
  function sendPageBox(managed: Managed): void {
    if (managed.closed) return;
    // A docked tab has no window: its page box is the view rect on the slot (`placeEmbedded`).
    if (managed.embedded) return;
    try {
      const outer = outerBoxForPage(managed.page, managed.decoration);
      managed.win.setSize(outer.width, outer.height);
    } catch {
      // the window is gone: the close handler is about to run
    }
  }

  /** Re-applies the page box after the asynchronous style-mask flip lands. */
  function settleChrome(managed: Managed, target: boolean): void {
    managed.cancelSettle?.();
    managed.settling = true;
    const last = CHROME_SETTLE_MS[CHROME_SETTLE_MS.length - 1];
    const timers: Array<{ clear: () => void }> = [];
    managed.cancelSettle = () => {
      for (const timer of timers) timer.clear();
      timers.length = 0;
      managed.cancelSettle = null;
      managed.settling = false;
    };
    for (const delay of CHROME_SETTLE_MS) {
      const handle = setTimeout(() => {
        if (managed.closed || managed.framed !== target) {
          managed.settling = false;
          return;
        }
        if (target) {
          // Once the titled mask is on, frame - page is a real reading of the titlebar.
          try {
            const frame = managed.win.getFrame();
            const reading = decorationFrom(frame, managed.page);
            if (reading.height > 0) {
              managed.framedDecoration = reading;
              managed.decoration = reading;
            }
          } catch {
            // the window closed while settling
          }
        }
        sendPageBox(managed);
        if (delay === last) {
          managed.settling = false;
          managed.cancelSettle = null;
          timers.length = 0;
        }
      }, delay);
      timers.push({ clear: () => clearTimeout(handle) });
    }
  }

  function emitState(managed: Managed): void {
    if (managed.closed) return;
    try {
      hooks.onWindowState?.({
        win: managed.id,
        // A docked tab has no window state: main owns the focus/minimize flags it would report.
        focused: managed.embedded ? false : managed.focused,
        minimized: managed.embedded ? false : managed.minimized,
        fullscreen: managed.embedded ? false : managed.fullscreen,
        maximized: managed.embedded ? false : managed.maximized,
      });
    } catch {
      // a hook that throws never takes a window down
    }
  }

  function poll(managed: Managed): void {
    if (managed.closed) return;
    const before = `${managed.focused}|${managed.minimized}|${managed.fullscreen}|${managed.maximized}`;
    try {
      managed.minimized = managed.win.isMinimized() === true;
      managed.fullscreen = managed.win.isFullScreen() === true;
      managed.maximized = managed.win.isMaximized() === true;
    } catch {
      return; // the window is closing
    }
    const after = `${managed.focused}|${managed.minimized}|${managed.fullscreen}|${managed.maximized}`;
    if (before !== after) emitState(managed);
  }

  function startPolling(managed: Managed): void {
    managed.stopPoll?.();
    // Electrobun has no minimize/unminimize event (measured); a 300 ms scalar read is cheap and
    // makes `onWindowState` catch minimize, full-screen and maximize like tinyjs does.
    const handle = setInterval(() => poll(managed), POLL_MS);
    managed.stopPoll = () => clearInterval(handle);
  }

  function stopPolling(managed: Managed): void {
    managed.stopPoll?.();
    managed.stopPoll = null;
  }

  // ------------------------------------------------------------------ navigation

  function applyRules(managed: Managed): void {
    try {
      managed.view.setNavigationRules(managed.rules);
    } catch {
      // the view may already be gone
    }
  }

  function denyFuture(managed: Managed, url: string): void {
    const rule = denyRuleFor(url);
    if (rule !== null && !managed.rules.includes(rule)) {
      managed.rules = [...managed.rules, rule];
      applyRules(managed);
    }
    managed.denied.add(url);
  }

  function injectToolBridge(managed: Managed): void {
    if (managed.kind === 'main') return;
    try {
      managed.view.executeJavascript(toolBridgeSource(managed.id));
    } catch {
      // the view is gone
    }
  }

  function reportNavigation(
    managed: Managed,
    kind: TinyNavEvent['kind'],
    url: string,
    isMainFrame = true,
  ): void {
    try {
      // Every report below has already been matched against the view's own top URL
      // (`acceptTopFrame`/`notePolicyCorrection`): the devkit's navigation events fire for subframes
      // and carry no frame flag (measured), so the frame claim is the facade's, not the event's.
      hooks.onNavigate?.({ window: managed.id, kind, url, isMainFrame });
    } catch {
      // hooks never take a navigation down
    }
  }

  function handlePolicy(managed: Managed, url: string, allowed: boolean): void {
    if (url === '' || url.startsWith('about:')) return;
    notePolicyCorrection(managed, url);
    if (managed.kind === 'main') gate?.beginNavigation?.(managed.view.id);
    let answer: 'deny' | 'external' | undefined;
    try {
      answer = hooks.onNavigate?.({
        window: managed.id,
        kind: 'policy',
        url,
        isMainFrame: true,
      });
    } catch {
      answer = undefined;
    }
    if (answer === 'external') {
      try {
        Utils.openExternal(url);
      } catch {
        // no browser: the navigation is denied below anyway
      }
      denyFuture(managed, url);
      return;
    }
    if (answer === 'deny' && allowed) {
      // The view's rules had already allowed this URL, so it may be loading. The next attempt is
      // denied natively; if it commits, the commit handler puts the previous page back.
      denyFuture(managed, url);
    }
  }

  function handleCommit(managed: Managed, url: string): void {
    managed.committedUrl = url;
    managed.committedOrigin = originOfUrl(url);
    // A new document: its tool-bridge call ids start over, so no reply from the previous one may
    // be written into it (`host-message` captures this counter around each call).
    managed.generation += 1;
    try {
      gate?.commit?.(managed.view.id, url);
    } catch {
      // the gate never takes a window down
    }
    if (managed.kind === 'main') {
      try {
        hooks.onMainOrigin?.(managed.committedOrigin, url);
      } catch {
        // hooks never take a window down
      }
    } else {
      injectToolBridge(managed);
    }
    if (managed.denied.delete(url)) {
      const back = managed.pageUrl;
      if (back !== null && back !== url) {
        try {
          managed.view.loadURL(back);
        } catch {
          // the view is gone
        }
      }
    }
  }

  function handleDownload(
    managed: Managed,
    state: 'started' | 'progress' | 'done' | 'failed',
    detail: DownloadDetail,
  ): void {
    const now = Date.now();
    let download: Download | undefined;
    if (state === 'started') {
      download = { id: ++downloadSeq, filename: detail.filename, path: detail.path, lastProgressAt: 0 };
      managed.downloads.push(download);
    } else {
      download =
        managed.downloads.find(
          (entry) =>
            (detail.path !== null && entry.path === detail.path) ||
            (detail.path === null && detail.filename !== '' && entry.filename === detail.filename),
        ) ?? managed.downloads[managed.downloads.length - 1];
    }
    if (download === undefined) return;
    if (state === 'progress') {
      if (now - download.lastProgressAt < DOWNLOAD_PROGRESS_MS) return;
      download.lastProgressAt = now;
    }
    if (state === 'done' || state === 'failed') {
      managed.downloads = managed.downloads.filter((entry) => entry !== download);
    }
    const event: TinyDownloadEvent = {
      id: download.id,
      // The devkit payload carries no URL (measured) and no byte counters; the audit needs only
      // filename + error, and the engine dropped the URL before the event existed.
      url: '',
      filename: download.filename !== '' ? download.filename : detail.filename,
      path: download.path ?? detail.path,
      state,
    };
    if (detail.error !== null) event.error = detail.error;
    try {
      hooks.onDownload?.(event);
    } catch {
      // hooks never take a window down
    }
  }

  function attachView(managed: Managed): void {
    // The devkit's BrowserView.on union omits `new-window-open`/`host-message`; the emitter is the
    // same `on(name, handler)` for every webview event, so one documented assertion reaches them.
    const view = managed.view as unknown as EventEmitter;
    view.on('will-navigate', (event: unknown) => {
      const detail = readNavigation(eventDetail(event));
      if (detail !== null) handlePolicy(managed, detail.url, detail.allowed);
    });
    view.on('did-commit-navigation', (event: unknown) => {
      const detail = readNavigation(eventDetail(event));
      if (detail === null) return;
      acceptTopFrame(managed, detail.url, () => {
        handleCommit(managed, detail.url);
        reportNavigation(managed, 'commit', detail.url);
      });
    });
    view.on('did-navigate', (event: unknown) => {
      const detail = readNavigation(eventDetail(event));
      if (detail === null) return;
      acceptTopFrame(managed, detail.url, () => reportNavigation(managed, 'start', detail.url));
    });
    view.on('dom-ready', (event: unknown) => {
      const detail = readNavigation(eventDetail(event));
      if (detail === null) return;
      acceptTopFrame(managed, detail.url, () => {
        managed.pageUrl = detail.url;
        injectToolBridge(managed);
        reportNavigation(managed, 'finish', detail.url);
      });
    });
    view.on('host-message', (event: unknown) => {
      const payload = readJson(eventDetail(event));
      if (payload === null || payload === undefined) return;
      let request: WindowsHostRequest | null = null;
      try {
        // The request/reply path when the gate offers it; the one-way path otherwise (a probe, a
        // test), so a launch without a gate behaves exactly as before.
        if (gate?.hostRequest !== undefined) {
          request = gate.hostRequest(managed.view.id, managed.id, payload, managed.committedOrigin);
        } else {
          gate?.hostMessage?.(managed.view.id, managed.id, payload, managed.committedOrigin);
        }
      } catch {
        return; // the gate never takes a window down
      }
      if (request === null || request.id === null || request.reply === null) return;
      const id = request.id;
      const reply = request.reply;
      const generation = managed.generation;
      void reply
        .then((answer) => {
          // A commit since the call means a different document; its counter starts over, so this
          // answer could land on a promise the new page made. Drop it (fails closed, like the gate).
          if (managed.closed || managed.generation !== generation) return;
          const js =
            answer.ok === true
              ? replySource(id, { ok: true, result: answer.result })
              : replySource(id, { ok: false, error: answer.error ?? '' });
          if (js === null) return;
          try {
            managed.view.executeJavascript(js);
          } catch {
            // the view is gone
          }
        })
        .catch(() => undefined);
    });
    view.on('new-window-open', (event: unknown) => {
      const url = readPopupUrl(readJson(eventDetail(event)));
      if (url !== null) handlePopupOpen(managed, url);
    });
    for (const [name, state] of [
      ['download-started', 'started'],
      ['download-progress', 'progress'],
      ['download-completed', 'done'],
      ['download-failed', 'failed'],
    ] as const) {
      view.on(name, (event: unknown) => {
        const detail = readDownloadDetail(readJson(eventDetail(event)));
        if (detail !== null) handleDownload(managed, state, detail);
      });
    }
  }

  // ------------------------------------------------------------------ window lifecycle

  function attachWindow(managed: Managed): void {
    const win = managed.win;
    const events = win as unknown as EventEmitter;
    // A carrier window outlives the tab only until it is docked: its late events must not touch a
    // record that now belongs to the main window.
    const current = () => !managed.closed && managed.win === win;
    events.on('focus', () => {
      if (!current()) return;
      managed.focused = true;
      emitState(managed);
    });
    events.on('blur', () => {
      if (!current()) return;
      managed.focused = false;
      emitState(managed);
    });
    events.on('resize', (event: unknown) => {
      if (!current() || managed.settling) return; // the chrome flip's own resize, not the person's
      if (event !== null && typeof event === 'object' && 'data' in event) {
        const data = event.data;
        if (data !== null && typeof data === 'object') {
          const width = 'width' in data ? data.width : undefined;
          const height = 'height' in data ? data.height : undefined;
          if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
            // Measured: the resize payload is the CONTENT size, i.e. the page box itself.
            managed.page = { width: Math.round(width), height: Math.round(height) };
            const clamped = clampToMinSize(managed.page, managed.minPage);
            if (clamped !== null) {
              managed.page = clamped;
              sendPageBox(managed);
            }
          }
        }
      }
      // Measured: a layout pass rewrites a window's views to fill its content view. A docked tab
      // gets its slot rect back; a detached one fills the window it just resized.
      if (managed.id === MAIN) placeEmbeddedAll();
      else placeDetached(managed);
    });
    events.on('will-close', (event: unknown) => {
      if (!current()) return;
      if (managed.id !== MAIN || !hideOnClose || quitting) return;
      // The devkit hands a mutable ElectrobunEvent; `allow:false` vetoes the close (measured in
      // `proc/native.ts`: `responseWasSet && response.allow === false`).
      const closeEvent = event as CloseEvent | null;
      if (closeEvent === null || typeof closeEvent !== 'object') return;
      closeEvent.response = { allow: false };
      // With another window on screen, only main goes away and that window stays (RF-15: a tool
      // window keeps working). When main is the last window, hide the APP instead of ordering the
      // window out: AppKit keeps a hidden app's windows in its window list, so neither macOS
      // automatic termination nor a user install of a "quit apps when their last window closes"
      // tool sees an app that ran out of windows (measured: a window-only hide got a Quit AppleEvent
      // ~1.5 s later, and Electrobun's delegate forwards every Quit to `Utils.quit()`).
      const ops = nativeOps();
      const appHide = ops.hideApp;
      if (hasOtherWindow(managed) || appHide === undefined || !appHide.call(ops)) {
        try {
          win.hide();
        } catch {
          // the window is already going away
        }
      }
      managed.visible = false;
      emitState(managed);
    });
    events.on('close', () => {
      if (!current()) return;
      managed.closed = true;
      managed.visible = false;
      stopPolling(managed);
      windows.delete(managed.id);
      // A tab's view has no window of its own: the devkit only removes views registered to the
      // window that closed, so this is the one that has to let it go.
      if (managed.id !== MAIN) {
        try {
          managed.view.remove();
        } catch {
          // the view is already gone
        }
      }
      try {
        gate?.forget?.(managed.view.id);
      } catch {
        // the gate never takes a window down
      }
      try {
        hooks.onWindowClosed?.(managed.id);
      } catch {
        // hooks never take a window down
      }
    });
  }

  /** The fields every managed window and tab starts with. */
  function baseManaged(init: {
    id: string;
    kind: ViewKind;
    win: AnyWindow;
    view: AnyView;
    page: Size;
    framed: boolean;
    decoration: Decoration;
    pageUrl: string | null;
    popupOf?: string | null;
    embedded?: boolean;
    shell?: AnyWindow | null;
    screen?: Rect | null;
    local?: Rect | null;
    viewRef?: string | null;
    focused?: boolean;
    title?: string;
  }): Managed {
    return {
      id: init.id,
      kind: init.kind,
      win: init.win,
      view: init.view,
      handle: undefined as never,
      embedded: init.embedded === true,
      viewRef: init.viewRef ?? null,
      screen: init.screen ?? null,
      local: init.local ?? null,
      shell: init.shell ?? null,
      title: init.title ?? 'Nod',
      framed: init.framed,
      decoration: init.decoration,
      framedDecoration: init.framed && init.decoration.height > 0 ? init.decoration : null,
      page: init.page,
      minPage: null,
      focused: init.focused !== false,
      minimized: false,
      fullscreen: false,
      maximized: false,
      visible: true,
      closed: false,
      settling: false,
      committedUrl: null,
      committedOrigin: null,
      generation: 0,
      pageUrl: init.pageUrl,
      rules: [...NAVIGATION_ALLOW_RULES],
      denied: new Set<string>(),
      popupOf: init.popupOf ?? null,
      downloads: [],
      stopPoll: null,
      cancelSettle: null,
    };
  }

  /**
   * Handle, map, events, rules and gate registration: the tail every creation shares. A docked view
   * has no window of its own, so it takes no window events and no window-state poll.
   */
  function finishManaged(managed: Managed, withWindow: boolean): Managed {
    managed.handle = makeHandle(managed);
    windows.set(managed.id, managed);
    if (withWindow) attachWindow(managed);
    attachView(managed);
    // `createWebview` drops creation-time rules in 2.0.4; this is the call that reaches native code.
    applyRules(managed);
    if (withWindow) startPolling(managed);
    try {
      gate?.register(managed.view.id, managed.id, managed.kind);
    } catch {
      // the gate never takes a window down
    }
    return managed;
  }

  /** A `BrowserWindow` with the Nod's option assembly, and the chrome it charges on every setSize. */
  function newShellWindow(
    options: {
      title?: string;
      left?: number;
      top?: number;
      frameless?: boolean;
      activate?: boolean;
      hidden?: boolean;
      sandbox?: boolean;
      rpc?: unknown;
      preload?: string | null;
    },
    page: Size,
    url: string | null,
  ): { win: AnyWindow; outer: Size | null; decoration: Decoration } {
    const frameless = options.frameless === true;
    // The devkit's RPC generic cannot be expressed for an `unknown` field, and the facade never
    // reads it; one assertion at the constructor boundary keeps the rest of the file typed.
    const windowOptions = {
      title: options.title ?? 'Nod',
      url,
      frame: {
        ...(options.left !== undefined ? { x: Math.round(options.left) } : {}),
        ...(options.top !== undefined ? { y: Math.round(options.top) } : {}),
        width: page.width,
        height: page.height,
      },
      titleBarStyle: frameless ? 'hidden' : 'default',
      // Contract invariant: tool and popup views are sandboxed (no RPC, no main bridge).
      sandbox: options.sandbox === true,
      rpc: options.rpc,
      preload: options.preload ?? null,
      activate: options.activate !== false,
      hidden: options.hidden === true,
    } as unknown as Partial<WindowOptionsType<never>>;
    const win = new BrowserWindow(windowOptions) as AnyWindow;

    // Creation took the content rect; whatever the frame reads back now minus the requested page
    // box is the titlebar the runtime charges on every later setSize.
    let decoration = NO_DECORATION;
    let outer: Size | null = null;
    try {
      const frame = win.getFrame();
      outer = { width: frame.width, height: frame.height };
      decoration = decorationAtCreation(frameless, outer, page);
    } catch {
      decoration = decorationFor(!frameless, null);
    }
    return { win, outer, decoration };
  }

  /** A window that owns its own page (the main window, and the no-native fallback for a tab). */
  function create(
    id: string,
    kind: ViewKind,
    url: string,
    options: {
      title?: string;
      page?: Size;
      left?: number;
      top?: number;
      frameless?: boolean;
      activate?: boolean;
      popupOf?: string | null;
      sandbox?: boolean;
      rpc?: unknown;
      preload?: string | null;
    } = {},
  ): Managed {
    const page = options.page ?? DEFAULT_PAGE;
    const frameless = options.frameless === true;
    const shell = newShellWindow(options, page, url);
    const managed = baseManaged({
      id,
      kind,
      win: shell.win,
      view: shell.win.webview,
      page: shell.outer === null ? page : pageBoxFromOuter(shell.outer, shell.decoration),
      framed: !frameless,
      decoration: shell.decoration,
      pageUrl: url,
      popupOf: options.popupOf ?? null,
      focused: options.activate !== false,
      title: options.title ?? 'Nod',
    });
    return finishManaged(managed, true);
  }

  /**
   * A docked tab (owner decision 2026-10-22 §22): a main-process `BrowserView` laid over the main
   * window's content view — no window of its own. The geometry the backend passes is the slot's
   * screen rect; it is translated to the content view here. `autoResize: false` is mandatory (with
   * the default the view fills the content view, measured in `e06-view-spike.md` §1).
   */
  function createEmbedded(
    id: string,
    kind: ViewKind,
    url: string,
    options: {
      title?: string;
      page?: Size;
      left?: number;
      top?: number;
      popupOf?: string | null;
      preload?: string | null;
    } = {},
  ): Managed | null {
    const host = windows.get(MAIN);
    if (host === undefined || !canEmbed()) return null;
    let frame: Rect;
    try {
      frame = host.win.getFrame();
    } catch {
      return null;
    }
    const page = options.page ?? DEFAULT_PAGE;
    const screen: Rect = {
      x: options.left ?? frame.x,
      y: options.top ?? frame.y,
      width: page.width,
      height: page.height,
    };
    const local = viewRectForScreen(frame, host.page, screen);
    const before = viewRefs(host.win);
    let view: AnyView;
    try {
      view = new BrowserView({
        windowId: host.win.id,
        url,
        frame: local,
        autoResize: false,
        renderer: 'native',
        // Contract invariant: every tool, link and popup view is sandboxed (no RPC, no bridge).
        sandbox: true,
        preload: options.preload ?? toolBridgeSource(id),
      }) as AnyView;
    } catch {
      return null;
    }
    const viewRef = addedViewRef(before, viewRefs(host.win), url);
    const managed = baseManaged({
      id,
      kind,
      win: host.win,
      view,
      page,
      framed: false,
      decoration: NO_DECORATION,
      pageUrl: url,
      popupOf: options.popupOf ?? null,
      embedded: true,
      screen,
      local,
      viewRef,
      focused: false,
      title: options.title ?? 'Nod',
    });
    return finishManaged(managed, false);
  }

  /**
   * A tab in its own window: a real `BrowserWindow` (title, frame, focus, close — as before), whose
   * page is the *same* view object a docked tab uses, moved into it with the AppKit re-parent the
   * spike measured (0.5–1.8 ms, no reload). Because the view's core registration stays with the
   * main window, docking it back is one more move and destroying the window never destroys the page.
   */
  function createCarrier(
    id: string,
    kind: ViewKind,
    url: string,
    options: {
      title?: string;
      page?: Size;
      left?: number;
      top?: number;
      activate?: boolean;
      popupOf?: string | null;
      preload?: string | null;
    } = {},
  ): Managed | null {
    const host = windows.get(MAIN);
    if (host === undefined || !canEmbed()) return null;
    const page = options.page ?? DEFAULT_PAGE;
    let shell: { win: AnyWindow; outer: Size | null; decoration: Decoration };
    try {
      // `url: null`: the window carries no page of its own — the tab's view is moved in right after,
      // and the empty view the constructor creates is removed so the window has exactly one page.
      shell = newShellWindow(options, page, null);
    } catch {
      return null;
    }
    try {
      shell.win.webview?.remove();
    } catch {
      // the constructor's view is already gone
    }
    const before = viewRefs(host.win);
    const local = viewRectForContent(page);
    let view: AnyView;
    try {
      view = new BrowserView({
        windowId: host.win.id,
        url,
        // 1×1 until it is inside its own window: the view is registered with main, and anything
        // bigger would paint over the shell for the instant before the re-parent.
        frame: { x: 0, y: 0, width: 1, height: 1 },
        autoResize: false,
        renderer: 'native',
        sandbox: true,
        preload: options.preload ?? toolBridgeSource(id),
      }) as AnyView;
    } catch {
      try {
        shell.win.close();
      } catch {
        // already gone
      }
      return null;
    }
    let screen: Rect | null = null;
    try {
      const frame = shell.win.getFrame();
      screen = { x: frame.x, y: frame.y, width: page.width, height: page.height };
    } catch {
      screen = null;
    }
    const managed = baseManaged({
      id,
      kind,
      win: shell.win,
      view,
      page,
      framed: true,
      decoration: shell.decoration,
      pageUrl: url,
      popupOf: options.popupOf ?? null,
      shell: shell.win,
      screen,
      local,
      viewRef: addedViewRef(before, viewRefs(host.win), url),
      focused: options.activate !== false,
      title: options.title ?? 'Nod',
    });
    if (!reparent(managed, shell.win, local, true)) {
      managed.closed = true;
      try {
        view.remove();
        shell.win.close();
      } catch {
        // the window may already be gone
      }
      return null;
    }
    placeView(managed, local);
    return finishManaged(managed, true);
  }

  /** Adopts a window someone else created (the Shell's main window, with its page bridge RPC). */
  function adoptMain(win: AnyWindow, page: Size): Managed {
    let decoration = decorationFor(true, null);
    let outer: Size | null = null;
    try {
      const frame = win.getFrame();
      outer = { width: frame.width, height: frame.height };
      decoration = decorationAtCreation(false, outer, page);
    } catch {
      // keep the default titlebar
    }
    const managed = baseManaged({
      id: MAIN,
      kind: 'main',
      win,
      view: win.webview,
      page: outer === null ? page : pageBoxFromOuter(outer, decoration),
      framed: true,
      decoration,
      pageUrl: win.url ?? null,
      focused: true,
    });
    return finishManaged(managed, true);
  }

  /**
   * What a window id is, for the gate: the backend's ids are `main`, `tool_*`/a tool slug,
   * `link_<n>` for an ad-hoc tab and `popup<N>` for a popup. Only a tool window may reach
   * `login.report`; a link has no api at all (`gate-core.ts` `decide`).
   */
  function kindFor(id: string): ViewKind {
    if (id === MAIN) return 'main';
    if (id.startsWith('link_')) return 'link';
    if (id.startsWith('embed_')) return 'embed';
    if (id.startsWith('popup')) return 'popup';
    return 'tool';
  }

  function requireWindow(id: string): Managed {
    const managed = windows.get(id);
    if (managed === undefined) throw new Error(`no window "${id}"`);
    return managed;
  }

  function currentPage(managed: Managed): Size {
    if (managed.embedded) return managed.page;
    try {
      const frame = managed.win.getFrame();
      return pageBoxFromOuter({ width: frame.width, height: frame.height }, managed.decoration);
    } catch {
      return managed.page;
    }
  }

  // ------------------------------------------------------------------ getState

  /**
   * What `getState()` answers for a docked tab: the slot rect the backend laid it on, in screen
   * coordinates, with no window of its own to report. `canPosition` stays true — the backend asks it
   * of main, not of a tab.
   */
  function embeddedState(managed: Managed): TinyWinState | null {
    if (managed.closed) return null;
    const host = hostGeometry();
    if (host === null) return null;
    const fallback = managed.local ?? {
      x: 0,
      y: 0,
      width: managed.page.width,
      height: managed.page.height,
    };
    const screen =
      managed.screen ?? screenRectForView(host.frame, host.page, fallback);
    const display = screenForRect(displayRects(), screen);
    const hostVisible = windows.get(MAIN)?.visible !== false;
    return {
      x: screen.x,
      y: screen.y,
      width: managed.page.width,
      height: managed.page.height,
      outer: { width: screen.width, height: screen.height },
      fullscreen: false,
      minimized: false,
      visible: managed.visible && hostVisible,
      focused: false,
      alwaysOnTop: false,
      resizable: true,
      clickThrough: false,
      level: 'normal',
      allSpaces: false,
      chrome: {
        frame: false,
        windowControls: null,
        transparent: false,
        vibrancy: null,
        squareCorners: false,
        acceptsFirstMouse: false,
      },
      screen: { width: display?.width ?? 0, height: display?.height ?? 0, scale: display?.scale ?? 1 },
      canPosition: true,
    };
  }

  function stateOf(managed: Managed): TinyWinState | null {
    if (managed.closed) return null;
    if (managed.embedded) return embeddedState(managed);
    let frame: Rect;
    let alwaysOnTop: boolean;
    let allSpaces: boolean;
    let minimized: boolean;
    let fullscreen: boolean;
    let maximized: boolean;
    let visible: boolean;
    try {
      frame = managed.win.getFrame();
      alwaysOnTop = managed.win.isAlwaysOnTop() === true;
      allSpaces = managed.win.isVisibleOnAllWorkspaces() === true;
      minimized = managed.win.isMinimized() === true;
      fullscreen = managed.win.isFullScreen() === true;
      maximized = managed.win.isMaximized() === true;
      visible = managed.win.isVisible() === true;
    } catch {
      return null;
    }
    managed.minimized = minimized;
    managed.fullscreen = fullscreen;
    managed.maximized = maximized;
    managed.visible = visible;
    const display = screenForRect(displayRects(), frame);
    return {
      x: frame.x,
      y: frame.y,
      width: managed.page.width,
      height: managed.page.height,
      outer: { width: frame.width, height: frame.height },
      fullscreen,
      minimized,
      visible,
      focused: managed.focused,
      alwaysOnTop,
      resizable: true,
      clickThrough: false,
      level: 'normal',
      allSpaces,
      chrome: {
        frame: managed.framed,
        windowControls: managed.framed ? ['close', 'minimize', 'maximize'] : null,
        transparent: false,
        vibrancy: null,
        squareCorners: false,
        acceptsFirstMouse: false,
      },
      screen: { width: display?.width ?? 0, height: display?.height ?? 0, scale: display?.scale ?? 1 },
      canPosition: true,
    };
  }

  // ------------------------------------------------------------------ handles

  function makeHandle(managed: Managed): TinyWindowHandle {
    const handle = {
      get id() {
        return managed.id;
      },
      eval(js: string) {
        managed.view.executeJavascript(js);
      },
      push() {
        // Only the main window has an RPC bridge; `app.push` is the app facade's job (A21).
      },
      close() {
        if (managed.closed) return;
        if (managed.embedded) {
          // A docked tab has no window to close: drop the view and report it like a closed window.
          managed.closed = true;
          managed.visible = false;
          windows.delete(managed.id);
          try {
            managed.view.remove();
          } catch {
            // the view is already gone
          }
          try {
            gate?.forget?.(managed.view.id);
          } catch {
            // the gate never takes a window down
          }
          try {
            hooks.onWindowClosed?.(managed.id);
          } catch {
            // hooks never take a window down
          }
          return;
        }
        // An explicit close of main is the tinyjs "quit" path: `setHideOnClose` must not intercept.
        if (managed.id === MAIN) quitting = true;
        managed.win.close();
      },
      setTitle(title: string) {
        if (managed.closed) return;
        managed.title = title;
        if (managed.embedded) return; // a docked tab carries its title on the strip, not a window
        managed.win.setTitle(title);
      },
      setSize(width: number, height: number) {
        if (managed.closed) return;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        const requested = { width: Math.round(width), height: Math.round(height) };
        // The floor is the Nod's page box: `setSize` never goes under `setMinSize`.
        managed.page = clampToMinSize(requested, managed.minPage) ?? requested;
        if (managed.embedded) {
          // The backend speaks the slot's screen rect; the view takes it relative to main.
          managed.screen = { ...tabScreen(managed), ...managed.page };
          placeEmbedded(managed);
          return;
        }
        sendPageBox(managed);
      },
      setPosition(x: number, y: number) {
        if (managed.closed) return;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (managed.embedded) {
          managed.screen = { ...tabScreen(managed), x: Math.round(x), y: Math.round(y) };
          placeEmbedded(managed);
          return;
        }
        managed.win.setPosition(Math.round(x), Math.round(y));
      },
      center() {
        if (managed.closed || managed.embedded) return;
        managed.win.center();
      },
      hide(opts?: TinyHideOptions) {
        if (managed.closed) return;
        // On `main` a bare `hide()` is the APP hide (tinyjs semantics): `NSApp.hide` puts every
        // window away and focus returns to the previous app, which is what a palette needs.
        // `{ app: false }` stays a window-only hide.
        if (managed.id === MAIN && opts?.app !== false) {
          const ops = nativeOps();
          const appHide = ops.hideApp;
          if (appHide !== undefined && appHide.call(ops)) {
            managed.visible = false;
            emitState(managed);
            return;
          }
          // No native helper (non-macOS): fall through to the window hide below.
        }
        if (managed.embedded) {
          // `webviewSetHidden`: the page stays alive and does not reload (measured).
          setViewHidden(managed, true);
          managed.visible = false;
          emitState(managed);
          return;
        }
        managed.win.hide();
        managed.visible = false;
        emitState(managed);
      },
      show(opts?: TinyShowOptions) {
        if (managed.closed) return;
        if (managed.embedded) {
          // A layout pass may have re-laid the view while it was hidden; the slot rect wins.
          placeEmbedded(managed);
          setViewHidden(managed, false);
          managed.visible = true;
          if (opts?.activate !== false) {
            try {
              windows.get(MAIN)?.win.activate();
            } catch {
              // the main window is already gone
            }
          }
          emitState(managed);
          return;
        }
        if (opts?.activate === false) managed.win.showInactive();
        else managed.win.show();
        managed.visible = true;
        emitState(managed);
      },
      minimize() {
        if (managed.closed || managed.embedded) return;
        managed.win.minimize();
        managed.minimized = true;
        emitState(managed);
      },
      restore() {
        if (managed.closed || managed.embedded) return;
        managed.win.unminimize();
        managed.minimized = false;
        emitState(managed);
      },
      zoom() {
        if (managed.closed || managed.embedded) return;
        managed.win.maximize();
      },
      fullscreen() {
        if (managed.closed || managed.embedded) return;
        const target = managed.win.isFullScreen() !== true;
        managed.win.setFullScreen(target);
        managed.fullscreen = target;
        emitState(managed);
      },
      setFullscreen(enabled: boolean) {
        if (managed.closed || managed.embedded) return;
        managed.win.setFullScreen(enabled === true);
        managed.fullscreen = enabled === true;
        emitState(managed);
      },
      setAlwaysOnTop(enabled: boolean) {
        if (managed.closed || managed.embedded) return;
        managed.win.setAlwaysOnTop(enabled === true);
      },
      setResizable() {
        // Creation-time only in Electrobun 2.0.4 (`styleMask`); the Nod never changes it at runtime.
      },
      setMinSize(width: number, height: number) {
        if (managed.closed) return;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        managed.minPage = { width: Math.round(width), height: Math.round(height) };
        const clamped = clampToMinSize(managed.page, managed.minPage);
        if (clamped !== null) {
          managed.page = clamped;
          if (managed.embedded) managed.screen = { ...tabScreen(managed), ...managed.page };
          sendPageBox(managed);
          if (managed.embedded) placeEmbedded(managed);
        }
        if (managed.embedded) return; // the floor is the tab's, not main's
        if (chrome.setMinSize !== undefined) {
          try {
            chrome.setMinSize(managed.win, width, height);
            return;
          } catch {
            // fall through to the native helper / the JS clamp
          }
        }
        const ops = nativeOps();
        const pointer = managed.win.ptr;
        if (ops.setContentMinSize !== undefined && pointer !== null && pointer !== undefined) {
          try {
            ops.setContentMinSize(pointer, Math.round(width), Math.round(height));
          } catch {
            // the JS clamp below still keeps the floor
          }
        }
      },
      ensureOnScreen() {
        // No devkit primitive; `getState`/`setPosition` keep the geometry the Nod already tracks.
      },
      startDrag() {
        // Frameless drag belongs to the page (`data-tiny-drag`); the backend never starts it.
      },
      startResize() {
        // A borderless window keeps its native resize edges; no per-edge API in the devkit.
      },
      setZoom() {
        // Native page zoom is not part of the Nod surface; window zoom is `zoom()`.
      },
      setClickThrough() {
        // No devkit API; the Nod never enables click-through.
      },
      setLevel() {
        // Only 'normal' is representable (`setAlwaysOnTop` covers 'floating').
      },
      setAllSpaces(enabled: boolean) {
        if (managed.closed || managed.embedded) return;
        managed.win.setVisibleOnAllWorkspaces(enabled === true);
      },
      setChrome(opts: TinyChromeOptions) {
        if (managed.closed) return;
        if (opts === null || typeof opts !== 'object') return;
        if (opts.frame === undefined) return; // the other chrome options are creation-time here
        const target = opts.frame === true;
        if (target === managed.framed) return;
        if (managed.id === MAIN) {
          const page = currentPage(managed);
          if (!applyFrame(managed, target)) {
            throw new Error('runtime window chrome is unavailable');
          }
          managed.framed = target;
          managed.decoration = decorationFor(target, managed.framedDecoration);
          managed.page = page;
          sendPageBox(managed);
          settleChrome(managed, target);
          emitState(managed);
          return;
        }
        // A tab: `frame:true` detaches it into its own window, `frame:false` docks it back onto the
        // slot — the same live view either way, no reload (RF-51).
        if (target) detachTab(managed);
        else dockTab(managed);
        emitState(managed);
      },
      async getState() {
        return stateOf(managed);
      },
      get menu() {
        return { set() {}, reset() {}, update() {}, async get() { return { exists: false }; } };
      },
      setMenu() {},
      resetMenu() {},
      updateMenuItem() {},
      async getMenuItem() {
        return { exists: false };
      },
      print() {},
      async printToPDF() {
        return { path: '' };
      },
      share() {
        return false;
      },
    };
    return handle as unknown as TinyWindowHandle;
  }

  /** `window('main')` before main exists: the tinyjs `"mainWindow": false` answer is a no-op handle. */
  function idleMainHandle(): TinyWindowHandle {
    const noop = {
      id: MAIN,
      eval() {},
      push() {},
      close() {},
      setTitle() {},
      setSize() {},
      setPosition() {},
      center() {},
      hide() {},
      show() {},
      minimize() {},
      restore() {},
      zoom() {},
      fullscreen() {},
      setFullscreen() {},
      setAlwaysOnTop() {},
      setResizable() {},
      setMinSize() {},
      ensureOnScreen() {},
      startDrag() {},
      startResize() {},
      setZoom() {},
      setClickThrough() {},
      setLevel() {},
      setAllSpaces() {},
      setChrome() {
        throw new Error('there is no main window');
      },
      async getState() {
        return null;
      },
      get menu() {
        return { set() {}, reset() {}, update() {}, async get() { return { exists: false }; } };
      },
      setMenu() {},
      resetMenu() {},
      updateMenuItem() {},
      async getMenuItem() {
        return { exists: false };
      },
      print() {},
      async printToPDF() {
        return { path: '' };
      },
      share() {
        return false;
      },
    };
    return noop as unknown as TinyWindowHandle;
  }

  function handleFor(id: string): TinyWindowHandle {
    if (id === MAIN) {
      const main = windows.get(MAIN);
      return main === undefined ? idleMainHandle() : main.handle;
    }
    return requireWindow(id).handle;
  }

  // ------------------------------------------------------------------ open

  function openMain(): Managed | null {
    const existing = windows.get(MAIN);
    if (existing !== undefined) return existing;
    if (deps.mainWindow !== undefined) return adoptMain(deps.mainWindow, pageSize(deps.mainSize));
    if (deps.mainUrl === undefined || deps.mainUrl === '') return null;
    return create(MAIN, 'main', deps.mainUrl, {
      title: 'Nod',
      page: pageSize(deps.mainSize),
      activate: true,
      sandbox: false,
      rpc: deps.mainRpc,
      preload: deps.mainPreload ?? null,
    });
  }

  function open(id: string, opts?: TinyOpenWindowOptions): void {
    if (id === MAIN) {
      openMain();
      return;
    }
    const existing = windows.get(id);
    if (existing !== undefined) {
      existing.handle.show();
      return;
    }
    if (opts === undefined || typeof opts.page !== 'string' || opts.page === '') {
      throw new Error(`win.open("${id}") needs a page`);
    }
    const kind = kindFor(id);
    const page = parseSize(opts.size) ?? DEFAULT_PAGE;
    const title = typeof opts.title === 'string' && opts.title !== '' ? opts.title : 'Nod';
    const left = typeof opts.x === 'number' ? opts.x : undefined;
    const top = typeof opts.y === 'number' ? opts.y : undefined;
    const docked = opts.chrome?.frame === false;
    // Owner decision 2026-10-22 §22: a docked tab is a native view inside the Nod window. The
    // backend is unchanged — it opens with `chrome:{frame:false}` and the same screen rect either
    // way; only the runtime object behind the handle differs (a `BrowserView` instead of a window).
    const managed =
      (docked ? createEmbedded(id, kind, resolvePage(opts.page), { title, page, left, top }) : null) ??
      createCarrier(id, kind, resolvePage(opts.page), { title, page, left, top, activate: true }) ??
      create(id, kind, resolvePage(opts.page), {
        title,
        page,
        left,
        top,
        frameless: docked,
        activate: true,
        sandbox: true,
        preload: toolBridgeSource(id),
      });
    const min = parseSize(opts.minSize);
    if (min !== null) managed.handle.setMinSize(min.width, min.height);
  }

  // ------------------------------------------------------------------ popups

  function defaultPopupMode(): 'window' | 'external' | 'deny' {
    try {
      return deps.popupMode?.() ?? 'window';
    } catch {
      return 'window';
    }
  }

  function reportPopup(
    opener: Managed,
    url: string,
    action: 'window' | 'external' | 'deny',
    window: string | null,
  ): void {
    try {
      hooks.onWindowOpen?.({ window, opener: opener.id, url, kind: 'open', action });
    } catch {
      // hooks never take a window down
    }
  }

  function handlePopupOpen(managed: Managed, url: string): void {
    const id = `popup${++popupSeq}`;
    const mode = defaultPopupMode();
    let answer: 'window' | 'external' | 'deny' = mode;
    try {
      const decided = hooks.onWindowOpen?.({
        window: id,
        opener: managed.id,
        url,
        kind: 'policy',
        mode,
      });
      if (decided === 'window' || decided === 'external' || decided === 'deny') answer = decided;
    } catch {
      answer = mode;
    }
    if (answer === 'external') {
      try {
        Utils.openExternal(url);
      } catch {
        // no browser available
      }
      reportPopup(managed, url, 'external', null);
      return;
    }
    if (answer === 'deny') {
      reportPopup(managed, url, 'deny', null);
      return;
    }
    let openerFrame: Rect | null = null;
    try {
      openerFrame = managed.win.getFrame();
    } catch {
      openerFrame = null;
    }
    const display = openerFrame === null ? null : screenForRect(displayRects(), openerFrame);
    const rect = cascadeRect(openerFrame, display, POPUP_PAGE);
    // The `new-window-open` handler runs inside a native callback; creating a window there would
    // re-enter the core from the same stack. One tick later is still ahead of the popup's own load.
    setTimeout(() => {
      if (managed.closed) {
        reportPopup(managed, url, 'window', null);
        return;
      }
      let popupId: string | null = id;
      const options = {
        title: 'Nod',
        page: { width: rect.width, height: rect.height },
        left: rect.x,
        top: rect.y,
        activate: true,
      };
      try {
        // The popup's page is the same view object a tab uses (moved into its own window), so the
        // backend can adopt it as a docked tab (`setChrome({frame:false})`) with no reload.
        createCarrier(id, 'popup', url, { ...options, popupOf: managed.id }) ??
          create(id, 'popup', url, {
            ...options,
            frameless: false,
            popupOf: managed.id,
            sandbox: true,
            preload: toolBridgeSource(id),
          });
      } catch {
        popupId = null;
      }
      reportPopup(managed, url, 'window', popupId);
    }, 0);
  }

  // ------------------------------------------------------------------ facade

  const screens = async (): Promise<TinyScreen[]> => {
    try {
      return Screen.getAllDisplays().map((display: Display) => ({
        id: display.id,
        name: null,
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        visible: {
          x: display.workArea.x,
          y: display.workArea.y,
          width: display.workArea.width,
          height: display.workArea.height,
        },
        scale: display.scaleFactor,
        primary: display.isPrimary === true,
      }));
    } catch {
      return [];
    }
  };

  const win = {
    open,
    async getState(): Promise<TinyWinState | null> {
      const managed = windows.get(MAIN);
      return managed === undefined ? null : stateOf(managed);
    },
    close(id?: string) {
      handleFor(id ?? MAIN).close();
    },
    async windows(): Promise<string[]> {
      return [...windows.keys()];
    },
    setHideOnClose(enabled: boolean) {
      hideOnClose = enabled === true;
      holdTermination();
    },
    // Everything else `TinyApp['win']` inherits from `TinyWindowHandle` acts on main, like tinyjs.
    get id() {
      return MAIN;
    },
    eval(js: string) {
      handleFor(MAIN).eval(js);
    },
    push() {
      // `app.push` (A21) delivers to the main window's RPC; the handle has no separate channel.
    },
    show(opts?: TinyShowOptions) {
      handleFor(MAIN).show(opts);
    },
    hide(opts?: TinyHideOptions) {
      handleFor(MAIN).hide(opts);
    },
    setSize(width: number, height: number) {
      handleFor(MAIN).setSize(width, height);
    },
    setPosition(x: number, y: number) {
      handleFor(MAIN).setPosition(x, y);
    },
    center() {
      handleFor(MAIN).center();
    },
    minimize() {
      handleFor(MAIN).minimize();
    },
    restore() {
      handleFor(MAIN).restore();
    },
    fullscreen() {
      handleFor(MAIN).fullscreen();
    },
    setFullscreen(enabled: boolean) {
      handleFor(MAIN).setFullscreen(enabled);
    },
    setAlwaysOnTop(enabled: boolean) {
      handleFor(MAIN).setAlwaysOnTop(enabled);
    },
    setResizable(enabled: boolean) {
      handleFor(MAIN).setResizable(enabled);
    },
    setMinSize(width: number, height: number) {
      handleFor(MAIN).setMinSize(width, height);
    },
    setChrome(opts: TinyChromeOptions) {
      handleFor(MAIN).setChrome(opts);
    },
    setTitle(title: string) {
      handleFor(MAIN).setTitle(title);
    },
    ensureOnScreen() {
      handleFor(MAIN).ensureOnScreen();
    },
    startDrag() {
      handleFor(MAIN).startDrag();
    },
    startResize() {
      handleFor(MAIN).startResize();
    },
    setZoom(factor: number) {
      handleFor(MAIN).setZoom(factor);
    },
    setClickThrough(enabled: boolean) {
      handleFor(MAIN).setClickThrough(enabled);
    },
    setLevel(level: TinyWindowLevel) {
      handleFor(MAIN).setLevel(level);
    },
    setAllSpaces(enabled: boolean) {
      handleFor(MAIN).setAllSpaces(enabled);
    },
    get menu() {
      return handleFor(MAIN).menu;
    },
    setMenu() {},
    resetMenu() {},
    updateMenuItem() {},
    async getMenuItem() {
      return { exists: false };
    },
    print() {},
    async printToPDF() {
      return { path: '' };
    },
    share() {
      return false;
    },
  };

  // The launcher opens the main window as the app starts, before the backend's `init` (which only
  // records the app). A page call that races the boot is answered by the gate, exactly as on tinyjs.
  if (deps.mainWindow !== undefined || (deps.mainUrl !== undefined && deps.mainUrl !== '')) {
    openMain();
  }

  return {
    win: win as unknown as TinyApp['win'],
    window(id: string): TinyWindowHandle {
      return handleFor(id);
    },
    screens,
    mainWindow(): AnyWindow | null {
      return windows.get(MAIN)?.win ?? null;
    },
    mainView(): AnyView | null {
      return windows.get(MAIN)?.view ?? null;
    },
    ids(): string[] {
      return [...windows.keys()];
    },
    quit(): void {
      quitting = true;
      hideOnClose = false;
      holdTermination();
      for (const managed of [...windows.values()]) {
        // A docked tab has no window of its own: its view dies with the main window below.
        if (managed.embedded) continue;
        try {
          managed.win.close();
        } catch {
          // already gone
        }
      }
      void Utils.quit();
    },
  };
}
