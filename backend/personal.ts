// B7's personal layer: the person's own tools, views and favorites (SP05 §2–§4, SP04 §4).
//
// Two homes, decided by one fact — whether a `host` row exists (SP05 §2):
//
// - **Connected**: the write updates the local cache at once and becomes one `host_outbox` row, which
//   `backend/sync.ts` replays in `id` order (SP04 §4). Nothing here touches the network. The cache is
//   `backend/connected-catalog.ts`'s overlay over the snapshot's personal half
//   (`shared/host-merge.ts`'s `applyOutbox`), so the sidebar, Home and the tool windows show the
//   write before the host ever hears of it — offline included (RF-37).
// - **Local**: the personal tool is a `tool` row with `scope = 'personal'` and its owner's id (SP05
//   §2), and the person's favorites and personal views live in the `meta` table under a key of their
//   own. No new table, so no `user_version` bump: the meta value is the ordered list itself.
//
// The runtime arrives as parameters, so `bun test` drives the whole module against a real temp SQLite
// (`test/helpers/sqlite-bun.ts`) with no runtime at all. Nothing here holds a secret: a personal tool
// is a title and an address, a favorite is an entry id, and the outbox row is one of SP03 §2's three
// personal writes (AGENTS.md).

import { originOf, validateEntry, visibleEntries } from '../shared/catalog';
import { CODE_ALPHABET, HOST_ROUTES } from '../shared/host-api';
import { applyOutbox, attachPersonalViews, parseSnapshot, sidebarOrder } from '../shared/host-merge';
import type { PersonalView } from '../shared/host-api';
import type { AuthOverride, Entry, Id, Person, PersonalToolDraft, View } from '../shared/types';
import type { OutboxOp, SnapshotRows } from '../shared/host-merge';
import type { Repo } from './repo';

// ---------------------------------------------------------------- the id the Nod generates

/** SP03 §2: a personal tool id — `p-` and ten lowercase base32 characters. */
export const PERSONAL_TOOL_ID = /^p-[a-z0-9]{10}$/;

/**
 * SP02 §3's Crockford alphabet, lowercased: the personal id is the code alphabet in the case the
 * host's route pattern (`^p-[a-z0-9]{10}$`, SP03 §2) accepts. Ten characters are fifty bits, which
 * seven random bytes carry with room to spare.
 */
const PERSONAL_ALPHABET = CODE_ALPHABET.toLowerCase();
const PERSONAL_ID_CHARS = 10;
const PERSONAL_ID_BYTES = 7;

/** `p-` and ten random base32 characters: the id of a personal tool the Nod creates (SP03 §2). */
export function generatePersonalToolId(): Id {
  const bytes = crypto.getRandomValues(new Uint8Array(PERSONAL_ID_BYTES));
  let buffer = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += PERSONAL_ALPHABET[(buffer >>> bits) & 31];
      if (out.length === PERSONAL_ID_CHARS) return `p-${out}`;
    }
  }
  // Unreachable: seven bytes hold eleven groups of five bits. Kept so the function is total.
  return `p-${out}${PERSONAL_ALPHABET[0].repeat(PERSONAL_ID_CHARS - out.length)}`;
}

// ---------------------------------------------------------------- what the page sends

/** The draft as the page sent it; the entry-level rules are `shared/catalog.ts`'s `validateEntry`. */
function toolDraft(value: unknown): PersonalToolDraft {
  if (typeof value !== 'object' || value === null) throw new Error('invalid personal tool');
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== 'string' || raw.title.trim() === '') throw new Error('title is required');
  if (typeof raw.url !== 'string') throw new Error('invalid address');
  const draft: PersonalToolDraft = { title: raw.title, url: raw.url };
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id === '') throw new Error('invalid id');
    draft.id = raw.id;
  }
  if (raw.order !== undefined) {
    if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) throw new Error('invalid order');
    draft.order = raw.order;
  }
  if (raw.active !== undefined) {
    if (typeof raw.active !== 'boolean') throw new Error('invalid active');
    draft.active = raw.active;
  }
  if (raw.icon !== undefined) {
    if (raw.icon !== null && typeof raw.icon !== 'string') throw new Error('invalid icon');
    draft.icon = raw.icon;
  }
  if (raw.auth !== undefined) {
    if (raw.auth !== null && typeof raw.auth !== 'object') throw new Error('invalid auth');
    draft.auth = raw.auth as AuthOverride | null;
  }
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views)) throw new Error('invalid views');
    draft.views = raw.views as View[];
  }
  return draft;
}

/** The view draft as the page sent it: the parent entry, the label, the address and the mode. */
function viewDraft(value: unknown): { id?: Id; entryId: Id; label: string; url: string; mode: 'window' | 'navigate' } {
  if (typeof value !== 'object' || value === null) throw new Error('invalid personal view');
  const raw = value as Record<string, unknown>;
  if (typeof raw.entryId !== 'string' || raw.entryId === '') throw new Error('invalid entry');
  if (typeof raw.label !== 'string' || raw.label.trim() === '') throw new Error('view label is required');
  if (typeof raw.url !== 'string') throw new Error('invalid address');
  if (raw.mode !== 'window' && raw.mode !== 'navigate') throw new Error('invalid view mode');
  const draft = { entryId: raw.entryId, label: raw.label, url: raw.url, mode: raw.mode } as {
    id?: Id;
    entryId: Id;
    label: string;
    url: string;
    mode: 'window' | 'navigate';
  };
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id === '') throw new Error('invalid id');
    draft.id = raw.id;
  }
  return draft;
}

/** A `PersonalView` read out of the meta table, or `false` for whatever is not one. */
function isPersonalView(value: unknown): value is PersonalView {
  if (typeof value !== 'object' || value === null) return false;
  const view = value as Record<string, unknown>;
  return (
    typeof view.id === 'string' &&
    typeof view.entryId === 'string' &&
    typeof view.label === 'string' &&
    typeof view.url === 'string' &&
    (view.mode === 'window' || view.mode === 'navigate')
  );
}

// ---------------------------------------------------------------- the module

/** What `createPersonal` needs from `backend/main.ts`. */
export interface PersonalDeps {
  repo: Repo;
  /**
   * The entries the person sees, in the mode's own order — `backend/main.ts`'s `visibleEntriesOf`.
   * It is the effective catalog: the snapshot's while connected (with the outbox overlay applied), the
   * local rows otherwise. `saveTool` reads an entry the person already owns from here, so a second
   * edit of a pending write keeps the first one's fields.
   */
  entries: () => Entry[];
  /** The host person id while connected, the local person id otherwise; both are the owner (SP05 §2). */
  personId: () => Id;
  /** From the `host` row, not from the cache (SP05 §2): a write goes to the outbox whenever one exists. */
  connected: () => boolean;
  /** Epoch milliseconds: `updatedAt` of a write is the Nod's clock (SP04 §4). */
  now: () => number;
  /** A personal tool that goes away takes the credential saved for it (A6); local mode only. */
  removeCredentials: (toolId: Id) => Promise<void>;
  /** A write landed: `backend/main.ts` re-derives the catalog, pushes it and asks for a sync. */
  onWrite: () => void;
}

/** The personal surface of `backend/main.ts` (SP05 §3). */
export interface Personal {
  /** SP05 §3 `personal.saveTool`: the entry as stored, with the id and the owner filled. */
  saveTool(draft: unknown): Entry;
  /** SP05 §3 `personal.removeTool`. */
  removeTool(id: Id): Promise<true>;
  /** SP05 §3 `personal.saveView`: the view as stored, with its id and its write time. */
  saveView(draft: unknown): PersonalView;
  /** SP05 §3 `personal.removeView`. */
  removeView(id: Id): Promise<true>;
  /** SP05 §3 `favorites.set`: the whole ordered list, ids that resolve to nothing dropped. */
  setFavorites(ids: Id[]): Promise<true>;
  /** SP05 §4/§3 (`favorites.list`) in local mode: the person's ordered favorites. */
  localFavorites(personId: Id): Id[];
  /** The local catalog: favorites → org → personal, with the person's views hung under their entry. */
  localCatalog(person: Person): Entry[];
  /**
   * RF-40 (B8b): one local row becomes a personal tool of this person — the same path `saveTool`
   * takes (one outbox row while connected), with its views turned into personal views so they survive
   * the local row going away. An `org` row gets a fresh `p-…` id; a local `personal` row (B7, added
   * before the host existed) keeps its own id, which is already a `p-…` and would otherwise duplicate
   * the tool once the host is removed. `icon` is the data URI of the tool's stored icon (or `null`),
   * resolved by the caller from the icon store. Answers the new entry; the caller re-points the saved
   * credential and removes the local row.
   */
  adoptLocalTool(local: Entry, icon: string | null): Entry;
  /**
   * `host.remove(keepPersonal)` (SP05 §3): what happens to the personal half of the snapshot when the
   * host goes — the tools, their views and the favorites stay as local data, or are dropped with it.
   * `ops` are the writes still in the outbox (B8b): they are part of the half the person is deciding
   * about, and `clearHost` would take them with the host.
   */
  adoptSnapshot(raw: string | null, personId: Id, keep: boolean, ops?: readonly OutboxOp[]): void;
}

/** The meta keys of the local personal data; the person id completes them (SP05 §2, B7). */
const FAVORITES_KEY = 'favorites:';
const VIEWS_KEY = 'personal_views:';

export function createPersonal(deps: PersonalDeps): Personal {
  const repo = deps.repo;

  /** The write time of a row the outbox will replay: the Nod's clock, ISO 8601 UTC (SP04 §4). */
  function writtenAt(): string {
    return new Date(deps.now()).toISOString();
  }

  /** One outbox row: the method, the SP03 §2 route with its id in it, and the body (SP04 §4). */
  function queue(method: 'PUT' | 'DELETE', path: string, body: unknown): void {
    repo.enqueueOutbox({ method, path, body: JSON.stringify(body), createdAt: writtenAt() });
  }

  function localViews(personId: Id): PersonalView[] {
    const raw = repo.meta(VIEWS_KEY + personId);
    if (raw === null) return [];
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.filter(isPersonalView) : [];
    } catch {
      // A value this side did not write is not one it reads: no views rather than no catalog.
      return [];
    }
  }

  function localFavorites(personId: Id): Id[] {
    const raw = repo.meta(FAVORITES_KEY + personId);
    if (raw === null) return [];
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((id): id is Id => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  /** The entry a draft describes: the base's fields, the draft's own, normalized by `validateEntry`. */
  function entryFor(draft: PersonalToolDraft, base: Entry | null, id: Id, personId: Id): Entry {
    // The base's personal views are not the tool's own: they hang under it through their own route
    // (SP04 §2), and `applyOutbox` attaches them again when this body comes back as a pending write.
    const views = (draft.views ?? base?.views ?? []).filter((view) => view.scope !== 'personal');
    const validated = validateEntry({
      id,
      title: draft.title,
      url: draft.url,
      icon: draft.icon === undefined ? (base?.icon ?? null) : draft.icon,
      order: draft.order ?? base?.order ?? 0,
      roles: base?.roles ?? [],
      views,
      auth: draft.auth === undefined ? (base?.auth ?? null) : draft.auth,
      active: draft.active ?? base?.active ?? true,
    });
    return { ...validated, scope: 'personal', ownerId: personId };
  }

  /** The person's own tool of this id: the effective entry, and only while it is theirs (SP04 §2). */
  function ownedTool(id: Id, personId: Id): Entry | null {
    // While connected the effective catalog is the snapshot's (SP05 §2), so a local `personal` row
    // (B7, added before the host existed) is hidden from `deps.entries()`; the local table still
    // answers for it, which is what lets RF-40 publish it under its own id (B8b's fix).
    const entry =
      deps.entries().find((candidate) => candidate.id === id) ??
      (deps.connected() ? repo.entry(id) : null);
    return entry !== null && entry.scope === 'personal' && entry.ownerId === personId ? entry : null;
  }

  function saveTool(value: unknown): Entry {
    const personId = deps.personId();
    const draft = toolDraft(value);
    const base = draft.id === undefined ? null : ownedTool(draft.id, personId);
    if (draft.id !== undefined && base === null) throw new Error('not a personal tool of yours');
    // The id is the backend's (SP03 §2): a draft names one only to edit a tool the person already has.
    const id = draft.id ?? generatePersonalToolId();
    const entry = entryFor(draft, base, id, personId);
    if (deps.connected()) {
      // The body is SP03 §2's `PersonalTool` — the entry plus the write time the host compares
      // (SP04 §4); the host drops the `scope`/`ownerId` its schema does not declare.
      queue('PUT', HOST_ROUTES.personalTool.replace(':id', id), { ...entry, updatedAt: writtenAt() });
    } else {
      repo.saveEntry(entry);
    }
    deps.onWrite();
    return entry;
  }

  async function removeTool(id: Id): Promise<true> {
    const personId = deps.personId();
    if (ownedTool(id, personId) === null) throw new Error('not a personal tool of yours');
    if (deps.connected()) {
      queue('DELETE', HOST_ROUTES.personalTool.replace(':id', id), { updatedAt: writtenAt() });
    } else {
      // A6, as `catalog.remove`: the credential of a tool leaves with it. While connected the tool is
      // the host's and the local vault rows are this machine's own, so they stay (B6's reading).
      await deps.removeCredentials(id);
      repo.removeEntry(id);
    }
    deps.onWrite();
    return true;
  }

  function saveView(value: unknown): PersonalView {
    const personId = deps.personId();
    const draft = viewDraft(value);
    const parent = deps.entries().find((entry) => entry.id === draft.entryId) ?? null;
    if (parent === null) throw new Error('unknown tool');
    // The same rule `validateView` applies to a tool's own views (shared/catalog.ts): a view of an
    // entry sits on that entry's origin. Checked here so nothing is queued that the host would refuse.
    if (originOf(draft.url) !== originOf(parent.url)) throw new Error('view outside the tool origin');
    const view: PersonalView = {
      id: draft.id ?? crypto.randomUUID(),
      entryId: draft.entryId,
      label: draft.label,
      url: draft.url,
      mode: draft.mode,
      scope: 'personal',
      ownerId: personId,
      updatedAt: writtenAt(),
    };
    if (deps.connected()) {
      queue('PUT', HOST_ROUTES.personalView.replace(':id', view.id), view);
    } else {
      repo.setMeta(VIEWS_KEY + personId, JSON.stringify([...localViews(personId).filter((v) => v.id !== view.id), view]));
    }
    deps.onWrite();
    return view;
  }

  async function removeView(id: Id): Promise<true> {
    const personId = deps.personId();
    if (deps.connected()) {
      queue('DELETE', HOST_ROUTES.personalView.replace(':id', id), { updatedAt: writtenAt() });
    } else {
      const views = localViews(personId);
      if (!views.some((view) => view.id === id)) throw new Error('view not found');
      repo.setMeta(VIEWS_KEY + personId, JSON.stringify(views.filter((view) => view.id !== id)));
    }
    deps.onWrite();
    return true;
  }

  async function setFavorites(ids: Id[]): Promise<true> {
    const personId = deps.personId();
    // The list is the person's, so an id their cache cannot resolve right now (an org tool of a guild
    // this Nod is signed out of, SP04 §3) keeps its place: `sidebarOrder` skips it while it is dark.
    const ordered: Id[] = [];
    for (const id of ids) {
      if (id === '' || ordered.includes(id)) continue;
      ordered.push(id);
    }
    if (deps.connected()) {
      queue('PUT', HOST_ROUTES.favorites, { entries: ordered, updatedAt: writtenAt() });
    } else {
      repo.setMeta(FAVORITES_KEY + personId, JSON.stringify(ordered));
    }
    deps.onWrite();
    return true;
  }

  function adoptLocalTool(local: Entry, icon: string | null): Entry {
    // A local `personal` row is already the person's own tool (B7): it keeps its id — the host's own
    // `p-…` shape — so the saved credential is not re-pointed and a later `host.remove` does not
    // materialize a second copy. Any other local row gets a fresh id, like a new personal tool.
    const reuseId = local.scope === 'personal' && PERSONAL_TOOL_ID.test(local.id);
    // The tool first: `saveView` below reads its parent out of the effective catalog, and the new
    // personal tool is in it once `saveTool`'s `onWrite` re-derived the cache (B7).
    const entry = saveTool({
      ...(reuseId ? { id: local.id } : {}),
      title: local.title,
      url: local.url,
      icon,
      order: local.order,
      auth: local.auth,
      active: local.active,
    });
    // A personal row keeps its views in the meta table (B7), not in the row; an org row carries them
    // itself. Either way each view goes through its own route (SP03 §2): the host drops the `views` a
    // tool body carries, so a view kept inside the tool's write would be lost at the next snapshot.
    const views =
      local.scope === 'personal'
        ? localViews(deps.personId()).filter((view) => view.entryId === local.id)
        : local.views;
    for (const view of views) {
      saveView({ entryId: entry.id, label: view.label, url: view.url, mode: view.mode });
    }
    return entry;
  }

  /**
   * SP05 §2, local mode: the person's own rows, the local favorites of SP05 §4 and their personal
   * views, in SP05 §4's order — favorites first, then the org tools the person is granted, then their
   * own tools. `shared/catalog.ts`'s `visibleEntries` is the rule the org half already follows, and
   * the personal half is the person's own rows alone: an owner check in SQL is the host's business,
   * not this table's (SP05 §2 keeps personal rows in `tool` with `owner_id`).
   */
  function localCatalog(person: Person): Entry[] {
    const rows = repo.listEntries();
    const ordered = sidebarOrder({
      orgTools: visibleEntries(
        rows.filter((entry) => entry.scope !== 'personal'),
        person,
      ),
      personalTools: rows.filter(
        (entry) => entry.scope === 'personal' && entry.ownerId === person.id && entry.active,
      ),
      favorites: localFavorites(person.id),
    });
    return attachPersonalViews(ordered, localViews(person.id));
  }

  function adoptSnapshot(raw: string | null, personId: Id, keep: boolean, ops: readonly OutboxOp[] = []): void {
    if (raw === null) return;
    let rows: SnapshotRows;
    try {
      rows = parseSnapshot(JSON.parse(raw) as unknown);
    } catch {
      // A body this side cannot read is not one it adopts; the host is gone either way.
      return;
    }
    // SP04 §4/B8b: a write still in the outbox belongs to the personal half this person is deciding
    // about — `clearHost` takes the outbox with the host, so without this overlay a personal tool the
    // person just added (the leftovers a join adopted) would go with it, kept or not.
    const half = applyOutbox(
      { personalTools: rows.personalTools, personalViews: rows.personalViews, favorites: rows.favorites },
      ops,
    );
    if (!keep) {
      for (const entry of half.personalTools) {
        const row = repo.entry(entry.id);
        if (row !== null && row.scope === 'personal' && row.ownerId === personId) repo.removeEntry(entry.id);
      }
      repo.setMeta(FAVORITES_KEY + personId, JSON.stringify([]));
      repo.setMeta(VIEWS_KEY + personId, JSON.stringify([]));
      return;
    }
    for (const entry of half.personalTools) {
      repo.saveEntry({ ...entry, scope: 'personal', ownerId: personId });
    }
    repo.setMeta(FAVORITES_KEY + personId, JSON.stringify(half.favorites));
    repo.setMeta(
      VIEWS_KEY + personId,
      JSON.stringify(half.personalViews.map((view) => ({ ...view, scope: 'personal', ownerId: personId }))),
    );
  }

  return {
    saveTool,
    removeTool,
    saveView,
    removeView,
    setFavorites,
    localFavorites,
    localCatalog,
    adoptLocalTool,
    adoptSnapshot,
  };
}
