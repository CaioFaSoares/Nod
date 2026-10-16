# Fix — a tool that exists only on the host receives a credential

Delimited failure handed over by the coordinator (the `em-curso` issue of the front, Block 1 "One
guild, synced"). Origin: `docs/handovers/b5.md` "What another owner must do" item 3 and
`docs/handovers/b11.md` finding 4. Contracts followed: `docs/specs/SP05-bond-connected.md` §2 (the
`vault_item` paragraph and "Connected catalog"), §5.3; `docs/specs/SP02-auth-and-keys.md` §8 (RF-38,
the item's `origin`); `docs/arquitetura.md` §2 (the runtime origin gate and the window guard), §4.
Rules: `AGENTS.md`, `backend/context.md`, `test/context.md`. English only (RNF-08).

Nothing here is secret-bearing: no key, token or password enters a file, a log, an event or
`store.json`. The smoke's temporary seed holds no secret and is restored at the end of the run.

## Symptom, reproduced before the correction

`execucao` — the new test of `test/vault.test.ts`, run against the code before this fix (the line
numbers are the pre-fix ones):

```
$ bun test test/vault.test.ts -t "exists only on the host"
bun test v1.4.3 (26aa4e1a9)
SQLiteError: FOREIGN KEY constraint failed
      errno: 787,
       code: "SQLITE_CONSTRAINT_FOREIGNKEY"
      at #run (bun:sqlite:187:20)
      at run (test/helpers/sqlite-bun.ts:20:23)
      at saveVaultItem (backend/repo.ts:1124:8)
      at save (backend/vault.ts:82:22)
      at async <anonymous> (test/vault.test.ts:305:30)
(fail) origin > a tool that exists only on the host receives a credential, on the host entry origin
 0 pass · 14 filtered out · 1 fail
```

The test models connected mode the way `backend/main.ts` builds it: the vault over
`{ ...database, entry: catalogEntryOf }` (SP05 §2), with a `host` entry for `jitsi` and **no** `tool`
row of that id. `vault.save` finds the entry (so not `unknown tool` — the wiring of B5 is already
right) and then the index write hits the FK.

## Cause, and the distance to the symptom

Two constraints met, both inherited from the local-only schema:

1. `vault_item.tool_id` was `NOT NULL REFERENCES tool (id) ON DELETE CASCADE` in `backend/repo.ts`'s
   `SCHEMA`, and `backend/sqlite.ts` opens the database with `PRAGMA foreign_keys = ON`. A connected
   org entry is read from `host.snapshot` (SP05 §2) and has no local `tool` row — SP05 §2 forbids
   writing one — so the insert could not succeed. The database answered with the raw
   `FOREIGN KEY constraint failed`, which names neither the table nor the entry: that is the distance
   between cause and symptom. `unknown tool` was the other face of the same gap, and it is what a
   machine that read the entry from the local table instead would have said (b5's finding 3).
2. The `login.report` origin guard of `backend/main.ts` (`requireToolOrigin`) read the entry from the
   local table. On a machine that stamps the window origin (macOS) a host-only tool's report was
   refused with `unknown tool` before the handler ran, so the cascade's fill could not be reported
   either. This is the "fill" half of the same failure; the coordinator's decision names
   `vault.save`/`reveal`/fill, so it is fixed here too.

Hypotheses discarded, with the reason:

- *"the vault's `entry` wiring is missing"* — `leitura` of `backend/main.ts:164`: the vault is
  already built over `{ ...database, entry: (id) => catalogEntryOf(id) }`, and `catalogEntryOf`
  answers the connected catalog's entry while connected. Nothing to change there.
- *"`catalogEntryOf` does not see the entry"* — `execucao`: the new test reaches `saveVaultItem`
  (the failure is the FK, not the refusal), and the smoke's step 3.6/3.7 has the entry in
  `catalog.list` before saving.
- *"the constraint can be dropped with an `ALTER`"* — SQLite has no `ALTER TABLE … DROP CONSTRAINT`;
  the table has to be rebuilt (the recipe below). Probed by the `repo.test.ts` cases.
- *"the version marker tells whether the FK is there"* — it does not: a v2 database and a block-1 one
  both carry it, and a fresh database of this build does not. The guard is the constraint itself
  (`PRAGMA foreign_key_list`), which is also what makes `migrate()` idempotent here.
- *"the FK's cascade was what removed a tool's vault rows"* — `leitura` of `backend/repo.ts`:
  `removeEntry` already deletes `tool_view`, `tool_grant` **and** `vault_item` explicitly, in one
  transaction. The rebuild loses nothing; the test below proves it with no FK in place.

## Files touched

| File | What changed |
| --- | --- |
| `backend/repo.ts` | `SCHEMA`'s `vault_item`: `tool_id TEXT NOT NULL` — the FK to `tool` is gone, the FK to `person` and `UNIQUE (person_id, tool_id)` stay. New `rebuildVaultItem()`, called by `migrate()` between `addColumns()` and `backfillVaultOrigin()`: guarded by `PRAGMA foreign_key_list(vault_item)` naming `tool` (not by `user_version`), it is the SQLite documentation's 12-step rebuild — `foreign_keys` off **outside** the transaction (the pragma is a silent no-op inside one), `vault_item_rebuilt`, `INSERT … SELECT` of the nine columns, `DROP`, `RENAME`, one transaction, the pragma back on in a `finally`. `user_version` stays 3. The header and `migrate()` comments record the direction: a *constraint* a later build removes is written twice like a column, with a rebuild instead of an `ALTER`. |
| `backend/main.ts` | `requireToolOrigin` (the `login.report` guard of SP05 §2/§4) reads `catalogEntryOf(toolId)` instead of `repo.entry(toolId)`: the effective catalog, entry and origin. Local mode is unchanged (`catalogEntryOf` is `repo.entry` there), and `guarded` still answers `bootFailure` before this runs, so dropping the `required(repo, …)` wrapper loses no check. |
| `backend/vault.ts` | Comment only: the entry is read from the effective catalog and is still refused when the catalog does not know it — not because of a FK, but because without an entry there is no origin to bind the credential to (RF-38). No behaviour change: `save` is the only path that writes. |
| `test/repo.test.ts` | Helper `foreignKeysOf` (sorted, so the comparison is order-free) and `foreignKeysOn`; new `describe('vault_item without the tool foreign key (SP05 §2)')` with three tests: a fresh database has the FK to `person` only and accepts a credential for an entry with no `tool` row; a database of an earlier build (`user_version` 2 **and** 3, built with the old DDL) is rebuilt with every row kept, the FK to `tool` gone, the pragma back on, a host-only insert accepted, the `person` FK still enforced and a second `migrate()` harmless; removing a local tool still deletes its vault rows with no FK to do it. |
| `test/vault.test.ts` | New test in `describe('origin')`: a tool that exists only on the host (the repository's `entry` overridden the way `main.ts` does it) receives a credential, stored with the **host entry's** origin, readable, and with the value only in the keychain. |
| `test/smoke/connected.ts` | The temporary seed is now per app id (`temporarySeed(tools, appId)`, written by `runPhase` before `gen-config` runs, so it is both the runtime origin gate's source and the catalog the app applies): the admin's has `tool-a`, the person's has `tool-a-old` — the same address under the id another release gave it — so the granted host entry has **no** local `tool` row on P's machine. New `personVault(origin)` reads P's own SQLite after the phases (read-only, before `clean()` wipes the dir) and the run fails unless the item of `tool-a` is there with Tool A's origin and P's `tool` table has **0** rows of that id. The backup/restore of `resources/seed.json` is untouched. |
| `test/smoke/connected.html` | Comment only: the person-join phase now says the granted tool is the host's entry (P's own seed has no row for it). |
| `docs/handovers/fix-vault-host-tool.md` | This file. |

Nothing else was touched: `backend/sqlite.ts` (the pragma is B9's), `backend/connected-catalog.ts`,
`shared/*`, `src/*`, the host, `docs/arquitetura.md` and the specs (their owner is writing the
matching text) were read, never edited.

## Acceptance

### "The vault takes the credential's entry from the effective catalog, and `vault_item` stops requiring a local `tool` row."

- *the entry comes from the effective catalog* — `leitura` of `backend/main.ts:162-164` (already the
  case, B5's decision 7) and `execucao` of the new `test/vault.test.ts` case: the item's `origin` is
  the host entry's url, `https://jitsi.example.test`, while the local `tool` table has no `jitsi`.
- *`vault_item` stops requiring a local `tool` row* — `execucao` of the three new `repo.test.ts`
  cases: the FK to `tool` is absent from a fresh database and from a rebuilt one, and a credential
  whose `tool_id` has no `tool` row is stored and read back.
- *the migration is guarded, idempotent and safe on v2/v3* — `execucao`: the same database is
  migrated twice (rows and version intact), both `user_version` 2 and 3 are covered, and the
  `person` FK and `PRAGMA foreign_keys = ON` are still in force afterwards.
- *removing a local tool still removes its vault rows* — `execucao`: the new `removeEntry` case (and
  the older `catalog › listEntries orders by order and title; removeEntry takes views, grants and
  vault with it`, which runs on the new shape).
- *local mode is unchanged* — `leitura`: no local-mode read or write touched the vault, `catalogEntryOf`
  falls back to `repo.entry` when there is no host row, and the FK to `person` is untouched. The
  guard's stricter answer while connected — an entry that is not in the effective catalog is
  `unknown tool` — is unreachable from an open window: `tool-windows.reconcile()` closes the window
  of any entry that left `visible()` on every catalog push.

### "Connected smoke green with the person's seed lacking the tool."

`execucao`, `bun test/smoke/connected.ts --force` (4 phases, 40 steps):

```
ok     3.7 vault.save (Tool A) (10 ms) credential saved for tool-a (value only in the keychain)
ok     3.8 tools.open (fill on the origin) (3303 ms) the form was filled on the credential's own origin (login filled)
...
P's vault rows after the run:
  vault items: 1
  item of tool-a: origin "http://127.0.0.1:56231" (expected "http://127.0.0.1:56231")
  local tool-a rows in tool: 0 (expected 0)
connected smoke ok: 4 phases, 40 steps, admin-publish:13 person-join:16 admin-revoke:7 person-signed-out:4
private seed restored
```

Two runs of the same command produced the same result (`40 steps`, the two lines above). The
credentials never printed: 3.7 reports the id and the keychain, 3.8 the login result.

## Commands run and observed results

1. `bun test test/vault.test.ts -t "exists only on the host"` — the reproduction above (`1 fail`,
   `FOREIGN KEY constraint failed`), run before any source file was edited.
2. `bun test test/repo.test.ts test/vault.test.ts` — `68 pass`, `0 fail`, `388 expect() calls`,
   `Ran 68 tests across 2 files`. (Before: `67 pass`, `1 fail` — the case of command 1.)
3. `bun test/smoke/connected.ts --force` — twice, the two runs above: `connected smoke ok: 4 phases,
   40 steps`, the private seed restored both times (the seed of `resources/seed.json` is byte for byte
   the owner's again: 962 bytes, mtime untouched).
4. Scratch compile of this slice's backend files (not the project gate, which stays with the
   coordinator):

   ```
   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext \
       --moduleResolution bundler --lib es2022,dom --skipLibCheck \
       backend/tjs.d.ts backend/tiny.d.ts backend/main.ts backend/repo.ts backend/vault.ts
   exit=0 (no diagnostics)
   ```
5. Not run, by the mandate: `bun run typecheck`, `bun test test/`, `bun test/smoke/run.ts`, any
   formatter, `bun run app:dev`.

An incident, disclosed because it is a real hazard for whoever runs this smoke next: the **first**
attempt exited without result — `SyntaxError: unexpected token in expression: '}'` at
`.build/app/entry.js:65` — because a `bun run app:dev` of another process was rebuilding the shared
`.build/app/` directory while the smoke's first app was starting. The process was gone by the next
attempt, which is the pair of green runs above; the smoke itself was not at fault and nothing was
changed for it.

## What could not be done, and what was not run

- **No real-surface *before*.** The delimited failure was reproduced at the unit level (command 1),
  not by running the changed smoke against the old code: reverting the fix for one run would have
  put a host-only-incompatible tree in front of the peers' gates for as long as the run takes. What
  the smoke does prove is the *condition* — `local tool-a rows in tool: 0`, read from P's own
  database — plus the two steps that fail without it (3.7 and 3.8); the old code's answer under
  exactly that condition is what command 1 observed.
- **Not on the real app / not in the owner's database.** The rebuild of the owner's own
  `~/Library/Application Support/studio.copland.bond/bond.db` (a v3 database with the FK, whose first
  boot after this change rebuilds `vault_item`) was **not** exercised: the smoke uses its own app
  ids and wipes them, and `bun run app:dev` is not the mandate's. The v3 path is covered by the
  `repo.test.ts` case with a hand-built v3 database.
- **No txiki.js run of the migration outside `tinyjs dev`.** The rebuild is `exec`/`run`/`all` only,
  the same statements the rest of this file uses on `tjs:sqlite`; what ran here is `bun:sqlite`
  (same SQLite) through `test/helpers/sqlite-bun.ts` and, for the smoke, the real backend under the
  real runtime.
- **No new dependency, no runtime or toolchain swap.**

## Findings for the coordinator

1. **One change went beyond `backend/repo.ts` + `backend/vault.ts`: the `login.report` guard in
   `backend/main.ts`.** It is the same failure (a host-only tool cannot be filled either) and it is
   named in the decision ("fill"). It is three lines and it leaves local mode identical; if the
   coordinator prefers it in another owner's slice, the guard is `requireToolOrigin`.
2. **The runtime origin gate is built from the *installed* seed, not from the connected catalog**
   (`scripts/gen-config.ts` → `tinyjs.json`'s `api.origins`; `docs/arquitetura.md` §2). A tool whose
   address is not in this machine's `resources/seed.json` cannot have its `login.report` accepted —
   the window would be filled but the result never reported. That is why the smoke's person seed
   keeps Tool A's **origin** (under another entry id): the granted entry has no local row, which is
   what the fix is about, while the origin stays gated. Making a host-only tool fillable *and*
   reportable with no seed entry at all is a bigger question (the gate would have to follow the
   snapshot), and it is not this ticket's.
3. **`docs/specs/SP05-bond-connected.md` §2 already carries the new paragraph** (the FK to `tool`
   dropped, guarded rebuild in `migrate()`, `removeEntry`'s explicit delete), written by the docs
   owner beside this fix; `docs/arquitetura.md` §4 lists `vault_item`'s columns without FKs, so it
   does not contradict it. What it may want is one line in the `migrate()` comment there (the
   rebuild, not only the added columns) — the docs owner's call.
4. **`vault.reveal` needed nothing.** It reads the index by `(person, tool)` and the keychain; the
   entry is not on that path. Said here so the decision's "reveal" is not read as a gap.

## Where the evidence lands

This file, plus the tests it names: `test/repo.test.ts` (three cases), `test/vault.test.ts` (one),
`test/smoke/connected.ts`'s own post-run check. The state of the story is the issue's `status` and
the coordinator's handover; this file decides neither.
