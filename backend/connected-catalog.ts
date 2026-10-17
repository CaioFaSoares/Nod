// The effective catalog of a connected Nod (SP05 §2, §4; RF-34): the org tools, the roles and the
// grants of the verified snapshot, parsed once per change and kept in memory, with the 14-day window
// of `docs/canonico.md` §22 (owner, 2026-10-16) applied on top of it.
//
// Why it is not `backend/repo.ts`: while a `host` row exists the `tool`/`role` tables are not the
// catalog (SP05 §2) — they keep the local-mode one, untouched, and removing the host returns to them.
// `backend/main.ts` is the only caller: it hands the `host` row in and puts the answer behind every
// read of the catalog layer (`visibleEntriesOf`, `catalog.list`, `roles.list`, the tool windows).
//
// Nothing here verifies a signature: the body in `host.snapshot` was checked against the pinned key
// by `backend/host-client.ts` before `backend/sync.ts` stored it verbatim (SP04 §2). What is left to
// this module is the shape check of `shared/host-merge.ts` and then the merge itself.
//
// No `tjs`, no `tiny`, no DOM, no `bun:*`: the row arrives as a parameter and the clock as a
// dependency, so `bun test` drives the whole module with a fixture and a fixed instant.

import { visibleEntries } from '../shared/catalog';
import { orgToolsUsable, parseSnapshot, sidebarOrder } from '../shared/host-merge';
import type { SnapshotRows } from '../shared/host-merge';
import type { PersonalView } from '../shared/host-api';
import type { Entry, Id, Role, View } from '../shared/types';

/**
 * What the catalog layer reads of the `host` row (SP05 §2): the last verified body and its clock.
 * `backend/repo.ts`'s `HostRecord` satisfies it whole, so `backend/main.ts` passes the row it read.
 */
export interface HostSnapshotRow {
  /** The last verified body, verbatim, or `null` before the first successful sync. */
  snapshot: string | null;
  /** `version` SP04 §2 puts in the `ETag`, or `null` with the body. */
  version: string | null;
  /** ISO 8601 of the last successful sync: what the 14-day window measures against (SP04 §3). */
  lastSyncAt: string | null;
  /** The host person id of the row: the body has to name the same person (SP05 §2). */
  personId: Id;
}

/** What "the connected catalog" resolves to: one answer for every reader of the catalog layer. */
export interface EffectiveCatalog {
  /** `version` of the body this catalog was read from, or `null` before the first snapshot. */
  version: string | null;
  /** RF-37: whether the org half is being shown at all (`orgToolsUsable`). */
  orgUsable: boolean;
  /** The person the host says this body belongs to (SP04 §2). */
  me: SnapshotRows['me'];
  /** The guild's roles (SP04 §2): the names are not secret inside the guild. */
  roles: Role[];
  /** The entries the person sees, in SP05 §4's order — favorites, org, personal. */
  entries: Entry[];
}

export interface ConnectedCatalogDeps {
  /** Milliseconds since the epoch: what the 14-day window is measured against (SP04 §3). */
  now: () => number;
}

export interface ConnectedCatalog {
  /**
   * Re-derives the catalog from the row the caller just read, and answers whether what the page
   * would see changed — the signal `backend/main.ts` pushes the catalog on.
   *
   * The body is parsed when its bytes changed and not before ("parsed once per change", SP05 §2).
   * The bytes, not the `version`, are the key on purpose: a `401` rewrites the cached body under the
   * same version (`clearOrgData`), and that rewrite has to be read.
   */
  refresh(record: HostSnapshotRow | null): boolean;
  /** The effective catalog, or `null` when there is nothing to read: no row, or no readable body. */
  current(): EffectiveCatalog | null;
  /** The entries the person sees; empty without an effective catalog. */
  entries(): Entry[];
  /** The guild's roles; empty without an effective catalog. */
  roles(): Role[];
}

/** SP04 §2's body, or `null` when the bytes are not that document. */
function readBody(raw: string, personId: Id): SnapshotRows | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  try {
    const rows = parseSnapshot(value);
    // The host signs per person, so a body naming someone else is not this Nod's snapshot: refused
    // like a body that does not read, because what is at stake is showing a guild's catalog.
    return rows.me.id === personId ? rows : null;
  } catch {
    return null;
  }
}

/**
 * SP04 §2: a personal view hangs under any entry the person sees, after that entry's own views —
 * which is the order `tools.openView` indexes and the page's view buttons follow.
 */
function withPersonalViews(entries: Entry[], views: PersonalView[]): Entry[] {
  if (views.length === 0) return entries;
  const byEntry = new Map<Id, View[]>();
  for (const view of views) {
    const list = byEntry.get(view.entryId);
    if (list === undefined) byEntry.set(view.entryId, [view]);
    else list.push(view);
  }
  return entries.map((entry) => {
    const extra = byEntry.get(entry.id);
    return extra === undefined ? entry : { ...entry, views: [...entry.views, ...extra] };
  });
}

export function createConnectedCatalog(deps: ConnectedCatalogDeps): ConnectedCatalog {
  /** The last row seen: everything below is derived from it (`null`: no host, no catalog). */
  let row: HostSnapshotRow | null = null;
  /** The body bytes the cache was parsed from; `null` while there is none. */
  let parsedFrom: string | null = null;
  /** The `version` of that body — the row's own moves on even when a later body does not read. */
  let parsedVersion: string | null = null;
  /** The rows those bytes yielded. A body that does not read keeps the previous ones (SP05 §2). */
  let parsed: SnapshotRows | null = null;
  /** The last effective catalog and what it was built from: the body, and the window's verdict. */
  let built: EffectiveCatalog | null = null;
  let builtFrom: string | null = null;
  let builtUsable: boolean | null = null;
  let builtOnce = false;
  /**
   * The catalog as text, the change detector of the push. It starts at `JSON.stringify(null)`, the
   * empty catalog of a Nod that was never connected, so the first refresh of that state is not
   * news.
   */
  let signature: string = JSON.stringify(null);

  /**
   * SP05 §4's order over SP05 §2's window, in one place: the org half only while `orgToolsUsable`
   * holds (past the window the personal half stays), the favorites in the person's order first, then
   * the org tools, then the personal ones.
   *
   * The org half goes through `shared/catalog.ts`'s `visibleEntries` — the rule the local catalog
   * already applies (`active` plus a grant to one of my roles, or `me.admin` for the whole guild) —
   * and the personal half through `active` alone: SP04 §2 says those are mine by construction.
   */
  function build(usable: boolean): EffectiveCatalog {
    const rows = parsed;
    if (rows === null) throw new Error('no parsed snapshot to build from');
    const org = usable ? visibleEntries(rows.orgTools, rows.me) : [];
    const personal = rows.personalTools.filter((entry) => entry.active !== false);
    const ordered = sidebarOrder({
      orgTools: org,
      personalTools: personal,
      favorites: rows.favorites,
    });
    return {
      // Not the row's `version`: a body that did not read leaves the cache on the previous one, and
      // the catalog answers with the body it is actually showing.
      version: parsedVersion,
      orgUsable: usable,
      me: rows.me,
      roles: rows.roles,
      entries: withPersonalViews(ordered, rows.personalViews),
    };
  }

  /**
   * The effective catalog of the last row seen, rebuilt only when its inputs moved: the body, or the
   * 14-day verdict of the clock (RF-37). A Nod that sat idle past the window therefore hides the org
   * half the moment it is read, and nothing is rebuilt while the verdict is the same — which is what
   * keeps an ordinary read free of work.
   */
  function effective(): EffectiveCatalog | null {
    const source = row;
    const usable = source === null || parsed === null ? null : orgToolsUsable(source.lastSyncAt, deps.now());
    // `parsedFrom` and `builtFrom` are the same string object while the body has not moved, so this
    // is a reference compare: no body is copied to decide it.
    if (!builtOnce || builtFrom !== parsedFrom || builtUsable !== usable) {
      built = usable === null ? null : build(usable);
      builtFrom = parsedFrom;
      builtUsable = usable;
      builtOnce = true;
      // The catalog is worth its own text: what `refresh` compares to answer whether the page has
      // anything new. `null` is the empty catalog, the state a Nod with no host row is in.
      signature = JSON.stringify(built);
    }
    return built;
  }

  function refresh(record: HostSnapshotRow | null): boolean {
    row = record;
    if (record === null || record.snapshot === null) {
      // No host row, or one that never synced: nothing of the guild is cached, and the local tables
      // are the catalog again (SP05 §2).
      parsedFrom = null;
      parsed = null;
      parsedVersion = null;
    } else if (record.snapshot !== parsedFrom) {
      parsedFrom = record.snapshot;
      // A body that does not read keeps the previous cache: the row holds the last bytes the pinned
      // key signed, and a snapshot the Nod cannot read is not one it may show.
      const read = readBody(record.snapshot, record.personId);
      if (read !== null) {
        parsed = read;
        parsedVersion = record.version;
      }
    }
    const before = signature;
    effective();
    return signature !== before;
  }

  function entries(): Entry[] {
    const value = effective();
    return value === null ? [] : value.entries;
  }

  function roles(): Role[] {
    const value = effective();
    return value === null ? [] : value.roles;
  }

  return { refresh, current: effective, entries, roles };
}
