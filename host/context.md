# host/ — the guild server

The server one guild runs on its Coolify: people, sessions, roles, org tools, grants, personal
tools and favorites, events, and (block 2) relayed credential shares. Optional: a Bond without a
host works exactly as before (`docs/epics/E01-connected-mode.md` §5).

Status: **H1 landed** (issue #4, block 1). `main.ts` boots on env data (`config.ts`), creates the
data dir and both key files (`keys.ts`), opens `bun:sqlite` and applies the ordered migrations
(`migrations.ts`), builds the Elysia app (`app.ts`) and serves `GET /health`; `Dockerfile` and
`compose.yaml` deploy it with the volume at `/data`. `repo.ts`, `auth.ts`, `snapshot.ts`,
`backup.ts` and `cli/` are still empty.

## Stack (decided 2026-10-16)

Bun + Elysia 2 beta (exact beta pinned, bumped on purpose), `bun:sqlite`, `Bun.password` (argon2id).
Only Elysia as a dependency. One process, one SQLite file, one replica.

## Layout

| File | Role | Spec |
| --- | --- | --- |
| `main.ts` | Boot: env, data dir, key files, migrations, Elysia app (backup timer arrives with SP07 §4) | SP07 |
| `app.ts` | Elysia routes; auth levels; error mapping; rate limits | SP03 |
| `config.ts` | Environment → `HostConfig` (data dir, public URL, port, dev) | SP07 §1–§2 |
| `repo.ts` | The **only** module touching `bun:sqlite` | SP01 |
| `migrations.ts` | Ordered SQL migrations; opens the connection at boot and applies them (queries belong to `repo.ts`) | SP01 §1, §4 |
| `auth.ts` | Codes, salt lookup, argon2id verify, sessions | SP02 |
| `snapshot.ts` | Per-person snapshot, version, Ed25519 signature | SP04 §2 |
| `keys.ts` | Signing key and host secret files | SP01 §1 |
| `backup.ts` | `VACUUM INTO`, rotation, restore | SP07 §4 |
| `cli/*.ts` | `setup-code`, `backup-now`, `restore` | SP07 §3 |
| `Dockerfile`, `compose.yaml`, `package.json` | Deployment | SP07 |
| `health.test.ts` | Boot and environment, on a temp data dir and the real app | SP01 §1, §5 |

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
- **Tests**: `bun test host/`, against a temp data dir and the real Elysia app; no mocks of the
  database.

## Read first

`docs/epics/E01-connected-mode.md` (why), `docs/specs/` SP01–SP04, SP07 (how), `AGENTS.md` (rules).
