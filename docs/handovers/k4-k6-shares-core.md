# Slice K4 + K6 + K7 (Nod backend) — send/accept/decline, the sharing scope and the holders

Authorizing issues: **#32** (K4, send/accept/decline + vault inbox), **#34** (K6, scope
role/blocked/org), **#35** (K7, holders list) and the backend half of **#33** (K5, the gate on
reveal/copy/accept/send). The issue copies are `/tmp/nod/issue-32.md` … `-35`. Epic #3 (E02 —
credential sharing), Block 2 ("Mine and shared" — `docs/epics/blocks.md`). Requirements: RF-44,
RF-45, RF-46, RF-53, RF-54.

Contracts followed: `docs/specs/SP06-credential-sharing.md` §3 (the sealed payload, the five opening
steps, "any failure declines with `invalid share`, no partial state"), §4 (send, accept, decline, the
update that skips the gate, the owner becoming a holder), §5 (the scope table, "never wider", clients
never receive an `org` share and `blocked` accepts nothing); `SP02-auth-and-keys.md` §9 (the gate),
§6/§8 (the verifier and the `bv1.` vault); `SP04-sync.md` §2 (`people`, `incomingShares`, `holders`,
`rotationPending`); `SP03-host-api.md` §3 (`POST /v1/shares`, `/:id/accept`, `/:id/decline`);
`AGENTS.md`, `backend/context.md`, `shared/context.md`.

Nothing here is a secret: a payload is sealed before it leaves the process, the host stores base64url
it cannot read, and no error, log, event or `store.json` entry carries a username, a secret, a sealed
body or a key.

## Files touched

| File | What changed |
| --- | --- |
| `backend/shares.ts` | **New.** K4/K6/K7: the pure `scopeDecision` (§5: `role` = common role **and** the org tool granted to one of the recipient's roles; `org` = granted `member`; `blocked` = nobody), the pure `shareMatches` (§3 step 4 against the host's metadata), `recipients`, `send` (gate → vault read → scope → pinned pair per recipient → one `seal` each → `POST /v1/shares`), `inbox` (snapshot metadata + roster names + catalog titles), `accept` (gate except an update of a held credential; the five §3 checks against the **pinned** sender key and the catalog origin; the vault copy; `acceptShare`; the previous item restored when the host refuses), `decline`, `setScope` (owner-only once the credential travelled) and `decorate` (snapshot `holders`/`rotationPending` onto `VaultItem`). English reasons only: `invalid share`, `blocked credential`, `recipient key changed`, `recipient has no pinned key`, `no role in common`, `tool not visible to recipient`, `org shares go to members only`, … |
| `backend/keys.ts` | `OwnPrivatePair` and `Keys.ownPrivate()` — the private halves opened from the `bv1.` value under `nod.keys.<person>` plus the public halves from `meta`. It is the one addition the sender (sign) and the opener (derive + salt) need, and it refuses instead of guessing while locked or after a store that does not open. |
| `backend/repo.ts` | **Migration 5**: `vault_item.credential_id` and `vault_item.scope` (`TEXT NOT NULL DEFAULT 'role'`) in `SCHEMA` and in `addColumns`, the `vault_item` rebuild carrying both, `SCHEMA_VERSION = 5`, `KNOWN_VERSIONS` gains `4`. `VaultItem` built with the two new fields; `saveVaultItem` takes optional `credentialId`/`scope` and keeps the stored ones on a conflict; `setVaultCredential`, `setVaultScope` and `setVaultSharing` (the accept rollback, `NULL` included). |
| `backend/vault.ts` | `save` carries `credentialId`/`scope` into the index row (the accept path). Nothing else: the value stays a `bv1.` keychain item under the same AAD. |
| `backend/host-client.ts` | `HostConnection.sendShares` (`POST /v1/shares`), `acceptShare(id)`, `declineShare(id)` — the three routes of SP03 §3, bearer included, no body echoed. |
| `backend/main.ts` | `shares` built beside the vault and the keys (catalog and connection read at call time; `connection` is `null` while the O2 gate is up). `vault.list` decorated with holders/rotationPending; `vault.reveal` and the new `vault.copy` (runtime `clipboard.write`, the secret never returned) go through the new K5 `authenticate`; `vault.setScope` and the five `shares.*` handlers. `HOST_WRITES` gains `shares.send`/`shares.accept`/`shares.decline`. `authenticate(reason, password?)` = `app.authenticate` where this machine has biometrics, else the unlocked person's verifier (`verifyStoredPassword`), with `authentication required` / `authentication cancelled`. |
| `shared/types.ts` | The block 2 contract, already in the file from SharesUI (VaultItem fields, `ShareRecipient`, `InboxShare`, the eight methods). Re-read before every edit; nothing re-added. |
| `test/shares.test.ts` | **New.** The scope decisions, the seal/open round trip through `shared/seal.ts` (tampered signature, wrong recipient, wrong sender key), `shareMatches` for every mismatching field, the accept paths (valid, origin mismatch, tampered bytes, foreign credential, foreign recipient, changed sender key, cancelled gate, update-held skip, rollback of a failed accept), send/recipients (pinned vs unknown vs changed key, role without a common role, blocked, personal tool, the payload Bob can open and the key that cannot), and the end-to-end against the real host app (below). |
| `test/repo.test.ts` | Migration 5 assertions: the fresh database is v5 with both columns, a v4→v5 test (item kept, `credentialId` null, `scope` `role`), LATER_COLUMNS and the version probes moved off 4. |
| `test/sync.test.ts`, `test/keys.test.ts` | Their `HostConnection` doubles gained the three new members (no-ops: neither story sends a share). |
| `backend/context.md`, `shared/context.md` | The module rows of `shares.ts`/`keys.ts`/`repo.ts`/`vault.ts`/`main.ts`, the block 2 types, the new "Shares" rule, and the block 2 status paragraph (K8–K10 still to come). |
| `docs/handovers/k4-k6-shares-core.md` | This file. |

**Not edited on purpose**: `shared/host-api.ts` (block 2 types and `HOST_ROUTES` were already in from
K3), `shared/seal.ts`, `host/**` (the routes and the scope checks landed with K3), `backend/session.ts`
(VaultFinish's this phase; the gate reads the verifier through `repo.personAuthByEmail` and never
touches the session's internals), `src/**` (SharesUI's half).

## Acceptance — how each item is met

`execucao` = run and observed; `leitura` = read from the code and the specs. Command:
`bun test test/shares.test.ts` (27 tests, all green) and `bun test test/repo.test.ts`.

### #32 — K4

| Item | How | Evidence |
| --- | --- | --- |
| Alice sends Bob a login; a dump of `host.db` contains no username or secret | `shares.send` seals one payload per recipient with the sender's Ed25519 key and `POST`s `{ credentialId, toolId, scope, kind, items }`; the test asks the real host app and dumps every table of its database | `execucao` (`test/shares.test.ts` → "Alice sends, the host keeps no credential value, Bob accepts, both list both holders": `dumpHost` does not contain `credentialuserzq7` nor `secretvaluezq7`) |
| Bob sees it in the inbox, accepts after the gate, and the item lands in his vault bound to the tool's origin | `shares.inbox` reads the snapshot's `incomingShares`; `shares.accept` opens with Bob's own pair and the pinned Alice key, checks credential/tool/kind/scope/`to` and `originOf(entry.url) === payload.toolOrigin`, saves the item with `origin`, `credentialId` and `scope`, then `POST /v1/shares/:id/accept` | `execucao` (same test: inbox row with `toolTitle: 'Figma'`, `fromName: 'Alice'`; accept → `vaultOrigin === 'https://figma.example.test'`, value read back; the host's `credential_holders` has Alice owner and Bob) |
| A share failing any check of SP06 §3 is declined as `invalid share` | Every failure path calls `declineInvalid`: the host gets `POST /:id/decline` (best effort) and the caller gets `invalid share`; nothing is written to the vault (the checks run before the save) | `execucao` (unit: origin mismatch, tampered signature, foreign credential, foreign tool, wrong recipient, changed sender key, missing pair; end-to-end: the cached sealed body is flipped and the host row ends with `declined_at` set) |

### #34 — K6

| Item | How | Evidence |
| --- | --- | --- |
| A `role` credential can't be sent to someone with no common role, by the Bond nor the host | `scopeDecision` requires a common role and the grant; `send` refuses with `no role in common` before any request, and the host's `createShares` repeats the check on its own rows (K3, `host/repo.ts`) | `execucao` (unit: "a role share to somebody with no common role is refused before any request", no request recorded; end-to-end: the same refusal against the real host) |
| A `blocked` credential has no send action; `org` reaches every member granted the tool, never clients | `item.scope === 'blocked'` refuses the send and `scopeDecision` allows nobody; `org` needs `kind === 'member'` plus the grant, so a client is refused with `org shares go to members only` | `execucao` (unit: "blocked credential", "org: every granted member, never a client"; end-to-end: `setScope('blocked')` then a refused send) |

### #35 — K7

| Item | How | Evidence |
| --- | --- | --- |
| After Alice sends Figma to Bob, both see "Alice, Bob" with date and scope | `shares.decorate` puts the snapshot's `holders[credentialId]` (name, owner, scope, `since`) on every `VaultItem` of `vault.list`, and `rotationPending` when the id is listed | `execucao` (end-to-end: both Nods' `vault.list` name `Alice` and `Bob`, every `since` filled; the host's `holdersOf` says the same) |
| The admin sees holders of every org credential | The host's snapshot already carries `holders` for an admin (K3/SP04 §2); the Nod decorates whatever the snapshot holds | `leitura` (the Nod adds nothing that would filter an admin's rows; the host's own read is K3's and is tested there) |

### #33 — K5 (backend half)

| Item | How | Evidence |
| --- | --- | --- |
| Each action calls `app.authenticate` (password on Linux); cancelling shows/copies/accepts/sends nothing | `authenticate` is the one gate: biometrics where `system !== 'linux' && capabilities.authenticate`, else the unlocked person's verifier; it runs before the credential is read (`vault.reveal`, `vault.copy`), before the vault read (`shares.send`) and before the share is opened (`shares.accept`, except an update already held). `authentication cancelled` / `authentication required` are the two refusals | `execucao` (unit: a gate that throws leaves the vault empty, the inbox untouched and no request made, for both send and accept); `leitura` for the RPC wiring (see "What was left out") |
| A revealed secret shows a 10 s countdown and is cleared from the page at zero | Page-side (SharesUI); the backend only answers `vault.reveal` after the gate | `leitura`; not this slice |

## What was left out, and why

- **The page half of K4–K7** (Vault tab, inbox badge, the countdown): SharesUI's slice. `vault.reveal`,
  `vault.copy`, `vault.setScope` and the five `shares.*` handlers here are the backend it calls.
- **K8 (assignments), K9 (rotation re-seal), K10 (`share.*` events)**: later stories of Block 2.
  `accept` already handles `kind: 'assign'`/`'update'` when a share arrives; nothing here produces
  one.
- **The runtime surface**: `bun test` proved the module, the real host app and the real crypto; the
  Nod under tiny.js was not run, so `vault.copy`'s `app.clipboard.write` and the RPC guards are
  `leitura` only (`test/smoke/` is the place for that).
- **Typecheck/lint/format/smoke were not run** (the phase's process rule). Only `bun test` on the
  files this slice owns or touched.

## Open findings

- The host's `ShareRequest.scope` union includes `'blocked'`, but the Nod never sends it (the scope
  is refused before the call and the host refuses it too). Left as the wire contract's shape.
- `shares.decline` does not verify that the id is one of this Nod's open shares before calling the
  host; the host answers `404`/`403` and the client maps it to `the host refused the request`. Kept
  simple because `decline` is ungated and the host owns the rule.
- An accept for a tool this Nod cannot see is declined, but an *update* to a credential already held
  whose tool left the catalog is declined the same way (both sides of the same check, §3 step 5).
  If a later story wants updates to survive a tool removed from the snapshot, that check has to be
  relaxed there and only there.

## Review fixes

Block 2 review (`docs/handovers/block2-review.md`), Nod side of `backend/shares.ts` — H1, M2, M4,
M6, L1, L3, L4, L6. Every fix has a failing-before/passing-after test in `test/shares.test.ts`,
`test/rotation.test.ts` or `test/assign.test.ts`.

- **H1** (`backend/shares.ts` `accept`/`applyUpdates`) — an `update` is applied silently only when
  `share.from` is the credential's live owner holder in the verified snapshot (`holdersOf(...)` row
  with `owner: true`, `removedAt: null`). Any other sender's `update` waits in the inbox for the
  gated accept; `applyUpdates` skips it without prompting. Tests: "an update whose sender is not the
  live owner holder needs the gate", "applyUpdates never applies a non-owner update silently", "an
  update from a revoked sender ...".
- **M2** (`accept`) — `ownPrivate() === null` throws `the key pair is not available` and leaves the
  share; a sender with no pin throws `recipient has no pinned key` and leaves it; a sender flagged
  `changed` is still verified with the pinned (old) key. Only a real `open`/`match` failure declines
  as `invalid share`. Tests: "a locked keychain leaves a good share in the inbox", "a share from
  somebody this Nod never pinned is left in the inbox", "a changed sender key still opens a share
  signed with the pinned key", "a share signed by a key other than the pinned one declines".
- **M4** (`setScope`, `HostConnection.setCredentialScope`, `shared/host-api.ts`) — a credential with
  holder rows calls `PUT /v1/credentials/:id/scope` before storing locally; a credential with no
  holder row stores locally only. Tests: "only the owner holder changes the scope ..." (asserts the
  host call), "a never-travelled credential sets its scope locally".
- **M6** (`assign`, `shared/types.ts` `assignments.set`, `src/settings.ts` dialog) — a direct
  `personId` assignment that sealed nothing throws the key-state reason; the action answers
  `{ sent, skipped }` and the dialog reports the skips. Tests: "a direct person assignment with no
  pinned key raises the reason", plus updated role/person count assertions.
- **L1** (`accept`, `shares.appliedIssuedAt` meta row) — an `update` whose `issuedAt` is not newer
  than the last payload applied to that credential declines as `invalid share`. Test: "a replayed
  `update` older than the applied one declines".
- **L3** (`stripSettledSealed`) — an accepted or declined share drops its `sealed` from the cached
  `host` snapshot at once (the cached body is not re-verified; the signature is checked on receipt in
  `backend/host-client.ts`). Test: "an accepted share drops its ciphertext from the cached snapshot".
- **L4** (`serialized`, per-share in-flight map) — accepts of one share id run one at a time, so a
  concurrent sync run cannot double-apply or roll back. Test: "two concurrent accepts of one update
  apply it once".
- **L6** (`send`, `assign`) — a generated `credentialId` is persisted only after the host accepted
  (the sealed copies, or the assignment row), so a refused action leaves no orphan id and the scope
  stays settable. Tests: "a first send the host refuses leaves no credentialId behind", and the
  "never-travelled credential" scope test.

`vault.setScope` is now async (`Shares.setScope`): the RPC result stays `VaultItem`, and its handler
in `backend/main.ts` awaits it. `HostConnection` gained `setCredentialScope`; `assignments.set`'s
result changed to `{ sent, skipped }` (caller in `src/settings.ts` updated). No other caller was
missed (`grep createShares` over `test/` matches only the three files above).
