// Fake tools for the smoke: local servers standing in for the internal tools, the identity
// provider, and one tool whose origin is not in the seed. Everything binds 127.0.0.1 on an
// ephemeral port (`port: 0`), so the smoke needs neither external network nor a fixed port.
//
// A: form login (entry `tool-a`), `/icon.png` serves the 1x1 PNG used as the tool icon.
// B: no login, plus the `/sso` view that leaves for the provider and comes back (`tool-b`).
// C: form login with the same shape as A, but its origin is NOT in the seed, so the runtime gate
//    does not allow `login.report` for it. It counts every `POST /login` it receives and serves
//    the counter at `GET /stats` (login-loop regression, step 10 of the smoke).
// Provider: only the SSO round trip; it never calls the Nod API.
//
// USERNAME/SECRET_A are the same pair `test/smoke/smoke.html` writes to the vault.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, relative, sep } from 'node:path';

/** Credentials server A accepts — the same pair `test/smoke/smoke.html` saves in the vault. */
export const USERNAME = 'person@test';
export const SECRET_A = 'secret-a';

export interface Tools {
  originA: string;
  originB: string;
  originC: string;
  originProvider: string;
  stop(): void;
}

// Valid 1x1 RGBA PNG (70 bytes: signature + IHDR + IDAT + IEND). Fixed bytes in the file —
// server A serves this as the tool icon.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64');

function page(title: string, body: string, head = ''): Response {
  return new Response(
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>\n`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function redirect(status: number, location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location: location, 'cache-control': 'no-store' };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status, headers });
}

function notFound(): Response {
  return new Response('not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** `true` when the Cookie header carries exactly this pair (`session=ok`). */
function hasCookie(req: Request, pair: string): boolean {
  const raw = req.headers.get('cookie') ?? '';
  return raw.split(';').some((part) => part.trim() === pair);
}

/** Login form of A and C: the `<link rel="icon">` is what makes A's probe find the PNG. */
function loginPage(tool: 'A' | 'C'): Response {
  return page(
    `Tool ${tool} · Test`,
    `<h1>Sign in to Tool ${tool}</h1>` +
      '<form method="post" action="/login">' +
      '<input type="text" name="username" autocomplete="username" placeholder="username">' +
      '<input type="password" name="password" autocomplete="current-password" placeholder="password">' +
      '<button type="submit">Sign in</button>' +
      '</form>',
    tool === 'A' ? '<link rel="icon" href="/icon.png">' : '',
  );
}

/**
 * A free loopback port: bound once and released, for the host (`PORT` refuses 0) and for each app
 * launch — a fixed port could be held by a process a previous smoke left behind, and then the page
 * would be served by the wrong instance.
 */
export function freePort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Starts A, B, C and the provider; returns their origins and how to stop them. */
export function startTools(): Tools {
  // The four origins only exist after the bind (ephemeral port), but the handlers only run when
  // someone calls — so reading them through the closure is safe.
  let originA = '';
  let originB = '';
  let originC = '';
  let originProvider = '';

  const providerServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/authorize') {
        const back = url.searchParams.get('return') ?? '';
        if (!back.startsWith(`${originB}/`)) {
          return new Response('invalid return\n', {
            status: 400,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        return redirect(302, back);
      }
      return notFound();
    },
  });
  originProvider = `http://127.0.0.1:${providerServer.port}`;

  const serverB = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/') return page('Tool B · Test', '<h1>B is open</h1>');
      if (url.pathname === '/sso') {
        if (hasCookie(req, 'sso=ok')) return redirect(303, '/panel');
        const back = encodeURIComponent(`${originB}/sso/back`);
        return redirect(302, `${originProvider}/authorize?return=${back}`);
      }
      if (url.pathname === '/sso/back') {
        return redirect(303, '/panel', 'sso=ok; Path=/');
      }
      if (url.pathname === '/panel') {
        if (hasCookie(req, 'sso=ok')) return page('Panel B · Test', '<h1>panel B</h1>');
        return redirect(303, '/sso');
      }
      return notFound();
    },
  });
  originB = `http://127.0.0.1:${serverB.port}`;

  const serverA = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/icon.png') {
        return new Response(PNG_1X1, {
          headers: {
            'content-type': 'image/png',
            'content-length': String(PNG_1X1.byteLength),
            'cache-control': 'no-store',
          },
        });
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const body = new URLSearchParams(await req.text());
        if (body.get('username') === USERNAME && body.get('password') === SECRET_A) {
          return redirect(303, '/', 'session=ok; Path=/');
        }
        return loginPage('A');
      }
      if (url.pathname === '/') {
        if (hasCookie(req, 'session=ok')) return page('Tool A · Test', '<h1>signed in to A</h1>');
        return loginPage('A');
      }
      return notFound();
    },
  });
  originA = `http://127.0.0.1:${serverA.port}`;

  // C never accepts a login: it only has to be filled once (wrong secret) and count the attempt.
  let logins = 0;
  const serverC = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/stats') {
        return new Response(JSON.stringify({ posts: logins }) + '\n', {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          },
        });
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        await req.text();
        logins += 1;
        return loginPage('C');
      }
      if (url.pathname === '/') return loginPage('C');
      return notFound();
    },
  });
  originC = `http://127.0.0.1:${serverC.port}`;

  return {
    originA,
    originB,
    originC,
    originProvider,
    stop(): void {
      serverA.stop(true);
      serverB.stop(true);
      serverC.stop(true);
      providerServer.stop(true);
    },
  };
}

// ---------------------------------------------------------------- app launches (shared)

/** Data directory of one app id, the way the runtime computes it on each system. */
export function appDataDir(appId: string): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', appId);
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), appId);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), appId);
}

/**
 * The smokes launch the one desktop runtime: Electrobun. The type keeps `tinyjs` so the old
 * handovers' explicit `--runtime=tinyjs` flag fails with a clear message instead of silently
 * running something else.
 */
export type SmokeRuntime = 'tinyjs' | 'electrobun';

const RUNTIME_FLAG = '--runtime=';

/**
 * The runtime of this run: Electrobun, always. `--runtime=electrobun` is still accepted for the
 * handovers that recorded it; `--runtime=tinyjs` fails loudly because that runtime was removed.
 */
export function smokeRuntime(argv: readonly string[] = process.argv): SmokeRuntime {
  const flags = argv.filter((arg) => arg.startsWith(RUNTIME_FLAG));
  if (flags.length > 1) throw new Error(`only one ${RUNTIME_FLAG} flag is allowed`);
  const raw = (flags[0]?.slice(RUNTIME_FLAG.length) ?? process.env.NOD_RUNTIME ?? 'electrobun')
    .trim()
    .toLowerCase();
  if (raw === 'electrobun') return raw;
  if (raw === 'tinyjs') {
    throw new Error('tinyjs was removed in 0.8.0: the smokes run on Electrobun only');
  }
  throw new Error(`unknown runtime ${JSON.stringify(raw)}: use --runtime=electrobun`);
}

/** App id of one launch; the `-eb` suffix keeps smoke data out of any real installation. */
export function smokeAppId(base: string, _runtime: SmokeRuntime): string {
  return `${base}-eb`;
}

/**
 * Directory the backend's own files live in for one launch (`store.json`, `nod.db`,
 * `guild-icon.png`) — `app.paths().data` of the runtime. Both runtimes use the app data dir root:
 * since 0.7.0 the Electrobun target resolves its data to the tinyjs layout for a fresh identifier
 * (`electrobun/bun/facade/data-dir.ts` `resolveDataDir`), so an updated Mac keeps its account, and
 * every smoke wipes its throwaway id first.
 */
export function runtimeDataDir(appId: string, _runtime: SmokeRuntime): string {
  return appDataDir(appId);
}

/** `store.json` of one launch — the result channel of every smoke here (`runtimeDataDir`). */
export function storeFilePath(appId: string, runtime: SmokeRuntime): string {
  return join(runtimeDataDir(appId, runtime), 'store.json');
}

/** The page under the project root, as the dev server serves it (`/test/smoke/.gerado/…`). */
export function devPageUrl(root: string, devPort: number, page: string): string {
  const path = relative(root, page).split(sep).join('/');
  if (path === '' || path.startsWith('../') || path.startsWith('/')) {
    throw new Error(`the page must live under the project root (${root}): ${page}`);
  }
  return `http://127.0.0.1:${devPort}/${path}`;
}

/**
 * `bun scripts/gen-electrobun-config.ts dev` under the smoke's identifier and page override. With
 * `null` for both, the child gets neither variable: that is how the last launch of a run puts the
 * development config back (`NOD_APP_ID` -> `copland.nod.eb-dev`, no `NOD_MAIN_URL`).
 *
 * `NOD_MAIN_URL` is read by `electrobun/bun/index.ts` in a dev run only (a packaged build always
 * loads `views://mainview/index.html`), and it is what points the main window at the generated
 * driver page instead of the project's `index.html`.
 */
export function generateElectrobunDevConfig(
  root: string,
  appId: string | null,
  mainUrl: string | null,
): { code: number; output: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  if (appId !== null) env.NOD_APP_ID = appId;
  else delete env.NOD_APP_ID;
  if (mainUrl !== null) env.NOD_MAIN_URL = mainUrl;
  else delete env.NOD_MAIN_URL;
  const result = Bun.spawnSync(['bun', 'scripts/gen-electrobun-config.ts', 'dev'], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode ?? -1,
    output: (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? ''),
  };
}

const DEV_SERVER_BOOT_TIMEOUT_MS = 30_000;

interface DevServer {
  output(): string;
  stop(): Promise<void>;
}

/** Kills the app and its children (the process group catches the frontend server). */
export async function killProcessTree(app: ChildProcess): Promise<void> {
  const pid = app.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return;
  }
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (alive()) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already dead */
    }
    const limit = Date.now() + 3000;
    while (Date.now() < limit && alive()) await Bun.sleep(100);
  }
  if (alive()) {
    Bun.spawnSync(['pkill', '-P', String(pid)], { stdout: 'ignore', stderr: 'ignore' });
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

/**
 * `bun run dev` (vite) on the launch's own port. Electrobun has no dev server of its own — the
 * tinyjs launcher starts `frontend.dev` for itself — so the Electrobun launch starts the same one
 * here. The `dev` script carries `--strictPort`: vite refuses instead of moving to another port, so
 * the URL the window loads is the one this runner waited for.
 */
async function startDevServer(root: string, devPort: number): Promise<DevServer> {
  let output = '';
  const append = (chunk: Buffer | string): void => {
    output = (output + chunk.toString()).slice(-4000);
  };
  const child = spawn('bun', ['run', 'dev'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NOD_DEV_PORT: String(devPort) },
  });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const start = Date.now();
  while (Date.now() < start + DEV_SERVER_BOOT_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`the dev server exited ${child.exitCode}: ${output.trim().slice(-400)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${devPort}/`);
      if (response.ok) return { output: () => output, stop: () => killProcessTree(child) };
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(150);
  }
  await killProcessTree(child);
  throw new Error(
    `the dev server did not answer http://127.0.0.1:${devPort}/ in ${DEV_SERVER_BOOT_TIMEOUT_MS} ms: ` +
      output.trim().slice(-400),
  );
}

/** One app launch of a smoke: the process, its result channel and how to take it down. */
export interface SmokeLaunch {
  /** The runtime process (`tinyjs` or the `electrobun` CLI); its pid tree is this run's app. */
  app: ChildProcess;
  /** Set when the spawn itself failed; `waitForStoredResult` answers with it instead of timing out. */
  box: { error: string | null };
  /** `<app data>/store.json` or `<app data>/dev/store.json` (`storeFilePath`). */
  storePath: string;
  /** One line for the runner's log: runtime, app id, page and dev port. */
  label: string;
  /** The last 4000 characters of the launch's (and the dev server's) output. */
  output(): string;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  root: string;
  runtime: SmokeRuntime;
  appId: string;
  devPort: number;
  /** Absolute path of the page the main window loads; it must live under `root`. */
  page: string;
  /** Extra environment of the child (never secrets — `AGENTS.md`). */
  env?: Record<string, string | undefined>;
  /** Called with every output chunk; the tabs runner keeps its own buffer for the failure report. */
  onOutput?: (chunk: string) => void;
}

/**
 * Starts the real app with its main window on the generated page: the dev config takes the smoke's
 * identifier, vite serves the page modules, and `electrobun dev` launches with `NOD_MAIN_URL`
 * pointing the window at the page.
 */
export async function launchSmokeApp(options: LaunchOptions): Promise<SmokeLaunch> {
  const { root, runtime, appId, devPort, page } = options;
  let output = '';
  const append = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    output = (output + text).slice(-4000);
    options.onOutput?.(text);
  };

  let devServer: DevServer | null = null;

  const mainUrl = devPageUrl(root, devPort, page);
  const gen = generateElectrobunDevConfig(root, appId, mainUrl);
  if (gen.code !== 0) {
    throw new Error(`gen-electrobun-config failed (code ${gen.code}): ${gen.output.trim()}`);
  }
  devServer = await startDevServer(root, devPort);
  output = devServer.output();
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    NOD_APP_ID: appId,
    NOD_DEV_PORT: String(devPort),
    NOD_MAIN_URL: mainUrl,
  };
  delete env.TINYJS_HTML;
  delete env.TINYJS_DEBUG;
  const label =
    `electrobun dev (NOD_MAIN_URL=${mainUrl}, NOD_APP_ID=${appId}, ` +
    `store=${storeFilePath(appId, runtime)})`;

  const bun = Bun.which('bun') ?? process.execPath;
  const app = spawn(bun, ['x', 'electrobun', 'dev', '--env=dev'], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  app.stdout?.on('data', append);
  app.stderr?.on('data', append);
  const box: { error: string | null } = { error: null };
  app.on('error', (error) => {
    box.error = `failed to start the app: ${error.message}`;
    append(box.error);
  });

  return {
    app,
    box,
    storePath: storeFilePath(appId, runtime),
    label,
    output: () => output,
    async stop(): Promise<void> {
      await killProcessTree(app);
      if (devServer !== null) await devServer.stop();
    },
  };
}

export interface StoredStep {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/**
 * Waits for `done` of **this** launch in the app's store: the nonce the runner put in the page is
 * what tells a fresh result from the one a previous launch of the same app id left there.
 */
export async function waitForStoredResult(
  app: ChildProcess,
  box: { error: string | null },
  storePath: string,
  nonce: string,
  key: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error: string | null; steps: StoredStep[] }> {
  const start = Date.now();
  let last: { done?: boolean; nonce?: string; steps?: StoredStep[] } | null = null;
  while (Date.now() - start < timeoutMs) {
    if (box.error !== null) return { ok: false, error: box.error, steps: last?.steps ?? [] };
    if (app.exitCode !== null || app.signalCode !== null) {
      return {
        ok: false,
        error: `the app exited before writing the result (code ${app.exitCode}, signal ${app.signalCode})`,
        steps: last?.steps ?? [],
      };
    }
    await Bun.sleep(200);
    if (!existsSync(storePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
      const result = raw[key] as { done?: boolean; nonce?: string; steps?: StoredStep[] } | undefined;
      if (!result || result.nonce !== nonce) continue;
      last = result;
      if (result.done === true) return { ok: true, error: null, steps: result.steps ?? [] };
    } catch {
      /* store.json may be mid-write; try again next cycle */
    }
  }
  return {
    ok: false,
    error: `timeout (${timeoutMs} ms) waiting for ${key}.done`,
    steps: last?.steps ?? [],
  };
}

// ---------------------------------------------------------------- host (shared)

const HOST_BOOT_TIMEOUT_MS = 20_000;
const HOST_STOP_TIMEOUT_MS = 5_000;
const HOST_OUTPUT_LIMIT = 4000;

export interface HostControl {
  port: number;
  env: Record<string, string | undefined>;
  /** `extraEnv` rides over the boot environment; the smoke's O2 step raises the minimum this way. */
  start(extraEnv?: Record<string, string>): Promise<string>;
  stop(): Promise<string>;
  running(): boolean;
  kill(): void;
}

/** The one host of a smoke: `bun host/main.ts` on a temp data dir, on a free loopback port. */
export function startHostControl(
  root: string,
  dataDirPath: string,
  guildName: string,
): HostControl {
  const port = freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    NOD_DATA: dataDirPath,
    NOD_DEV: '1',
    NOD_PUBLIC_URL: `http://127.0.0.1:${port}`,
    NOD_GUILD_NAME: guildName,
    PORT: String(port),
  };
  let child: ChildProcess | null = null;
  let output = '';

  const append = (chunk: Buffer | string): void => {
    output = (output + chunk.toString()).slice(-HOST_OUTPUT_LIMIT);
  };

  return {
    port,
    env,
    running: () => child !== null,
    async start(extraEnv: Record<string, string> = {}): Promise<string> {
      if (child !== null) return 'host already up';
      const spawned = spawn('bun', ['host/main.ts'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ...extraEnv },
      });
      child = spawned;
      output = '';
      spawned.stdout?.on('data', append);
      spawned.stderr?.on('data', append);
      const limit = Date.now() + HOST_BOOT_TIMEOUT_MS;
      while (Date.now() < limit) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) return `host up on 127.0.0.1:${port}`;
        } catch {
          /* not listening yet */
        }
        if (spawned.exitCode !== null) {
          throw new Error(`the host exited ${spawned.exitCode}: ${output.trim().slice(-300)}`);
        }
        await Bun.sleep(150);
      }
      throw new Error(
        `the host did not answer /health in ${HOST_BOOT_TIMEOUT_MS} ms: ${output.trim().slice(-300)}`,
      );
    },
    async stop(): Promise<string> {
      const spawned = child;
      if (spawned === null) return 'host already down';
      const exited = new Promise<void>((resolve) => spawned.once('exit', () => resolve()));
      spawned.kill('SIGTERM');
      const timedOut = await Promise.race([
        exited.then(() => false),
        Bun.sleep(HOST_STOP_TIMEOUT_MS).then(() => true),
      ]);
      if (timedOut) {
        spawned.kill('SIGKILL');
        await exited;
      }
      child = null;
      return `host stopped on 127.0.0.1:${port} (exit ${spawned.exitCode ?? 'signal'})`;
    },
    kill(): void {
      child?.kill('SIGKILL');
      child = null;
    },
  };
}

/** SP07 §3's one-time setup code, through the real command, over the host's own environment. */
export function issueSetupCode(
  root: string,
  env: Record<string, string | undefined>,
): string {
  const result = Bun.spawnSync(['bun', 'host/cli/setup-code.ts'], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `setup-code exited ${result.exitCode}: ${(result.stderr?.toString() ?? '').trim().slice(-300)}`,
    );
  }
  const code = (result.stdout?.toString() ?? '').trim();
  if (code.length === 0) throw new Error('setup-code printed nothing');
  return code;
}

// ---------------------------------------------------------------- E03 tab smoke (test/smoke/tabs.ts)

/**
 * One report a reporting tool page posted to its own server (the E03 tab smoke). The page measures
 * **itself** — `window.screenX/screenY`, its outer and inner box, `performance.timeOrigin`, the value
 * of its `<input id=draft>` and what the Nod API answered it — so the smoke reads the real geometry
 * of a real tool window instead of guessing it from the backend.
 */
export interface TabReport {
  /** 'A', 'B' or 'C': which reporting server served the page. */
  tool: string;
  /** this load's id — two tabs of the same tool answer their own commands. */
  pid: string;
  tag: string | null;
  note: string | null;
  /** `tiny.win.id`, the window the page lives in; null when the window has no bridge. */
  win: string | null;
  href: string;
  timeOrigin: number;
  /** The raw webview numbers, reported on purpose: in a WKWebView they are useless (see above). */
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  /**
   * `tiny.win.getState()` of that window — the runtime's own view of where it is and how big, which
   * is what the geometry of a tab can be measured with (`window.screenX/screenY` are 0 and the
   * screen height in this webview, and `outerWidth/outerHeight` are 0).
   */
  state: {
    /** frame top-left in screen coordinates — the units `setPosition` takes */
    x: number;
    y: number;
    /** the page's box (decorations excluded) */
    width: number;
    height: number;
    /** the footprint on screen, decorations included */
    outerWidth: number;
    outerHeight: number;
    frame: boolean | null;
    visible: boolean;
    focused: boolean;
    minimized: boolean;
  } | null;
  draft: string;
  /** what `tiny.api.call` answered: 'ok', the refusal, or why there is no bridge at all. */
  apiError: string | null;
  /** why the page has no `state`: no `tiny.win`, no `getState` in it, or an error from the call. */
  stateError: string | null;
  at: number;
}

export interface TabTools {
  originA: string;
  originB: string;
  originC: string;
  /** Every report every page posted so far, oldest first. */
  reports(): TabReport[];
  /** Queues one command for the page of one load; that page's next poll answers it. */
  command(pid: string, cmd: string, arg?: string, tag?: string): void;
  /** Forgets every report and every queued command. */
  reset(): void;
  stop(): void;
}

function smokeJson(value: unknown): Response {
  return new Response(JSON.stringify(value) + '\n', {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * The page of a reporting tool: no login, one icon, one input. It writes a random draft into
 * `<input id=draft>` on load, posts a report on load and on every resize, and polls its own server
 * (`/poll?pid=…`) for the one-shot commands the smoke queues — `report`, `open <url>`, `api <method>`.
 * The draft and `performance.timeOrigin` are what proves a switch, a detach or a dock never reloaded
 * the page; `window.open` is what RF-66 needs; the api answer is RF-68's.
 */
function reportPage(label: string): string {
  const script = [
    'const LABEL = ' + JSON.stringify(label) + ';',
    "const PID = Math.random().toString(36).slice(2) + Date.now().toString(36);",
    "const DRAFT = 'draft-' + Math.random().toString(36).slice(2, 8);",
    "const input = document.getElementById('draft');",
    'input.value = DRAFT;',
    'let apiError = null;',
    'async function snapshot(tag, note) {',
    '  const bridge = window.tiny && window.tiny.win ? window.tiny.win : null;',
    '  let state = null;',
    '  let stateError = null;',
    '  try {',
    '    if (bridge === null) stateError = "no tiny.win in this window";',
    '    else if (typeof bridge.getState !== "function") stateError = "no tiny.win.getState in this window";',
    '    else { state = await bridge.getState(); if (state === null) stateError = "getState() answered null"; }',
    '  } catch (error) { stateError = String(error && error.message ? error.message : error); }',
    '  return { tool: LABEL, pid: PID, tag: tag === undefined ? null : tag,',
    '    note: note === undefined ? null : note, win: bridge === null ? null : bridge.id,',
    '    stateError: stateError,',
    '    href: location.href, timeOrigin: performance.timeOrigin,',
    '    screenX: window.screenX, screenY: window.screenY,',
    '    outerWidth: window.outerWidth, outerHeight: window.outerHeight,',
    '    innerWidth: window.innerWidth, innerHeight: window.innerHeight,',
    '    state: state === null ? null : { x: state.x, y: state.y, width: state.width,',
    '      height: state.height, outerWidth: state.outer.width, outerHeight: state.outer.height,',
    '      frame: state.chrome ? state.chrome.frame : null, visible: state.visible,',
    '      focused: state.focused, minimized: state.minimized },',
    '    draft: input.value, apiError: apiError, at: Date.now() };',
    '}',
    'function send(tag, note) {',
    '  snapshot(tag, note).then(function (body) {',
    "    fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' },",
    '      body: JSON.stringify(body) }).catch(function () { return undefined; });',
    '  }).catch(function () { return undefined; });',
    '}',
    "window.addEventListener('resize', function () { send(undefined, 'resize'); });",
    'async function run(command) {',
    "  if (command.cmd === 'report') { send(command.tag, 'ask'); return; }",
    "  if (command.cmd === 'open') { window.open(command.arg, '_blank'); send(command.tag, 'open'); return; }",
    "  if (command.cmd === 'api') {",
    '    apiError = null;',
    '    try {',
    "      if (!window.tiny || !window.tiny.api) { apiError = 'no tiny bridge in this window'; }",
    "      else { await window.tiny.api.call(command.arg || 'login.report', { state: 'no-form' }); apiError = 'ok'; }",
    '    } catch (error) { apiError = String(error && error.message ? error.message : error); }',
    "    send(command.tag, 'api');",
    '    return;',
    '  }',
    "  send(command.tag, 'unknown:' + command.cmd);",
    '}',
    'async function poll() {',
    '  try {',
    "    const response = await fetch('/poll?pid=' + encodeURIComponent(PID), { cache: 'no-store' });",
    '    if (response.ok) { const list = await response.json(); for (const command of list) await run(command); }',
    '  } catch (error) { /* the server may be gone: keep polling */ }',
    '  setTimeout(poll, 120);',
    '}',
    "send(undefined, 'load');",
    'poll();',
  ].join('\n');
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    `<title>Tool ${label} · smoke</title>` +
    '<link rel="icon" href="/icon.png"></head><body>' +
    `<h1>Tool ${label}</h1>` +
    '<input id="draft" type="text" autocomplete="off">' +
    '<script>\n' +
    script +
    '\n</script></body></html>\n'
  );
}

/**
 * The three reporting tools of the E03 tab smoke, each on its own loopback origin: **A** and **B**
 * are the two the smoke's seed names (a tool tab each), **C** is an origin no catalog names — what
 * RF-67's "new tool" branch needs and what `api.origins` gives no method to. Every port is
 * ephemeral and everything binds 127.0.0.1: no fixed port, no external network.
 */
export function startTabTools(): TabTools {
  const reports: TabReport[] = [];
  const queues = new Map<string, Array<{ cmd: string; arg?: string; tag?: string }>>();
  const origins: Record<string, string> = {};
  const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

  function start(label: string): string {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/icon.png') {
          return new Response(PNG_1X1, {
            headers: {
              'content-type': 'image/png',
              'content-length': String(PNG_1X1.byteLength),
              'cache-control': 'no-store',
            },
          });
        }
        if (url.pathname === '/report' && req.method === 'POST') {
          const body: unknown = await req.json().catch(() => null);
          if (typeof body === 'object' && body !== null) reports.push(body as TabReport);
          return smokeJson({ ok: true });
        }
        if (url.pathname === '/poll') {
          const pid = url.searchParams.get('pid') ?? '';
          const queued = queues.get(pid) ?? [];
          queues.delete(pid);
          return smokeJson(queued);
        }
        if (req.method === 'GET') {
          return new Response(reportPage(label), {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
        return notFound();
      },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  origins.A = start('A');
  origins.B = start('B');
  origins.C = start('C');

  return {
    originA: origins.A,
    originB: origins.B,
    originC: origins.C,
    reports: () => [...reports],
    command(pid, cmd, arg, tag): void {
      const queued = queues.get(pid) ?? [];
      queued.push({ cmd, ...(arg === undefined ? {} : { arg }), ...(tag === undefined ? {} : { tag }) });
      queues.set(pid, queued);
    },
    reset(): void {
      reports.length = 0;
      queues.clear();
    },
    stop(): void {
      for (const server of servers) server.stop(true);
    },
  };
}
