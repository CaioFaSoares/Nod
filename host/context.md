# host/ — the guild server

The server one guild runs on its Coolify: people, sessions, roles, org tools, grants, personal
tools and favorites, events, and (block 2) relayed credential shares. Optional: a Bond without a
host works exactly as before (`docs/epics/E01-connected-mode.md` §5).

Status: **H4 landed** (issue #8, block 1; H1 in #4, H2 in #5). `main.ts` boots on env data
(`config.ts`), creates the data dir and both key files (`keys.ts`), opens `bun:sqlite`, applies the
ordered migrations (`migrations.ts` — migration 1 holds every block 1 table of SP01 §2), builds the
Elysia app (`app.ts`), serves it and runs the backup timer; `Dockerfile` and `compose.yaml` deploy it
with the volume at `/data`. `repo.ts` holds every query of block 1 and the rules SP01 §2 keeps out of
SQL. `app.ts` builds the repo and the auth service once, decorates the request context with them and
mounts `routes/auth.ts`, which serves `POST /v1/auth/{salt,activate,setup,login}`, `/logout` and
`/password`; `auth.ts` holds the argon2id hash and verify, the salt lookup, the session tokens, the
rate limits and the `personAuth`/`adminAuth` guards every later group mounts. `snapshot.ts` and the
remaining route groups (`routes/admin.ts` for H5, state for H6, events for H8) are still to come.
Handovers: `docs/handovers/h1.md`, `h2.md`, `h4.md`.

## Stack (decided 2026-10-16)

Bun + Elysia 2 beta (exact beta pinned, bumped on purpose), `bun:sqlite`, `Bun.password` (argon2id).
Only Elysia as a dependency. One process, one SQLite file, one replica.

## Layout

| File | Role | Spec |
| --- | --- | --- |
| `main.ts` | Boot: env, data dir, key files, migrations, Elysia app, backup timer | SP07 |
| `app.ts` | Elysia routes; the repo and the auth service of the process; auth levels; error mapping; body limit | SP03 |
| `config.ts` | Environment → `HostConfig` (data dir, public URL, port, dev) | SP07 §1–§2 |
| `repo.ts` | The **only** module touching `bun:sqlite` (besides the connection in `migrations.ts`): every block 1 query, every rule SP01 §2 keeps out of SQL, and every read of personal data filtered by owner | SP01, SP03 §2 |
| `migrations.ts` | Ordered SQL migrations; opens the connection at boot and applies them (queries belong to `repo.ts`) | SP01 §1, §4 |
| `auth.ts` | The auth service: argon2id over `authKey`, real or fake salt, session tokens, the rate limits, and the `personAuth`/`adminAuth` guards | SP02, SP03 §1 |
| `routes/auth.ts` | The auth routes: `salt`, `activate`, `setup`, `login` (public) and `logout`, `password` (person) | SP02, SP03 §2 |
| `routes/<group>.ts` | One plugin per route group (H5 admin, H6 state, H8 events); each is one `.use(...)` line in `app.ts` | SP03 §2 |
| `snapshot.ts` | Per-person snapshot, version, Ed25519 signature | SP04 §2 |
| `keys.ts` | Signing key and host secret files | SP01 §1 |
| `backup.ts` | `VACUUM INTO`, rotation, restore | SP07 §4 |
| `cli/*.ts` | `setup-code`, `backup-now`, `restore` | SP07 §3 |
| `Dockerfile`, `compose.yaml`, `package.json` | Deployment | SP07 |
| `health.test.ts` | Boot and environment, on a temp data dir and the real app | SP01 §1, §5 |
| `repo.test.ts` | The block 1 schema and every repo rule, on a temp migrated data dir (no mock) | SP01 §2, §5 |
| `auth.test.ts` | The auth surface, the guards and the rate limits, on the real app over a temp data dir | SP02 §2–§5, SP03 §1–§2, SP07 §3 |

## Rules

- **Pure logic and types come from `shared/`**: catalog validation, key derivation, code format, API
  types (`shared/host-api.ts`). The host never redefines a shape the Bond also uses.
- **Never stored or logged**: passwords, `authKey`, tokens, codes, credential values or private
  keys. Only hashes, salts and sealed blobs.
- **No secret in a log.** The setup code goes only to the terminal that asked for it. No request body
  is ever logged.
- **One error message per auth failure** (`invalid credentials`, `invalid code`), and the same
  timing for unknown and known emails: an unknown email is verified against a fixed dummy hash.
- **The auth level is a guard, not a check inside a handler.** `personAuth` and `adminAuth`
  (`auth.ts`) are mounted **before** the routes they protect, in the file that owns them:
  `new Elysia().use(personAuth).get(...)`. A route reads the caller with `callerOf(ctx)` and the
  process's services with `hostOf(ctx)` — never through `any`. `adminAuth` carries `personAuth`, so
  mounting it is enough for the admin level.
- **The app maps an error, the route never builds a message**: `RepoError.status` (409, 403, 404) and
  a body that fails its schema (400, naming the field) become `{ error }` of SP03 §1. A failure
  never echoes a value from the request.
- **Rate limits live in the auth service, in memory** (SP02 §5): 30 auth requests per address per
  minute, 10 failed sign-ins per email per 15 minutes. The address is the last hop of
  `x-forwarded-for`, else the socket. They reset with the process, and a restart is the operator's
  answer to a stuck budget.
- **The body limit is decided in `app.ts`**, before the body is parsed: 256 KB everywhere, 512 KB
  where a tool body may carry an `entry.icon` (SP03 §1).
- **Personal data is filtered by owner in the repo**, not only in routes. An admin doesn't see
  another person's personal tools.
- **The rules SP01 §2 keeps out of SQL belong to `repo.ts`**: a grant only on an org entry, a
  personal entry always with an owner, a favorite and a personal view only on an entry its person
  can see, favorites pruned when visibility goes away, and never a change that leaves the guild
  without an admin. A refusal is a typed error carrying the status of SP03 §1 — `ConflictError`
  (409), `ForbiddenError` (403), `NotFoundError` (404) — so a route maps it without reading a
  message, and every message is static English (never an echo of the request).
- **Tests**: `bun test host/`, against a temp data dir and the real Elysia app; no mocks of the
  database.

## Read first

`docs/epics/E01-connected-mode.md` (why), `docs/specs/` SP01–SP04, SP07 (how), `AGENTS.md` (rules).
