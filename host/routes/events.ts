// The event group of SP03 §2: `POST /v1/events`, the host's half of the Bond's event push (SP04 §5).
//
// A batch is at most 500 events, each carrying the Bond's stable client id. That id is the
// idempotency key: the insert is `ON CONFLICT(id) DO NOTHING`, so replaying a batch leaves one row
// per event, and the answer is every id the host now holds — the ones this batch inserted and the
// ones it already had (SP04 §5). The Bond marks exactly those `sent_at`.
//
// The caller is the session's person: the body has no person field, and one sent anyway is dropped
// by the schema below and never read. The URL of SP01 §2 (`origin + pathname` only) is the repo's
// rule, next to the `events.url` column — this file never touches it.
//
// `host/app.ts` mounts this plugin with one `.use(...)` line (H5 owns that file), exactly like the
// auth, admin and state groups (`host/context.md`).

import { Elysia, t } from 'elysia';

import { HOST_ROUTES, type EventsResponse } from '../../shared/host-api';
import type { EventType } from '../../shared/types';
import { callerOf, hostOf, personAuth } from '../auth';

// ---------------------------------------------------------------- schema (SP03 §1–§2)

/** SP03 §2: a batch carries up to 500 events; the 501st is a 400 that names the field. */
export const MAX_EVENTS_PER_BATCH = 500;

/**
 * The kinds of `shared/types.ts`'s `EventType` (canonico §13), which `ClientEvent.kind` types. That
 * type has no runtime list, so the wire schema needs one; keying this object by `EventType` makes
 * the compiler the guard against drift — a kind the type does not declare and a kind it declares
 * and this object misses both fail to build.
 */
const KIND_SET: Readonly<Record<EventType, true>> = {
  account_created: true,
  unlocked: true,
  unlock_failed: true,
  locked: true,
  password_changed: true,
  tool_opened: true,
  view_opened: true,
  login: true,
  load_failed: true,
  navigation_blocked: true,
  external_opened: true,
  download: true,
  credential_saved: true,
  credential_removed: true,
  vault_exported: true,
  vault_imported: true,
  catalog_changed: true,
  catalog_imported: true,
  seed_applied: true,
  grant_changed: true,
  roles_changed: true,
  invite_issued: true,
  access_revoked: true,
  update: true,
};

/** The same list as values, in the order above. `Object.keys` is the only way back from a type. */
const KINDS = Object.keys(KIND_SET) as EventType[];

/** `ClientEvent` types `toolId`, `url`, `result` and `detail` as `X | null`: null is a value. */
const nullableText = t.Union([t.String(), t.Null()]);

/** SP04 §5's `ClientEvent`, with the `at` the Bond's clock produced and the id it is keyed by. */
const clientEvent = t.Object({
  id: t.String({ minLength: 1 }),
  at: t.String({ minLength: 1 }),
  kind: t.Union(KINDS.map((kind) => t.Literal(kind))),
  toolId: nullableText,
  url: nullableText,
  result: nullableText,
  detail: nullableText,
});

/** SP03 §2: `{ events: ClientEvent[] }` (≤ 500). */
const eventsBody = t.Object({
  events: t.Array(clientEvent, { maxItems: MAX_EVENTS_PER_BATCH }),
});

// ---------------------------------------------------------------- routes

export const eventRoutes = new Elysia({ name: 'host-events-routes' })
  // SP03 §1: below this line the caller must be a live, non-disabled person.
  .use(personAuth)

  .post(HOST_ROUTES.events, { body: eventsBody }, (ctx): EventsResponse => {
    const { person, session } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    // SP04 §5: one insert for the batch, idempotent by client id. The person and the session come
    // from the token the guard verified — every event of the batch is theirs, whatever the body
    // says. `auth.now()` is the receipt the row keeps (`received_at`).
    return { acked: repo.addEvents(person.id, session.id, ctx.body.events, auth.now()) };
  });
