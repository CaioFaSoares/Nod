# host/ — the guild server

The server one guild runs on its Coolify: people, sessions, roles, org tools, grants, personal
tools and favorites, events, and (block 2) relayed credential shares. Optional: a Nod without a
host works exactly as before (`docs/epics/E01-connected-mode.md` §5).

Status: **block 1 complete** (milestone "Block 1 — One guild, synced", 2026-10-16; commit
`6af9e64`); **block 2's mine and shared landed** (H7, O1's person side, O2). `main.ts` boots on env
data (`config.ts`), creates the data dir and both key files
(`keys.ts`), opens `bun:sqlite`, applies the ordered migrations (`migrations.ts` — migration 1 holds
every block 1 table of SP01 §2), builds the Elysia app (`app.ts`), serves it and runs the backup
timer; `Dockerfile` and `compose.yaml` deploy it with the volume at `/data`. `repo.ts` holds every
block 1 query and the rules SP01 §2 keeps out of SQL. `app.ts` builds the repo and the auth service
once, decorates the request context with them and mounts one plugin per route group: `routes/auth.ts`
(`POST /v1/auth/{salt,activate,setup,login}`, `/logout`, `/password` — H4), `routes/admin.ts` (the
admin group of SP03 §2 — H5), `routes/state.ts` (discovery + the signed state — H6),
`routes/events.ts` (`POST /v1/events` — H8), `routes/guild.ts` (`GET /v1/guild/icon` — I2h),
`routes/person.ts` (`/v1/sessions`, the personal tools and views, favorites — H7, O1) and
`routes/meta.ts` (`GET /v1/meta/app` — O2), `routes/shares.ts` (block 2's public keys, shares,
holders and the share lifecycle — E02 K1/K3/K7/K9) and `routes/assignments.ts` (the admin's
assignments and the missing-copy list — E02 K8);
`auth.ts` holds the argon2id hash and verify, the salt
lookup, the session tokens, the rate limits and the `personAuth`/`adminAuth` guards each group mounts
for itself; `snapshot.ts` builds the discovery document and the signed snapshot. The guild icon
(the admin's upload in `routes/admin.ts`, the person's download in `routes/guild.ts`) lives in two
`meta` rows and travels as the digest inside the snapshot (SP03 §2, SP04 §2). Every route of SP03
§2–§3 is served; the host side of E02's block 2 (migration 2 of SP01 §3, SP03 §3's keys, shares,
holders and assignments, SP06) **has landed** — the Nod side of those stories is `backend/`'s and
`src/`'s. Handovers: `docs/handovers/h1.md`, `h2.md`, `h4.md`,
`h5.md`, `h6.md`, `h8.md`, `h9.md`, `i2h-guild-icon-host.md`, `h7-o1-o2-host.md`,
`k3-host-shares.md`.

## Stack (decided 2026-10-16)

Bun + Elysia 2 beta (exact beta pinned, bumped on purpose), `bun:sqlite`, `Bun.password` (argon2id).
Only Elysia as a **runtime** dependency. `@types/bun` is a dev-only `devDependency` (`host/package.json`,
pinned to the Bun of the `Dockerfile`): it is types for the toolchain and for `bun run typecheck`, it
is never imported at runtime and never ships in the image. One process, one SQLite file, one replica.

## Layout

| File | Role | Spec |
| --- | --- | --- |
| `main.ts` | Boot: env, data dir, key files, migrations, Elysia app, backup timer | SP07 |
| `app.ts` | Elysia routes; the repo and the auth service of the process; auth levels; error mapping; body limit | SP03 |
| `config.ts` | Environment → `HostConfig` (data dir, public URL, port, dev) and to `AppMeta` (minimum app version, update manifest URL — the one value discovery and `/v1/meta/app` share) | SP07 §1–§2, SP03 §3 |
| `repo.ts` | The **only** module touching `bun:sqlite` (besides the connection in `migrations.ts`): every block 1 and block 2 query, every rule SP01 §2 keeps out of SQL, the share rules of SP06 §4–§5, and every read of personal data filtered by owner | SP01, SP03 §2–§3 |
| `migrations.ts` | Ordered SQL migrations — 1 holds every block 1 table of SP01 §2, **2 every block 2 table of SP01 §3**; opens the connection at boot and applies them (queries belong to `repo.ts`) | SP01 §1, §3–§4 |
| `auth.ts` | The auth service: argon2id over `authKey`, real or fake salt, session tokens, the rate limits, and the `personAuth`/`adminAuth` guards | SP02, SP03 §1 |
| `routes/auth.ts` | The auth routes: `salt`, `activate`, `setup`, `login` (public) and `logout`, `password` (person) | SP02, SP03 §2 |
| `routes/admin.ts` | The admin group: people, their access codes and sessions, roles, grants, org tools, the one-time bootstrap and the event list; every route behind `adminAuth` (mounts `personAuth` first) | SP01 §2, SP02 §3, SP03 §2 |
| `routes/state.ts` | `GET /.well-known/nod` (public) and `GET /v1/state` (person), the signed snapshot and its `If-None-Match` | SP04 §1–§2 |
| `routes/events.ts` | `POST /v1/events`: the event batch, client-id idempotency, the ack | SP04 §5, SP03 §2 |
| `routes/presence.ts` | `GET /v1/presence` (person, members only): who is online — a live session seen within `PRESENCE_WINDOW_MS`; derived from `sessions.last_seen_at`, outside the signed snapshot | RF-58, SP03 §2 |
| `presence.test.ts` | Presence on the real app: online inside the window, last seen past it, disabled/revoked/clients never listed, client `403`, only the four keys | RF-58 |
| `routes/guild.ts` | `GET /v1/guild/icon` (person): the guild PNG byte for byte, `ETag: "<sha256>"`, `404` without one | SP03 §2 |
| `routes/person.ts` | The person group: `/v1/sessions` and `/v1/sessions/:id` (own only), `/v1/personal/tools/:id`, `/v1/personal/views/:id`, `/v1/favorites`; every route behind `personAuth`, every `updatedAt` the Nod's | SP01 §2, SP03 §2, SP04 §4 |
| `routes/meta.ts` | `GET /v1/meta/app` (public): the minimum app version the discovery repeats and the update manifest URL, or `null` | SP03 §3 |
| `routes/shares.ts` | Block 2's person group: `PUT /v1/keys`, `POST /v1/shares` (one sealed copy per item), the `accept` and `decline` of a share, `GET /v1/credentials/:id/holders` and `DELETE /v1/credentials/:id/holders/:personId`; every route behind `personAuth` | SP03 §3, SP06 |
| `routes/assignments.ts` | Block 2's admin group: `PUT /v1/admin/assignments` and `GET /v1/admin/assignments/missing`; behind `personAuth` + `adminAuth`, for the reason above | SP03 §3, SP06 §4 |
| `snapshot.ts` | The discovery document, the fingerprint; per-person snapshot, version, `guildIcon`, the block 2 fields (`people`, `incomingShares`, `holders`, `rotationPending`), Ed25519 signature | SP04 §1–§2 |
| `keys.ts` | Signing key and host secret files | SP01 §1 |
| `backup.ts` | `VACUUM INTO`, rotation and restore. Names neither `bun:sqlite` nor its constructor — the handle is typed from `Host` — so the connection stays in `migrations.ts`; the check runs `PRAGMA integrity_check` on the restored copy through `openDatabase` | SP07 §4 |
| `cli/*.ts` | `setup-code`, `backup-now`, `restore` | SP07 §3 |
| `Dockerfile`, `compose.yaml`, `package.json` | Deployment | SP07 |
| `health.test.ts` | Boot and environment, on a temp data dir and the real app | SP01 §1, §5 |
| `repo.test.ts` | The schema of both migrations and every repo rule, on a temp migrated data dir (no mock), including migration 2 applied over an existing block 1 file | SP01 §2–§5 |
| `auth.test.ts` | The auth surface, the guards and the rate limits, on the real app over a temp data dir | SP02 §2–§5, SP03 §1–§2, SP07 §3 |
| `admin.test.ts` | The admin surface, on the real app over a temp data dir: every route, the code shown once, the reissue, the revocation, the last admin, the bootstrap window, the filters | SP01 §2, SP02 §3, SP03 §1–§2 |
| `state.test.ts` | The discovery and the signed snapshot on the real app, with the Nod client end to end | SP04 §1–§2 |
| `events.test.ts` | The event batch on the real app: client ids, idempotency, the ack, the 500 cap | SP04 §5, SP03 §1–§2 |
| `person.test.ts` | The person surface on the real app over a temp data dir: the own-session list and revoke (the revoked device's 401), the personal tools, views and favorites with their 400/403/404/409, and that no admin answer carries another person's personal data | SP01 §2, SP03 §1–§2, SP04 §4 |
| `meta.test.ts` | `GET /v1/meta/app` and the app metadata of the environment on the real app: the defaults, the semver/URL validation, the public level, and the one value the discovery repeats | SP03 §1, §3, SP04 §1 |
| `guild-icon.test.ts` | The guild icon on the real app: the admin's upload and digest, the 400/403/413, the byte-for-byte download with its `ETag`, the delete, and `Snapshot.guildIcon` inside the signed bytes | SP03 §2, SP04 §2 |
| `shares.test.ts` | The block 2 host surface on the real app over a temp data dir: `PUT /v1/keys` and the roster, the whole share lifecycle (send, accept, decline, expiry, update, revocation), the scope refusals of SP06 §5, the holders of a credential, the assignments and the missing-copy list, and the block 2 fields inside the signed snapshot | SP03 §3, SP06, RF-44/47/48/53/54 |
| `backup.test.ts` | `VACUUM INTO`, rotation, the restore triple, and the connection invariant | SP07 §4 |

## Rules

- **Pure logic and types come from `shared/`**: catalog validation, key derivation, code format, API
  types (`shared/host-api.ts`). The host never redefines a shape the Nod also uses.
- **Never stored or logged**: passwords, `authKey`, tokens, codes, credential values or private
  keys. Only hashes, salts and sealed blobs.
- **No secret in a log.** The setup code goes only to the terminal that asked for it. No request body
  is ever logged.
- **One error message per auth failure** (`invalid credentials`, `invalid code`), and the same
  timing for unknown and known emails: an unknown email is verified against a fixed dummy hash.
- **The auth level is a guard, not a check inside a handler.** `personAuth` and `adminAuth`
  (`auth.ts`) are mounted **before** the routes they protect, in the file that owns them:
  `new Elysia().use(personAuth).get(...)`. A route reads the caller with `callerOf(ctx)` and the
  process's services with `hostOf(ctx)` — never through `any`. `adminAuth` carries `personAuth`, and a
  group still mounts `personAuth` itself first (`new Elysia().use(personAuth).use(adminAuth)`): a
  plugin's `derive` does not reach the `derive` of the plugin that mounts it, so `adminAuth` alone
  reads `person` as undefined and answers 500 — measured, `docs/handovers/h5.md`. Mounted that way
  each guard runs once per request, in the order `person` → `admin` → the route.
- **The app maps an error, the route never builds a message**: `RepoError.status` (409, 403, 404) and
  a body that fails its schema (400, naming the field) become `{ error }` of SP03 §1. A failure
  never echoes a value from the request.
- **Rate limits live in the auth service, in memory** (SP02 §5): 30 auth requests per address per
  minute, 10 failed sign-ins per email per 15 minutes. The address is the last hop of
  `x-forwarded-for`, else the socket. They reset with the process, and a restart is the operator's
  answer to a stuck budget.
- **The body limit is decided in `app.ts`**, before the body is parsed: 256 KB everywhere, 512 KB
  where a body may carry an icon — an `entry.icon` data URI (the admin tool writes, the bootstrap,
  and the personal tool write of SP03 §2) or the guild PNG the admin uploads (SP03 §1).
- **The app metadata is one resolved value** (SP03 §3, O2): `config.ts` reads
  `NOD_MIN_APP_VERSION` and `NOD_UPDATE_URL` at boot into `AppMeta`, `main.ts` hands it to the app,
  and both `routes/meta.ts` (`GET /v1/meta/app`) and the discovery answer the same `minAppVersion`
  through `appMetaOf` — never a second read of the environment with a second default.
- **The guild icon is bytes plus their digest, in two `meta` rows** (`GUILD_ICON_HASH_KEY`,
  `GUILD_ICON_BYTES_KEY`, `repo.ts`): `PUT /v1/admin/guild/icon` stores both (`400` when the bytes
  are not a PNG), `GET /v1/guild/icon` answers the bytes with the digest as the `ETag`, and
  `Snapshot.guildIcon` carries the digest alone — a tampered icon fails the Nod's own comparison
  (SP03 §2, SP04 §2).
- **Personal data is filtered by owner in the repo**, not only in routes. An admin doesn't see
  another person's personal tools.
- **An org tool write carries the host clock as `updatedAt`** (`routes/admin.ts`); only the personal
  writes of SP03 §2 carry Nod's `updatedAt`, which is what last-write-wins compares (SP04 §4).
  A code the admin issues is returned once, stored as the hex SHA-256 of its normalized form and
  never listed again (SP02 §3).
- **A refusal the query can decide is a typed error, and a route that had to read a row first throws
  the same type**: `new NotFoundError('unknown person')` for an id no query ever sees, never a
  hand-built `{ error }` body.
- **The rules SP01 §2 keeps out of SQL belong to `repo.ts`**: a grant only on an org entry, a
  personal entry always with an owner, a favorite and a personal view only on an entry its person
  can see, favorites pruned when visibility goes away, and never a change that leaves the guild
  without an admin. A refusal is a typed error carrying the status of SP03 §1 — `ConflictError`
  (409), `ForbiddenError` (403), `NotFoundError` (404) — so a route maps it without reading a
  message, and every message is static English (never an echo of the request).
- **A share is only ciphertext, and it does not live long.** `sealed` is the opaque base64url of
  SP06 §3: the host stores it, hands it to its recipient and purges it — `''` with `purged_at` set —
  when the share is accepted, declined or reaches its 14 days (SP01 §3). No route or repo reads
  inside it, and no value of a body reaches a log or an error message (SP03 §1). The read paths run
  the purge, so the state build of `snapshot.ts` and the accept/decline routes clear expiry.
- **The recipient rules of SP06 §5 live in `createShares`** (`repo.ts`), one check per item: the
  recipient exists, is not disabled and has keys (404/403/409); the tool is an org entry granted to
  one of their roles (403); `role` also needs a role in common with the sender, `org` a `member`,
  and `blocked` refuses the whole request — as does a credential whose owner holder row is blocked.
  Only an admin assigns (`kind: 'assign'`) and only the credential's owner holder updates
  (`kind: 'update'`, to current non-removed holders).
- **The sender becomes the owner holder** on the first share of a credential, and the holder rows
  are what the host derives everything else from: `GET /v1/credentials/:id/holders` and
  `Snapshot.holders` (a holder or an admin; an admin sees every credential), and
  `Snapshot.rotationPending` — the credential ids the owner revoked somebody from and has not
  re-sealed since (an `update` share clears it). The owner row is not removable (409).
- **The block 2 fields of `Snapshot` are inside the signed bytes**: the roster with public keys, the
  open shares addressed to the caller, the holders of what the caller holds, and what must rotate
  (SP04 §2). They are optional in the type so a Nod still reads an older host's body.
- **Tests**: `bun test host/`, against a temp data dir and the real Elysia app; no mocks of the
  database.

## Read first

`docs/epics/E01-connected-mode.md` (why), `docs/specs/` SP01–SP04, SP07 (how), `AGENTS.md` (rules).
