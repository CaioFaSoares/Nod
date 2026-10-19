// Comparing the version strings two independent sides produce: the app's own version
// (`app.info().version`, the `version` key of `tinyjs.base.json`) and the oldest version a host
// serves (`Discovery.minAppVersion` / `AppMeta.minAppVersion`, SP04 §1, SP03 §3).
//
// Pure, like every module of `shared/`: no `tjs`, no `tiny`, no DOM, no `bun:*` and no import.
//
// The runtime also compares versions for RF-55's update notice (`~/.tinyjs/runtime/update.js`,
// `parseVer`/`isNewer`), but it reads only the three numbers: to it `0.5.5a` is `0.5.5`, so it never
// offers a hotfix to a Nod on that release. The Nod decides "is there a newer build" here instead
// (`backend/main.ts` `refreshUpdateNotice`), for the update notice as for the O2 gate. The rule is
// semver 2.0.0 §11, on purpose narrow: three numeric components (1 or 2 are padded with zeros),
// optional hotfix letters on the patch (`docs/distribuicao.md` §8) and an optional pre-release;
// build metadata (`+…`) is ignored, as §10 says.

/**
 * A version as the comparison reads it: `1.2` → `[1,2,0]`, `1.0.0-rc.1` → `[1,0,0]` + `['rc','1']`,
 * `0.5.5a` → `[0,5,5]` + hotfix `a` (`docs/distribuicao.md` §8: the hotfix letters follow the patch).
 */
interface Version {
  numbers: readonly number[];
  /** `''` for a plain release; `a`, `b`, … for its hotfixes, each newer than the one before. */
  hotfix: string;
  /** Empty when there is no pre-release, which is what makes `1.0.0` newer than `1.0.0-rc` (§11.3). */
  prerelease: readonly string[];
}

/** Semver §9: numeric identifiers carry no leading zero; the others are `[0-9A-Za-z-]+`. */
const NUMERIC_IDENTIFIER = /^[0-9]+$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
/** The patch with its hotfix letters: `5`, `5a`, `5b`. Only the third number carries letters. */
const PATCH_WITH_HOTFIX = /^([0-9]+)([a-z]*)$/;

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
  let hotfix = '';
  for (const [index, part] of parts.entries()) {
    const patch = index === 2 ? PATCH_WITH_HOTFIX.exec(part) : null;
    if (patch !== null) {
      numbers.push(Number.parseInt(patch[1] ?? '', 10));
      hotfix = patch[2] ?? '';
      continue;
    }
    if (!NUMERIC_IDENTIFIER.test(part)) return null;
    numbers.push(Number.parseInt(part, 10));
  }
  while (numbers.length < 3) numbers.push(0);

  const prerelease = pre === '' ? [] : pre.split('.');
  for (const identifier of prerelease) {
    if (!IDENTIFIER.test(identifier)) return null;
  }
  return { numbers, hotfix, prerelease };
}

/**
 * Semver 2.0.0 §11: the three numbers first, then the hotfix letters (`0.5.5` < `0.5.5a` <
 * `0.5.5b` < `0.5.6`; a longer run of letters is newer, `z` < `aa`), then the pre-release
 * identifiers — numeric ones numerically (and below the alphanumeric ones, §11.4.3), the others in
 * ASCII order, a shorter list below a longer one that starts the same, and no pre-release above
 * every pre-release (§11.3).
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

  if (a.hotfix !== b.hotfix) {
    if (a.hotfix.length !== b.hotfix.length) return a.hotfix.length < b.hotfix.length ? -1 : 1;
    return a.hotfix < b.hotfix ? -1 : 1;
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

/**
 * O2/SP04 §1: whether the running app is older than the version a host says it serves —
 * `Discovery.minAppVersion` (`GET /v1/meta/app` carries the same value, SP03 §3). The one place the
 * gate is decided; the sync's run (`backend/sync.ts`), the two auth calls of a join
 * (`backend/main.ts`) and their tests all read it.
 *
 * `null` on either side is no verdict, not "older": a runtime that has not told the backend its own
 * version never stops the Nod, and a host that serves no minimum or one this file cannot parse never
 * refuses it (`compareVersions` answers `0`).
 */
export function tooOldFor(appVersion: string | null, minAppVersion: string | null): boolean {
  return (
    appVersion !== null &&
    minAppVersion !== null &&
    compareVersions(appVersion, minAppVersion) < 0
  );
}
