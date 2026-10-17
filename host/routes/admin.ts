// The admin group of SP03 §2: people, their access codes and sessions, roles, grants, the org
// catalog, the one-time bootstrap and the event log. `host/app.ts` mounts this plugin with one
// `.use(...)` line, exactly like the auth, state and event groups (`host/context.md`).
//
// `adminAuth` covers every route below it, so a caller who is not an admin person never reaches a
// handler (SP03 §1). The bodies are the shapes of `shared/host-api.ts` — `PersonCreateRequest`,
// `PersonUpdateRequest`, `RoleRequest`, `GrantRequest`, `OrgTool`, `PromoteRequest`,
// `BootstrapRequest`, `AdminEventsQuery` — so the Nod and the host validate the same fields; a body
// that fails its schema is the 400 `app.ts` builds, naming the field.
//
// The repo owns every rule and every status (`host/repo.ts`, SP01 §2): a taken email, a stale
// write, the last admin, a grant on a personal entry. This file only translates a validated body
// into what the repo takes and answers with the row it wrote — no rule is repeated here.
//
// No secret leaves here. The access code is generated once (SP02 §3), stored as the hex SHA-256 of
// its normalized form, and returned only in the answer that created it: never listed, never logged,
// and `GET /v1/admin/people` carries no salt and no hash (H2 decision 2). Admin tool writes pass the
// host clock as `updatedAt`; only the personal writes of SP03 §2 carry the Nod's (SP04 §4).

import { Elysia, status, t } from 'elysia';

import { fromBase64url, sha256Hex } from '../../shared/encoding';
import {
  HOST_ROUTES,
  generateCode,
  isPng,
  normalizeCode,
  type AdminPerson,
  type BootstrapResponse,
  type CodeResponse,
  type DeviceOs,
  type DeviceSession,
  type GuildIconResponse,
  type HostEvent,
  type OrgTool,
  type PersonCreateResponse,
} from '../../shared/host-api';
import type { Entry, Role } from '../../shared/types';
import { adminAuth, callerOf, hostOf, personAuth } from '../auth';
import {
  ForbiddenError,
  NotFoundError,
  type HostPerson,
  type SessionRecord,
  type ToolInput,
} from '../repo';

// ---------------------------------------------------------------- schemas (SP03 §2)

/** SP01 §2: an entry id is a slug, the same pattern `shared/catalog.ts` validates a catalog with. */
const ENTRY_ID = '^[a-z0-9][a-z0-9-]{0,39}$';

/** SP03 §2: the personal tool ids the Nod generates. */
const PERSONAL_ID = '^p-[a-z0-9]{10}$';

/** A uuid (person, session, view id); the length bounds a value a caller cannot usefully exceed. */
const idSchema = t.String({ minLength: 1, maxLength: 64 });
const entryIdSchema = t.String({ pattern: ENTRY_ID });
/** SP03 §1's 400 names the field; these are the route parameters, one shape per id kind. */
const idParams = t.Object({ id: idSchema });
const entryIdParams = t.Object({ id: entryIdSchema });

/** Bounds as in `routes/auth.ts`: the shapes are SP01 §2's, the lengths only keep a body finite. */
const emailSchema = t.String({ minLength: 1, maxLength: 320 });
const nameSchema = t.String({ minLength: 1, maxLength: 200 });
const textSchema = t.String({ minLength: 1, maxLength: 2048 });
/** The org tool ids a write cites; a role id is a slug by SP01 §2 but nothing validates it there. */
const roleIds = t.Array(idSchema);

/** `Entry.icon` and `AuthOverride` are nullable on purpose: null is a value, not an absence. */
const nullableText = t.Union([t.String(), t.Null()]);
const authOverride = t.Union([t.Object({ noFill: t.Optional(t.Boolean()) }), t.Null()]);

/**
 * `View` (SP04 §2): the id is optional because a write may carry a view the host has not created
 * yet — the route gives it one (`toToolInput`).
 */
const viewBody = t.Object({
  id: t.Optional(idSchema),
  label: nameSchema,
  url: textSchema,
  mode: t.Union([t.Literal('window'), t.Literal('navigate')]),
});

/** `OrgTool` = `Entry` + views (SP03 §2): the body and the answer of the admin tool routes. */
const toolBody = t.Object({
  id: entryIdSchema,
  title: nameSchema,
  url: textSchema,
  icon: nullableText,
  order: t.Number(),
  roles: roleIds,
  views: t.Array(viewBody),
  auth: authOverride,
  active: t.Boolean(),
});

const personCreateBody = t.Object({
  email: emailSchema,
  name: nameSchema,
  roles: roleIds,
});

/** SP03 §2: "only what the caller sends changes", so every field is optional. */
const personUpdateBody = t.Object({
  name: t.Optional(nameSchema),
  roles: t.Optional(roleIds),
  disabled: t.Optional(t.Boolean()),
});

const roleBody = t.Object({ name: nameSchema, admin: t.Boolean() });

const grantBody = t.Object({
  roleId: idSchema,
  entryId: idSchema,
  granted: t.Boolean(),
});

const promoteBody = t.Object({ personalId: t.String({ pattern: PERSONAL_ID }) });

const bootstrapBody = t.Object({
  tools: t.Array(toolBody),
  roles: t.Array(t.Object({ id: idSchema, name: nameSchema, admin: t.Boolean() })),
});

/**
 * SP03 §2's `GuildIconRequest`: base64url of the PNG bytes, so the schema refuses the alphabet that
 * is not base64url (padding, `+`, `/`) before a handler sees it. The body limit of `host/app.ts`
 * bounds the length — this path is in its icon exception — so no `maxLength` restates it here.
 */
const guildIconBody = t.Object({
  png: t.String({ minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }),
});

/** SP03 §2's `?person&tool&from&to&limit`, in the wire names of the URL (`AdminEventsQuery`). */
const eventsQuery = t.Object({
  person: t.Optional(idSchema),
  tool: t.Optional(idSchema),
  from: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
  to: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
  limit: t.Optional(t.Numeric({ minimum: 1 })),
});

// ---------------------------------------------------------------- helpers

/**
 * SP03 §1's 404: the repo throws it wherever a query can tell on its own, and a route that had to
 * read a row first throws the same type with the same wording — the app builds the response, never
 * this file.
 */
function unknown(what: string): never {
  throw new NotFoundError(`unknown ${what}`);
}

/** SP02 §3: what the host stores is the hex SHA-256 of the normalized code, never the code. */
async function storedCodeHash(code: string): Promise<string> {
  const normalized = normalizeCode(code);
  // `generateCode` answers Crockford base32 by construction; this guards the day it does not.
  if (normalized === null) throw new Error('a generated access code must be Crockford base32');
  return await sha256Hex(normalized);
}

/**
 * SP03 §2's `OrgTool` → the repo's write shape: `Entry` field for field, plus a view id for every
 * view the write leaves out (the host creates the view, SP04 §2). The path or the body decides the
 * id; the host always decides `scope`, `owner_id` and `updated_at` (SP01 §2).
 */
function toToolInput(id: string, tool: Entry): ToolInput {
  return {
    id,
    title: tool.title,
    url: tool.url,
    icon: tool.icon ?? null,
    order: tool.order,
    roles: tool.roles,
    auth: tool.auth ?? null,
    active: tool.active,
    views: tool.views.map((view) => ({
      id: view.id ?? crypto.randomUUID(),
      label: view.label,
      url: view.url,
      mode: view.mode,
    })),
  };
}

/**
 * `DeviceSession` (SP03 §2): a live session row without its token hash. `repo.Device.os` is a
 * `string` where SP01 §2 fixes three values (the finding of `docs/handovers/c1.md`, whose fix is a
 * one-line change in `host/repo.ts`, H2's file); the cast is the route's side of it.
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

// ---------------------------------------------------------------- routes

export const adminRoutes = new Elysia({ name: 'host-admin-routes' })
  // SP03 §1: below this line the caller must be an admin; `adminAuth` carries `personAuth`, so a
  // missing or dead token is a 401 and a live non-admin person is a 403 `admin only`.
  //
  // `personAuth` is mounted here first because the two guards are plugins: a `derive` of a plugin
  // does not reach the `derive` of the plugin that mounts it, so `adminAuth`'s own derive would read
  // `person` as undefined and answer 500 (its nested `personAuth` never runs — measured, see
  // `docs/handovers/h5.md`). Mounted this way each guard runs exactly once per request, in the order
  // `person` → `admin` → the route.
  .use(personAuth)
  .use(adminAuth)

  // -------------------------------------------------------------- people (SP03 §2)

  /** `AdminPerson[]`: the repo's rows carry no salt and no hash (H2 decision 2). */
  .get(HOST_ROUTES.adminPeople, (ctx): AdminPerson[] => hostOf(ctx).repo.listPeople())

  /**
   * Creates the person and their one access code as one unit of work (SP02 §3): the code is bound
   * to the person's email, dies after 72 h, and is answered here and never again.
   */
  .post(HOST_ROUTES.adminPeople, { body: personCreateBody }, async (ctx): Promise<PersonCreateResponse> => {
    const { repo, auth } = hostOf(ctx);
    const code = generateCode('access');
    // The hash is computed before the transaction: `repo.transaction` is synchronous (H2 decision 14).
    const codeHash = await storedCodeHash(code);
    const now = auth.now();
    const { person, expiresAt } = repo.transaction(() => {
      const created = repo.createPerson(
        {
          id: crypto.randomUUID(),
          email: ctx.body.email,
          name: ctx.body.name,
          roles: ctx.body.roles,
        },
        now,
      );
      const record = repo.issueCode(
        { id: crypto.randomUUID(), purpose: 'activate', personId: created.id, codeHash },
        now,
      );
      return { person: created, expiresAt: record.expiresAt };
    });
    return { person, code, expiresAt };
  })

  /** SP03 §2: only what the caller sends changes; disabling revokes every session of the person. */
  .patch(HOST_ROUTES.adminPerson, { params: idParams, body: personUpdateBody }, (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const { id } = ctx.params;
    const { name, roles, disabled } = ctx.body;
    const updated: AdminPerson = repo.transaction(() => {
      let person: HostPerson | null = null;
      if (name !== undefined) person = repo.renamePerson(id, name);
      if (roles !== undefined) person = repo.setRoles(id, roles);
      if (disabled !== undefined) person = repo.setDisabled(id, disabled, auth.now());
      // An empty body answers the stored person; an id nobody holds is the 404 of SP03 §1.
      return person ?? repo.personById(id) ?? unknown('person');
    });
    return updated;
  })

  /** SP03 §2: a reissued code replaces the previous one — the repo revokes it as it stores the new. */
  .post(HOST_ROUTES.adminPersonCode, { params: idParams }, async (ctx): Promise<CodeResponse> => {
    const { repo, auth } = hostOf(ctx);
    const { id } = ctx.params;
    // `access_codes.person_id` is a foreign key: a code for an id nobody holds would be a write
    // error, so the person is read first and the answer is SP03 §1's 404.
    if (repo.personById(id) === null) unknown('person');
    const code = generateCode('access');
    const record = repo.issueCode(
      {
        id: crypto.randomUUID(),
        purpose: 'activate',
        personId: id,
        codeHash: await storedCodeHash(code),
      },
      auth.now(),
    );
    return { code, expiresAt: record.expiresAt };
  })

  /** The live sessions of that person, without their token hashes (SP03 §2). */
  .get(HOST_ROUTES.adminPersonSessions, { params: idParams }, (ctx): DeviceSession[] => {
    const { repo, auth } = hostOf(ctx);
    const { id } = ctx.params;
    if (repo.personById(id) === null) unknown('person');
    return repo.sessionsOfPerson(id, auth.now()).map(toDeviceSession);
  })

  // -------------------------------------------------------------- sessions

  /** SP03 §2: the admin ends anyone's session; an id nobody holds is 404, a dead one is a no-op. */
  .delete(HOST_ROUTES.adminSession, { params: idParams }, (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const { id } = ctx.params;
    const session = repo.sessionById(id);
    if (session === null) unknown('session');
    if (session.revokedAt === null) repo.revokeSession(id, auth.now());
    return status(204);
  })

  // -------------------------------------------------------------- roles, grants

  /** SP03 §2: upsert; demoting the last admin role is the repo's 409 (SP01 §2). */
  .put(HOST_ROUTES.adminRole, { params: idParams, body: roleBody }, (ctx): Role => {
    const { repo } = hostOf(ctx);
    return repo.saveRole({ id: ctx.params.id, name: ctx.body.name, admin: ctx.body.admin });
  })

  /** SP03 §2: `409` when removing the role would leave the guild without an admin. */
  .delete(HOST_ROUTES.adminRole, { params: idParams }, (ctx) => {
    hostOf(ctx).repo.removeRole(ctx.params.id);
    return status(204);
  })

  /** SP03 §2: `{ roleId, entryId, granted }`; a grant references an org entry only (SP01 §2). */
  .put(HOST_ROUTES.adminGrants, { body: grantBody }, (ctx) => {
    const { repo } = hostOf(ctx);
    repo.grant(ctx.body.roleId, ctx.body.entryId, ctx.body.granted);
    return status(204);
  })

  // -------------------------------------------------------------- org tools

  /**
   * SP03 §2: `OrgTool` (Entry + views) in and out. The path is the entry's id — a body naming
   * another one is a body that fails its contract, answered 400 with the field it failed on.
   */
  .put(HOST_ROUTES.adminTool, { params: entryIdParams, body: toolBody }, (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const id = ctx.params.id;
    if (ctx.body.id !== id) return status(400, { error: 'invalid body: id must match the path id' });
    // The host clock, never the body's: an org write has no `updatedAt` of the Nod's (SP04 §4).
    const saved: OrgTool = repo.saveOrgTool(toToolInput(id, ctx.body), auth.now());
    return saved;
  })

  .delete(HOST_ROUTES.adminTool, { params: entryIdParams }, (ctx) => {
    hostOf(ctx).repo.removeOrgTool(ctx.params.id);
    return status(204);
  })

  /**
   * SP03 §2: copies one of the caller's **personal** tools into the org catalog, under the id of
   * the path, and the owner keeps theirs. The copy starts with no grants and with fresh view ids —
   * a personal view is its owner's row (SP01 §2), so it is copied, never moved.
   */
  .post(HOST_ROUTES.adminToolPromote, { params: entryIdParams, body: promoteBody }, (ctx): OrgTool => {
    const { repo, auth } = hostOf(ctx);
    const { person } = callerOf(ctx);
    // A personal tool is only ever read through its owner (`host/repo.ts`): an id the admin does not
    // own is invisible to them, which SP03 §1 answers 403, not 404.
    const personal = repo.personalTool(person.id, ctx.body.personalId);
    if (personal === null) throw new ForbiddenError('not yours');
    const id = ctx.params.id;
    // The copy is `Entry` field for field: the tool's own fields, no grants (the admin grants next)
    // and the views without their ids, so `toToolInput` gives each copy a new one.
    const copy: Entry = {
      id,
      title: personal.title,
      url: personal.url,
      icon: personal.icon,
      order: personal.order,
      roles: [],
      views: personal.views.map((view) => ({ label: view.label, url: view.url, mode: view.mode })),
      auth: personal.auth,
      active: personal.active,
    };
    return repo.saveOrgTool(toToolInput(id, copy), auth.now());
  })

  /**
   * SP03 §2, B8a: roles and tools in one write, once — the repo refuses it the moment the host has
   * an org tool (409). `created` counts the org tools this request wrote.
   */
  .post(HOST_ROUTES.adminBootstrap, { body: bootstrapBody }, (ctx): BootstrapResponse => {
    const { repo, auth } = hostOf(ctx);
    repo.bootstrap(
      {
        roles: ctx.body.roles,
        tools: ctx.body.tools.map((tool) => toToolInput(tool.id, tool)),
      },
      auth.now(),
    );
    return { created: ctx.body.tools.length };
  })

  // -------------------------------------------------------------- guild icon

  /**
   * SP03 §2: stores the guild icon — base64url of the PNG bytes — and answers the lowercase hex
   * SHA-256 of exactly those bytes. That digest is what the snapshot signs (SP04 §2), so the icon is
   * stored with it and never decoded again; the bytes go to SP01 §1's single file, and no copy is
   * written anywhere else.
   *
   * A body that is not base64url, or whose bytes are not a PNG, is the 400 of SP03 §1 naming the
   * field. Nothing is echoed: the message is static and the image is never logged.
   */
  .put(
    HOST_ROUTES.adminGuildIcon,
    { body: guildIconBody },
    async (ctx) => {
      const { repo } = hostOf(ctx);
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        // The schema caught a character outside the alphabet; this catches the rest of the encoding
        // rule (`shared/encoding.ts`: padding, a length without whole bytes, non-zero trailing bits).
        bytes = fromBase64url(ctx.body.png);
      } catch {
        return status(400, { error: 'invalid body: png is not base64url' });
      }
      if (!isPng(bytes)) return status(400, { error: 'invalid body: png must be a PNG' });
      // SP03 §2's decoded ceiling is the encoded body's, one third smaller: `host/app.ts` gives this
      // path the 512 KB of its icon exception, which refuses a base64 body that could exceed it.
      const sha256 = await sha256Hex(bytes);
      repo.setGuildIcon({ sha256, bytes });
      const answer: GuildIconResponse = { sha256 };
      return answer;
    },
  )

  /**
   * SP03 §2: removes the icon (`204`, and an idempotent one). The next snapshot carries
   * `guildIcon: null`, which is what a Nod reads as "delete your copy and go back to the bundle
   * icon" (SP04 §2).
   */
  .delete(HOST_ROUTES.adminGuildIcon, (ctx) => {
    hostOf(ctx).repo.clearGuildIcon();
    return status(204);
  })

  // -------------------------------------------------------------- events

  /** SP03 §2: newest first, filtered by person, tool and client-time range (`AdminEventsQuery`). */
  .get(HOST_ROUTES.adminEvents, { query: eventsQuery }, (ctx): HostEvent[] => {
    const { repo } = hostOf(ctx);
    const { person, tool, from, to, limit } = ctx.query;
    return repo.listEvents({ personId: person, toolId: tool, from, to, limit });
  });
