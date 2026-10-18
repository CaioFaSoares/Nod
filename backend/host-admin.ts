// The admin side of connected mode (SP05 §3–§4): every write the Tools, Roles and People tabs make,
// the Activity read, and B8a's one-time publish — each one mapped to the route of SP03 §2 that owns
// it, over the `HostConnection` the caller already holds (RF-30: no host row, no connection).
//
// The shapes in and out are `shared/host-api.ts`'s, so the Nod and the host validate the same fields;
// the conversion the other way — this Nod's `EventFilter` into SP03 §2's query, a `HostEvent` into the
// `AuditEvent` the Activity tab renders — happens here and nowhere else.
//
// The bearer is never named here: `HostConnection` reads it from the keychain per call (SP02 §5). No
// message of this file carries a value from a request or from the host's body — the client does not
// even read a failing body (`backend/host-client.ts`) — so a status the caller must explain becomes a
// sentence written on this side (AGENTS.md: no secret, and nothing of the host's text, in an error).
//
// `backend/main.ts` owns the call: it builds this from `connectionOf()` when a `host` row exists and
// keeps the local repository path otherwise, so local mode never reaches the network.

import {
  HOST_ROUTES,
  type AdminPerson,
  type BootstrapRequest,
  type BootstrapResponse,
  type CodeResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type DeviceSession,
  type GuildInvite,
  type HostEvent,
  type OrgTool,
  type PersonUpdateRequest,
  type RoleRequest,
} from '../shared/host-api';
import type { AuditEvent, Entry, EventFilter, EventType, Id, Person, Role, View } from '../shared/types';
import { HostError, type HostConnection } from './host-client';

/**
 * SP03 §2's `409` on `POST /v1/admin/bootstrap` — the window closes with the first org tool
 * (H5 decision 12). The host's own body never reaches the Nod, so this is the Nod's sentence.
 */
export const BOOTSTRAP_CLOSED = 'the guild already has org tools';

/** SP03 §2's `404` on `POST /v1/admin/invites`: a role the guild does not have. */
const UNKNOWN_ROLE = 'the guild has no such role';

/**
 * The invite routes' `404` when every role of the body exists: the host predates 0.5.0 and serves no
 * `/v1/admin/invites` at all — the same plain `404 {"error":"not found"}` an unauthenticated caller
 * gets. The Nod never reads a failing body (`backend/host-client.ts`), so it only knows whether the
 * roles it sent are roles it listed from this host: all known ⇒ the route is missing (RF-64).
 */
export const HOST_TOO_OLD = 'this host does not serve invites yet — redeploy the host';

/**
 * The People screen's two writes on a host older than 0.5.3 (RF-64): that host has no owner concept,
 * so none of `GET /v1/admin/people`'s rows carries a boolean `owner`, its `PATCH`/`DELETE
 * /v1/admin/people/:id` do not exist (a plain `404`) and its events route refuses the local
 * `person_updated`/`person_deleted` kinds with a `400`. The Nod refuses first, with a sentence the
 * screen can show, so neither the write nor the event is ever attempted.
 */
export const HOST_TOO_OLD_PEOPLE = 'this host does not manage people yet — redeploy the host';

/** The one refusal the People screen's two writes share: only the guild owner manages people. */
const OWNER_ONLY = 'only the guild owner can do this';

/** RF-64: the host's own sentence for the owner as a delete target, written on this side. */
const OWNER_KEPT = 'the owner cannot be deleted';

/** SP03 §1's `404` everywhere else. */
const NOT_ON_HOST = 'not found on the host';

/** What `backend/main.ts` calls while a host is connected (SP05 §3). */
export interface HostAdmin {
  /** `PUT /v1/admin/tools/:id` → the stored org tool, grants and views included. */
  saveTool(tool: Entry): Promise<OrgTool>;
  /** `DELETE /v1/admin/tools/:id` → `204`. */
  removeTool(id: Id): Promise<true>;
  /** `PUT /v1/admin/roles/:id` → the stored role. */
  saveRole(role: Role): Promise<Role>;
  /** `DELETE /v1/admin/roles/:id` → `204`; the last admin role is the host's `409`. */
  removeRole(id: Id): Promise<true>;
  /** `PUT /v1/admin/grants` → `204`. A grant applies to an org entry only (SP01 §2). */
  grant(roleId: Id, entryId: Id, granted: boolean): Promise<true>;
  /** `GET /v1/admin/people` → the guild's people, without a salt or a hash (SP03 §2). */
  listPeople(): Promise<Person[]>;
  /** `PATCH /v1/admin/people/:id { roles }` → the stored person. */
  setRoles(personId: Id, roles: Id[]): Promise<Person>;
  /**
   * `PATCH /v1/admin/people/:id { name?, email? }` → the stored person (0.5.3, RF-64). Only the
   * guild owner may rename or re-email: another admin is the host's own `403`, an email another
   * person holds its `409`.
   */
  updatePerson(personId: Id, input: { name?: string; email?: string }): Promise<Person>;
  /**
   * `DELETE /v1/admin/people/:id` → `204` (0.5.3, RF-64). Owner only, and never the owner: either
   * refusal is the host's own; a person it does not have is `NOT_ON_HOST`.
   */
  deletePerson(personId: Id): Promise<true>;
  /** `PATCH /v1/admin/people/:id { disabled: true }` → the person, `disabledAt` filled. */
  disable(personId: Id): Promise<Person>;
  /** `POST /v1/admin/people/:id/code` → a fresh code, the previous one revoked (SP02 §3). */
  issueCode(personId: Id): Promise<CodeResponse>;
  /** `GET /v1/admin/invites` → the guild's invites, newest first (0.5.0, RF-59). */
  listInvites(): Promise<GuildInvite[]>;
  /**
   * `POST /v1/admin/invites` → the invite and the one code of it, which is never returned again.
   * `knownRoles` is this Nod's own list of the guild's role ids (RF-64): it separates the route's
   * `404` for a role the guild does not have from the `404` of a host that serves no invite route
   * at all (`HOST_TOO_OLD`).
   */
  createInvite(input: CreateInviteRequest, knownRoles: Id[]): Promise<CreateInviteResponse>;
  /** `DELETE /v1/admin/invites/:id` → `204`. A person who already joined keeps their account. */
  revokeInvite(id: Id): Promise<true>;
  /** O1/`GET /v1/admin/people/:id/sessions` → that person's devices and their instants (SP03 §2). */
  sessions(personId: Id): Promise<DeviceSession[]>;
  /** O1/`DELETE /v1/admin/sessions/:id` → `204`; the person signs out at their next sync (SP03 §2). */
  revokeSession(id: Id): Promise<true>;
  /** `GET /v1/admin/events` → the guild's log, in the shape the Activity tab renders. */
  listEvents(filter: EventFilter): Promise<AuditEvent[]>;
  /** `POST /v1/admin/bootstrap` → how many org tools were written, or the closed window (B8a). */
  bootstrap(tools: Entry[], roles: Role[]): Promise<{ created: number; refused: boolean }>;
}

/**
 * SP05 §3: the admin handlers ask for this on every call. Without a connection — no `host` row —
 * there is no host admin, and the caller keeps the local repository path (RF-30).
 */
export function hostAdminFor(connection: HostConnection | null): HostAdmin | null {
  return connection === null ? null : createHostAdmin(connection);
}

/**
 * SP03 §2's `OrgTool` carries the entry's own views. While connected the effective entry also hangs
 * the person's personal views under it, for the screens that open them (SP04 §2, B5) — those are the
 * person's rows, not the guild's, and never travel on an admin route.
 */
export function orgViewsOf(views: View[]): View[] {
  return views.filter((view) => view.scope !== 'personal');
}

/**
 * 0.5.3 (RF-64): the People screen's two writes (`people.update`, `people.delete`) are the guild
 * owner's alone, so both RPCs run this gate before they hand anything to the host.
 *
 * It reads `GET /v1/admin/people` first. A host older than 0.5.3 carries no boolean `owner` on any
 * row: its person routes do not exist and its events route refuses the local kinds those writes
 * record, so the Nod refuses with `HOST_TOO_OLD_PEOPLE` before a write or an event — the deployed
 * host stays untouched and Activity sync is never jammed by a batch it would reject.
 *
 * On a 0.5.3 host, `actorId` is the unlocked person: only the row with `owner: true` may call. For
 * `people.delete`, `targetId` is the row being removed — the owner may never be deleted, themselves
 * included. Both are the host's own refusals (`403 owner only`, `403 the owner cannot be deleted`);
 * checking here as well keeps the sentence the screen shows clear and stops the call before it is
 * made.
 */
export async function ownerGate(
  admin: HostAdmin,
  actorId: Id,
  targetId: Id | null = null,
): Promise<void> {
  const people = await admin.listPeople();
  if (!people.some((person) => typeof person.owner === 'boolean')) {
    throw new Error(HOST_TOO_OLD_PEOPLE);
  }
  if (people.find((person) => person.id === actorId)?.owner !== true) throw new Error(OWNER_ONLY);
  if (targetId !== null && people.find((person) => person.id === targetId)?.owner === true) {
    throw new Error(OWNER_KEPT);
  }
}

export function createHostAdmin(connection: HostConnection): HostAdmin {
  /** SP03 §2 writes each path once, with `:id` for the segment the caller fills. */
  function path(template: string, id: string): string {
    return template.replace(':id', encodeURIComponent(id));
  }

  /**
   * `OrgTool` (SP03 §2 = `Entry` + views), field by field: a body carries what the route declares
   * and nothing else, so a `scope` or an `ownerId` of a local row never travels (the host owns both,
   * SP01 §2). A view without an id is one the host has not created yet, which the route accepts.
   */
  function orgTool(tool: Entry): OrgTool {
    return {
      id: tool.id,
      title: tool.title,
      url: tool.url,
      icon: tool.icon ?? null,
      // RF-62: the guild's category travels on every org write — the host route accepts it and the
      // snapshot reads it back. Dropping it here is what left every category set while connected
      // ungrouped on the host; `?? null` is "the guild filed it nowhere" (SP03 §2, host's own null).
      category: tool.category ?? null,
      order: tool.order,
      roles: [...tool.roles],
      views: orgViewsOf(tool.views).map((view) => ({
        id: view.id,
        label: view.label,
        url: view.url,
        mode: view.mode,
      })),
      auth: tool.auth === null ? null : { ...tool.auth },
      active: tool.active,
    };
  }

  /** SP03 §2's `?person&tool&from&to&limit`: the host filters by those; `result` is ours (below). */
  function eventsQuery(filter: EventFilter): string {
    const query = new URLSearchParams();
    if (filter.personId !== undefined) query.set('person', filter.personId);
    if (filter.toolId !== undefined) query.set('tool', filter.toolId);
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    const encoded = query.toString();
    return encoded === '' ? '' : `?${encoded}`;
  }

  /**
   * One host event as the Activity tab reads it. `kind` stays a string on the wire — a newer host may
   * have kinds this Nod does not know (SP03 §2) — and lands in `type`, which the table prints.
   * `receivedAt` is the host clock of the batch that brought it in: it answers the column's question
   * ("is it on the host, and since when?") for a row that is on the host by construction.
   */
  function auditEvent(event: HostEvent): AuditEvent {
    return {
      id: event.id,
      at: event.at,
      personId: event.personId,
      toolId: event.toolId,
      type: event.kind as EventType,
      url: event.url,
      result: event.result,
      detail: event.detail,
      sentAt: event.receivedAt,
    };
  }

  return {
    async saveTool(tool) {
      return await connection.request<OrgTool>('PUT', path(HOST_ROUTES.adminTool, tool.id), orgTool(tool));
    },

    async removeTool(id) {
      await connection.request<void>('DELETE', path(HOST_ROUTES.adminTool, id));
      return true;
    },

    async saveRole(role) {
      const body: RoleRequest = { name: role.name, admin: role.admin };
      return await connection.request<Role>('PUT', path(HOST_ROUTES.adminRole, role.id), body);
    },

    async removeRole(id) {
      await connection.request<void>('DELETE', path(HOST_ROUTES.adminRole, id));
      return true;
    },

    async grant(roleId, entryId, granted) {
      await connection.request<void>('PUT', HOST_ROUTES.adminGrants, { roleId, entryId, granted });
      return true;
    },

    async listPeople() {
      return await connection.request<AdminPerson[]>('GET', HOST_ROUTES.adminPeople);
    },

    async setRoles(personId, roles) {
      const body: PersonUpdateRequest = { roles };
      try {
        return await connection.request<AdminPerson>('PATCH', path(HOST_ROUTES.adminPerson, personId), body);
      } catch (error) {
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
    },

    async disable(personId) {
      const body: PersonUpdateRequest = { disabled: true };
      try {
        return await connection.request<AdminPerson>('PATCH', path(HOST_ROUTES.adminPerson, personId), body);
      } catch (error) {
        // `404` is a person the guild does not have; `409` (the last admin) keeps the host's own
        // generic refusal, because the screen only ever offers a person it just listed.
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
    },

    /**
     * 0.5.3 (RF-64): rename a person or change their email. Only the owner may — another admin's
     * `403 owner only` and a taken email's `409 email taken` are the host's own refusals, kept as
     * they are because the People screen shows them; a person the guild does not have is `NOT_ON_HOST`.
     */
    async updatePerson(personId, input) {
      try {
        return await connection.request<AdminPerson>('PATCH', path(HOST_ROUTES.adminPerson, personId), input);
      } catch (error) {
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
    },

    /**
     * 0.5.3 (RF-64): remove a person from the guild, a hard delete on the host's side. `403 owner
     * only` (a non-owner admin), `403` for deleting the owner or self and the last-admin `409` all
     * keep the host's own refusal; only `404` becomes this side's sentence.
     */
    async deletePerson(personId) {
      try {
        await connection.request<void>('DELETE', path(HOST_ROUTES.adminPerson, personId));
      } catch (error) {
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
      return true;
    },

    async issueCode(personId) {
      try {
        return await connection.request<CodeResponse>('POST', path(HOST_ROUTES.adminPersonCode, personId));
      } catch (error) {
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
    },

    /**
     * 0.5.0 (RF-59): the guild's invites. `GET` answers revoked ones too (the admin list shows their
     * state); `POST` answers the code exactly once — the host stores its hash and nothing else; and
     * `DELETE` sets `revoked_at` on the host, which is idempotent there.
     *
     * A `404` on the `GET` is not "no invites": this Nod sends no id and no role, so an authenticated
     * `404` means the route itself is absent — the host predates 0.5.0 (RF-64). It keeps `HOST_TOO_OLD`
     * so the Settings screen learns why; the tab load is what decides to show that as a note rather
     * than blank the page (`src/settings.ts`).
     */
    async listInvites() {
      try {
        return await connection.request<GuildInvite[]>('GET', HOST_ROUTES.adminInvites);
      } catch (error) {
        if (error instanceof HostError && error.status === 404) throw new Error(HOST_TOO_OLD);
        throw error;
      }
    },

    /**
     * 0.5.3 (RF-64): `knownRoles` is what this Nod listed of the guild (`rolesOf()`), the only thing
     * that separates the two meanings of the route's `404` — a role the guild does not have
     * (`UNKNOWN_ROLE`) from a host whose `/v1/admin/invites` does not exist at all (`HOST_TOO_OLD`).
     * A `400` (an out-of-range `maxUses` or `expiresInMinutes`) is not something this Nod sends, so
     * it stays the host's own refusal.
     */
    async createInvite(input, knownRoles) {
      try {
        return await connection.request<CreateInviteResponse>('POST', HOST_ROUTES.adminInvites, input);
      } catch (error) {
        if (error instanceof HostError && error.status === 404) {
          const known = new Set(knownRoles);
          throw new Error(input.roles.some((role) => !known.has(role)) ? UNKNOWN_ROLE : HOST_TOO_OLD);
        }
        throw error;
      }
    },

    async revokeInvite(id) {
      try {
        await connection.request<void>('DELETE', path(HOST_ROUTES.adminInvite, id));
      } catch (error) {
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
      return true;
    },

    /**
     * O1/SP03 §2: one person's devices, for the People screen. The host answers the live sessions
     * only — a revoked or expired one is not a device to sign out.
     */
    async sessions(personId) {
      return await connection.request<DeviceSession[]>(
        'GET',
        path(HOST_ROUTES.adminPersonSessions, personId),
      );
    },

    /** O1/SP03 §2: ends one session of the guild. The person signs out at their next sync (RF-39). */
    async revokeSession(id) {
      await connection.request<void>('DELETE', path(HOST_ROUTES.adminSession, id));
      return true;
    },

    async listEvents(filter) {
      const events = await connection.request<HostEvent[]>(
        'GET',
        `${HOST_ROUTES.adminEvents}${eventsQuery(filter)}`,
      );
      const mapped = events.map(auditEvent);
      // SP03 §2's admin list filters by person, tool and client-time range — there is no `result`.
      // The page's own filter is applied over the page the host answered, and says nothing less: the
      // rows it hides were read from the host just the same.
      return filter.result === undefined ? mapped : mapped.filter((event) => event.result === filter.result);
    },

    async bootstrap(tools, roles) {
      const body: BootstrapRequest = { tools: tools.map(orgTool), roles: roles.map((role) => ({ ...role })) };
      try {
        const answer = await connection.request<BootstrapResponse>('POST', HOST_ROUTES.adminBootstrap, body);
        return { created: answer.created, refused: false };
      } catch (error) {
        // The closed window is an answer for the screen (the offer is over), not a failed call: the
        // host refused because it already has org tools, and nothing of this Nod's catalog moved.
        if (error instanceof HostError && error.status === 409) return { created: 0, refused: true };
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
    },
  };
}
