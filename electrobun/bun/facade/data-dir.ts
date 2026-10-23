// Where the Electrobun target keeps the backend's own files (`nod.db`, `store.json`,
// `guild-icon.png`, `icons/`).
//
// The tinyjs runtime has used `~/Library/Application Support/<app id>` (and its Windows/Linux
// equivalents) since the first release, and every installation in the wild holds its account there.
// Electrobun's devkit computes `Utils.paths.userData` as `<app data>/<identifier>/<channel>`, which
// would leave an updated tinyjs installation looking at an empty Nod. So the Electrobun target
// resolves the tinyjs directory itself, and only falls back to the devkit's directory when that one
// already holds an account and the tinyjs one does not (an Electrobun-only install; none was ever
// released, but a local build can have one).
//
// Pure like the rest of the facade's decision code: the caller injects the platform, home and
// environment, and the probe is replaceable in tests.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The per-user data root the tinyjs runtime resolves for an app id (`~/.tinyjs/runtime/bridge.js`). */
export function tinyjsDataDir(
  identifier: string,
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
): string {
  if (platform === 'win32') {
    return `${env.APPDATA || `${home}/AppData/Roaming`}/${identifier}`;
  }
  if (platform === 'linux') {
    return `${env.XDG_DATA_HOME || `${home}/.local/share`}/${identifier}`;
  }
  return `${home}/Library/Application Support/${identifier}`;
}

/** A directory that already holds this app's backend data. */
export function hasAccountData(directory: string): boolean {
  return existsSync(join(directory, 'nod.db')) || existsSync(join(directory, 'store.json'));
}

export interface DataDirOptions {
  identifier: string;
  /** `Utils.paths.userData` of the running Electrobun build. */
  electrobunUserData: string;
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** Test seam; production reads the filesystem. */
  probe?: (directory: string) => boolean;
}

export interface DataDirChoice {
  /** The directory the backend and the update channel use. */
  dir: string;
  /** Which layout it came from: `tinyjs` is the default and the update path. */
  source: 'tinyjs' | 'electrobun';
}

/**
 * The tinyjs directory wins whenever it holds data — that is the installation being updated. An
 * Electrobun-only directory is honoured only when the tinyjs one is empty, so an update never
 * abandons an existing account. With neither, the tinyjs layout is chosen, so a fresh Electrobun
 * install is readable by a later tinyjs update too.
 */
export function resolveDataDir(options: DataDirOptions): DataDirChoice {
  const probe = options.probe ?? hasAccountData;
  const tinyDir = tinyjsDataDir(options.identifier, options.platform, options.home, options.env);
  if (probe(tinyDir)) return { dir: tinyDir, source: 'tinyjs' };
  if (probe(options.electrobunUserData)) {
    return { dir: options.electrobunUserData, source: 'electrobun' };
  }
  return { dir: tinyDir, source: 'tinyjs' };
}

/**
 * The identifier hutch wrote into `Resources/version.json` from the generated config. A packaged
 * build must use it: `NOD_APP_ID` is absent when LaunchServices starts the app, and falling back to
 * another id would point the backend at another installation's data. `fallback` covers a dev run,
 * where the file does not exist and the environment carries the id.
 */
export function bundledIdentifier(execPath: string, fallback: string): string {
  try {
    const info = JSON.parse(
      readFileSync(join(dirname(execPath), '..', 'Resources', 'version.json'), 'utf8'),
    ) as { identifier?: unknown };
    if (typeof info.identifier === 'string' && info.identifier.trim() !== '') {
      return info.identifier.trim();
    }
  } catch {
    // A dev run has no version.json beside its executable.
  }
  return fallback;
}
