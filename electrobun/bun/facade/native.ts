// The Electrobun target's native client: keychain secrets, LocalAuthentication, the app icon,
// `NSApp.hide`, tray icon rendering, and the app-modal file panels, over
// `electrobun/native/NodNative.swift` compiled to `libNodNative.dylib`.
//
// The Swift library is loaded IN-PROCESS with `bun:ffi`, not as a child process: on Electrobun the
// Bun process is the bundle's foreground app (`Contents/MacOS/bun`), so it is the only process that
// can own `NSApp`'s icon, present NSOpenPanel/NSSavePanel as Nod, show the Touch ID sheet as Nod, and
// write a keychain item whose ACL names the app binary. The measurement lives at the top of the
// Swift file.
//
// Wire discipline: one JSON request string per FFI call, one JSON response string back, `id` echoed.
// Secret values travel only as that in-memory argument — never argv, environment, a temp file or a
// log. `encodeNativeRequest`/`decodeNativeResponse` are pure and covered by
// `test/electrobun-native.test.ts`.
//
// Authentication is begin/poll: the system sheet is asynchronous, and a blocking FFI call would
// freeze the Bun loop (and every backend task) for as long as the person takes to answer.
import { dlopen, FFIType } from 'bun:ffi';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TrayIconSpec } from './tray-icon';

// MARK: - Errors

/** A native failure, or a protocol violation. `code` is the Swift side's failure code. */
export class NativeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeError';
    this.code = code;
  }
}

// MARK: - Wire protocol (pure)

export type NativeOp =
  | 'keychain.get'
  | 'keychain.set'
  | 'keychain.delete'
  | 'canAuthenticate'
  | 'authenticate.begin'
  | 'authenticate.poll'
  | 'authenticate.cancel'
  | 'setAppIcon'
  | 'openFile'
  | 'saveFile'
  | 'setWindowFrame'
  | 'setContentMinSize'
  | 'views.list'
  | 'view.attach'
  | 'view.url'
  | 'hideApp'
  | 'setTerminationHold'
  | 'renderTrayIcon';

export type NativeWireRequest =
  | { id: string; op: 'keychain.get'; service?: string; account: string }
  | { id: string; op: 'keychain.set'; service?: string; account: string; value: string }
  | { id: string; op: 'keychain.delete'; service?: string; account: string }
  | { id: string; op: 'canAuthenticate' }
  | { id: string; op: 'authenticate.begin'; reason?: string }
  | { id: string; op: 'authenticate.poll'; token: string }
  | { id: string; op: 'authenticate.cancel'; token: string }
  | { id: string; op: 'setAppIcon'; path: string }
  | { id: string; op: 'openFile'; types?: string[]; title?: string }
  | { id: string; op: 'saveFile'; types?: string[]; name?: string; title?: string }
  | { id: string; op: 'setWindowFrame'; target: string; frame: boolean }
  | { id: string; op: 'setContentMinSize'; target: string; width: number; height: number }
  | { id: string; op: 'views.list'; target: string }
  | { id: string; op: 'view.url'; view: string }
  | { id: string; op: 'hideApp' }
  | { id: string; op: 'setTerminationHold'; enabled: boolean }
  | {
      id: string;
      op: 'renderTrayIcon';
      kind: 'sf' | 'emoji';
      value: string;
      dir: string;
    }
  | {
      id: string;
      op: 'view.attach';
      view: string;
      target: string;
      x: number;
      y: number;
      width: number;
      height: number;
      autoresize?: boolean;
    };

/** The same union with the transport-assigned `id` removed, distributed over every variant. */
type NativeCall = NativeWireRequest extends infer Request
  ? Request extends NativeWireRequest
    ? Omit<Request, 'id'>
    : never
  : never;

export type NativeWireResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; code: string; error: string };

/** Serializes one request. Kept separate from the transport so tests never load the dylib. */
export function encodeNativeRequest(request: NativeWireRequest): string {
  return JSON.stringify(request);
}

/**
 * Parses one response and enforces the framing the Swift entry point promises: an object, a string
 * `id` (equal to the request's when given), a boolean `ok`, and either `result` (which may be null)
 * or a `code`/`error` pair.
 */
export function decodeNativeResponse(raw: string, expectedId?: string): NativeWireResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NativeError('protocol', 'native response is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new NativeError('protocol', 'native response is not an object');
  }
  const response = parsed as Record<string, unknown>;
  if (typeof response.id !== 'string') {
    throw new NativeError('protocol', 'native response has no string id');
  }
  if (expectedId !== undefined && response.id !== expectedId) {
    throw new NativeError(
      'protocol',
      `native response id ${response.id} does not match ${expectedId}`,
    );
  }
  if (typeof response.ok !== 'boolean') {
    throw new NativeError('protocol', 'native response has no boolean ok');
  }
  if (response.ok) {
    if (!('result' in response)) {
      throw new NativeError('protocol', 'native success response has no result');
    }
    return { id: response.id, ok: true, result: response.result };
  }
  if (typeof response.code !== 'string' || typeof response.error !== 'string') {
    throw new NativeError('protocol', 'native failure response has no code/error');
  }
  return { id: response.id, ok: false, code: response.code, error: response.error };
}

/** Extensions without a leading dot, trimmed, de-duplicated, empty entries dropped. */
export function normalizeDialogTypes(types: readonly string[] | undefined): string[] {
  if (!types) return [];
  const seen = new Set<string>();
  for (const raw of types) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    seen.add(trimmed.startsWith('.') ? trimmed.slice(1) : trimmed);
  }
  return [...seen];
}

// MARK: - Native loading

type RequestFn = (request: string) => string;

interface LoadedBridge {
  readonly path: string;
  readonly request: RequestFn;
}

let cached: LoadedBridge | null = null;

function candidates(explicit?: string): string[] {
  if (explicit) return [resolve(explicit)];
  const fromExecutable = resolve(
    dirname(process.execPath),
    '..',
    'Resources',
    'app',
    'native',
    'libNodNative.dylib',
  );
  const fromBundledModule = resolve(import.meta.dir, '..', 'native', 'libNodNative.dylib');
  const fromSourceModule = resolve(
    import.meta.dir,
    '..',
    '..',
    'native',
    'build',
    'libNodNative.dylib',
  );
  const fromCwd = resolve(process.cwd(), 'electrobun/native/build/libNodNative.dylib');
  return [fromExecutable, fromBundledModule, fromSourceModule, fromCwd];
}

function loadBridge(explicit?: string): LoadedBridge | null {
  if (cached && (!explicit || cached.path === resolve(explicit))) return cached;
  for (const path of candidates(explicit)) {
    if (!existsSync(path)) continue;
    try {
      const library = dlopen(path, {
        nodnative_request: { args: [FFIType.cstring], returns: FFIType.cstring },
      });
      const symbol = library.symbols.nodnative_request as unknown as (
        request: string
      ) => string | null;
      const request: RequestFn = (input) => {
        const raw = symbol(input);
        if (typeof raw !== 'string') {
          throw new NativeError('transport', 'native bridge returned no response');
        }
        return raw;
      };
      cached = { path, request };
      return cached;
    } catch {
      // Try the next candidate; a missing/incompatible dylib degrades to `available: false` instead
      // of taking the app down at import time.
    }
  }
  return null;
}

// MARK: - Core view symbols (docked tabs)

/** A rect in the unit `createWebview`/`resizeWebview` take: top-left, view coordinates. */
export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One direct child of a window's content view, as the AppKit tree reports it. */
export interface ViewListing {
  /** Decimal string of the AppKit object pointer — what `attachView` takes. */
  ptr: string;
  /** The WKWebView's URL when the child contains one. */
  url: string | null;
  className: string;
  hidden: boolean;
}

/**
 * Electrobun 2.0.4 has no `BrowserView.setFrame`/`setHidden`: geometry and visibility of a
 * main-process view are only reachable through the core's own `resizeWebview`/`webviewSetHidden`
 * symbols (measured in `docs/handovers/e06-view-spike.md` §1; both hit the live view table because
 * dyld dedupes the already-loaded dylib by path). They are bound here, next to the JSON bridge.
 */
export interface CoreViewOps {
  /** Places a view inside its current content view (top-left rect). */
  resize(viewId: number, rect: NativeRect): boolean;
  /** Hides/shows a view without a reload (`timeOrigin` unchanged, measured). */
  setHidden(viewId: number, hidden: boolean): boolean;
}

type CoreResizeFn = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  masks: unknown,
) => void;

interface CoreViewBridge extends CoreViewOps {
  readonly path: string;
}

let cachedCore: CoreViewBridge | null | undefined;

/** `[]` masks: the core's own default when the devkit forwards no mask list. */
const MASK_LIST = Buffer.from('[]\u0000', 'utf8');

function loadCoreViews(): CoreViewBridge | null {
  if (cachedCore !== undefined) return cachedCore;
  cachedCore = null;
  // The two places the devkit itself loads the core from (`proc/native.ts`'s candidate list).
  const fileName = `libElectrobunCore.${process.platform === 'darwin' ? 'dylib' : 'so'}`;
  const candidates = [resolve(process.cwd(), fileName)];
  if (process.argv0) candidates.push(resolve(dirname(process.argv0), fileName));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const library = dlopen(path, {
        resizeWebview: {
          args: [FFIType.u32, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.cstring],
          returns: FFIType.void,
        },
        webviewSetHidden: {
          args: [FFIType.u32, FFIType.bool],
          returns: FFIType.void,
        },
      });
      const resize = library.symbols.resizeWebview as unknown as CoreResizeFn;
      const setHidden = library.symbols.webviewSetHidden as unknown as (
        id: number,
        hidden: boolean,
      ) => void;
      cachedCore = {
        path,
        resize(viewId, rect) {
          try {
            resize(viewId, rect.x, rect.y, rect.width, rect.height, MASK_LIST);
            return true;
          } catch {
            return false;
          }
        },
        setHidden(viewId, hidden) {
          try {
            setHidden(viewId, hidden);
            return true;
          } catch {
            return false;
          }
        },
      };
      break;
    } catch {
      // Try the next candidate; without the core a docked tab degrades to a plain window.
    }
  }
  return cachedCore;
}

// MARK: - Facade

/** Structurally `TinySecrets` (`backend/tiny.d.ts`), without importing the ambient declaration. */
export interface NativeSecrets {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<boolean>;
  delete(account: string): Promise<boolean>;
}

export interface NativeAvailability {
  secrets: boolean;
  authenticate: boolean;
  icon: boolean;
  dialogs: boolean;
}

export interface NativeFacade {
  readonly secrets: NativeSecrets;
  readonly available: NativeAvailability;
  /** `deviceOwnerAuthentication` (Touch ID or the account password); false covers cancel. */
  authenticate(reason?: string): Promise<boolean>;
  canAuthenticate(): Promise<boolean>;
  /** `''` restores the bundle icon. Synchronous and never throws: false means "not applied". */
  setIcon(path: string): boolean;
  openFile(options?: { types?: readonly string[]; title?: string }): Promise<string | null>;
  saveFile(options?: {
    name?: string;
    types?: readonly string[];
    title?: string;
  }): Promise<string | null>;
  /** Runtime chrome toggle for `BrowserWindow.ptr`; true when the main queue accepted the change. */
  setWindowFrame(target: number | bigint, frame: boolean): boolean;
  /** Page-box size floor for `BrowserWindow.ptr`; true when the main queue accepted the change. */
  setContentMinSize(target: number | bigint, width: number, height: number): boolean;
  /** The window's content-view children (its webviews), from the live AppKit tree. */
  listViews(target: number | bigint | string): ViewListing[] | null;
  /**
   * Moves a live view into a window's content view at a top-left rect. `autoresize` makes it follow
   * the window's content size (a detached tab); a docked tab is placed by the facade instead.
   */
  attachView(
    view: string,
    target: number | bigint | string,
    rect: NativeRect,
    autoresize?: boolean,
  ): boolean;
  /** The core's `resizeWebview` (top-left rect inside the view's current content view). */
  resizeView(viewId: number, rect: NativeRect): boolean;
  /** The core's `webviewSetHidden` (page stays alive, no reload). */
  setViewHidden(viewId: number, hidden: boolean): boolean;
  /** The URL of a view's top document, read from the live WKWebView; null when unavailable. */
  viewUrl(view: string): string | null;
  /** `NSApp.hide`: puts every window away and returns focus to the previous app. */
  hideApp(): boolean;
  /**
   * Opts the process in/out of macOS automatic and sudden termination. Armed while `main` hides on
   * close (tray), released on a real quit; true when the main queue took the change.
   */
  setTerminationHold(enabled: boolean): boolean;
  /**
   * Draws an `sf:`/`emoji:` tray icon to a PNG under `dir` and answers its path. Null when the
   * helper is unavailable or the spec cannot be drawn, so the caller can keep the bundled png.
   */
  renderTrayIcon(spec: TrayIconSpec, dir: string): string | null;
}

export interface NativeOptions {
  /** Keychain service; the native side defaults to the running bundle's identifier. */
  identifier?: string;
  /** Explicit dylib path; by default it is resolved beside the executable and in the repo. */
  libraryPath?: string;
}

/** The sheet is system UI; a person may take a while, but not forever. */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_POLL_MS = 100;

const UNAVAILABLE: NativeAvailability = Object.freeze({
  secrets: false,
  authenticate: false,
  icon: false,
  dialogs: false,
});

/** The `authenticate.begin` answer: a token to poll, or an immediate negative. */
function parseAuthStart(value: unknown): { token: string | null; result: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NativeError('protocol', 'authenticate.begin returned no object');
  }
  const { token, result } = value as { token?: unknown; result?: unknown };
  if (token !== null && typeof token !== 'string') {
    throw new NativeError('protocol', 'authenticate.begin returned no token');
  }
  return { token: typeof token === 'string' && token.length > 0 ? token : null, result: result === true };
}

function parseAuthPoll(value: unknown): { status: 'pending' | 'done'; result: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NativeError('protocol', 'authenticate.poll returned no object');
  }
  const { status, result } = value as { status?: unknown; result?: unknown };
  if (status !== 'pending' && status !== 'done') {
    throw new NativeError('protocol', 'authenticate.poll returned no status');
  }
  return { status, result: result === true };
}

export function createNative(options: NativeOptions = {}): NativeFacade {
  const bridge = process.platform === 'darwin' ? loadBridge(options.libraryPath) : null;
  let counter = 0;
  const prefix = Math.random().toString(36).slice(2, 8);

  const call = (request: NativeCall): unknown => {
    if (!bridge) throw new NativeError('unavailable', 'native library is not loaded');
    const id = `${prefix}-${++counter}`;
    const response = decodeNativeResponse(
      bridge.request(encodeNativeRequest({ ...request, id } as NativeWireRequest)),
      id,
    );
    if (!response.ok) throw new NativeError(response.code, response.error);
    return response.result;
  };

  const keychain = (account: string): { service?: string; account: string } => {
    if (typeof account !== 'string' || account.length === 0) {
      throw new NativeError('invalid', 'account must be a non-empty string');
    }
    return options.identifier ? { service: options.identifier, account } : { account };
  };

  const secrets: NativeSecrets = {
    async get(account) {
      if (!bridge) return null;
      const value = call({ op: 'keychain.get', ...keychain(account) });
      return typeof value === 'string' ? value : null;
    },
    async set(account, value) {
      if (!bridge) return false;
      if (typeof value !== 'string') throw new NativeError('invalid', 'value must be a string');
      return call({ op: 'keychain.set', ...keychain(account), value }) === true;
    },
    async delete(account) {
      if (!bridge) return false;
      return call({ op: 'keychain.delete', ...keychain(account) }) === true;
    },
  };

  const canAuthenticate = async (): Promise<boolean> => {
    if (!bridge) return false;
    return call({ op: 'canAuthenticate' }) === true;
  };

  let availability: NativeAvailability;
  if (!bridge) {
    availability = UNAVAILABLE;
  } else {
    availability = Object.freeze({
      secrets: true,
      authenticate: call({ op: 'canAuthenticate' }) === true,
      icon: true,
      dialogs: true,
    });
  }

  return {
    secrets,
    available: availability,
    canAuthenticate,
    async authenticate(reason = 'Confirm your identity') {
      if (!bridge) return false;
      const started = parseAuthStart(call({ op: 'authenticate.begin', reason }));
      if (!started.token) return started.result;
      const token = started.token;
      const deadline = Date.now() + AUTH_TIMEOUT_MS;
      try {
        while (Date.now() < deadline) {
          const polled = parseAuthPoll(call({ op: 'authenticate.poll', token }));
          if (polled.status === 'done') return polled.result;
          const { promise, resolve: wake } = Promise.withResolvers<void>();
          setTimeout(wake, AUTH_POLL_MS);
          await promise;
        }
      } finally {
        // Drops the LAContext even when the poll threw. A completed token is already gone, so this is
        // a no-op then.
        try {
          call({ op: 'authenticate.cancel', token });
        } catch {
          // best effort
        }
      }
      return false;
    },
    setIcon(path) {
      if (!bridge) return false;
      try {
        call({ op: 'setAppIcon', path });
        return true;
      } catch {
        return false;
      }
    },
    async openFile(opts = {}) {
      if (!bridge) return null;
      const types = normalizeDialogTypes(opts.types);
      const result = call({
        op: 'openFile',
        ...(types.length > 0 ? { types } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      });
      return typeof result === 'string' ? result : null;
    },
    async saveFile(opts = {}) {
      if (!bridge) return null;
      const types = normalizeDialogTypes(opts.types);
      const result = call({
        op: 'saveFile',
        ...(types.length > 0 ? { types } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      });
      return typeof result === 'string' ? result : null;
    },
    setWindowFrame(target, frame) {
      if (!bridge) return false;
      try {
        return call({ op: 'setWindowFrame', target: String(target), frame }) === true;
      } catch {
        return false;
      }
    },
    setContentMinSize(target, width, height) {
      if (!bridge) return false;
      try {
        return call({ op: 'setContentMinSize', target: String(target), width, height }) === true;
      } catch {
        return false;
      }
    },
    listViews(target) {
      if (!bridge) return null;
      try {
        const result = call({ op: 'views.list', target: String(target) });
        if (!Array.isArray(result)) return null;
        const list: ViewListing[] = [];
        for (const entry of result) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const ptr = record.ptr;
          if (typeof ptr !== 'string' || ptr === '') continue;
          const url = typeof record.url === 'string' && record.url !== '' ? record.url : null;
          list.push({
            ptr,
            url,
            className: typeof record.class === 'string' ? record.class : '',
            hidden: record.hidden === true,
          });
        }
        return list;
      } catch {
        return null;
      }
    },
    attachView(view, target, rect, autoresize = false) {
      if (!bridge || view === '') return false;
      try {
        return (
          call({
            op: 'view.attach',
            view,
            target: String(target),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            autoresize,
          }) === true
        );
      } catch {
        return false;
      }
    },
    viewUrl(view) {
      if (!bridge || view === '') return null;
      try {
        const result = call({ op: 'view.url', view });
        return typeof result === 'string' && result !== '' ? result : null;
      } catch {
        return null;
      }
    },
    hideApp() {
      if (!bridge) return false;
      try {
        return call({ op: 'hideApp' }) === true;
      } catch {
        return false;
      }
    },
    setTerminationHold(enabled) {
      if (!bridge) return false;
      try {
        return call({ op: 'setTerminationHold', enabled: enabled === true }) === true;
      } catch {
        return false;
      }
    },
    renderTrayIcon(spec, dir) {
      if (!bridge || dir === '') return null;
      try {
        const result = call({
          op: 'renderTrayIcon',
          kind: spec.kind,
          value: spec.value,
          dir,
        });
        return typeof result === 'string' && result !== '' ? result : null;
      } catch {
        return null;
      }
    },
    resizeView(viewId, rect) {
      return loadCoreViews()?.resize(viewId, rect) ?? false;
    },
    setViewHidden(viewId, hidden) {
      return loadCoreViews()?.setHidden(viewId, hidden) ?? false;
    },
  };
}
