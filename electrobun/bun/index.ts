// Bun entrypoint of the Electrobun target. It wires the facade, the backend and the runtime hooks:
// a `TinyApp` facade, the backend (`backend/main.ts`, unchanged), the runtime hooks and the main
// window's page bridge.
//
// Order matters:
// 1. `installTjs()` before the backend module evaluates (its `tjs:sqlite` import is aliased to
//    `electrobun/bun/sqlite-shim.ts` by the generated config; the file APIs are global).
// 2. `createWindows` builds the facade but does not create the main window; the RPC and the gate
//    exist first, so the window can load the moment it is opened.
// 3. `createApp` composes the facade from the windows/native/update instances; `init(app)` boots the
//    backend, and only then `windows.win.open('main')` shows the page — the same order the tinyjs
//    runtime always took (backend ready, then the window).
//
// `NOD_APP_ID` selects the identifier (and the keychain namespace). A release build uses
// `copland.nod` (the identity the tinyjs releases wore, so an update keeps its data); a dev launch
// refuses it, and `eb:dev` sets `copland.nod.eb-dev`, so development never touches a real
// installation. The backend's data directory is the legacy one even when the identifier differs
// (facade/data-dir.ts).
//
// No secret enters this file: the keychain lives in the native helper (Native's slice), and the
// update URL comes from the bundled seed only when it shipped.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserView, BuildConfig, Session, Updater, Utils } from 'electrobun/main';
import { RESOURCES_FOLDER } from 'electrobun/main/paths';
import appConfig from '../../app.json';
import * as backend from '../../backend/main';
import { installTjs } from './tjs-shim';
import { createApp } from './facade/app';
import { bundledIdentifier, resolveDataDir } from './facade/data-dir';
import { createDownloads, DOWNLOAD_PARTITION } from './facade/downloads';
import { createGate } from './facade/gate';
import { createNative } from './facade/native';
import { createPlatformDialogs } from './facade/dialogs';
import { createUpdate } from './facade/update';
import { createRuntimeUpdate } from './facade/update-runtime';
import { createWindows } from './facade/windows';
import type { NodBridgeSchema } from '../shared-rpc';

installTjs();

const base = appConfig as Record<string, unknown>;
const build = BuildConfig.getSync();
const isDev = build.channel === 'dev';

const rawIdentifier = (process.env.NOD_APP_ID ?? '').trim();

const identifier =
  rawIdentifier === ''
    ? bundledIdentifier(process.execPath, isDev ? 'copland.nod.eb-dev' : 'copland.nod')
    : rawIdentifier;
if (isDev && identifier === 'copland.nod') {
  throw new Error('NOD_APP_ID must not be copland.nod in a dev run: use copland.nod.eb-dev');
}

const version =
  typeof base.version === 'string' && base.version.trim() !== '' ? base.version : '0.0.0';

/**
 * The backend's data directory: the tinyjs layout, so an installation updated from tinyjs keeps its
 * `nod.db`, `store.json` and icons (facade/data-dir.ts).
 */
const dataDir = resolveDataDir({
  identifier,
  electrobunUserData: Utils.paths.userData,
  platform: process.platform,
  home: homedir(),
  env: process.env,
}).dir;

/** Main window page box from `app.json` (`WxH`). */
function mainFrame(): { width: number; height: number } {
  const text = typeof base.size === 'string' ? base.size.trim() : '';
  const match = /^([0-9]+)x([0-9]+)$/.exec(text);
  if (match === null) return { width: 1100, height: 720 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** `NOD_DEV_PORT` validation shared with the dev launcher. */
function devPort(): number {
  const raw = process.env.NOD_DEV_PORT;
  if (raw === undefined) return 5173;
  const parsed = Number(raw);
  if (!/^[0-9]+$/.test(raw) || parsed < 1024 || parsed > 65535) {
    throw new Error(`invalid NOD_DEV_PORT: ${raw}`);
  }
  return parsed;
}

const port = isDev ? devPort() : 0;

/**
 * Dev-only page override (`NOD_MAIN_URL`): the smoke runners point the main window at a generated
 * driver page served by the dev server instead of the project's `index.html`. A packaged build
 * never reads it (`isDev` is false), and a non-loopback URL is refused — the gate trusts exactly
 * this origin, so it must be the development machine's own server.
 */
function devMainPage(): { url: string; origin: string } {
  const raw = (process.env.NOD_MAIN_URL ?? '').trim();
  if (raw === '') return { url: `http://127.0.0.1:${port}/`, origin: `http://127.0.0.1:${port}` };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid NOD_MAIN_URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
    throw new Error(`NOD_MAIN_URL must be a loopback http URL: ${raw}`);
  }
  return { url: parsed.href, origin: parsed.origin };
}

const mainPage = isDev ? devMainPage() : null;
const mainUrl = mainPage?.url ?? 'views://mainview/index.html';
const mainOrigin = mainPage?.origin ?? 'views://mainview';
const resources = join(RESOURCES_FOLDER, 'app', 'resources');

/** The seed's update URL, when the release shipped one (the backend applies the same seed). */
async function updateUrlFromSeed(): Promise<string | null> {
  const file = Bun.file(join(resources, 'seed.json'));
  if (!(await file.exists())) return null;
  try {
    const parsed = JSON.parse(await file.text()) as { update?: { url?: unknown } };
    const url = parsed.update?.url;
    return typeof url === 'string' && url !== '' ? url : null;
  } catch {
    // The backend validates and reports a broken seed itself; the update channel just stays off.
    return null;
  }
}

/**
 * Source of the main-window preload: the bridge view `electrobun dev|build` already compiled into
 * `Resources/app/views/bridge/index.js`. Injected at document-start, so `window.tiny` exists before
 * `src/app.ts` — on the vite dev URL and on the packaged `views://mainview/index.html` alike.
 */
async function bridgePreload(): Promise<string> {
  const file = Bun.file(join(RESOURCES_FOLDER, 'app', 'views', 'bridge', 'index.js'));
  if (!(await file.exists())) {
    throw new Error('the bridge view is missing: run `bun run eb:dev` or `bun run eb:build`');
  }
  return await file.text();
}

/** Readable message of anything the gate or a facade threw, for the page's `new Error(message)`. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

const preload = await bridgePreload();
if (isDev) console.log(`[eb] main ${identifier} ${mainUrl} preload=${preload.length}b`);
const native = createNative({
  identifier,
  // The macOS helper owns the panels; on Windows/Linux the runtime's native chooser does.
  dialogs:
    process.platform === 'darwin'
      ? undefined
      : createPlatformDialogs({ openFileDialog: Utils.openFileDialog }),
});
let app: TinyApp | null = null;

/** The facade after `createApp`; a call that arrives before it is a boot bug, not a page call. */
function requireApp(method: string): TinyApp {
  if (app === null) throw new Error(`Nod is not ready (${method})`);
  return app;
}

/**
 * Downloads from a sandboxed view (surface-check finding 10). The engine's own WKDownload cannot
 * write `~/Downloads` from a packaged Nod (`sandbox_extension_issue_file … Operation not
 * permitted`), so the preload hands a `<a download>` click to the gate under `nod.download` and this
 * service saves it: same-origin fetch with the view's session cookies, or the page's own
 * `blob:`/`data:` bytes, into `Utils.paths.downloads` with the de-dup naming the engine uses. Every
 * `done`/`failed` goes through the backend's `onDownload`, which writes the audit row.
 */
const downloads = createDownloads({
  saveDir: () => Utils.paths.downloads,
  cookieHeader(url) {
    try {
      return Session.fromPartition(DOWNLOAD_PARTITION)
        .cookies.get({ url })
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
    } catch {
      // no FFI (carrot mode) or no cookie store: the request goes out without the session
      return '';
    }
  },
  onDownload: backend.onDownload,
});

const gate = createGate({
  api: backend.api,
  app: () => requireApp('api.call'),
  appOrigins: () => [mainOrigin],
  download: downloads,
});

// The facade's `quit` must terminate the process, not call itself: `createApp` exposes this exact
// function as `TinyApp.quit`, so routing it back through `app.quit()` would recurse forever.
const quit = (): void => {
  void Utils.quit();
};

const updateUrl = await updateUrlFromSeed();
// macOS swaps the `.app` itself (sha256 + rollback helper); Windows and Linux use the runtime's
// update channel, which owns replacing an installed directory.
const update =
  process.platform === 'darwin'
    ? createUpdate({ updateUrl, version, dataDir, quit })
    : createRuntimeUpdate({ updateUrl, version, updater: Updater });

const send = (event: string, data: unknown): void => {
  try {
    mainRpc.send['api.event']({ event, data });
  } catch {
    // no main window yet (or it is closing): a push nobody can receive is not an error
  }
};

const mainRpc = BrowserView.defineRPC<NodBridgeSchema>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      async 'api.call'({ method, params }) {
        try {
          return { ok: true, result: await gate.call(method, params, { window: 'main' }) };
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
      },
      'dialog.openFile': ({ types }) => native.openFile({ types }),
      'dialog.saveFile': ({ types, name }) => native.saveFile({ types, name }),
      async 'store.set'({ key, value }) {
        return await requireApp('store.set').store.set(key, value);
      },
      'win.getState': () => requireApp('win.getState').win.getState(),
      'win.show'({ activate }) {
        requireApp('win.show').win.show(activate === false ? { activate: false } : {});
        return true;
      },
      'win.setSize'({ width, height }) {
        requireApp('win.setSize').win.setSize(width, height);
        return true;
      },
      // Smoke-only members of the page bridge. The devkit exposes the system clipboard as text
      // (read/write); the rest of `TinyClipboardData` is the empty shape it would be for text.
      'clipboard.read': () => ({
        kind: 'text' as const,
        changeCount: 0,
        text: Utils.clipboardReadText(),
        html: null,
        paths: [],
        image: null,
        imageSize: null,
        color: null,
        concealed: false,
        sourceApp: null,
        sourceURL: null,
      }),
      'clipboard.write'({ data }) {
        const text =
          typeof data === 'string' ? data : (data as { text?: unknown } | null)?.text;
        if (typeof text !== 'string') {
          throw new Error('clipboard.write: only text is supported on the Electrobun target');
        }
        Utils.clipboardWriteText(text);
        return true;
      },
      async fetch({ url, init }) {
        const headers = new Headers(init?.headers);
        const body =
          init?.body === undefined
            ? undefined
            : init.body.kind === 'text'
              ? init.body.value
              : Uint8Array.from(atob(init.body.value), (char) => char.charCodeAt(0));
        const response = await fetch(url, {
          method: init?.method,
          headers,
          body,
          redirect: init?.redirect,
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: Array.from(response.headers),
          body: btoa(binary),
        };
      },
    },
  },
});

const windows = createWindows({
  mainUrl,
  quit,
  mainRpc,
  mainPreload: preload,
  mainSize: mainFrame(),
  gate,
  native,
  popupMode: () =>
    base.popups === 'external' || base.popups === 'deny' ? base.popups : 'window',
  hooks: {
    onNavigate: backend.onNavigate,
    onWindowOpen: backend.onWindowOpen,
    onDownload: backend.onDownload,
    onWindowClosed: backend.onWindowClosed,
    onWindowState: backend.onWindowState,
    onMainOrigin: (origin, href) => gate.committed(origin, href),
  },
});

app = await createApp({
  identifier,
  version,
  runtime: 'Electrobun',
  resources,
  paths: {
    userData: dataDir,
    home: Utils.paths.home,
    cache: Utils.paths.userCache,
    logs: Utils.paths.userLogs,
    temp: Utils.paths.temp,
    downloads: Utils.paths.downloads,
    desktop: Utils.paths.desktop,
    documents: Utils.paths.documents,
  },
  os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
  arch: process.arch,
  send,
  quit,
  hooks: {
    onTray: (id) => backend.onTray(id, requireApp('tray')),
    onHotkey: backend.onHotkey,
    onOpenUrl: (url) => backend.onOpenUrl(url, requireApp('open-url')),
  },
  windows,
  native,
  update,
});

try {
  await backend.init(app);
} catch (error) {
  console.error('[eb] backend init failed', error);
  throw error;
}
if (isDev) console.log('[eb] backend ready');

// The windows facade builds the main window lazily (it must exist before `init` can size it, but
// not before the backend is ready): opening it here is the runtime's "app starts with its window".
windows.win.open('main');
