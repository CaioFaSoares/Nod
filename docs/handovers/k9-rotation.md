# Slice K9 — Share with updates; rotation pending on revoke

Owner: the **Nod** slice of E02's block 2 for issue **#37 (K9)**, under the coordinator's
assignment in this session. It rides on K3's host side (already landed: `rotationPending` in the
signed snapshot, `DELETE /v1/credentials/:id/holders/:personId`, an `update` share from the owner
holder clears the badge) and on K4/K6/K7's Nod share flows.

Contracts followed: `docs/specs/SP06-credential-sharing.md` §4 (Update and Revoke a holder) and §5
(the scope the update travels with); `docs/specs/SP04-sync.md` §2 (the snapshot is the source of
`rotationPending` and of the open shares); `docs/handovers/k3-host-shares.md` (the host's
`rotationPending` clears when an `update` share you created exists at or after the removal);
`backend/context.md`, `shared/context.md`, `src/context.md`, `AGENTS.md`.

Not run: the repo-wide `bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter — the
coordinator runs those at the end of the phase. What ran: this slice's own file (`test/rotation.test.ts`)
and the three test files whose `HostConnection` doubles this slice extended.

## Files touched

| File | What changed |
| --- | --- |
| `backend/shares.ts` | New K9 section after `send`: `PENDING_UPDATES_KEY` (`meta` row, no schema bump), `readPendingUpdates`/`writePendingUpdates`, `sealUpdate` (seal one `kind:'update'` copy per live holder and `POST /v1/shares`), `update` (the owner's save fan-out), `retryPending`, `applyUpdates` (no-gate accept of an incoming `update` of a held credential) and `removeHolder`. Four new `Shares` members; the warnings `UPDATE_PENDING`/`UPDATE_KEY_CHANGED`. |
| `backend/vault.ts` | `VaultDeps.afterSave?` — the one sharing call-out. `save` awaits it after the index write and, if it answers a warning, returns `{ ...item, updateWarning }`; a throw is swallowed so the save stands. |
| `backend/host-client.ts` | `HostConnection.removeHolder(credentialId, personId)` → `DELETE /v1/credentials/:id/holders/:personId` (the second `:personId` filled beside `routePath`'s first). |
| `backend/main.ts` | The vault's `afterSave` wired to `shares.update`; `onState` calls `shares.retryPending()` every run and `shares.applyUpdates()` on an applied snapshot; `shares.removeHolder` in `HOST_WRITES`; the `shares.removeHolder` RPC. |
| `shared/types.ts` | `VaultItem.updateWarning?`; the `shares.removeHolder` RPC (`{ toolId, personId } → VaultItem`). |
| `src/settings.ts` | The holder rows gain a `Remove` for a live holder when the viewer is the owner or an admin; `revokeHolder` (confirm → RPC → `host.syncNow` → reload); the `rotation pending` chip gains the title "save a new secret to rotate"; `saveCredential` shows `updateWarning` when the save answered one. |
| `test/rotation.test.ts` | **New.** The K9 flow, unit and end to end (below). |
| `test/shares.test.ts`, `test/keys.test.ts`, `test/sync.test.ts` | One additive line each: the `HostConnection` doubles gain `removeHolder` (the interface method is new). |
| `backend/context.md`, `shared/context.md`, `src/context.md` | The rows of the files above and the block 2 status paragraphs. `host/context.md` already carried K9's `rotationPending` (K3) and the host side is unchanged. |
| `docs/handovers/k9-rotation.md` | This file. |

## Acceptance criterion — how each item was met

### 1. The owner edits a shared credential; holders get the new value at their next sync

| How | Evidence |
| --- | --- |
| A save goes through the vault's `afterSave` (`main.ts` wires it to `shares.update`). For an item with a `credentialId` whose snapshot holders name the caller an owner, `update` seals the new keychain value to every live holder (`removedAt === null`, not me) with `kind:'update'` and `POST /v1/shares`. The receiver's `accept` replaces the item (same `toolId`, same `credentialId`, origin checked) and, on an applied snapshot, `applyUpdates` accepts an incoming `update` of a held credential with **no gate** and nothing shown. | `test/rotation.test.ts`: "an edited shared credential reaches the holders…" (real host: Alice edits after Bob and Carol accepted, Bob's Nod holds the new secret after its next sync and the same one-item vault), plus "a save of a shared credential posts an update to every live holder" (the payload opens with `kind:'update'` and the new secret) and "applyUpdates replaces the value, keeps the origin and never duplicates the item". |

### 2. Removing a holder marks the credential rotation pending until a new secret is saved

| How | Evidence |
| --- | --- |
| `shares.removeHolder` → `HostConnection.removeHolder` → `DELETE /v1/credentials/:id/holders/:personId`; the host sets `removed_at`, and its `rotationPending` (the owner's owned credentials with a revoked holder and no `update` share since) rides in the next snapshot. The owner's save fans the `update` out (item 1), which is what clears the badge host-side. The Vault tab shows the `rotation pending` chip (title "save a new secret to rotate") and a `Remove` on each live holder row for the owner/admin. | `test/rotation.test.ts`: "an edited shared credential reaches the holders, and a revoked holder stays pending" (Alice removes Carol → `rotationPending` true and Carol's row carries `removedAt` → Alice saves → `rotationPending` false and Bob holds the rotated value); "removeHolder calls the host and answers the item". |

## Decisions and findings for the coordinator

1. **No second gate on a save.** SP06 §4 gates the *send* (biometrics before reading the
   credential) and says the receiver's accept of an `update` already held needs no gate. The owner's
   edit is entered by the person typing the secret into the form, so the save is its own act of
   intent; asking for a second biometric prompt to re-seal a value the person just typed would be
   gratuitous. `update` is therefore ungated. Documented in `backend/shares.ts` and in
   `backend/context.md`'s K9 rule.
2. **One `meta` row, not one per credential.** The assignment suggested `shares.pendingUpdate.<credentialId>`;
   the repository offers `meta(key)`/`setMeta` and no key listing, and `backend/repo.ts` is another
   slice's file, so the pending set is one JSON row `shares.pendingUpdates` (`credentialId → toolId`).
   It needs no schema change and no repository method.
3. **The update is best-effort and never fails the save**: a missing connection, a missing key pair,
   a value that does not open or a host that refuses all leave the marker and answer
   `UPDATE_PENDING`; the credential is already in the keychain and the index when this happens.
   `retryPending` runs on every sync, so a reconnection delivers it.
4. **A `changed` holder key skips that holder, warns and does not block.** RF-45 blocks *sending* to
   a person whose key changed; an update should not resurrect that refusal for the whole fan-out, so
   the holder is skipped, the others still receive it and the save answers `UPDATE_KEY_CHANGED`. A
   pending marker is *not* written for a skip (a re-pin is a person's decision, not a retry).
5. **`rotationPending` is snapshot-driven**, as K3 built it: nothing local is remembered. The Vault
   tab's chip appears after the sync that follows the revoke (`revokeHolder` calls `host.syncNow`
   before reloading `vault.list`), and clears after the sync that follows the save that fanned the
   update out.
6. **`applyUpdates` accepts only `update` shares of a credential already held.** A `send`, an
   `assign`, or an `update` of a credential this Nod does not hold stays in the inbox for the person
   to answer; the held test matches `existing.credentialId === share.credentialId`. The host purges
   an accepted share, so a `304` (no new snapshot) re-runs nothing.
7. **The three `HostConnection` doubles gained `removeHolder`.** The interface method is new, and
   `test/shares.test.ts`, `test/keys.test.ts` and `test/sync.test.ts` implement the interface; the
   one-line stubs keep them compiling. They are the only files outside this slice's list that the
   change touched.

## Commands run and observed results

1. `bun test test/rotation.test.ts` — **9 pass, 0 fail** (the acceptance e2e included), repeated
   five times without a flake.
2. `bun test test/shares.test.ts` — **27 pass, 1 fail**, the failure in a describe another agent was
   adding to that file during this session ("one pair per person across machines (canonico §22)",
   K1); every pre-existing share test, this slice's K9 accept/update paths included, passes.
3. `bun test test/sync.test.ts` — **41 pass, 0 fail**.
4. `bun test test/keys.test.ts` — failures under "the pair of this machine (K1)" while another agent
   edits `backend/keys.ts` (`keys.ensure` answers `created: false`); the count moved from 7 to 3
   across the session as that agent worked. This slice's only touch to that file is the additive
   `removeHolder` stub, and the failures reproduce in isolation. Reported to the coordinator.
5. **Not run**: `bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter.

## What was left out

- **The `share.*` events (K10)**: the host stores events from `POST /v1/events`, and the
  `share.sent`/`share.accepted`/`share.declined`/`share.updated` events of E02 §6 are another
  slice's; this slice raises none.
- **Assignments (K8)**: the admin flows (`assignments.*`) are being built beside this one.
- **A pending-update UI**: a save that ends `UPDATE_PENDING` shows a status line; there is no badge
  for "an update is waiting", because the retry is silent and short-lived by design.
- **The host side**: unchanged — K3's `removeHolder`, `rotationPending` and `update` checks already
  carry it.

## Fixes (block 2 closeout, RF-48)

The smoke (`docs/handovers/k10-smoke.md`, finding 1) found the dead end this slice could not: an owner
who revoked their **only** non-owner holder kept `rotationPending` forever. The host cleared the state
only on an `update` share from the owner, and `update` returns early — sending nothing — when no live
holder is left, so the save that was supposed to rotate had no witness at all.

- **Host (`host/migrations.ts`, `host/repo.ts`, `host/routes/shares.ts`, `shared/host-api.ts`)**:
  migration 4 adds `credential_holders.rotated_at` (the owner row's explicit rotation instant), and
  `POST /v1/credentials/:id/rotated` — owner holder or admin, `403` for anyone else, `404` for an
  unowned id — writes it. `rotationPending` now reads a removal as cleared when it is at or before
  either the latest `update` share from the owner **or** `rotated_at`, so the explicit signal clears
  the state with no recipient in the fan-out.
- **Nod (`backend/shares.ts`, `backend/host-client.ts`)**: `shares.update` sends the signal whenever
  the credential has a removed holder and the owner saves a new secret, whether or not update shares
  went out — with a live holder the fan-out is proof too, but an all-skipped fan-out (RF-45) is not.
  Offline or a refused host leaves the credential in K9's own pending-update marker, and
  `retryPending` retries the whole save, signal included, at the next sync.
- **Tests**: `host/shares.test.ts` pins the route (owner clears the state after the last holder is
  revoked; a live non-owner and a removed holder each `403`; the admin `404` on an unknown
  credential; `401` without a session); `test/rotation.test.ts` adds the end-to-end "the only holder
  is revoked and the owner's save clears the rotation" and the focused "an offline save of a revoked
  credential keeps a marker and retries the signal". `schema_version` moves to `4`
  (`host/repo.test.ts`, `host/health.test.ts`).

The other route and column lines this touched are in `docs/specs/SP01-host-data-model.md` §3–§5,
`docs/specs/SP03-host-api.md` §3 and `docs/specs/SP06-credential-sharing.md` §4.
