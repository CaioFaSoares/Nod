// Two-instance smoke of connected mode — SP05 §5 steps 2–5, story B11 (issue #22).
//
//   bun test/smoke/connected.ts            # refuses when resources/seed.json exists
//   bun test/smoke/connected.ts --force    # moves the private seed to test/smoke/.gerado/seed.json.bak
//                                          # and restores it at the end
//
// What runs here, all on loopback and with no external network:
//
//   - the real host (`bun host/main.ts`) on a free port, over a temp data dir, with `BOND_DEV=1`;
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
// in the order the acceptance needs: publish, join and reconnect, revoke, then the doomed sync.
//
//   phase admin-publish      SP05 §5.2  host.activate with the setup code, publish local tools,
//                                       create P with role `team`, grant the tool to `team`, sync
//   phase person-join        SP05 §5.3  P activates, sees the granted tool, saves a credential
//                            SP05 §5.5  and fills the login; host stopped: lock/unlock, tools still
//                                       there, `stale`; host restarted: sync pushes P's events
//   phase admin-revoke       SP05 §5.4  the admin revokes P
//   phase person-signed-out  SP05 §5.4  P's next sync: `signed-out`, org tools gone
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
import type { Tools } from './tools';
import { startTools } from './tools';

/** The two app ids of the smoke: the real installation is never touched. */
const ADMIN_APP_ID = 'studio.copland.bond.smoke-admin';
const PERSON_APP_ID = 'studio.copland.bond.smoke-person';

/** One dev port per instance: neither is 5173, which a developer's `bun run app:dev` takes. */
const ADMIN_DEV_PORT = 5199;
const PERSON_DEV_PORT = 5200;

/** The two connected accounts this smoke creates. Fake addresses, like the fake tools. */
const ADMIN_EMAIL = 'admin@smoke.test';
const PERSON_EMAIL = 'person@smoke.test';

/** The guild name the host is booted with (`BOND_GUILD_NAME`), asserted by both pages. */
const GUILD_NAME = 'Smoke Guild';

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED_DIR = join(import.meta.dir, '.gerado');
const CONNECTED_DIR = join(GENERATED_DIR, 'connected');
const CONNECTED_TEMPLATE = join(import.meta.dir, 'connected.html');
const SEED = join(ROOT, 'resources', 'seed.json');
const SEED_BACKUP = join(GENERATED_DIR, 'seed.json.bak');
const TINYJS_JSON = join(ROOT, 'tinyjs.json');

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

/** One launch of the app: which app id, which dev port, which page phase. */
interface Phase {
  name: 'admin-publish' | 'person-join' | 'admin-revoke' | 'person-signed-out';
  appId: string;
  devPort: number;
}

const PHASES: Phase[] = [
  { name: 'admin-publish', appId: ADMIN_APP_ID, devPort: ADMIN_DEV_PORT },
  { name: 'person-join', appId: PERSON_APP_ID, devPort: PERSON_DEV_PORT },
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
 * Temporary seed, the same shape `test/smoke/run.ts` writes: the gate needs the origin of every
 * entry (`login.report`, which is what the adapter calls when the tool enters the page), and both
 * app ids apply these two entries as their local catalog on first boot. The admin publishes them to
 * the host (SP05 §5.2), and the person's own local rows are what `vault.save` needs for the entry
 * that arrives from the snapshot (the id is the same on both sides).
 */
function temporarySeed(tools: Tools): string {
  const entries = [
    { id: 'tool-a', title: 'Tool A', url: tools.originA, order: 10 },
    { id: 'tool-b', title: 'Tool B', url: tools.originB, order: 20 },
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
  if (appId !== null) env.BOND_APP_ID = appId;
  else delete env.BOND_APP_ID;
  if (devPort !== null) env.BOND_DEV_PORT = String(devPort);
  else delete env.BOND_DEV_PORT;
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
): Promise<{ ok: boolean; error: string | null; steps: Step[] }> {
  const nonce = crypto.randomUUID();
  const gen = runGenConfig(phase.appId, phase.devPort);
  if (gen.code !== 0) {
    return { ok: false, error: `gen-config failed (code ${gen.code}): ${gen.output.trim()}`, steps: [] };
  }
  const page = generatePage(phase, nonce, tools, address, deskOrigin, methods);

  const app = spawn('tinyjs', ['dev'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TINYJS_HTML: page,
      BOND_APP_ID: phase.appId,
      BOND_DEV_PORT: String(phase.devPort),
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
    BOND_DATA: dataDirPath,
    BOND_DEV: '1',
    BOND_PUBLIC_URL: `http://127.0.0.1:${port}`,
    BOND_GUILD_NAME: GUILD_NAME,
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

    mkdirSync(join(ROOT, 'resources'), { recursive: true });
    writeFileSync(SEED, temporarySeed(tools));

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

    let failed = false;
    const phaseResults: { name: string; steps: number }[] = [];
    for (const phase of PHASES) {
      console.log(`\nphase ${phase.name} (app id ${phase.appId}, dev port ${phase.devPort})`);
      const result = await runPhase(phase, tools, desk.origin, address, methods);
      for (const step of result.steps) {
        console.log(`${step.ok ? 'ok    ' : 'FAILED'} ${step.step} (${step.ms} ms) ${step.detail}`);
      }
      if (!result.ok) {
        console.error(`phase ${phase.name} without result: ${result.error}`);
        failed = true;
      }
      if (!result.steps.every((step) => step.ok)) failed = true;
      phaseResults.push({ name: phase.name, steps: result.steps.length });

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
