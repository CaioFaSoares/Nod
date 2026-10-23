// Pure decisions the two Electrobun build hooks share about the macOS usage strings
// (`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`). The plist itself is read and written
// by `scripts/eb-postwrap.ts` and `scripts/eb-postbuild.ts`; this module has no side effects, so the
// unit tests can prove the same rule the build enforces (E06 §13).

import { USAGE_KEYS, usageGaps, type UsageDescriptions, type UsageKey } from './gen-electrobun-config';

/** Info.plist entry of an app inside a payload tar (`Nod.app/Contents/Info.plist`). */
const TAR_PLIST = /^[^/]+\.app\/Contents\/Info\.plist$/;

/**
 * The single app plist inside a tar's entry list, or `null` when the archive holds none (a delta
 * patch, an unrelated artifact) or more than one (never one of ours; the caller reports it).
 */
export function tarPlistEntry(entries: readonly string[]): string | null {
  const matches = entries
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((entry) => TAR_PLIST.test(entry));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Usage keys whose value in parsed plist JSON is absent or different from the expected sentence.
 * The empty array is the only acceptable state for a bundle the app runs.
 */
export function plistGaps(
  values: Record<string, unknown>,
  expected: UsageDescriptions,
): UsageKey[] {
  const present: Partial<Record<UsageKey, string | null>> = {};
  for (const key of Object.values(USAGE_KEYS)) {
    const value = values[key];
    present[key] = typeof value === 'string' ? value : null;
  }
  return usageGaps(present, expected);
}
