// The host's environment (SP07 §1–§2). Everything here is data: no address, guild name or product
// name is written into code (`AGENTS.md`).

import type { AppMeta } from '../shared/host-api';

export type HostConfig = {
  /** Directory holding `host.db`, the key files and `backups/` (SP01 §1). */
  dataDir: string;
  /** The `https://` address the proxy exposes; the host itself serves plain HTTP (SP07 §2). */
  publicUrl: string;
  /** Port inside the container network; `PORT` in the Dockerfile (SP07 §1). */
  port: number;
  /** Dev runs may point `NOD_PUBLIC_URL` at a plain `http://` address. */
  dev: boolean;
};

export const DEFAULT_PORT = 8080;

/** A bad environment: the message goes to stderr and the process exits (main.ts). */
export class ConfigError extends Error {}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigError(`invalid PORT: ${raw}`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new ConfigError(`invalid PORT: ${raw}`);
  return port;
}

function parsePublicUrl(raw: string | undefined, dev: boolean): string {
  if (raw === undefined || raw === '') {
    throw new ConfigError('NOD_PUBLIC_URL is required (the https address the proxy exposes)');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`invalid NOD_PUBLIC_URL: ${raw}`);
  }
  // SP07 §2: the host refuses to start outside dev when the address the Nod will pin is not https.
  if (!dev && parsed.protocol !== 'https:') {
    throw new ConfigError(`NOD_PUBLIC_URL must be https:// outside dev: ${raw}`);
  }
  return raw;
}

export function loadConfig(env: Record<string, string | undefined>): HostConfig {
  const dataDir = env.NOD_DATA?.trim();
  if (!dataDir) {
    throw new ConfigError('NOD_DATA is required (the directory holding the database and key files)');
  }
  const dev = env.NOD_DEV === '1' || env.NOD_DEV === 'true';
  return {
    dataDir,
    publicUrl: parsePublicUrl(env.NOD_PUBLIC_URL?.trim(), dev),
    port: parsePort(env.PORT?.trim()),
    dev,
  };
}

// ---------------------------------------------------------------- guild name (SP04 §1, RF-59)

/**
 * SP07 §2: the deployment's guild name. Two documents carry it — the discovery a Nod pins
 * (SP04 §1) and the invite preview a stranger reads before typing an account (RF-59) — so the
 * environment name lives here, beside the other deployment values, and each of those two routes
 * reads it as the trimmed value of its own request.
 */
export const GUILD_NAME_ENV = 'NOD_GUILD_NAME';

// ---------------------------------------------------------------- app metadata (SP03 §3, O2)

/** SP07 §2: the semver the discovery and `/v1/meta/app` serve. */
export const MIN_APP_VERSION_ENV = 'NOD_MIN_APP_VERSION';

/** SP03 §3: the `https` address of the tinyjs update manifest; unset means the host offers none. */
export const UPDATE_URL_ENV = 'NOD_UPDATE_URL';

/**
 * Applied when the deployment sets no `NOD_MIN_APP_VERSION`: `0.0.0` is older than every Nod, so a
 * host that was given no minimum refuses none. (SP07 §2 and the two compose files still spell the
 * older `0.3.0`; that is the finding of `docs/handovers/h7-o1-o2-host.md`, packaging's and the
 * spec's to settle.)
 */
export const DEFAULT_MIN_APP_VERSION = '0.0.0';

/**
 * semver 2.0.0's grammar (semver.org §9) — three numbers, an optional pre-release and build — plus
 * the Nod's hotfix letters on the patch (`0.5.5a`, `docs/distribuicao.md` §8, `shared/version.ts`).
 */
const SEMVER = /^\d+\.\d+\.\d+[a-z]*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseMinAppVersion(raw: string | undefined): string {
  const value = raw?.trim();
  if (value === undefined || value === '') return DEFAULT_MIN_APP_VERSION;
  // SP04 §1 puts a semver in the discovery: a deployment that mistypes it stops the boot here, the
  // way a mistyped PORT or public URL does, instead of serving a document no Nod can compare.
  if (!SEMVER.test(value)) throw new ConfigError(`invalid NOD_MIN_APP_VERSION: ${value}`);
  return value;
}

function parseUpdateUrl(raw: string | undefined): { url: string } | null {
  const value = raw?.trim();
  if (value === undefined || value === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`invalid NOD_UPDATE_URL: ${value}`);
  }
  // The manifest is what the tinyjs updater fetches (canonico §19 F5); no deployment of ours serves
  // it over plain http, so only https is accepted, exactly as SP07 §2 refuses a non-https address.
  if (parsed.protocol !== 'https:') {
    throw new ConfigError(`NOD_UPDATE_URL must be https://: ${value}`);
  }
  return { url: value };
}

/**
 * SP03 §3's `AppMeta`, resolved from the environment once at boot (`host/main.ts`): the minimum app
 * version the discovery repeats and the update manifest address. Both documents read this one value,
 * so they cannot disagree.
 */
export function loadAppMeta(env: Record<string, string | undefined>): AppMeta {
  return {
    minAppVersion: parseMinAppVersion(env[MIN_APP_VERSION_ENV]),
    update: parseUpdateUrl(env[UPDATE_URL_ENV]),
  };
}

/**
 * The app metadata of one request: what the boot resolved and `host/app.ts` decorated, or — for an
 * app a harness built by hand, with no resolved value — the environment read now. One definition for
 * both routes that answer it, never two.
 */
export function appMetaOf(deps: { appMeta?: AppMeta }): AppMeta {
  return deps.appMeta ?? loadAppMeta(process.env);
}
