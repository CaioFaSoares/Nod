// Builds `electrobun.config.ts` from `app.json` + `resources/seed.json`. Electrobun is the only
// desktop runtime: this file writes the config the release and dev launches read, which is
// gitignored and regenerated.
//
// `generateElectrobunConfig` is pure: it neither reads nor writes a file and never exits the process.
// The I/O lives in the `import.meta.main` block, run with
// `bun scripts/gen-electrobun-config.ts <dev|build>`.
//
// `NOD_APP_ID` overrides the Electrobun identifier (a smoke or a developer launch gets its own app
// data and keychain namespace). A `dev` run refuses the release id `copland.nod`: the two targets
// never share an app data directory in development. A `build` accepts it (the 0.7.0 release uses
// it), and the runtime resolves the legacy data directory so an installation updated from tinyjs keeps its
// account. Absent, the identifier is `copland.nod.eb`.
//
// Parity notes (probed on Electrobun 2.0.4 / hutch 0.28.1):
// - `build.copy` accepts directories; a target under `views/` lands in `Resources/app/views`, anything
//   else under `Resources/app/<target>` — where `app.paths().resources` reads `resources/`.
// - `build.bun.alias` takes an absolute path; a project-relative value does not resolve.
// - `scripts.postWrap` is a Bun module path (not a command line) run after the `.app` is wrapped,
//   with `ELECTROBUN_WRAPPER_BUNDLE_PATH` in the environment.
// - `ElectrobunConfig` has no camera/microphone plist field, so `scripts/eb-postwrap.ts` patches
//   `Info.plist`; the build refuses to start without the two usage strings.
// - The app icon is not a single PNG field either: macOS takes `build.mac.icons`, a `.iconset`
//   *folder* (hutch runs `iconutil` on it), and Windows/Linux take `build.win.icon` /
//   `build.linux.icon` as PNG. `scripts/eb-icon.ts` writes the iconset from the very PNG the release
//   wears (`iconForConfig`, same `NOD_ICON`/private/default precedence and same 1024 check).

import { resolve } from 'node:path';
import type { Seed } from '../shared/types';
import { BUILD_MODE_STAMP } from '../shared/build-mode';
import { validateSeed } from '../shared/catalog';
import { iconForConfig } from './app-config';

/** Identifier a release always wears (the 0.7.0 migration kept the tinyjs identity). */
export const RELEASE_IDENTIFIER = 'copland.nod';

/** Identifier a release uses when `NOD_APP_ID` is absent. */
export const EB_IDENTIFIER = RELEASE_IDENTIFIER;

/** Development identifier: a build that never touches a release installation. */
export const DEV_IDENTIFIER = 'copland.nod.eb-dev';

/** Bun entrypoint of the main process (`electrobun/bun/index.ts`). */
export const EB_ENTRYPOINT = 'electrobun/bun/index.ts';

/** The page bridge compiled as a view and injected as the main window's preload. */
export const EB_BRIDGE_ENTRYPOINT = 'electrobun/view/bridge.ts';
export const EB_BRIDGE_VIEW = 'bridge';

/** Module the main process bundle resolves `tjs:sqlite` to (absolute path at generation time). */
export const EB_SQLITE_SHIM = 'electrobun/bun/sqlite-shim.ts';

/** Name of the built vite page inside the bundle (`views://mainview/index.html`). */
export const EB_MAIN_VIEW = 'mainview';

/** Native helper compiled by `scripts/build-nod-native.ts` (Native's slice). */
export const EB_NATIVE_LIBRARY = 'electrobun/native/build/libNodNative.dylib';
export const EB_NATIVE_TARGET = 'native/libNodNative.dylib';

/** Hook that patches the two macOS usage strings into the wrapped `.app`. */
export const EB_POSTWRAP = 'scripts/eb-postwrap.ts';

/**
 * Hook that repairs and asserts the same strings after hutch's packaging: measured on 2.0.4 /
 * hutch 0.28.1, the self-extracting payload (`Contents/Resources/<hash>.tar.zst`, the same bytes
 * as `artifacts/<prefix>-<Name>.app.tar.zst`) is packed *before* `postWrap` runs, and a dev build
 * does not run `postWrap` at all. `scripts/eb-postbuild.ts` is the second half.
 */
export const EB_POSTPACKAGE = 'scripts/eb-postbuild.ts';

/**
 * Folder `scripts/eb-icon.ts` writes the macOS icon set into and `build.mac.icons` names: hutch
 * converts an `.iconset` (not a bare PNG) into the bundle's `.icns` with `iconutil`.
 */
export const EB_ICON_ICONSET = '.eb-icon.iconset';

/**
 * Images the icon set holds — the ten entries `iconutil` requires, every one downscaled from the
 * single ≥1024 PNG the release build wears. Pure data, so the generator and `scripts/eb-icon.ts`
 * agree on the names and the test proves the 1024 source lands in `icon_512x512@2x.png`.
 */
export const ICONSET_IMAGES: readonly { file: string; size: number }[] = [
  { file: 'icon_16x16.png', size: 16 },
  { file: 'icon_16x16@2x.png', size: 32 },
  { file: 'icon_32x32.png', size: 32 },
  { file: 'icon_32x32@2x.png', size: 64 },
  { file: 'icon_128x128.png', size: 128 },
  { file: 'icon_128x128@2x.png', size: 256 },
  { file: 'icon_256x256.png', size: 256 },
  { file: 'icon_256x256@2x.png', size: 512 },
  { file: 'icon_512x512.png', size: 512 },
  { file: 'icon_512x512@2x.png', size: 1024 },
];

const MISSING_PERMISSIONS_MESSAGE =
  'app.json must declare "permissions": { "camera": "...", "microphone": "..." }';

/** Files the release always ships from `resources/`, before the seed and the relative entry icons. */
const BUNDLED = ['tray.png'];

/** The identifier for an `NOD_APP_ID` value; the release id is refused outside a release build. */
export function appIdentifier(value: string | undefined, mode: 'dev' | 'build' = 'dev'): string {
  const id = (value ?? '').trim();
  if (id === '') return mode === 'dev' ? DEV_IDENTIFIER : EB_IDENTIFIER;
  if (id === RELEASE_IDENTIFIER && mode !== 'build') {
    throw new Error(
      `NOD_APP_ID must not be ${RELEASE_IDENTIFIER} outside a release build: the Electrobun target ` +
        'keeps its own app data in development',
    );
  }
  return id;
}

/**
 * Info.plist keys macOS reads before it hands `navigator.mediaDevices` to a page. There is no
 * `ElectrobunConfig` field for them, so the build writes them (`scripts/eb-postwrap.ts` and
 * `scripts/eb-postbuild.ts` share this table).
 */
export const USAGE_KEYS = {
  camera: 'NSCameraUsageDescription',
  microphone: 'NSMicrophoneUsageDescription',
} as const;

export type UsageKey = (typeof USAGE_KEYS)[keyof typeof USAGE_KEYS];

export interface UsageDescriptions {
  camera: string;
  microphone: string;
}

/**
 * Keys whose Info.plist value is absent or different from the sentence `app.json`
 * declares. Pure: the caller reads the plist and decides what to do with the gap. The empty array
 * is the only acceptable state for a bundle the app runs.
 */
export function usageGaps(
  present: Partial<Record<UsageKey, string | null>>,
  expected: UsageDescriptions,
): UsageKey[] {
  const gaps: UsageKey[] = [];
  if (present[USAGE_KEYS.camera] !== expected.camera) gaps.push(USAGE_KEYS.camera);
  if (present[USAGE_KEYS.microphone] !== expected.microphone) gaps.push(USAGE_KEYS.microphone);
  return gaps;
}

/** Camera and microphone usage strings; throws when either is missing or blank. */
export function mediaPermissions(base: Record<string, unknown>): UsageDescriptions {
  const permissions = base.permissions;
  const raw =
    permissions !== null && typeof permissions === 'object'
      ? (permissions as Record<string, unknown>)
      : {};
  const camera =
    typeof raw.camera === 'string' && raw.camera.trim() !== '' ? raw.camera : null;
  const microphone =
    typeof raw.microphone === 'string' && raw.microphone.trim() !== '' ? raw.microphone : null;
  if (camera === null || microphone === null) throw new Error(MISSING_PERMISSIONS_MESSAGE);
  return { camera, microphone };
}

/**
 * Icon path of an entry, relative to `resources/`: no data URI, no `..`, no absolute path;
 * `null` when the icon does not travel as a file. Pure and testable.
 */
function relativeIconPath(icon: string | null): string | null {
  if (icon === null || /^data:/i.test(icon)) return null;
  const path = icon.replace(/^\.\//, '').replace(/^\/+/, '');
  if (path === '' || path.includes('..')) return null;
  return path;
}

/**
 * Files the Electrobun bundle stages from `resources/`: the seed it was built with, the tray icon
 * and the relative entry icons. A dev run also stages the build-mode stamp — it is what tells the
 * backend this is a dev run, and the copy step is the only way the stamp reaches the bundle; a
 * release never ships it (the same rule for the release build).
 */
export function electrobunResources(seed: Seed | null, mode: 'dev' | 'build'): string[] {
  const bundled = seed === null ? [...BUNDLED] : ['seed.json', ...BUNDLED];
  const seen = new Set<string>(bundled);
  const list = [...bundled];
  if (seed !== null) {
    for (const entry of seed.entries) {
      const path = relativeIconPath(entry.icon);
      if (path === null || seen.has(path)) continue;
      seen.add(path);
      list.push(path);
    }
  }
  if (mode === 'dev') {
    seen.add(BUILD_MODE_STAMP);
    list.push(BUILD_MODE_STAMP);
  }
  return list;
}

export interface ElectrobunOptions {
  /** `NOD_APP_ID` value; absent keeps `EB_IDENTIFIER`. */
  appId?: string;
  /** Absolute path of `electrobun/bun/sqlite-shim.ts` (Electrobun's alias needs an absolute path). */
  sqliteShim: string;
  /** The native helper was built: stage it under `Resources/app/native/`. */
  nativeLibrary?: boolean;
  /** Host being built; macOS alone takes an `.iconset`, the others take the PNG. */
  platform?: NodeJS.Platform;
  /**
   * App icon the build wears (RF-56 parity), project-relative and already resolved and checked by
   * `iconForConfig` — `.nod-icon.png`, `resources/icon.png` or `assets/icon.png`. macOS gets the
   * `.iconset` `scripts/eb-icon.ts` writes from it, Windows/Linux the PNG itself. `null`/absent
   * leaves the icon to Electrobun's own default.
   */
  icon?: string | null;
}

/**
 * Directory of the update channel from the seed's URL: the legacy channel publishes one merged
 * `manifest.json`, while Electrobun reads per-platform files next to the artifacts. A seed URL that
 * names `manifest.json` therefore contributes its directory; anything else is kept verbatim.
 */
export function releaseBaseUrl(url: string): string {
  return url.replace(/\/manifest\.json$/i, '/');
}

/**
 * Builds `electrobun.config.ts`. Pure and deterministic: the same inputs return the same config.
 *
 * The main window is the vite `dist/` copied to `views/mainview` (build) or the dev server URL
 * (dev, chosen by the entrypoint from the build channel). `resources/` files are copied so
 * `app.paths().resources` answers the same paths the release build ships. macOS usage strings are
 * enforced here for `build` and applied by `scripts/eb-postwrap.ts`, because the config type has no
 * plist field. `options.icon` is the same app icon the release build wears: macOS names the iconset
 * `scripts/eb-icon.ts` writes from it, Windows and Linux name the PNG.
 */
export function generateElectrobunConfig(
  base: Record<string, unknown>,
  seed: Seed | null,
  mode: 'dev' | 'build',
  options: ElectrobunOptions,
): Record<string, unknown> {
  if (mode === 'build') mediaPermissions(base);

  const identifier = appIdentifier(options.appId, mode);
  const title =
    (typeof base.title === 'string' && base.title.trim() !== '' ? base.title : null) ??
    (typeof base.name === 'string' && base.name.trim() !== '' ? base.name : null) ??
    'Nod';
  const version =
    typeof base.version === 'string' && base.version.trim() !== '' ? base.version : '0.0.0';
  const scheme =
    typeof base.urlScheme === 'string' && base.urlScheme.trim() !== '' ? base.urlScheme : 'nod';

  const copy: Record<string, string> = {};
  // The built page is a view of its own; dev loads the vite server and needs no copy.
  if (mode === 'build') copy.dist = `views/${EB_MAIN_VIEW}`;
  for (const file of electrobunResources(seed, mode)) {
    copy[`resources/${file}`] = `resources/${file}`;
  }
  if (options.nativeLibrary === true) copy[EB_NATIVE_LIBRARY] = EB_NATIVE_TARGET;

  // RF-56 parity: the same PNG the release build wears. macOS takes the iconset folder (hutch runs iconutil on
  // it — a PNG path here would be ignored), Windows and Linux take the PNG itself. No icon resolved
  // leaves all three keys out, so Electrobun keeps its template icon.
  const icon = options.icon ?? null;
  const platform = options.platform ?? 'darwin';
  const mac: Record<string, unknown> = { bundleCEF: false, createDmg: false };
  const win: Record<string, unknown> = { bundleCEF: false };
  const linux: Record<string, unknown> = { bundleCEF: false };
  if (icon !== null) {
    if (platform === 'darwin') mac.icons = EB_ICON_ICONSET;
    win.icon = icon;
    linux.icon = icon;
  }

  const config: Record<string, unknown> = {
    app: {
      name: title,
      identifier,
      version,
      urlSchemes: [scheme],
    },
    build: {
      mainProcess: 'bun',
      bun: {
        entrypoint: EB_ENTRYPOINT,
        alias: { 'tjs:sqlite': options.sqliteShim },
      },
      views: {
        [EB_BRIDGE_VIEW]: {
          entrypoint: EB_BRIDGE_ENTRYPOINT,
          format: 'iife',
          minify: false,
        },
      },
      copy,
      mac,
      linux,
      win,
    },
    runtime: {
      // The app lives in the tray: a closed window (before or after `setHideOnClose`) does not quit.
      exitOnLastWindowClosed: false,
    },
    scripts: {
      postWrap: EB_POSTWRAP,
      // Runs after hutch has packed the payload tar it will ship; `postWrap` is too early for it.
      postPackage: EB_POSTPACKAGE,
    },
  };

  if (seed !== null && seed.update !== null) {
    // No delta patches: a release's full archive is small enough, and the release job never has
    // the previous channel in place to compute one.
    config.release = { baseUrl: releaseBaseUrl(seed.update.url), generatePatch: false };
  }

  return config;
}

/** Renders the generated module (one `export default` so hutch's TS loader can read it). */
export function renderElectrobunConfig(config: Record<string, unknown>): string {
  return (
    '// Generated by scripts/gen-electrobun-config.ts — do not edit; gitignored.\n' +
    'import type { ElectrobunConfig } from "electrobun";\n\n' +
    `export default ${JSON.stringify(config, null, 2)} satisfies ElectrobunConfig;\n`
  );
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== 'dev' && mode !== 'build') {
    console.error('usage: bun scripts/gen-electrobun-config.ts <dev|build>');
    process.exit(1);
  }

  const root = `${import.meta.dir}/..`;
  const baseFile = Bun.file(`${root}/app.json`);
  const seedFile = Bun.file(`${root}/resources/seed.json`);

  if (!(await baseFile.exists())) {
    console.error('app.json is missing');
    process.exit(1);
  }
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

  // The vite output is what the packaged main window loads; a missing directory would ship an app
  // whose window loads nothing, so the build is refused here with the command that produces it.
  if (mode === 'build' && !(await Bun.file(`${root}/dist/index.html`).exists())) {
    console.error('dist/index.html is missing: run `bun run build` before `eb:build`');
    process.exit(1);
  }

  let config: Record<string, unknown>;
  try {
    config = generateElectrobunConfig(base, seed, mode, {
      appId: process.env.NOD_APP_ID,
      sqliteShim: resolve(root, EB_SQLITE_SHIM),
      nativeLibrary: await Bun.file(`${root}/${EB_NATIVE_LIBRARY}`).exists(),
      platform: process.platform,
      // Same resolution, same PNG check and same `NOD_ICON` staging the icon helper runs,
      // so every target wears the same icon. `scripts/eb-icon.ts` reads it again to write
      // the macOS iconset; a file that is not there is refused here, before either build starts.
      icon: await iconForConfig(root),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  await Bun.write(`${root}/electrobun.config.ts`, renderElectrobunConfig(config));
  // SP02 §9: the stamp `backend/main.ts` reads to tell a dev run from a release. Written in both
  // modes; only the dev copy above stages it into the bundle.
  await Bun.write(`${root}/resources/${BUILD_MODE_STAMP}`, `${mode}\n`);
}
