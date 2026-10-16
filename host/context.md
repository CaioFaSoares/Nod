# host/ — the guild server

The server one guild runs on its Coolify: people, sessions, roles, org tools, grants, personal
tools and favorites, events, and (block 2) relayed credential shares. Optional: a Bond without a
host works exactly as before (`docs/epics/E01-connected-mode.md` §5).

Status: **H2 landed** (issue #5, block 1; H1 landed in #4). `main.ts` boots on env data
(`config.ts`), creates the data dir and both key files (`keys.ts`), opens `bun:sqlite` and applies
the ordered migrations (`migrations.ts` — migration 1 holds every block 1 table of SP01 §2),
builds the Elysia app (`app.ts`) and serves `GET /health`; `Dockerfile` and `compose.yaml` deploy it
with the volume at `/data`. `repo.ts` holds every query of block 1 (people, codes, sessions, roles,
grants, org and personal tools, views, favorites, events, meta) and the rules SP01 §2 keeps out of
SQL; `auth.ts`, `snapshot.ts`, `backup.ts` and `cli/` are still empty.
Handovers: `docs/handovers/h1.md`, `docs/handovers/h2.md`.

## Stack (decided 2026-10-16)

Bun + Elysia 2 beta (exact beta pinned, bumped on purpose), `bun:sqlite`, `Bun.password` (argon2id).
Only Elysia as a dependency. One process, one SQLite file, one replica.

## Layout

| File | Role | Spec |
| --- | --- | --- |
| `main.ts` | Boot: env, data dir, key files, migrations, Elysia app (backup timer arrives with SP07 §4) | SP07 |
| `app.ts` | Elysia routes; auth levels; error mapping; rate limits | SP03 |
| `config.ts` | Environment → `HostConfig` (data dir, public URL, port, dev) | SP07 §1–§2 |
| `repo.ts` | The **only** module touching `bun:sqlite` (besides the connection in `migrations.ts`): every block 1 query, every rule SP01 §2 keeps out of SQL, and every read of personal data filtered by owner | SP01, SP03 §2 |
| `migrations.ts` | Ordered SQL migrations; opens the connection at boot and applies them (queries belong to `repo.ts`) | SP01 §1, §4 |
| `auth.ts` | Codes, salt lookup, argon2id verify, sessions | SP02 |
| `snapshot.ts` | Per-person snapshot, version, Ed25519 signature | SP04 §2 |
| `keys.ts` | Signing key and host secret files | SP01 §1 |
| `backup.ts` | `VACUUM INTO`, rotation, restore | SP07 §4 |
| `cli/*.ts` | `setup-code`, `backup-now`, `restore` | SP07 §3 |
| `Dockerfile`, `compose.yaml`, `package.json` | Deployment | SP07 |
| `health.test.ts` | Boot and environment, on a temp data dir and the real app | SP01 §1, §5 |
| `repo.test.ts` | The block 1 schema and every repo rule, on a temp migrated data dir (no mock) | SP01 §2, §5 |

## Rules

- **Pure logic and types come from `shared/`**: catalog validation, key derivation, code format, API
  types (`shared/host-api.ts`). The host never redefines a shape the Bond also uses.
- **Never stored or logged**: passwords, `authKey`, tokens, codes, credential values or private
  keys. Only hashes, salts and sealed blobs.
- **No secret in a log.** The setup code goes only to the terminal that asked for it. No request body
  is ever logged.
- **One error message per auth failure** (`invalid credentials`, `invalid code`), and the same
  timing for unknown and known emails.
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
