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
import { join } from 'node:path';

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
 * `bun scripts/gen-config.ts dev`, with the smoke id and dev port; with `null` for both the child
 * gets neither key — which is how the final regeneration puts back the base id and default port.
 */
export function generateDevConfig(
  root: string,
  appId: string | null,
  devPort: number | null,
): { code: number; output: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  if (appId !== null && devPort !== null) {
    env.NOD_APP_ID = appId;
    env.NOD_DEV_PORT = String(devPort);
  } else {
    delete env.NOD_APP_ID;
    delete env.NOD_DEV_PORT;
  }
  const result = Bun.spawnSync(['bun', 'scripts/gen-config.ts', 'dev'], {
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

/** Kills the app and its children (the process group catches the frontend server). */
export async function killProcessTree(app: ChildProcess): Promise<void> {
  const pid = app.pid;
  if (pid === undefined) return;
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
