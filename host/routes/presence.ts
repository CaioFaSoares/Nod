// RF-58's person route: who in the guild is online now. `host/app.ts` mounts it with one `.use(...)`
// line beside the other groups (`host/context.md`).
//
// Presence is derived, never written: `personAuth` touches `sessions.last_seen_at` on every
// authenticated request (SP02 §5) and the Nod syncs every 5 minutes (SP04 §3), so a person whose live
// session was seen inside `PRESENCE_WINDOW_MS` is online — no heartbeat, no new table. It stays out of
// the signed snapshot on purpose: a value that changes on every poll would move the snapshot's
// `version` and the `304` would never happen (SP04 §2).
//
// Members only, both ways: a client (`kind = client`, E04) gets 403 and is never listed. The answer
// carries a name and an instant — never a device, an OS, a session id or an address.

import { Elysia } from 'elysia';

import { HOST_ROUTES, PRESENCE_WINDOW_MS, type PresenceEntry } from '../../shared/host-api';
import { callerOf, hostOf, personAuth } from '../auth';
import { ForbiddenError } from '../repo';

export const presenceRoutes = new Elysia({ name: 'host-presence-routes' })
  .use(personAuth)

  /** RF-58: online first, then most recently seen; the caller is listed like anyone else. */
  .get(HOST_ROUTES.presence, (ctx): PresenceEntry[] => {
    const { repo, auth } = hostOf(ctx);
    const { person } = callerOf(ctx);
    if (person.kind !== 'member') throw new ForbiddenError('members only');
    const now = auth.now();
    const cutoff = Date.parse(now) - PRESENCE_WINDOW_MS;
    const rows = repo.presence(now).map(
      (row): PresenceEntry => ({
        personId: row.personId,
        name: row.name,
        lastSeenAt: row.lastSeenAt,
        online: Date.parse(row.lastSeenAt) >= cutoff,
      }),
    );
    // The repo already sorts by `lastSeenAt` desc, so the online ones are the head of the list.
    return rows;
  });
