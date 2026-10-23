// `app.update` of the Electrobun target — the same contract the backend already consumes from the
// tinyjs runtime (`backend/main.ts` `refreshUpdateNotice`/`withHotfixes`, `nod.checkUpdate`,
// `nod.installUpdate`): `check()` answers `{ available, current, latest, notes }` and `install()`
// replaces the bundle and relaunches, answering `false` for every refusal.
//
// The channel is the one file every Nod reads: the seed's `update.url`
// (`.../releases/latest/download/manifest.json`), the tinyjs `publish` format — `version`, `notes`,
// `mac.<arch>` with the artifact URL and its sha256, plus `win`/`linux` and a top-level `url`/
// `sha256` (the macOS arm64 zip) for the readers that predate the blocks. The Electrobun target
// reads the same file, picks `mac.<arch>` and installs the `.zip` — one release, one manifest, and
// a tinyjs Mac that installs an Electrobun `Nod.app` from it has migrated.
//
// Why the sha256 is checked even though the transport is HTTPS:
// Electrobun 2.0.4's own `Updater` has no signature and no checksum field — its manifest holds a
// 13-character build hash and the version decision is `hash !== installedHash` (see
// `docs/handovers/e06-electrobun-spike.md` §5). That hash is not a digest of the bytes on the wire
// and cannot authenticate them: a swapped artifact that keeps the same release name is accepted.
// tinyjs 0.61+ ships Ed25519 signatures; Electrobun ships none, so the Nod publishes the sha256 of
// the exact archive it built and refuses to extract anything whose bytes do not hash to that value.
// The manifest is read from the same HTTPS release as the artifact, so the digest travels on the
// same channel as the address — an attacker who can rewrite both is out of scope for every
// digest-only scheme, but corruption, a CDN mix-up, a partial upload and a swapped asset are not.
// `Updater` itself cannot apply a verified local file (its plan is built from `version.json`'s
// installed hash and its own `<prefix>-<hash>.patch` chain), so the facade stages the bundle and
// swaps it with a rollback-safe helper of its own.
//
// Two traces, both under `updates/`: `install.log` (this file — one line per attempt, refusals
// included) and `swap.log` (the helper, which only ever exists once this file says one was armed).
// `install()` answers `false` for a refusal and `refusal()` names the reason, which the backend
// audits as an `update` event.
//
// Comparison, hotfix letters included, is `shared/version.ts` — the backend applies `withHotfixes`
// on top of what it gets, and both sides must agree.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { compareVersions } from '../../../shared/version';

/** What `check()` answers — structurally `TinyApp['update']['check']` (`backend/tiny.d.ts`). */
export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string | null;
  notes: string | null;
}

export type UpdateArch = 'arm64' | 'x86_64';

export const UPDATE_ARCHES: readonly UpdateArch[] = ['arm64', 'x86_64'];

/** One macOS artifact of a release: where it is and what its bytes must hash to. */
export interface UpdateManifestEntry {
  url: string;
  /** Lowercase hex sha256 of the archive at `url`. */
  sha256: string;
}

/**
 * The wire format this target reads: the release `manifest.json`, as `tinyjs publish` writes it.
 * Only `version`, `notes` and `mac` are consumed here; `win`, `linux` and the top-level `url`/
 * `sha256` belong to the tinyjs readers and are carried past untouched. A broken document — a bad
 * digest, a missing arch block — is refused rather than offered.
 */
export interface UpdateManifest {
  version: string;
  notes: string | null;
  mac: Partial<Record<UpdateArch, UpdateManifestEntry>>;
}

export interface UpdateFacade {
  check(): Promise<UpdateInfo>;
  install(): Promise<boolean>;
  /**
   * Why the most recent `install()` answered `false`, for the backend's `update` event; `null`
   * when the attempt was armed (or no attempt ran). `install()` itself keeps the tinyjs contract.
   */
  refusal(): string | null;
}

export interface UpdateOptions {
  /**
   * The bundled seed's `update.url`, verbatim (`.../manifest.json`): the release manifest every Nod
   * reads, this target included. `null` = no channel.
   */
  updateUrl: string | null;
  /** The running build's version (`app.info().version`). */
  version: string;
  /** Writable data dir (`paths().data`); downloads, staging and the swap log live under `updates/`. */
  dataDir: string;
  /** Quit once the swap helper is armed. It waits for this process to exit. */
  quit?: () => void;
  /** The global `fetch` in production; tests inject a canned channel. */
  fetch?: FetchLike;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MANIFEST_MAX_BYTES = 64 * 1024;
const NOTES_MAX_CHARS = 100_000;
/** A Nod bundle is ~70 MB; far above that is a wrong URL, not a release. */
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
/** `release.yml`'s version gate: X.Y.Z plus hotfix letters and an optional pre-release/build. */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+[a-z]*([-+][0-9A-Za-z.-]+)?$/;

/** An object read out of JSON, or `null` when the value is not one. */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The seed's `update.url`, validated and returned as the address of the manifest itself: one file
 * serves the tinyjs readers and the Electrobun one, so nothing is rewritten. Credentials are
 * refused (a manifest is public data, and a token in it would leak into every log that prints it);
 * a fragment is dropped because it never reaches the server.
 */
export function channelUrlFor(updateUrl: string): string {
  const url = new URL(updateUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('the update url is not http(s)');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('the update url carries credentials');
  }
  url.hash = '';
  return url.toString();
}

function parseEntry(value: unknown): UpdateManifestEntry | null {
  const fields = record(value);
  if (fields === null) return null;
  const url = fields.url;
  const sha256 = fields.sha256;
  if (typeof url !== 'string' || typeof sha256 !== 'string') return null;
  if (!SHA256_PATTERN.test(sha256)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return { url: parsed.toString(), sha256: sha256.toLowerCase() };
}

/**
 * Validates the release manifest (or one architecture half of it: `scripts/eb-publish.ts` writes
 * that). `null` when the channel is broken — an empty string, a bad digest, a missing arch block:
 * none of that is an update to offer. At least one macOS artifact is required; a release may ship
 * only one architecture. The tinyjs blocks (`win`, `linux`) and the top-level `url`/`sha256` are
 * not read here, and are not a reason to refuse.
 */
export function parseManifest(raw: unknown): UpdateManifest | null {
  const fields = record(raw);
  if (fields === null) return null;
  const version = fields.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version.trim())) return null;
  const rawNotes = fields.notes;
  if (rawNotes !== undefined && rawNotes !== null && typeof rawNotes !== 'string') return null;
  const notes = typeof rawNotes === 'string' ? rawNotes : null;
  if (notes !== null && notes.length > NOTES_MAX_CHARS) return null;
  const macField = record(fields.mac);
  if (macField === null) return null;
  const mac: Partial<Record<UpdateArch, UpdateManifestEntry>> = {};
  for (const arch of UPDATE_ARCHES) {
    const value = macField[arch];
    if (value === undefined) continue;
    const entry = parseEntry(value);
    if (entry === null) return null;
    mac[arch] = entry;
  }
  if (mac.arm64 === undefined && mac.x86_64 === undefined) return null;
  return { version: version.trim(), notes, mac };
}

/** `process.platform`/`process.arch` → the manifest key. Only macOS artifacts are published. */
export function updateArch(platform: string, arch: string): UpdateArch | null {
  if (platform !== 'darwin') return null;
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64' || arch === 'x86_64') return 'x86_64';
  return null;
}

/** `0.5.5` < `0.5.5a` < `0.5.5b` < `0.5.6`: the manifest is never offered as a downgrade. */
export function isNewer(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}

export function infoFrom(manifest: UpdateManifest, current: string): UpdateInfo {
  return {
    available: isNewer(current, manifest.version),
    current,
    latest: manifest.version,
    notes: manifest.notes,
  };
}

/**
 * The `.app` an executable lives in, ascending from `Contents/MacOS/<binary>`; `null` for a build
 * that runs outside a bundle (an `electrobun dev` run), where there is nothing to swap.
 */
export function bundlePathOf(execPath: string): string | null {
  const parts = execPath.split(sep).filter((part) => part !== '');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].endsWith('.app')) return `${sep}${parts.slice(0, index + 1).join(sep)}`;
  }
  return null;
}

/** A Gatekeeper-translocated copy (`/private/var/folders/…/AppTranslocation/…`) is read-only. */
export function isTranslocatedBundle(bundlePath: string): boolean {
  return bundlePath.includes('/AppTranslocation/');
}

/** Reads one string out of an XML `Info.plist`; `null` when the key is absent or not a string. */
export function plistString(xml: string, key: string): string | null {
  const pattern = new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([^<]*)</string>`);
  const match = pattern.exec(xml);
  return match === null ? null : decodeXml(match[1]).trim();
}

function readBundlePlist(bundlePath: string): string | null {
  try {
    return readFileSync(join(bundlePath, 'Contents', 'Info.plist'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The staged bundle must be the same app (identifier) at the version the manifest names. This
 * catches a mis-uploaded artifact and a manifest that points at another product's archive; the
 * sha256 already covers the bytes, this covers "right file, wrong release".
 */
export function stagedBundleMatches(
  stagedPath: string,
  runningPath: string,
  version: string,
): boolean {
  const stagedPlist = readBundlePlist(stagedPath);
  const runningPlist = readBundlePlist(runningPath);
  if (stagedPlist === null || runningPlist === null) return false;
  const stagedId = plistString(stagedPlist, 'CFBundleIdentifier');
  const runningId = plistString(runningPlist, 'CFBundleIdentifier');
  if (stagedId === null || runningId === null || stagedId !== runningId) return false;
  const stagedVersion =
    plistString(stagedPlist, 'CFBundleShortVersionString') ??
    plistString(stagedPlist, 'CFBundleVersion');
  if (stagedVersion === null) return true;
  const strip = (value: string): string => value.replace(/^v/, '');
  return strip(stagedVersion) === strip(version);
}

/**
 * Streams `url` into `path` and answers whether the bytes hash to `expectedSha256`. The fetch is
 * aborted on timeout; the size cap stops a manifest that points somewhere enormous from filling the
 * disk before the digest can refuse it. `false` leaves the partial file for the caller to remove.
 */
export async function downloadVerified(
  url: string,
  path: string,
  fetchFn: FetchLike,
  expectedSha256: string,
): Promise<boolean> {
  if (!SHA256_PATTERN.test(expectedSha256)) return false;
  const controller = new AbortController();
  // The deadline covers the whole transfer, body included — a stalled CDN must not leave the
  // install waiting forever while the person watches the notice.
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const hasher = new Bun.CryptoHasher('sha256');
  const writer = Bun.file(path).writer();
  let total = 0;
  let failed = false;
  try {
    const response = await fetchFn(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || response.body === null) return false;
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > ARCHIVE_MAX_BYTES) return false;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ARCHIVE_MAX_BYTES) {
        failed = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      hasher.update(value);
      writer.write(value);
    }
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
    await writer.end();
  }
  if (failed) return false;
  return expectedSha256.toLowerCase() === hasher.digest('hex').trim().toLowerCase();
}

/**
 * Unpacks a verified `.zip` into `destination` with `ditto -x -k`: the same extraction the tinyjs
 * runtime has always done for these archives, and the one the swap helper can rely on — it needs no
 * program the machine may not have on `PATH` (the helper relaunches the Nod with an allowlisted
 * environment, so anything but `/usr/bin` is a coin toss; `e06-surface-check.md` §9).
 *
 * Answers `null` when the archive was unpacked, the reason otherwise.
 */
export function extractArchive(archive: string, destination: string): string | null {
  const result = Bun.spawnSync(['/usr/bin/ditto', '-x', '-k', archive, destination], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (result.exitCode === 0) return null;
  return `ditto could not unpack the archive: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`;
}

function findApp(directory: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  return apps.length === 1 ? join(directory, apps[0].name) : null;
}

/**
 * The helper that performs the swap after this process is gone: it waits for the app and its
 * launcher to exit, moves the old bundle aside, moves the staged one in, drops the quarantine
 * attribute (the download is a fresh file, which macOS would otherwise refuse to launch) and opens
 * it. If the new bundle cannot be moved or launched, the old one is put back and reopened. The
 * previous bundle stays under `updates/rollback/` until the next successful swap replaces it —
 * that directory is the manual recovery path — and every exit path removes this attempt's archive
 * and staging, so a rollback or an abort leaves nothing behind for the next install to trip on.
 */
const SWAP_HELPER = `#!/bin/sh
# Nod self-update helper, written by electrobun/bun/facade/update.ts. Arguments are paths; nothing
# secret is passed here (no token, no URL).
set -u
app=$1
staged=$2
backup=$3
pid=$4
ppid=$5
log=$6
archive=$7
log_line() {
  printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$log"
}
# This attempt's download and staging are nobody's business once the helper is done with them: the
# rollback path used to leave both, and the next install's sweep keeps them for an hour.
cleanup() {
  rm -f "$archive" 2>/dev/null || true
  rm -rf "$(dirname "$staged")" 2>/dev/null || true
}
# open(1) hands the caller's environment to the app it starts, so the helper's PATH is the
# relaunched Nod's PATH. It arrives with an allowlist (see HELPER_ENV_KEYS in update.ts), never with
# the whole environment of the process being replaced.
# A killed process stays a zombie until its parent reaps it; kill -0 would keep answering "alive"
# and the swap would abort after the timeout for no reason. Z is gone for the purposes of swapping.
alive() {
  [ "$1" -gt 1 ] || return 1
  status=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  case "$status" in
    ''|Z*) return 1 ;;
  esac
  return 0
}
i=0
while alive "$pid" || alive "$ppid"; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    log_line "app still running after 60s; swap aborted"
    cleanup
    exit 1
  fi
  sleep 0.2
done
log_line "swapping $app <- $staged"
mkdir -p "$(dirname "$backup")" 2>/dev/null || true
rm -rf "$backup" 2>/dev/null || true
if ! mv "$app" "$backup" 2>>"$log"; then
  log_line "could not move the old bundle; nothing changed"
  cleanup
  exit 1
fi
if ! mv "$staged" "$app" 2>>"$log"; then
  log_line "could not move the new bundle; restoring the old one"
  mv "$backup" "$app" 2>>"$log" || log_line "RESTORE FAILED: $backup -> $app"
  cleanup
  exit 1
fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
if ! open "$app" 2>>"$log"; then
  log_line "the new bundle did not launch; restoring the old one"
  rm -rf "$app" 2>/dev/null || true
  mv "$backup" "$app" 2>>"$log" || log_line "RESTORE FAILED: $backup -> $app"
  open "$app" 2>>"$log" || true
  cleanup
  exit 1
fi
cleanup
# One previous bundle is the recovery path; older ones are 70 MB of nothing. A swap that succeeded
# leaves exactly the bundle it replaced, so updates/rollback/ does not grow with every release.
for older in "$(dirname "$backup")"/*; do
  [ -e "$older" ] || continue
  [ "$older" = "$backup" ] && continue
  rm -rf "$older" 2>/dev/null || true
done
log_line "updated $app; previous bundle kept at $backup"
`;

/** The trace of the attempts themselves (`updates/install.log`); the helper writes `swap.log`. */
export const INSTALL_LOG_NAME = 'install.log';

/**
 * The variables the swap helper is given. It used to get `PATH` alone — "the helper needs nothing
 * from this process" — but `open` hands the caller's environment to the app it starts, so the Nod
 * the helper relaunched ran with the helper's `PATH` and nothing else: no `HOME`, no `TMPDIR`, and
 * no user `PATH`, which is why the next install could not run the `zstd` binary `tar --zstd` shells
 * out to. None of these is a secret, and they are what a launch from Finder carries.
 */
const HELPER_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

/** Always present for the helper's own tools (`ps`, `mv`, `open`, `xattr`, `tar`). */
const TOOL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The allowlisted environment, with the tool directories appended and duplicates dropped. */
export function helperEnv(appEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HELPER_ENV_KEYS) {
    const value = appEnv[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  const parts = (env.PATH ?? '').split(':').filter((part) => part !== '');
  for (const dir of TOOL_PATH.split(':')) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(':');
  return env;
}

/**
 * `app.update` for the Electrobun target. `check()` never applies anything; `install()` refuses
 * (answering `false`, never throwing) every case the backend must audit as a failed install: no
 * channel, a non-newer manifest, no artifact for this machine, a digest mismatch, a staged bundle
 * that is not this app, or a dev run without a bundle. Every refusal — before or after the
 * download — is written to `updates/install.log` and answered by `refusal()`, so the backend can
 * audit it: an install that fetched its artifact and neither swapped nor logged was the one
 * un-diagnosable failure of the local channel (`e06-surface-check.md` §9). On success it has
 * spawned the swap helper and scheduled `quit()`.
 */
export function createUpdate(options: UpdateOptions): UpdateFacade {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const quit =
    options.quit ??
    ((): void => {
      setTimeout(() => process.exit(0), 50);
    });
  let installing: Promise<boolean> | null = null;
  let lastRefusal: string | null = null;
  /** The helper this process already armed; a second one would race it for the same bundle. */
  let armedHelper: number | null = null;

  /** One line per attempt in `updates/install.log`; a line the data dir cannot take is not fatal. */
  function note(message: string): void {
    try {
      const updates = join(options.dataDir, 'updates');
      mkdirSync(updates, { recursive: true });
      appendFileSync(join(updates, INSTALL_LOG_NAME), `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
    } catch {
      // Unwritable data dir: `install()` answers false for it and the reason travels in `refusal()`.
    }
  }

  function refuse(reason: string): false {
    lastRefusal = reason;
    note(`refused: ${reason}`);
    return false;
  }

  async function fetchManifest(): Promise<UpdateManifest> {
    if (options.updateUrl === null) throw new Error('no update channel');
    const channel = new URL(channelUrlFor(options.updateUrl));
    // GitHub's `releases/latest/download` is served by a CDN; a stale manifest would hide a release
    // for its cache lifetime. Same trick as the runtime's own check.
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    channel.searchParams.set('_', nonce);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await fetchFn(channel.toString(), {
        redirect: 'follow',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`the manifest answered ${response.status}`);
      const text = await response.text();
      if (text.length > MANIFEST_MAX_BYTES) throw new Error('the manifest is too large');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('the manifest is not JSON');
      }
      const manifest = parseManifest(raw);
      if (manifest === null) throw new Error('the manifest is not a valid update manifest');
      return manifest;
    } finally {
      clearTimeout(timer);
    }
  }

  async function installOnce(): Promise<boolean> {
    lastRefusal = null;
    note(`install ${options.version} from ${options.updateUrl ?? 'no channel'}`);
    try {
      // The helper waits for this pid to go away and then swaps. If `quit()` has not taken the
      // process down yet, arming a second helper would leave two of them moving the same bundle;
      // say so instead of starting a race that only `swap.log` could explain.
      if (armedHelper !== null) {
        return refuse(`a swap helper (pid ${armedHelper}) is already waiting for this process to quit`);
      }
      if (options.updateUrl === null) return refuse('the seed names no update channel');
      const arch = updateArch(process.platform, process.arch);
      if (arch === null) {
        return refuse(`this machine (${process.platform}/${process.arch}) has no macOS artifact`);
      }
      const bundle = bundlePathOf(process.execPath);
      if (bundle === null) {
        return refuse('this run is not inside an .app (a dev run has nothing to swap)');
      }
      if (isTranslocatedBundle(bundle)) {
        return refuse('Gatekeeper runs this copy from a read-only translocated path');
      }

      // A fresh manifest: the one the notice was built from may be hours old (daily check).
      const manifest = await fetchManifest();
      if (!isNewer(options.version, manifest.version)) {
        return refuse(`the channel offers ${manifest.version}, not newer than ${options.version}`);
      }
      const entry = manifest.mac[arch];
      if (entry === undefined) return refuse(`release ${manifest.version} ships no ${arch} artifact`);

      const updates = join(options.dataDir, 'updates');
      mkdirSync(updates, { recursive: true });
      // A helper that aborted (the app never exited) leaves its staging behind; the next intake
      // starts clean instead of growing the data dir by one bundle per attempt. Only old entries:
      // a helper that is still waiting owns its own `staged-*`, and a restarted app install can
      // overlap it.
      const staleBefore = Date.now() - 60 * 60 * 1000;
      for (const name of readdirSync(updates)) {
        if (!name.startsWith('staged-') && !name.startsWith('download-')) continue;
        const candidate = join(updates, name);
        try {
          if (statSync(candidate).mtimeMs < staleBefore) {
            rmSync(candidate, { recursive: true, force: true });
          }
        } catch {
          // Another process may be creating its own entry; stale cleanup is best effort.
        }
      }
      const stamp = `${process.pid}-${Date.now().toString(36)}`;
      const partial = join(updates, `download-${stamp}.part`);
      const archive = join(updates, `download-${stamp}.zip`);
      const staging = join(updates, `staged-${stamp}`);
      let armed = false;
      try {
        if (!(await downloadVerified(entry.url, partial, fetchFn, entry.sha256))) {
          return refuse(`the ${arch} artifact could not be fetched or does not match its sha256`);
        }
        renameSync(partial, archive);
        mkdirSync(staging, { recursive: true });
        const unpacking = extractArchive(archive, staging);
        if (unpacking !== null) return refuse(unpacking);
        const staged = findApp(staging);
        if (staged === null) return refuse('the archive does not hold exactly one .app');
        if (!stagedBundleMatches(staged, bundle, manifest.version)) {
          return refuse(`the staged bundle is not ${basename(bundle)} ${manifest.version}`);
        }

        const script = join(updates, `swap-${stamp}.sh`);
        writeFileSync(script, SWAP_HELPER, { mode: 0o755 });
        const backup = join(updates, 'rollback', `${basename(bundle)}-${stamp}`);
        const child = Bun.spawn(
          [
            '/bin/sh',
            script,
            bundle,
            staged,
            backup,
            String(process.pid),
            String(process.ppid ?? 0),
            join(updates, 'swap.log'),
            archive,
          ],
          // An allowlist, never the whole environment of the process being replaced: `open` passes
          // this one on to the Nod that launches next.
          { stdio: ['ignore', 'ignore', 'ignore'], env: helperEnv(process.env) },
        );
        child.unref();
        armed = true;
        armedHelper = child.pid ?? null;
        note(`armed the swap helper (pid ${child.pid}): ${bundle} <- ${staged}`);
        setTimeout(quit, 50);
        return true;
      } finally {
        if (!armed) {
          rmSync(partial, { force: true });
          rmSync(archive, { force: true });
          rmSync(staging, { recursive: true, force: true });
        }
      }
    } catch (error) {
      return refuse(`the install failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    check: async (): Promise<UpdateInfo> => infoFrom(await fetchManifest(), options.version),
    install: (): Promise<boolean> => {
      if (installing !== null) return installing;
      const operation = installOnce().finally(() => {
        if (installing === operation) installing = null;
      });
      installing = operation;
      return operation;
    },
    // Read right after `install()` answered false; the backend audits this as the event's detail.
    refusal: (): string | null => lastRefusal,
  };
}
