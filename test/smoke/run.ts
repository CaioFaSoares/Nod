// Smoke runner for Nod on the real surface.
//
// Starts the real app (`tinyjs dev`) with the main window pointed at a test page (runtime recipe:
// `TINYJS_HTML=/abs/page.html tinyjs dev`). The page drives the API through the real path and
// writes the result to the app store; this runner reads `<app data>/store.json` and prints it step
// by step. `--runtime=electrobun` runs the same page and checks on the Electrobun target instead
// (main window on `NOD_MAIN_URL`, store at `<app data>/dev/store.json` — `test/smoke/tools.ts`).
//
//   bun test/smoke/run.ts            # refuses when resources/seed.json exists
//   bun test/smoke/run.ts --force    # moves the private seed to test/smoke/.gerado/seed.json.bak
//                                    # and restores it at the end
//   bun test/smoke/run.ts --runtime=electrobun --force
//
// No external network: the "tools" are local servers (test/smoke/tools.ts). The scenario is built
// and torn down here: temporary seed, tinyjs.json, the page generated in test/smoke/.gerado/ and
// the smoke app data directory. Everything goes back to the previous state. Nothing here writes to
// `.build/`: `tinyjs dev` takes that directory as cwd and recreates it on start, wiping whatever is
// inside.
//
// Besides the page-driven steps, the harness derives the SP02 §1 key vectors under the runtime the
// app's backend runs on — `bin/tjs` (txiki.js) on tinyjs, the bundle's Bun on Electrobun — and
// compares them with the pinned hex (`KDF_VECTORS`): same bytes in Bun and in the Nod runtime, or
// the smoke fails. The same binary seals and opens the SP06 §3 vectors (`SEAL_VECTORS`) and must
// refuse a flipped bit in the body, in the signature or in the AAD.
//
// The run takes a free dev port per launch (`freePort`, `test/smoke/tools.ts`) for `gen-config` and
// for the `tinyjs dev` child, so the smoke never takes the port a developer's `bun run app:dev` is
// already using, nor one a process a previous smoke left behind still holds; the page is written
// under a per-launch nonce name for the same reason. The last regeneration drops `NOD_DEV_PORT` and
// leaves the default 5173 config.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { SealPayload } from '../../shared/seal';
import type { SmokeLaunch, Tools } from './tools';
import {
  appDataDir as dataDir,
  freePort,
  generateDevConfig,
  generateElectrobunDevConfig,
  launchSmokeApp,
  smokeAppId,
  smokeRuntime,
  startTools,
  waitForStoredResult,
} from './tools';

/** Which target this run measures: `--runtime=electrobun` or `NOD_RUNTIME=electrobun` (default tinyjs). */
const RUNTIME = smokeRuntime();

/** Smoke id: the real app runs under it so it never touches the owner's data. */
const APP_ID = smokeAppId('copland.nod.smoke', RUNTIME);

const ROOT = join(import.meta.dir, '..', '..');
const GENERATED_DIR = join(import.meta.dir, '.gerado');
const SMOKE_TEMPLATE = join(import.meta.dir, 'smoke.html');
const SEED = join(ROOT, 'resources', 'seed.json');
const SEED_BACKUP = join(GENERATED_DIR, 'seed.json.bak');
const TINYJS_JSON = join(ROOT, 'tinyjs.json');
const EXPORT_PATH = join(GENERATED_DIR, 'events.jsonl');

/** The key-vector driver and its bundle, both generated (test/smoke/.gerado/ is gitignored). */
const KDF_DRIVER = join(GENERATED_DIR, 'kdf-driver.ts');
const KDF_OUTDIR = join(GENERATED_DIR, 'kdf');

/** The seal-vector driver and its bundle, generated the same way. */
const SEAL_DRIVER = join(GENERATED_DIR, 'seal-driver.ts');
const SEAL_OUTDIR = join(GENERATED_DIR, 'seal');

/** Marker of the `smoke.html` template, replaced by the JSON of the origins. */
const MARKER = '__CONFIG__';

const FINISH_TIMEOUT_MS = 120_000;
const EXPECTED_STEPS = 14;

/** A credential or a wrong secret never reaches the audit — the runner checks both. */
const FORBIDDEN_IN_EXPORT = ['secret-a', 'wrong'];

/** Data directory per app id comes from `./tools` (`appDataDir`), the launches' one home. */

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

/**
 * Writes the page of this launch from the template, with the origins JSON and the launch nonce in
 * the marker, under a per-launch file name. A page of an earlier run is never the file a stale
 * `tinyjs dev` watches, so it cannot reload this launch's page and race it for the result; the
 * nonce also tells a fresh `smoke_result` from the one a previous launch of the same app id left in
 * `store.json`.
 */
function generatePage(tools: Tools, nonce: string): string {
  const template = readFileSync(SMOKE_TEMPLATE, 'utf8');
  // Exactly one marker: `String.replace` would eat a second one in a comment and leave the page
  // with a bare `__CONFIG__` (a syntax error the runner would only see as "the app exited").
  if (template.split(MARKER).length !== 2) {
    throw new Error(`the template ${SMOKE_TEMPLATE} must hold exactly one ${MARKER} marker`);
  }
  const config = JSON.stringify({
    nonce,
    originA: tools.originA,
    originB: tools.originB,
    originC: tools.originC,
    exportPath: EXPORT_PATH,
  });
  const page = join(GENERATED_DIR, `smoke-${nonce}.html`);
  writeFileSync(page, template.replace(MARKER, () => config));
  return page;
}

/**
 * The `gen-config` regeneration, the store-file wait and the process tree kill come from `./tools`,
 * the one home of the smoke's process plumbing.
 */

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

// ------------------------------------------------------------- SP02 §1 in the Nod runtime

/**
 * The three SP02 §1 vectors: the same triples and the same pinned hex as `test/auth.test.ts`.
 *
 * Kept in both files because a `bun:test` module cannot be imported outside the test runner
 * (`describe` throws there), and this check has to compare the Nod runtime against the pinned bytes
 * instead of against Bun. Change one copy and the other fails — `bun test test/auth.test.ts` here and
 * the smoke below.
 */
// frozen protocol label (kept 'bond' on purpose: changing it changes every derived key)
const KDF_VECTORS = [
  {
    password: 'correct horse battery staple',
    saltHex: '000102030405060708090a0b0c0d0e0f',
    iterations: 1000,
    authKey: '8f5d9631b2425febae77676239724baadfc150a78186996166bba91ea20a33a4',
    vaultKey: '3e1717afd122bc46c5ef27e03b4ac87180f174aec27dfc6d87fcfc7fb8a271e6',
    localKey: '254aec6c6d53cd77a078fac64513d3ff5969ba41b50638724ed279a27aa2bfc9',
  },
  {
    // 'café-Ünicode-pässwörd' typed with combining marks (NFD); the pinned hex is the NFC one.
    password: 'cafe\u0301-U\u0308nicode-pa\u0308sswo\u0308rd',
    saltHex: 'ffeeddccbbaa99887766554433221100',
    iterations: 1000,
    authKey: 'e94fe009e769ebc5ae5e2f5e0518c42ac3cb077f99bffb22938642e20355de04',
    vaultKey: 'c54112e99b6b8f73e272ba3021aba0a7430067d9324e6a5e3ebf2e6fd3074934',
    localKey: '0be6e4c41ba9235af51ff4afa2273d404cf89c8bf13e46a1dcd3602b6924a356',
  },
  {
    password: 'bond-h3-third-vector',
    saltHex: '00112233445566778899aabbccddeeff',
    iterations: 600_000,
    authKey: 'c755c494f743b2df0c76cca56b08d44e1e26bfaa5ccf5be8aa1a3ddf15eef43d',
    vaultKey: 'a740caf4e1c9be6a719165afe7263b9edc8c2d63995b8241f09839c8b7a2462a',
    localKey: '5a91a24b2e32e0c48324b973b7a0cdba980397437a01b09ee1526c2990a43ef4',
  },
];

/** JSON shape the generated driver prints on its last line. */
interface DerivedVectors {
  ms: number;
  derived: Record<string, string>[];
}

/**
 * The Nod runtime: `<tinyjs home>/bin/tjs`, the txiki.js binary the tinyjs launcher execs
 * (`~/.tinyjs/tinyjs` is `exec "$DIR/bin/tjs" run "$DIR/cli.js"`). `TINYJS_HOME` and the launcher on
 * PATH come first, so no install path is hardcoded.
 */
function runtimeBinary(): string | null {
  const name = platform() === 'win32' ? 'tjs.exe' : 'tjs';
  const launcher = Bun.which('tinyjs');
  const candidates = [
    ...(process.env.TINYJS_HOME ? [join(process.env.TINYJS_HOME, 'bin', name)] : []),
    ...(launcher === null ? [] : [join(dirname(realpathSync(launcher)), 'bin', name)]),
    join(homedir(), '.tinyjs', 'bin', name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * The Bun binary the Electrobun dev app ships (`build/dev-macos-<arch>/Nod-dev.app`), which is the
 * runtime the app's backend process runs on. Absent (no Electrobun build yet), the runner's own Bun
 * is used and says so — the same vectors are pinned in Bun by `bun test`.
 */
function electrobunBun(): string | null {
  if (process.platform !== 'darwin') return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidate = join(ROOT, 'build', `dev-macos-${arch}`, 'Nod-dev.app', 'Contents', 'MacOS', 'bun');
  return existsSync(candidate) ? candidate : null;
}

/**
 * How one vector bundle is executed, per runtime: `tjs run <bundle>` on tinyjs (the txiki.js binary
 * the app's backend runs on) and the bundle's Bun on Electrobun (the backend is Bun there). Both
 * must reproduce the pinned hex — a vector that differs between runtimes blocks the story
 * (`shared/context.md`).
 */
function vectorCommand(
  bundle: string,
): { argv: string[]; label: string } | { error: string } {
  if (RUNTIME === 'electrobun') {
    const bundled = electrobunBun();
    if (bundled !== null) {
      return { argv: [bundled, bundle], label: `${bundled} (the Electrobun bundle's Bun)` };
    }
    return {
      argv: [process.execPath, bundle],
      label: `${process.execPath} (Bun ${Bun.version}; the dev bundle's Bun is not built yet)`,
    };
  }
  const binary = runtimeBinary();
  if (binary === null) {
    return {
      error: 'the tinyjs runtime binary was not found (TINYJS_HOME, tinyjs on PATH or ~/.tinyjs/bin/tjs)',
    };
  }
  return { argv: [binary, 'run', bundle], label: binary };
}

/**
 * Source of the generated driver: it imports the real `shared/auth.ts` (bundled by the runner) and
 * derives the three triples, printing one JSON line. An async IIFE with no top-level await, so the
 * bundle needs no module system in the runtime.
 */
function kdfDriver(): string {
  const triples = KDF_VECTORS.map(({ password, saltHex, iterations }) => ({
    password,
    saltHex,
    iterations,
  }));
  return `// GENERATED by test/smoke/run.ts — the SP02 §1 triples, derived here by the Nod runtime.
import { deriveKeys } from '${relative(GENERATED_DIR, join(ROOT, 'shared', 'auth'))}';

const TRIPLES = ${JSON.stringify(triples, null, 2)};

function bytesOf(hex) {
  return new Uint8Array((hex.match(/../g) || []).map((pair) => parseInt(pair, 16)));
}

function hexOf(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

(async function () {
  const started = Date.now();
  const derived = [];
  for (const triple of TRIPLES) {
    const keys = await deriveKeys(triple.password, bytesOf(triple.saltHex), triple.iterations);
    derived.push({
      authKey: hexOf(keys.authKey),
      vaultKey: hexOf(keys.vaultKey),
      localKey: hexOf(keys.localKey),
    });
  }
  console.log(JSON.stringify({ ms: Date.now() - started, derived: derived }));
})();
`;
}

/**
 * The same three vectors derived by the Nod runtime instead of Bun: a bundle of the real
 * `shared/auth.ts` runs under the txiki.js binary the app's backend runs on, and the result is
 * compared with the pinned hex. PBKDF2, HMAC-SHA256 and the NFC step must agree in both runtimes, or
 * H3 fails (`shared/context.md`: a vector that differs between runtimes blocks the story).
 */
async function checkKdfVectors(): Promise<{ ok: boolean; detail: string }> {
  mkdirSync(KDF_OUTDIR, { recursive: true });
  writeFileSync(KDF_DRIVER, kdfDriver());
  const built = await Bun.build({
    entrypoints: [KDF_DRIVER],
    target: 'browser',
    format: 'iife',
    outdir: KDF_OUTDIR,
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (built instanceof Error) return { ok: false, detail: `bundling the vectors failed: ${built.message}` };
  if (!built.success || built.outputs.length === 0) {
    return {
      ok: false,
      detail: `bundling the vectors failed: ${built.logs.map((log) => log.message).join('; ')}`,
    };
  }

  const command = vectorCommand(built.outputs[0].path);
  if ('error' in command) return { ok: false, detail: command.error };
  const run = Bun.spawnSync(command.argv, {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = run.stdout?.toString() ?? '';
  const stderr = run.stderr?.toString() ?? '';
  if (run.exitCode !== 0) {
    return {
      ok: false,
      detail: `the Nod runtime exited ${run.exitCode}: ${(stderr || stdout).trim().slice(-400)}`,
    };
  }

  let output: DerivedVectors;
  try {
    output = JSON.parse(
      stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .pop() ?? '',
    );
  } catch {
    return {
      ok: false,
      detail: `the Nod runtime printed no JSON: ${(stdout || stderr).trim().slice(-400)}`,
    };
  }
  if (output.derived?.length !== KDF_VECTORS.length) {
    return {
      ok: false,
      detail: `the Nod runtime derived ${output.derived?.length ?? 0} of ${KDF_VECTORS.length} vectors`,
    };
  }

  for (let index = 0; index < KDF_VECTORS.length; index++) {
    for (const name of ['authKey', 'vaultKey', 'localKey'] as const) {
      const obtained = output.derived[index][name];
      if (obtained !== KDF_VECTORS[index][name]) {
        return {
          ok: false,
          detail: `vector ${index + 1} ${name}: the Nod runtime gave ${obtained}, expected ${KDF_VECTORS[index][name]}`,
        };
      }
    }
  }
  return { ok: true, detail: `${KDF_VECTORS.length} vectors matched in ${output.ms} ms (${command.label})` };
}

// ------------------------------------------------------------- SP06 §3 in the Nod runtime

/**
 * The two SP06 §3 vectors: the same values and the same pinned `sealed` strings as
 * `test/seal.test.ts`, produced once by the real `shared/seal.ts` under Bun (2026-10-16) with a
 * pinned ephemeral pair and nonce. Kept in both files because a `bun:test` module cannot be imported
 * outside the test runner (`describe` throws there) and this check has to compare the Nod runtime
 * against the pinned bytes instead of against Bun. Change one copy and the other fails — the unit
 * test here and the smoke below. This copy drops `signatureHex`, which only the unit test asserts.
 */
interface SealVector {
  payload: SealPayload;
  ephemeralX25519PrivateKey: string;
  ephemeralX25519PublicKey: string;
  nonceHex: string;
  sealed: string;
}

/** The recipient's and the sender's pairs of both vectors, as SP06 §2 stores them. */
const SEAL_KEYS = {
  recipientX25519PrivateKey:
    '302e020100300506032b656e04220420979ce251fae9a716fa5033a11766707e7597370e88001401ed2a823bc07109bf',
  recipientX25519PublicKey: '4961c6a9945d449d1fb9f2cb664a353c4081ba23dca968d091e9f9125ba8a227',
  senderEd25519PrivateKey:
    '302e020100300506032b657004220420514bed7caba48f93511fb909a915af4d7eedb6391901b7d277ecc6f6b384e27c',
  senderEd25519PublicKey: '9c8ba7c6523a23951cc8f3f30c7e1bd55ad04058bbc2f17023ee823753e6214c',
};

// frozen protocol label (kept 'bond' on purpose: changing it changes every derived key)
const SEAL_VECTORS: SealVector[] = [
  {
    payload: {
      v: 1,
      credentialId: '33333333-3333-4333-8333-333333333333',
      toolId: 'kanban',
      toolOrigin: 'https://kanban.example',
      label: 'Kanban',
      username: 'alice@example',
      secret: 's\u00ebnha-\u00danica-01',
      scope: 'role',
      from: '11111111-1111-4111-8111-111111111111',
      to: '22222222-2222-4222-8222-222222222222',
      kind: 'send',
      issuedAt: '2026-10-16T12:00:00.000Z',
    },
    ephemeralX25519PrivateKey:
      '302e020100300506032b656e04220420d76dbeb8ff72419eaa05fcd1c8007c6b191f7f35b26229bebc79f7293619e88a',
    ephemeralX25519PublicKey: '0836ad8a79bbbedfc97206aa33a98163468144c0d8f6a9a0ae70335a0c4b831b',
    nonceHex: '000102030405060708090a0b',
    sealed:
      'AQg2rYp5u77fyXIGqjOpgWNGgUTA2PapoK5wM1oMS4MbAAECAwQFBgcICQoL6pFA1tkIe_z2b5lUClTWjiYaw29pAzhVhcVDZAqcOM3BRTPWcAM_rmjNCcTxs_Qg0n1wjIN26BPJxX2Wr3fc3Gnr8TRnOTBKNMEMmAuUTIBOsAU1c6r3lrxC6Kr9lX-WUrjgZgq4-2VNW9X9s2RHh7UoaLpavW5Uu2O-BQ8qKabD-lfERpuCMc7vhHr8c40NIZ82pvVFKvFudvJlXulkAx8Fu9W9GQDBsRacmryRZhvv_A0P3hCf9lHpXobHQotZ-KhMACnEbDg6y_65gq973TxlbswhWBnCFVpz91X7rSaM9WWSH1YoDRWnM4bdYDaUrOmUXYIpd1JcUY0dYhlaO38lg8orsZwP5de484AbfQ_hnXU0reM1waMzY8yL03qYsHOzy50pnYXuxE95gCP2FrA_-QYJVJXNgZUQFiInBr1jxzhb1jnbsirQdlKpmYCoZbPzdG2z7cQpg4KqQG1UXNkSJ8AK1CxXq6AvgOQ6DL-tPUADcWKj9-DUZMi-43phqDechjImZvZV32m10TkMlo5OoWuQGvgrV1Ni36O_JHrgviEj33L8jgYI',
  },
  {
    payload: {
      v: 1,
      credentialId: '44444444-4444-4444-8444-444444444444',
      toolId: 'jitsi-admin',
      toolOrigin: 'https://meet.example',
      label: 'Jitsi admin',
      username: 'admin@example',
      secret: 'plain-ascii-secret',
      scope: 'org',
      from: '11111111-1111-4111-8111-111111111111',
      to: '22222222-2222-4222-8222-222222222222',
      kind: 'assign',
      issuedAt: '2026-10-16T12:34:56.000Z',
    },
    ephemeralX25519PrivateKey:
      '302e020100300506032b656e042204205f1c181fe97ebf73f687ae7e06c4fc2cddf94f9f4c4e45375945613faf30a4ad',
    ephemeralX25519PublicKey: '6ca54d6dc051f9b5bad18a2a67cc284e23ab2eded8f6e3d16641c1ce4c0cc116',
    nonceHex: 'fffefdfcfbfaf9f8f7f6f5f4',
    sealed:
      'AWylTW3AUfm1utGKKmfMKE4jqy7e2Pbj0WZBwc5MDMEW__79_Pv6-fj39vX05ggTHpagshsTkGzD3RgFNAmECXHNlNuwlrZW83IlqD6BqyUnDCRcqsVPOxfRRb4jPjlXIhe__ClaBsf1lyME_k3p9WrTbEoTfeBdUAmOGOB-_qMuQoMO_7rUcGW7iVdVBpXNxyIU2V8h6qdVEuH90kQ_LMrjsrdWZIhVSo_ldECW9iaMLKF8pECaclBIIQ2Bhzf4ztdKnpEf5eTxbPIwcaBALtfWgF44Y2HqBw7HmegZlhKCMvsrUakoEZG_PwCxJFTfYrI5Nn0HKMUYkeo4i8Qam9oUassCmbqbfWIldZZ5WTL8dutZYk5EWmUQYFvI7H9oTrSW1vDlbblerIj1p75w1Baz07hvk-BvXi0w6wHwrNmpH8N-Tb8GErzpVM49rm-HFxDi_33uT7KzR9oY6h-GwC1Db5iHQCS7ZTWPOmgPMFtOpxqS_dhfBZFPhIrxuiFhGnr6cksA5JGVDuf02CZwJFMHnvTe8ObKiihRBcsEe76FGnJ9Qm5csZJCNQd1GXU_Ks9k1qdbhT7SyprheK-0VkcmFKxmZSPpU2jnT5YZm3XdgGg-SxTv3IIQUVcAhg2WmwA',
  },
];

/** Vector 1 with one bit flipped in the body (inside the ciphertext) and one in the signature. */
const SEAL_TAMPERED = {
  bodyFlipped:
    'AQg2rYp5u77fyXIGqjOpgWNGgUTA2PapoK5wM1oMS4MbAAECAwQFBgcICQoL65FA1tkIe_z2b5lUClTWjiYaw29pAzhVhcVDZAqcOM3BRTPWcAM_rmjNCcTxs_Qg0n1wjIN26BPJxX2Wr3fc3Gnr8TRnOTBKNMEMmAuUTIBOsAU1c6r3lrxC6Kr9lX-WUrjgZgq4-2VNW9X9s2RHh7UoaLpavW5Uu2O-BQ8qKabD-lfERpuCMc7vhHr8c40NIZ82pvVFKvFudvJlXulkAx8Fu9W9GQDBsRacmryRZhvv_A0P3hCf9lHpXobHQotZ-KhMACnEbDg6y_65gq973TxlbswhWBnCFVpz91X7rSaM9WWSH1YoDRWnM4bdYDaUrOmUXYIpd1JcUY0dYhlaO38lg8orsZwP5de484AbfQ_hnXU0reM1waMzY8yL03qYsHOzy50pnYXuxE95gCP2FrA_-QYJVJXNgZUQFiInBr1jxzhb1jnbsirQdlKpmYCoZbPzdG2z7cQpg4KqQG1UXNkSJ8AK1CxXq6AvgOQ6DL-tPUADcWKj9-DUZMi-43phqDechjImZvZV32m10TkMlo5OoWuQGvgrV1Ni36O_JHrgviEj33L8jgYI',
  signatureFlipped:
    'AQg2rYp5u77fyXIGqjOpgWNGgUTA2PapoK5wM1oMS4MbAAECAwQFBgcICQoL6pFA1tkIe_z2b5lUClTWjiYaw29pAzhVhcVDZAqcOM3BRTPWcAM_rmjNCcTxs_Qg0n1wjIN26BPJxX2Wr3fc3Gnr8TRnOTBKNMEMmAuUTIBOsAU1c6r3lrxC6Kr9lX-WUrjgZgq4-2VNW9X9s2RHh7UoaLpavW5Uu2O-BQ8qKabD-lfERpuCMc7vhHr8c40NIZ82pvVFKvFudvJlXulkAx8Fu9W9GQDBsRacmryRZhvv_A0P3hCf9lHpXobHQotZ-KhMACnEbDg6y_65gq973TxlbswhWBnCFVpz91X7rSaM9WWSH1YoDRWnM4bdYDaUrOmUXYIpd1JcUY0dYhlaO38lg8orsZwP5de484AbfQ_hnXU0reM1waMzY8yL03qYsHOzy50pnYXuxE95gCP2FrA_-QYJVJXNgZUQFiInBr1jxzhb1jnbsirQdlKpmYCoZbPzdG2z7cQpg4KqQG1UXNkSJ8AK1CxXq6AvgOQ6DL-tPUADcWKj9-DUZMi-43phqDechjImZvZV32m10TkMlo5OoWuQGvgrV1Ni36O_JHrgviEj33L8jgYJ',
};

/** `sign` over 29 raw bytes, deterministic: the pinned signature of a fixed message. */
const SEAL_SIGNATURE_VECTOR = {
  messageHex: '626f6e642f73302f7369676e61747572652d766563746f72',
  signatureHex:
    '5092a2c99da46d2c7b13b150624a5ce140de8b2cb07cfa6e8368c6e07d87d2c13824fc082272ab9ba817ba7975a63ea53957f9c4cdc9830cca57d391a601480f',
};

/** Every refusal the driver has to report as `true` (SP06 §6: a flipped bit fails; `shared/seal.ts`). */
const SEAL_REFUSALS = [
  'bodyFlipped',
  'signatureFlipped',
  'wrongAadCredentialId',
  'wrongAadTo',
  'wrongRecipient',
  'wrongSender',
] as const;

/** JSON shape the generated seal driver prints on its last line. */
interface SealedVectors {
  ms: number;
  vectors: { sealed: string; opened: unknown }[];
  refused: Record<string, boolean>;
  signature: { hex: string; verified: boolean; flipped: boolean; wrongKey: boolean };
}

/**
 * Source of the generated driver: it imports the real `shared/seal.ts` (bundled by the runner),
 * re-seals the pinned vectors with the pinned ephemeral pair and nonce, opens the pinned `sealed`
 * strings, tries the tampered ones and the wrong AAD, and prints one JSON line. An async IIFE with
 * no top-level await, so the bundle needs no module system in the runtime.
 */
function sealDriver(): string {
  const data = {
    keys: SEAL_KEYS,
    vectors: SEAL_VECTORS,
    signature: SEAL_SIGNATURE_VECTOR,
    tampered: SEAL_TAMPERED,
  };
  return `// GENERATED by test/smoke/run.ts — the SP06 §3 vectors, sealed and opened by the Nod runtime.
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  open,
  seal,
  sign,
  verify,
} from '${relative(GENERATED_DIR, join(ROOT, 'shared', 'seal'))}';

const DATA = ${JSON.stringify(data, null, 2)};

function bytesOf(hex) {
  return new Uint8Array((hex.match(/../g) || []).map((pair) => parseInt(pair, 16)));
}

function hexOf(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

(async function () {
  const started = Date.now();
  const recipientPrivateKey = bytesOf(DATA.keys.recipientX25519PrivateKey);
  const recipientPublicKey = bytesOf(DATA.keys.recipientX25519PublicKey);
  const senderPrivateKey = bytesOf(DATA.keys.senderEd25519PrivateKey);
  const senderPublicKey = bytesOf(DATA.keys.senderEd25519PublicKey);

  const vectors = [];
  for (const vector of DATA.vectors) {
    const sealed = await seal(vector.payload, recipientPublicKey, senderPrivateKey, {
      ephemeral: {
        publicKey: bytesOf(vector.ephemeralX25519PublicKey),
        privateKey: bytesOf(vector.ephemeralX25519PrivateKey),
      },
      nonce: bytesOf(vector.nonceHex),
    });
    const opened = await open(vector.sealed, {
      recipientPrivateKey: recipientPrivateKey,
      recipientPublicKey: recipientPublicKey,
      senderPublicKey: senderPublicKey,
      credentialId: vector.payload.credentialId,
      to: vector.payload.to,
    });
    vectors.push({ sealed: sealed, opened: opened });
  }

  const first = DATA.vectors[0].payload;
  const args = {
    recipientPrivateKey: recipientPrivateKey,
    recipientPublicKey: recipientPublicKey,
    senderPublicKey: senderPublicKey,
    credentialId: first.credentialId,
    to: first.to,
  };
  const otherRecipient = await generateX25519KeyPair();
  const otherSender = await generateEd25519KeyPair();
  const refused = {
    bodyFlipped: (await open(DATA.tampered.bodyFlipped, args)) === null,
    signatureFlipped: (await open(DATA.tampered.signatureFlipped, args)) === null,
    wrongAadCredentialId:
      (await open(DATA.vectors[0].sealed, { ...args, credentialId: DATA.vectors[1].payload.credentialId })) === null,
    wrongAadTo: (await open(DATA.vectors[0].sealed, { ...args, to: '99999999-9999-4999-8999-999999999999' })) === null,
    wrongRecipient:
      (await open(DATA.vectors[0].sealed, {
        ...args,
        recipientPrivateKey: otherRecipient.privateKey,
        recipientPublicKey: otherRecipient.publicKey,
      })) === null,
    wrongSender: (await open(DATA.vectors[0].sealed, { ...args, senderPublicKey: otherSender.publicKey })) === null,
  };

  const message = bytesOf(DATA.signature.messageHex);
  const flippedSignature = bytesOf(DATA.signature.signatureHex);
  flippedSignature[0] ^= 0x01;
  const signature = {
    hex: hexOf(await sign(message, senderPrivateKey)),
    verified: await verify(bytesOf(DATA.signature.signatureHex), message, senderPublicKey),
    flipped: await verify(flippedSignature, message, senderPublicKey),
    wrongKey: await verify(bytesOf(DATA.signature.signatureHex), message, otherSender.publicKey),
  };

  console.log(JSON.stringify({ ms: Date.now() - started, vectors: vectors, refused: refused, signature: signature }));
})();
`;
}

/**
 * The SP06 §3 vectors sealed, opened and refused by the Nod runtime instead of Bun: the real
 * `shared/seal.ts` runs under the txiki.js binary the app's backend runs on. A `sealed` string that
 * differs from the pinned one means X25519+HKDF+AES-GCM disagree between the runtimes, and the two
 * runtime directions follow from the bytes: the pinned string is what Bun produces, and the runtime
 * must both produce and open it (SP06 §6, S0).
 */
async function checkSealVectors(): Promise<{ ok: boolean; detail: string }> {
  mkdirSync(SEAL_OUTDIR, { recursive: true });
  writeFileSync(SEAL_DRIVER, sealDriver());
  const built = await Bun.build({
    entrypoints: [SEAL_DRIVER],
    target: 'browser',
    format: 'iife',
    outdir: SEAL_OUTDIR,
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (built instanceof Error) return { ok: false, detail: `bundling the seal vectors failed: ${built.message}` };
  if (!built.success || built.outputs.length === 0) {
    return {
      ok: false,
      detail: `bundling the seal vectors failed: ${built.logs.map((log) => log.message).join('; ')}`,
    };
  }

  const command = vectorCommand(built.outputs[0].path);
  if ('error' in command) return { ok: false, detail: command.error };
  const run = Bun.spawnSync(command.argv, {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = run.stdout?.toString() ?? '';
  const stderr = run.stderr?.toString() ?? '';
  if (run.exitCode !== 0) {
    return {
      ok: false,
      detail: `the Nod runtime exited ${run.exitCode}: ${(stderr || stdout).trim().slice(-400)}`,
    };
  }

  let output: SealedVectors;
  try {
    output = JSON.parse(
      stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .pop() ?? '',
    );
  } catch {
    return {
      ok: false,
      detail: `the Nod runtime printed no JSON: ${(stdout || stderr).trim().slice(-400)}`,
    };
  }
  if (output.vectors?.length !== SEAL_VECTORS.length) {
    return {
      ok: false,
      detail: `the Nod runtime sealed ${output.vectors?.length ?? 0} of ${SEAL_VECTORS.length} vectors`,
    };
  }

  for (let index = 0; index < SEAL_VECTORS.length; index++) {
    const obtained = output.vectors[index];
    if (obtained.sealed !== SEAL_VECTORS[index].sealed) {
      return {
        ok: false,
        detail: `vector ${index + 1}: the Nod runtime sealed ${JSON.stringify(obtained.sealed)?.slice(0, 80)}…, expected ${SEAL_VECTORS[index].sealed.slice(0, 80)}…`,
      };
    }
    if (JSON.stringify(obtained.opened) !== JSON.stringify(SEAL_VECTORS[index].payload)) {
      return {
        ok: false,
        detail: `vector ${index + 1}: the Nod runtime opened ${JSON.stringify(obtained.opened)?.slice(0, 200)}`,
      };
    }
  }
  for (const name of SEAL_REFUSALS) {
    if (output.refused?.[name] !== true) {
      return { ok: false, detail: `the Nod runtime did not refuse ${name}` };
    }
  }
  if (output.signature?.hex !== SEAL_SIGNATURE_VECTOR.signatureHex) {
    return {
      ok: false,
      detail: `the Nod runtime signed ${output.signature?.hex}, expected ${SEAL_SIGNATURE_VECTOR.signatureHex}`,
    };
  }
  if (output.signature?.verified !== true) {
    return { ok: false, detail: 'the Nod runtime did not verify the pinned signature' };
  }
  if (output.signature?.flipped !== false) {
    return { ok: false, detail: 'the Nod runtime accepted a flipped signature' };
  }
  if (output.signature?.wrongKey !== false) {
    return { ok: false, detail: 'the Nod runtime accepted the signature under another key' };
  }
  return {
    ok: true,
    detail: `${SEAL_VECTORS.length} vectors matched, ${SEAL_REFUSALS.length} tampered refused in ${output.ms} ms (${command.label})`,
  };
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
  let app: SmokeLaunch | null = null;
  let page: string | null = null;
  let seedMoved = false;

  let cleaned = false;
  const clean = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (app !== null) await app.stop();
    tools?.stop();
    if (page !== null) rmSync(page, { force: true });
    rmSync(SEED, { force: true });
    if (seedMoved) {
      renameSync(SEED_BACKUP, SEED);
      console.log('private seed restored');
    }
    if (RUNTIME === 'tinyjs') {
      const finalGen = generateDevConfig(ROOT, null, null);
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
    } else {
      // The Electrobun config was generated for this smoke's identifier; the next launch regenerates
      // it, but leave the development one behind rather than the throwaway.
      const finalGen = generateElectrobunDevConfig(ROOT, null, null);
      if (finalGen.code !== 0) {
        console.error(`final gen-electrobun-config failed (code ${finalGen.code}):\n${finalGen.output.trim()}`);
      } else {
        console.log('electrobun.config.ts regenerated in dev');
      }
    }
  };
  // A Ctrl-C in the middle of the run cannot leave the app up or the owner's seed out of place.
  const onSignal = (): void => {
    void clean().then(() => process.exit(130));
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

    const devPort = freePort();
    const nonce = crypto.randomUUID();
    if (RUNTIME === 'tinyjs') {
      const gen = generateDevConfig(ROOT, APP_ID, devPort);
      if (gen.code !== 0) {
        console.error(`gen-config failed (code ${gen.code}):\n${gen.output.trim()}`);
        return 3;
      }
      console.log('tinyjs.json generated in dev with the temporary seed');
    }

    rmSync(dataDir(APP_ID), { recursive: true, force: true });
    console.log(`smoke app data wiped: ${dataDir(APP_ID)}`);

    page = generatePage(tools, nonce);
    console.log(`smoke page: ${page}`);

    app = await launchSmokeApp({ root: ROOT, runtime: RUNTIME, appId: APP_ID, devPort, page });
    console.log(`app: ${app.label}`);

    const result = await waitForStoredResult(
      app.app,
      app.box,
      app.storePath,
      nonce,
      'smoke_result',
      FINISH_TIMEOUT_MS,
    );
    for (const step of result.steps) {
      console.log(`${step.ok ? 'ok    ' : 'FAILED'} ${step.step} (${step.ms} ms) ${step.detail}`);
    }

    const exportCheck = checkExport();
    console.log(`export: ${exportCheck.ok ? 'ok' : 'FAILED'} ${exportCheck.detail}`);

    const kdfCheck = await checkKdfVectors();
    console.log(`kdf vectors: ${kdfCheck.ok ? 'ok' : 'FAILED'} ${kdfCheck.detail}`);

    const sealCheck = await checkSealVectors();
    console.log(`seal vectors: ${sealCheck.ok ? 'ok' : 'FAILED'} ${sealCheck.detail}`);

    if (!result.ok) {
      console.error(`smoke without result: ${result.error}`);
      if (result.steps.length > 0) console.error(`(partial above: ${result.steps.length} step(s) recorded)`);
      const output = app.output().trim();
      if (output.length > 0) console.error(`--- app output ---\n${output}`);
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
    if (!kdfCheck.ok) {
      console.error(`kdf vectors check failed: ${kdfCheck.detail}`);
      return 1;
    }
    if (!sealCheck.ok) {
      console.error(`seal vectors check failed: ${sealCheck.detail}`);
      return 1;
    }
    console.log(`smoke ok: ${result.steps.length} steps`);
    return 0;
  } finally {
    await clean();
  }
}

process.exit(await main());
