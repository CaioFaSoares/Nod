// `electrobun.config.ts` `scripts.postWrap` hook: adds the two macOS usage strings the Electrobun
// config type has no field for (`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`).
//
// Without them macOS kills a packaged app whose page captures camera or microphone — the same rule
// `scripts/gen-electrobun-config.ts` enforces. `gen-electrobun-config.ts build` already refuses to
// generate a config without the strings; this hook is the second half, applying them to the wrapped
// `.app` (`ELECTROBUN_WRAPPER_BUNDLE_PATH`, measured on hutch 0.28.1). A dev run only warns: it is
// not a release, and the generator mirrors `gen-electrobun-config.ts`'s build-only refusal.
//
// Measured ordering caveat (E06 §13): hutch packs the payload tar before this hook runs, and dev
// builds do not run it at all. `scripts/eb-postbuild.ts` repairs/asserts both after packaging; this
// hook still runs first so a release is signed with the strings in place.
//
// Nothing here reads or writes a secret: only the two public usage sentences from
// `app.json`.

import { join } from 'node:path';
import {
  USAGE_KEYS,
  mediaPermissions,
  usageGaps,
  type UsageDescriptions,
  type UsageKey,
} from './gen-electrobun-config';

function plistValue(plist: string, key: string): string | null {
  const result = Bun.spawnSync(['plutil', '-extract', key, 'raw', plist], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

/** Writes one usage string; `-replace` when the key already exists, `-insert` otherwise. */
function writePlistValue(plist: string, key: UsageKey, value: string): void {
  const exists = plistValue(plist, key) !== null;
  const result = Bun.spawnSync(
    ['plutil', exists ? '-replace' : '-insert', key, '-string', value, plist],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `could not write ${key} in ${plist}: ${result.stderr.toString().trim() || 'plutil failed'}`,
    );
  }
  // `plutil -extract ... raw` appends a newline to the value it prints.
  const written = plistValue(plist, key)?.replace(/\n$/, '');
  if (written !== value) {
    throw new Error(`${key} did not round-trip in ${plist}`);
  }
}

/** Writes only the keys whose current value is absent or different, then checks the pair. */
function applyUsageDescriptions(plist: string, expected: UsageDescriptions): UsageKey[] {
  const present: Partial<Record<UsageKey, string | null>> = {};
  for (const key of Object.values(USAGE_KEYS)) {
    present[key] = plistValue(plist, key)?.replace(/\n$/, '') ?? null;
  }
  const gaps = usageGaps(present, expected);
  for (const key of gaps) {
    const role = key === USAGE_KEYS.camera ? 'camera' : 'microphone';
    writePlistValue(plist, key, expected[role]);
  }
  return gaps;
}

if (process.platform !== 'darwin') {
  // The keys are a macOS rule; other targets have no .app bundle to patch.
  process.exit(0);
}

const bundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
if (bundle === undefined || bundle === '') {
  console.error('eb-postwrap: ELECTROBUN_WRAPPER_BUNDLE_PATH is missing');
  process.exit(1);
}

const channel = process.env.ELECTROBUN_BUILD_ENV ?? 'dev';
const plist = join(bundle, 'Contents', 'Info.plist');

let permissions: UsageDescriptions;
try {
  const base = (await Bun.file(join(import.meta.dir, '..', 'app.json')).json()) as Record<
    string,
    unknown
  >;
  permissions = mediaPermissions(base);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (channel === 'dev') {
    console.warn(`eb-postwrap: ${message} (dev build: plist left untouched)`);
    process.exit(0);
  }
  console.error(`eb-postwrap: ${message}`);
  process.exit(1);
}

try {
  applyUsageDescriptions(plist, permissions);
} catch (error) {
  console.error(`eb-postwrap: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
