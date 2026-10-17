// The guild icon a person downloads of SP03 §2: `GET /v1/guild/icon`, the raw PNG bytes with
// `ETag: "<sha256>"`. `host/app.ts` mounts this plugin with one `.use(...)`, the way it mounts the
// auth, admin, state and event groups.
//
// The icon is guild content and not a secret, but it is only useful to someone inside the guild, so
// the one route here sits behind `personAuth` (SP03 §1's person level). The admin's write side —
// `PUT`/`DELETE /v1/admin/guild/icon` — is `host/routes/admin.ts`'s, where `adminAuth` already covers
// a group; the guard rule of `host/context.md` (`personAuth` mounted before the routes it covers, one
// group per file) is what keeps this file to a single route.
//
// The bytes are the repo's (`SP01 §1`'s single file, SP03 §2's storage decision): this file decides
// the status, the media type and the `ETag`, and signs nothing — the digest the snapshot carries is
// the same value, read from the same row (SP04 §2).

import { Elysia } from 'elysia';

import { HOST_ROUTES, SNAPSHOT_ETAG_HEADER } from '../../shared/host-api';
import { hostOf, personAuth } from '../auth';
import { NotFoundError } from '../repo';
import { etagOf } from '../snapshot';

export const guildRoutes = new Elysia({ name: 'host-guild-routes' })
  // SP03 §1: below this line the caller must be a live, non-disabled person — a missing or dead token
  // is the guard's 401 `invalid credentials`.
  .use(personAuth)

  /**
   * SP03 §2: the stored icon, byte for byte, with the digest of those bytes as the `ETag` — the same
   * value `Snapshot.guildIcon` carries, which is what lets the Nod refuse a tampered download
   * (SP04 §2). `404` while the guild has none, and the answer is a raw `Response` so nothing between
   * the row and the socket touches the bytes.
   */
  .get(HOST_ROUTES.guildIcon, (ctx) => {
    const icon = hostOf(ctx).repo.guildIcon();
    if (icon === null) throw new NotFoundError('unknown guild icon');
    return new Response(icon.bytes, {
      status: 200,
      headers: { 'content-type': 'image/png', [SNAPSHOT_ETAG_HEADER]: etagOf(icon.sha256) },
    });
  });
