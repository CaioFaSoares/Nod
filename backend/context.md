# backend/ — Nod's system side

The txiki.js process behind every Nod window: SQLite, keychain, tool windows, the login cascade,
and (from block 1) the host client and sync. Module by module, with signatures:
`docs/arquitetura.md` §4. Runtime facts: `docs/tinyjs.md`.

## What it owns

- The local database (`repo.ts`, `tjs:sqlite`), and the only path to the OS keychain (`vault.ts`,
  `session.ts`).
- Every network call the Nod makes. The page never talks to the network (`docs/tinyjs.md` §10).
- The RPC gate in `main.ts`: which window and which session may call which method
  (`docs/arquitetura.md` §2).
- Tool windows, popups, shortcuts, the login adapter and the canonico §22 warning of a tool that
  did not come from the org (`tool-windows.ts`, `login-adapter.ts`; B7).

## Modules (block 1 landed; block 2 pending)

| Module | What it does now | Story |
| --- | --- | --- |
| `host-client.ts` | Discovery, bearer in the keychain, signature check, error mapping (SP04 §1–§2); `putKeys` (`PUT /v1/keys`, K1) | B1, K1 |
| `sync.ts` | Timer, outbox flush, event push, snapshot apply, stale/signed-out state, backoff (SP04 §3–§5); the O2 gate — `minAppVersion` (`GET /v1/meta/app`) against the running app, and a run that pushes nothing while this Nod is older | B4, B5, B10, O2 |
| `connected-catalog.ts` | The effective org catalog from the verified `host.snapshot`, parsed once per change, with the pending outbox writes applied over the personal half (B7) | B5, B7 |
| `host-admin.ts` | Admin writes routed to the host routes when connected; the guild's people and their device sessions (O1) | B6, B8a, O1 |
| `keys.ts` | The person's E02 key pairs and the pin table (SP06 §2): `ensure` generates them at activation, after a reset and on a machine that never had one, seals the private halves as `bv1.` under `nod.keys.<person>` (AAD = the same key) and publishes the public halves with `PUT /v1/keys`; the public halves stay in `meta.keys.public.<person>`; `observe` applies the snapshot's `people` to `peer_keys` (first sight pins, a difference is a pending change), `peers`/`peerKeyFor` report them, `confirm` promotes the pending pair (RF-45); `ownPrivate` opens this machine's own pair for the share flow | K1, K2, K4 |
| `shares.ts` | SP06 §3–§5: `recipients` and the pure `scopeDecision` (common role and grant for `role`, granted members for `org`, nobody for `blocked`), `send` (gate → vault read → scope → pinned keys → one seal per recipient → `POST /v1/shares`), `inbox` from the snapshot, `accept` (gate, the five checks of §3, the vault copy and the host accept with the previous item restored on failure) and `decline`; `setScope` for the owner; `decorate` puts the snapshot's `holders` and `rotationPending` on the vault list | K4, K6, K7 |
| `personal.ts` | The person's own tools, views and favorites (SP05 §2–§4): the write goes to `host_outbox` while a `host` row exists and to the `tool`/`meta` tables otherwise; `p-…` ids; `host.remove` keeps or drops the personal half; `adoptLocalTool` turns a leftover local tool into a personal one (RF-40) | B7, B8b |
| `repo.ts` | `user_version = 5`: `host`, `host_outbox`, `event.client_id`/`sent_at`, `vault_item.origin`, `vault_item.credential_id`/`scope` (K4/K6), password V2, `tool.scope`/`owner_id` (a personal row carries both), `peer_keys` (pinned + pending pairs, K2); `rekeyVaultTool` moves a credential's index rows to a new tool id (B8b) | B1–B4, B7, B9, B8b, K1–K4, K6 |
| `session.ts` | `PasswordHashV2` from account creation on (keys in memory immediately), keys in memory while unlocked, `adoptConnectedAccount`, `wipeVault`, `onActivated` (§7 reset hook), biometric item holding `base64url(vaultKey)` with enable/disable (SP02 §6, §7, §9) | B2, B3, V1 |
| `vault.ts` | Fill only on the origin the credential was saved for (RF-38); every value sealed as `bv1.` (AAD = keychain key), `migrateLegacy` on the first unlock, `reencryptVaultItems` for the password change (SP02 §8); `save` carries the credential group and scope of an accepted share (K4/K6) | B9, V1, K4 |
| `main.ts` | `host.*` (`state`/`discover`/`activate`/`signIn`/`syncNow`/`remove`/`bootstrap`/`localLeftovers`/`adoptLocalAsPersonal`/`sessions`/`revokeSession`), `events.syncStatus`, `people.sessions`/`people.revokeSession`, `personal.*`/`favorites.*` (B7), `session.disableBiometric`, `keys.mine`/`peers.list`/`peers.confirm` (K1–K2), `vault.copy`/`vault.setScope` and `shares.recipients`/`send`/`inbox`/`accept`/`decline` (K4–K7) over the `authenticate` gate of K5 — biometrics where available, the unlocked person's password otherwise, `authentication required`/`authentication cancelled`; admin methods routed to the host; the O2 write gate (`HOST_WRITES`, refused with `UPDATE_REQUIRED_ERROR`); `afterUnlock` runs `vault.migrateLegacy`; a same-person reset wipes the vault and reports `wipedVault`, while an F1 adoption re-seals it (SP02 §7–§8) and the E02 pair is ensured on activation (`session.onActivated`), on unlock and after every applied snapshot (SP06 §2); `leftoverTools` (RF-40 leftovers, B8b) | B2, B6, B7, B8a, B8b, O1, O2, V1, K1–K2, K4–K7 |

Block 2 landed so far: the E02 key pairs and the pin table (K1–K2, `keys.ts`), and the share flows
of K4, K6 and K7 with the K5 gate (`shares.ts`, `main.ts`). Still to come: the outbox scope of a
personal write, assignments (K8), the rotation re-seal (K9) and the `share.*` events (K10).

Contracts: `docs/specs/SP02-auth-and-keys.md`, `SP04-sync.md`, `SP05-nod-connected.md`,
`SP06-credential-sharing.md`.

## Rules

- The page never receives `authKey`, `vaultKey`, the host token or a private key; at most a
  revealed credential, after the gate (E02 §5).
- `host.activate`, `host.signIn` and `session.*` carry the password in params, so `TINYJS_DEBUG=1`
  must never run with real credentials (`AGENTS.md`).
- Backend timers, not page timers, for anything periodic. The page is throttled when hidden
  (`docs/tinyjs.md` §3).
- Check capabilities with `!== false` before using biometrics, tray or global shortcuts
  (`docs/tinyjs.md` §6).
- Tests: pure parts go to `shared/` and run under `bun test`; runtime-bound parts are proved by
  the smoke (`test/smoke/`).
- **O2**: while the host's `minAppVersion` is above the running app, a sync pushes nothing (outbox,
  events and snapshot all stop) and every method that writes to the host is refused with
  `UPDATE_REQUIRED_ERROR` — `HOST_WRITES` in `main.ts` and the gate in `sync.ts` are the two halves
  of that one rule, so a new method that reaches the host belongs in both. `PUT /v1/keys` is a write
  of that kind made outside a method: `keysConnection()` (`main.ts`) hands `backend/keys.ts` a `null`
  connection while the gate is up, and the pair waits locally.
- **Keys (K1–K2, SP06 §2)**: a private half only ever exists inside the `bv1.` value of
  `nod.keys.<person>` (AAD = the same keychain key) and in the memory of the unlock; the public
  halves are `meta.keys.public.<person>` (public: the host holds them too) and the pinned pairs of
  colleagues are `peer_keys`. `peerKeyFor` is the only seam a sender may read, and `changed` means
  refusing to send until `peers.confirm` (RF-45).
- **Shares (K4–K7, SP06 §3–§5)**: `shares.send`, `shares.accept` and `shares.decline` reach the host
  and are in `HOST_WRITES`; `shares.send`, `shares.accept`, `vault.reveal` and `vault.copy` call the
  one K5 gate (`authenticate`) before reading anything, and a cancelled prompt or a locked session
  shows, copies, sends and accepts nothing. The scope is decided twice — here against the verified
  snapshot (`scopeDecision`) and by the host on its own rows — and the sealed payload never carries
  the scope wider than the credential's. `host.db` holds the sealed bytes and the metadata, never a
  username or a secret (RF-44).
