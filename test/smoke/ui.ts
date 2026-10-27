// Real-page UI smoke of Nod (story checks #24, #25, #27–#38, and the RF-64 owner steps).
//
//   bun test/smoke/ui.ts            # refuses when resources/seed.json exists
//   bun test/smoke/ui.ts --force    # moves the private seed to test/smoke/.gerado/seed.json.bak
//                                   # and restores it at the end
//   bun test/smoke/ui.ts --runtime=electrobun --force
//
// A stage that fails stops the run (`failed` breaks the loop): the stages after it did not run, and
// the summary still names the planned stage/launch count.
//
// Unlike `run.ts` and `connected.ts`, this smoke renders the real page: the main window loads a
// generated HTML that imports `src/app.ts` exactly as `index.html` does, plus
// `test/smoke/ui-driver.ts` after it. The driver sets the world up over the real RPC path and then
// drives the real screens with DOM events; the runner only starts the world (host, fake tools) and
// reads the app store.
//
// One host process, four app ids: the admin (launched three times), the person P (twice), and two
// Nods of their own — #37's invite joiner and #38's seed importer, one launch each. The second
// member Q, the throwaway member the owner renames and deletes (RF-64) and P's second machine are
// headless (`test/smoke/headless.ts`): Bun calls to the host,
// run beside the GUI launch they don't depend on. The host's data dir is the only state that carries
// between stages; the GUI launches stay sequential because they share `tinyjs.json` and
// `resources/seed.json` at the project root.
//
// The page is served by the dev server `tinyjs dev` starts: the runner points `frontend.devUrl` at
// the generated file under `test/smoke/.gerado/ui/`, so the window is a real `http://` page on the
// same origin as its modules and the runtime's `tiny` bridge. The generated page carries no code,
// no password and no credential value; those live in the driver's memory and in the runner's. #38
// hands its page the path of a fake seed file under `.gerado/` — the file picker itself
// (`tiny.dialog`) is not driven by this smoke.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  acceptAllShares,
  activateWithAccessCode,
  joinWithInvite,
  type HeadlessMember,
} from './headless';
import { sha256Hex, toBase64url } from '../../shared/encoding';
import type { HostControl, SmokeLaunch, Tools } from './tools';
import {
  appDataDir as dataDir,
  freePort,
  generateElectrobunDevConfig,
  issueSetupCode,
  launchSmokeApp,
  smokeAppId,
  smokeRuntime,
  startHostControl,
  startTools,
  waitForStoredResult,
} from './tools';

/** The one runtime: Electrobun. */
const RUNTIME = smokeRuntime();

const ADMIN_APP_ID = smokeAppId('copland.nod.ui-admin', RUNTIME);
const PERSON_APP_ID = smokeAppId('copland.nod.ui-person', RUNTIME);
/** #37: a Nod with no account and no host — the invite of the guild, entered through the `+` tile. */
const THIRD_APP_ID = smokeAppId('copland.nod.ui-third', RUNTIME);
/** #38: a Nod with no account and no host, whose first run imports a seed file (RF-61). */
const SEED_APP_ID = smokeAppId('copland.nod.ui-seed', RUNTIME);
const APP_IDS = [ADMIN_APP_ID, PERSON_APP_ID, THIRD_APP_ID, SEED_APP_ID];

/** The driver's `PASSWORD`: a throwaway of throwaway accounts, never printed. */
const PASSWORD = 'smoke-ui-1';

const ADMIN_EMAIL = 'admin@ui.test';
const PERSON_EMAIL = 'person@ui.test';
const OTHER_EMAIL = 'other@ui.test';
const THIRD_EMAIL = 'third@ui.test';
/** RF-64 (0.5.3): the throwaway member the owner renames and deletes — a person of their own. */
const EXTRA_EMAIL = 'extra@ui.test';
const ADMIN_NAME = 'Smoke Admin';
const PERSON_NAME = 'Smoke Person';
const OTHER_NAME = 'Smoke Other';
const THIRD_NAME = 'Smoke Third';
const EXTRA_NAME = 'Smoke Extra';
const GUILD_NAME = 'UI Smoke Guild';

/**
 * #38's throwaway seed, written by this runner under `.gerado/` and imported by the page of
 * `SEED_APP_ID` (`session.importSeed`). Fake data only: one tool of the C fake server behind the
 * role the seed's own invite grants, which is what makes the import observable — the tool shows only
 * for an account created with that invite's code. The code itself is the driver's throwaway; the
 * seed carries its SHA-256 hash, exactly as a real seed does (`shared/auth.ts`).
 */
const IMPORT_SEED_FILE_NAME = 'import-seed.json';
const IMPORT_CODE = 'smoke-import-code-1';
const IMPORT_ROLE_ID = 'imported';
const IMPORT_ROLE_NAME = 'Imported';
const IMPORT_TOOL_ID = 'imported-one';
const IMPORT_TOOL_TITLE = 'Imported One';

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED_DIR = join(import.meta.dir, '.gerado');
const UI_DIR = join(GENERATED_DIR, 'ui');
const SEED = join(ROOT, 'resources', 'seed.json');
const SEED_BACKUP = join(GENERATED_DIR, 'seed.json.bak');
const UI_DRIVER_ROUTE = '/test/smoke/ui-driver.ts';
const HOST_DATA = join(GENERATED_DIR, 'ui-smoke-host');
/** #38's generated seed file, and #37's icon source (the tray icon of this very repo). */
const IMPORT_SEED_FILE = join(GENERATED_DIR, IMPORT_SEED_FILE_NAME);
const GUILD_ICON_FILE = join(ROOT, 'resources', 'tray.png');

const FINISH_TIMEOUT_MS = 90_000;

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

/**
 * What the checks of #37 and #38 need handed to their pages: the guild icon as base64url (what
 * `host.setGuildIcon` takes) and the path of #38's seed file. Both are the runner's, because a page
 * cannot read a file of this machine (and the smoke never drives `tiny.dialog`).
 */
interface PageExtras {
  iconPng: string;
  seedPath: string;
}

/**
 * #38's seed file, written under `.gerado/`: version 2 (this launch's temporary seed is version 1,
 * and a boot-mode plan only applies a version that advances, `shared/catalog.ts`), one role, one
 * tool behind that role, and one invite whose code only this runner and the driver know — the seed
 * carries the hash of it, exactly as a real seed does. Fake data only.
 */
async function writeImportSeed(tools: Tools): Promise<string> {
  const seed = {
    version: 2,
    generatedAt: new Date().toISOString(),
    roles: [
      { id: 'admin', name: 'Admin', admin: true },
      { id: IMPORT_ROLE_ID, name: IMPORT_ROLE_NAME, admin: false },
    ],
    entries: [
      {
        id: IMPORT_TOOL_ID,
        title: IMPORT_TOOL_TITLE,
        url: `${tools.originC}/imported`,
        icon: null,
        order: 10,
        roles: [IMPORT_ROLE_ID],
        views: [],
        auth: null,
        active: true,
      },
    ],
    invites: [
      {
        codeHash: await sha256Hex(IMPORT_CODE),
        roles: [IMPORT_ROLE_ID],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    update: null,
  };
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(IMPORT_SEED_FILE, JSON.stringify(seed, null, 2) + '\n');
  return IMPORT_SEED_FILE;
}

/** One stage: at most one GUI launch, and the headless work that runs beside it. */
interface Stage {
  gui: Phase | null;
  headless: { name: string; run: () => Promise<string> } | null;
}

/**
 * The order is the data dependency through the host: Q needs the admin's invite (and so does the
 * throwaway member of RF-64, created in the same headless step), the admin's work
 * needs P and Q pinned, Q's accept needs the admin's share, and P's re-key comes after P accepted
 * with the old pair (and before the admin reads the changed key).
 */
function stages(desk: Desk, address: string): Stage[] {
  let other: HeadlessMember | null = null;
  return [
    { gui: { name: 'admin-setup', appId: ADMIN_APP_ID }, headless: null },
    {
      gui: { name: 'person-join', appId: PERSON_APP_ID },
      headless: {
        name: 'setup: the second and throwaway members joined (headless)',
        run: async () => {
          other = await joinWithInvite(address, {
            email: OTHER_EMAIL,
            name: OTHER_NAME,
            password: PASSWORD,
            code: desk.code('other'),
          });
          // RF-64: the throwaway member the owner renames and deletes on the People tab. They join
          // the way Q does — a guild invite the admin created, redeemed headlessly — so the steps
          // never touch P or Q, whose names the later checks read.
          await joinWithInvite(address, {
            email: EXTRA_EMAIL,
            name: EXTRA_NAME,
            password: PASSWORD,
            code: desk.code('extra'),
          });
          return 'Q and the throwaway member are members with keys';
        },
      },
    },
    { gui: { name: 'admin-work', appId: ADMIN_APP_ID }, headless: null },
    {
      gui: { name: 'person-inbox', appId: PERSON_APP_ID },
      headless: {
        name: 'setup: the second member accepted (headless)',
        run: async () => {
          if (other === null) throw new Error('the second member never joined');
          const accepted = await acceptAllShares(address, other);
          if (accepted < 1) throw new Error('the second member has no share waiting');
          return `Q accepted ${accepted} share(s)`;
        },
      },
    },
    {
      gui: null,
      headless: {
        name: 'setup: the second machine activated with a new code (headless)',
        run: async () => {
          await activateWithAccessCode(address, {
            email: PERSON_EMAIL,
            password: PASSWORD,
            code: desk.code('person2'),
          });
          return 'P has a new key';
        },
      },
    },
    // #37 and #38: two Nods of their own, each on a fresh data dir, both before the stage that takes
    // the host's old version away (the O2 banner). Their invite link and their seed file were left by
    // the stages above (the desk, and the runner's own `.gerado/`).
    { gui: { name: 'third-join', appId: THIRD_APP_ID }, headless: null },
    { gui: { name: 'seed-import', appId: SEED_APP_ID }, headless: null },
    { gui: { name: 'admin-final', appId: ADMIN_APP_ID }, headless: null },
  ];
}

/**
 * The temporary seed of one launch (the shape `test/smoke/run.ts` writes): `gen-electrobun-config` reads it
 * for the runtime's origin gate and the app applies it on first boot. The person's seed carries two
 * local tools the host does not serve — the leftovers of #25 — and the second member's seed carries
 * only the tool the guild has, so it has nothing to keep. #37 and #38 start the way a fresh install
 * does: no tool at all (the third member's catalog comes from the guild; the seed importer's comes
 * from the file it imports).
 */
function temporarySeed(tools: Tools, appId: string): string {
  const base = { icon: null, roles: [], views: [], auth: null, active: true };
  const fresh = appId === THIRD_APP_ID || appId === SEED_APP_ID;
  const entries = fresh
    ? []
    : appId === PERSON_APP_ID
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
  extras: PageExtras,
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
    thirdEmail: THIRD_EMAIL,
    extraEmail: EXTRA_EMAIL,
    adminName: ADMIN_NAME,
    personName: PERSON_NAME,
    otherName: OTHER_NAME,
    thirdName: THIRD_NAME,
    extraName: EXTRA_NAME,
    guildName: GUILD_NAME,
    iconPng: extras.iconPng,
    seedPath: extras.seedPath,
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

// ------------------------------------------------------------- the desk

interface Desk {
  origin: string;
  /**
   * A code the admin's page handed over; throws when it never arrived. `third` holds the whole
   * `nod://join` link of #37's invite (address, fingerprint and code) — the person pastes a link,
   * and the check must not rebuild one of its own. `import` is set by this runner: the code of #38's
   * own seed file, which no page ever sees until the check reads it here. `extra` is RF-64's invite:
   * a member the owner renames and deletes, so no later check's names change.
   */
  code(who: 'person' | 'other' | 'person2' | 'third' | 'import' | 'extra'): string;
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
 * (the admin's chat), #38's imported code, and the host's stop/start. Codes live in this process'
 * memory and in the driver's; nothing is logged, written to a file or echoed back beyond the page
 * that asked. The generated page carries none of them (`.gerado/ui/*.html` is a file on disk).
 */
function startDesk(deps: {
  address: string;
  setupCode: string;
  /** #38: the code of the invite the runner's own seed file carries (its hash, at least). */
  importCode: string;
  host: HostControl;
}): Desk {
  const codes: Partial<Record<'person' | 'other' | 'person2' | 'third' | 'import' | 'extra', string>> = {
    import: deps.importCode,
  };
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
          (who !== 'person' &&
            who !== 'other' &&
            who !== 'person2' &&
            who !== 'third' &&
            who !== 'import' &&
            who !== 'extra') ||
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
        const known =
          who === 'person' ||
          who === 'other' ||
          who === 'person2' ||
          who === 'third' ||
          who === 'import' ||
          who === 'extra'
            ? codes[who]
            : null;
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
    code(who): string {
      const known = codes[who];
      if (known === undefined) throw new Error(`the desk carries no code for ${who}`);
      return known;
    },
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
  extras: PageExtras,
): Promise<SmokeResult> {
  const devPort = freePort();
  writeFileSync(SEED, temporarySeed(tools, phase.appId));
  const page = generatePage(phase, nonce, devPort, deskOrigin, address, tools.originC, extras);

  let app: SmokeLaunch;
  try {
    app = await launchSmokeApp({
      root: ROOT,
      runtime: RUNTIME,
      appId: phase.appId,
      devPort,
      page: page.file,
    });
  } catch (error) {
    rmSync(page.file, { force: true });
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      steps: [],
    };
  }

  try {
    const result = await waitForStoredResult(
      app.app,
      app.box,
      app.storePath,
      nonce,
      'ui_smoke_result',
      FINISH_TIMEOUT_MS,
    );
    const output = app.output().trim();
    if (!result.ok && output.length > 0) {
      return { ...result, error: `${result.error}\n--- app output ---\n${output}` };
    }
    return result;
  } finally {
    await app.stop();
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
    // The generated config named this smoke's identifier and page: put the development one back.
    const finalGen = generateElectrobunDevConfig(ROOT, null, null);
    if (finalGen.code !== 0) {
      console.error(`final gen-electrobun-config failed (code ${finalGen.code}):\n${finalGen.output.trim()}`);
    } else {
      console.log('electrobun.config.ts regenerated in dev');
    }
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

  // A backup already in place means another smoke is running (or one was killed before it
  // restored): moving `resources/seed.json` now would put that run's temporary seed over the
  // owner's private one. Refused before anything moves; restore the backup by hand.
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
    for (const appId of APP_IDS) rmSync(dataDir(appId), { recursive: true, force: true });
    rmSync(HOST_DATA, { recursive: true, force: true });
    rmSync(UI_DIR, { recursive: true, force: true });

    tools = startTools();
    console.log(
      `local tools: A=${tools.originA} B=${tools.originB} C=${tools.originC} (fake servers, loopback only)`,
    );

    // #37's icon bytes and #38's seed file: the pages cannot read either of them (no file picker is
    // driven by this smoke), so the runner hands both over in the generated page's config.
    const extras: PageExtras = {
      iconPng: toBase64url(readFileSync(GUILD_ICON_FILE)),
      seedPath: await writeImportSeed(tools),
    };
    console.log(`guild icon: ${GUILD_ICON_FILE} (${extras.iconPng.length} base64url chars)`);
    console.log(`seed file for #38: ${extras.seedPath} (version 2, fake data only)`);

    host = startHostControl(ROOT, HOST_DATA, GUILD_NAME);
    console.log(await host.start());
    const setupCode = issueSetupCode(ROOT, host.env);
    console.log(`setup code issued by host/cli/setup-code.ts (${setupCode.length} chars, not printed)`);
    const address = `http://127.0.0.1:${host.port}`;
    desk = startDesk({ address, setupCode, host, importCode: IMPORT_CODE });

    let failed = false;
    const plan = stages(desk, address);
    const report = (steps: { ok: boolean; step: string; ms: number; detail: string }[]): void => {
      for (const step of steps) {
        console.log(`${step.ok ? 'ok    ' : 'FAILED'} ${step.step} (${step.ms} ms) ${step.detail}`);
        if (!step.ok) failed = true;
      }
    };
    for (const stage of plan) {
      const label = [stage.gui?.name, stage.headless === null ? null : 'headless'].filter(Boolean);
      console.log(`\nstage ${label.join(' + ')}${stage.gui === null ? '' : ` (app id ${stage.gui.appId})`}`);
      const started = Date.now();
      const side = stage.headless;
      const [gui, headless] = await Promise.all([
        stage.gui === null
          ? Promise.resolve(null)
          : runPhase(stage.gui, crypto.randomUUID(), tools, desk.origin, address, extras),
        side === null
          ? Promise.resolve(null)
          : side.run().then(
              (detail) => ({ ok: true, step: side.name, ms: Date.now() - started, detail }),
              (error: unknown) => ({
                ok: false,
                step: side.name,
                ms: Date.now() - started,
                detail: `error: ${error instanceof Error ? error.message : String(error)}`,
              }),
            ),
      ]);
      if (gui !== null) {
        report(gui.steps);
        if (!gui.ok) {
          console.error(`phase ${stage.gui?.name} without result: ${gui.error}`);
          failed = true;
        }
      }
      if (headless !== null) report([headless]);
      console.log(`stage took ${Date.now() - started} ms`);
      // A stage that failed leaves the next one without its precondition: stop instead of timing out.
      if (failed) break;
    }

    const launches = plan.filter((stage) => stage.gui !== null).length;
    console.log(`\nui smoke: ${failed ? 'FAILED' : 'ok'} (${plan.length} stage(s), ${launches} app launch(es))`);
    return failed ? 1 : 0;
  } finally {
    clean();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

process.exit(await main());
