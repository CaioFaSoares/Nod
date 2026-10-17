# B8b — local tools offered as personal tools on Add host; Remove host keeps them (issue #25)

Slice: Block 2 — Mine and shared. Authorizing issue: `#25` (`[B8b] Local tools become personal on Add
host; Remove host keeps them`, labels `epic:E01`, `area:backend`, `area:src`, `type:story`, `sp:3`),
after #24 (B7) with gate #1 closed. Contracts followed: `docs/specs/SP05-nod-connected.md` §2–§3 (the
issue text names `SP05-bond-connected.md`; the file in the repository is `SP05-nod-connected.md`),
`docs/canonico.md` §14 RF-40 (and RF-37), the epic's RF-40 row
(`docs/epics/E01-connected-mode.md`), `docs/handovers/b7-personal.md` (finding 3: `host.remove`
`keepPersonal` landed; the adopted tool's icon left out) and `docs/handovers/b8a.md`. Rules read:
`AGENTS.md`, `backend/context.md`, `shared/context.md`, `src/context.md`, `test/context.md`.

Everything below is English (RNF-08). No project gate was run: not `bun run typecheck`, not the whole
`bun test test/`, not a formatter or linter, not the smoke. What ran is the slice's own new test file
and two files this slice edited (`bun test`, allowed by the mandate). Nothing added here holds a
secret: a leftover is a title and an address, the outbox row is SP03 §2's personal write, and no
password, `vaultKey`, host token or credential ever enters a log, an event, an error or `store.json`.

## Files touched

| File | What changed |
| --- | --- |
| `shared/host-merge.ts` | New pure `leftoverLocalTools(local, orgTools)` (RF-40): the local `org` tools whose normalized address — origin plus path, query and fragment dropped (`shared/catalog.ts`'s `auditUrl`) — matches none of the snapshot's `orgTools`. One private `normalizedAddress` helper; a new `./catalog` import. |
| `shared/types.ts` | Two additive `ApiContract` rows in the host region: `host.localLeftovers` (read, `Entry[]`) and `host.adoptLocalAsPersonal` (`{ ids: Id[] }` → `{ created: number }`). |
| `backend/personal.ts` | New `adoptLocalTool(local, icon)` on `Personal`: the same path as `saveTool` (a `p-…` id, one outbox row while connected), plus one `saveView` per local view (the host drops the views a tool body carries). `adoptSnapshot` gained an optional `ops` argument and applies `applyOutbox` over the snapshot's personal half before it keeps or drops it. |
| `backend/repo.ts` | New `rekeyVaultTool(fromToolId, toToolId)`: moves the `vault_item` index rows to the new tool id, `keychain_key` untouched. |
| `backend/main.ts` | `leftoverTools()` helper (plus `parseSnapshot`/`leftoverLocalTools` imports); the `host.localLeftovers` and `host.adoptLocalAsPersonal` handlers; `host.adoptLocalAsPersonal` added to `HOST_WRITES`; `host.remove` hands the outbox to `adoptSnapshot`. |
| `src/settings.ts` | `state.leftovers`/`state.leftoversClosed`; the Hosts tab reads `host.localLeftovers` on load; a "Keep your local tools" card (a checkbox per leftover, all checked, "Keep as personal tools" and "Not now"); the card is re-read after a join and after a bootstrap; removal clears it. |
| `test/host-handoff.test.ts` (new) | 7 tests of the pure leftover rule (same address, another path, query/fragment, another origin, no org tools, order, unparsable address). |
| `test/personal.test.ts` | 3 tests: `adoptLocalTool` (the `p-…` entry, one tool outbox row with title/url/icon, one view outbox row), `rekeyVaultTool` (the id moves, the keychain pointer stays), and the `adoptSnapshot` overlay (a pending personal tool is kept with the kept half, dropped with the dropped one). |
| `docs/handovers/b8b.md` | This file. |

`backend/vault.ts` and `backend/session.ts` were **not** touched (VaultFinish's this phase). No
`user_version` bump: the local schema is untouched.

## Acceptance criterion — how each item was met

### 1. "After Add host, every pre-existing local tool is either an org tool now or offered (and by default kept) as a personal tool."

`execucao` (the pure rule, `test/host-handoff.test.ts`) + `leitura` of the wiring:

- *The leftover set is the local `org` catalog minus the guild's own tools.* `leftoverTools()`
  (`backend/main.ts`) reads the local `tool` rows of scope `org` and the verified snapshot's
  `orgTools` (through `parseSnapshot`), and `leftoverLocalTools` keeps the ones whose normalized
  address matches none. A local tool the guild already serves is that tool, so it stays as it is;
  every other one is a leftover.
- *The step lists them and keeps them by default.* `src/settings.ts`'s `leftoverCard` renders one
  checked checkbox per leftover (all checked, via `checkbox`/`checkboxField`) and the "Keep as
  personal tools" action; "Not now" hides the step for the session only.
- *Keeping one makes it a personal tool.* `host.adoptLocalAsPersonal` calls `personal.ts`'s
  `adoptLocalTool`, which is `saveTool` (the `p-…` id, the Nod's `updatedAt`, one
  `PUT /v1/personal/tools/:id` outbox row while connected) with the local tool's title, address,
  order, auth override and icon (data URI), and one `PUT /v1/personal/views/:id` per view. The local
  `org` row is then removed, so the tool is not listed twice once the host is removed. The unit test
  drives the entry, the tool row and the view row.
- *The icon B7 left out.* `host.localLeftovers` resolves each leftover's stored icon through
  `localEntriesWithIcons` (`repo.iconHash` → `Icons.dataUri`, the same helper B8a uses), so the page
  and the adoption carry the data URI an entry carries. No new icon helper was needed: the missing
  piece was the call site, not the conversion.
- *The step appears after the join and after the bootstrap.* A join in the Hosts tab refreshes the
  tab (`joinSection`'s `onJoined` now runs `load()`), a join from the first-run screen is covered
  when Settings → Hosts opens, and `publishLocalTools` re-reads the leftovers after a successful
  publish — a published tool is an org tool of the guild now, so it leaves the list.

### 2. "Remove host with keep-personal returns personal tools as local tools; org tools removed."

`leitura` + `execucao`: B7's `adoptSnapshot` (kept) materializes the personal half as local rows and
never materializes the snapshot's `orgTools`; `clearHost` drops the host row (with the snapshot) and
the outbox, so a guild-only org tool is gone and the local catalog is the catalog again. Two gaps
were closed here:

- *The adopted tool's views.* `adoptLocalTool` writes each view as a personal view (a separate outbox
  row), because `host/routes/person.ts` drops the `views` a tool body carries; without that the views
  would be lost at the next snapshot.
- *A personal tool still in the outbox.* `adoptSnapshot` now applies `applyOutbox` over the snapshot's
  personal half with the outbox rows `host.remove` hands it, before keeping or dropping. `clearHost`
  deletes the outbox, so a personal tool the person just added — the leftovers a join just adopted,
  offline included — would otherwise go with the host even when the person asked to keep it. The unit
  test pins both directions.

## Decisions

1. **The matching rule is origin plus path** (`shared/catalog.ts`'s `auditUrl`), not the origin alone
   and not the whole URL. The origin alone would swallow a *different* tool the guild happens to serve
   on another path of the same host; the whole URL would call the same button a leftover over a
   trailing `?`/`#`. The rule is documented at `leftoverLocalTools` and pinned by the tests.
2. **A kept leftover loses its local `org` row.** The tool moves to the guild; leaving the local row
   would make the same tool appear twice after `host.remove` with keep-personal (the snapshot's
   personal tool plus the untouched local row). The local catalog of a Nod joined *without* a
   bootstrap keeps its rows: those are not leftovers, they are the guild's own tools (SP05 §2's "the
   local tables keep the local-mode catalog"), and they come back on removal as before.
3. **A view is a personal view, not a field of the tool body.** `PUT /v1/personal/tools/:id` reads
   `views` for shape and writes nothing of them (`host/routes/person.ts`), so `adoptLocalTool` sends
   each view through `PUT /v1/personal/views/:id` — the route the snapshot's `personalViews` come
   from. `personal.saveView` re-checks the view stays on the tool's origin, which a local view already
   satisfied.
4. **The credential follows its tool through the repository, not through the vault.** The keychain key
   is `nod.cred.<person>.<tool>` (`backend/vault.ts`) and the value is sealed with that key as AAD,
   but `vault.read` looks the value up by the `keychain_key` **stored in the index row**, not by
   recomputing it from the id. So moving `vault_item.tool_id` (`repo.rekeyVaultTool`) keeps the
   credential usable with no `vaultKey` on hand and without touching `backend/vault.ts` (VaultFinish's
   file this phase). No message to `agent://VaultFinish` was needed.
5. **`adoptSnapshot` gains an optional fourth parameter** (`ops`) instead of a new method or a changed
   signature: B7's two tests keep calling it with three arguments, and `host.remove` passes
   `repo.listOutbox()`. It is the same overlay `backend/connected-catalog.ts` already applies over the
   personal half.
6. **`host.adoptLocalAsPersonal` sits in `HOST_WRITES`.** It queues the guild's personal writes for
   this person, so an outdated Nod refuses it like the other `host.*` writes (`backend/context.md`'s
   O2 rule: a method that reaches the host belongs in `HOST_WRITES` and in the sync gate). The
   `personal.*` writes it reuses are not in that table (B7's comment: the sync gate stops them);
   whether they should be is a finding for the coordinator, not a change this slice makes.
7. **The step is a session-level offer, not a permanent screen.** "Not now" only hides it; the local
   rows are untouched, and the step comes back the next time the tab is opened (the leftovers are
   still there). Once every leftover is kept, the list is empty and the card disappears.
8. **The card is hidden while signed out.** RF-39 empties the snapshot's org half on a `401`
   (`shared/host-merge.ts`'s `clearOrgData`), and the leftovers would then list the whole local
   catalog as if the guild did not serve it. It is hidden for `none` and `signed-out`, like B8a's
   publish offer.

## What was left out

- **The real surface was not run.** No `tinyjs dev`, no smoke: the offer's rendering and the removal
  round trip two machines deep are `leitura` here. Extending `test/smoke/connected.ts` with a
  "join → keep leftovers → remove with keep-personal" phase belongs to the phase's smoke (B11's
  runner), and this slice did not touch it.
- **No project gate**: `bun run typecheck`, the whole `bun test test/`, the formatters and the linters
  are the coordinator's.
- **The keychain key name keeps the old tool id.** After `rekeyVaultTool` the index row points at the
  new personal id while `keychain_key` still reads `nod.cred.<person>.<oldId>` — that string is what
  opens the sealed value (`vault.ts` reads by the stored key; its AAD is the same string), so the
  credential stays usable, but the name no longer matches the tool id. A later **re-save** of that
  credential writes a fresh `nod.cred.<person>.<newId>` item and updates the index row, leaving the
  old keychain item orphaned. Cleaning that up needs a re-seal (a `vault.ts` operation this slice does
  not own); the case only arises after the person re-saves the credential of an adopted tool. Reported
  as a finding, not silently fixed.
- **A local account that is not the one adopting.** `rekeyVaultTool` moves **every** person's index
  rows for the old tool id to the new one. Only the adopter can reach the new personal tool; another
  local account's credential (a device could hold several) becomes unreachable either way, because its
  tool row is gone. The alternative — a per-person re-seal — needs the other person's `vaultKey`,
  which is not on hand.
- **Personal tools added while disconnected, then `host.remove` without keep**: dropped, exactly as
  B7 left it (RF-37's writes are the host's state; SP05 §2's "removing the host returns to the local
  tables" does not keep what the host never held). The overlay closes the `keep-personal` half only.
- **A local *personal* row (B7, scope `personal`) is neither an org tool nor a leftover.** The task's
  definition of a leftover is a local `org` row whose address matches no snapshot org tool, and this
  slice implements exactly that. But B7 lets a local-mode person add a personal tool, and while
  connected the catalog is the snapshot's personal half (`visibleEntriesOf`), so such a row is hidden
  from the sidebar and the step does not offer it — the one pre-existing local tool the RF-40
  acceptance sentence ("every pre-existing local tool is either an org tool now or offered") does not
  cover. Including it is not a small change: re-saving it under a fresh `p-…` id would leave two
  copies once the host is removed (the hidden local row and the materialized personal one), and
  `saveTool` cannot reuse the old id because a connected personal tool must already be visible in the
  effective catalog. **Reported as a divergence for the coordinator, not silently decided** — the
  stories that could close it (a local-personal migration on join, or hiding local personal rows on
  the join's own terms) are outside this issue's file list.

## Commands run and observed results

1. **The all-new pure file** (allowed by the mandate):

   ```
   $ bun test test/host-handoff.test.ts
    7 pass
    0 fail
    7 expect() calls
   Ran 7 tests across 1 file.
   ```

2. **The two test files this slice edited**:

   ```
   $ bun test test/personal.test.ts
   23 pass
    0 fail
   Ran 23 tests across 1 file.

   $ bun test test/host-merge.test.ts
   14 pass
    0 fail
   Ran 14 tests across 1 file.
   ```

   (`personal.test.ts` was 20 before this slice; the three new cases are the two `adoptLocalTool`/
   `rekeyVaultTool` ones and the `adoptSnapshot` overlay one.)

3. **Not run, by the mandate**: `bun run typecheck`, the whole `bun test test/`, the smoke
   (`test/smoke/`) and any formatter. The settings card and the removal round trip were not executed —
   `leitura` of `src/settings.ts`, `backend/main.ts`, `backend/personal.ts` and `backend/repo.ts`.

## For other owners

- **Coordinator — `docs/specs/SP05-nod-connected.md` §3**: the two new rows (`host.localLeftovers`
  `→ Entry[]`; `host.adoptLocalAsPersonal { ids } → { created }`) should be added beside the B8a
  `host.bootstrap` row. **§4** already promises the offer; the leftovers step is its second half.
- **Coordinator — `docs/canonico.md` §15 open question 4** ("Removing a host: keep personal tools and
  favorites as local tools (proposal), or wipe"): this slice confirms "keep" is what B7 + B8b
  implement; the question can be closed.
- **Vault (V1 / VaultFinish)**: if a `vault.ts` helper ever re-seals a value under a new keychain key,
  `repo.rekeyVaultTool`'s naming quirk (finding above) could be retired by re-sealing instead of
  re-pointing. Not required for correctness today.
- **B11 (#22)**: the connected smoke has no phase for this story; if it gains one, the observation is
  "join, keep the leftovers, close the host, and the tools are still in the local sidebar".
- **Coordinator — RF-40's scope**: decide whether a local-mode *personal* row (see "What was left
  out") is also offered on a join. It is the one local tool the current definition leaves out, and it
  needs its own rule (the id cannot be reused through `personal.saveTool`).

---

## Fixes (HandoffFix, 2026-10-17) — the two divergences b8b left open, plus the orphan keychain item

This section is additive: it closes finding 1 and finding 4 of the "What was left out" list above and
the orphan-keychain finding, without changing what the slice above already stated. Same rules: English
(RNF-08), no project gate run here (no `bun run typecheck`, no whole `bun test test/`, no formatter, no
linter, no smoke). What ran are the files this fix touched (`bun test`, allowed by the mandate). Nothing
added here holds a secret.

### Files touched

| File | What changed |
| --- | --- |
| `shared/host-merge.ts` | `leftoverLocalTools(local, orgTools, personalTools = [])`: the pure rule now takes the person's local rows of both scopes. An `org` row is a leftover when its normalized address matches no snapshot org tool (unchanged); a `personal` row is a leftover unless the snapshot's personal half already carries its **id** (a personal tool's identity is its id). |
| `backend/personal.ts` | `ownedTool` falls back to the local `tool` row while connected, so a local `personal` row (hidden from the snapshot catalog) is recognised; `adoptLocalTool` reuses a personal row's own `p-…` id (fresh id otherwise) and copies its views out of the meta table (`localViews`), not from the row. |
| `backend/main.ts` | `leftoverTools()` now passes every local row (org, plus the person's own personal rows) and the snapshot's `personalTools` to the pure rule; the five personal writes are in `HOST_WRITES`; `hostWriteRefused(method, updateRequired)` is extracted from `guarded()` and exported; `host.adoptLocalAsPersonal` re-keys the vault rows only when the id actually moved. |
| `backend/vault.ts` | `save` reads the index row before the write and, when its `keychain_key` differs from the canonical key, deletes the stale keychain item after the new value landed. |
| `src/settings.ts` | The "Keep your local tools" card's copy now says the personal tools added on this machine are included. |
| `test/host-handoff.test.ts` | 3 new cases: a personal row not in the snapshot is a leftover; a personal row the snapshot carries by id is not; org + personal leftovers in the local order. |
| `test/personal.test.ts` | 2 new cases for adoption (id + views survive Add host → Remove host with keep-personal, exactly one local row; a personal row whose id is not a `p-…` gets a fresh one) and 1 for the O2 gate. |
| `test/vault.test.ts` | 1 new case: re-saving a re-keyed credential writes the canonical keychain key and leaves no orphan. |
| `docs/handovers/b8b.md` | This section. |

### Acceptance — how each item was met

1. **Every pre-existing local tool survives Add host and Remove host with keep-personal, no duplicates.**
   - *Pure rule* (`execucao`, `test/host-handoff.test.ts`): a local `personal` row is a leftover until
     the snapshot's personal half holds its id, and the org rule is unchanged.
   - *Adoption round trip* (`execucao`, `test/personal.test.ts`): a local personal row keeps its id and
     its views; after the join handler drops the local row and `host.remove(keepPersonal)` runs
     `adoptSnapshot` over the snapshot + outbox, exactly one local row of that tool remains.
   - *Id reuse* is why there is no duplicate: the row is published under its own id, so the snapshot's
     copy and the materialized local row are the same id (an org leftover still moves to a fresh id
     and its `vault_item` rows are re-keyed).
2. **Personal writes refused while update-required in connected mode; local mode unaffected.**
   - The five methods are in `HOST_WRITES`; the gate refuses them through the exported
     `hostWriteRefused(method, requiresUpdate())` (`execucao`, the new `test/personal.test.ts` case
     pins the table + both halves).
   - `requiresUpdate()` is `false` while no `host` row exists (`backend/sync.ts`'s `updateRequiredNow`,
     already covered by `test/sync.test.ts`), so adding the methods unconditionally never stops a
     local-only Nod — the second argument of `hostWriteRefused` is that state.
3. **Re-saving a re-keyed credential leaves no orphan keychain item.** `execucao`,
   `test/vault.test.ts`: after the re-key the index row still points at `nod.cred.<person>.<oldId>`; a
   re-save writes `nod.cred.<person>.<newId>` (bv1 AAD = canonical key) and deletes the old item, so
   the keychain holds one value.

### Decisions

1. **The personal-row leftover is keyed by id, the org-row one by address.** Two ids that match are
   the same personal tool (the host's `p-…` is globally unique); the org comparison stays origin +
   path, as above. Mixed lists keep the input order, so the card and the handler read the same rows.
2. **`hostWriteRefused` is exported from `backend/main.ts`.** The `HOST_WRITES` gate could not be
   unit-tested before: `backend/main.ts` imports the `tjs:sqlite` built-in, so a test has to stub that
   module. The predicate takes the two decisions as data (`method`, `updateRequired`), so the test
   pins the real table without booting the runtime. `guarded()` calls the same predicate, so the test
   exercises the gate and not a copy of it.
3. **The vault clean-up is ordered after the new value lands.** `previous` is read before the seal;
   the stale item is deleted only once `keychain.set` accepted, so a refused or locked save never
   destroys the credential that is still in place.
4. **No schema bump.** The local tables are untouched; `user_version` stays 5.

### Commands run and observed results

```
$ bun test test/host-handoff.test.ts test/personal.test.ts test/vault.test.ts
  56 pass, 0 fail

$ bun test test/host-merge.test.ts test/connected-catalog.test.ts
  26 pass, 0 fail
```

Not run, by the mandate: `bun run typecheck`, the whole `bun test test/`, the formatter, the linter and
the smoke. `src/settings.ts`'s card copy was not executed (a string change), and the `backend/main.ts`
wiring is `leitura` of the handlers and the gate; the exported predicate is the one exercised.

### For other owners

- **Coordinator — `docs/canonico.md` §15 open question 4 / RF-40's scope** (the closing note above):
  the local personal row is now offered and kept, so RF-40's "every pre-existing local tool" holds for
  both scopes.
- **Vault (V1 / VaultFinish)**: `backend/vault.ts` now owns the re-key clean-up; the
  `repo.rekeyVaultTool` naming quirk is retired on the next re-save. No `backend/session.ts` change.
- **B11 (#22)**: the smoke phase can observe "a personal tool added before the join is still in the
  sidebar after the join and after Remove host".
