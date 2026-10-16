# test/ — proof

Two kinds of proof, matching `AGENTS.md`'s rule that nothing is "verified" without execution:

| Kind | Where | Runs | Proves |
| --- | --- | --- | --- |
| Unit | `test/*.test.ts`, `host/**/*.test.ts` (block 1 on) | `bun test` | Pure logic in `shared/` and the host against a real temp SQLite |
| Smoke, local | `test/smoke/` (`run.ts`, `smoke.html`, `tools.ts`) | `bun test/smoke/run.ts` | The real Bond app under tinyjs, with local fake tools, a throwaway app id (`BOND_APP_ID`) and its own data dir |
| Smoke, connected | `test/smoke/` (`connected.ts`, `connected.html`, `tools.ts`) | `bun test/smoke/connected.ts [--force]` | The real Bond under two app ids beside a real host process: SP05 §5 steps 2–5, no external network, no container |

`test/helpers/sqlite-bun.ts` adapts `bun:sqlite` to the backend's `SqlDb`, so `backend/repo.ts` runs
under Bun.

## Rules

- **Behavior, not wording.** Tests assert outcomes, boundaries and errors, not message text or
  source shape.
- **Smoke never uses real credentials**, and never runs with `TINYJS_DEBUG=1` and a real account
  (`AGENTS.md`).
- **The smoke refuses to run when `resources/seed.json` exists**, unless given `--force` (it writes
  its own seed).

## Added by blocks 1–2

| Proof | Story |
| --- | --- |
| Key-derivation vectors in Bun, and the same vectors in txiki.js through the smoke | H3 |
| Seal/open vectors across both runtimes | S0 |
| Host route groups against a temp data dir | H4–H8 |
| Two-instance smoke: a host process plus two Bond app ids (admin and person) | B11, K10 |

## The connected smoke (`test/smoke/connected.ts`)

`bun test/smoke/connected.ts` refuses while `resources/seed.json` exists, exactly like the local
smoke; `--force` moves it to `test/smoke/.gerado/seed.json.bak` and restores it at the end.

What it starts, all on loopback, with no external network and no container:

| Piece | How |
| --- | --- |
| Host | `bun host/main.ts` on a free loopback port: `BOND_DATA` in `test/smoke/.gerado/connected/host-data`, `BOND_DEV=1`, `BOND_PUBLIC_URL=http://127.0.0.1:<port>`, `BOND_GUILD_NAME=Smoke Guild` (SP04 §1 allows plain `http://` only in dev) |
| Setup code | `bun host/cli/setup-code.ts` over the same environment; it stays in the runner's memory (never printed, never written to a file) |
| Tools | `test/smoke/tools.ts` (A and B), the same fake servers the local smoke uses |
| Bonds | two app ids — `studio.copland.bond.smoke-admin` and `studio.copland.bond.smoke-person` — launched one at a time the way `run.ts` launches one: temporary seed, `gen-config` with that app id, its own dev port (5199, 5200), `TINYJS_HTML=connected.html` and the result channel through `<app data>/store.json` |

The page drives SP05 §5 in four phases, in this order — steps 4 and 5 conflict for P, because a
revoked person cannot push later:

1. `admin-publish` (§5.2) — the setup code, `host.bootstrap`, role `team`, `invites.issue` for P,
   `roles.grant`, sync;
2. `person-join` (§5.3 and §5.5) — P activates, the granted tool appears, the vault fills on its
   origin; the host process is stopped (lock, unlock offline, tools from the cache, `stale`) and
   started again (the events go up);
3. `admin-revoke` (§5.4) — `people.revoke` on P;
4. `person-signed-out` (§5.4) — P's next sync is `signed-out` and the org tools are gone.

No code goes through a file: the pages fetch the setup code and P's access code from a loopback
endpoint the runner serves ("the desk"), and the admin page hands P's code back the same way. The
desk is also what stops and starts the host process. The runner reads the host's own SQLite
afterwards (people, roles, org entries, grants, and P's events) and prints step names, statuses and
counts only — never a code, a token or a password.
