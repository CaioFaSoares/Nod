// Builds `tinyjs.json` from `tinyjs.base.json` + `resources/seed.json`.
// Contract: docs/arquitetura.md §2 (origin gate) and §6 (build and dev); requirements:
// docs/canonico.md §19, RF-26, RF-27.
//
// `generateConfig` is pure: it neither reads nor writes a file and never exits the process. The I/O
// lives in the `import.meta.main` block, run with `bun scripts/gen-config.ts <dev|build>`.
//
// The `NOD_APP_ID` env replaces the app `id` — it lets the smoke run with a data directory of its
// own, without touching the real installation.
//
// The `NOD_DEV_PORT` env moves the dev server port (and, with it, the dev origin of the gate and
// `frontend.devUrl`) — it lets the smoke hold its own `tinyjs dev` next to a developer's
// `bun run app:dev`. Absent, it stays 5173.

import type { Seed } from '../shared/types';
import { originOf, validateSeed } from '../shared/catalog';

/** Dev port when nobody chooses one: vite's default, the one `bun run app:dev` takes. */
const DEFAULT_DEV_PORT = 5173;
const FILE_ORIGIN = 'file://*';
const MISSING_SEED_MESSAGE =
  'private seed missing: resources/seed.json (see resources/seed.example.json)';
const MISSING_PERMISSIONS_MESSAGE =
  'tinyjs.base.json must declare "permissions": { "camera": "...", "microphone": "..." }';

/** What an org tool's origin may call: report the login result, use camera and microphone. */
const TOOL_METHODS = ['login.report', 'media.camera', 'media.microphone'] as const;

/** The base config carries a non-empty usage string for both camera and microphone. */
function hasMediaPermissions(base: Record<string, unknown>): boolean {
  const p = base.permissions;
  if (p === null || typeof p !== 'object') return false;
  const text = (key: string): boolean => {
    const v: unknown = (p as Record<string, unknown>)[key];
    return typeof v === 'string' && v.trim() !== '';
  };
  return text('camera') && text('microphone');
}

/** Files the release always ships from `resources/`, before the relative entry icons. */
const BUNDLED = ['seed.json', 'tray.png'];

/**
 * Icon path of an entry, relative to `resources/`: no data URI, no `..` (the build refuses `..`),
 * no absolute path; `null` when the icon does not travel as a file.
 */
function relativeIconPath(icon: string | null): string | null {
  if (icon === null || /^data:/i.test(icon)) return null;
  const path = icon.replace(/^\.\//, '').replace(/^\/+/, '');
  if (path === '' || path.includes('..')) return null;
  return path;
}

/** `resources` list of the release: the seed, the tray icon and the relative icons, without repeats. */
function buildResources(seed: Seed): string[] {
  const seen = new Set<string>(BUNDLED);
  const list = [...BUNDLED];
  for (const entry of seed.entries) {
    const path = relativeIconPath(entry.icon);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    list.push(path);
  }
  return list;
}

/** Origins of the seed entries, in seed order. */
function toolOrigins(seed: Seed): string[] {
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const entry of seed.entries) {
    const origin = originOf(entry.url);
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }
  return origins;
}

/**
 * Builds `tinyjs.json`. Pure and deterministic: the same inputs return the same config.
 *
 * `build` requires the seed (RF-26); `dev` runs without it, releasing only the app's own pages. The
 * origin gate never gives `"all"` to a tool and never opens a key with `*` beyond `file://*`.
 *
 * `devPort` is the port the vite dev server takes (`NOD_DEV_PORT` in the entry block): in `dev`
 * both the page gate and `frontend.devUrl` name `http://127.0.0.1:<devPort>` — the smoke runs its
 * own server next to a developer's `app:dev` — and in `build` it changes nothing.
 */
export function generateConfig(
  base: Record<string, unknown>,
  seed: Seed | null,
  mode: 'dev' | 'build',
  appId?: string,
  devPort: number = DEFAULT_DEV_PORT,
): Record<string, unknown> {
  if (mode === 'build' && seed === null) throw new Error(MISSING_SEED_MESSAGE);
  // macOS kills a packaged app whose page captures camera or microphone without the usage strings
  // (tinyjs docs, "Mic + camera"); a call tool would crash the release, so the build refuses it.
  if (mode === 'build' && !hasMediaPermissions(base)) throw new Error(MISSING_PERMISSIONS_MESSAGE);

  const tools = seed === null ? [] : toolOrigins(seed);
  for (const origin of tools) {
    // Defense in depth (security D4): a validated seed cannot reach this — `validateSeed` and
    // `originOf` already refuse a wildcard host — but a tool key must never carry `*`.
    if (origin.includes('*')) throw new Error(`tool origin must not be a wildcard: ${origin}`);
  }

  const origins: Record<string, 'all' | string[]> = { [FILE_ORIGIN]: 'all' };
  if (mode === 'dev') origins[`http://127.0.0.1:${devPort}`] = 'all';
  // Tool origins come last and never inherit `"all"`. Org tools (the release seed) report the login
  // result and get camera and microphone without the per-site prompt; any other origin keeps the
  // engine's own prompt, which is the warning for links from outside the org.
  for (const origin of tools) origins[origin] = [...TOOL_METHODS];

  const config: Record<string, unknown> = { ...base };
  config.api = { origins };
  if (mode === 'dev') {
    // The window and the gate have to name the same origin, so `devUrl` follows the port.
    const frontend = base.frontend;
    // `tinyjs.base.json` is the repository's own versioned config and its shape is trusted, the
    // same way the rest of `base` is; the check only keeps a malformed file from spreading, say, a
    // string into numbered keys.
    const kept: Record<string, unknown> =
      typeof frontend === 'object' && frontend !== null && !Array.isArray(frontend)
        ? (frontend as Record<string, unknown>)
        : {};
    config.frontend = { ...kept, devUrl: `http://127.0.0.1:${devPort}` };
  }
  if (seed !== null && seed.update !== null) {
    config.update = { url: seed.update.url, auto: 'daily' };
  }
  if (mode === 'build' && seed !== null) config.resources = buildResources(seed);
  if (appId !== undefined && appId !== '') config.id = appId;
  return config;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== 'dev' && mode !== 'build') {
    console.error('usage: bun scripts/gen-config.ts <dev|build>');
    process.exit(1);
  }

  const rawDevPort = process.env.NOD_DEV_PORT;
  let devPort = DEFAULT_DEV_PORT;
  if (rawDevPort !== undefined) {
    // Digits only, 1024–65535 (`Number('')` is 0, `Number('5199x')` is NaN): anything else is a
    // mistake to report, not a value to fall back from.
    const parsed = Number(rawDevPort);
    if (!/^[0-9]+$/.test(rawDevPort) || parsed < 1024 || parsed > 65535) {
      console.error(`invalid NOD_DEV_PORT: ${rawDevPort}`);
      process.exit(1);
    }
    devPort = parsed;
  }

  const root = `${import.meta.dir}/..`;
  const baseFile = Bun.file(`${root}/tinyjs.base.json`);
  const seedFile = Bun.file(`${root}/resources/seed.json`);

  if (!(await baseFile.exists())) {
    console.error('tinyjs.base.json is missing');
    process.exit(1);
  }
  // tinyjs.base.json is the repository's own versioned config: its shape is trusted (it is not
  // network data) and we only read it and set the keys the build controls.
  const base = JSON.parse(await baseFile.text()) as Record<string, unknown>;

  let seed: Seed | null = null;
  if (await seedFile.exists()) {
    try {
      seed = validateSeed(JSON.parse(await seedFile.text()));
    } catch (error) {
      console.error(`invalid seed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  let config: Record<string, unknown>;
  try {
    config = generateConfig(base, seed, mode, process.env.NOD_APP_ID, devPort);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  await Bun.write(`${root}/tinyjs.json`, `${JSON.stringify(config, null, 2)}\n`);
}
