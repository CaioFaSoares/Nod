# Block 2 review (Block2Review, 01-orchestration-reviewer)

Evidence: `leitura` only. Saved by the orchestrator from the reviewer's output (the reviewer had no write tool).

**Verdict: challenge.** I found 1 high, 8 medium and 7 low findings, plus 4 acceptance bullets I could not find implemented.

## Findings by severity

### HIGH

**H1. Any member who knows a `credentialId` can become a second owner holder, then silently overwrite the credential on every holder.**
- Host, `host/repo.ts:1764-1767` and `:1859-1864`. `createShares` only checks the sender's holder state for `kind === 'update'`. For `send` and `assign` it does:
  ```ts
  if (senderHolder === null) { INSERT INTO credential_holders (…, owner, …) VALUES (?, ?, ?, 1, ?, NULL, ?) }
  ```
  The primary key is `(credential_id, person_id)` (`host/migrations.ts:154-165`), so a second `owner = 1` row for a different person is legal.
- The route also allows an empty batch. `host/routes/shares.ts:64` has `items: t.Array(shareItemBody)` with no `minItems`, so `items: []` still inserts the owner row.
- The attacker needs a pending or unaccepted share, or an assignment, of that credential. `credentialId` is in their snapshot's `incomingShares`. After sending any `send` for it to a third member who shares a role, they pass `kind === 'update'` (`:1765`), because the host treats them as owner.
- The attacker can then seal an arbitrary secret as `kind: 'update'` to every live holder. On each holder's Nod, `applyUpdates` (`backend/shares.ts:727-738`) calls `accept`, which skips the gate when `share.kind === 'update'` and the credential is held (`:808`). Nothing checks that `share.from` is the owner. The sender's signature is verified only against the attacker's own pinned key, and the host metadata matches.
- Result: the attacker's account is stored as the colleague's login for the real tool origin, with no prompt shown. They can also call `DELETE …/holders/:personId`.
- Fix on the host:
  - For `kind === 'send'`, require `senderHolder !== null && senderHolder.removedAt === null`. The only exception is a credential with no holder rows at all (first share).
  - Reject a request whose `toolId` differs from the existing holders' `tool_id`.
  - Add `minItems: 1` to `items`.
- Fix on the Nod: for a silently applied `update`, require `holdersOf(share.credentialId)` to list `share.from` as the live owner. Otherwise fall back to the gated inbox path.

### MEDIUM

**M1. A password change can leave the host blob sealed under the old `vaultKey` forever, and the failure is discarded.**
- `backend/main.ts:1494` does `await keys?.reSeal(previousVaultKey, keysConnection());` and ignores the returned `KeyStatus`.
- In `backend/keys.ts`, `publish` on failure only returns `report(pair, created, false, reason(error))` (`:642`). It sets no retry mark.
- Later `ensure` branch (a) at `:735` does `if (hosted.privateSealed !== null) return await report(local, false, false, null);`. Branch (a) only compares public keys, so the stale blob is never republished.
- Another machine signing in with the new password then hits `local === null`, an unopenable blob, and `refused(KEYS_UNAVAILABLE)` forever. That breaks SP06 §6 "a password change re-seals the blob".
- The same happens if the process dies between `changePassword` and `reSeal`.
- Fix: write a `keys.reseal.pending.<person>` meta mark before `changePassword`. Clear it only after `publish` succeeds. Make `ensure` republish while the mark is set. Return the `reSeal` status to the page.

**M2. `accept` destroys a share on conditions that are not "invalid".**
- `backend/shares.ts:814-816`:
  ```ts
  if (own === null) return await declineInvalid(me, connection, id);
  if (pinned === null || pinned.status !== 'pinned') return await declineInvalid(me, connection, id);
  ```
  `declineInvalid` calls `connection.declineShare`. The host then sets `sealed = ''` and `purged_at` (`host/repo.ts` `answerShare`), which is irreversible.
- So a transient keychain miss or locked key (`ownPrivate() === null`) destroys a good share. Merely clicking Accept while the sender is flagged `changed` also destroys it.
- SP06 §3 step 2 says to verify with the pinned key even when the snapshot key differs. For a share signed before the rotation, the open would succeed.
- Fix: in those two cases throw `NO_KEY_PAIR` / `RECIPIENT_KEY_CHANGED` without declining, and leave the share in the inbox. Only decline after `open` or `shareMatches` actually fails. For `changed`, still try `open` with the pinned key.

**M3. The gate does not call `app.authenticate` on machines that have biometrics but have not enabled the shortcut.**
- `src/settings.ts:1964`: `if (state.session.biometric) { void run(undefined); return; }`. That flag is "biometrics available and enabled for the last person" (`shared/types.ts:365`), not machine capability. Otherwise the UI shows a password prompt.
- `backend/main.ts:850-852`: a non-empty password always wins, so `app.authenticate` is skipped.
- Issue #33 bullet 1, SP02 §9 and the canonico "Biometric gate" decision all say "password where biometrics don't exist (Linux)".
- `docs/handovers/k10-smoke.md` §"The fix the smoke needed" records this as a deliberate choice, but it exceeds the owner decision.
- **Owner question:** is a password fallback acceptable on machines that do have biometrics, when the person never enabled the shortcut? If not, the UI should key on machine capability (`biometricAvailable`) rather than `session.biometric`.

**M4. `blocked`, and any scope change, never reaches the host.**
- The host blocked check at `host/repo.ts:1753-1756` reads `credential_holders … owner = 1 AND scope = 'blocked'`. Nothing writes that.
- `createShares` rejects `scope: 'blocked'` before any insert, so the owner row can never carry `blocked`.
- `vault.setScope` (`backend/shares.ts` `setScope`) only runs `deps.repo.setVaultScope`. `host/shares.test.ts:435` admits this: "no route writes that scope".
- Consequences:
  - SP06 §5 "host never accepts a share for that credentialId" and issue #34 are not enforceable on the host.
  - After the owner sets `blocked`, existing holders' Nods still hold `scope: 'role'` and can re-send.
  - A modified client can claim any `scope` on a re-send, because the host trusts the body.
- Fix: a route (or a field on `PUT /v1/keys`-style bodies) for the owner to set the credential's scope, which updates the holder rows. `createShares` should then derive the allowed scope from the owner row, not the body.

**M5. A revoked holder can send, and can be re-added by any holder.**
- `createShares` never checks `senderHolder.removedAt` for `send`, and never checks the recipient's removal state.
- `answerShare` (`host/repo.ts:1973`) does `ON CONFLICT … DO UPDATE SET … removed_at = NULL`. So holder Y can `send` to revoked X and X's accept undoes the revocation (RF-48).
- Separately, `missingCopies` (`host/repo.ts`, "A removed holder is missing again") re-lists a revoked member of an assigned role until the assignment is deleted.
- Fix: for `kind: 'send'`, reject a removed sender and a removed recipient unless the sender is the owner or an admin.
- **Owner question:** is re-listing a revoked role member in the missing list intended (K8 decision 1), or should revocation suppress it?

**M6. A direct person assignment reports success even when nothing was sent.**
- `backend/shares.ts:1117` does `await sealAssigned(me, [{ credentialId, toolId: input.toolId, personId }]);` and discards `{ sent, skipped }`. `assign` returns `true`.
- `src/settings.ts:2647-2651` then shows "Assigned — the copy is sealed to them" even if the target had an unpinned or `changed` key, a missing tool or a `blocked` credential. A person assignment has no row, so nothing tracks the miss.
- The credential id is also persisted (`:1075-1076`) before the gate and before any host success.
- Fix: return the counts and have the UI report `skipped`, or throw the key-state reason (`RECIPIENT_KEY_CHANGED` / `NO_PINNED_KEY`) when `sent === 0`.

**M7. The admin cannot see the holders of credentials they do not hold.**
- `host/snapshot.ts` carries `holders` for every credential when the caller is admin (`heldCredentials(me.id, me.admin)`).
- The only consumer is `decorate`/`holdersOf` over the admin's own vault items (`backend/shares.ts`). No RPC or view lists the rest (`grep holders backend/main.ts src/app.ts` finds none; `settings.ts:2016-2048` is the per-vault-item box).
- Issue #35 bullet 1, second half: "the admin sees holders of every org credential".
- Fix: an admin list (for example `holders.list` from `snapshot.holders`) with a Settings card.

**M8. AGENTS.md's `TINYJS_DEBUG` warning was not updated.**
- `AGENTS.md:48-52` still lists only `session.*`, `host.activate`/`host.signIn`, `vault.save`/`vault.reveal` and `invites.issue`. The params-carrying-password RPCs the block added are missing:
  - `vault.reveal` also now carries `password`; the response carries the secret.
  - `vault.copy`, `shares.send`, `shares.accept`, `assignments.set` and `assignments.sealMissing` are missing entirely.
- `backend/context.md:55-56` repeats the stale list.
- Older omissions, also carrying passwords: `session.enableBiometric`, `vault.exportToFile`, `vault.importFromFile`.
- Fix: add all of these to both lists. This was a stated requirement of the task.

### LOW

- **L1. Replay of a stale share is possible.** `issuedAt` is in the payload (`shared/seal.ts`) but `shareMatches` and `accept` never use it. A malicious host re-serving an old `update` sealed blob is applied silently and rolls the value back. The signature and AAD do not bind a sequence.
- **L2. `peers.confirm` is not bound to the fingerprint the person read.** `backend/main.ts:1924` and `keys.ts` `confirm` take only `personId` and promote whatever `pending_*` is stored then. A host changing the key again between display and click is confirmed unseen. Fix: pass the displayed `fingerprint` and refuse on mismatch.
- **L3. The cached snapshot keeps `incomingShares[].sealed` in the local `host` row.** It stays after accept until the next snapshot. This is ciphertext at rest, in SQLite and not `store.json`. Consider stripping `sealed` once accepted or declined. [INFERENCE on how long the row lingers.]
- **L4. Possible concurrent double `accept` of one `update`.** `applyUpdates` (`backend/shares.ts:727-738`) can race a second sync run. The loser's rollback (`:836-856`) restores `previousCredential` read before the winner saved. [INFERENCE: I did not confirm that sync runs are not serialized.]
- **L5. The reveal countdown is page-timer based.** `src/settings.ts:2470-2486` decrements a counter per `setInterval` tick, and `backend/context.md` itself says the page timer is throttled while hidden. A hidden window can keep the secret in the DOM beyond 10 s. Fix: store `expiresAt = Date.now() + 10_000`, compare on each tick, and clear on `visibilitychange`. No secret is retained after zero (`hideRevealed` nulls `state.revealed`) and `lock` clears it.
- **L6. After a failed first send, the owner can never set the scope.** `credentialId` is saved locally before the host call (`backend/shares.ts:473-474`). If the host then refuses, the item has a `credentialId` but no holder row. `setScope` then throws `OWNER_ONLY` because `holdersOf` returns `[]`. Fix: persist the id only after the host answers, or treat "no holder rows in the snapshot" as owner.
- **L7. Host input looseness.** `createShares` does not reject a share to oneself, does not check that the sender can see the tool, and has no cap on item count or label length (only the 256 KB body limit). The Nod blocks self-share, so this is host hardening only.

## Acceptance bullets not found implemented

- **#33 bullet 1** ("Each action calls `app.authenticate`, password on Linux"): partially. See M3.
- **#35 bullet 1, second clause** ("the admin sees holders of every org credential"): data reaches the Nod but no view exists. See M7.
- **#34 bullet 1, host half** ("`role`… can't be sent… by the host", with `blocked`): the host `blocked` state is unreachable. See M4. The role and common-role check itself is implemented at `host/repo.ts:1819-1835` (host) and in `scopeDecision`.
- **#36 bullet 1** ("reaches every current member"): clients and members with no published keys are not reached by design (`missingCopies`). The direct person path can no-op silently, as in M6.

I found no gap in the other bullets of #23–#38. The two I could not fully check are #28 (O2 version gate, read-only from cache) and #24 (offline outbox behaviour). I checked the host config and routes for #28 and the outbox wiring for #24, but did not trace the full behaviour.

## What passed, by reading

- **SP06 §3 opening steps 1–5 are all enforced.** The pinned Ed25519 key is used.
  - Step 1 and 2: split and verify in `shared/seal.ts:377-381`, with the pinned key passed at `backend/shares.ts:818-826`.
  - Step 3: derive and decrypt with the recipient's own public key at `shared/seal.ts:395-409`.
  - Step 4: `shareMatches` (`credentialId`, `toolId`, `scope`, `kind`, `from`, `to`).
  - Step 5: the effective-catalog entry exists, is not personal, and `originOf(entry.url) === payload.toolOrigin` (`backend/shares.ts:842-848`).
- **AAD and key order are right.** AAD is `credentialId|to`, taken from host metadata on open. `info` is `bond/share/v1`. The HKDF salt is `eph.public || recipient.x25519Public`.
- **Send and update seal to the pinned key.** `send` and `sealUpdate` seal to `peerKeyFor(...).x25519` and refuse `changed` or unknown.
- **Pin and key-sync rules hold.** First sight pins; a different key marks `changed`. `GET /v1/keys/private` is the caller's own row only. `Snapshot.people` carries public keys only. The host stores the blob opaquely.
- **RPC guards.** Every method except `login.report` is main-window only (`backend/main.ts` `guarded`). `assignments.*` is in `ADMIN_ONLY`; `shares.send`/`accept`/`decline`/`removeHolder` and `assignments.set`/`sealMissing` are in `HOST_WRITES`. The gate is called before the read in `vault.reveal`, `vault.copy`, `send`, `accept` (except a held `update`) and `assign`/`sealMissing`.
- **No logging or leakage found.** There are no `console`/`print` calls in the block-2 files. Share events carry ids, scope and kind only. `shares.inbox` returns metadata and never the sealed body.

I did not verify `host/routes/events.ts` abuse (a client posting forged `share.expired`) or the txiki.js side of low-order X25519 points.

## Questions for the owner

1. **M3:** is a password prompt acceptable on a machine that has biometrics when the biometric shortcut was never enabled?
2. **M5:** should a revoked member of a role-assigned credential reappear in the missing list, or should revocation suppress it?