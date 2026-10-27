// The Electrobun target's `TinyApp`: the object `backend/main.ts` receives from `init(app)`.
//
// Composition only (contract `e06-parity.md`, row "electrobun/bun/facade/app.ts"):
//   - windows (`app.win`, `app.window`, `app.screens`)      -> facade/windows.ts  (Windows)
//   - secrets / authenticate / icon                        -> facade/native.ts   (Native)
//   - update.check / update.install                        -> facade/update.ts   (Update)
//   - store (JSON at the data dir, atomic write)           -> ./store
//   - tray / hotkeys / deep links / paths / info / push / quit -> this file over the devkit
//
// The devkit is loaded lazily in `electrobunRuntime()` so this module stays importable by a plain
// `bun test` (the gate and accelerator-mapping tests do exactly that).
//
// Parity rows: A1–A11, A18–A26, E2–E3, E9–E13 (`docs/handovers/e06-tinyjs-surface.md`).

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { MenuItemConfig, Tray } from 'electrobun/bun';
import { createStore, type Store } from './store';
import { parseTrayIconSpec, type TrayIconSpec } from './tray-icon';

/** The pieces of `TinyApp` windows.ts returns. Structurally identical to `WindowFacade` there. */
export interface AppWindows {
  win: TinyApp['win'];
  window(id: string): TinyWindowHandle;
  screens(): Promise<TinyScreen[]>;
}

/** The native client's surface (`facade/native.ts`). */
export interface AppNative {
  secrets: TinySecrets;
  authenticate(reason?: string): Promise<boolean>;
  setIcon(path: string): boolean;
  /**
   * Draws an `sf:`/`emoji:` tray icon to a png under `dir`; null when the helper is unavailable or
   * the spec cannot be drawn, in which case the bundled `tray.png` stands in.
   */
  renderTrayIcon?(spec: TrayIconSpec, dir: string): string | null;
  available: { secrets: boolean; authenticate: boolean; icon: boolean; dialogs: boolean };
}

/** The update facade's surface (`facade/update.ts`). */
export interface AppUpdate {
  check(): Promise<{
    available: boolean;
    current: string;
    latest: string | null;
    notes: string | null;
  }>;
  install(): Promise<boolean>;
  /** Why the last `install()` refused, for the backend's `update` event (not part of `TinyApp`). */
  refusal(): string | null;
}

/** Tray menu entry after the translation to the devkit's shape. */
export interface TrayMenuEntry {
  label: string;
  action: string;
}

export interface TrayCreateSpec {
  title: string;
  image: string;
  menu: Array<TrayMenuEntry | 'separator'>;
}

/**
 * The OS pieces app.ts needs. The default implementation is `electrobunRuntime()` below; a test or
 * a different host can inject its own without the devkit.
 */
export interface RuntimeBindings {
  available: { tray: boolean; hotkey: boolean };
  tray: {
    create(spec: TrayCreateSpec, onSelect: (id: string) => void): boolean;
    bounds(): Promise<{ x: number; y: number; width: number; height: number } | null>;
    remove(): void;
  };
  shortcuts: {
    register(accelerator: string, handler: () => void): boolean;
    unregister(accelerator: string): void;
  };
  /** Native clipboard (`NSPasteboard` through the devkit's `Utils`). */
  clipboard: {
    readText(): string | null;
    writeText(text: string): void;
    readImage(): Uint8Array | null;
    writeImage(png: Uint8Array): void;
    clear(): void;
    formats(): string[];
  };
  /** End the process with the devkit's graceful quit (native cleanup, before-quit hooks). */
  quit(): void;
  /** `open-url` from LaunchServices (`nod://…`); fires only in a packaged/blessed `.app`. */
  onOpenUrl(handler: (url: string) => void): void;
}

/** Where the app's directories are; `userData` is keyed by the build identifier. */
export interface AppPathsInput {
  userData: string;
  home: string;
  cache: string;
  logs: string;
  temp: string;
  downloads: string;
  desktop: string;
  documents: string;
}

export interface AppHooks {
  onTray?: (id: string) => void;
  onHotkey?: (id: string) => void;
  onOpenUrl?: (url: string) => void;
}

export interface AppDeps {
  /** The build identifier (`copland.nod.eb-dev`, …); never used to reach app data of another id. */
  identifier: string;
  /** Version of the running build (`app.json`'s `version`, injected by the build). */
  version: string;
  /** Runtime label for `info().runtime`, e.g. `Electrobun 2.0.4`. */
  runtime: string;
  os: 'macos' | 'windows' | 'linux';
  arch: string;
  /** resources dir (seed, tray.png, stamp) or `null`. */
  resources: string | null;
  executables?: string | null;
  paths: AppPathsInput;
  /** Push one event to the main window's bridge (never to tool views). */
  send(event: string, data: unknown): void;
  /** The host's quit; defaults to the devkit's `Utils.quit`. */
  quit?: () => void;
  hooks: AppHooks;
  windows: AppWindows;
  native: AppNative;
  update: AppUpdate;
  /** Test/host seam; defaults to the Electrobun devkit. */
  bindings?: RuntimeBindings;
}

// ---------------------------------------------------------------- accelerator mapping

const MODIFIERS: Record<string, string> = {
  cmd: 'Command',
  command: 'Command',
  meta: 'Command',
  super: 'Command',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Option',
  option: 'Option',
  shift: 'Shift',
};

const NAMED_KEYS: Record<string, string> = {
  backspace: 'Backspace',
  delete: 'Delete',
  down: 'Down',
  end: 'End',
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  home: 'Home',
  left: 'Left',
  minus: '-',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  plus: '+',
  return: 'Return',
  right: 'Right',
  space: 'Space',
  tab: 'Tab',
  up: 'Up',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '`': 'Backquote',
};

/**
 * `shared/shortcuts.ts`'s combos (`cmd+shift+d`, `ctrl+tab`, `cmd+1`, …) to the accelerator syntax
 * the devkit's `GlobalShortcut` accepts (Electron-style: `Command+Shift+D`, `Control+Tab`).
 * `null` for anything this runtime cannot register — never a guess.
 */
export function toAccelerator(combo: string): string | null {
  const parts = combo
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => part.trim());
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  if (key === '') return null;
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part];
    if (modifier === undefined) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  if (modifiers.length === 0) return null;

  let acceleratorKey: string;
  if (NAMED_KEYS[key] !== undefined) acceleratorKey = NAMED_KEYS[key];
  else if (/^[a-z0-9]$/.test(key)) acceleratorKey = key.toUpperCase();
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) acceleratorKey = key.toUpperCase();
  else return null;

  return [...modifiers, acceleratorKey].join('+');
}

// ---------------------------------------------------------------- tray

/**
 * Tray image path. `sf:`/`emoji:` specs are drawn by the native helper to a png in the app's cache
 * (tinyjs renders the same 18 pt symbol/glyph); the bundled `tray.png` stands in when the helper is
 * unavailable or the symbol is unknown. Plain names stay relative to the resources dir.
 */
export function trayImage(
  icon: string | undefined,
  resources: string | null,
  render?: (spec: TrayIconSpec) => string | null,
): string {
  if (icon === undefined || icon === '') return '';
  const spec = parseTrayIconSpec(icon);
  if (spec !== null) {
    let rendered: string | null = null;
    if (render !== undefined) {
      try {
        rendered = render(spec);
      } catch {
        rendered = null;
      }
    }
    if (rendered !== null && rendered !== '') return rendered;
    return resources === null ? '' : `${resources}/tray.png`;
  }
  if (icon.startsWith('/') || icon.startsWith('views://')) return icon;
  return resources === null ? icon : `${resources}/${icon}`;
}

function trayMenu(spec: TinyTraySpec): Array<TrayMenuEntry | 'separator'> {
  const menu: Array<TrayMenuEntry | 'separator'> = [];
  for (const item of spec.menu ?? []) {
    if ('separator' in item && item.separator === true) {
      menu.push('separator');
      continue;
    }
    const entry = item as TinyMenuItem;
    if (entry.id === undefined || entry.id === '') continue;
    menu.push({ label: entry.label ?? entry.id, action: entry.id });
  }
  return menu;
}

// ---------------------------------------------------------------- app

/** Build the `TinyApp` the backend sees. Resolves once the store is loaded and `open-url` armed. */
export async function createApp(deps: AppDeps): Promise<TinyApp> {
  const bindings = deps.bindings ?? (await electrobunRuntime());
  const paths = deps.paths;
  const store: Store = createStore(`${paths.userData}/store.json`);
  const clipboard = createClipboard(bindings.clipboard, paths.temp);

  const registeredHotkeys = new Map<string, string>();
  const trayBindings = bindings.tray;

  bindings.onOpenUrl((url) => {
    const hook = deps.hooks.onOpenUrl;
    if (hook === undefined || url === '') return;
    try {
      hook(url);
    } catch {
      // A malformed link is the backend's to refuse; it must not reach the window server.
    }
  });

  const data: TinyPaths = {
    resources: deps.resources,
    executables: deps.executables ?? null,
    home: paths.home,
    data: paths.userData,
    cache: paths.cache,
    logs: paths.logs,
    temp: paths.temp,
    downloads: paths.downloads,
    desktop: paths.desktop,
    documents: paths.documents,
  };

  // `app.paths` and `app.info` are callables that also carry the pre-0.57.0 object form.
  const pathsFn = Object.assign(async (): Promise<TinyPaths> => ({ ...data }), { ...data });
  const info: TinyAppInfo = { version: deps.version, tinyjs: 'electrobun', runtime: deps.runtime };
  const infoFn = Object.assign(async (): Promise<TinyAppInfo> => ({ ...info }), { ...info });

  const capabilities = async (): Promise<Record<string, boolean | string>> => ({
    authenticate: deps.native.available.authenticate,
    // 0.7.0, Nod-specific key: `authenticate` stays on (the gate may ask the system prompt), but
    // it never backs a session unlock here — the Electrobun `bun` binary is signed with Bun's
    // Developer ID (team 7FRXF46ZSN), so the keychain lets ANY Electrobun app on the machine read
    // `nod.bio.<person>` without a prompt (`docs/handovers/e07-migration.md` §5). macOS 0.7.0
    // therefore unlocks by password only and keeps no vault key in the keychain.
    biometricUnlock: false,
    hotkey: bindings.available.hotkey,
    tray: bindings.available.tray,
    icon: deps.native.available.icon,
  });

  const app = {
    push(event: string, payload?: unknown): void {
      try {
        deps.send(event, payload);
      } catch {
        // The main window may not be attached yet; an event is not worth a crash (tinyjs drops it).
      }
    },
    quit(): void {
      try {
        if (deps.quit !== undefined) deps.quit();
        else bindings.quit();
      } catch {
        // A host whose quit failed still must not keep the backend alive; last resort.
        process.exit(0);
      }
    },
    paths: pathsFn,
    info: infoFn,
    icon(path: string): boolean {
      if (!deps.native.available.icon) return false;
      try {
        return deps.native.setIcon(path);
      } catch {
        return false;
      }
    },
    store: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
      delete: (key: string) => store.delete(key),
      all: () => store.all(),
    },
    secrets: deps.native.secrets,
    clipboard,
    async authenticate(reason?: string): Promise<boolean> {
      if (!deps.native.available.authenticate) return false;
      try {
        return await deps.native.authenticate(reason);
      } catch {
        return false;
      }
    },
    system: {
      os: () => deps.os,
      isMacOS: () => deps.os === 'macos',
      isWindows: () => deps.os === 'windows',
      isLinux: () => deps.os === 'linux',
      info: async (): Promise<TinySystemInfo> => ({
        os: deps.os,
        arch: deps.arch,
        session: null,
        desktop: null,
      }),
      architecture: async () => deps.arch,
      capabilities,
      requirements: async () => [],
      missing: async () => [],
      battery: async () => null,
      wifi: async () => null,
      idleTime: async () => 0,
      locale: async () => null,
    },
    tray: {
      set(spec: TinyTraySpec): void {
        if (!bindings.available.tray) return;
        try {
          const created = trayBindings.create(
            {
              title: spec.title ?? '',
              image: trayImage(spec.icon, deps.resources, (icon) =>
                deps.native.renderTrayIcon === undefined
                  ? null
                  : deps.native.renderTrayIcon(icon, paths.cache),
              ),
              menu: trayMenu(spec),
            },
            (id) => {
              try {
                deps.hooks.onTray?.(id);
              } catch {
                // Tray clicks are fire-and-forget.
              }
            },
          );
          // A tray that could not be created must not look like one: `setTray` would otherwise arm
          // hide-on-close and a Linux desktop without AppIndicator would have no way back. The
          // backend catches this and keeps closing = quitting (RF-15).
          if (!created) throw new Error('system tray is unavailable');
        } catch {
          throw new Error('system tray is unavailable');
        }
      },
      remove(): void {
        try {
          trayBindings.remove();
        } catch {
          // Already gone.
        }
      },
      async position() {
        try {
          return await trayBindings.bounds();
        } catch {
          return null;
        }
      },
    },
    hotkey: {
      register(id: string, combo: string): void {
        if (!bindings.available.hotkey) throw new Error('global hotkeys are unavailable');
        const accelerator = toAccelerator(combo);
        if (accelerator === null) throw new Error(`unsupported hotkey "${combo}"`);
        if (registeredHotkeys.has(id)) return;
        const ok = bindings.shortcuts.register(accelerator, () => {
          try {
            deps.hooks.onHotkey?.(id);
          } catch {
            // A hotkey handler failing must not kill the shortcut.
          }
        });
        if (!ok) throw new Error(`hotkey "${combo}" is already taken`);
        registeredHotkeys.set(id, accelerator);
      },
      unregister(id: string): void {
        const accelerator = registeredHotkeys.get(id);
        if (accelerator === undefined) return;
        registeredHotkeys.delete(id);
        try {
          bindings.shortcuts.unregister(accelerator);
        } catch {
          // Already released.
        }
      },
    },
    update: {
      check: () => deps.update.check(),
      install: () => deps.update.install(),
      refusal: () => deps.update.refusal(),
    },
    win: deps.windows.win,
    window(id: string): TinyWindowHandle {
      return deps.windows.window(id);
    },
    screens(): Promise<TinyScreen[]> {
      return deps.windows.screens();
    },
  };

  // The full `TinyApp` surface is much wider than the Nod uses (the inventory lists ~60 members);
  // the backend only reaches what is above (`docs/handovers/e06-tinyjs-surface.md` A–E).
  return app as unknown as TinyApp;
}

// ---------------------------------------------------------------- clipboard

/** PNG dimensions from the IHDR chunk; `null` when the bytes are not a PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  // 89 50 4E 47 0D 0A 1A 0A, then the IHDR length+type at 8..16, width at 16 and height at 20.
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A png path, a `data:` URL or raw base64, as `TinyClipboardWrite.image` allows. */
function decodeImage(source: string): Uint8Array | null {
  try {
    if (source.startsWith('data:')) {
      const comma = source.indexOf(',');
      if (comma < 0) return null;
      return Uint8Array.from(atob(source.slice(comma + 1)), (char) => char.charCodeAt(0));
    }
    if (source.startsWith('/') || source.startsWith('~')) {
      return new Uint8Array(readFileSync(source));
    }
    return Uint8Array.from(atob(source), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

/**
 * `app.clipboard` (backend `TinyApp`, A-level surface the inventory missed): the backend's one call
 * site is `vault.copy` -> `write({ text })`, so text is the path that matters. The devkit exposes
 * read/write text, read/write image, clear and available formats — no HTML, files, colour or
 * NSPasteboard change count — so those fields answer null/false and `changeCount` is the count this
 * facade observed (its own writes plus the changes `watch()` noticed), not the system counter.
 */
function createClipboard(
  native: RuntimeBindings['clipboard'],
  tempDir: string,
): TinyApp['clipboard'] {
  let changes = 0;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let lastText: string | null = null;
  let lastImage: Uint8Array | null = null;
  let tempCounter = 0;

  const readText = (): string | null => {
    try {
      return native.readText();
    } catch {
      return null;
    }
  };
  const readImage = (): Uint8Array | null => {
    try {
      return native.readImage();
    } catch {
      return null;
    }
  };
  const formats = (): string[] => {
    try {
      return native.formats();
    } catch {
      return [];
    }
  };

  return {
    async read(): Promise<TinyClipboardData> {
      const available = formats();
      const text = readText();
      const bytes = readImage();
      let image: string | null = null;
      if (bytes !== null) {
        image = `${tempDir}/clipboard-${process.pid}-${tempCounter++}.png`;
        try {
          await writeFile(image, bytes);
        } catch {
          image = null;
        }
      }
      const kind: TinyClipboardData['kind'] =
        available.includes('files') ? 'files' : bytes !== null ? 'image' : text !== null ? 'text' : 'empty';
      return {
        kind,
        changeCount: changes,
        text,
        html: null,
        paths: [],
        image,
        imageSize: bytes === null ? null : pngSize(bytes),
        color: null,
        concealed: false,
        sourceApp: null,
        sourceURL: null,
      };
    },
    write(data: TinyClipboardWrite): boolean {
      try {
        if (typeof data.text === 'string') {
          native.writeText(data.text);
          changes += 1;
          return true;
        }
        if (typeof data.image === 'string' && data.image !== '') {
          const bytes = decodeImage(data.image);
          if (bytes === null) return false;
          native.writeImage(bytes);
          changes += 1;
          return true;
        }
        // HTML, files and colour have no writer in the devkit; a silent success would lie.
        return false;
      } catch {
        return false;
      }
    },
    async changeCount(): Promise<number> {
      return changes;
    },
    watch(intervalMs?: number): true {
      if (watchTimer !== null) return true;
      lastText = readText();
      lastImage = readImage();
      watchTimer = setInterval(() => {
        const text = readText();
        const bytes = readImage();
        if (text !== lastText || !sameBytes(bytes, lastImage)) {
          changes += 1;
          lastText = text;
          lastImage = bytes;
        }
      }, Math.max(100, intervalMs ?? 500));
      return true;
    },
    unwatch(): true {
      if (watchTimer !== null) {
        clearInterval(watchTimer);
        watchTimer = null;
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- devkit runtime

/** Electrobun events carry their payload in `.data`; some emitters pass it bare. */
function eventData(event: unknown): Record<string, unknown> | null {
  if (event === null || typeof event !== 'object') return null;
  const payload: unknown = 'data' in event ? event.data : event;
  if (payload === null || typeof payload !== 'object') return null;
  return payload as Record<string, unknown>;
}

/**
 * The default `RuntimeBindings`, over the projected devkit. Loaded dynamically so a unit test can
 * import this file without `.hutch/` existing.
 */
export async function electrobunRuntime(): Promise<RuntimeBindings> {
  // Static import is impossible here: the devkit is projected into `.hutch/devkit` by the
  // `electrobun` CLI and does not exist for a plain `bun test` (this module is imported by the gate
  // tests for `toAccelerator`). The specifier is fixed, not runtime-selected.
  const eb = await import('electrobun/bun');

  let tray: Tray | null = null;

  return {
    available: { tray: true, hotkey: true },
    tray: {
      create(spec, onSelect) {
        try {
          if (tray !== null) {
            tray.remove();
            tray = null;
          }
          const created = new eb.Tray({
            title: spec.title,
            image: spec.image,
            template: true,
          });
          tray = created;
          const menu: MenuItemConfig[] = spec.menu.map((entry) =>
            entry === 'separator'
              ? { type: 'divider' }
              : { type: 'normal', label: entry.label, action: entry.action },
          );
          created.setMenu(menu);
          created.on('tray-clicked', (event: unknown) => {
            const data = eventData(event);
            const action = data !== null ? data.action : undefined;
            const fallback = data !== null ? data.id : undefined;
            const id = typeof action === 'string' && action !== '' ? action : String(fallback ?? '');
            if (id !== '') onSelect(id);
          });
          return created.visible;
        } catch {
          tray = null;
          return false;
        }
      },
      async bounds() {
        if (tray === null) return null;
        return tray.getBounds();
      },
      remove() {
        if (tray === null) return;
        tray.remove();
        tray = null;
      },
    },
    shortcuts: {
      register(accelerator, handler) {
        return eb.GlobalShortcut.register(accelerator, handler);
      },
      unregister(accelerator) {
        eb.GlobalShortcut.unregister(accelerator);
      },
    },
    clipboard: {
      readText: () => eb.Utils.clipboardReadText(),
      writeText: (text) => eb.Utils.clipboardWriteText(text),
      readImage: () => eb.Utils.clipboardReadImage(),
      writeImage: (png) => eb.Utils.clipboardWriteImage(png),
      clear: () => eb.Utils.clipboardClear(),
      formats: () => eb.Utils.clipboardAvailableFormats(),
    },
    quit() {
      void eb.Utils.quit();
    },
    onOpenUrl(handler) {
      // The default export carries `events` (the named exports do not). The devkit's
      // `ElectrobunEventEmitter` declaration omits `on` even though its own sources call it, so the
      // listener surface is named once here instead of sprinkled as inline accesses.
      const events = eb.default.events as unknown as {
        on(name: string, handler: (event: unknown) => void): void;
      };
      events.on('open-url', (event: unknown) => {
        const data = eventData(event);
        if (data !== null && typeof data.url === 'string') handler(data.url);
      });
    },
  };
}
