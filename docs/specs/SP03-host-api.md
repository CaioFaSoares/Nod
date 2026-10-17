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
| 401 | missing or invalid token; `invalid credentials`; `invalid code` |
| 403 | authenticated but not allowed (`admin only`, `not yours`, `the credential is blocked`, `tool not visible to sender`) |
| 404 | an id no query ever sees (`unknown person`, `unknown session`, `unknown tool`, `unknown credential`); an id that exists but belongs to someone else answers 403 |
| 409 | conflict: email taken, last admin, stale `updatedAt`, `recipient has no keys`, `credential belongs to another tool`, `the owner cannot be removed`, `a shared credential keeps the tool` |
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
| `POST /v1/auth/login` | `{ email, authKey, device }` | `{ token, personId }` |

`device = { name, os, appVersion }`.

- `activate` redeems an `activate` code bound to that email.
- `setup` redeems the setup code, creates the person and role `admin` (`admin = 1`), and
  assigns it.

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
| `GET /v1/admin/people` | — | `AdminPerson[]` (no salt or hash) |
| `POST /v1/admin/people` | `{ email, name, roles }` | `{ person, code, expiresAt }`, the code shown once |
| `PATCH /v1/admin/people/:id` | `{ name?, roles?, disabled? }` | `AdminPerson`; disabling revokes their sessions |
| `POST /v1/admin/people/:id/code` | — | `{ code, expiresAt }`; revokes the previous code |
| `GET /v1/admin/people/:id/sessions` | — | `DeviceSession[]` |
| `DELETE /v1/admin/sessions/:id` | — | `204` |
| `PUT /v1/admin/roles/:id` | `{ name, admin }` | `Role` |
| `DELETE /v1/admin/roles/:id` | — | `204`; `409` if it would leave no admin |
| `PUT /v1/admin/grants` | `{ roleId, entryId, granted }` | `204` |
| `PUT /v1/admin/tools/:id` | `OrgTool` (Entry + views) | `OrgTool` |
| `DELETE /v1/admin/tools/:id` | — | `204`; `409` while a share still names the tool (`a shared credential keeps the tool`) |
| `POST /v1/admin/tools/:id/promote` | `{ personalId }` | `OrgTool`; copies a personal tool to org, owner keeps theirs |
| `POST /v1/admin/bootstrap` | `{ tools: OrgTool[], roles: Role[] }` | `{ created }`; only while the host has no org tools (B8a) |
| `PUT /v1/admin/guild/icon` | `{ png }` — base64url of the PNG bytes, ≤ 512 KB decoded | `{ sha256 }`, lowercase hex of those bytes; `400` when they are not a PNG |
| `DELETE /v1/admin/guild/icon` | — | `204`, and the next snapshot carries `guildIcon: null` |
| `GET /v1/admin/events` | `?person&tool&from&to&limit` | `HostEvent[]` |

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
| `GET /v1/meta/app` | public | — | `{ minAppVersion, update: { url } \| null }` (O2) |

Incoming shares and the caller's holders data travel inside `GET /v1/state` (SP04 §2). Every
`Holder` row carries `toolId` — the credential's `credential_holders.tool_id` — in both the signed
snapshot and `GET /v1/credentials/:id/holders`, so the admin's holders card names the tool without a
separate lookup (`docs/handovers/block2-review.md` M7).

`update.url` is served for whoever runs the deployment: the tinyjs runtime takes no URL —
`app.update.check()`/`install()` read the address fixed when the app was created — so the running
Nod keeps its built-in update channel and does not fetch the host's manifest. The host serves it and
the Nod reads and drops it (O2's limit, `docs/handovers/o1-o2-nod.md` finding 1).

## 4. Acceptance

- An integration test file per route group runs the real Elysia app on a temp `/data` dir
  (`bun test`). It covers each status in the table of §1 at least once.
- `POST /v1/auth/login` with a wrong key and with an unknown email return byte-identical bodies.
- No route logs a request body. A test captures the logger and asserts no `authKey`, code or token
  appears.
