// Two-instance smoke of connected mode — SP05 §5 steps 2–5, story B11 (issue #22).
//
//   bun test/smoke/connected.ts            # refuses when resources/seed.json exists
//   bun test/smoke/connected.ts --force    # moves the private seed to test/smoke/.gerado/seed.json.bak
//                                          # and restores it at the end
//
// What runs here, all on loopback and with no external network:
//
//   - the real host (`bun host/main.ts`) on a free port, over a temp data dir, with `NOD_DEV=1`;
//   - the setup code of that host (`bun host/cli/setup-code.ts`, the same environment) — held in
//     memory, never printed, never written to a file;
//   - the local fake tools of `test/smoke/tools.ts` (the stand-ins for the internal tools);
//   - the real app (`tinyjs dev`) under two app ids (`...smoke-admin`, `...smoke-person`) and its
//     own dev port each, the way `test/smoke/run.ts` launches one (temporary seed, gen-config,
//     `TINYJS_HTML` page, result channel through `<app data>/store.json`).
//
// The pages drive the flow; this runner is the world around them, and it takes part through one
// loopback endpoint ("the desk"): the admin page asks it for the setup code, hands P's access code
// back (never through a file: the code exists in this process' memory and in the page's), and the
// person page asks it to stop and start the host — SP05 §5.5's "network off" is the host process
// gone, and "network on" is the same data dir started again.
//
// Steps 4 and 5 of SP05 §5 conflict for P (a revoked person cannot push later), so the phases run
// in the order the acceptance needs: publish, join and reconnect, the guild icon's removal, revoke,
// then the doomed sync.
//
//   phase admin-publish      SP05 §5.2  a local account with the guild email and a credential saved
//                                       for it, then host.activate with the setup code: the join
//                                       answers F1's choice (nothing sent), the same code redeems
//                                       with it, the credential comes along; publish local tools,
//                                       create P with role `team`, grant the tool to `team`, sync
//                            SP05 §6    and upload the guild's PNG (`host.setGuildIcon`)
//   phase person-join        SP05 §5.3  P activates, sees the granted tool, saves a credential
//                            SP05 §5.5  and fills the login; host stopped: lock/unlock, tools still
//                                       there, `stale`; host restarted: sync pushes P's events
//                            SP05 §6    and P's app reports the guild icon as available and shows
//                                       it (`nod.setAppIcon`); the runner then reads the PNG off P's
//                                       own data dir
//   phase admin-clear        SP05 §6    the admin removes the guild icon
//   phase person-cleared     SP05 §6    P's next sync deletes the file and puts the bundle icon back
//   phase admin-revoke       SP05 §5.4  the admin revokes P
//   phase person-signed-out  SP05 §5.4  P's next sync: `signed-out`, org tools gone
//
// The two §6 phases sit between the join and the revocation because that window is the only one in
// which the icon can be removed while P still syncs: after the revocation P's sync is the
// `signed-out` one, which says nothing about a guild icon.
//
// P's seed is not the admin's (see `temporarySeed`): the granted tool is the host's entry, with no
// local `tool` row under it. Step 3.7/3.8 therefore prove a host-only tool receiving a credential,
// and the fill on the host entry's origin (SP05 §2).
//
// No secret reaches a file, a log, an event or `store.json`: the codes live in memory (the host CLI
// writes to a pipe, the desk answers the page), and only step names, statuses and counts are
// printed. `resources/seed.json` is never lost: it is moved aside exactly like `run.ts --force`
// does and restored in `finally`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { GUILD_ICON_FILE } from '../../backend/guild-icon';
import { sha256Hex, toBase64url } from '../../shared/encoding';
import type { Tools } from './tools';
import { startTools } from './tools';

/** The two app ids of the smoke: the real installation is never touched. */
const ADMIN_APP_ID = 'copland.nod.smoke-admin';
const PERSON_APP_ID = 'copland.nod.smoke-person';

/** One dev port per instance: neither is 5173, which a developer's `bun run app:dev` takes. */
const ADMIN_DEV_PORT = 5199;
const PERSON_DEV_PORT = 5200;

/** The two connected accounts this smoke creates. Fake addresses, like the fake tools. */
const ADMIN_EMAIL = 'admin@smoke.test';
const PERSON_EMAIL = 'person@smoke.test';

/** The guild name the host is booted with (`NOD_GUILD_NAME`), asserted by both pages. */
const GUILD_NAME = 'Smoke Guild';

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED_DIR = join(import.meta.dir, '.gerado');
const CONNECTED_DIR = join(GENERATED_DIR, 'connected');
const CONNECTED_TEMPLATE = join(import.meta.dir, 'connected.html');
const SEED = join(ROOT, 'resources', 'seed.json');
const SEED_BACKUP = join(GENERATED_DIR, 'seed.json.bak');
const TINYJS_JSON = join(ROOT, 'tinyjs.json');

/**
 * The PNG the admin uploads as the guild icon (SP05 §6): a small, real, versioned PNG of the
 * repository — the tray's (`docs/arquitetura.md`), 32×32 RGBA, 304 bytes. Nothing is invented and
 * nothing is copied: the runner reads this file once, hashes it and hands the page its base64url, so
 * both sides work with the same bytes and the digest compared at the end is the digest uploaded.
 */
const GUILD_ICON_PNG = join(ROOT, 'resources', 'tray.png');

/** The host's data dir: temp, wiped at start and at the end like the app data dirs. */
const HOST_DATA = join(CONNECTED_DIR, 'host-data');

/** Marker of the `connected.html` template, replaced by the JSON of that phase. */
const MARKER = '__CONFIG__';

const FINISH_TIMEOUT_MS = 180_000;
const HOST_BOOT_TIMEOUT_MS = 20_000;
const HOST_STOP_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 4000;

interface Step {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

interface SmokeResult {
  done: boolean;
  /** The phase and the launch nonce: what keeps a result from a previous launch out of this wait. */
  phase?: string;
  nonce?: string;
  steps: Step[];
  error?: string | null;
}

/**
 * The guild icon fixture of one run (SP05 §6): the bytes the admin's page uploads and the digest the
 * runner compares the person's file against. Base64url is the form `host.setGuildIcon` takes (SP03 §2).
 */
interface GuildIconFixture {
  /** The PNG, base64url without padding: exactly what travels in `host.setGuildIcon({ png })`. */
  png: string;
  /** Its SHA-256, lowercase hex: the digest the host answers and the signed body carries. */
  sha256: string;
}

/** One launch of the app: which app id, which dev port, which page phase. */
interface Phase {
  name:
    | 'admin-publish'
    | 'person-join'
    | 'admin-clear'
    | 'person-cleared'
    | 'admin-revoke'
    | 'person-signed-out';
  appId: string;
  devPort: number;
}

const PHASES: Phase[] = [
  { name: 'admin-publish', appId: ADMIN_APP_ID, devPort: ADMIN_DEV_PORT },
  { name: 'person-join', appId: PERSON_APP_ID, devPort: PERSON_DEV_PORT },
  { name: 'admin-clear', appId: ADMIN_APP_ID, devPort: ADMIN_DEV_PORT },
  { name: 'person-cleared', appId: PERSON_APP_ID, devPort: PERSON_DEV_PORT },
  { name: 'admin-revoke', appId: ADMIN_APP_ID, devPort: ADMIN_DEV_PORT },
  { name: 'person-signed-out', appId: PERSON_APP_ID, devPort: PERSON_DEV_PORT },
];

/** Data directory per app id, the way the runtime computes it on each system. */
function dataDir(appId: string): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', appId);
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), appId);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), appId);
}

/**
 * Entry ids of the temporary seeds. `TOOL_A_ID` is the admin's (and so the host's, the admin
 * publishing its own tools), `TOOL_B_ID` the second fake tool, and `PERSON_TOOL_A_ID` the id the
 * person's own release seed has for Tool A's address — the entry id the host does not hold.
 */
const TOOL_A_ID = 'tool-a';
const TOOL_B_ID = 'tool-b';
const PERSON_TOOL_A_ID = 'tool-a-old';

/**
 * Temporary seed of one app, the same shape `test/smoke/run.ts` writes: it exists only so
 * `gen-config` builds the runtime origin gate (`docs/arquitetura.md` §2) — every entry origin gets
 * `login.report`, which is what the adapter script calls when the tool enters the page — and so each
 * app id applies a local catalog on first boot.
 *
 * The two app ids are two machines with their own release seeds, and that is what the run needs:
 *
 *   - the admin's seed is the guild's own machine: it holds the two fake tools, the admin publishes
 *     them and the host keeps their ids — so `tool-a` is the granted entry the host holds;
 *   - the person's seed is another machine's: it knows Tool A's address under the entry id that
 *     release gave it, and nothing else. The granted entry (`tool-a`, the host's) therefore has **no
 *     local `tool` row** on P's machine: it exists only on the host (SP05 §2), which is the case
 *     `vault.save` had to refuse. Its origin stays in the gate, because the gate is built from this
 *     same file — without that the tool window could not report the login the cascade filled.
 */
function temporarySeed(tools: Tools, appId: string): string {
  const entries = [
    {
      id: appId === PERSON_APP_ID ? PERSON_TOOL_A_ID : TOOL_A_ID,
      title: 'Tool A',
      url: tools.originA,
      order: 10,
    },
    { id: TOOL_B_ID, title: 'Tool B', url: tools.originB, order: 20 },
  ].map((entry) => ({
    ...entry,
    icon: null,
    roles: [],
    views: [],
    auth: null,
    active: true,
  }));
  return (
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        roles: [{ id: 'admin', name: 'Admin', admin: true }],
        entries,
        invites: [],
        update: null,
      },
      null,
      2,
    ) + '\n'
  );
}

// ------------------------------------------------------------- the shared API contract

/**
 * `ApiContract`'s entries, read from the source at run time. B6 (#18) and B8a (#19) land the
 * connected-mode admin methods in parallel with this slice, and this smoke has to drive whatever
 * names they land; reading the contract is how it does that without hardcoding a guess.
 */
function contractEntries(): Record<string, string> {
  const source = readFileSync(join(ROOT, 'shared', 'types.ts'), 'utf8');
  const start = source.indexOf('export interface ApiContract {');
  if (start < 0) throw new Error('shared/types.ts has no ApiContract');
  const body = source.slice(start, source.indexOf('\n}', start));
  // One entry per `  '<method>': [` line, sliced up to the next one: an entry's own text carries
  // `];` (`roles: Id[];`), so the closing bracket is not a boundary.
  const found: { name: string; from: number }[] = [];
  const pattern = /^\s*'([^']+)':\s*\[/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) found.push({ name: match[1], from: match.index });
  const entries: Record<string, string> = {};
  for (let index = 0; index < found.length; index++) {
    const to = index + 1 < found.length ? found[index + 1].from : body.length;
    entries[found[index].name] = body.slice(found[index].from, to);
  }
  return entries;
}

/** The methods this smoke needs, as `shared/types.ts` declares them at this run. */
interface Methods {
  /** B8a's "publish the local tools as org tools, once"; null while no such method exists. */
  publish: string | null;
  /** Whether the publish method takes SP03 §2's `BootstrapRequest` body instead of nothing. */
  publishBody: boolean;
  /** "create person + access code" (SP05 §3), `invites.issue` in the same contract. */
  personCreate: string | null;
  /** Whether that method takes the person's email and name (the connected shape). */
  personCreateEmail: boolean;
}

function resolveMethods(): Methods {
  const entries = contractEntries();
  const publish =
    ['host.bootstrap', 'catalog.bootstrap', 'admin.bootstrap', 'host.publishTools'].find(
      (name) => entries[name] !== undefined,
    ) ?? null;
  const publishText = publish === null ? '' : entries[publish];
  const personCreate =
    ['people.create', 'invites.issue'].find((name) => entries[name] !== undefined) ?? null;
  return {
    publish,
    // A method that takes nothing declares `void`; one that mirrors the host route names its fields.
    publishBody: publish !== null && !/\bvoid\b/.test(publishText) && /\btools\b|\broles\b/.test(publishText),
    personCreate,
    personCreateEmail: personCreate !== null && /\bemail\b/.test(entries[personCreate]),
  };
}

// ------------------------------------------------------------- the app launches

/** `bun scripts/gen-config.ts dev`, with the smoke id and dev port; the last call drops both. */
function runGenConfig(appId: string | null, devPort: number | null): { code: number; output: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  if (appId !== null) env.NOD_APP_ID = appId;
  else delete env.NOD_APP_ID;
  if (devPort !== null) env.NOD_DEV_PORT = String(devPort);
  else delete env.NOD_DEV_PORT;
  const result = Bun.spawnSync(['bun', 'scripts/gen-config.ts', 'dev'], {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode ?? -1,
    output: (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? ''),
  };
}

/** Writes the page of one phase, with the JSON of that launch in the template's one marker. */
function generatePage(
  phase: Phase,
  nonce: string,
  tools: Tools,
  address: string,
  deskOrigin: string,
  methods: Methods,
  icon: GuildIconFixture,
): string {
  const template = readFileSync(CONNECTED_TEMPLATE, 'utf8');
  if (template.split(MARKER).length !== 2) {
    throw new Error(`the template ${CONNECTED_TEMPLATE} must hold exactly one ${MARKER} marker`);
  }
  const config = JSON.stringify({
    phase: phase.name,
    nonce,
    address,
    guild: GUILD_NAME,
    desk: deskOrigin,
    originA: tools.originA,
    adminEmail: ADMIN_EMAIL,
    personEmail: PERSON_EMAIL,
    methods,
    // SP05 §6: the PNG the admin's page uploads, and the digest it must come back.
    guildIcon: { png: icon.png, sha256: icon.sha256 },
  });
  const page = join(CONNECTED_DIR, `${phase.name}.html`);
  writeFileSync(page, template.replace(MARKER, () => config));
  return page;
}

/** `true` while the process (or the group) still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills the app and its children (the process group catches the frontend server). */
async function killTree(app: ChildProcess): Promise<void> {
  const pid = app.pid;
  if (pid === undefined) return;
  if (alive(pid)) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already dead */
    }
    const limit = Date.now() + 3000;
    while (Date.now() < limit && alive(pid)) await Bun.sleep(100);
  }
  if (alive(pid)) {
    Bun.spawnSync(['pkill', '-P', String(pid)], { stdout: 'ignore', stderr: 'ignore' });
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

/**
 * Waits for `smoke_result.done` of **this** launch in the app's store.json: the nonce the runner
 * put in the page is what tells a fresh result from the one the previous launch of the same app id
 * left there.
 */
async function waitForResult(
  app: ChildProcess,
  box: { error: string | null },
  appId: string,
  nonce: string,
): Promise<{ ok: boolean; error: string | null; steps: Step[] }> {
  const path = join(dataDir(appId), 'store.json');
  const start = Date.now();
  let last: SmokeResult | null = null;
  while (Date.now() - start < FINISH_TIMEOUT_MS) {
    if (box.error !== null) return { ok: false, error: box.error, steps: last?.steps ?? [] };
    if (app.exitCode !== null || app.signalCode !== null) {
      return {
        ok: false,
        error: `the app exited before writing the result (code ${app.exitCode}, signal ${app.signalCode})`,
        steps: last?.steps ?? [],
      };
    }
    await Bun.sleep(200);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const result = raw['smoke_result'] as SmokeResult | undefined;
      if (!result || result.nonce !== nonce) continue;
      last = result;
      if (result.done === true) return { ok: true, error: null, steps: result.steps ?? [] };
    } catch {
      /* store.json may be mid-write; try again next cycle */
    }
  }
  return {
    ok: false,
    error: `timeout (${FINISH_TIMEOUT_MS} ms) waiting for smoke_result.done`,
    steps: last?.steps ?? [],
  };
}

/** One launch of the app for one phase; returns the phase's steps. */
async function runPhase(
  phase: Phase,
  tools: Tools,
  deskOrigin: string,
  address: string,
  methods: Methods,
  icon: GuildIconFixture,
): Promise<{ ok: boolean; error: string | null; steps: Step[] }> {
  const nonce = crypto.randomUUID();
  // The seed of this app id: `gen-config` reads it here (the runtime gate of `login.report`) and the
  // app reads it at boot (its local catalog, applied on the first one). Two machines, two seeds.
  writeFileSync(SEED, temporarySeed(tools, phase.appId));
  const gen = runGenConfig(phase.appId, phase.devPort);
  if (gen.code !== 0) {
    return { ok: false, error: `gen-config failed (code ${gen.code}): ${gen.output.trim()}`, steps: [] };
  }
  const page = generatePage(phase, nonce, tools, address, deskOrigin, methods, icon);

  const app = spawn('tinyjs', ['dev'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TINYJS_HTML: page,
      NOD_APP_ID: phase.appId,
      NOD_DEV_PORT: String(phase.devPort),
    },
  });
  let output = '';
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

  try {
    const result = await waitForResult(app, box, phase.appId, nonce);
    if (!result.ok && output.trim().length > 0) {
      return { ...result, error: `${result.error}\n--- app output ---\n${output.trim()}` };
    }
    return result;
  } finally {
    await killTree(app);
  }
}

// ------------------------------------------------------------- the host process

interface HostControl {
  port: number;
  env: Record<string, string | undefined>;
  start(): Promise<string>;
  stop(): Promise<string>;
  running(): boolean;
  kill(): void;
}

/** A free loopback port: the host's `PORT` refuses 0, so one is reserved and released. */
function freePort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  const port = server.port;
  server.stop(true);
  return port;
}

async function answersHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The one host of the smoke: `bun host/main.ts` on a temp data dir. `start` and `stop` are what the
 * desk exposes to the person page — SP05 §5.5's network switch is this process.
 */
function hostControl(dataDirPath: string): HostControl {
  const port = freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    NOD_DATA: dataDirPath,
    NOD_DEV: '1',
    NOD_PUBLIC_URL: `http://127.0.0.1:${port}`,
    NOD_GUILD_NAME: GUILD_NAME,
    PORT: String(port),
  };
  let child: ChildProcess | null = null;
  let output = '';
  const append = (chunk: Buffer | string): void => {
    output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
  };

  return {
    port,
    env,
    running: () => child !== null,
    async start(): Promise<string> {
      if (child !== null) return 'host already up';
      const spawned = spawn('bun', ['host/main.ts'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      child = spawned;
      output = '';
      spawned.stdout?.on('data', append);
      spawned.stderr?.on('data', append);
      const limit = Date.now() + HOST_BOOT_TIMEOUT_MS;
      while (Date.now() < limit) {
        if (await answersHealth(port)) return `host up on 127.0.0.1:${port}`;
        if (spawned.exitCode !== null) throw new Error(`the host exited ${spawned.exitCode}: ${output.trim().slice(-300)}`);
        await Bun.sleep(150);
      }
      throw new Error(`the host did not answer /health in ${HOST_BOOT_TIMEOUT_MS} ms: ${output.trim().slice(-300)}`);
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

/**
 * SP07 §3's one-time setup code, through the real command, over the same environment the host booted
 * with. The code is returned to the caller and never printed: it goes to the desk, which is how the
 * admin's page receives it (SP02 §3's "printed to the terminal that ran it" — here, to the process
 * that started the host, which hands it over the way the admin would).
 */
function issueSetupCode(env: Record<string, string | undefined>): string {
  const result = Bun.spawnSync(['bun', 'host/cli/setup-code.ts'], {
    cwd: ROOT,
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

// ------------------------------------------------------------- the desk

interface Desk {
  origin: string;
  /** P's access code, once the admin's page handed it over; null before that. */
  handedOver(): string | null;
  stop(): void;
}

function deskJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * The out-of-band channel of the smoke, on loopback: the admin page's own terminal (the setup code)
 * and the admin's chat (P's access code), plus the network switch of SP05 §5.5. Codes live in this
 * process' memory and in the page's; no request body is ever logged.
 */
function startDesk(deps: {
  address: string;
  setupCode: string;
  host: HostControl;
}): Desk {
  let personCode: string | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/desk/admin') {
          return deskJson({ ok: true, address: deps.address, guild: GUILD_NAME, code: deps.setupCode });
        }
        if (url.pathname === '/desk/handover' && request.method === 'POST') {
          const body = (await request.json()) as { code?: unknown };
          if (typeof body.code !== 'string' || body.code.trim().length === 0) {
            return deskJson({ ok: false, error: 'no code' }, 400);
          }
          personCode = body.code.trim();
          return deskJson({ ok: true });
        }
        if (url.pathname === '/desk/person') {
          if (personCode === null) return deskJson({ ok: false, error: 'no code handed over yet' }, 409);
          return deskJson({ ok: true, address: deps.address, guild: GUILD_NAME, code: personCode });
        }
        if (url.pathname === '/desk/host' && request.method === 'POST') {
          const body = (await request.json()) as { action?: unknown };
          if (body.action === 'stop') return deskJson({ ok: true, detail: await deps.host.stop() });
          if (body.action === 'start') return deskJson({ ok: true, detail: await deps.host.start() });
          return deskJson({ ok: false, error: 'unknown action' }, 400);
        }
      } catch (error) {
        // The reason never echoes the request (which may carry a code): a static message.
        return deskJson({ ok: false, error: error instanceof Error ? error.message : 'desk failure' }, 500);
      }
      return deskJson({ ok: false, error: 'unknown path' }, 404);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    handedOver: () => personCode,
    stop: () => server.stop(true),
  };
}

// ------------------------------------------------------------- the host's own rows

/**
 * What the host holds after the run, read straight from its SQLite (WAL: a reader does not block the
 * writer). SP05 §5.5 asks for P's events "on the host", and this is the host's own answer; the same
 * rows are what `GET /v1/admin/events` lists, and reading them here needs no admin token.
 */
interface HostRows {
  lines: string[];
  /** P's event kinds on the host; null when the host holds no such person. */
  personKinds: Record<string, number> | null;
  personEvents: number;
}

function hostRows(personEmail: string): HostRows {
  const file = join(HOST_DATA, 'host.db');
  if (!existsSync(file)) return { lines: ['(the host database is missing)'], personKinds: null, personEvents: 0 };
  const db = new Database(file, { readonly: true });
  try {
    const count = (sql: string, params: unknown[] = []): number =>
      (db.query(sql).get(...params) as { n: number } | null)?.n ?? 0;
    const person = db.query('SELECT id FROM people WHERE email = ?').get(personEmail) as
      | { id: string }
      | null;
    const lines = [
      `people: ${count('SELECT COUNT(*) AS n FROM people')}`,
      `roles: ${count('SELECT COUNT(*) AS n FROM roles')}`,
      `org entries: ${count("SELECT COUNT(*) AS n FROM entries WHERE scope = 'org'")}`,
      `grants: ${count('SELECT COUNT(*) AS n FROM grants')}`,
    ];
    if (person === null) {
      lines.push(`events of ${personEmail}: (no such person on the host)`);
      return { lines, personKinds: null, personEvents: 0 };
    }
    const rows = db
      .query('SELECT kind, COUNT(*) AS n FROM events WHERE person_id = ? GROUP BY kind ORDER BY kind')
      .all(person.id) as { kind: string; n: number }[];
    const personKinds: Record<string, number> = {};
    for (const row of rows) personKinds[row.kind] = row.n;
    const personEvents = rows.reduce((sum, row) => sum + row.n, 0);
    lines.push(
      `events of ${personEmail}: ${personEvents}` +
        (rows.length === 0 ? '' : ` (${rows.map((row) => `${row.kind}×${row.n}`).join(', ')})`),
    );
    return { lines, personKinds, personEvents };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------- the admin Nod's own rows

/** The id the host holds for an email; `null` when the host has no such person. */
function hostPersonId(email: string): string | null {
  const file = join(HOST_DATA, 'host.db');
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true });
  try {
    const row = db.query('SELECT id FROM people WHERE email = ?').get(email) as { id: string } | null;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

/**
 * The admin Nod's vault row after the run — read before `clean()` wipes the app data dir. It is F1's
 * proof on the real surface: the credential saved **before** the join belongs to the guild person
 * the local account became, and its keychain key was renamed with it (the keychain itself is the
 * OS's; the page's own `vault.reveal` is what proves the value opens under the new key).
 */
interface AdminVault {
  lines: string[];
  personId: string | null;
  keychainKey: string | null;
}

function adminVault(): AdminVault {
  const file = join(dataDir(ADMIN_APP_ID), 'nod.db');
  if (!existsSync(file)) return { lines: ["the admin's database is missing"], personId: null, keychainKey: null };
  const db = new Database(file, { readonly: true });
  try {
    const row = db.query('SELECT person_id, keychain_key FROM vault_item WHERE tool_id = ?').get(TOOL_A_ID) as
      | { person_id: string; keychain_key: string }
      | null;
    const people = db.query('SELECT COUNT(*) AS n FROM person').get() as { n: number };
    return {
      lines: [
        `people: ${people.n} (expected 1: the adopted account)`,
        `vault row of ${TOOL_A_ID}: ${
          row === null ? '(missing)' : `person ${row.person_id}, key ${row.keychain_key}`
        }`,
      ],
      personId: row?.person_id ?? null,
      keychainKey: row?.keychain_key ?? null,
    };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------- P's own rows

/**
 * P's database after the run — read before `clean()` wipes the app data dir, and read-only, the way
 * the host's rows are. It is the second half of the real-surface proof of SP05 §2's vault fix: the
 * credential P saved in step 3.7 is stored for the **host's** entry id (which is what the snapshot
 * brought), with the host entry's origin, and the machine has no `tool` row of that id behind it —
 * the tool exists only on the host.
 */
interface PersonVault {
  lines: string[];
  /** The item's origin, when the item of the granted tool is there; null otherwise. */
  origin: string | null;
  /** Local `tool` rows of the granted entry id: the fix is about this being zero. */
  localRows: number;
}

function personVault(expectedOrigin: string): PersonVault {
  const file = join(dataDir(PERSON_APP_ID), 'nod.db');
  if (!existsSync(file))
    return { lines: ["P's database is missing"], origin: null, localRows: -1 };
  const db = new Database(file, { readonly: true });
  try {
    // bun:sqlite hands `get()` back as `unknown`; these three reads are the shape of this query's
    // own SELECT, the way `hostRows` reads the host's.
    const item = db.query('SELECT origin FROM vault_item WHERE tool_id = ?').get(TOOL_A_ID) as
      | { origin: string | null }
      | null;
    const local = db.query('SELECT COUNT(*) AS n FROM tool WHERE id = ?').get(TOOL_A_ID) as {
      n: number;
    };
    const all = db.query('SELECT COUNT(*) AS n FROM vault_item').get() as { n: number };
    return {
      lines: [
        `vault items: ${all.n}`,
        `item of ${TOOL_A_ID}: ${
          item === null ? '(missing)' : `origin ${JSON.stringify(item.origin)}`
        } (expected ${JSON.stringify(expectedOrigin)})`,
        `local ${TOOL_A_ID} rows in tool: ${local.n} (expected 0)`,
      ],
      origin: item?.origin ?? null,
      localRows: local.n,
    };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------- the guild icon on P's disk

/** What the runner read on P's disk: the lines it prints, and whether it is what SP04 §2 says. */
interface IconFileCheck {
  lines: string[];
  ok: boolean;
}

/**
 * SP04 §2/SP05 §6, the runner's half of the proof: the file the app itself wrote under its own data
 * dir. The page cannot report this — where that directory is, is this runner's own `dataDir()` — so
 * the last link of the chain is read here: the bytes on P's disk hash to what the host answered for
 * the admin's upload, and the icon is the guild's own PNG, not another one.
 */
async function personGuildIconFile(icon: GuildIconFixture): Promise<IconFileCheck> {
  const file = join(dataDir(PERSON_APP_ID), GUILD_ICON_FILE);
  if (!existsSync(file)) {
    return {
      lines: [`${GUILD_ICON_FILE}: (missing), the uploaded PNG's sha256 is ${digestHead(icon.sha256)}`],
      ok: false,
    };
  }
  const bytes = new Uint8Array(readFileSync(file));
  const observed = await sha256Hex(bytes);
  return {
    lines: [
      `${GUILD_ICON_FILE}: ${bytes.byteLength} byte(s), sha256 ${digestHead(observed)} ` +
        `(the uploaded PNG's ${digestHead(icon.sha256)})`,
    ],
    ok: observed === icon.sha256,
  };
}

/** The same file after the admin removed the icon: SP04 §2's `null` deletes it on the next sync. */
function personGuildIconGone(): IconFileCheck {
  const file = join(dataDir(PERSON_APP_ID), GUILD_ICON_FILE);
  const size = existsSync(file) ? readFileSync(file).byteLength : null;
  return {
    lines: [`${GUILD_ICON_FILE}: ${size === null ? '(gone)' : `still there (${size} bytes)`}`],
    ok: size === null,
  };
}

/** Twelve hex of a digest: enough to compare two of them by eye, and the PNG it names is public. */
function digestHead(digest: string): string {
  return `${digest.slice(0, 12)}…`;
}

// ------------------------------------------------------------- main

async function main(): Promise<number> {
  if (existsSync(SEED) && !process.argv.includes('--force')) {
    console.error("refused: resources/seed.json exists (it is the owner's private seed).");
    console.error('this smoke writes a temporary seed at that path; run with --force to move it');
    console.error(`to ${SEED_BACKUP} and restore it at the end.`);
    return 2;
  }

  mkdirSync(CONNECTED_DIR, { recursive: true });
  const previousTinyjsJson = existsSync(TINYJS_JSON) ? readFileSync(TINYJS_JSON, 'utf8') : null;

  let tools: Tools | null = null;
  let desk: Desk | null = null;
  let host: HostControl | null = null;
  let seedMoved = false;
  let cleaned = false;

  const clean = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (host !== null) {
      try {
        if (host.running()) await host.stop();
      } catch {
        /* the host is going away anyway */
      }
      host.kill();
    }
    desk?.stop();
    tools?.stop();
    rmSync(SEED, { force: true });
    if (seedMoved) {
      renameSync(SEED_BACKUP, SEED);
      console.log('private seed restored');
    }
    const finalGen = runGenConfig(null, null);
    if (finalGen.code !== 0) {
      console.error(`final gen-config failed (code ${finalGen.code}):\n${finalGen.output.trim()}`);
      if (previousTinyjsJson !== null) {
        writeFileSync(TINYJS_JSON, previousTinyjsJson);
        console.error('tinyjs.json restored to its previous content');
      } else {
        rmSync(TINYJS_JSON, { force: true });
      }
    } else {
      console.log('tinyjs.json regenerated in dev');
    }
    // The two app data dirs and the host's temp data dir go with it; the owner's install is
    // untouchable (different app ids).
    rmSync(dataDir(ADMIN_APP_ID), { recursive: true, force: true });
    rmSync(dataDir(PERSON_APP_ID), { recursive: true, force: true });
    rmSync(CONNECTED_DIR, { recursive: true, force: true });
    console.log('smoke app data wiped (both app ids) and the temp data dir removed');
  };

  // A Ctrl-C in the middle of the run cannot leave the app or the host up, or the seed out of place.
  const onSignal = (): void => {
    void clean().then(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (existsSync(SEED)) {
      renameSync(SEED, SEED_BACKUP);
      seedMoved = true;
      console.log(`private seed moved to ${SEED_BACKUP}`);
    }

    tools = startTools();
    console.log(
      `local tools: A=${tools.originA} B=${tools.originB} (fake servers, loopback only)`,
    );

    // Every phase writes the temporary seed of its own app id before `gen-config` runs: the admin's
    // machine and the person's are not the same installation, and the person's has no local row for
    // the tool the admin grants (see `temporarySeed`).
    mkdirSync(join(ROOT, 'resources'), { recursive: true });

    // Both app ids start from nothing: a repeated run must not inherit a host row or a person.
    for (const appId of [ADMIN_APP_ID, PERSON_APP_ID]) {
      rmSync(dataDir(appId), { recursive: true, force: true });
    }
    rmSync(HOST_DATA, { recursive: true, force: true });
    console.log('smoke app data wiped before the run (both app ids)');

    host = hostControl(HOST_DATA);
    console.log(await host.start());
    const setupCode = issueSetupCode(host.env);
    console.log(`setup code issued by host/cli/setup-code.ts (${setupCode.length} chars, not printed)`);

    const methods = resolveMethods();
    console.log(
      `contract: publish=${methods.publish ?? '(none in ApiContract — B6/B8a not landed)'}` +
        `${methods.publish ? ` body=${methods.publishBody}` : ''}, ` +
        `person=${methods.personCreate ?? '(none)'} email=${methods.personCreateEmail}`,
    );

    const address = `http://127.0.0.1:${host.port}`;
    desk = startDesk({ address, setupCode, host });

    // SP05 §6: the fixture both halves of the icon proof work with. Reading the repository's own PNG
    // here is what lets the runner hash exactly the bytes the page uploads.
    if (!existsSync(GUILD_ICON_PNG)) {
      console.error(`the guild icon fixture is missing: ${GUILD_ICON_PNG}`);
      return 1;
    }
    const iconBytes = new Uint8Array(readFileSync(GUILD_ICON_PNG));
    const icon: GuildIconFixture = { png: toBase64url(iconBytes), sha256: await sha256Hex(iconBytes) };
    console.log(
      `guild icon fixture: ${GUILD_ICON_PNG} (${iconBytes.byteLength} bytes, ` +
        `sha256 ${digestHead(icon.sha256)})`,
    );

    let failed = false;
    const phaseResults: { name: string; steps: number }[] = [];
    for (const phase of PHASES) {
      console.log(`\nphase ${phase.name} (app id ${phase.appId}, dev port ${phase.devPort})`);
      const result = await runPhase(phase, tools, desk.origin, address, methods, icon);
      for (const step of result.steps) {
        console.log(`${step.ok ? 'ok    ' : 'FAILED'} ${step.step} (${step.ms} ms) ${step.detail}`);
      }
      if (!result.ok) {
        console.error(`phase ${phase.name} without result: ${result.error}`);
        failed = true;
      }
      if (!result.steps.every((step) => step.ok)) failed = true;
      phaseResults.push({ name: phase.name, steps: result.steps.length });

      // SP05 §6, the runner's half: what P's own disk holds after the phase that chose the guild
      // icon, and after the phase that saw the admin remove it. Read here, before `clean()` wipes the
      // app data dirs — and read only here, because the file belongs to the app and the page never
      // learns where that directory is.
      if (phase.name === 'person-join') {
        const check = await personGuildIconFile(icon);
        console.log("\nP's guild icon file after the phase (SP05 §6):");
        for (const line of check.lines) console.log(`  ${line}`);
        if (!check.ok) {
          console.error("P's guild-icon.png is not the PNG the admin uploaded");
          failed = true;
        }
      }
      if (phase.name === 'person-cleared') {
        const check = personGuildIconGone();
        console.log("\nP's guild icon file after the clear (SP05 §6):");
        for (const line of check.lines) console.log(`  ${line}`);
        if (!check.ok) {
          console.error("P's guild-icon.png survived the sync that carried guildIcon: null");
          failed = true;
        }
      }

      // The person's phase is the one that needs the code the admin handed over; without it the
      // later phases would fail for the wrong reason and say nothing about the flow.
      if (phase.name === 'admin-publish' && desk.handedOver() === null) {
        console.error('the admin phase did not hand P\'s access code over: the person phases are skipped');
        return 1;
      }
    }

    const rows = hostRows(PERSON_EMAIL);
    console.log('\nhost rows after the run:');
    for (const line of rows.lines) console.log(`  ${line}`);

    // SP05 §5.5: "network on: events are sent and show on the host". P's rows are the proof, and the
    // `locked` one can only come from the step run while the host process was down: it is on the
    // host because the reconnect pushed the backlog.
    if (rows.personEvents === 0) {
      console.error('the host holds no event of the smoke person (SP05 §5.5: the events are sent)');
      failed = true;
    } else if (rows.personKinds === null || (rows.personKinds['locked'] ?? 0) === 0) {
      console.error('the host holds no `locked` event of the smoke person: the offline backlog did not go up');
      failed = true;
    }

    // SP05 §2: the credential of a tool that exists only on the host. P's seed has no row for the
    // granted entry id, so the item can only be there if `vault.save` took the entry from the
    // effective catalog and `vault_item` stopped requiring a local `tool` row.
    const vaultRows = personVault(tools.originA);
    console.log("\nP's vault rows after the run:");
    for (const line of vaultRows.lines) console.log(`  ${line}`);
    if (vaultRows.localRows !== 0) {
      console.error(`P's catalog holds a local \`tool\` row for ${TOOL_A_ID}: that is not the host-only case`);
      failed = true;
    }
    if (vaultRows.origin !== tools.originA) {
      console.error(
        `P has no credential for ${TOOL_A_ID} on ${tools.originA} (origin ${JSON.stringify(vaultRows.origin)})`,
      );
      failed = true;
    }

    // F1: the admin Nod had a local account with the guild's email and a credential saved before
    // the join. The join adopted it, so the vault row has to carry the guild's person id and the
    // keychain key of that id — the page's own reveal (step 2.4c) is what proves the value moved.
    const guildPerson = hostPersonId(ADMIN_EMAIL);
    const adopted = adminVault();
    console.log("\nthe admin Nod's vault row after the adopt (F1):");
    for (const line of adopted.lines) console.log(`  ${line}`);
    if (guildPerson === null) {
      console.error('the host holds no person for the smoke admin');
      failed = true;
    } else {
      if (adopted.personId !== guildPerson) {
        console.error(
          `the credential of ${TOOL_A_ID} belongs to ${JSON.stringify(adopted.personId)}, ` +
            `not to the guild person ${guildPerson}`,
        );
        failed = true;
      }
      if (adopted.keychainKey !== `nod.cred.${guildPerson}.${TOOL_A_ID}`) {
        console.error(
          `the keychain key of ${TOOL_A_ID} is ${JSON.stringify(adopted.keychainKey)}, ` +
            `expected nod.cred.${guildPerson}.${TOOL_A_ID}`,
        );
        failed = true;
      }
    }

    if (failed) {
      console.error('connected smoke failed');
      return 1;
    }
    const steps = phaseResults.reduce((sum, entry) => sum + entry.steps, 0);
    console.log(
      `connected smoke ok: ${PHASES.length} phases, ${steps} steps, ` +
        `${phaseResults.map((entry) => `${entry.name}:${entry.steps}`).join(' ')}`,
    );
    return 0;
  } finally {
    await clean();
  }
}

process.exit(await main());
