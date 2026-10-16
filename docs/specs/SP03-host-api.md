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
- Body size limit: 256 KB, except icon uploads (`entry.icon` data URI ≤ 512 KB). The build answers
  **413 `body too large`** over the limit (`host/app.ts`), and the exception is read as "the routes
  whose body can carry an `entry.icon`": `/v1/admin/tools*` and `/v1/admin/bootstrap` get 512 KB,
  everything else 256 KB (`bodyLimitFor`; the bootstrap body carries the seed's icons, h4).
- Guards are Elysia plugins mounted **before** the routes they cover, and a group mounts every level
  it needs: `adminAuth` reaches a route only when `personAuth` ran first, so an admin group mounts
  `new Elysia().use(personAuth).use(adminAuth)` — `adminAuth` alone in a plugin group reads no
  person and answers 500 (h5). Each guard runs once per request (`person` → `admin` → route).

| Status | When |
| --- | --- |
| 400 | body fails its schema; message names the field |
| 401 | missing or invalid token; `invalid credentials`; `invalid code` |
| 403 | authenticated but not allowed (`admin only`, `not yours`) |
| 404 | id not found **and** visible to the caller; otherwise 403 |
| 409 | conflict: email taken, last admin, stale `updatedAt` |
| 413 | body over the limit (see above) |
| 429 | rate limit (SP02 §5) |

## 2. Routes — block 1

### Public

| Route | Body | Response |
| --- | --- | --- |
| `GET /health` | — | `200 ok` (text) |
| `GET /.well-known/bond` | — | `Discovery` (SP04 §1) |
| `POST /v1/auth/salt` | `{ email }` | `{ salt, iterations }` (SP02 §4) |
| `POST /v1/auth/activate` | `{ email, code, salt, authKey, device }` | `{ token, personId }` |
| `POST /v1/auth/setup` | `{ email, name, code, salt, authKey, device }` | `{ token, personId }`, first admin |
| `POST /v1/auth/login` | `{ email, authKey, device }` | `{ token, personId }` |

`device = { name, os, appVersion }`.

- `activate` redeems an `activate` code bound to that email.
- `setup` redeems the setup code, creates the person and role `admin` (`admin = 1`), and
  assigns it.

### Person

`POST /v1/auth/logout` and `POST /v1/auth/password` landed with block 1 (`host/routes/auth.ts`).
The rest of this table — the session list and revoke, the personal tool/view writes and the
favorites write — did **not** land in block 1: they are the block 2 stories O1 and B7 (the Nod
methods `host.sessions`/`host.revokeSession`, `personal.*` and `favorites.set` are likewise block 2,
SP05 §3). The host rejects those paths with its `404` until they land.

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

- Personal tool ids must match `^p-[a-z0-9]{10}$`. The Nod generates them.
- A `PUT` of an id owned by someone else answers 403.

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
| `DELETE /v1/admin/tools/:id` | — | `204` |
| `POST /v1/admin/tools/:id/promote` | `{ personalId }` | `OrgTool`; copies a personal tool to org, owner keeps theirs |
| `POST /v1/admin/bootstrap` | `{ tools: OrgTool[], roles: Role[] }` | `{ created }`; only while the host has no org tools (B8a) |
| `GET /v1/admin/events` | `?person&tool&from&to&limit` | `HostEvent[]` |

## 3. Routes — block 2

| Route | Auth | Body | Response |
| --- | --- | --- | --- |
| `PUT /v1/keys` | person | `{ x25519Public, ed25519Public }` | `204`; replaces (reset) |
| `POST /v1/shares` | person | `{ credentialId, toolId, scope, kind, items: [{ to, sealed }] }` | `{ ids }`; checks scope and visibility (SP06 §5) |
| `POST /v1/shares/:id/accept` | recipient | — | `204`; purges `sealed`, adds holder |
| `POST /v1/shares/:id/decline` | recipient | — | `204`; purges `sealed` |
| `GET /v1/credentials/:id/holders` | holder or admin | — | `Holder[]` |
| `DELETE /v1/credentials/:id/holders/:personId` | owner or admin | — | `204`; marks removed; owner gets "rotation pending" |
| `PUT /v1/admin/assignments` | admin | `{ credentialId, roleId, toolId, assigned }` | `204` |
| `GET /v1/admin/assignments/missing` | admin | — | `[{ credentialId, toolId, roleId, personId }]`: members without a copy |
| `GET /v1/meta/app` | public | — | `{ minAppVersion, update: { url } \| null }` (O2) |

Incoming shares and the caller's holders data travel inside `GET /v1/state` (SP04 §2).

## 4. Acceptance

- An integration test file per route group runs the real Elysia app on a temp `/data` dir
  (`bun test`). It covers each status in the table of §1 at least once.
- `POST /v1/auth/login` with a wrong key and with an unknown email return byte-identical bodies.
- No route logs a request body. A test captures the logger and asserts no `authKey`, code or token
  appears.
