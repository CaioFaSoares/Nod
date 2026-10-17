# Slice V1 — vault encrypted with `vaultKey`; biometric item holds the key; reset wipes

Authorizing issue: **#26** (copy `/tmp/nod/issue-26.md`), under `docs/epics/E01-connected-mode.md`
(Block 2 — "Mine and shared") and `docs/epics/blocks.md`. Spec: `docs/specs/SP02-auth-and-keys.md`
§1, §6–§9. Requirements: RF-43 and RF-24 (`docs/canonico.md` §14, proposals in the epic until #1).

This slice repairs and finishes the partial V1 work left by an interrupted agent. No contract or
persistence format was redesigned.

## Files touched

| File | What changed |
| --- | --- |
| `shared/vault-crypto.ts` | Fixed `encryptVaultBytes` so the plaintext reaches WebCrypto as an `ArrayBuffer`-backed view: the parameter is typed `Uint8Array<ArrayBuffer>` (no copy), clearing `TS2345` at the `BufferSource` argument. Format and public API unchanged. |
| `backend/vault.ts` | (from the partial state, completed/validated) `save` seals every credential with `encryptVaultValue` (AAD = keychain key); `read` opens `bv1.` values and still reads legacy plaintext (read-only) until migration; `migrateLegacy` re-encrypts the person's plaintext values, idempotently; `reencryptVaultItems` re-seals the whole set for the password change, opening everything in memory before the first keychain write. |
| `backend/session.ts` | **Corrective follow-up:** `createAccount` now creates the V2 verifier over a fresh local salt and keeps the derived keys in memory, so the session is never unlocked without a `vaultKey` (RF-24/RF-43); the invite path uses the same code. The insert still goes through the existing v1-shaped transaction (invite consumption stays atomic) and `savePasswordCheck` replaces it with V2 immediately; a crash in between leaves a valid v1 verifier of the same password, which the first unlock migrates. Fixed the `last`-null narrowing at the legacy biometric marker path (`TS2345`); `keys()` returns the `vaultKey` for a biometric unlock too (`authKey: null` there) and stays `null` while locked; added `disableBiometric()`; added `onActivated(cb)` with `ActivationEvent { personId, reset, vaultKey }`; `wipeVault` records the reset. Password change already re-seals vault values and the biometric item before the verifier moves; validated, not rewritten. |
| `backend/main.ts` | Added the `session.disableBiometric` RPC handler (local-only write; not in `HOST_WRITES`). **Corrective follow-up:** `wipeResetVault` now wipes only a true reset — the same person id re-activating with a fresh salt — and receives `opened.personId`. Activation over another local id is the F1 adoption, whose credentials `adoptConnectedAccount` re-seals under the new key; the earlier partial code wiped it and broke F1 (and smoke step 2.4c). |
| `shared/types.ts` | Added `'session.disableBiometric': [void, SessionState]`; `JoinResult.wipedVault` doc now points at the wired notice instead of saying the frontend does not show it. |
| `src/settings.ts` | Minimal frontend wiring: `mountJoinFlow`'s `onJoined` receives `{ vaultWiped }` and Settings → Hosts shows the reset notice (`Connected — your saved logins on this machine were removed because the account was reset.`); added a "Disable biometrics" button on the biometric card (the delete path of SP02 §9). `src/app.ts`'s first-run join callback still compiles unchanged (it takes no argument). |
| `test/session.test.ts` | Harness fixes (V1 makes a key necessary to seal): unlock before saving a credential in the local change-password test; `biometricAvailable: true` in the wipe test; valid legacy plaintext JSON (`{username,secret}`) where the old test wrote an arbitrary string. Replaced the old pin `a locally created account has no keys until its first unlock migrates it` with `a locally created account holds the keys of its V2 verifier and uses the vault at once`; the second-account test now asserts the new account's own keys replace the previous ones; the "v1 verifier has no host password" fixture writes a genuine v1 row by hand. Updated the two biometric `keys()` expectations to `{ authKey: null, vaultKey }`; new tests for `disableBiometric` and `onActivated`. |
| `test/tool-windows.test.ts` | Harness only: `settle()` now drains WebCrypto's task turns with `setImmediate` (fake timers do not touch it, so the 4 s re-check stays under test control). Vault construction already passed `vaultKey`. |
| `test/host-admin.test.ts` | Harness only: the F1 join test unlocks the local account before saving the credential (still valid after `createAccount` became V2: the call is idempotent). |
| `backend/context.md`, `shared/context.md` | Module rows for `session.ts`, `vault.ts`, `main.ts` and the new `vault-crypto.ts`; block-2 "still to come" no longer lists V1. |
| `docs/handovers/v1-vault.md` | This file. |

## Acceptance — how each item is met

| Acceptance item | Where it is met | Evidence |
| --- | --- | --- |
| Keychain values use the `bv1.` format with AAD = keychain key; legacy plaintext re-encrypts on first unlock | `backend/vault.ts` `save`/`read`/`migrateLegacy`, `backend/main.ts` `afterUnlock`; format in `shared/vault-crypto.ts` | `execucao`: `test/vault-crypto.test.ts` (envelope, AAD mismatch, fresh nonce, size gate) and `test/vault.test.ts` (`save` writes `bv1.`, `migrateLegacy` idempotent, refuses without key). |
| Reading `bond.cred.*` with the system keychain tool shows ciphertext | Same path: only `save` writes the keychain, and it writes the envelope | **`leitura` only** — not executed. The two smoke scripts ran the real Nod backend, but no system keychain inspection (`security`/`secret-tool`) was made. The stored-value shape is pinned by the vault tests. |
| Biometric unlock reads `vaultKey` from `bond.bio.<person>`; Linux has no such item | `backend/session.ts` `unlockBiometric` (`decodeVaultKey`), `enableBiometric` writes `base64url(vaultKey)`, `disableBiometric` deletes; `main.ts` creates the session with `biometricAvailable: system !== 'linux' && …` | `execucao`: `test/session.test.ts` — item holds the key, biometric unlock keeps only the `vaultKey`, legacy marker is deleted and requires one password unlock, disable removes the item. |
| A reset (new access code) wipes this machine's vault after telling the person | `backend/main.ts` `wipeResetVault` (same person id re-activating with a fresh salt) and the cached-salt comparison in `host.signIn`; both return `wipedVault`; `src/settings.ts` shows the notice after the join. `wipeVault` also deletes the biometric item. An F1 adoption (another local id) is not a reset and re-seals instead. | `execucao`: `test/session.test.ts` wipe test (index rows, credential items and biometric item; other people untouched), the `onActivated` test, and `bun test/smoke/connected.ts --force` step 2.4c (the pre-join credential comes along through the adoption). `wipedVault` → notice is `leitura` on the backend; no page test was run. |
| Password change (local and online) re-seals every item and the biometric item under the new `vaultKey` | `backend/session.ts` `changePassword` → `reencryptVaultItems` before `savePasswordCheck`; biometric item rewritten; host called first when connected | `execucao`: the two change-password suites: new key opens the value, old key opens nothing, biometric item follows the new key, biometric unlock still reads the vault. |

## Commands run and observed results

```text
$ bun test test/session.test.ts test/vault.test.ts test/host-admin.test.ts test/tool-windows.test.ts
153 pass, 0 fail, 807 expect() calls — Ran 153 tests across 4 files. [4.02s]

$ bun test/smoke/run.ts --force
ok 1 session.state … ok 2 session.createAccount (784 ms) account created; person is admin and session unlocked
ok 3 catalog.probe … ok 4 catalog.save … ok 5 vault.save (tool-a) (14 ms) credential in keychain; vault.list does not show secret
ok 6 tools.open (tool-a, form) … ok 7 tools.open (tool-b, session) … ok 8 warm … ok 9 provider view …
ok 10 tools.open (tool-c, login loop) … ok 11 events.exportToFile … ok 12 session.lock …
ok 13 session.unlock … ok 14 vault.remove (tool-a, tool-c) …
14 steps, all ok (the private seed was moved/restored by the script; TINYJS_DEBUG was not set).

$ bun test/smoke/connected.ts --force
ok 2.1 session.state … ok 2.1b session.createAccount (792 ms) … ok 2.1c vault.save (before the join, F1) (14 ms)
ok 2.4 host.activate (the choice, F1) … ok 2.4b host.activate (adoptLocal, F1) (923 ms)
ok 2.4c vault.list/reveal (the credential came along, F1)
… all phases …
connected smoke ok: 6 phases, 53 steps
```

The earlier full-file typecheck (`bunx tsc -p tsconfig.json --noEmit`, no output; `backend/tsconfig.json`
with only other slices' diagnostics) was run **before** this corrective follow-up. Per the
coordinator's instruction, typecheck and the full suite were not run again after the
`createAccount`/`wipeResetVault` changes; those were verified by the four suites and the two smoke
scripts above.

## Open findings / divergences (reported, not decided)

1. **A keychain failure midway through `reencryptVaultItems` leaves a mixed vault.** Planning is
   all-in-memory, so a value that cannot be opened aborts before any write; but if `keychain.set`
   fails after some writes, those items are under the new key while the verifier (and the rest) are
   still under the old one. The operation is retryable with the same new password (values that
   already open with `to` are accepted), but it is not atomic. SP02 §7's "old values readable"
   holds for the values not yet rewritten and for the abort-before-write path only.
2. **`keys()` changed shape:** `authKey` is now `Uint8Array | null` (null after a biometric unlock)
   so the `vaultKey` is available from both unlock paths, as requested by the K1 handoff. The only
   callers are tests.
3. **`onActivated` isolates subscriber failures.** Callbacks run after the adoption row is written
   and are awaited, but a throw is swallowed so a subscriber cannot leave the activation with the
   local row adopted and the host row/token unsaved. Subscribers must be idempotent and own their
   retries. K1 was told the exact signature; whether it needs a visible failure signal is a
   contract decision.
4. **A reset is now narrower than the earlier partial code assumed.** Activation wipes only when
   `local.id === opened.personId` (the same person re-activating); adopting a local account with
   another id is F1 and re-seals. SP02 §7 describes the reset as a new access code for the same
   account, so this matches the spec and the smoke's F1 acceptance; the previous "any V2 local
   account on activation" rule contradicted it. Reported here as the decision the code now makes.

## What another owner needs

`KeysPinning` (K1) may now call `session.keys()`, `session.vaultKey()` and
`session.onActivated(cb)` and register the callback in `backend/main.ts`; it must not edit
`backend/session.ts`. Signature sent to `agent://KeysPinning`.
