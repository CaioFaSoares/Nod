// Real-surface smoke of E03 (RF-49…RF-52, RF-66…RF-68, release 0.6.0): the real page inside
// `tinyjs dev`, a real tool window per tab, and reporting tool pages that measure themselves.
//
//   bun test/smoke/tabs.ts            # refuses when resources/seed.json exists
//   bun test/smoke/tabs.ts --force    # moves the private seed to test/smoke/.gerado/seed.json.bak
//                                     # and restores it at the end
//
// The window loads a generated page that imports `src/app.ts` exactly as `index.html` does and then
// `test/smoke/tabs-driver.ts`; `frontend.devUrl` points at that file, so `tinyjs dev` serves the real
// `http://` entry with the runtime bridge. No host process is involved: the smoke enters a **local**
// account (`session.createAccount`, no code) and the two catalog tools come from the temporary seed.
//
// The tool pages are the reporting servers of `test/smoke/tools.ts` (`startTabTools`): each page
// measures its own `window.screenX/screenY`, outer and inner box, `performance.timeOrigin` and the
// value of its `<input id=draft>`, and posts them to its own origin. The driver reads those reports
// through this runner's desk and drives the real screens with DOM events; the runner only starts the
// world, forwards commands to the pages and reads the app store.
//
// This machine runs OmniWM, a tiling window manager (`docs/handovers/e03-spikes.md` B05/§1): it
// arranges the app's windows, which is why the requested rects do not survive on their own. The
// runner floats **this run's own windows** (matched by pid, never the owner's Nod) through
// `omniwmctl window focus` + `command toggle-focused-window-floating` — no config file is touched —
// and hands the tiler's own view of the windows back to the driver, so a geometry check either
// measures a floated window or says so with numbers.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TabTools } from './tools';
import {
  appDataDir as dataDir,
  freePort,
  generateDevConfig,
  killProcessTree,
  startTabTools,
  waitForStoredResult,
} from './tools';

/** A throwaway app id: its own data dir, never the owner's `copland.nod`. */
const APP_ID = 'copland.nod.smoke-tabs';
/** Catch-all of the generated page: the driver's `EMAIL`/`NAME` are the same throwaways. */
const EMAIL = 'tabs@nod.test';
const NAME = 'Smoke Tabs';

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED_DIR = join(import.meta.dir, '.gerado');
const TABS_DIR = join(GENERATED_DIR, 'tabs');
const SEED = join(ROOT, 'resources', 'seed.json');
const SEED_BACKUP = join(GENERATED_DIR, 'seed.json.bak');
const TINYJS_JSON = join(ROOT, 'tinyjs.json');
const DRIVER_ROUTE = '/test/smoke/tabs-driver.ts';

const FINISH_TIMEOUT_MS = 240_000;
const OUTPUT_LIMIT = 4000;
/** How long a floated window is given to settle before the driver measures it. */
const FLOAT_SETTLE_MS = 80;

interface Step {
  step: string;
  ok: boolean;
  /** the session made the step's subject unobservable: not a pass, and not a failure either */
  blocked?: boolean;
  detail: string;
  ms: number;
}

/** What the page writes into the store: the steps, and where it is right now. */
interface StoredResult {
  done?: boolean;
  nonce?: string;
  steps?: Step[];
  error?: string | null;
  alive?: { step?: unknown; at?: unknown };
}

function storedResult(storePath: string, nonce: string): StoredResult | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(storePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const box = raw as Record<string, unknown>;
    const result = box.tabs_smoke_result;
    if (typeof result !== 'object' || result === null) return null;
    const stored = result as StoredResult;
    return stored.nonce === nonce ? stored : null;
  } catch {
    return null; // the store may be mid-write
  }
}

function stepLine(step: Step): string {
  const mark = step.ok ? 'ok      ' : step.blocked === true ? 'blocked ' : 'FAILED  ';
  return `${mark}${step.step} (${step.ms} ms) ${step.detail}`;
}

interface SmokeResult {
  ok: boolean;
  error: string | null;
  steps: Step[];
}

// ------------------------------------------------------------- the temporary seed

/**
 * The seed of this launch (`gen-config dev` reads it for the runtime's origin gate, the app applies
 * it on first boot): two org tools on two reporting servers, one admin role, no invite. Both origins
 * end up in `api.origins` with the three tool methods (`scripts/gen-config.ts`), which is what lets
 * a tool tab report a login and keeps the third origin — the one RF-67's "new tool" branch saves —
 * without any method at all.
 */
function temporarySeed(tools: TabTools): string {
  const base = { icon: null, roles: [], views: [], auth: null, active: true };
  const seed = {
    version: 1,
    generatedAt: new Date().toISOString(),
    roles: [{ id: 'admin', name: 'Admin', admin: true }],
    entries: [
      { ...base, id: 'tool-a', title: 'Tool A', url: `${tools.originA}/tab`, order: 10 },
      { ...base, id: 'tool-b', title: 'Tool B', url: `${tools.originB}/tab`, order: 20 },
      // RF-69: a tool whose pages answer `X-Frame-Options: SAMEORIGIN` — never embeddable.
      { ...base, id: 'tool-d', title: 'Tool D', url: `${tools.originD}/tab`, order: 30 },
    ],
    invites: [],
    update: null,
  };
  return JSON.stringify(seed, null, 2) + '\n';
}

// ------------------------------------------------------------- TinyWM (OmniWM) helpers

interface WmWindow {
  id: string;
  pid: number;
  app: string;
  title: string;
  mode: string;
  layoutReason: string;
  visible: boolean;
  frame: { x: number; y: number; width: number; height: number };
}

/** One window the window server is really showing, with the frame it is showing it at. */
interface OnScreen {
  pid: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `test/smoke/winlist.swift`'s own output, as that file builds it. */
interface RawOnScreen {
  pid?: unknown;
  owner?: unknown;
  name?: unknown;
  layer?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
}

const WINLIST_SWIFT = join(import.meta.dir, 'winlist.swift');
const WINLIST_BIN = join(GENERATED_DIR, 'winlist');

/** One debug dump of what the WM knows about this run, printed once per smoke run. */
let wmDebugged = false;

/**
 * Runs one tool and returns what it said. Asynchronous on purpose: this process is also the fake
 * tool servers and the desk the app under test talks to (`Bun.serve` in the same event loop), so a
 * blocking `spawnSync` here would starve the very app being measured.
 */
async function runTool(argv: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: out + err };
}

/** `omniwmctl query windows --format json` as `omniwmctl help` documents it; every field is read
 *  with a `typeof` check, so an unexpected shape lands as an empty value instead of a crash. */
interface RawWmWindow {
  id?: unknown;
  pid?: unknown;
  app?: { name?: unknown };
  title?: unknown;
  mode?: unknown;
  layoutReason?: unknown;
  isVisible?: unknown;
  frame?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
}

interface RawWmPayload {
  result?: { payload?: { windows?: RawWmWindow[] } };
}

/** Every window the WM knows about, or `[]` when `omniwmctl` is not there at all. */
async function omniwmWindows(): Promise<WmWindow[]> {
  const result = await runTool([
    'omniwmctl',
    'query',
    'windows',
    '--fields',
    'id,pid,app,title,frame,mode,layout-reason,is-visible',
    '--format',
    'json',
  ]);
  if (result.code !== 0) return [];
  let windows: RawWmWindow[] | undefined;
  try {
    // The output of the tool this machine has installed, whose shape `omniwmctl help` documents.
    const payload = JSON.parse(result.out) as RawWmPayload;
    windows = payload.result?.payload?.windows;
  } catch {
    return [];
  }
  if (!Array.isArray(windows)) return [];
  const number = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return windows.flatMap((item): WmWindow[] => {
    if (typeof item.id !== 'string' || typeof item.pid !== 'number') return [];
    return [
      {
        id: item.id,
        pid: item.pid,
        app: typeof item.app?.name === 'string' ? item.app.name : '',
        title: typeof item.title === 'string' ? item.title : '',
        mode: typeof item.mode === 'string' ? item.mode : '',
        layoutReason: typeof item.layoutReason === 'string' ? item.layoutReason : '',
        visible: item.isVisible === true,
        frame: {
          x: number(item.frame?.x),
          y: number(item.frame?.y),
          width: number(item.frame?.width),
          height: number(item.frame?.height),
        },
      },
    ];
  });
}

/** This launch's own processes: the `tinyjs dev` tree, whose windows the WM must not re-tile. */
async function descendantPids(root: number): Promise<Set<number>> {
  const result = await runTool(['ps', '-A', '-o', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of result.out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]);
    else list.push(pid);
  }
  const found = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.pop() as number;
    for (const child of children.get(parent) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

async function ownWindows(rootPid: number | null): Promise<WmWindow[]> {
  if (rootPid === null) return [];
  const pids = await descendantPids(rootPid);
  return (await omniwmWindows()).filter((window) => pids.has(window.pid));
}

/** A one-line view of this run's windows, for the handover: title, mode, frame, visibility. */
async function wmSnapshot(rootPid: number | null): Promise<string> {
  const windows = await ownWindows(rootPid);
  if (windows.length === 0) return '(no window of this run in omniwmctl)';
  return windows
    .map(
      (window) =>
        `${JSON.stringify(window.title)} ${window.mode}/${window.layoutReason} ` +
        `${window.visible ? 'visible' : 'hidden'} ` +
        `${window.frame.width}x${window.frame.height}@${window.frame.x},${window.frame.y}`,
    )
    .join('; ');
}

/** The session the run is in, and why the window list could not be read. */
interface ScreenReading {
  windows: OnScreen[];
  others: number;
  why: string;
  /** a locked screen covers every window, which is where a webview reports itself hidden */
  locked: boolean;
  frontmost: string;
}

/**
 * What the window server is really showing of this run, straight from `CGWindowListCopyWindowInfo`
 * (`test/smoke/winlist.swift`, the helper the E03 spikes used): the only honest source for a
 * window's real frame here. A WKWebView reports `window.screenX/screenY` as 0 and the screen height
 * and `window.outerWidth/outerHeight` as 0 (`backend/tiny.d.ts`, `TinyWinState.outer`), so the page
 * cannot answer this by itself; `why` says so instead of pretending the runtime's own numbers are
 * the screen's. `others` counts the windows of an app whose owner name matches but whose pid is not
 * in this run's tree — the person's own Nod, say, which is why the match is by pid.
 */
async function onScreenWindows(rootPid: number | null): Promise<ScreenReading> {
  const empty = (why: string): ScreenReading => ({ windows: [], others: 0, why, locked: false, frontmost: '' });
  if (rootPid === null) return empty('the app is not running');
  const compiler = Bun.which('swiftc');
  if (compiler === null) return empty('no swiftc on this machine');
  if (!existsSync(WINLIST_BIN) || statSync(WINLIST_BIN).mtimeMs < statSync(WINLIST_SWIFT).mtimeMs) {
    mkdirSync(GENERATED_DIR, { recursive: true });
    const built = await runTool([compiler, '-O', '-o', WINLIST_BIN, WINLIST_SWIFT]);
    if (built.code !== 0) {
      return empty(`swiftc exited ${built.code}: ${built.out.trim().slice(-200)}`);
    }
  }
  const run = await runTool([WINLIST_BIN]);
  if (run.code !== 0) return empty(`winlist exited ${run.code}`);
  let list: RawOnScreen[] | undefined;
  let locked = false;
  let frontmost = '';
  try {
    // `test/smoke/winlist.swift`'s own output, whose shape that file builds.
    const payload = JSON.parse(run.out) as {
      list?: RawOnScreen[];
      session?: { screenLocked?: unknown };
      frontmost?: { name?: unknown };
    };
    list = payload.list;
    locked = payload.session?.screenLocked === true;
    frontmost = typeof payload.frontmost?.name === 'string' ? payload.frontmost.name : '';
  } catch {
    return empty('winlist printed something that is not JSON');
  }
  if (!Array.isArray(list)) return empty('winlist carried no list');
  const pids = await descendantPids(rootPid);
  const windows: OnScreen[] = [];
  let others = 0;
  for (const item of list) {
    const pid = typeof item.pid === 'number' ? item.pid : -1;
    if (item.layer !== 0) continue; // the window server's own chrome and the desktop
    if (!pids.has(pid)) {
      if (/nod|tinyjs|bun/i.test(String(item.owner ?? ''))) others += 1;
      continue;
    }
    windows.push({
      pid,
      title: typeof item.name === 'string' ? item.name : '',
      x: typeof item.x === 'number' ? item.x : 0,
      y: typeof item.y === 'number' ? item.y : 0,
      width: typeof item.w === 'number' ? item.w : 0,
      height: typeof item.h === 'number' ? item.h : 0,
    });
  }
  return { windows, others, why: '', locked, frontmost };
}

/**
 * Floats every **visible**, tiled window of this run: the WM owns a tiled frame, so the rect the Nod
 * asks for does not survive it, and a floating window keeps it. Only visible windows are touched —
 * focusing a hidden docked tab could bring it back onto the panel, which is not this smoke's to do —
 * and, when anything was floated, the main window takes the focus back so the app is where it was.
 */
async function floatOwnWindows(rootPid: number | null): Promise<{
  tiler: boolean;
  tiled: number;
  floated: string[];
  snapshot: string;
  screen: OnScreen[];
  others: number;
  screenWhy: string;
  screenLocked: boolean;
  frontmost: string;
}> {
  if (rootPid !== null && !wmDebugged) {
    wmDebugged = true;
    const known = await ownWindows(rootPid);
    console.log(
      `wm: omniwmctl knows ${known.length} window(s) of this run` +
        (known.length === 0
          ? ` (of ${(await omniwmWindows()).length} in total)`
          : `: ${await wmSnapshot(rootPid)}`),
    );
  }
  const tiled = (await ownWindows(rootPid)).filter(
    (window) => window.mode === 'tiling' && window.visible,
  );
  const floated: string[] = [];
  for (const window of tiled) {
    await runTool(['omniwmctl', 'window', 'focus', window.id]);
    await Bun.sleep(FLOAT_SETTLE_MS);
    await runTool(['omniwmctl', 'command', 'toggle-focused-window-floating']);
    await Bun.sleep(FLOAT_SETTLE_MS);
    floated.push(window.title);
  }
  if (floated.length > 0) {
    const main = (await ownWindows(rootPid)).find((window) => window.title === 'Nod');
    if (main !== undefined) await runTool(['omniwmctl', 'window', 'focus', main.id]);
  }
  const screen = await onScreenWindows(rootPid);
  return {
    tiler: tiled.length > 0,
    tiled: tiled.length,
    floated,
    snapshot: await wmSnapshot(rootPid),
    screen: screen.windows,
    others: screen.others,
    screenWhy: screen.why,
    screenLocked: screen.locked,
    frontmost: screen.frontmost,
  };
}

// ------------------------------------------------------------- the generated page

/** The generated page: the real entry, then the driver. It carries no secret. */
function generatePage(
  nonce: string,
  devPort: number,
  deskOrigin: string,
  tools: TabTools,
): { url: string; file: string } {
  const config = JSON.stringify({
    nonce,
    desk: deskOrigin,
    originA: tools.originA,
    originB: tools.originB,
    originC: tools.originC,
    originD: tools.originD,
  });
  const html =
    '<!doctype html>\n' +
    '<html lang="en"><head><meta charset="utf-8"><title>Nod — tabs smoke</title>' +
    '<link rel="stylesheet" href="/src/style.css"></head><body>' +
    '<div id="app"></div>' +
    `<script>window.__NOD_TABS_SMOKE__ = ${config};</script>` +
    '<script type="module" src="/src/app.ts"></script>' +
    `<script type="module" src="${DRIVER_ROUTE}"></script>` +
    '</body></html>\n';
  mkdirSync(TABS_DIR, { recursive: true });
  const file = join(TABS_DIR, `tabs-${nonce}.html`);
  writeFileSync(file, html);
  return {
    url: `http://127.0.0.1:${devPort}/test/smoke/.gerado/tabs/tabs-${nonce}.html`,
    file,
  };
}

/** Points the dev window at this launch's page (the generated file, not the project's index.html). */
function pointDevUrl(url: string): void {
  const raw: unknown = JSON.parse(readFileSync(TINYJS_JSON, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error(`${TINYJS_JSON} is not an object`);
  const config = raw as Record<string, unknown>;
  const frontend = config.frontend;
  if (typeof frontend !== 'object' || frontend === null) {
    throw new Error(`${TINYJS_JSON} has no frontend object`);
  }
  (frontend as Record<string, unknown>).devUrl = url;
  writeFileSync(TINYJS_JSON, JSON.stringify(config, null, 2) + '\n');
}

// ------------------------------------------------------------- the desk

interface Desk {
  origin: string;
  stop(): void;
}

/** `pid` of the running app, as `runPhase` has it — the desk's `/desk/float` needs it. */
interface PidRef {
  value: number | null;
}

function deskJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * The out-of-band channel between the runner and the page: the tool pages' own reports (read out of
 * the fake servers, which the driver cannot reach from another origin), the one-shot commands the
 * pages poll for, and the WM's view of this run's windows. It binds loopback on an ephemeral port
 * and carries no secret.
 */
function startDesk(deps: { tools: TabTools; pid: PidRef }): Desk {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/desk/reports') {
        return deskJson({ ok: true, reports: deps.tools.reports() });
      }
      if (url.pathname === '/desk/reset' && req.method === 'POST') {
        deps.tools.reset();
        return deskJson({ ok: true });
      }
      if (url.pathname === '/desk/cmd' && req.method === 'POST') {
        const body: unknown = await req.json().catch(() => null);
        if (typeof body !== 'object' || body === null) {
          return deskJson({ ok: false, error: 'bad body' }, 400);
        }
        const { pid, cmd, arg, tag } = body as Record<string, unknown>;
        if (typeof pid !== 'string' || pid === '' || typeof cmd !== 'string' || cmd === '') {
          return deskJson({ ok: false, error: 'bad command' }, 400);
        }
        deps.tools.command(
          pid,
          cmd,
          typeof arg === 'string' ? arg : undefined,
          typeof tag === 'string' ? tag : undefined,
        );
        return deskJson({ ok: true });
      }
      if (url.pathname === '/desk/float' && req.method === 'POST') {
        return deskJson({ ok: true, ...(await floatOwnWindows(deps.pid.value)) });
      }
      if (url.pathname === '/desk/onscreen') {
        const screen = await onScreenWindows(deps.pid.value);
        // Owner decision 2026-10-19: the smoke must not touch window-manager state beyond what it
        // already did. The driver gets the WM's own view instead, so a geometry step the tiler has
        // taken over says `blocked by the tiling WM` with numbers rather than failing or passing.
        const tiled = (await ownWindows(deps.pid.value))
          .filter((window) => window.mode === 'tiling')
          .map((window) => `${window.title} ${window.frame.width}x${window.frame.height}@${window.frame.x},${window.frame.y}`);
        return deskJson({
          ok: true,
          windows: screen.windows,
          others: screen.others,
          why: screen.why,
          screenLocked: screen.locked,
          frontmost: screen.frontmost,
          tiled,
        });
      }
      return deskJson({ ok: false, error: 'not found' }, 404);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop(): void {
      server.stop(true);
    },
  };
}

// ------------------------------------------------------------- the launch

/** The app's own stdout/stderr of the launch, for the report a failure prints. */
let appOutput = '';

async function runPhase(
  nonce: string,
  tools: TabTools,
  deskOrigin: string,
  pid: PidRef,
): Promise<SmokeResult> {
  const devPort = freePort();
  writeFileSync(SEED, temporarySeed(tools));
  const gen = generateDevConfig(ROOT, APP_ID, devPort);
  if (gen.code !== 0) {
    return { ok: false, error: `gen-config failed (code ${gen.code}): ${gen.output.trim()}`, steps: [] };
  }
  const page = generatePage(nonce, devPort, deskOrigin, tools);
  pointDevUrl(page.url);

  const env: Record<string, string | undefined> = {
    ...process.env,
    NOD_APP_ID: APP_ID,
    NOD_DEV_PORT: String(devPort),
  };
  // The smoke never runs with the runtime trace (AGENTS.md), and never with a page override.
  delete env.TINYJS_DEBUG;
  delete env.TINYJS_HTML;

  const app = spawn('tinyjs', ['dev'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  pid.value = app.pid ?? null;
  console.log(`app: tinyjs dev pid ${app.pid ?? '?'} on dev port ${devPort}, page ${page.file}`);
  let output = '';
  appOutput = '';
  const append = (chunk: Buffer | string): void => {
    output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
  };
  app.stdout?.on('data', append);
  app.stderr?.on('data', append);
  const box: { error: string | null } = { error: null };
  app.on('error', (error) => {
    box.error = `failed to start the app: ${error.message}`;
    append(box.error);
  });
  app.on('exit', (code, signal) => {
    console.log(`app: tinyjs dev exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });

  // The page writes its steps as they land; printing them live is what tells a stalled step from a
  // frozen page (the heartbeat stops when nothing runs) — and it leaves the step table on screen
  // even when the run ends on the timeout.
  const storePath = join(dataDir(APP_ID), 'store.json');
  const printed = new Set<string>();
  let aliveAt = Date.now();
  let aliveStep = 'setup';
  const watch = setInterval(() => {
    const stored = storedResult(storePath, nonce);
    if (stored === null) return;
    for (const step of stored.steps ?? []) {
      if (printed.has(step.step)) continue;
      printed.add(step.step);
      console.log(stepLine(step));
    }
    if (typeof stored.alive?.at === 'number') aliveAt = stored.alive.at;
    if (typeof stored.alive?.step === 'string') aliveStep = stored.alive.step;
  }, 1_000);

  appOutput = output;
  // A page that never boots (a broken module, a dev server that never came up) must not keep a
  // broken window on screen for the whole timeout: 25 s without a result and without a window of
  // this run is the answer, and the `finally` below kills the app and restores the seed.
  const bootFailed = Promise.withResolvers<SmokeResult>();
  void (async () => {
    for (let tick = 0; tick < 25; tick += 1) {
      await Bun.sleep(1_000);
      if (storedResult(storePath, nonce) !== null) return;
      if (app.exitCode !== null) break;
    }
    bootFailed.resolve({
      ok: false,
      error: 'the page never booted: no window of this run and no result after 25 s',
      steps: [],
    });
  })();

  try {
    const result = await Promise.race([
      waitForStoredResult(app, box, storePath, nonce, 'tabs_smoke_result', FINISH_TIMEOUT_MS),
      bootFailed.promise,
    ]);
    appOutput = output;
    return result;
  } finally {
    clearInterval(watch);
    for (const step of storedResult(storePath, nonce)?.steps ?? []) {
      if (printed.has(step.step)) continue;
      printed.add(step.step);
      console.log(stepLine(step));
    }
    console.log(
      `the page's last heartbeat was ${Math.round((Date.now() - aliveAt) / 1000)} s ago, in step ` +
        `${JSON.stringify(aliveStep)}`,
    );
    // The WM's and the window server's own view of the run, taken while the windows are still
    // there: the handover quotes both.
    const screen = await onScreenWindows(pid.value);
    console.log(`omniwm windows of this run: ${await wmSnapshot(pid.value)}`);
    console.log(
      screen.why === ''
        ? `on screen (CGWindowList): ${
            screen.windows
              .map((w) => `${JSON.stringify(w.title)} ${w.width}x${w.height}@${w.x},${w.y}`)
              .join('; ') || '(none)'
          }`
        : `on screen (CGWindowList): not read — ${screen.why}`,
    );
    console.log(
      `session: screen locked ${screen.locked}, frontmost ${JSON.stringify(screen.frontmost)}`,
    );
    pid.value = null;
    await killProcessTree(app);
    rmSync(page.file, { force: true });
  }
}

// ------------------------------------------------------------- main

/**
 * The driver runs inside the page, so vite transforms it: a syntax error there opens the app's
 * window with a vite overlay and no page at all. Parsing it here, before any launch, is what keeps a
 * broken smoke off the owner's screen.
 */
async function driverParseError(): Promise<string | null> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'tabs-driver.ts')],
    target: 'browser',
    outdir: join(GENERATED_DIR, 'parse-check'),
    throw: false,
  });
  rmSync(join(GENERATED_DIR, 'parse-check'), { recursive: true, force: true });
  if (!result.success) return result.logs.map((log) => String(log)).join('\n').slice(0, 1200);
  const source = readFileSync(join(import.meta.dir, 'tabs-driver.ts'), 'utf8');
  const nodeImport = /^import\s[^;]*from\s+['"](node:|bun)/m.exec(source);
  return nodeImport === null ? null : `the page module imports a runtime builtin: ${nodeImport[0]}`;
}

async function main(): Promise<number> {
  if (existsSync(SEED) && !process.argv.includes('--force')) {
    console.error(
      `refusing to run: ${SEED} exists. Move it away or run again with --force ` +
        `(the smoke moves it to ${SEED_BACKUP} and restores it at the end).`,
    );
    return 2;
  }

  const parseError = await driverParseError();
  if (parseError !== null) {
    console.error(`refusing to run: test/smoke/tabs-driver.ts does not parse\n${parseError}`);
    return 2;
  }

  const previousTinyjsJson = existsSync(TINYJS_JSON) ? readFileSync(TINYJS_JSON, 'utf8') : null;
  let seedMoved = false;
  let tools: TabTools | null = null;
  let desk: Desk | null = null;
  const pid: PidRef = { value: null };

  const clean = (): void => {
    desk?.stop();
    desk = null;
    tools?.stop();
    tools = null;
    rmSync(dataDir(APP_ID), { recursive: true, force: true });
    rmSync(TABS_DIR, { recursive: true, force: true });
    if (previousTinyjsJson !== null) writeFileSync(TINYJS_JSON, previousTinyjsJson);
    if (seedMoved) {
      if (existsSync(SEED)) rmSync(SEED, { force: true });
      renameSync(SEED_BACKUP, SEED);
    }
  };

  const onSignal = (): void => {
    clean();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // A backup already in place means another smoke is running (or one was killed before it restored).
  if (existsSync(SEED_BACKUP)) {
    console.error(`refused: ${SEED_BACKUP} exists — another smoke is running, or restore it to ${SEED} by hand`);
    process.exit(1);
  }

  try {
    if (existsSync(SEED)) {
      mkdirSync(GENERATED_DIR, { recursive: true });
      renameSync(SEED, SEED_BACKUP);
      seedMoved = true;
      console.log(`private seed moved to ${SEED_BACKUP}`);
    }
    rmSync(dataDir(APP_ID), { recursive: true, force: true });
    rmSync(TABS_DIR, { recursive: true, force: true });

    tools = startTabTools();
    console.log(
      `reporting tools: A=${tools.originA} B=${tools.originB} C=${tools.originC} ` +
        `D=${tools.originD} (XFO SAMEORIGIN, loopback only)`,
    );
    const wm = await runTool(['omniwmctl', 'ping']);
    console.log(
      wm.code === 0
        ? 'omniwmctl answers: the windows of this run are floated before every geometry check'
        : 'omniwmctl does not answer: no tiling WM is managed here',
    );

    desk = startDesk({ tools, pid });
    console.log(`desk on ${desk.origin} (reports, commands and the WM view; no secret)`);

    const nonce = crypto.randomUUID();
    const started = Date.now();
    const result = await runPhase(nonce, tools, desk.origin, pid);
    let failed = !result.ok;
    let blockedSteps = 0;
    for (const step of result.steps) {
      if (step.blocked === true) blockedSteps += 1;
      if (!step.ok && step.blocked !== true) failed = true;
    }
    if (!result.ok) {
      console.error(`the page did not answer: ${result.error}`);
      const tail = appOutput.trim();
      console.error(tail === '' ? 'app: printed nothing' : `app output (last 1200 chars):\n${tail.slice(-1200)}`);
    }
    console.log(
      `\ntabs smoke (app id ${APP_ID}, email ${EMAIL}, ${NAME}): ${failed ? 'FAILED' : 'ok'} ` +
        `(${result.steps.length} step(s), ${blockedSteps} blocked by the session, in ` +
        `${Date.now() - started} ms)`,
    );
    return failed ? 1 : 0;
  } finally {
    clean();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

process.exit(await main());
