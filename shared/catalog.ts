// Pure catalog logic: address, id, entry, seed, visibility and seed planning.
// Contract: docs/arquitetura.md §3; types: shared/types.ts; requirements: docs/canonico.md §8, §9, §10, §19.
// No `tjs`, no `tiny`, no DOM: only `URL`, `String`, `Date`, `Object` and `Array`.

import type { AuthOverride, Entry, Id, InviteSeed, Role, Seed, View } from './types';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOST = /^[a-z0-9.-]+$/;
const IPV6_LOOPBACK = '[::1]';
const HASH = /^[0-9a-f]{64}$/;
const LOOPBACK_IPV4 = /^127(\.\d{1,3}){3}$/;
const FORBIDDEN_KEY = /password|secret|token|senha|segredo/i;
/** RF-62: the longest category name the guild may give a tool. */
export const CATEGORY_MAX_LENGTH = 40;
/** A control character in a category name: it is printed in the sidebar and in Home, so refused. */
const CATEGORY_CONTROL = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------- address

/**
 * Parses an address and asserts it may host a tool. The WHATWG parser accepts hosts the app must
 * never trust — `*` (wildcards) and `_` — so the host is checked on its own; credentials in the
 * address would end up in events and in the store, so they are refused outright.
 */
function parseAddress(url: string): URL {
  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed === null) throw new Error('invalid address');
  if (parsed.username !== '' || parsed.password !== '') throw new Error('address must not contain credentials');
  const hostname = parsed.hostname;
  if (hostname !== IPV6_LOOPBACK && !HOST.test(hostname)) throw new Error('invalid address');
  if (parsed.protocol === 'https:') return parsed;
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === IPV6_LOOPBACK ||
    LOOPBACK_IPV4.test(hostname);
  if (parsed.protocol === 'http:' && loopback) return parsed;
  throw new Error('address must be https');
}

/** Canonical origin of an address. HTTPS only; HTTP only on loopback. */
export function originOf(url: string): string {
  return parseAddress(url).origin;
}

/** Canonical URL for events: origin + pathname, never query or fragment. `null` when invalid. */
export function auditUrl(url: string): string | null {
  try {
    const parsed = parseAddress(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- slug

/** Suggests an id from a title: lowercase, no accent, only `[a-z0-9-]`, at most 40. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ---------------------------------------------------------------- validators

/** The only way into `unknown` data in this module: an object, never an array, never `null`. */
function record(v: unknown, message: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(message);
  return v as Record<string, unknown>;
}

function requiredText(v: unknown, message: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(message);
  return v;
}

function textList(v: unknown, message: string): string[] {
  if (!Array.isArray(v)) throw new Error(message);
  const items: unknown[] = v;
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') throw new Error(message);
    out.push(item);
  }
  return out;
}

function validateAuth(v: unknown): AuthOverride {
  const raw = record(v, 'invalid auth');
  const auth: AuthOverride = {};
  if (raw.noFill !== undefined && raw.noFill !== null) {
    if (typeof raw.noFill !== 'boolean') throw new Error('invalid noFill');
    auth.noFill = raw.noFill;
  }
  return auth;
}

function validateView(v: unknown, origin: string): View {
  const raw = record(v, 'invalid view');
  const label = requiredText(raw.label, 'view label is required');
  const url = raw.url;
  if (typeof url !== 'string') throw new Error('invalid address');
  if (originOf(url) !== origin) throw new Error('view outside the tool origin');
  const mode = raw.mode === undefined ? 'window' : raw.mode;
  if (mode !== 'window' && mode !== 'navigate') throw new Error('invalid view mode');
  return { label, url, mode };
}

/**
 * RF-62: the category a guild gives a tool. A name is trimmed, and one that is empty or only spaces
 * is `null` — "no category" written down, never an empty group in the display. Longer than
 * `CATEGORY_MAX_LENGTH` characters or carrying a control character is refused: the name is what the
 * sidebar and Home print.
 */
function validateCategory(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error('invalid category');
  const name = v.trim();
  if (name === '') return null;
  if (name.length > CATEGORY_MAX_LENGTH || CATEGORY_CONTROL.test(name)) throw new Error('invalid category');
  return name;
}

/** Normalizes a catalog entry, applying the defaults and refusing what does not serve. */
export function validateEntry(e: unknown): Entry {
  const raw = record(e, 'invalid entry');
  const id = requiredText(raw.id, 'invalid id');
  if (!ID.test(id)) throw new Error('invalid id');
  const title = requiredText(raw.title, 'title is required');
  const url = raw.url;
  if (typeof url !== 'string') throw new Error('invalid address');
  const origin = originOf(url);

  const views: View[] = [];
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views)) throw new Error('invalid views');
    const rawViews: unknown[] = raw.views;
    for (const view of rawViews) views.push(validateView(view, origin));
  }

  let order = 0;
  if (raw.order !== undefined) {
    if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) throw new Error('invalid order');
    order = raw.order;
  }

  let active = true;
  if (raw.active !== undefined) {
    if (typeof raw.active !== 'boolean') throw new Error('invalid active');
    active = raw.active;
  }

  return {
    id,
    title,
    category: validateCategory(raw.category),
    url,
    icon: raw.icon === undefined || raw.icon === null ? null : requiredText(raw.icon, 'invalid icon'),
    order,
    roles: raw.roles === undefined ? [] : textList(raw.roles, 'invalid roles'),
    views,
    auth: raw.auth === undefined || raw.auth === null ? null : validateAuth(raw.auth),
    active,
  };
}

// ---------------------------------------------------------------- seed

/** No key of the seed may look like a secret, at any depth (RF-27). */
function rejectSecrets(v: unknown): void {
  if (Array.isArray(v)) {
    const items: unknown[] = v;
    for (const item of items) rejectSecrets(item);
    return;
  }
  if (typeof v !== 'object' || v === null) return;
  for (const [key, value] of Object.entries(v)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`the seed must not contain secrets: ${key}`);
    rejectSecrets(value);
  }
}

function validateRole(v: unknown): Role {
  const raw = record(v, 'invalid role');
  const id = requiredText(raw.id, 'invalid role');
  const name = requiredText(raw.name, 'invalid role');
  const admin = raw.admin;
  if (typeof admin !== 'boolean') throw new Error('invalid role');
  return { id, name, admin };
}

/** Every role cited has to exist in the seed itself. */
function requireRoles(roles: Id[], known: Id[]): void {
  for (const role of roles) {
    if (!known.includes(role)) throw new Error(`unknown role: ${role}`);
  }
}

function validateInvite(v: unknown, known: Id[]): InviteSeed {
  const raw = record(v, 'invalid invite');
  const codeHash = raw.codeHash;
  if (typeof codeHash !== 'string' || !HASH.test(codeHash)) throw new Error('invalid codeHash');
  const expiresAt = requiredText(raw.expiresAt, 'invalid expiresAt');
  const roles = raw.roles === undefined ? [] : textList(raw.roles, 'invalid invite roles');
  requireRoles(roles, known);
  return { codeHash, roles, expiresAt };
}

/** Normalizes and validates a whole seed. No key may look like a secret (RF-27). */
export function validateSeed(s: unknown): Seed {
  const raw = record(s, 'invalid seed');
  rejectSecrets(raw);

  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('invalid seed version');
  }
  const generatedAt = requiredText(raw.generatedAt, 'invalid generatedAt');

  if (!Array.isArray(raw.roles)) throw new Error('invalid seed roles');
  const rawRoles: unknown[] = raw.roles;
  const roles: Role[] = rawRoles.map(validateRole);
  const known = roles.map((role) => role.id);

  if (!Array.isArray(raw.entries)) throw new Error('invalid seed entries');
  const rawEntries: unknown[] = raw.entries;
  const entries: Entry[] = rawEntries.map(validateEntry);
  const seen: Id[] = [];
  for (const entry of entries) {
    if (seen.includes(entry.id)) throw new Error(`duplicate entry: ${entry.id}`);
    seen.push(entry.id);
    requireRoles(entry.roles, known);
  }

  const invites: InviteSeed[] = [];
  if (raw.invites !== undefined) {
    if (!Array.isArray(raw.invites)) throw new Error('invalid seed invites');
    const rawInvites: unknown[] = raw.invites;
    for (const invite of rawInvites) invites.push(validateInvite(invite, known));
  }

  let update: { url: string } | null = null;
  if (raw.update !== undefined && raw.update !== null) {
    const rawUpdate = record(raw.update, 'invalid update');
    const url = rawUpdate.url;
    if (typeof url !== 'string') throw new Error('invalid update address');
    originOf(url);
    update = { url };
  }

  return { version, generatedAt, roles, entries, invites, update };
}

// ---------------------------------------------------------------- visibility

/**
 * The catalog's own order: `order`, then title. `visibleEntries` sorts by it, and the display halves
 * of `shared/host-merge.ts`'s `sidebarOrder` do too — before RF-62 splits the org half into
 * categories, so every list of the app reads the same way.
 */
export function byOrderAndTitle(a: Entry, b: Entry): number {
  return a.order - b.order || a.title.localeCompare(b.title, 'en');
}

/** Active entries the person sees, ordered by `order` and then by title. */
export function visibleEntries(entries: Entry[], person: { roles: Id[]; admin: boolean }): Entry[] {
  const visible = entries.filter(
    (entry) => entry.active && (person.admin || entry.roles.some((role) => person.roles.includes(role))),
  );
  return visible.sort(byOrderAndTitle);
}

// ---------------------------------------------------------------- categories (RF-62)

/**
 * `Entry.category` as every display reads it: the trimmed name, or `null` when the entry carries
 * none — an old host's snapshot, a personal tool, a seed written before the field. The one place
 * that decides it, so the validator, the sidebar and Home cannot disagree about what is empty.
 */
export function categoryOf(entry: Entry): string | null {
  const name = entry.category;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed === '' ? null : trimmed;
}

/** One group of the display: a category name, or `null` for the tools the guild filed nowhere. */
export interface CategoryGroup {
  /** the trimmed category name; `null` is the uncategorized group */
  category: string | null;
  entries: Entry[];
}

/** The smallest `order` of a group: where the group stands among the others. */
function groupOrder(group: CategoryGroup): number {
  let min = Number.POSITIVE_INFINITY;
  for (const entry of group.entries) {
    if (entry.order < min) min = entry.order;
  }
  return min;
}

/**
 * RF-62: org tools grouped by the category the guild gave them, in the order the display reads them.
 * A group stands where its smallest `order` puts it — the tool the guild ordered first names the
 * place — and a tie is decided by the category name. The uncategorized group comes last, always:
 * the tools with no place of their own read after the ones the guild filed.
 *
 * The entries inside a group keep the order they arrived in, which is the catalog's own
 * (`visibleEntries`: `order`, then title; `sidebarOrder` sorts the same way). A list with no
 * category at all answers one `null` group carrying it unchanged, so a guild that files nothing
 * sees exactly the catalog it saw before.
 */
export function groupByCategory(entries: readonly Entry[]): CategoryGroup[] {
  const named = new Map<string, CategoryGroup>();
  const uncategorized: Entry[] = [];
  for (const entry of entries) {
    const category = categoryOf(entry);
    if (category === null) {
      uncategorized.push(entry);
      continue;
    }
    const group = named.get(category);
    if (group === undefined) named.set(category, { category, entries: [entry] });
    else group.entries.push(entry);
  }
  const groups = [...named.values()];
  groups.sort((a, b) => {
    const order = groupOrder(a) - groupOrder(b);
    if (order !== 0) return order;
    return (a.category as string).localeCompare(b.category as string, 'en');
  });
  if (uncategorized.length > 0) groups.push({ category: null, entries: uncategorized });
  return groups;
}

// ---------------------------------------------------------------- which catalog is in force

/**
 * SP05 §2 + O2/SP04 §1: which of the two catalogs a Nod serves. `connected` is the verified
 * snapshot's; `local` is the `tool`/`role` tables, the one a Nod that never joined runs on.
 */
export type CatalogMode = 'local' | 'connected';

/**
 * The switch, in one place (owner decision 2026-10-17): the snapshot's catalog only while a `host`
 * row exists **and** this build is not older than the host's `minAppVersion`. Too old, the guild is
 * disconnected — the person runs on the local catalog as if no host existed, while the row, the
 * bearer and the cached body stay on disk untouched and Settings → Hosts still shows the guild.
 * `updateRequired` is `false` without a `host` row (`backend/sync.ts`), so a local-only Nod is never
 * moved off its own tables.
 */
export function catalogMode(hasHostRow: boolean, updateRequired: boolean): CatalogMode {
  return hasHostRow && !updateRequired ? 'connected' : 'local';
}

// ---------------------------------------------------------------- seed applied

/**
 * What of a seed still does not exist locally. `boot` is the first boot and only advances
 * versions (RF-27); `merge` always applies and never overwrites; `overwrite` always applies and
 * hands back what already exists so the caller can update it (A12).
 */
export function planSeed(
  current: { entries: Id[]; roles: Id[]; invites: string[]; seedVersion: number | null },
  seed: Seed,
  mode: 'boot' | 'merge' | 'overwrite',
): {
  insertEntries: Entry[];
  updateEntries: Entry[];
  insertRoles: Role[];
  updateRoles: Role[];
  insertInvites: InviteSeed[];
  seedVersion: number;
} | null {
  if (mode === 'boot' && current.seedVersion !== null && seed.version <= current.seedVersion) return null;

  const overwrite = mode === 'overwrite';

  return {
    insertEntries: seed.entries.filter((entry) => !current.entries.includes(entry.id)),
    updateEntries: overwrite ? seed.entries.filter((entry) => current.entries.includes(entry.id)) : [],
    insertRoles: seed.roles.filter((role) => !current.roles.includes(role.id)),
    updateRoles: overwrite ? seed.roles.filter((role) => current.roles.includes(role.id)) : [],
    insertInvites: seed.invites.filter((invite) => !current.invites.includes(invite.codeHash)),
    seedVersion: Math.max(current.seedVersion ?? 0, seed.version),
  };
}

// ---------------------------------------------------------------- export

/** Builds an exportable seed from the local state. The icon does not travel (RF-13, §19). */
export function exportSeed(
  d: {
    entries: Entry[];
    roles: Role[];
    invites: InviteSeed[];
    update: { url: string } | null;
    version: number;
  },
  now: Date,
): Seed {
  return validateSeed({
    version: d.version,
    generatedAt: now.toISOString(),
    roles: d.roles.map((role) => ({ id: role.id, name: role.name, admin: role.admin })),
    entries: d.entries.map((entry) => ({ ...entry, icon: null })),
    invites: d.invites.map((invite) => ({
      codeHash: invite.codeHash,
      roles: [...invite.roles],
      expiresAt: invite.expiresAt,
    })),
    update: d.update === null ? null : { url: d.update.url },
  });
}
