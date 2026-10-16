# test/ — proof

Two kinds of proof, matching `AGENTS.md`'s rule that nothing is "verified" without execution:

| Kind | Where | Runs | Proves |
| --- | --- | --- | --- |
| Unit | `test/*.test.ts`, `host/**/*.test.ts` (block 1 on) | `bun test` | Pure logic in `shared/` and the host against a real temp SQLite |
| Smoke | `test/smoke/` (`run.ts`, `smoke.html`, `tools.ts`) | `bun test/smoke/run.ts` | The real Bond app under tinyjs, with local fake tools, a throwaway app id (`BOND_APP_ID`) and its own data dir |

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
| Two-instance smoke: a local host container plus two Bond app ids (admin and person) | B11, K10 |

The two-instance smoke starts the host from `host/compose.yaml` on loopback (`http://127.0.0.1`,
which SP04 §1 allows only in dev), then drives both Bonds through `smoke.html` the way the current
smoke does.
