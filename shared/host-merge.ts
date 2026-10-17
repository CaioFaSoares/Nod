// Pure merge of one verified host snapshot into the Nod's own shapes (SP04 §2, §4, SP05 §1–§2,
// §4): the rows the catalog layer keeps, the sidebar order, the one decision an outbox replay asks
// for and the window in which the cached org half may still be shown.
//
// Imported by `backend/sync.ts` (B4) and by whatever renders the sidebar from the cache (B5/B2).
// No `tjs`, no `tiny`, no DOM, no `bun:*`: the language and type-only imports, as `shared/context.md`
// requires of every module of this folder.

import type { PersonalView, Snapshot } from './host-api';
import type { Entry, Id, Role } from './types';

// ---------------------------------------------------------------- the cached org window

/**
 * `docs/canonico.md` §22, "Stale cache" (owner, 2026-10-16): a connected Nod that is offline keeps
 * showing org tools from the cache for 14 days after the last successful sync, and after that hides
 * them until a sync succeeds (RF-37, RF-39). `backend/sync.ts` keeps the cache; the catalog layer
 * decides with `orgToolsUsable` whether the org half of it is still shown.
 */
export const ORG_CACHE_DAYS = 14;

/** `ORG_CACHE_DAYS` in milliseconds: what {@link orgToolsUsable} measures against. */
export const ORG_CACHE_MS = ORG_CACHE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Whether org tools may still be shown from a cache last written at `lastSyncAt`.
 *
 * The window is the half-open `[lastSyncAt, lastSyncAt + ORG_CACHE_MS)`: the day it completes, the
 * org half is hidden until a sync succeeds. A row that never synced (no `lastSyncAt`) has no cached
 * org data to show, and a date this function cannot read is treated the same way — fail closed,
 * because what is at stake is showing a guild's tools to someone the host may no longer admit.
 */
export function orgToolsUsable(lastSyncAt: string | null, now: number): boolean {
  if (lastSyncAt === null) return false;
  const syncedAt = Date.parse(lastSyncAt);
  if (Number.isNaN(syncedAt)) return false;
  return now - syncedAt < ORG_CACHE_MS;
}

// ---------------------------------------------------------------- the snapshot body

/** A body that is not the document of SP04 §2, at the depth this module reads it. */
export class SnapshotShapeError extends Error {
  constructor(what: string) {
    super(`the snapshot is not the document SP04 §2 defines: ${what}`);
  }
}

/**
 * The rows one verified snapshot holds: the org half (the guild's roles and the org tools granted to
 * me, `Entry.roles` carrying the grants), the personal half, and the favorites in the person's order
 * (SP04 §2). This is what SP05 §2 calls the cache "parsed once per change and kept in memory".
 *
 * `guildIcon` is the guild's own icon as the snapshot carries it (the host-side digest of the guild
 * PNG, or `null` when the guild has none); it is kept beside the rows so a cache rewrite preserves
 * it exactly as it was signed.
 */
export interface SnapshotRows {
  me: Snapshot['me'];
  roles: Role[];
  orgTools: Entry[];
  personalTools: Entry[];
  personalViews: PersonalView[];
  favorites: Id[];
  guildIcon: string | null;
}

/** The rows plus the two fields the `host` row stores beside the body (SP04 §2). */
interface SnapshotBody {
  version: string;
  issuedAt: string;
  rows: SnapshotRows;
}

function object(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotShapeError(what);
  return v as Record<string, unknown>;
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new SnapshotShapeError(what);
  return v;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new SnapshotShapeError(what);
  return v;
}

function readMe(v: unknown): Snapshot['me'] {
  const me = object(v, 'me');
  const kind = me.kind;
  if (kind !== 'member' && kind !== 'client') throw new SnapshotShapeError('me.kind');
  if (typeof me.admin !== 'boolean') throw new SnapshotShapeError('me.admin');
  return {
    id: text(me.id, 'me.id'),
    email: text(me.email, 'me.email'),
    name: text(me.name, 'me.name'),
    roles: list(me.roles, 'me.roles').map((role) => text(role, 'me.roles')),
    admin: me.admin,
    kind,
  };
}

function readRole(v: unknown): Role {
  const role = object(v, 'role');
  if (typeof role.admin !== 'boolean') throw new SnapshotShapeError('role.admin');
  return { id: text(role.id, 'role.id'), name: text(role.name, 'role.name'), admin: role.admin };
}

/**
 * `Entry`'s spine, as the sidebar and the catalog layer read it. The rest travels as the host sent
 * it — `scope`, `ownerId`, `icon`, the views and their ids, `auth`, `active` (SP04 §2) — so nothing
 * of the document is lost to a second normalization here.
 */
function readEntry(v: unknown): Entry {
  const entry = object(v, 'entry');
  text(entry.id, 'entry.id');
  text(entry.title, 'entry.title');
  text(entry.url, 'entry.url');
  if (typeof entry.order !== 'number') throw new SnapshotShapeError('entry.order');
  list(entry.roles, 'entry.roles');
  list(entry.views, 'entry.views');
  return v as Entry;
}

function readPersonalView(v: unknown): PersonalView {
  const view = object(v, 'personal view');
  text(view.id, 'view.id');
  text(view.entryId, 'view.entryId');
  text(view.label, 'view.label');
  text(view.url, 'view.url');
  if (view.mode !== 'window' && view.mode !== 'navigate') throw new SnapshotShapeError('view.mode');
  return v as PersonalView;
}

function readBody(value: unknown): SnapshotBody {
  const body = object(value, 'body');
  if (body.api !== 1) throw new SnapshotShapeError('api');
  return {
    version: text(body.version, 'version'),
    issuedAt: text(body.issuedAt, 'issuedAt'),
    rows: {
      me: readMe(body.me),
      roles: list(body.roles, 'roles').map(readRole),
      orgTools: list(body.orgTools, 'orgTools').map(readEntry),
      personalTools: list(body.personalTools, 'personalTools').map(readEntry),
      personalViews: list(body.personalViews, 'personalViews').map(readPersonalView),
      favorites: list(body.favorites, 'favorites').map((id) => text(id, 'favorites')),
      // Cosmetic, so read permissively: a missing or non-string icon is `null`, not a shape refusal.
      guildIcon: typeof body.guildIcon === 'string' ? body.guildIcon : null,
    },
  };
}

/**
 * SP04 §2's snapshot body, read into the rows the Nod keeps. `backend/host-client.ts` has already
 * checked the bytes with the pinned key; this is the shape check of the document itself, which is
 * where the rest of the body stops being `unknown` (B1 left it here on purpose).
 */
export function parseSnapshot(value: unknown): SnapshotRows {
  return readBody(value).rows;
}

/**
 * SP04 §3, RF-39: a `401` drops the org half of the cache and keeps the personal half. `raw` is the
 * body the Nod holds; the answer is the body to hold instead, with the guild's roles and org tools
 * gone and `me`, the personal tools, the personal views and the favorites keeping their place.
 *
 * The body no longer carries the bytes the host signed, so the caller must not offer its `version`
 * as an `ETag` again (`backend/sync.ts` marks that). A favorite may now point at nothing: it is the
 * person's own data and stays, and `sidebarOrder` skips what it cannot resolve. `null` means the
 * body was not a snapshot at all, and then nothing is rewritten: the catalog layer can read nothing
 * out of it anyway.
 */
export function clearOrgData(raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  let body: SnapshotBody;
  try {
    body = readBody(value);
  } catch {
    return null;
  }
  const cleared: Snapshot = {
    api: 1,
    version: body.version,
    issuedAt: body.issuedAt,
    me: body.rows.me,
    roles: [],
    orgTools: [],
    personalTools: body.rows.personalTools,
    personalViews: body.rows.personalViews,
    favorites: body.rows.favorites,
    guildIcon: body.rows.guildIcon,
  };
  return JSON.stringify(cleared);
}

// ---------------------------------------------------------------- sidebar

/**
 * SP05 §4: the favorites first, in the order the person chose, then the org tools, then the personal
 * ones — inside each group in the order the local catalog already uses (`order`, then title, as in
 * `shared/catalog.ts`'s `visibleEntries`). An id that resolves to no entry is skipped, which is what
 * a favorite of an org tool looks like once a sign-out emptied the org half.
 */
export function sidebarOrder(rows: {
  orgTools: Entry[];
  personalTools: Entry[];
  favorites: Id[];
}): Entry[] {
  const known = new Map<Id, Entry>();
  for (const entry of [...rows.orgTools, ...rows.personalTools]) {
    if (!known.has(entry.id)) known.set(entry.id, entry);
  }
  const ordered: Entry[] = [];
  const placed = new Set<Id>();
  for (const id of rows.favorites) {
    const entry = known.get(id);
    if (entry === undefined || placed.has(id)) continue;
    placed.add(id);
    ordered.push(entry);
  }
  for (const group of [rows.orgTools, rows.personalTools]) {
    const sorted = group.slice().sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'en'));
    for (const entry of sorted) {
      if (placed.has(entry.id)) continue;
      placed.add(entry.id);
      ordered.push(entry);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------- outbox

/**
 * SP04 §4's verdict on a replay that did **not** work: `drop` is the `409` whose newer version the
 * next snapshot brings, `rejected` is another `4xx` the host refused for good, and `retry` is the
 * `5xx` or the call that never reached the host — and the caller stops the flush there.
 *
 * Only failures are asked: a request that resolved is SP04 §4's `2xx`, and the caller drops the row
 * without a verdict. `401` and `429` answer `retry` although they are 4xx: neither judges the write —
 * the first says the session ended (SP04 §3 has the run react to it as a whole) and the second asks
 * for patience — and dropping a person's offline write over either would lose it for good.
 */
export type OutboxVerdict = 'drop' | 'rejected' | 'retry';

/** `status` is what the failed call answered; `null` is a call that never reached the host. */
export function outboxVerdict(status: number | null): OutboxVerdict {
  if (status === null) return 'retry';
  if (status === 409) return 'drop';
  if (status >= 400 && status <= 499 && status !== 401 && status !== 429) return 'rejected';
  return 'retry';
}
