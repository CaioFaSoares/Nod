# Block 2 review, second pass (Block2Review, 01-orchestration-reviewer)

Evidence: `leitura` only. Base: block 2 uncommitted on `a73a33e`, branch `nod-0.3.5`. Every path below was opened in this pass; nothing is cited from memory or from another agent's summary. No suite, typecheck or smoke was run (phase rule).

Verdict: **challenge** — all 16 first-review findings are closed (part 1), but two reachable defects remain in the assign/delete paths (part 2), and three of the fixes left small holes behind them (part 3).

## 1. First-review findings: all 16 closed

**H1 — second owner holder.** Closed on both sides. `host/repo.ts:1842-1844` refuses `send`/`assign` from a non-live holder once the credential has rows (`if (senderHolder === null) throw new ForbiddenError('not a holder')`), `:1815-1817` pins the tool (`409 credential belongs to another tool`), `:1964-1969` writes the owner row only `if (holders.length === 0)`, and `host/routes/shares.ts:74` is `t.Array(shareItemBody, { minItems: 1, maxItems: 500 })`. On the Nod, `backend/shares.ts:435-439` (`isLiveOwner`), `:924` (`const silent = share.kind === 'update' && held && isLiveOwner(share.credentialId, share.from)`) and `:838` (`if (!isLiveOwner(share.credentialId, share.from)) continue;`) keep every non-owner `update` in the gated inbox.
- The residual variant I looked for — claiming the *unclaimed* owner row while a share is pending — is not reachable: the owner row is written by the same transaction that creates the first share (`host/repo.ts:1964-1969`), `createShares` is one transaction that validates every item before writing any row (`:1856-1857`, `:1797`), and `removeHolder` refuses the owner row (`:2148`, `409 the owner cannot be removed`). A share therefore cannot exist while no holder row does.

**M1 — password change and the host blob.** Closed. `backend/main.ts:1572-1578` reads the old `vaultKey` and `keys?.beginReseal()` before `changePassword` (`:1581`), `:1590` calls `reSeal(previousVaultKey, keysConnection())`. `backend/keys.ts:561-565` writes the mark, `:572-574` clears it, `:703-706` clears it when `PUT /v1/keys` lands, `:729-732` makes `mine` answer `pending`, `:802-805` republishes although the public halves match, and `:849-886` accepts a value the session already moved (`openPrivateKeys(vaultKey, aad, stored)` fallback). The pair's own keychain value rides in the session's own batch: `backend/session.ts:944-952` passes `[{ key: keysKey(person.id), aad: keysKey(person.id) }]` into `backend/vault.ts:309-315`, whose `extra` loop (`:334-345`) opens first and writes with the `planned` pass; an unopenable extra is skipped, as documented at `:302-307`.

**M2 — `accept` no longer destroys a good share.** Closed. `backend/shares.ts:933` (`if (own === null) throw new Error(NO_KEY_PAIR)`), `:937` (`if (pinned === null) throw new Error(NO_PINNED_KEY)`) refuse without declining, and `:938-939` records that a `changed` sender is still verified with the pinned key: the open at `:943-951` uses `fromBase64url(pinned.ed25519)` with no `status` short-circuit, and only a real `open`/`match` failure reaches `declineInvalid` (`:955`, `:974-981`).

**M3 — the gate on machines with biometrics.** Closed. `backend/main.ts:934-942` (`gateFactor`: `if (biometrics) return typed && devRun ? 'password' : 'biometrics'`) and `:955-963` (where the capability exists, `app.authenticate` is what runs). The page no longer keys on `session.biometric` alone: `src/settings.ts:1993-1996` (`if (state.info.biometricAvailable && !state.info.devRun) { void run(undefined); return; }`). The dev exception is a build-mode stamp read once (`backend/main.ts:699-706`), written by `scripts/gen-config.ts:308` and deliberately kept out of the release list (`:120-123`); the stamp is only ever `dev` for the exact text (`shared/build-mode.ts:23-26`), pinned by `test/gate.test.ts:41-48`.

**M4 — `blocked` and scope changes reach the host.** Closed. `host/routes/shares.ts:209-225` is `PUT /v1/credentials/:id/scope` (owner or admin, `shared/host-api.ts:90`, `backend/host-client.ts:699-703`), `host/repo.ts:2156-2175` writes the scope to every holder row, `:1806-1811` refuses the whole request for a `blocked` owner row, and `:1937-1939` derives the allowed breadth from the owner row (`SCOPE_BREADTH` at `:229`). The Nod calls the route before storing locally when the credential has rows (`backend/shares.ts:1333-1337`).

**M5 — revoked holders.** Closed. `host/repo.ts:1843-1844` refuses a removed sender, `:1874-1884` refuses a revoked recipient unless the sender is the owner or an admin, `:2079-2095` keeps `removed_at` for a share that is not from the owner/admin (`removed_at = CASE WHEN ? = 1 THEN NULL ELSE credential_holders.removed_at END`), and `:2257-2281` excludes any holder row — removed included — from the missing list.

**M6 — a direct assignment that sent nothing.** Closed. `backend/main.ts:2789`-side contract is `{ sent, skipped }` (`shared/types.ts:816-819`), `backend/shares.ts:1287` throws the key-state reason (`if (result.sent === 0) throw new Error(sealSkipReason(me, target))`, `:1111-1123`), and the dialog reports skips (`src/settings.ts:2763-2769`).

**M7 — the admin's list of every credential's holders.** Closed. `backend/holders.ts` builds the rows, `backend/main.ts:552-573` assembles the lookups, `:778` puts `holders.list` in `ADMIN_ONLY` and `:2789` wires the handler; the page reads it with the Vault tab for an admin (`src/settings.ts:977`) and renders the card (`:2098-2130`, mounted at `:2547-2548`). `Holder.toolId` now exists (`shared/host-api.ts:684-691`, `HOLDER_COLUMNS` at `host/repo.ts:693-694`).

**M8 — the `TINYJS_DEBUG` list.** Closed. `AGENTS.md:48-55` now names `vault.reveal`/`vault.copy`, `shares.send`, `shares.accept`, `assignments.set`, `assignments.sealMissing`, `vault.exportToFile`/`vault.importFromFile` and `session.enableBiometric`, and `backend/context.md:55-56` points at that list instead of repeating a stale one. No handover section records this fix (traceability gap only).

**L1–L7.** Closed. L1: `backend/shares.ts:108`, `:461-464` (a mark that never moves back), `:976-981` (an older `issuedAt` declines), `:1017-1018`. L2: `backend/keys.ts:993-1001` refuses anything but the stored `pendingFingerprint` (`if (pending === null || pending !== fingerprint) throw new Error(PEER_KEY_MOVED)`). L3: `stripSettledSealed` (`:473-503`) at every settle point (`:904`, `:1020`, `:1034`). L4: `serialized` per share id (`:508-517`, used at `:910-912`). L5: `src/settings.ts:653`, `:2577-2595` (wall-clock deadline) and `:4037-4042` (`visibilitychange` → `hideRevealed`). L6: `:625`, `:1267`, `:1289` persist the generated uuid only after the host answered. L7: `host/repo.ts:1819-1832`, `:1860`, `host/routes/shares.ts:52-57` (64 KB) and `:74`.

## 2. Defects found in this pass (both pre-existing; neither introduced by the fixes)

### F1 (MEDIUM) — the missing-copy list can carry a member the host itself refuses, and that one member blocks the whole assign

`host/repo.ts:2257-2281` lists "every current member of the assigned role who has keys, is not the admin who assigned, and has no holder row". It filters clients (`:2266-2272`) but has no grant filter, while `createShares` refuses any recipient without an org grant: `host/repo.ts:1896-1897` `if (!granted) throw new ForbiddenError('tool not visible to recipient')`. One refused item fails the whole request (`:1856` "Every item is validated before a single row is written, so a wide request fails whole", `:1797` `runInTransaction`), and the Nod sends one request per credential (`backend/shares.ts:1141-1160`, `:1186-1195`), with no per-group catch. The admin can pick any role (`src/settings.ts:2250-2257` lists `state.roles`), and `missingRows.filter((row) => row.credentialId === credentialId)` (`backend/shares.ts:1271-1279`) mixes the members of *every* role assigned that credential into that one request.

*Why it is a defect:* SP06 §5's "granted the tool" rule holds for `kind: 'assign'` too ("Every other rule of the table holds for every kind"), so an un-granted member of the assigned role is not an eligible recipient and must not be in the list — the same reasoning already applied to clients in the query's own comment. Reachable through the UI: assign tool X (granted to `team`) to role `ops`; every member of `ops` is listed as missing, and every Assign/Seal press answers the host's `403 tool not visible to recipient` and seals nothing — including to the `team` members in the same credential's group. `host/shares.test.ts:271-277` grants the tool to both fixture roles, so this case is untested.

*Fix:* add the grant predicate to `missingCopies` (`EXISTS (SELECT 1 FROM entries e JOIN grants g ON g.entry_id = e.id JOIN person_roles pr ON pr.role_id = g.role_id WHERE e.id = a.tool_id AND pr.person_id = p.id AND e.scope = 'org')`), and make `sealAssigned` count a refused group as skipped instead of aborting the rest.

### F2 (MEDIUM) — an org tool that was ever shared cannot be removed: the delete fails with a foreign-key error and the API answers 500

`host/migrations.ts:141` declares `tool_id TEXT NOT NULL REFERENCES entries(id)` on `shares` (no `ON DELETE`), `:158` declares `credential_holders.tool_id … ON DELETE CASCADE`, and `:205` sets `PRAGMA foreign_keys = ON`. `removeOrgTool` is a bare parent delete: `host/repo.ts:1379-1383` `db.query("DELETE FROM entries WHERE id = ? AND scope = 'org'").run(id)`. SQLite's default for a child reference is NO ACTION, so the statement aborts (nothing cascades, nothing is deleted) and `host/app.ts:103-112` maps a non-`RepoError` to `status(500, { error: 'internal error' })`. Reachable: the admin's Nod wires `catalog.remove` to it (`backend/main.ts:2207-2211` → `backend/host-admin.ts:163-166` → `DELETE /v1/admin/tools/:id`, `host/routes/admin.ts:347-350`). Every test deletes a tool with no shares (`host/admin.test.ts:672-681`, `host/repo.test.ts:697-700`).

*Why it is a defect:* a documented admin action (Settings → Catalog → remove a tool) fails with an internal error and a `console.error` line for any tool whose credential has ever travelled. It also *guards* the H1 fix: that FK is the only reason a share row cannot outlive its tool, so the owner row can never cascade away while a share still names the credential.

*Fix:* refuse with a typed error in `removeOrgTool` when a `shares` row references the tool (for example `409 a shared credential keeps the tool`), and leave the FK as it is. Adding `ON DELETE CASCADE` to `shares.tool_id` instead would repeal F2's guard and re-open, for any machine that still holds the credential locally (`vault_item.credential_id` survives on every holder's Nod), the state the H1 fix rests on — a credential with no holder row, whose owner row the next `send` claims (`host/repo.ts:1964`).

## 3. Small holes left by the fixes themselves

### F3 (LOW, introduced by M1) — a refused password change leaves the reseal mark set

`backend/main.ts:1578` marks before `changePassword` is even asked to validate: the mark is written at `:1578` and the call at `:1581` is what rejects a wrong current password (`backend/session.ts:907-920`) or a host refusal (`:930-937`). Nothing clears the mark on those paths, so `backend/keys.ts:729-732` makes Settings → Account answer `pending` with `your key is not on the guild yet — it goes out at the next sync` (`:95`) until the next unlock republishes the blob (`backend/main.ts:1229-1230` → `ensure` branch (a), `backend/keys.ts:802-805` → `publish` → `clearReseal`). Self-healing, but the card lies in the meantime.
*Fix:* call `beginReseal()` after the local validation (or clear the mark when `changePassword` throws).

### F4 (LOW, introduced by M4/L6) — a scope set while the cache has no holder row never reaches the host, and nothing retries it

`backend/shares.ts:1333-1337` calls `setCredentialScope` only when `holdersOf(item.credentialId).length > 0`, and `holdersOf` reads the cached snapshot (`:395-400`). Unlike the update flow — which has `readPendingUpdates`/`retryPending` (`:637`, `:807-818`) called on every run (`backend/main.ts:337-341`) — the scope has no pending marker: `deps.repo.setVaultScope` (`:1339`) is the only other write. So when the cached snapshot predates the credential's first holder row (a send is a direct write, `:617-625`, so a sync failure right after it leaves the cache without the row), the local item says `blocked` while the host's owner row stays `role`, permanently; another machine of the same person, or a modified client, can still send under the old scope — the M4 class the review closed on the host side.
*Fix:* a `shares.scope.pending.<credentialId>` marker retired by the sync (the `retryPending` pattern), or call the host whenever the item has a `credentialId` and a connection and treat a `404 unknown credential` as "not on the host yet", keeping the local write.

### F5 (LOW, introduced by M6) — the assign dialog reports success for a role assignment that sealed nothing

`src/settings.ts:2763-2769` only branches on `result.skipped > 0`; `backend/shares.ts:1271-1279` returns `{ sent: 0, skipped: 0 }` whenever the host's missing list has no row for that credential (every current member already holds a copy, or the only one was revoked — canonico §22), and the dialog then says `Assigned — copies sealed to the members`.
*Fix:* branch on `result.sent === 0` as well.

## 4. The M3 question: can a release report `devRun` true?

No, through either documented path: `scripts/gen-config.ts:220` narrows the release's `"resources"` list (`:119-123`, `buildResources`) and keeps `build-mode` out of it, `:308` writes the stamp as `build` for a release, and the tinyjs rule is "`"resources": [...]` lists paths inside it to ship only those … Ships whole by default" (`.agents/skills/tinyjs/references/release.md:12-21`); `stampMode` fails closed on anything but `dev` (`shared/build-mode.ts:23-26`). Both callers go through `gen-config build`: `package.json:10` (`app:build`) and `.github/workflows/release.yml:127`. The one gap is off-path: a `tinyjs publish` run without `gen-config build` after `bun run app:dev` would use the dev config (no `"resources"` key → the whole folder ships, `release.md:12`) together with the stamp the dev run wrote (`dev`, `:308`), and that release would report `devRun` true. Nothing in the repo does that; `docs/distribuicao.md:29-36` prescribes `bun run app:build`.

## 5. Issues #23–#38 acceptance

No unimplemented bullet beyond the four the first review listed, and each of those is now covered: #33 bullet 1 (`src/settings.ts:1993-1996` + `backend/main.ts:934-942`, `test/gate.test.ts:9-46`), #35 bullet 1 second clause (`holders.list`, `src/settings.ts:2098-2130`), #34 bullet 1 host half (`host/repo.ts:1806-1811`, `:1937-1939`, `:2156-2175`), and #36 bullet 1 with the caveat F1 states — the role assignment reaches every *eligible* current member (granted the tool, keys published, not the assigner, not a client — `host/repo.ts:2257-2281`), and the ineligible case is exactly where F1 makes it fail loudly. #24's added warning bullet is implemented (`src/app.ts:459-460`, `:799-800`, `backend/tool-windows.ts:44-48`), and #28's read-only banner is `src/app.ts:883-887` over `HostState.updateRequired` (`backend/sync.ts:141-145`, `:599-600`).

## 6. What could not be answered

- `paths.resources` in a *packaged* app is taken from the runtime's own documentation, not observed here (§4): the conclusion rests on `.agents/skills/tinyjs/references/release.md:12-21` plus `gen-config build` being the only release path in the repo.
- F1's and F2's consequences are read from code: I did not execute the two HTTP sequences that would show them (assign to an un-granted role; `DELETE /v1/admin/tools/:id` for a shared tool). `bun test host/` with those two cases would prove them.
- `test/smoke/` (the two-instance smoke, #38) was not run, so its `ACCOUNT_PASSWORD` path through the dev exception is read, not observed.

**challenge**

## Second review fixes

Host half of F1 and F2 (owner: HostFix2, `nod-0.3.5`, block 2 uncommitted). Every code line and every
path below was opened in this pass; every test line was executed.

### F1 — `missingCopies` carries the grant predicate

- **Fix:** `host/repo.ts:2295-2298` — the query gains `AND EXISTS (SELECT 1 FROM grants g JOIN
  entries e ON e.id = g.entry_id JOIN person_roles prg ON prg.role_id = g.role_id WHERE e.id =
  a.tool_id AND e.scope = 'org' AND prg.person_id = p.id)`, the same rule `createShares` applies at
  `host/repo.ts:1897-1906`. The grant is read from the person's own roles, not from the role being
  assigned, so a member granted through another role stays listed. `host/repo.ts:2277-2280` records
  why: SP06 §5's "granted the tool" holds for `kind: 'assign'` too, and one refused item fails the
  whole request.
- **Test:** `host/shares.test.ts:1454-1489`, `an assignment to a role the tool is not granted to
  lists nobody (F1)`. `kalendar` is granted to `other` only; assigning it to `team` (Alice, Bob,
  Dana, all with keys) answers `[]`, and the same tool assigned to `other` answers `[cara]` — the
  emptiness is the predicate, not a query that answers nothing.
- Out of this slice: the second half of the review's F1 fix (`sealAssigned` counting a refused group
  as skipped).

### F2 — `removeOrgTool` refuses with a typed `409`

- **Fix:** `host/repo.ts:1379-1392` — one `SELECT 1 AS one FROM shares WHERE tool_id = ?`; a row
  throws `ConflictError('a shared credential keeps the tool')` before the parent delete, so the route
  answers `409` instead of the `500 internal error` the FK abort produced. `shares.tool_id` keeps its
  plain reference (`host/migrations.ts:143`, no `ON DELETE`), which is the guard the H1 fix rests on.
  The route needs no change (`host/routes/admin.ts:347-350`; `host/app.ts:104` maps a `RepoError` to
  its own status).
- **Test:** `host/admin.test.ts:694-752`, `DELETE refuses a tool a share still names, and removes an
  unshared one (F2)`. A real guild — role `team`, tool `kanban` granted to it, a member with keys
  through `PUT /v1/keys` — and one real `POST /v1/shares` (`scope: 'org'`) leave the row; `DELETE`
  answers `409 { error: 'a shared credential keeps the tool' }` and `listOrgTools()` still holds
  `kanban`; a second tool no share names answers `204`.
- **Doc:** `docs/specs/SP03-host-api.md:103` (`204`; `409` while a share still names the tool),
  `:37` (the message joins the 409 list of §1) and `:131` (the missing list reads "members of an
  assigned role the tool is granted to, without a copy").

### Commands and observed results

Failing before the fix — both hunks temporarily reverted, then restored exactly:

```
$ bun test host/shares.test.ts -t 'not granted to lists nobody'
(fail) assignments > an assignment to a role the tool is not granted to lists nobody (F1)
 0 pass / 1 fail — the list carried the three un-granted `team` members

$ bun test host/admin.test.ts -t 'a share still names'
nod host: unexpected error on DELETE /v1/admin/tools/kanban
error: expect(received).toBe(expected) Expected: 409 / Received: 500
 0 pass / 1 fail
```

Passing after:

```
$ bun test host/shares.test.ts -t 'not granted to lists nobody'   → 1 pass, 0 fail
$ bun test host/admin.test.ts -t 'a share still names'            → 1 pass, 0 fail
$ bun test host/shares.test.ts                                    → 27 pass, 0 fail (830 expect)
$ bun test host/admin.test.ts                                     → 21 pass, 0 fail (257 expect)
```

Not run, per the phase rule: typecheck, the whole suite, formatters, smokes. No file outside
`host/repo.ts`, `host/shares.test.ts`, `host/admin.test.ts` and `docs/specs/SP03-host-api.md` was
touched.


### Nod half of F1, F3, F4 and F5 (owner: NodFix2)

Scope: `backend/shares.ts`, `backend/main.ts` (`session.changePassword` only), `backend/keys.ts`
(expose `clearReseal`), `src/settings.ts` (assign dialog only), `test/shares.test.ts`,
`test/keys.test.ts`. No file outside these was touched.

**F1 (second half) — a group the host refuses is skipped, the others still travel.**
- **Fix:** `backend/shares.ts:1181-1216` (`sealAssigned`). `sent` is no longer counted as each copy is
  sealed; it is counted per group, after `connection.sendShares` takes the request. The group loop
  gained a `try/catch`: a `HostError` with a status (the host's whole-request refusal, e.g. `403 tool
  not visible to recipient`) adds the group's items to `skipped` and the loop continues with the
  next group. A network failure (`HostError.status === null`) or any other error still aborts, so the
  admin can retry the seal.
- **Test:** `test/shares.test.ts:1598-1625`, `a credential the host refuses is skipped, and the
  others still travel (F1)` — the fake connection's missing list carries two credentials;
  `sendShares` refuses the `kalendar` one with a `403`. `sealMissing()` answers `{ sent: 1, skipped:
  1 }`, only the `figma` request went out, and only its `share.sent` event was written.

**F3 — a refused password change clears the reseal mark.**
- **Fix:** `backend/keys.ts:239-245` adds `clearReseal(personId)` to the `Keys` interface (`:1034`
  returns it; the internal `clearReseal` is unchanged). `backend/main.ts:1581-1599` wraps the
  `session.changePassword` call: on a throw (a wrong current password, or a host that would not take
  the new `authKey`) it clears the mark before rethrowing — the vault never moved and the host's blob
  is not stale, so `keys.mine` stays `ok` instead of answering `pending` until the next unlock.
- **Test:** `test/keys.test.ts:935-953`, `a refused password change clears the stale mark, so mine
  stays ok (F3)` — `beginReseal()` makes `mine()` answer `pending`; `clearReseal(personId)` returns it
  to `ok` with nothing republished.

**F4 — a scope with a credentialId reaches the host; a network failure is pending.**
- **Fix:** `backend/shares.ts:1416-1445` (`setScope`) calls the host whenever the item has a
  `credentialId`, keeping the cheap cached-snapshot owner check only while the cache still shows a
  holder row. New `pushScope` (`:815-878`) treats `404 unknown credential` as "not on the host yet"
  (the scope stays local and travels on the first send), rethrows any other refusal, and leaves a
  `shares.scope.pending` marker (new constant `:110-117`) on a network failure or with no connection.
  `retryPending` (`:881-907`) now iterates that marker on every sync, beside the pending updates.
- **Tests:** `test/shares.test.ts:1465-1515` — an offline set then `retryPending` reaches the host and
  clears the marker; a network failure leaves the marker and the next-sync retry lands it; a `404`
  keeps the scope local with nothing pending. The updated `test/shares.test.ts:1446-1463` now expects
  the host call for a credentialId whose cache has no holder row.

**F5 — the assign dialog branches on `sent === 0`.**
- **Fix:** `src/settings.ts:2766-2776` — a role assignment that sealed nothing answers `Assigned — no
  member needed a copy` (or `Assigned — no copy was sealed, N skipped`) instead of reporting copies
  that never went.
- **Test:** none — `src/settings.ts` has no test harness; the page module is not driven by the suite.

### Commands and observed results

```
$ bun test test/keys.test.ts                         → 42 pass, 0 fail (226 expect)
$ bun test test/shares.test.ts                       → 47 pass, 0 fail (191 expect)
$ bun test test/shares.test.ts -t F1                 → 1 pass, 0 fail
$ bun test test/shares.test.ts -t F4                 → 4 pass, 0 fail
$ bun test test/keys.test.ts -t F3                   → 1 pass, 0 fail
$ bun test test/shares.test.ts test/keys.test.ts     → 89 pass, 0 fail (417 expect)
```

Failing before the fix: F4's offline test found no `shares.scope.pending` marker (`setScope` skipped
the host entirely for a credentialId whose cache had no holder row); F1's test rejected out of
`sealMissing` (the refused group's `HostError` propagated and aborted the other group); F3's test
found no `clearReseal` on `Keys`. Not run, per the phase rule: typecheck, the whole suite,
formatters, smokes.
