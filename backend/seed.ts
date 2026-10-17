// Private seed of the release (canonico §19, RF-26, RF-27; docs/arquitetura.md §4).
// The seed carries no secret and never overwrites what already exists: `planSeed` returns only what
// the database is missing (RF-27). `importSeedFile` is the same core, shared with the manual import
// of `catalog.importFromFile`.
import { originOf, planSeed, validateSeed } from '../shared/catalog';
import { bytesToBase64, typeOfMime, typeOfPath } from './icons';
import type { Entry, Id, InviteSeed, RawIcon, Role, Seed } from '../shared/types';
import type { Icons } from './icons';
import type { Repo } from './repo';

/** What a seed added to the database. */
export interface SeedCounts {
  entries: number;
  roles: number;
  invites: number;
}

/** One seed that was applied: the version recorded and what it moved. */
export interface SeedApplied {
  version: number;
  counts: SeedCounts;
}

/** The `detail` of a seed event and of the import's report: what a plan moved. */
export function seedCountsDetail(counts: SeedCounts): string {
  return `entries: ${counts.entries}, roles: ${counts.roles}, invites: ${counts.invites}`;
}

/** The plan `planSeed` hands back: inserts, and the updates that only `overwrite` produces. */
interface SeedPlan {
  insertEntries: Entry[];
  updateEntries: Entry[];
  insertRoles: Role[];
  updateRoles: Role[];
  insertInvites: InviteSeed[];
  seedVersion: number;
}

/** Reading a file: `tjs.readFile` at runtime, injectable in tests. */
type ReadFile = (path: string) => Promise<Uint8Array>;

/** Key of `meta.seed_version`. The repo treats meta keys as opaque. */
const SEED_VERSION_META = 'seed_version';
const SEED_FILE = 'seed.json';

/**
 * Applies the `seed.json` shipped in `resourcesDir`, in boot mode (RF-26).
 * `null` when there is no seed, when it did not ship, or when its version does not advance over the
 * one already in the database.
 */
export async function applyBundledSeed(
  repo: Repo,
  resourcesDir: string | null,
  icons: Icons,
  readFile: ReadFile = (path) => tjs.readFile(path),
): Promise<number | null> {
  if (resourcesDir === null) return null;
  const applied = await applySeedFile(
    repo,
    `${resourcesDir}/${SEED_FILE}`,
    resourcesDir,
    icons,
    readFile,
  );
  if (applied === null) return null;

  repo.addEvent({
    personId: null,
    toolId: null,
    type: 'seed_applied',
    url: null,
    result: String(applied.version),
    detail: seedCountsDetail(applied.counts),
  });
  return applied.version;
}

/**
 * Applies one `seed.json` file in boot mode — the same core the release's own seed runs through at
 * boot (RF-26) and the optional import of the first run (RF-61). `resourcesDir` is where a relative
 * icon of the seed is read from (`null` ignores them, like every import from a picked file); the
 * plan only carries what the database is missing (`planSeed`, RF-27), and `null` answers "there was
 * nothing to apply": no file, an unreadable one, or a version that does not advance.
 *
 * Nothing is recorded here: what the seed means to the log is the caller's (`seed_applied` at boot,
 * `catalog_imported` for `session.importSeed`).
 */
export async function applySeedFile(
  repo: Repo,
  path: string,
  resourcesDir: string | null,
  icons: Icons,
  readFile: ReadFile,
): Promise<SeedApplied | null> {
  let raw: string;
  try {
    raw = new TextDecoder().decode(await readFile(path));
  } catch {
    return null; // no `seed.json` there: the catalog already in the database stands
  }

  const seed = validateSeed(parseJson(raw));
  const plan = planSeed(currentSeedState(repo), seed, 'boot');
  if (plan === null) return null; // the database already carries this version or newer
  return { version: seed.version, counts: await applyPlan(repo, plan, icons, resourcesDir, readFile) };
}

/**
 * Imports a seed from a JSON string, in the mode the administrator chose (RF-13).
 * `merge` only inserts (RF-27); `overwrite` also updates existing entries and roles (A12). A
 * relative icon is ignored here: outside the bundle there is no `resources/` to read it from.
 */
export async function importSeedFile(
  repo: Repo,
  json: string,
  mode: 'merge' | 'overwrite',
  icons: Icons,
): Promise<SeedCounts> {
  const seed = validateSeed(parseJson(json));
  const plan = planSeed(currentSeedState(repo), seed, mode);
  // `planSeed` answers `null` for `boot` alone: a merge/overwrite plan is always here.
  if (plan === null) return { entries: 0, roles: 0, invites: 0 };
  return applyPlan(repo, plan, icons, null, (path) => tjs.readFile(path));
}

/**
 * Origins of the seed entries, in seed order and without repeats: exactly the origins the runtime
 * origin gate opens for `login.report` (`docs/arquitetura.md` §2), which is what `AppInfo.gateOrigins`
 * hands the page so Settings can warn about a tool registered after the release.
 */
export function gateOrigins(seed: Seed | null): string[] {
  if (seed === null) return [];
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

/** `meta.seed_version` of this repo as a number, or `null` when there is none (or it is not a
 *  positive integer). Reviews and the catalog export read the version from here. */
export function storedSeedVersion(repo: Repo): number | null {
  return seedVersionOf(repo.meta(SEED_VERSION_META));
}

/** `meta.seed_version` as a number, or `null` when there is none (or it is not an integer ≥ 1). */
function seedVersionOf(value: string | null): number | null {
  if (value === null) return null;
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function currentSeedState(repo: Repo): {
  entries: Id[];
  roles: Id[];
  invites: string[];
  seedVersion: number | null;
} {
  return {
    entries: repo.listEntries().map((entry) => entry.id),
    roles: repo.listRoles().map((role) => role.id),
    invites: repo.listInvites().map((invite) => invite.codeHash),
    seedVersion: seedVersionOf(repo.meta(SEED_VERSION_META)),
  };
}

/** Writes the plan into the repo and moves `meta.seed_version` up to the plan's version. */
async function applyPlan(
  repo: Repo,
  plan: SeedPlan,
  icons: Icons,
  resourcesDir: string | null,
  readFile: ReadFile,
): Promise<SeedCounts> {
  // Roles before entries: a new entry's grant points at a seed role.
  for (const role of [...plan.insertRoles, ...plan.updateRoles]) repo.saveRole(role);
  for (const entry of [...plan.insertEntries, ...plan.updateEntries]) {
    await writeEntry(repo, entry, icons, resourcesDir, readFile);
  }
  for (const invite of plan.insertInvites) {
    repo.saveInvite({
      codeHash: invite.codeHash,
      roles: invite.roles,
      expiresAt: invite.expiresAt,
      createdBy: null,
    });
  }
  repo.setMeta(SEED_VERSION_META, String(plan.seedVersion));

  return {
    entries: plan.insertEntries.length + plan.updateEntries.length,
    roles: plan.insertRoles.length + plan.updateRoles.length,
    invites: plan.insertInvites.length,
  };
}

async function writeEntry(
  repo: Repo,
  entry: Entry,
  icons: Icons,
  resourcesDir: string | null,
  readFile: ReadFile,
): Promise<void> {
  const icon = await readIcon(entry.icon, resourcesDir, readFile);
  const hash = icon === null ? null : await icons.save(icon);
  // Without the `iconHash` key the icon already in the database stands (the same rule as
  // `catalog.save`): an entry updated by an import keeps its local icon when the seed has none.
  repo.saveEntry(entry, hash === null ? undefined : { iconHash: hash });
}

/** The seed's icon: a data URI, or a relative path read from `resourcesDir`; anything else is ignored. */
async function readIcon(
  icon: string | null,
  resourcesDir: string | null,
  readFile: ReadFile,
): Promise<RawIcon | null> {
  if (icon === null) return null;
  if (icon.startsWith('data:')) return iconFromDataUri(icon);
  if (resourcesDir === null || !isSafeRelativePath(icon)) return null;

  const type = typeOfPath(icon);
  if (type === null) return null;
  try {
    return { type, base64: bytesToBase64(await readFile(`${resourcesDir}/${icon}`)) };
  } catch {
    return null; // an icon that did not ship in the bundle never blocks the seed
  }
}

function iconFromDataUri(uri: string): RawIcon | null {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(uri);
  if (match === null) return null;
  const type = typeOfMime(match[1]);
  return type === null ? null : { type, base64: match[2] };
}

/** Refuses an absolute path, a Windows drive and any `..` in the middle (canonico §20). */
function isSafeRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-z]:[\\/]/i.test(path)) return false;
  return path.split(/[\\/]/).every((part) => part !== '' && part !== '..');
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('invalid seed: not JSON');
  }
}
