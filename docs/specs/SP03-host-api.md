# SP03 — Host API

Elysia 2 (beta, pinned), one process (`host/context.md`). Request and response types live in
`shared/host-api.ts` so the Nod and the host compile against the same shapes. Elysia validates each
body with a `t.*` schema derived from them.

## 1. Conventions

- JSON in and out; `Content-Type: application/json`.
- Errors: `{ "error": "<english message>" }` with the status below. Never a stack trace or a value
  from the request.
- Auth levels:
  - **public**: no token;
  - **person**: valid session, person not disabled;
  - **admin**: person with an admin role.
- Every authenticated response sets no cookies (the app uses bearer tokens; cookies come with E04).
- Body size limit: 256 KB, except icon uploads (an `entry.icon` data URI, or the guild PNG the admin
  sends as base64url — both ≤ 512 KB). The build answers **413 `body too large`** over the limit
  (`host/app.ts`), and the exception is read as "the routes whose body can carry an icon":
  `/v1/admin/tools*`, `/v1/admin/bootstrap`, `/v1/admin/guild/icon` and `/v1/personal/tools*` get
  512 KB, everything else 256 KB (`bodyLimitFor`; the bootstrap body carries the seed's icons, h4,
  and a personal tool body carries the same `Entry.icon`, h7). The guild icon's own
  ceiling applies to the **decoded** bytes; because the body carries them base64url, an icon of that
  size no longer fits the encoded body, so the body limit is the binding one (finding in
  `docs/handovers/i2h-guild-icon-host.md`).
- Guards are Elysia plugins mounted **before** the routes they cover, and a group mounts every level
  it needs: `adminAuth` reaches a route only when `personAuth` ran first, so an admin group mounts
  `new Elysia().use(personAuth).use(adminAuth)` — `adminAuth` alone in a plugin group reads no
  person and answers 500 (h5). Each guard runs once per request (`person` → `admin` → route).

| Status | When |
| --- | --- |
| 400 | body fails its schema; message names the field |
| 401 | missing or invalid token; `invalid credentials`; `invalid code`; `invalid invite` (RF-59: a dead, expired, revoked or used-up invite, or one whose role has since been made admin) |
| 403 | authenticated but not allowed (`admin only`, `owner only`, `not yours`, `the owner keeps an admin role`, `the owner cannot be disabled`, `the credential is blocked`, `tool not visible to sender`) |
| 404 | an id no query ever sees (`unknown person`, `unknown session`, `unknown tool`, `unknown credential`, `unknown invite`, `unknown role`); an id that exists but belongs to someone else answers 403. `POST /v1/auth/invite` answers `404 invalid invite` for a code that names no live invite |
| 409 | conflict: email taken, `this email already has an account in the guild — sign in instead` (the join of RF-59), last admin, `the owner cannot be deleted`, stale `updatedAt`, `recipient has no keys`, `credential belongs to another tool`, `the owner cannot be removed`, `a shared credential keeps the tool` |
| 413 | body over the limit (see above) |
| 429 | rate limit (SP02 §5) |

## 2. Routes — block 1

### Public

| Route | Body | Response |
| --- | --- | --- |
| `GET /health` | — | `200 ok` (text) |
| `GET /.well-known/nod` | — | `Discovery` (SP04 §1) |
| `POST /v1/auth/salt` | `{ email }` | `{ salt, iterations }` (SP02 §4) |
| `POST /v1/auth/activate` | `{ email, code, salt, authKey, device }` | `{ token, personId }` |
| `POST /v1/auth/setup` | `{ email, name, code, salt, authKey, device }` | `{ token, personId }`, first admin |
| `POST /v1/auth/invite` | `{ code }` | `InvitePreview`: `{ guild, roles: [{ id, name }], expiresAt, usesLeft, icon }` (RF-59) |
| `POST /v1/auth/join` | `{ email, name, code, salt, authKey, device }` | `{ token, personId }`; creates the person with the invite's roles (RF-59) |
| `POST /v1/auth/login` | `{ email, authKey, device }` | `{ token, personId }` |

`device = { name, os, appVersion }`.

- `activate` redeems an `activate` code bound to that email.
- `setup` redeems the setup code, creates the person and role `admin` (`admin = 1`), and
  assigns it.
- `invite` is what a `nod://join` link opens: it shows the guild, its icon and the roles the invite
  grants before any account is typed, and reads a **live** invite only — unknown, revoked, expired
  and used-up all answer the same `404 { error: 'invalid invite' }`. `icon` is the stored guild PNG
  as base64url, or `null`. Public: a valid invite is what shows a guild to someone outside it.
- `join` redeems that invite: the caller chooses the account (name, email, password) and the host
  creates it with the invite's roles and spends one use. An email the guild already holds answers
  `409 { error: 'this email already has an account in the guild — sign in instead' }` and spends
  none; every dead invite is `401 { error: 'invalid invite' }`, counted as a failure of SP02 §5's
  email budget, and the argon2id hash is paid before that branch (SP02 §5, F4). An invite never
  makes an admin: a role of it that carries `admin = 1` by the time of the join is that same `401`,
  and spends none.
- `roles` in `InvitePreview` names the roles that still exist, so an invite made before a role was
  removed shows the rest.

### Person

`POST /v1/auth/logout` and `POST /v1/auth/password` landed with block 1 (`host/routes/auth.ts`);
the rest of this table with block 2 (`host/routes/person.ts`) — the session list and revoke are O1,
the personal tool and view writes and the favorites write are B7. The Nod methods
`host.sessions`/`host.revokeSession`, `personal.*`, `favorites.list`/`favorites.set` are SP05 §3.

| Route | Body | Response |
| --- | --- | --- |
| `GET /v1/state` | — | signed `Snapshot` (SP04 §2), `304` on `If-None-Match` hit |
| `POST /v1/auth/logout` | — | `204`, revokes this session |
| `POST /v1/auth/password` | `{ currentAuthKey, newSalt, newAuthKey }` | `204` (SP02 §7) |
| `GET /v1/sessions` | — | `DeviceSession[]` of the caller |
| `DELETE /v1/sessions/:id` | — | `204` (own sessions only) |
| `PUT /v1/personal/tools/:id` | `PersonalTool` with `updatedAt` | `PersonalTool`; `409` if older than stored |
| `DELETE /v1/personal/tools/:id` | `{ updatedAt }` | `204` |
| `PUT /v1/personal/views/:id` | `PersonalView` with `updatedAt` | `PersonalView` |
| `DELETE /v1/personal/views/:id` | `{ updatedAt }` | `204` |
| `PUT /v1/favorites` | `{ entries: Id[], updatedAt }` | `204`, replaces the ordered list |
| `POST /v1/events` | `{ events: ClientEvent[] }` (≤ 500) | `{ acked: Id[] }` (SP04 §5) |
| `GET /v1/guild/icon` | — | `200 image/png`, the stored bytes, `ETag: "<sha256>"`; `404` while the guild has none |
| `GET /v1/presence` | — | `PresenceEntry[]` (RF-58): members with a live session, `{ personId, name, lastSeenAt, online }`, online = seen within `PRESENCE_WINDOW_MS` (6 min); a client gets `403`. Outside the signed snapshot |

- Personal tool ids must match `^p-[a-z0-9]{10}$`. The Nod generates them.
- A `PUT` of an id owned by someone else answers 403.
- `GET /v1/sessions` carries no marker for the calling device, and the Nod does not learn a session
  id (`POST /v1/auth/login` answers `{ token, personId }` only), so the page cannot label one row as
  "this device" (O1's limit; a real marker needs a spec-side field).

### Admin

| Route | Body | Response |
| --- | --- | --- |
| `GET /v1/admin/people` | — | `AdminPerson[]` (no salt or hash), each carrying `owner: boolean` (RF-64) |
| `PATCH /v1/admin/people/:id` | `{ name?, email?, roles?, disabled? }` | `AdminPerson`; `name` and `email` are **owner only** — any other admin answers `403 owner only` — and `email` is lowercased and trimmed, already held → `409 email taken`; `roles` and `disabled` stay admin-level, except that the owner keeps an admin role — `roles` without an admin role is `403 the owner keeps an admin role` and `disabled: true` is `403 the owner cannot be disabled`, whoever asks, the owner included — and disabling revokes their sessions |
| `DELETE /v1/admin/people/:id` | — | `204`; **owner only** (`403 owner only`); a hard delete of the person with everything cascading (below); deleting the owner, themselves included, → `403 the owner cannot be deleted`; an unknown id → `404 unknown person`; a delete that would leave the guild with no admin → the existing `409` |
| `POST /v1/admin/people/:id/code` | — | `{ code, expiresAt }`; revokes the previous code |
| `GET /v1/admin/people/:id/sessions` | — | `DeviceSession[]` |
| `POST /v1/admin/invites` | `{ roles, maxUses, expiresInMinutes }` | `{ invite, code }`, the code shown once; `400` when a role carries `admin = 1` (RF-59) |
| `GET /v1/admin/invites` | — | `GuildInvite[]`, newest first, revoked ones included |
| `DELETE /v1/admin/invites/:id` | — | `204`; sets `revokedAt` (`404` for an unknown id, `204` again for one already revoked) |
| `DELETE /v1/admin/sessions/:id` | — | `204` |
| `PUT /v1/admin/roles/:id` | `{ name, admin }` | `Role`; demoting the owner's only admin role is `403 the owner keeps an admin role`, then `409` if it would leave no admin |
| `DELETE /v1/admin/roles/:id` | — | `204`; deleting the owner's only admin role is `403 the owner keeps an admin role`, then `409` if it would leave no admin |
| `PUT /v1/admin/grants` | `{ roleId, entryId, granted }` | `204` |
| `PUT /v1/admin/tools/:id` | `OrgTool` (Entry + views) | `OrgTool`; RF-62's `category` (a name of ≤ 40 characters, or `null`) travels in and out, and a body's name is trimmed |
| `DELETE /v1/admin/tools/:id` | — | `204`; `409` while a share still names the tool (`a shared credential keeps the tool`) |
| `POST /v1/admin/tools/:id/promote` | `{ personalId }` | `OrgTool`; copies a personal tool to org, owner keeps theirs |
| `POST /v1/admin/bootstrap` | `{ tools: OrgTool[], roles: Role[] }` | `{ created }`; only while the host has no org tools (B8a) |
| `PUT /v1/admin/guild/icon` | `{ png }` — base64url of the PNG bytes, ≤ 512 KB decoded | `{ sha256 }`, lowercase hex of those bytes; `400` when they are not a PNG |
| `DELETE /v1/admin/guild/icon` | — | `204`, and the next snapshot carries `guildIcon: null` |
| `GET /v1/admin/events` | `?person&tool&from&to&limit` | `HostEvent[]` |

`POST /v1/admin/people` — the email-bound "create person + one access code" — is gone in 0.5.0: a
guild invite creates a person (RF-59). `POST /v1/admin/people/:id/code` stays: it is the reissue for
a person the guild already has, and it is what a reset uses.

The guild owner (RF-64) is the person the setup code created, stored as the `meta` key `owner_id`
(SP01 §4). It is the only person allowed to rename somebody or edit their email, and the
only one who may delete somebody: the same routes an admin already reaches answer `403 owner only`
for every other admin, while `roles` and `disabled` stay at the admin level — except that the owner
never loses their own admin role and is never disabled: `roles` without an admin role aimed at the
owner is `403 the owner keeps an admin role` and `disabled: true` aimed at the owner is
`403 the owner cannot be disabled`, whoever the caller is, the owner included. The same rule guards
the roles surface, because a role edit is another way to strip the owner: demoting the owner's only
admin role (`PUT /v1/admin/roles/:id`) or deleting it (`DELETE /v1/admin/roles/:id`) is that same
`403`, not the last-admin `409` the owner is also the subject of. `DELETE
/v1/admin/people/:id` is a **hard delete in one transaction** — the person row and everything
cascading, plus the rows whose foreign keys do not cascade: the person's events (`events.person_id`,
`events.session_id`) and their shares (`shares.from_id`/`to_id`) are deleted, holder rows'
`via_share_id` pointing at a deleted share is set NULL, and `credential_assignments.assigned_by` is
reassigned to the deleting owner. The host records a `person_deleted` event written by the owner,
whose `detail` names the deleted person's name and email and never a code or a secret. The owner
themselves cannot be deleted by anyone, the owner included (`403 the owner cannot be deleted`), and
no delete may leave the guild with no admin (the existing `409`).

The guild invites of RF-59: the admin hands out a link — `nod://join?host=<address>&fp=<fingerprint>&code=<code>`,
built by the Nod's `shared/join-link.ts` — and whoever opens it sees the guild and creates the
account they choose. The code is the longest of SP02 §3 and only its SHA-256 is stored. Creating one
records an `invite_issued` event for the creating admin, whose `detail` names the roles, the
max-use count and the expiry and never the code. `roles` is a list of role ids that must all exist
(`404` otherwise); **an invite never grants an admin role** — a role with `admin = 1` is
`400 { error: 'an invite cannot grant an admin role' }` and stores nothing, because an invite is a
bearer code pasted into chats, and the join re-checks the roles it would grant (a role promoted to
admin after the invite was made answers the same `401 invalid invite` and spends no use, and the
invite works again if that role is demoted or removed). Making somebody an admin is
`PATCH /v1/admin/people/:id`. `maxUses` is 1..1000 or `null` (no limit); `expiresInMinutes` is
1..43200 (30 days) or `null` (never). `GET /v1/admin/invites` never carries a code or a hash
(`GuildInvite` has no such field), and a revoked invite stays in the list so the admin can see what
was spent.

The guild icon is the image the Nod shows as the app icon on a guild build. The host stores the bytes
and their SHA-256 in two `meta` rows (`host/repo.ts`: `GUILD_ICON_HASH_KEY`, `GUILD_ICON_BYTES_KEY`);
the digest travels inside the signed snapshot (`Snapshot.guildIcon`, SP04 §2) and the bytes come back
from `GET /v1/guild/icon`, so a Nod refuses an icon whose bytes do not hash to the signed value. The
bytes must start with the PNG signature (`shared/host-api.ts`'s `PNG_SIGNATURE`/`isPng`) — the host
decodes no image — and the admin's upload is the only writer.

## 3. Routes — block 2

| Route | Auth | Body | Response |
| --- | --- | --- | --- |
| `PUT /v1/keys` | person | `{ x25519Public, ed25519Public, privateSealed? }` | `204`; new public keys replace the row (reset), the same ones move `privateSealed` alone (canonico §22) |
| `GET /v1/keys/private` | person | — | `{ x25519Public, ed25519Public, privateSealed }` of the caller's own row; `404` without one; never another person's (canonico §22) |
| `POST /v1/shares` | person | `{ credentialId, toolId, scope, kind, items: [{ to, sealed }] }`, `items` 1–500, `sealed` ≤ 64 KB | `{ ids }`; checks scope and visibility (SP06 §5). Once the credential has holder rows the sender must be a live holder and `toolId` must match the credential's (409 otherwise); a body scope may narrow the owner row's scope, never widen it |
| `POST /v1/shares/:id/accept` | recipient | — | `204`; purges `sealed`, adds holder |
| `POST /v1/shares/:id/decline` | recipient | — | `204`; purges `sealed` |
| `GET /v1/credentials/:id/holders` | holder or admin | — | `Holder[]` |
| `PUT /v1/credentials/:id/scope` | owner or admin | `{ scope }` | `204`; sets the scope of every holder row. Every later share derives its allowed scope from the owner row — narrower only, wider is `403`, `blocked` refuses every share (SP06 §5) |
| `DELETE /v1/credentials/:id/holders/:personId` | owner or admin | — | `204`; marks removed; owner gets "rotation pending" |
| `POST /v1/credentials/:id/rotated` | owner or admin | — | `204`; records that a new secret was saved, clearing `rotationPending` (RF-48) |
| `PUT /v1/admin/assignments` | admin | `{ credentialId, roleId, toolId, assigned }` | `204` |
| `GET /v1/admin/assignments/missing` | admin | — | `[{ credentialId, toolId, roleId, personId }]`: members of an assigned role the tool is granted to, without a copy; a `client` is never listed |
| `GET /v1/meta/app` | public | — | `{ minAppVersion, update: { url } \| null }` (O2); the one route a too-old Nod still reads, once per sync run (SP04 §3) |

Incoming shares and the caller's holders data travel inside `GET /v1/state` (SP04 §2). Every
`Holder` row carries `toolId` — the credential's `credential_holders.tool_id` — in both the signed
snapshot and `GET /v1/credentials/:id/holders`, so the admin's holders card names the tool without a
separate lookup (`docs/handovers/block2-review.md` M7).

`minAppVersion` is the oldest Nod the deployment takes. A Nod below it reaches no other route: the
discovery (public) and this one are all it calls, it refuses the joins, the sign-in and every RPC
that would reach the host, and it runs on its local catalog until it is updated (SP04 §3, owner
decision of 2026-10-17).

`update.url` is served for whoever runs the deployment: the tinyjs runtime takes no URL —
`app.update.check()`/`install()` read the address fixed when the app was created — so the running
Nod keeps its built-in update channel and does not fetch the host's manifest. The host serves it and
the Nod reads and drops it (O2's limit, `docs/handovers/o1-o2-nod.md` finding 1).

## 4. Acceptance

- An integration test file per route group runs the real Elysia app on a temp `/data` dir
  (`bun test`). It covers each status in the table of §1 at least once.
- `host/invites.test.ts` (RF-59) covers the invite group end to end: create/list/revoke, the public
  preview (with and without a guild icon), the join with the invite's roles, an exhausted max-use
  count, an expired invite, a revoked invite, the email-taken `409` that spends no use, and the
  email budget that answers `429` — see §2's public and admin tables.
- `POST /v1/auth/login` with a wrong key and with an unknown email return byte-identical bodies.
- No route logs a request body. A test captures the logger and asserts no `authKey`, code or token
  appears.
