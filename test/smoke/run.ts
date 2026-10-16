// Smoke runner for Bond on the real surface.
//
// Starts the real app (`tinyjs dev`) with the main window pointed at a test page (runtime recipe:
// `TINYJS_HTML=/abs/page.html tinyjs dev`). The page drives the API through the real path and
// writes the result to the app store; this runner reads `<app data>/store.json` and prints it step
// by step.
//
//   bun test/smoke/run.ts            # refuses when resources/seed.json exists
//   bun test/smoke/run.ts --force    # moves the private seed to test/smoke/.gerado/seed.json.bak
//                                    # and restores it at the end
//
// No external network: the "tools" are local servers (test/smoke/tools.ts). The scenario is built
// and torn down here: temporary seed, tinyjs.json, the page generated in test/smoke/.gerado/ and
// the smoke app data directory. Everything goes back to the previous state. Nothing here writes to
// `.build/`: `tinyjs dev` takes that directory as cwd and recreates it on start, wiping whatever is
// inside.
//
// The run holds its own dev port (`BOND_DEV_PORT`, `SMOKE_DEV_PORT` below) for `gen-config` and for
// the `tinyjs dev` child, so the smoke never takes the port a developer's `bun run app:dev` is
// already using; the last regeneration drops the variable and leaves the default 5173 config.
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { Tools } from './tools';
import { startTools } from './tools';

/** Smoke id: the real app runs under it so it never touches the owner's data. */
const APP_ID = 'studio.copland.bond.smoke';

/** Dev port of the smoke: never 5173, which is what a developer's `bun run app:dev` takes. */
const SMOKE_DEV_PORT = 5199;

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED_DIR = join(import.meta.dir, '.gerado');
const SMOKE_TEMPLATE = join(import.meta.dir, 'smoke.html');
const SMOKE_PAGE = join(GENERATED_DIR, 'smoke.html');
const SEED = join(ROOT, 'resources', 'seed.json');
const SEED_BACKUP = join(GENERATED_DIR, 'seed.json.bak');
const TINYJS_JSON = join(ROOT, 'tinyjs.json');
const EXPORT_PATH = join(GENERATED_DIR, 'events.jsonl');

/** Marker of the `smoke.html` template, replaced by the JSON of the origins. */
const MARKER = '__CONFIG__';

const FINISH_TIMEOUT_MS = 120_000;
const EXPECTED_STEPS = 14;
const OUTPUT_LIMIT = 4000;

/** A credential or a wrong secret never reaches the audit — the runner checks both. */
const FORBIDDEN_IN_EXPORT = ['secret-a', 'wrong'];

interface Step {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

interface SmokeResult {
  done: boolean;
  steps: Step[];
  error?: string | null;
}

/** Data directory per app id, the way the runtime computes it on each system. */
function dataDir(): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_ID);
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_ID);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), APP_ID);
}

/**
 * Temporary seed. It exists only so `gen-config` builds the origin gate: every entry origin gets
 * `login.report`, which is what the adapter script calls when the tool enters the page. The smoke
 * registers both entries again through the API — hence the minimal entries here. The provider and
 * tool C stay out: the cascade never injects outside the entry origin, and C's origin must NOT be
 * in the gate (step 10 checks what an ungated origin does).
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

/** Writes `test/smoke/.gerado/smoke.html` from the template, with the origins JSON in the marker. */
function generatePage(tools: Tools): void {
  const template = readFileSync(SMOKE_TEMPLATE, 'utf8');
  // Exactly one marker: `String.replace` would eat a second one in a comment and leave the page
  // with a bare `__CONFIG__` (a syntax error the runner would only see as "the app exited").
  if (template.split(MARKER).length !== 2) {
    throw new Error(`the template ${SMOKE_TEMPLATE} must hold exactly one ${MARKER} marker`);
  }
  const config = JSON.stringify({
    originA: tools.originA,
    originB: tools.originB,
    originC: tools.originC,
    exportPath: EXPORT_PATH,
  });
  writeFileSync(SMOKE_PAGE, template.replace(MARKER, () => config));
}

/**
 * `bun scripts/gen-config.ts dev`. With `smokeId`, the child gets `BOND_APP_ID` and `BOND_DEV_PORT`
 * and `tinyjs.json` comes out with the smoke id and the smoke dev origin; without it, the
 * environment goes without both keys — which is how the final regeneration puts back the id from
 * `tinyjs.base.json` and the default dev port.
 */
function runGenConfig(smokeId: boolean): { code: number; output: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  if (smokeId) {
    env.BOND_APP_ID = APP_ID;
    env.BOND_DEV_PORT = String(SMOKE_DEV_PORT);
  } else {
    delete env.BOND_APP_ID;
    delete env.BOND_DEV_PORT;
  }
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

/** Waits for `smoke_result.done` in the app's store.json (or the app dying/failing before that). */
async function waitForResult(
  app: ChildProcess,
  box: { error: string | null },
): Promise<{ ok: boolean; error: string | null; steps: Step[] }> {
  const path = join(dataDir(), 'store.json');
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
      if (!result) continue;
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

/** The audit export must exist, be valid JSONL line by line and never carry a credential. */
function checkExport(): { ok: boolean; detail: string } {
  if (!existsSync(EXPORT_PATH)) return { ok: false, detail: `missing ${EXPORT_PATH}` };
  const lines = readFileSync(EXPORT_PATH, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { ok: false, detail: 'the export has no line' };
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, detail: `line that is not JSON: ${line.slice(0, 120)}` };
    }
    if (typeof event !== 'object' || event === null) {
      return { ok: false, detail: 'line that is not a JSON object' };
    }
  }
  for (const needle of FORBIDDEN_IN_EXPORT) {
    if (lines.some((line) => line.includes(needle))) {
      return { ok: false, detail: `the export carries ${needle}` };
    }
  }
  return { ok: true, detail: `${lines.length} event(s), no secret` };
}

async function main(): Promise<number> {
  if (existsSync(SEED) && !process.argv.includes('--force')) {
    console.error("refused: resources/seed.json exists (it is the owner's private seed).");
    console.error('this smoke writes a temporary seed at that path; run with --force to move it');
    console.error(`to ${SEED_BACKUP} and restore it at the end.`);
    return 2;
  }

  mkdirSync(GENERATED_DIR, { recursive: true });
  rmSync(EXPORT_PATH, { force: true });
  const previousTinyjsJson = existsSync(TINYJS_JSON) ? readFileSync(TINYJS_JSON, 'utf8') : null;

  let tools: Tools | null = null;
  let app: ChildProcess | null = null;
  let seedMoved = false;
  let appOutput = '';
  const box: { error: string | null } = { error: null };
  const appendOutput = (chunk: Buffer | string): void => {
    appOutput = (appOutput + chunk.toString()).slice(-OUTPUT_LIMIT);
  };

  let cleaned = false;
  const clean = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (app) await killTree(app);
    tools?.stop();
    rmSync(SEED, { force: true });
    if (seedMoved) {
      renameSync(SEED_BACKUP, SEED);
      console.log('private seed restored');
    }
    const finalGen = runGenConfig(false);
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
  };
  // A Ctrl-C in the middle of the run cannot leave the app up or the owner's seed out of place.
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
      `local tools: A=${tools.originA} B=${tools.originB} C=${tools.originC} provider=${tools.originProvider}`,
    );

    mkdirSync(join(ROOT, 'resources'), { recursive: true });
    writeFileSync(SEED, temporarySeed(tools));

    const gen = runGenConfig(true);
    if (gen.code !== 0) {
      console.error(`gen-config failed (code ${gen.code}):\n${gen.output.trim()}`);
      return 3;
    }
    console.log('tinyjs.json generated in dev with the temporary seed');

    rmSync(dataDir(), { recursive: true, force: true });
    console.log(`smoke app data wiped: ${dataDir()}`);

    generatePage(tools);
    console.log(`smoke page: ${SMOKE_PAGE}`);

    app = spawn('tinyjs', ['dev'], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TINYJS_HTML: SMOKE_PAGE,
        BOND_APP_ID: APP_ID,
        BOND_DEV_PORT: String(SMOKE_DEV_PORT),
      },
    });
    app.stdout?.on('data', appendOutput);
    app.stderr?.on('data', appendOutput);
    app.on('error', (error) => {
      box.error = `failed to start the app: ${error.message}`;
      appendOutput(box.error);
    });
    console.log(
      `app: tinyjs dev (TINYJS_HTML=${SMOKE_PAGE}, BOND_APP_ID=${APP_ID}, BOND_DEV_PORT=${SMOKE_DEV_PORT})`,
    );

    const result = await waitForResult(app, box);
    for (const step of result.steps) {
      console.log(`${step.ok ? 'ok    ' : 'FAILED'} ${step.step} (${step.ms} ms) ${step.detail}`);
    }

    const exportCheck = checkExport();
    console.log(`export: ${exportCheck.ok ? 'ok' : 'FAILED'} ${exportCheck.detail}`);

    if (!result.ok) {
      console.error(`smoke without result: ${result.error}`);
      if (result.steps.length > 0) console.error(`(partial above: ${result.steps.length} step(s) recorded)`);
      if (appOutput.trim().length > 0) console.error(`--- app output ---\n${appOutput.trim()}`);
      return 1;
    }
    if (result.steps.length !== EXPECTED_STEPS) {
      console.error(`expected ${EXPECTED_STEPS} steps, got ${result.steps.length}`);
      return 1;
    }
    if (!result.steps.every((step) => step.ok)) {
      console.error('smoke failed');
      return 1;
    }
    if (!exportCheck.ok) {
      console.error(`export check failed: ${exportCheck.detail}`);
      return 1;
    }
    console.log(`smoke ok: ${result.steps.length} steps`);
    return 0;
  } finally {
    await clean();
  }
}

process.exit(await main());
