// Comparing the version strings two independent sides produce: the app's own version
// (`app.info().version`, the `version` key of `tinyjs.base.json`) and the oldest version a host
// serves (`Discovery.minAppVersion` / `AppMeta.minAppVersion`, SP04 §1, SP03 §3).
//
// Pure, like every module of `shared/`: no `tjs`, no `tiny`, no DOM, no `bun:*` and no import.
//
// The runtime already compares versions for RF-55's update notice (`~/.tinyjs/runtime/update.js`,
// `parseVer`/`isNewer`), but that one is not this fix's to import: it lives in the runtime, not in
// the repository, and the Nod's own gate is decided in the backend (O2). Semver 2.0.0 §11 is the
// rule below, on purpose narrow: three numeric components (1 or 2 are padded with zeros) and an
// optional pre-release; build metadata (`+…`) is ignored, as §10 says.

/** A version as the comparison reads it: `1.2` → `[1,2,0]`, `1.0.0-rc.1` → `[1,0,0]` + `['rc','1']`. */
interface Version {
  numbers: readonly number[];
  /** Empty when there is no pre-release, which is what makes `1.0.0` newer than `1.0.0-rc` (§11.3). */
  prerelease: readonly string[];
}

/** Semver §9: numeric identifiers carry no leading zero; the others are `[0-9A-Za-z-]+`. */
const NUMERIC_IDENTIFIER = /^[0-9]+$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;

/**
 * `null` when the text is not a version this file can compare: a host that serves something else —
 * an empty string, a date, a sentence — is not a host to refuse a Nod over (O2). A leading `v` is
 * accepted because tags carry it (`release-X.Y.Z`, `docs/distribuicao.md` §8).
 */
function parseVersion(text: string): Version | null {
  const trimmed = text.trim().replace(/^v/i, '');
  // §10: build metadata does not order versions, and a `-` inside it is not the pre-release's.
  const withoutBuild = trimmed.split('+')[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  if (core === '') return null;

  const parts = core.split('.');
  if (parts.length > 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!NUMERIC_IDENTIFIER.test(part)) return null;
    numbers.push(Number.parseInt(part, 10));
  }
  while (numbers.length < 3) numbers.push(0);

  const prerelease = pre === '' ? [] : pre.split('.');
  for (const identifier of prerelease) {
    if (!IDENTIFIER.test(identifier)) return null;
  }
  return { numbers, prerelease };
}

/**
 * Semver 2.0.0 §11: the three numbers first, then the pre-release identifiers — numeric ones
 * numerically (and below the alphanumeric ones, §11.4.3), the others in ASCII order, a shorter list
 * below a longer one that starts the same, and no pre-release above every pre-release (§11.3).
 *
 * `0` when either text is not a version (see `parseVersion`): "not older and not newer", which is
 * the safe answer for a comparison that decides whether to stop writing to the host.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return 0;

  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const one = a.prerelease[index];
    const other = b.prerelease[index];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const oneNumeric = NUMERIC_IDENTIFIER.test(one);
    const otherNumeric = NUMERIC_IDENTIFIER.test(other);
    if (oneNumeric && otherNumeric) {
      const difference = Number(one) - Number(other);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (oneNumeric) return -1;
    if (otherNumeric) return 1;
    if (one !== other) return one < other ? -1 : 1;
  }
  return 0;
}
