// The admin side of connected mode (SP05 §3–§4): every write the Tools, Roles and People tabs make,
// the Activity read, and B8a's one-time publish — each one mapped to the route of SP03 §2 that owns
// it, over the `HostConnection` the caller already holds (RF-30: no host row, no connection).
//
// The shapes in and out are `shared/host-api.ts`'s, so the Bond and the host validate the same fields;
// the conversion the other way — this Bond's `EventFilter` into SP03 §2's query, a `HostEvent` into the
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
  type HostEvent,
  type OrgTool,
  type PersonCreateRequest,
  type PersonCreateResponse,
  type PersonUpdateRequest,
  type RoleRequest,
} from '../shared/host-api';
import type { AuditEvent, Entry, EventFilter, EventType, Id, Person, Role, View } from '../shared/types';
import { HostError, type HostConnection } from './host-client';

/**
 * SP03 §2's `409` on `POST /v1/admin/bootstrap` — the window closes with the first org tool
 * (H5 decision 12). The host's own body never reaches the Bond, so this is the Bond's sentence.
 */
export const BOOTSTRAP_CLOSED = 'the guild already has org tools';

/** SP03 §2's `409` on `POST /v1/admin/people`: one person per email in the guild. */
const EMAIL_TAKEN = 'email taken';

/** SP03 §2's `404` on `POST /v1/admin/people`: a role the guild does not have. */
const UNKNOWN_ROLE = 'the guild has no such role';

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
  /** `PATCH /v1/admin/people/:id { disabled: true }` → the person, `disabledAt` filled. */
  disable(personId: Id): Promise<Person>;
  /** `POST /v1/admin/people` → the person and the one access code that creates their account. */
  createPerson(input: PersonCreateRequest): Promise<PersonCreateResponse>;
  /** `POST /v1/admin/people/:id/code` → a fresh code, the previous one revoked (SP02 §3). */
  issueCode(personId: Id): Promise<CodeResponse>;
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
   * have kinds this Bond does not know (SP03 §2) — and lands in `type`, which the table prints.
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

    async createPerson(input) {
      try {
        return await connection.request<PersonCreateResponse>('POST', HOST_ROUTES.adminPeople, input);
      } catch (error) {
        if (error instanceof HostError && error.status === 409) throw new Error(EMAIL_TAKEN);
        if (error instanceof HostError && error.status === 404) throw new Error(UNKNOWN_ROLE);
        throw error;
      }
    },

    async issueCode(personId) {
      try {
        return await connection.request<CodeResponse>('POST', path(HOST_ROUTES.adminPersonCode, personId));
      } catch (error) {
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
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
        // host refused because it already has org tools, and nothing of this Bond's catalog moved.
        if (error instanceof HostError && error.status === 409) return { created: 0, refused: true };
        if (error instanceof HostError && error.status === 404) throw new Error(NOT_ON_HOST);
        throw error;
      }
    },
  };
}
