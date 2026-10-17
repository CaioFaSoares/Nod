// H6's route group (SP03 §2): the public `GET /.well-known/nod` of SP04 §1 and the signed
// `GET /v1/state` of SP04 §2. `host/app.ts` mounts this plugin with one `.use(...)`, the way it mounts
// `routes/auth.ts`.
//
// The public route comes first, because a guard covers only the routes written after it
// (`host/context.md`). Everything the bytes depend on — the key, the fingerprint, the document, its
// version and the signature — is `host/snapshot.ts`'s; this file owns the HTTP surface: which
// document, which headers, which status, and the `If-None-Match` negotiation.
//
// No secret is read, written or logged here: the state route answers a document the repo already
// filtered by owner, and the signature is public by definition (SP04 §2).

import { Elysia } from 'elysia';

import {
  HOST_ROUTES,
  SNAPSHOT_ETAG_HEADER,
  SNAPSHOT_SIGNATURE_HEADER,
  type AppMeta,
} from '../../shared/host-api';
import { callerOf, personAuth, type HostContext } from '../auth';
import { appMetaOf, type HostConfig } from '../config';
import { loadOrCreateSigningKey, type SigningKey } from '../keys';
import {
  discoveryDocument,
  etagMatches,
  etagOf,
  issueSnapshot,
  serializeSnapshot,
  signSnapshot,
  signatureHeader,
  snapshotDocument,
  snapshotSource,
} from '../snapshot';

/** SP04 §2 names the request header only in prose; the answer side is the shared constant. */
const IF_NONE_MATCH_HEADER = 'If-None-Match';

/** SP07 §2's deployment value of the discovery: `host/compose.yaml` sets it. */
export const GUILD_NAME_ENV = 'NOD_GUILD_NAME';
// The other deployment value of the discovery — the minimum app version and the update manifest URL
// — is `host/config.ts`'s since O2: one resolved value (`loadAppMeta`) feeds both this route and
// `GET /v1/meta/app`. Re-exported here because `host/state.test.ts` and `test/host-admin.test.ts`
// read these two names from this module.
export { DEFAULT_MIN_APP_VERSION, MIN_APP_VERSION_ENV } from '../config';

/**
 * What this file reads off the request context. `host/app.ts` decorates `config`, `db`, `repo` and
 * `auth`; `host/auth.ts`'s `HostContext` names three of them, so the cast stays here — confined to
 * `stateOf`, exactly as `hostOf` confines its own.
 */
type StateContext = HostContext & { config: HostConfig; appMeta?: AppMeta };

function stateOf(ctx: unknown): StateContext {
  return ctx as StateContext;
}

/**
 * The process's signing pair (SP01 §1), loaded once per data dir: `bootHost` loads the same file
 * before the app exists, and `host/app.ts` already reads `host-secret` from the data dir the same way
 * (`loadOrCreateHostSecret`). One read per process, never one per request, and the pair lives only in
 * the `WeakMap` `host/snapshot.ts` imports the signing key through.
 */
const signingKeys = new Map<string, Promise<SigningKey>>();

function signingKeyOf(dataDir: string): Promise<SigningKey> {
  let loaded = signingKeys.get(dataDir);
  if (loaded === undefined) {
    loaded = loadOrCreateSigningKey(dataDir);
    signingKeys.set(dataDir, loaded);
  }
  return loaded;
}

export const stateRoutes = new Elysia({ name: 'host-state-routes' })
  // SP04 §1: public. The Nod shows the guild and the fingerprint, and pins the key, before anyone
  // signs in; this route reads no caller and no table.
  .get(HOST_ROUTES.discovery, async (ctx) => {
    const { config } = stateOf(ctx);
    // O2: the minimum app version is the one `GET /v1/meta/app` answers, resolved once for the
    // process (`appMetaOf`) — never a second read of the environment with a second default.
    const { minAppVersion } = appMetaOf(stateOf(ctx));
    return await discoveryDocument({
      // SP04 §1 annotates `guild` as `meta.guild_name` (SP01 §2), a row nothing writes yet: its
      // origin is the deployment environment of SP07 §2 either way. The exact `host/config.ts` and
      // `host/main.ts` change is in `docs/handovers/h6.md`, "Other owners".
      guild: process.env[GUILD_NAME_ENV]?.trim() ?? '',
      key: await signingKeyOf(config.dataDir),
      minAppVersion,
    });
  })

  // SP03 §1: below this line the caller must be a live, non-disabled person. Disabling revokes the
  // sessions (SP01 §2), so a disabled person answers the guard's 401 like any dead token.
  .use(personAuth)

  .get(HOST_ROUTES.state, async (ctx) => {
    const { repo, auth, config } = stateOf(ctx);
    const { person } = callerOf(ctx);
    // SP04 §2: the rows the repo filters by owner, and the version the answered body will carry.
    const source = snapshotSource(repo, person);
    const { issuedAt, version } = await issueSnapshot(source, () => auth.now());

    // The version is what `If-None-Match` is compared against, so it is computed before the
    // signature: a hit costs two digests and no Ed25519 operation, and answers no body at all.
    if (etagMatches(ctx.request.headers.get(IF_NONE_MATCH_HEADER), version)) {
      return new Response(null, {
        status: 304,
        headers: { [SNAPSHOT_ETAG_HEADER]: etagOf(version) },
      });
    }

    // SP04 §2: the bytes signed are the bytes returned. The body is serialized once, here, and the
    // signature header covers exactly that string — the response is handed over raw so no layer
    // re-serializes it.
    const body = serializeSnapshot(snapshotDocument(source, issuedAt, version));
    const signature = await signSnapshot(body, await signingKeyOf(config.dataDir));
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [SNAPSHOT_ETAG_HEADER]: etagOf(version),
        [SNAPSHOT_SIGNATURE_HEADER]: signatureHeader(signature),
      },
    });
  });
