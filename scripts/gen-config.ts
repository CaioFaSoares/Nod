// Builds `tinyjs.json` from `tinyjs.base.json` + `resources/seed.json`.
// Contract: docs/arquitetura.md §2 (origin gate) and §6 (build and dev); requirements:
// docs/canonico.md §19, RF-26, RF-27, RF-56.
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
//
// The app icon (RF-56) comes from `NOD_ICON`, else from the private `resources/icon.png`, else from
// the tracked `assets/icon.png`; `iconSource` resolves it, `assertIconPng` refuses a file the build
// could not use and `iconForConfig` (the I/O half) stages the env file inside the project. Nothing
// tracked is ever written: `docs/distribuicao.md` §9 is the owner's step by step.

import type { Seed } from '../shared/types';
import { originOf, validateSeed } from '../shared/catalog';

/** Dev port when nobody chooses one: vite's default, the one `bun run app:dev` takes. */
const DEFAULT_DEV_PORT = 5173;
const FILE_ORIGIN = 'file://*';
const MISSING_SEED_MESSAGE =
  'private seed missing: resources/seed.json (see resources/seed.example.json)';
const MISSING_PERMISSIONS_MESSAGE =
  'tinyjs.base.json must declare "permissions": { "camera": "...", "microphone": "..." }';

/** Icon of a release nobody customised: tracked, 1024×1024 (`.agents/skills/tinyjs/SKILL.md`). */
export const DEFAULT_ICON = 'assets/icon.png';

/** Private icon of a custom build (RF-56): dropped in place, gitignored, like the seed. */
export const PRIVATE_ICON = 'resources/icon.png';

/** Generated copy of a `NOD_ICON` PNG, read from inside the project by every OS build. */
export const STAGED_ICON = '.nod-icon.png';

/** Smallest icon the pipeline is built around: the macOS `.icns` tinyjs writes tops out at 1024. */
export const MIN_ICON_SIZE = 1024;

/** PNG signature (8 bytes), then the IHDR chunk header: its length (13) and its type. */
const PNG_HEADER = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
];

/** The header above plus the 4-byte width and the 4-byte height that follow it. */
const PNG_HEADER_BYTES = 24;

/** Where the build takes the app icon from (RF-56). */
export type IconSource = 'env' | 'private' | 'default' | 'none';

/**
 * App icon by precedence (RF-56): the non-empty `NOD_ICON` path, else the private
 * `resources/icon.png`, else the tracked `assets/icon.png`. `none` means no file is there and
 * tinyjs's own default (its template icon) stands.
 */
export function iconSource(
  envIcon: string,
  privateIconExists: boolean,
  defaultIconExists: boolean,
): IconSource {
  if (envIcon !== '') return 'env';
  if (privateIconExists) return 'private';
  if (defaultIconExists) return 'default';
  return 'none';
}

/**
 * `icon` value the generated config names for a source: the file itself, or the staged copy for
 * `NOD_ICON`. tinyjs resolves `icon` from the project root (`cli.js`: `cfg.icon || 'icon.png'`) and
 * hands that same path to sips, to `dist/icon.png` and to the Windows icon embedder — only the
 * first of the three takes a path outside the project, so the env file is staged inside it.
 * `null` (source `none`) leaves the icon to tinyjs' own resolution.
 */
export function iconConfigPath(source: IconSource): string | null {
  if (source === 'none') return null;
  return source === 'env' ? STAGED_ICON : source === 'private' ? PRIVATE_ICON : DEFAULT_ICON;
}

/**
 * Refuses an icon the build could not use (RF-56). tinyjs reads this one PNG for every OS: sips
 * turns it into the macOS `.icns` (16…1024), Linux copies it to `dist/icon.png` and Windows
 * embeds it — so the wrong file is a mistake to report here, with its path, not a release that
 * silently ships a default or blurry icon later.
 */
export function assertIconPng(bytes: Uint8Array, source: string): void {
  if (bytes.length < PNG_HEADER_BYTES || !PNG_HEADER.every((b, i) => bytes[i] === b)) {
    throw new Error(`${source} is not a PNG: the app icon must be a PNG file (RF-56)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < MIN_ICON_SIZE || height < MIN_ICON_SIZE) {
    throw new Error(
      `${source} is ${width}x${height}: the app icon must be at least ` +
        `${MIN_ICON_SIZE}x${MIN_ICON_SIZE} (tinyjs builds the macOS .icns up to that size, so a ` +
        'smaller image only ships upscaled)',
    );
  }
}

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
 *
 * `icon` is the app icon the build wears (RF-56), already resolved and checked by `iconForConfig`:
 * `dev` shows it in the dev window and `build` in the `.app`/taskbar icon. `null` leaves the choice
 * to tinyjs's own resolution (`assets/icon.png`, then a root `icon.png`, then the template icon).
 */
export function generateConfig(
  base: Record<string, unknown>,
  seed: Seed | null,
  mode: 'dev' | 'build',
  appId?: string,
  devPort: number = DEFAULT_DEV_PORT,
  icon: string | null = null,
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
  if (icon !== null) config.icon = icon;
  return config;
}

/**
 * I/O half of RF-56, run before `generateConfig`: resolves the icon source, refuses a file the
 * build could not use and stages a PNG given through `NOD_ICON` as `STAGED_ICON`. Returns the
 * `icon` value for `generateConfig`, or `null` when there is no file to name.
 */
async function iconForConfig(root: string): Promise<string | null> {
  const envIcon = process.env.NOD_ICON ?? '';
  const source = iconSource(
    envIcon,
    await Bun.file(`${root}/${PRIVATE_ICON}`).exists(),
    await Bun.file(`${root}/${DEFAULT_ICON}`).exists(),
  );
  const icon = iconConfigPath(source);
  if (icon === null) return null;

  // `NOD_ICON` is read as the owner typed it, relative to where the command runs; the project's own
  // files are read from the root, which is where tinyjs resolves `icon` from, and named from there
  // so the message reads `resources/icon.png` and not a path with `scripts/..` in it.
  const named = source === 'env' ? envIcon : icon;
  const file = Bun.file(source === 'env' ? named : `${root}/${named}`);
  if (!(await file.exists())) throw new Error(`icon file not found: ${named}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertIconPng(bytes, named);
  if (source === 'env') await Bun.write(`${root}/${icon}`, bytes);
  return icon;
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
    const icon = await iconForConfig(root);
    config = generateConfig(base, seed, mode, process.env.NOD_APP_ID, devPort, icon);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  await Bun.write(`${root}/tinyjs.json`, `${JSON.stringify(config, null, 2)}\n`);
}
