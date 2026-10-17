// The Elysia app: routes, auth levels, error mapping, rate limits (SP03). H1 served only the health
// probe; H4 adds the repo, the auth service and the auth routes every other group hangs beside.
//
// One `createRepo` and one auth service per app, both on the request context, so a route of H5, H6 or
// H8 reads them instead of building them again. A new group is one file under `host/routes/` and one
// `.use(...)` line below (SP03 §2).
//
// The app takes its dependencies instead of reading the environment or opening its own connection, so
// a test runs the real app on a temp data dir (`app.handle(new Request(...))`).

import { Elysia, NotFound, ParseError, ValidationError, status } from 'elysia';
import type { Database } from 'bun:sqlite';

import { HOST_ROUTES } from '../shared/host-api';
import { createAuthService, type AuthService } from './auth';
import type { HostConfig } from './config';
import { loadOrCreateHostSecret } from './keys';
import { RepoError, createRepo, type Repo } from './repo';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { eventRoutes } from './routes/events';
import { guildRoutes } from './routes/guild';
import { stateRoutes } from './routes/state';

export type AppDeps = {
  /** Host configuration resolved at boot (SP07 §1–§2). */
  config: HostConfig;
  /** The migrated connection of the process (SP01 §1). */
  db: Database;
};

/** SP03 §1: 256 KB for every body; a body that carries a tool icon may reach 512 KB. */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_ICON_BODY_BYTES = 512 * 1024;

/** The routes whose body carries an icon: an `entry.icon` data URI or the guild PNG (SP03 §1, §2). */
export function bodyLimitFor(path: string): number {
  return path.startsWith('/v1/admin/tools') ||
    path.startsWith('/v1/admin/bootstrap') ||
    path === HOST_ROUTES.adminGuildIcon
    ? MAX_ICON_BODY_BYTES
    : MAX_BODY_BYTES;
}

/**
 * SP03 §1's limit. A declared `Content-Length` decides without reading the body; `app.handle` and a
 * chunked body carry none, and there the body is measured once through a clone.
 */
async function overBodyLimit(request: Request, limit: number): Promise<boolean> {
  const declared = request.headers.get('content-length');
  if (declared !== null) return Number(declared) > limit;
  if (request.body === null) return false;
  return (await request.clone().arrayBuffer()).byteLength > limit;
}

/**
 * SP03 §1: the message names the field. Only the path and the reason of the first failure travel —
 * `error.value` and `payload.found` are the request, and a response never repeats a request value.
 */
function invalidBody(error: ValidationError): string {
  const first = error.all[0] as { path?: string; message?: string } | undefined;
  const field = first?.path !== undefined && first.path !== 'root' ? `${first.path} ` : '';
  return `invalid ${error.type ?? 'body'}: ${field}${first?.message ?? 'invalid'}`;
}

export function createApp(deps: AppDeps) {
  const repo: Repo = createRepo(deps.db);
  // The host secret file is `bootHost`'s to create (H1); reading it here keeps `AppDeps` untouched.
  const auth: AuthService = createAuthService({
    repo,
    hostSecret: loadOrCreateHostSecret(deps.config.dataDir),
  });

  return new Elysia()
    // All four land on the request context, so the routes of H4 onward read the resolved
    // configuration, the open connection, the repo and the auth service instead of deriving them
    // again.
    .decorate({ config: deps.config, db: deps.db, repo, auth })

    // SP03 §1: the size limit, decided before the body is parsed.
    .onRequest(async ({ request }) => {
      const limit = bodyLimitFor(new URL(request.url).pathname);
      if (await overBodyLimit(request, limit)) {
        return status(413, { error: 'body too large' });
      }
    })

    // SP03 §1: one shape for every failure, with the status the error itself carries.
    .onError(({ error, request }) => {
      if (error instanceof RepoError) return status(error.status, { error: error.message });
      if (error instanceof ValidationError) return status(400, { error: invalidBody(error) });
      if (error instanceof ParseError) return status(400, { error: 'invalid body' });
      if (error instanceof NotFound) return status(404, { error: 'not found' });
      // Never the message: an unexpected error may carry a value from the request (SP03 §1), and no
      // request body is ever logged (host/context.md). The path alone is enough to find it.
      console.error(`nod host: unexpected error on ${request.method} ${new URL(request.url).pathname}`);
      return status(500, { error: 'internal error' });
    })

    .get(HOST_ROUTES.health, () => 'ok')

    // SP03 §2: the route groups in one line each, in this order — auth (H4), admin (H5), state
    // (H6), events (H8), guild (I2h). Each carries its own guards, so a group mounted later keeps its
    // own access rules and the levels of the groups above stay inside them (H4's regression test).
    .use(authRoutes)
    .use(adminRoutes)
    .use(stateRoutes)
    .use(eventRoutes)
    .use(guildRoutes);
}
