// `electrobun.config.ts` `scripts.postPackage` hook, and the last step of `eb:build`: repairs and
// asserts the two macOS usage strings in everything the build ships.
//
// Why this exists (measured on Electrobun 2.0.4 / hutch 0.28.1, E06 §13):
// - `postWrap` (`scripts/eb-postwrap.ts`) runs *after* the payload tar is packed.
//   `Contents/Resources/<hash>.tar.zst` — byte for byte the
//   `artifacts/<prefix>-<Name>.app.tar.zst` the updater downloads — already holds an `Info.plist`
//   without the strings when `postWrap` starts. The outer `.app` gets patched; the tar, which is
//   what an installed or swapped-in app runs, did not.
// - `postWrap` is not invoked at all for `--env=dev`, so an `eb:dev` bundle never got the strings.
//
// This hook closes both gaps: it patches the outer plist when it is missing the strings, rewrites a
// payload tar whose inner plist is missing them, and then *verifies* every bundle and tar it found.
// A surviving gap exits non-zero (hutch reports `HookFailed`), so a build cannot ship a camera/mic
// bundle that lacks the descriptions. `--verify-only` skips the repairs and only asserts, which is
// the form `eb:build` and the workflow use after hutch has packaged.
//
// hutch *imports* a hook instead of spawning it (`postWrap` works the same way), so the command
// runs at module top level: an `import.meta.main` guard would make the hook a no-op. The pure
// decisions live in `scripts/eb-plist.ts`, which is what the tests import.
//
// Nothing here reads or writes a secret: only the two public sentences from `app.json`.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  USAGE_KEYS,
  mediaPermissions,
  type UsageDescriptions,
  type UsageKey,
} from './gen-electrobun-config';
import { plistGaps, tarPlistEntry } from './eb-plist';

/** The `.app` bundles a hutch build root holds (`build/<env>-<os>-<arch>/<Name>.app`). */
function appBundlePaths(buildRoot: string): string[] {
  if (!existsSync(buildRoot)) return [];
  const apps: string[] = [];
  for (const channel of readdirSync(buildRoot).sort()) {
    const channelRoot = join(buildRoot, channel);
    if (!statSync(channelRoot).isDirectory()) continue;
    for (const name of readdirSync(channelRoot).sort()) {
      if (!name.endsWith('.app')) continue;
      const path = join(channelRoot, name);
      if (statSync(path).isDirectory()) apps.push(path);
    }
  }
  return apps;
}

/** Payload tars the build produced: the app's own copy plus the artifacts the updater downloads. */
function payloadTars(apps: readonly string[], artifactRoot: string): string[] {
  const tars: string[] = [];
  for (const app of apps) {
    const resources = join(app, 'Contents', 'Resources');
    if (!existsSync(resources)) continue;
    for (const name of readdirSync(resources).sort()) {
      if (name.endsWith('.tar.zst')) tars.push(join(resources, name));
    }
  }
  if (existsSync(artifactRoot)) {
    for (const name of readdirSync(artifactRoot).sort()) {
      if (name.endsWith('.tar.zst')) tars.push(join(artifactRoot, name));
    }
  }
  return tars;
}

function run(command: string[], label: string): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label}: ${result.stderr.toString().trim() || `${command[0]} exited ${result.exitCode}`}`,
    );
  }
  return result.stdout.toString();
}

/** Parsed plist JSON; `plutil` refuses a missing or malformed file loudly. */
function readPlistValues(plist: string, label = plist): Record<string, unknown> {
  const json = run(['plutil', '-convert', 'json', '-o', '-', plist], `cannot read ${label}`);
  return JSON.parse(json) as Record<string, unknown>;
}

/** Writes the missing/incorrect keys in place and fails when the value does not round-trip. */
function patchPlist(plist: string, expected: UsageDescriptions): UsageKey[] {
  const values = readPlistValues(plist);
  const before = plistGaps(values, expected);
  for (const key of before) {
    const role: keyof UsageDescriptions =
      key === USAGE_KEYS.camera ? 'camera' : 'microphone';
    run(
      [
        'plutil',
        key in values ? '-replace' : '-insert',
        key,
        '-string',
        expected[role],
        plist,
      ],
      `cannot write ${key} to ${plist}`,
    );
  }
  const after = plistGaps(readPlistValues(plist), expected);
  if (after.length > 0) throw new Error(`${plist} still lacks ${after.join(', ')}`);
  return before;
}

/** The plist of one entry of a tar, written into `directory`; the entry is not fully extracted. */
function extractTarPlist(tar: string, entry: string, directory: string): string {
  const target = join(directory, `${basename(tar)}.plist`);
  const result = Bun.spawnSync(['tar', '--zstd', '-xOf', tar, entry], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `cannot read ${entry} from ${tar}: ${
        result.stderr.toString().trim() || `tar exited ${result.exitCode}`
      }`,
    );
  }
  writeFileSync(target, new Uint8Array(result.stdout));
  return target;
}

/**
 * Rebuilds a payload tar with the usage strings in its inner plist. The archive is rewritten in
 * place (same path, atomic rename), so the artifact name, `<hash>.tar.zst` name and the update
 * metadata around it stay untouched. Only the plist changes: extraction and repacking keep modes
 * and symlinks, and the launcher is ad-hoc signed with `Info.plist=not bound` (measured), so the
 * seal is unaffected.
 */
function rewriteTar(tar: string, entry: string, expected: UsageDescriptions): void {
  const top = entry.split('/')[0] as string;
  const work = mkdtempSync(join(tmpdir(), 'nod-eb-plist-'));
  try {
    run(['tar', '--zstd', '-xf', tar, '-C', work], `cannot unpack ${tar}`);
    patchPlist(join(work, entry), expected);
    const rebuilt = join(dirname(tar), `.${basename(tar)}.${process.pid}.tmp`);
    try {
      run(['tar', '--zstd', '-cf', rebuilt, '-C', work, top], `cannot repack ${tar}`);
      renameSync(rebuilt, tar);
    } finally {
      if (existsSync(rebuilt)) rmSync(rebuilt, { force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Result of checking one bundle/tar; `repaired` says a write happened. */
interface Check {
  target: string;
  gaps: UsageKey[];
  repaired: boolean;
}

function checkOuter(app: string, expected: UsageDescriptions, verifyOnly: boolean): Check {
  const plist = join(app, 'Contents', 'Info.plist');
  if (!existsSync(plist)) throw new Error(`${app} has no Contents/Info.plist`);
  const gaps = plistGaps(readPlistValues(plist), expected);
  if (gaps.length === 0 || verifyOnly) return { target: app, gaps, repaired: false };
  patchPlist(plist, expected);
  return { target: app, gaps, repaired: true };
}

function checkTar(
  tar: string,
  expected: UsageDescriptions,
  verifyOnly: boolean,
  work: string,
): Check | null {
  const entries = run(['tar', '--zstd', '-tf', tar], `cannot list ${tar}`).split('\n');
  const entry = tarPlistEntry(entries);
  if (entry === null) {
    const apps = entries.filter((line) => line.replace(/\/+$/, '').endsWith('/Contents/Info.plist'));
    if (apps.length > 1) throw new Error(`${tar} carries more than one app Info.plist`);
    return null;
  }
  const gaps = plistGaps(readPlistValues(extractTarPlist(tar, entry, work), entry), expected);
  if (gaps.length === 0 || verifyOnly) return { target: tar, gaps, repaired: false };
  rewriteTar(tar, entry, expected);
  // Re-read the rewritten archive: a repair that did not take must not pass as a success.
  const after = plistGaps(
    readPlistValues(extractTarPlist(tar, entry, work), entry),
    expected,
  );
  if (after.length > 0) throw new Error(`${tar} still lacks ${after.join(', ')}`);
  return { target: tar, gaps, repaired: true };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Repairs/asserts every bundle and payload tar; the hook and the `eb:verify` CLI share it. */
async function postbuild(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify-only');
  const root = resolve(import.meta.dir, '..');
  const buildRoot = resolve(option('--build') ?? join(root, 'build'));
  const artifactRoot = resolve(option('--artifacts') ?? join(root, 'artifacts'));

  let expected: UsageDescriptions;
  try {
    const base = (await Bun.file(join(root, 'app.json')).json()) as Record<
      string,
      unknown
    >;
    expected = mediaPermissions(base);
  } catch (error) {
    console.error(`eb-postbuild: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), 'nod-eb-check-'));
  let failed = false;
  try {
    const apps = appBundlePaths(buildRoot);
    if (apps.length === 0) {
      console.error(`eb-postbuild: no .app bundle under ${buildRoot}`);
      failed = true;
    }
    for (const app of apps) {
      try {
        const check = checkOuter(app, expected, verifyOnly);
        if (check.gaps.length > 0) {
          console.error(
            `eb-postbuild: ${app}: ${check.repaired ? 'patched' : 'missing'} ${check.gaps.join(', ')}`,
          );
          if (!check.repaired) failed = true;
        } else {
          console.log(`eb-postbuild: ${app}: usage strings present`);
        }
      } catch (error) {
        console.error(`eb-postbuild: ${error instanceof Error ? error.message : String(error)}`);
        failed = true;
      }
    }

    const tars = [...new Set(payloadTars(apps, artifactRoot))];
    // A dev build is not self-extracting (`build/dev-<os>-<arch>/` holds the bundle directly, no
    // payload tar); a canary/stable build always ships one, so its absence is a failure.
    const release = apps.some((app) => !basename(dirname(app)).startsWith('dev-'));
    if (tars.length === 0 && release) {
      console.error(`eb-postbuild: no payload .tar.zst under ${buildRoot} or ${artifactRoot}`);
      failed = true;
    } else if (tars.length === 0) {
      console.log('eb-postbuild: no payload tar (dev build)');
    }
    for (const tar of tars) {
      try {
        const check = checkTar(tar, expected, verifyOnly, work);
        if (check === null) {
          console.log(`eb-postbuild: ${tar}: no app plist (skipped)`);
          continue;
        }
        if (check.gaps.length > 0) {
          console.error(
            `eb-postbuild: ${tar}: ${check.repaired ? 'patched' : 'missing'} ${check.gaps.join(', ')}`,
          );
          if (!check.repaired) failed = true;
        } else {
          console.log(`eb-postbuild: ${tar}: usage strings present`);
        }
      } catch (error) {
        console.error(`eb-postbuild: ${error instanceof Error ? error.message : String(error)}`);
        failed = true;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (failed) {
    console.error('eb-postbuild: the built app would lose camera/microphone');
    process.exit(1);
  }
}

if (process.platform === 'darwin') await postbuild();
// Other targets have no `.app` bundle and no TCC gate for these two keys.
