// Real-page UI smoke of Nod (story checks #24, #25, #27–#35).
//
//   bun test/smoke/ui.ts            # refuses when resources/seed.json exists
//   bun test/smoke/ui.ts --force    # moves the private seed to test/smoke/.gerado/seed.json.bak
//                                   # and restores it at the end
//
// Unlike `run.ts` and `connected.ts`, this smoke renders the real page: the main window loads a
// generated HTML that imports `src/app.ts` exactly as `index.html` does, plus
// `test/smoke/ui-driver.ts` after it. The driver sets the world up over the real RPC path and then
// drives the real screens with DOM events; the runner only starts the world (host, fake tools) and
// reads the app store.
//
// One host process, five app ids: the admin, the person (P), a second member (Q), P's second
// machine, and no sixth — the admin is launched three times, the person twice. The launches are
// sequential; the host's data dir is the only state that carries between them.
//
// The page is served by the dev server `tinyjs dev` starts: the runner points `frontend.devUrl` at
// the generated file under `test/smoke/.gerado/ui/`, so the window is a real `http://` page on the
// same origin as its modules and the runtime's `tiny` bridge. The generated page carries no code,
// no password and no credential value; those live in the driver's memory and in the runner's.
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { HostControl, Tools } from './tools';
import {
  appDataDir as dataDir,
  freePort,
  generateDevConfig,
  issueSetupCode,
  killProcessTree,
  startHostControl,
  startTools,
  waitForStoredResult,
} from './tools';

const ADMIN_APP_ID = 'copland.nod.ui-admin';
const PERSON_APP_ID = 'copland.nod.ui-person';
const OTHER_APP_ID = 'copland.nod.ui-person2';
const PERSON_SECOND_APP_ID = 'copland.nod.ui-person3';
const APP_IDS = [ADMIN_APP_ID, PERSON_APP_ID, OTHER_APP_ID, PERSON_SECOND_APP_ID];

const ADMIN_EMAIL = 'admin@ui.test';
const PERSON_EMAIL = 'person@ui.test';
const OTHER_EMAIL = 'other@ui.test';
const ADMIN_NAME = 'Smoke Admin';
const PERSON_NAME = 'Smoke Person';
const OTHER_NAME = 'Smoke Other';
const GUILD_NAME = 'UI Smoke Guild';

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED_DIR = join(import.meta.dir, '.gerado');
const UI_DIR = join(GENERATED_DIR, 'ui');
const SEED = join(ROOT, 'resources', 'seed.json');
const SEED_BACKUP = join(GENERATED_DIR, 'seed.json.bak');
const TINYJS_JSON = join(ROOT, 'tinyjs.json');
const UI_DRIVER_ROUTE = '/test/smoke/ui-driver.ts';
const HOST_DATA = join(GENERATED_DIR, 'ui-smoke-host');

const FINISH_TIMEOUT_MS = 90_000;
const OUTPUT_LIMIT = 4000;

/** Tool ids of the temporary seeds (one per fake server, the leftovers have their own). */
const TOOL_A_ID = 'tool-a';
const TOOL_B_ID = 'tool-b';

interface Step {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

interface SmokeResult {
  ok: boolean;
  error: string | null;
  steps: Step[];
}

interface Phase {
  name: string;
  appId: string;
}

const PHASES: Phase[] = [
  { name: 'admin-setup', appId: ADMIN_APP_ID },
  { name: 'person-join', appId: PERSON_APP_ID },
  { name: 'person2-join', appId: OTHER_APP_ID },
  { name: 'admin-work', appId: ADMIN_APP_ID },
  { name: 'person-inbox', appId: PERSON_APP_ID },
  { name: 'other-accept', appId: OTHER_APP_ID },
  { name: 'person-second-machine', appId: PERSON_SECOND_APP_ID },
  { name: 'admin-final', appId: ADMIN_APP_ID },
];

/**
 * The temporary seed of one launch (the shape `test/smoke/run.ts` writes): `gen-config` reads it
 * for the runtime's origin gate and the app applies it on first boot. The person's seed carries two
 * local tools the host does not serve — the leftovers of #25 — and the second member's seed carries
 * only the tool the guild has, so it has nothing to keep.
 */
function temporarySeed(tools: Tools, appId: string): string {
  const base = { icon: null, roles: [], views: [], auth: null, active: true };
  const entries =
    appId === PERSON_APP_ID
      ? [
          { ...base, id: TOOL_B_ID, title: 'Tool B', url: tools.originB, order: 20 },
          { ...base, id: 'local-notes', title: 'Local Notes', url: tools.originC, order: 30 },
          {
            ...base,
            id: 'local-desk',
            title: 'Local Desk',
            url: `${tools.originB}/local`,
            order: 40,
          },
        ]
      : [
          { ...base, id: TOOL_A_ID, title: 'Tool A', url: tools.originA, order: 10 },
          { ...base, id: TOOL_B_ID, title: 'Tool B', url: tools.originB, order: 20 },
        ];
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

/** The generated page: the real entry, then the driver. It carries no secret. */
function generatePage(
  phase: Phase,
  nonce: string,
  devPort: number,
  deskOrigin: string,
  address: string,
  originC: string,
): { url: string; file: string } {
  const config = JSON.stringify({
    phase: phase.name,
    nonce,
    address,
    desk: deskOrigin,
    originC,
    adminEmail: ADMIN_EMAIL,
    personEmail: PERSON_EMAIL,
    otherEmail: OTHER_EMAIL,
    adminName: ADMIN_NAME,
    personName: PERSON_NAME,
    otherName: OTHER_NAME,
  });
  const html =
    '<!doctype html>\n' +
    '<html lang="en"><head><meta charset="utf-8"><title>Nod — UI smoke</title>' +
    '<link rel="stylesheet" href="/src/style.css"></head><body>' +
    '<div id="app"></div>' +
    `<script>window.__NOD_UI_SMOKE__ = ${config};</script>` +
    '<script type="module" src="/src/app.ts"></script>' +
    `<script type="module" src="${UI_DRIVER_ROUTE}"></script>` +
    '</body></html>\n';
  mkdirSync(UI_DIR, { recursive: true });
  const file = join(UI_DIR, `ui-${nonce}.html`);
  writeFileSync(file, html);
  // The URL the window loads: the dev server serves the project root, and the page lives under it.
  return { url: `http://127.0.0.1:${devPort}/test/smoke/.gerado/ui/${file.slice(UI_DIR.length + 1)}`, file };
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
 * The out-of-band channel: the setup code (the terminal that started the host), the access codes
 * (the admin's chat), and the host's stop/start. Codes live in this process' memory and in the
 * driver's; nothing is logged, written to a file or echoed back beyond the page that asked.
 */
function startDesk(deps: {
  address: string;
  setupCode: string;
  host: HostControl;
}): Desk {
  const codes: Partial<Record<'person' | 'other' | 'person2', string>> = {};
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/desk/setup') {
        return deskJson({ ok: true, code: deps.setupCode, address: deps.address });
      }
      if (url.pathname === '/desk/code' && req.method === 'POST') {
        const body: unknown = await req.json().catch(() => null);
        if (typeof body !== 'object' || body === null) return deskJson({ ok: false, error: 'bad body' }, 400);
        const { who, code } = body as { who?: unknown; code?: unknown };
        if (
          (who !== 'person' && who !== 'other' && who !== 'person2') ||
          typeof code !== 'string' ||
          code.length === 0
        ) {
          return deskJson({ ok: false, error: 'bad handover' }, 400);
        }
        codes[who] = code;
        return deskJson({ ok: true });
      }
      if (url.pathname === '/desk/code' && req.method === 'GET') {
        const who = url.searchParams.get('who') ?? '';
        const known = who === 'person' || who === 'other' || who === 'person2' ? codes[who] : null;
        return deskJson({ ok: true, code: known ?? null });
      }
      if (url.pathname === '/desk/host' && req.method === 'POST') {
        const body: unknown = await req.json().catch(() => null);
        if (typeof body !== 'object' || body === null) return deskJson({ ok: false, error: 'bad body' }, 400);
        const { action, minAppVersion } = body as {
          action?: unknown;
          minAppVersion?: unknown;
        };
        try {
          if (action === 'stop') return deskJson({ ok: true, detail: await deps.host.stop() });
          if (action === 'start') {
            const extra =
              typeof minAppVersion === 'string' ? { NOD_MIN_APP_VERSION: minAppVersion } : {};
            return deskJson({ ok: true, detail: await deps.host.start(extra) });
          }
          return deskJson({ ok: false, error: 'bad action' }, 400);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          return deskJson({ ok: false, error: why }, 500);
        }
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

// ------------------------------------------------------------- app launches

async function runPhase(
  phase: Phase,
  nonce: string,
  tools: Tools,
  deskOrigin: string,
  address: string,
): Promise<SmokeResult> {
  const devPort = freePort();
  writeFileSync(SEED, temporarySeed(tools, phase.appId));
  const gen = generateDevConfig(ROOT, phase.appId, devPort);
  if (gen.code !== 0) {
    return { ok: false, error: `gen-config failed (code ${gen.code}): ${gen.output.trim()}`, steps: [] };
  }
  const page = generatePage(phase, nonce, devPort, deskOrigin, address, tools.originC);
  pointDevUrl(page.url);

  const env: Record<string, string | undefined> = {
    ...process.env,
    NOD_APP_ID: phase.appId,
    NOD_DEV_PORT: String(devPort),
  };
  // The smoke never runs with the runtime trace (AGENTS.md): it prints the login adapter's EVAL and
  // every call. The child gets neither the debug flag nor a page override.
  delete env.TINYJS_DEBUG;
  delete env.TINYJS_HTML;

  const app = spawn('tinyjs', ['dev'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
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
    const result = await waitForStoredResult(
      app,
      box,
      join(dataDir(phase.appId), 'store.json'),
      nonce,
      'ui_smoke_result',
      FINISH_TIMEOUT_MS,
    );
    if (!result.ok && output.trim().length > 0) {
      return { ...result, error: `${result.error}\n--- app output ---\n${output.trim()}` };
    }
    return result;
  } finally {
    await killProcessTree(app);
    rmSync(page.file, { force: true });
  }
}

// ------------------------------------------------------------- main

async function main(): Promise<number> {
  if (existsSync(SEED) && !process.argv.includes('--force')) {
    console.error(
      `refusing to run: ${SEED} exists. Move it away or run again with --force ` +
        `(the smoke moves it to ${SEED_BACKUP} and restores it at the end).`,
    );
    return 2;
  }

  const previousTinyjsJson = existsSync(TINYJS_JSON) ? readFileSync(TINYJS_JSON, 'utf8') : null;
  let seedMoved = false;
  let tools: Tools | null = null;
  let host: ReturnType<typeof startHostControl> | null = null;
  let desk: Desk | null = null;

  const clean = (): void => {
    desk?.stop();
    desk = null;
    tools?.stop();
    tools = null;
    host?.kill();
    host = null;
    for (const appId of APP_IDS) rmSync(dataDir(appId), { recursive: true, force: true });
    rmSync(UI_DIR, { recursive: true, force: true });
    rmSync(HOST_DATA, { recursive: true, force: true });
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

  try {
    if (existsSync(SEED)) {
      mkdirSync(GENERATED_DIR, { recursive: true });
      renameSync(SEED, SEED_BACKUP);
      seedMoved = true;
      console.log(`private seed moved to ${SEED_BACKUP}`);
    }
    for (const appId of APP_IDS) rmSync(dataDir(appId), { recursive: true, force: true });
    rmSync(HOST_DATA, { recursive: true, force: true });
    rmSync(UI_DIR, { recursive: true, force: true });

    tools = startTools();
    console.log(
      `local tools: A=${tools.originA} B=${tools.originB} C=${tools.originC} (fake servers, loopback only)`,
    );

    host = startHostControl(ROOT, HOST_DATA, GUILD_NAME);
    console.log(await host.start());
    const setupCode = issueSetupCode(ROOT, host.env);
    console.log(`setup code issued by host/cli/setup-code.ts (${setupCode.length} chars, not printed)`);
    const address = `http://127.0.0.1:${host.port}`;
    desk = startDesk({ address, setupCode, host });

    let failed = false;
    for (const phase of PHASES) {
      const nonce = crypto.randomUUID();
      console.log(`\nphase ${phase.name} (app id ${phase.appId})`);
      const result = await runPhase(phase, nonce, tools, desk.origin, address);
      for (const step of result.steps) {
        console.log(`${step.ok ? 'ok    ' : 'FAILED'} ${step.step} (${step.ms} ms) ${step.detail}`);
      }
      if (!result.ok) {
        console.error(`phase ${phase.name} without result: ${result.error}`);
        failed = true;
      }
      if (!result.steps.every((step) => step.ok)) failed = true;
    }

    console.log(`\nui smoke: ${failed ? 'FAILED' : 'ok'} (${PHASES.length} phase(s))`);
    return failed ? 1 : 0;
  } finally {
    clean();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

process.exit(await main());
