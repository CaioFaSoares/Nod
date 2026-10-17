// H7's and O1's person group (SP03 §2): the caller's own device sessions, their personal tools,
// their personal views and their favorites. `host/app.ts` mounts this plugin with one `.use(...)`
// line, the way it mounts the auth, admin, state, event and guild groups (`host/context.md`).
//
// `personAuth` covers every route below it, so a caller without a live session never reaches a
// handler (SP03 §1). The bodies are the shapes of `shared/host-api.ts` — `PersonalTool`,
// `PersonalView`, `DeleteRequest`, `FavoritesRequest` — so the Nod and the host validate the same
// fields; a body that fails its schema is the 400 `host/app.ts` builds, naming the field.
//
// Two rules hold this group together:
//
// - **The caller is the owner.** No route here reads an owner from a body: the person comes from the
//   token, and every repo read and write of personal data is filtered by `owner_id` in its SQL
//   (`host/repo.ts`, SP01 §2). So an id of someone else answers 403, an id no query ever sees
//   answers 404 (SP03 §1), and no admin has a route into this data at all.
// - **`updatedAt` is the Nod's and the host keeps the newest** (SP04 §4): every write carries it, the
//   repo compares it with the stored row and throws the 409 of a stale write, and this file passes it
//   through untouched — the host clock belongs to the org writes of `routes/admin.ts` alone.
//
// No secret travels here. A session row is answered as `DeviceSession`, which is a `sessions` row
// without its `token_hash` (`toDeviceSession`), and no body is ever logged (AGENTS.md).

import { Elysia, status, t } from 'elysia';

import {
  HOST_ROUTES,
  type DeviceOs,
  type DeviceSession,
  type PersonalTool,
  type PersonalView,
} from '../../shared/host-api';
import type { View } from '../../shared/types';
import { callerOf, hostOf, personAuth } from '../auth';
import { ForbiddenError, NotFoundError, type HostTool, type HostView, type SessionRecord } from '../repo';

// ---------------------------------------------------------------- schemas (SP03 §2)

/** SP01 §2: an entry id is a slug, the same pattern `shared/catalog.ts` validates a catalog with. */
const ENTRY_ID = '^[a-z0-9][a-z0-9-]{0,39}$';

/** SP03 §2: the personal tool ids the Nod generates. */
const PERSONAL_ID = '^p-[a-z0-9]{10}$';

/** A uuid (a session or a view); the length bounds a value a caller cannot usefully exceed. */
const idSchema = t.String({ minLength: 1, maxLength: 64 });
const entryIdSchema = t.String({ pattern: ENTRY_ID });
/** SP03 §1's 400 names the field; these are the route parameters, one shape per id kind. */
const idParams = t.Object({ id: idSchema });
const personalIdParams = t.Object({ id: t.String({ pattern: PERSONAL_ID }) });

/** Bounds as in `routes/auth.ts` and `routes/admin.ts`: the shapes are SP01 §2's, the lengths only
 *  keep a body finite. */
const nameSchema = t.String({ minLength: 1, maxLength: 200 });
const textSchema = t.String({ minLength: 1, maxLength: 2048 });
/** ISO 8601 UTC, the instant the Nod wrote (SP04 §4). */
const timestampSchema = t.String({ minLength: 1, maxLength: 40 });

/** `Entry.icon` and `AuthOverride` are nullable on purpose: null is a value, not an absence. */
const nullableText = t.Union([t.String(), t.Null()]);
const authOverride = t.Union([t.Object({ noFill: t.Optional(t.Boolean()) }), t.Null()]);

/**
 * `View` (SP04 §2), as a tool body carries it. This group writes views through their own route
 * (`PUT /v1/personal/views/:id`), so these are read for shape and dropped: a personal view is its
 * own row, and the entry's `views` in an answer is what the repo attached to it.
 */
const viewBody = t.Object({
  id: t.Optional(idSchema),
  label: nameSchema,
  url: textSchema,
  mode: t.Union([t.Literal('window'), t.Literal('navigate')]),
});

/** SP03 §2's `PersonalTool` = `Entry` + `updatedAt` (the org twin is `routes/admin.ts`'s `OrgTool`). */
const personalToolBody = t.Object({
  id: t.String({ pattern: PERSONAL_ID }),
  title: nameSchema,
  url: textSchema,
  icon: nullableText,
  order: t.Number(),
  roles: t.Array(idSchema),
  views: t.Array(viewBody),
  auth: authOverride,
  active: t.Boolean(),
  updatedAt: timestampSchema,
});

/** SP03 §2's `PersonalView`: `View` + the id the Nod generated, the entry it hangs under, and its own `updatedAt`. */
const personalViewBody = t.Object({
  id: idSchema,
  entryId: entryIdSchema,
  label: nameSchema,
  url: textSchema,
  mode: t.Union([t.Literal('window'), t.Literal('navigate')]),
  updatedAt: timestampSchema,
});

/** SP03 §2's `DeleteRequest`: the write time the host compares with the stored row (SP04 §4). */
const deleteBody = t.Object({ updatedAt: timestampSchema });

/** SP03 §2's `FavoritesRequest`: the whole ordered list, and the write time (SP04 §4). */
const favoritesBody = t.Object({
  entries: t.Array(entryIdSchema),
  updatedAt: timestampSchema,
});

// ---------------------------------------------------------------- row → wire (SP03 §2)

/**
 * `DeviceSession` (SP03 §2): a live session row without its token hash. `routes/admin.ts` makes the
 * same conversion for the admin read of another person's sessions; a `DeviceSession` is SP03 §2's one
 * shape, so the two must change together (see the finding in `docs/handovers/h7-o1-o2-host.md`).
 */
function toDeviceSession(row: SessionRecord): DeviceSession {
  return {
    id: row.id,
    personId: row.personId,
    device: {
      name: row.device.name,
      os: row.device.os as DeviceOs,
      appVersion: row.device.appVersion,
    },
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
  };
}

/** A view row as `View`: the id, the scope and the owner travel with the label, url and mode. */
function viewOf(row: HostView): View {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    mode: row.mode,
    scope: row.scope,
    ownerId: row.ownerId,
  };
}

/** A personal tool row as `PersonalTool`: the entry's own fields plus the write time of its row. */
function personalToolOf(row: HostTool): PersonalTool {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.ownerId,
    title: row.title,
    url: row.url,
    icon: row.icon,
    order: row.order,
    roles: row.roles,
    views: row.views.map(viewOf),
    auth: row.auth,
    active: row.active,
    updatedAt: row.updatedAt,
  };
}

/** A personal view row as `PersonalView`: the entry it hangs under and its own id and write time. */
function personalViewOf(row: HostView): PersonalView {
  return { ...viewOf(row), id: row.id, entryId: row.entryId, updatedAt: row.updatedAt };
}

// ---------------------------------------------------------------- routes

export const personRoutes = new Elysia({ name: 'host-person-routes' })
  // SP03 §1: below this line the caller must be a live, non-disabled person — a missing or dead token
  // is the guard's 401 `invalid credentials`.
  .use(personAuth)

  // -------------------------------------------------------------- device sessions (O1)

  /** SP03 §2: the caller's own live sessions, most recently seen first, token hashes never (SP02 §5). */
  .get(HOST_ROUTES.sessions, (ctx): DeviceSession[] => {
    const { repo, auth } = hostOf(ctx);
    const { person } = callerOf(ctx);
    return repo.sessionsOfPerson(person.id, auth.now()).map(toDeviceSession);
  })

  /**
   * SP03 §2: revokes one of the caller's own sessions — the device it belongs to is signed out at its
   * next request, because the token no longer resolves (`auth.authenticate`). A session that is
   * already revoked is a no-op `204`, exactly as the admin route treats it; another person's session
   * is 403 (SP03 §1: a row this caller cannot see), never 404.
   */
  .delete(HOST_ROUTES.session, { params: idParams }, (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const { person } = callerOf(ctx);
    const { id } = ctx.params;
    const session = repo.sessionById(id);
    if (session === null) throw new NotFoundError('unknown session');
    if (session.personId !== person.id) throw new ForbiddenError('not yours');
    if (session.revokedAt === null) repo.revokeOwnSession(person.id, id, auth.now());
    return status(204);
  })

  // -------------------------------------------------------------- personal tools (H7)

  /**
   * SP03 §2: upserts a tool the caller owns. The path is the id, and a body naming another one is a
   * body that fails its contract (400, the same check as `routes/admin.ts`). The host decides
   * `scope`, `owner_id` and the ids of views; the body's `updatedAt` is the Nod's and a write older
   * than the stored row is the repo's 409 (SP04 §4).
   */
  .put(HOST_ROUTES.personalTool, { params: personalIdParams, body: personalToolBody }, (ctx) => {
    const { repo } = hostOf(ctx);
    const { person } = callerOf(ctx);
    const { id } = ctx.params;
    if (ctx.body.id !== id) return status(400, { error: 'invalid body: id must match the path id' });
    // `roles` and `views` of the body are shape-checked and not written: a personal entry has no
    // grants (SP01 §2), and a personal view is the route below and its own row.
    const saved: PersonalTool = personalToolOf(
      repo.savePersonalTool(
        person.id,
        {
          id,
          title: ctx.body.title,
          url: ctx.body.url,
          icon: ctx.body.icon,
          order: ctx.body.order,
          auth: ctx.body.auth,
          active: ctx.body.active,
        },
        ctx.body.updatedAt,
      ),
    );
    return saved;
  })

  /** SP03 §2: removes one of the caller's tools; the repo settles the 403 and the stale 409. */
  .delete(HOST_ROUTES.personalTool, { params: personalIdParams, body: deleteBody }, (ctx) => {
    const { repo } = hostOf(ctx);
    const { person } = callerOf(ctx);
    repo.removePersonalTool(person.id, ctx.params.id, ctx.body.updatedAt);
    return status(204);
  })

  // -------------------------------------------------------------- personal views (H7)

  /**
   * SP03 §2: upserts a view the caller owns, hung under an entry they can see — their own tool or an
   * org tool a role of theirs is granted (SP01 §2). An entry they cannot see is the repo's 403, a
   * view id already owned by someone else is 403 too, and a stale `updatedAt` is 409.
   */
  .put(HOST_ROUTES.personalView, { params: idParams, body: personalViewBody }, (ctx) => {
    const { repo } = hostOf(ctx);
    const { person } = callerOf(ctx);
    const { id } = ctx.params;
    if (ctx.body.id !== id) return status(400, { error: 'invalid body: id must match the path id' });
    const saved: PersonalView = personalViewOf(
      repo.savePersonalView(
        person.id,
        {
          id,
          entryId: ctx.body.entryId,
          label: ctx.body.label,
          url: ctx.body.url,
          mode: ctx.body.mode,
        },
        ctx.body.updatedAt,
      ),
    );
    return saved;
  })

  /** SP03 §2: removes one of the caller's views; the repo settles the 403 and the stale 409. */
  .delete(HOST_ROUTES.personalView, { params: idParams, body: deleteBody }, (ctx) => {
    const { repo } = hostOf(ctx);
    const { person } = callerOf(ctx);
    repo.removePersonalView(person.id, ctx.params.id, ctx.body.updatedAt);
    return status(204);
  })

  // -------------------------------------------------------------- favorites (H7)

  /**
   * SP03 §2: replaces the caller's ordered list whole (SP04 §4). A favorite of an entry the person
   * cannot see is the repo's 403, a stale `updatedAt` its 409, and the answer is `204` — the list
   * comes back in the next snapshot (SP04 §2).
   */
  .put(HOST_ROUTES.favorites, { body: favoritesBody }, (ctx) => {
    const { repo } = hostOf(ctx);
    const { person } = callerOf(ctx);
    repo.replaceFavorites(person.id, ctx.body.entries, ctx.body.updatedAt);
    return status(204);
  });
