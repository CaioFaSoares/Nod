# test/ — proof

Two kinds of proof, matching `AGENTS.md`'s rule that nothing is "verified" without execution:

| Kind | Where | Runs | Proves |
| --- | --- | --- | --- |
| Unit | `test/*.test.ts`, `host/**/*.test.ts` (block 1 on) | `bun test` | Pure logic in `shared/` and the host against a real temp SQLite |
| Smoke, local | `test/smoke/` (`run.ts`, `smoke.html`, `tools.ts`) | `bun test/smoke/run.ts` | The real Nod app under tinyjs, with local fake tools, a throwaway app id (`NOD_APP_ID`), a free dev port and a page file named after the launch's nonce (so a `tinyjs dev` a previous smoke left behind can neither serve nor reload this launch's page), and its own data dir |
| Smoke, connected | `test/smoke/` (`connected.ts`, `connected.html`, `tools.ts`) | `bun test/smoke/connected.ts [--force]` | The real Nod under four app ids beside a real host process: SP05 §5 steps 2–5 and block 2's sharing (SP06 §4–§6, B7, K1–K9), no external network, no container |

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
| Person fingerprint vectors, the pin decision, the sealed key pairs and the pin table against in-memory SQLite (`test/keys.test.ts`) | K1–K2 |
| The scope decision, the sealed payload and every `invalid share` path, plus a send/accept/decline end to end against the real host app (`test/shares.test.ts`) | K4, K6, K7 |
| The admin's assignment to a role and to one person, the missing-copy list and its seal behind the gate, end to end against the real host app (`test/assign.test.ts`) | K8 |
| The owner's update fan-out to the holders, the revoked holder staying `rotation pending` until a new secret is saved, and the no-gate apply of an incoming update (`test/rotation.test.ts`) | K9 |
| The gate's factor (SP02 §9): a password the call carries wins over the machine's biometrics (`test/gate.test.ts`) | K5 |
| Host route groups against a temp data dir | H4–H8 |
| Two-instance smoke: a host process plus two Nod app ids (admin and person) | B11 |
| The same smoke over four app ids: the personal half across machines, send/accept/assign/update/revoke and the no-plaintext dump of `host.db` | K10 |

## The connected smoke (`test/smoke/connected.ts`)

`bun test/smoke/connected.ts` refuses while `resources/seed.json` exists, exactly like the local
smoke; `--force` moves it to `test/smoke/.gerado/seed.json.bak` and restores it at the end.

What it starts, all on loopback, with no external network and no container:

| Piece | How |
| --- | --- |
| Host | `bun host/main.ts` on a free loopback port: `NOD_DATA` in `test/smoke/.gerado/connected/host-data`, `NOD_DEV=1`, `NOD_PUBLIC_URL=http://127.0.0.1:<port>`, `NOD_GUILD_NAME=Smoke Guild` (SP04 §1 allows plain `http://` only in dev) |
| Setup code | `bun host/cli/setup-code.ts` over the same environment; it stays in the runner's memory (never printed, never written to a file) |
| Tools | `test/smoke/tools.ts` (A, B and C), the same fake servers the local smoke uses; Tool C's origin is the personal tool's address (it is not in any seed) |
| Nods | four app ids — `copland.nod.smoke-admin`, `...smoke-person`, `...smoke-person2` and `...smoke-admin2` — launched one at a time the way `run.ts` launches one: temporary seed, `gen-config` with that app id, **a free dev port of its own per launch**, a page file named after the launch's nonce, `TINYJS_HTML=connected.html` and the result channel through `<app data>/store.json` |

The page drives SP05 §5 and block 2's sharing in fourteen phases, in this order — the two icon
phases need P's syncs, the sharing needs both members before `people.revoke`, and the revocation of
P is last because a revoked person cannot push later:

| Phase | Spec | What it drives |
| --- | --- | --- |
| `admin-publish` | SP05 §5.2, §6, B7, K1 | the setup code, `host.bootstrap`, role `team`, an access code for each member, both grants, the admin joining `team` (a `role` share needs a role in common), a personal tool and its favorite, the guild PNG |
| `person-join` | SP05 §5.3, §5.5, §6, B7, K1 | P activates, the granted tool appears, no personal half of another person arrives, the vault fills on its origin; host stopped and started again; the guild icon shows |
| `person2-join` | SP05 §5.3 | Q, the second member of `team`, activates the same way |
| `admin-clear` | SP05 §6 | the admin removes the guild icon |
| `person-cleared` | SP05 §6 | P's next sync deletes the file and drops the option |
| `admin-share` | K2, K4, K6, K8 | both members pinned with the fingerprints they reported, the personal tool and the favorite read out of the snapshot, one credential scoped `role` and sent to both, a second one assigned to `team` |
| `person-share` | K4, K5, K7 | the inbox holds the send and the assign; the send is accepted behind the gate, `vault.reveal`/`vault.copy` pass it, the holders list both people |
| `person2-accept` | K4, K8 | Q accepts the same two shares and reveals the same value |
| `admin-update` | K8, K9 | three holders per credential; the owner saves a new secret, which fans an update out; the missing list is empty |
| `person-update` | K9 | the sync applies the update with no gate, the vault moves, the host purged the share |
| `admin-rotate` | K9/RF-48 | `shares.removeHolder` on P → `rotationPending`, then the save that reaches Q and clears it |
| `admin-second-machine` | SP05 §5.3, B7, K1 | the same person's second machine signs in, ends with the pair of the first one (canonico §22) and finds the personal tool and its favorite in the snapshot |
| `admin-revoke` | SP05 §5.4 | `people.revoke` on P |
| `person-signed-out` | SP05 §5.4 | P's next sync is `signed-out` and the org tools are gone |

No code goes through a file: the pages fetch the setup code and each member's access code from a
loopback endpoint the runner serves ("the desk"), and the admin page hands the codes back the same
way. The desk is also what stops and starts the host process, and what carries one machine's own key
fingerprint (a public digest) to another. Every gated call carries the password: on a machine with
biometrics the backend would otherwise open the operating system's prompt (SP02 §9's fallback).

The runner reads the host's own SQLite afterwards — people, roles, org entries, grants, the personal
entries and favorites, the shares and holders, the assignments, and P's events — and asks **every
text column of every table** for the username and the secrets the run wrote (SP06 §6/RF-44): it
prints the counts of tables, columns and hits, and never a value. It also reads P's `nod.db` (the
accepted item's origin, credential and scope) and the second machine's (which must hold no local
`tool` row for the personal tool). Nothing printed is ever a code, a token, a password, a secret or
a sealed blob — step names, statuses, counts and public digests only.
