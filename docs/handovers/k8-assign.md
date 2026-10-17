# Slice K8 — Assign to a person or a role, and the missing-copy list

Owner: the **K8** slice of E02's block 2 — issue **#36 [K8] Assign to a person or a role;
missing-copy list** (`/tmp/nod/issue-36.md`), the last host-side gap the K3 handover left open plus
the Nod side of the story. The host half touches the rule `docs/handovers/k3-host-shares.md`
reported as **finding 2** and its **finding 5**; the Nod half is the `assignments.*` surface, the
per-sync read and the Vault tab's two admin cards.

Contracts followed: `docs/specs/SP06-credential-sharing.md` §4–§5 (the flows and the scope table),
SP03 §3 (the two admin routes and the statuses of §1), SP04 §2 (the state the Nod publishes),
`host/context.md`, `backend/context.md`, `src/context.md`, `AGENTS.md`.

Not run: the repo-wide `bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter — the
coordinator runs those once at the end of the phase. What ran: this slice's own test files
(`test/assign.test.ts`, `host/shares.test.ts`), `test/sync.test.ts` (the file whose subject the one
additive `sync.ts` change sits in), `test/shares.test.ts` (the receiver path an `assign` share
travels), `test/personal.test.ts` (which crosses `backend/main.ts`'s import) and a scratch parse
probe of `src/settings.ts` — all disclosed in "Commands run".

## Files touched

| File | What changed |
| --- | --- |
| `host/repo.ts` | `createShares`: the `role` common-role check of SP06 §5 is skipped for `kind: 'assign'`, and an assignment instead requires the recipient to be a member of a role the credential is assigned to (`403 not a member of an assigned role`) — unless the credential has **no** assignment row at all, which is the direct person assignment. The assigned roles are read once per request, before the item loop. `missingCopies`: `AND p.kind <> 'client'`. |
| `host/shares.test.ts` | The assignment test now sends the role assignment with scope `role` (the case finding 2 said was refused) and asserts a non-member of the assigned role is `403 not a member of an assigned role`; a second test covers the direct person assignment (an `assign` with no assignment row) and that a client in the assigned role never enters the missing list. `joinClient` grew two optional parameters (email, name) so a fixture can hold two clients. |
| `backend/shares.ts` | The K8 section: `assign` (the credential's uuid generated the way `send` does it, `PUT /v1/admin/assignments` for a role, a direct `kind: 'assign'` copy for a person, then the seal to the members the host lists as missing), `missing` (`MissingCopyView[]`: the host's rows with the member's name, the tool's title and the store's key state), `sealMissing` (one gate, one `assign` copy per reachable member, `changed`/`unknown` keys skipped and counted), `refreshAssignments` / `missingCount` for the sync loop and the state, and the reasons `ADMIN_ONLY` / `NO_ASSIGNMENT_TARGET` plus `GATE_REASON.assign`. The list lives in a module-level array — memory only. |
| `backend/host-client.ts` | `HostConnection.putAssignment` (`PUT /v1/admin/assignments`) and `missingCopies` (`GET /v1/admin/assignments/missing`). |
| `backend/main.ts` | `HOST_WRITES` and `ADMIN_ONLY` gained `assignments.set` / `assignments.sealMissing` (`assignments.missing` is a read: `ADMIN_ONLY` only); the three handlers after `shares.removeHolder`; the `createSync` deps `refreshAssignments` / `missingCopies`. |
| `backend/sync.ts` | Two optional `SyncDeps` (`refreshAssignments?`, `missingCopies?`), one awaited best-effort call after `fetchSnapshot`, and the conditional field in `state()`. |
| `shared/types.ts` | `MissingCopyView`, `HostState.missingCopies?: number`, and the three RPCs `assignments.set` / `assignments.missing` / `assignments.sealMissing`. |
| `src/settings.ts` | The Vault tab's admin half: an `Assign` action and dialog per credential (a role or a person, with `Remove assignment`), the "Members missing a copy" card (one line per member with their key state, one gated `Send copies`), the state fields, the gate kinds `assign` / `sealMissing`, and the reads and handlers behind them. |
| `test/assign.test.ts` | **New.** Three tests on the real host app (below). |
| `host/context.md`, `backend/context.md`, `shared/context.md`, `src/context.md` | The rows and rules above. |
| `docs/handovers/k8-assign.md` | This file. |

## Acceptance criterion — how each item was met

### 1. Assigning to role `team` reaches every current member

| How | Evidence |
| --- | --- |
| The admin's Nod writes the assignment and seals to every member the host lists as missing in the same gated call; the host's `createShares` accepts the `kind: 'assign'` copies of an admin to the members of the assigned role, without asking for a role in common with the sender. | `test/assign.test.ts` — "the admin assigns to `team` and every current member receives the copy": the two Nods sync, both have one `assign` share, both accept it and both read the credential; the gate recorded the one reason; the host holds `Root, Alice, Bob` as holders and the `assignments` row names the assigning admin. `execucao` |

### 2. A new member of `team` appears in the admin's missing list until the admin's Nod seals their copy after the gate

| How | Evidence |
| --- | --- |
| The host's `missingCopies` lists a member of an assigned role with keys and no live holder row; the Nod reads it once per sync, keeps it in memory and seals one copy to each reachable member behind the single gate. | `test/assign.test.ts` — "a member who joins `team` later is missing until the admin seals their copy after the gate": after Dave joins, the list is exactly one `MissingCopyView` (`personName: 'Dave'`, `keyStatus: 'pinned'`); `sealMissing` answers `{ sent: 1, skipped: 0 }` after the gate, Dave receives the `assign` share and accepts it, and the list is empty again. `execucao` |
| The count is published for the page: `HostState.missingCopies` carries the length of the same in-memory list, and the Vault tab says "N members are missing a copy of an assigned credential". | `execucao` (the field and the card) — the page itself is not exercised by a test (see "What was left out"). |

### 3. The host findings the task named

- **Finding 2 (the admin cannot `assign` with scope `role`)**: fixed in `createShares`. For
  `kind: 'assign'` the `role` rule of SP06 §5 is not applied; the credential's assignment rows are
  the rule instead, and the scope of the request (never broader than the credential's) travels. The
  K8 Nod therefore sends the credential's own scope — `role` for a normal assignment, `org` when the
  owner chose it. `docs/handovers/k3-host-shares.md`'s "K6/K8: `kind: 'assign'` needs scope `org`"
  no longer holds; the coordinator's decision 2 of that handover is resolved by this slice's reading
  of SP06 §4 ("the admin assigns to a role" is not a member-to-member `role` share).
- **Finding 5 (a client in an assigned role)**: `missingCopies` leaves `kind = 'client'` out, as
  SP06 §5 refuses them an `org` share and the host holds no scope on an assignment row. A client an
  admin wants to hand a copy to gets one through the direct person assignment.

## Decisions

1. **The list clears on the member's accept, not on the seal.** `missingCopies` is derived from the
   `credential_holders` rows (RF-47), so a member whose copy is sealed but not yet accepted is still
   listed. That is the K3 behaviour and the host test's own assertion; the seal puts the ciphertext
   in the member's inbox and the accept is what makes them a holder. The Vault tab's card is read
   again on every `host` push, so the list follows.
2. **One gated action, not two.** `assignments.set` with `assigned: true` runs the seal for the
   credential in the same call (`refreshAssignments` after the `PUT`, then the seal), so the page
   never has to press twice; `assignments.sealMissing` is the same seal over the whole list, for the
   members who join later. `k3`'s flow reading in SP06 §4 says the same ("after the gate it seals and
   sends them with `kind: 'assign'`").
3. **The direct person assignment is an `assign` share with no row.** `roleId` absent and
   `personId` present: no `PUT`, one sealed copy, and the host accepts it because the credential has
   no assignment row (see the rule above). `assigned: false` with a `personId` is a no-op — there is
   no row to remove — and is not gated.
4. **The gate covers the seal, not the metadata write.** A removal, and a person-less removal, read
   no secret; the person is asked for a password exactly when a copy is about to travel. The copy
   itself is sealed with the credential's stored scope, and a `blocked` credential is refused with
   `blocked credential` before the gate — the same refusal `shares.send` gives (SP06 §5).
5. **The state field is optional.** `HostState.missingCopies?` is written by `sync.ts` only when the
   wiring provides `missingCopies` (a member's Nod, and `test/sync.test.ts`'s harness, do not), so
   the field's absence is what a member sees and the page reads it as `0`.
6. **`assignments.set` and `assignments.sealMissing` carry an optional `password`.** The issue's
   signatures do not name one, but both reach the K5 gate, and the page has no other way to hand the
   password over on a machine without biometrics — the same shape `shares.send` and `shares.accept`
   already have. `assigned: false` and a `personId`-only removal do not gate and ignore it.

## Open findings

1. **The state's count is not exercised end to end.** `test/assign.test.ts` drives
   `shares.refreshAssignments()` / `missing()` / `missingCount()` directly (the same calls
   `main.ts` wires into `sync.ts`), and `test/sync.test.ts` covers the loop; no test asserts a
   `host.state` answer that carries `missingCopies`. The page's card, the assign dialog and the gate
   prompt are not exercised by a test either (the repo's page has no test file for this tab).
2. **`missingCopies` does not check the tool's grant.** A member of an assigned role whose role is
   not granted the assigned tool is listed, and the seal to them is then refused by the host
   (`tool not visible to recipient`, `403`). It is the literal reading of RF-47 ("every non-disabled
   member of the role"); an assignment to a role the tool is not granted for is a configuration the
   admin sees as a refused send.
3. **`missingCopies` has no scope**, so a `role`-scoped assignment cannot reach a `client` through
   the list at all (decision 3 of the host side of this slice). Reported rather than solved: the
   host's `assignments` table has no scope column, and adding one is a schema change no slice of
   this block was authorized for.
4. **Two admins can assign the same credential** to the same role: `saveAssignment` upserts on
   `(credential_id, role_id)` and `assigned_by` follows the last writer, so the earlier admin's
   missing list no longer excludes them. The list only exists for whoever the row names; reported as
   a coordinator question (the same shape as k3's finding 9).

## Commands run and observed results

1. **This slice's files**, on the final tree:

   ```
   $ bun test host/shares.test.ts test/assign.test.ts test/sync.test.ts test/shares.test.ts
   92 pass
   0 fail
   981 expect() calls
   Ran 92 tests across 4 files. [10.56s]
   ```

   The four files are the ones this slice's changes sit in: the host's route tests, the new e2e
   (`test/assign.test.ts`, 3 tests), the sync loop whose deps gained the read, and K4–K7's e2e (the
   receiver path an `assign` share travels). The other files are the peers' and are not run here.

   `test/personal.test.ts` was run too, because it crosses `backend/main.ts`'s import (the dynamic
   one that stubs `tjs:sqlite`), which is what proves the `HOST_WRITES`/`ADMIN_ONLY` additions and
   the three handlers leave that file loadable: `26 pass, 0 fail`.

2. **This slice's own two files**, as the first green observation:

   ```
   $ bun test test/assign.test.ts host/shares.test.ts
   23 pass
   0 fail
   641 expect() calls
   Ran 23 tests across 2 files. [9.67s]
   ```

   (23 = the 3 new tests plus the host file, which carries two tests added by the K1/K2 slice's
   `GET /v1/keys/private` work while this slice ran.)

3. **A scratch parse probe of the page** (not the project gate, and not a typecheck: `bun build`
   strips the types and only proves the file is syntactically whole; the output went to `/tmp`, never
   into the repo):

   ```
   $ bun build src/settings.ts --target=browser --outfile=/tmp/omp-settings-parse-check.js
   Bundled 6 modules in 10ms
   ```

   `src/settings.ts` is imported by no test file, so this is the only check the slice could run over
   its half of the Vault tab.

4. **Not run**: `bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter.

## For other owners

- **Coordinator**: decision 2 of `docs/handovers/k3-host-shares.md` is resolved by this slice (the
  `assign` + `role` reading); its "K6/K8: `kind: 'assign'` needs scope `org`" line is now stale and
  should not be carried into the next handover chain. Findings 2–4 above are worth a word.
- **K10 (events)**: nothing here raises an event; a `share.sent` / `share.assigned` event for the
  admin's seal is still K10's.
