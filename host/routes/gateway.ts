// The gateway group of SP03 §2 (RF-80): the admin's table of the names the Caddy sidecar serves.
// `host/app.ts` mounts this plugin with one `.use(...)` line, like `routes/admin.ts`, and the group
// mounts `personAuth` then `adminAuth` for the reason `host/context.md` records.
//
// The host keeps the route table and drives Caddy (`host/gateway.ts`); Caddy does the proxy and the
// TLS. A deployment without `GATEWAY=true` has no gateway service: the read answers
// `{ enabled: false }` and every write is the 404 of SP03 §1, so the surface does not exist there.
//
// Every write applies the new Caddyfile at once and records `gateway_applied` or
// `gateway_apply_failed` in the guild's log — the route id, the upstream or the clipped error, never
// the file the host sent. The minute-by-minute reconciliation of `host/gateway.ts` writes no event:
// an event names a person and a session, and the timer has neither.

import { Elysia, status, t } from 'elysia';

import { HOST_ROUTES, type GatewayRoute, type GatewayStatus } from '../../shared/host-api';
import { adminAuth, callerOf, hostOf, personAuth, type HostContext } from '../auth';
import { GatewayInputError, gatewayUrl, validateUpstream } from '../gateway';
import { RepoError, type GatewayRouteRecord, type ToolInput } from '../repo';

// ---------------------------------------------------------------- schemas (SP03 §1)

/** The id is the subdomain label and the guild tool's id at once: the entry-id slug of SP01 §2. */
const routeParams = t.Object({ id: t.String({ pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }) });

const routeBody = t.Object({
  upstream: t.String({ minLength: 1, maxLength: 300 }),
  tool: t.Optional(
    t.Object({
      title: t.String({ minLength: 1, maxLength: 200 }),
      roles: t.Array(t.String({ minLength: 1, maxLength: 64 })),
    }),
  ),
});

// ---------------------------------------------------------------- helpers

/** SP03 §1's 404 for a deployment without the gateway: the routes behave as if they did not exist. */
class GatewayOffError extends RepoError {
  constructor() {
    super('not found', 404);
  }
}

function enabledGateway(host: HostContext) {
  const settings = host.config.gateway;
  if (host.gateway === null || settings === null || settings === undefined) throw new GatewayOffError();
  return { gateway: host.gateway, settings };
}

function routeOf(row: GatewayRouteRecord, domain: string, port: number): GatewayRoute {
  return { ...row, url: gatewayUrl(row.id, domain, port) };
}

function statusOf(host: HostContext): GatewayStatus {
  const { gateway, settings } = enabledGateway(host);
  return {
    enabled: true,
    domain: settings.domain,
    port: settings.port,
    ...gateway.state(),
    routes: host.repo.listGatewayRoutes().map((row) => routeOf(row, settings.domain, settings.port)),
  };
}

/** The applied-or-failed event of one admin write (the clipped error is Caddy's, never the file). */
function recordApply(ctx: unknown, applied: boolean, detail: string): void {
  const { repo, auth, gateway } = hostOf(ctx);
  const { person, session } = callerOf(ctx);
  const now = auth.now();
  repo.addEvents(
    person.id,
    session.id,
    [
      {
        id: crypto.randomUUID(),
        at: now,
        kind: applied ? 'gateway_applied' : 'gateway_apply_failed',
        detail: applied ? detail : `${detail} — ${gateway?.state().lastError ?? 'unknown error'}`,
      },
    ],
    now,
  );
}

// ---------------------------------------------------------------- routes

export const gatewayRoutes = new Elysia({ name: 'host-gateway-routes' })
  .use(personAuth)
  .use(adminAuth)

  /**
   * `GatewayStatus`. With the gateway on, the read reconciles first, so `caddyReachable` is what the
   * admin socket answered now and a Caddy that restarted with only its base gets the routes back.
   */
  .get(HOST_ROUTES.adminGateway, async (ctx): Promise<GatewayStatus> => {
    const host = hostOf(ctx);
    if (host.gateway === null || !host.config.gateway) return { enabled: false };
    await host.gateway.reconcile();
    return statusOf(host);
  })

  /**
   * Saves one route. The upstream is validated (`validateUpstream`: a container name,
   * `host.docker.internal` or a private IP, with a port — never a public host, so the gateway is not
   * an open proxy). With `tool`, the guild tool of the same id is created or updated with the route's
   * URL, that title and those roles, and linked to the route; its other fields stay the admin's.
   */
  .put(HOST_ROUTES.adminGatewayRoute, { params: routeParams, body: routeBody }, async (ctx) => {
    const host = hostOf(ctx);
    const { gateway, settings } = enabledGateway(host);
    const { repo, auth } = host;
    const id = ctx.params.id;
    let upstream: string;
    try {
      upstream = validateUpstream(ctx.body.upstream);
    } catch (error) {
      if (!(error instanceof GatewayInputError)) throw error;
      return status(400, {
        error: 'invalid body: upstream must be scheme://host:port on a container, host.docker.internal or a private IP',
      });
    }
    const now = auth.now();
    repo.transaction(() => {
      const previous = repo.gatewayRoute(id);
      let entryId = previous?.entryId ?? null;
      const tool = ctx.body.tool;
      if (tool !== undefined) {
        const existing = repo.listOrgTools().find((row) => row.id === id) ?? null;
        const input: ToolInput = {
          id,
          title: tool.title,
          category: existing?.category ?? null,
          tags: existing?.tags ?? [],
          orgAccount: existing?.orgAccount ?? null,
          url: gatewayUrl(id, settings.domain, settings.port),
          allowHttp: false,
          icon: existing?.icon ?? null,
          order: existing?.order ?? 0,
          roles: tool.roles,
          auth: existing?.auth ?? null,
          active: existing?.active ?? true,
          views: (existing?.views ?? []).map((view) => ({
            id: view.id,
            label: view.label,
            url: view.url,
            mode: view.mode,
          })),
        };
        repo.saveOrgTool(input, now);
        entryId = id;
      }
      repo.saveGatewayRoute({ id, upstream, entryId }, now);
    });
    const applied = await gateway.apply();
    recordApply(ctx, applied, `route ${id} → ${upstream}`);
    return statusOf(host);
  })

  /** Removes one route, `204`. The linked guild tool stays: the admin deletes it in Tools if wanted. */
  .delete(HOST_ROUTES.adminGatewayRoute, { params: routeParams }, async (ctx) => {
    const host = hostOf(ctx);
    const { gateway } = enabledGateway(host);
    host.repo.removeGatewayRoute(ctx.params.id);
    const applied = await gateway.apply();
    recordApply(ctx, applied, `route ${ctx.params.id} removed`);
    return status(204);
  });
