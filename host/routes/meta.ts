// O2's route (SP03 §3): `GET /v1/meta/app`, the document a Nod reads to learn which version this host
// serves and where the tinyjs update manifest lives (`update.check`, canonico §19 F5).
//
// It is **public** for two reasons: a Nod too old to sign in still has to learn that it must update,
// and neither value is a guild secret — `minAppVersion` is already in `GET /.well-known/nod`.
//
// The whole answer is the process's configuration and nothing else: no database, no caller, no body.
// `minAppVersion` and the discovery's are the same resolved value (`host/config.ts`), so the two
// documents cannot disagree; `host/app.ts` mounts this plugin with one `.use(...)` line, the way it
// mounts the other groups (`host/context.md`).

import { Elysia } from 'elysia';

import { HOST_ROUTES, type AppMeta } from '../../shared/host-api';
import type { HostContext } from '../auth';
import { appMetaOf } from '../config';

/**
 * What this file reads off the request context: `host/app.ts` decorates the app metadata the boot
 * resolved, and `appMetaOf` reads it — the cast is what names the decoration, exactly as
 * `routes/state.ts`'s `StateContext`/`stateOf` names `config`. The parameter is `unknown` for the
 * reason that file gives: a plugin's own context type carries only the decorations it makes itself
 * (`repo`, `auth` and `config` are `host/app.ts`'s), so the shape is declared here and the cast stays
 * inside `metaOf` — never an `any`.
 */
type MetaContext = HostContext & { appMeta?: AppMeta };

function metaOf(ctx: unknown): MetaContext {
  return ctx as MetaContext;
}

export const metaRoutes = new Elysia({ name: 'host-meta-routes' }).get(
  HOST_ROUTES.appMeta,
  (ctx): AppMeta => appMetaOf(metaOf(ctx)),
);
