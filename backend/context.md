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

## Modules (block 1 and block 2 landed)

| Module | What it does now | Story |
| --- | --- | --- |
| `host-client.ts` | Discovery, bearer in the injected `SecretStore` (sealed under `vaultKey` in the `secret` table since 0.5.1, RF-63), signature check, error mapping (SP04 §1–§2); `putKeys` (`PUT /v1/keys`, K1) and `getOwnKeys` (`GET /v1/keys/private`, canonico §22); `sendShares`/`acceptShare`/`declineShare` (K4), `removeHolder` (`DELETE /v1/credentials/:id/holders/:personId`, K9) and `markRotated` (`POST /v1/credentials/:id/rotated`, RF-48); `putAssignment` (`PUT /v1/admin/assignments`) and `missingCopies` (`GET /v1/admin/assignments/missing`, K8) | B1, K1, K4, K8, K9 |
| `sync.ts` | Timer, outbox flush, event push, snapshot apply, stale/signed-out state, backoff (SP04 §3–§5); the O2 gate — `shared/version.ts`'s `tooOldFor` over `minAppVersion` (`GET /v1/meta/app`) against the running app, and a run that ends right there while this Nod is older (the guild is disconnected: no outbox, no events, no snapshot, no other route); K8: one best-effort `refreshAssignments` read per run that reached the host, and the count it leaves in `HostState.missingCopies` (`missingCopies?`/`refreshAssignments?`, absent for a Nod wired without them) | B4, B5, B10, O2, K8 |
| `connected-catalog.ts` | The effective org catalog from the verified `host.snapshot`, parsed once per change, with the pending outbox writes applied over the personal half (B7); in force only while `shared/catalog.ts`'s `catalogMode` says so — a disconnected Nod (O2) is served the local tables instead | B5, B7, O2 |
| `host-admin.ts` | Admin writes routed to the host routes when connected; the guild's people and their device sessions (O1) | B6, B8a, O1 |
| `keys.ts` | The person's E02 key pairs and the pin table (SP06 §2, canonico §22): `ensure` generates them at activation, after a reset and on a machine that never had one, seals the private halves as `bv1.` under `nod.keys.<person>` (AAD = the same key), publishes the public halves **and** the `privateSealed` blob with `PUT /v1/keys`, and adopts the host's pair (`GET /v1/keys/private`) instead of generating a competitor when the host holds one; `reSeal` re-seals the keychain value and the blob when a password change moves the `vaultKey` (a `keys.reseal.pending.<person>` mark, M1, written by `beginReseal` before the change and cleared once the host takes the blob, makes that republishable by the next `ensure` and shows as `pending` in `mine`); the public halves stay in `meta.keys.public.<person>`; `mine` answers `MineKeys` (`fingerprint: string | null`, `status: 'ok' | 'pending' | 'unavailable'`, `message: string | null`) — the fingerprint card's read, no key material; `observe` applies the snapshot's `people` to `peer_keys` (first sight pins, a difference is a pending change), `peers`/`peerKeyFor` report them, `confirm(personId, fingerprint)` promotes the pending pair and refuses any other fingerprint (RF-45, L2); `ownPrivate` opens this machine's own pair for the share flow | K1, K2, K4 |
| `shares.ts` | SP06 §3–§5: `recipients` and the pure `scopeDecision` (common role and grant for `role`, granted members for `org`, nobody for `blocked`), `send` (gate → vault read → scope → pinned keys → one seal per recipient → `POST /v1/shares`), `inbox` from the snapshot, `accept` (gate, the five checks of §3, the vault copy and the host accept with the previous item restored on failure) and `decline`; `setScope` for the owner; `decorate` puts the snapshot's `holders` and `rotationPending` on the vault list; K9: `update` (the owner's save re-seals to the live holders with `kind:'update'`; no gate, a changed key is skipped with a warning, an unreachable host leaves a `meta` pending marker; a revoked holder also sends the explicit rotation signal, `signalRotated`), `retryPending` at each sync, `applyUpdates` (an incoming `update` of a held credential is applied with no gate), `removeHolder` (`DELETE` the holder, the host marks the credential pending); K8: `assign` (the admin writes the assignment — `PUT` for a role, a direct `kind:'assign'` share for one person — and seals a copy to every member the host lists as missing in the same gated step), `missing` (the host's rows with the member's name, the tool's title and their key state), `sealMissing` (one gate, one `assign` copy per reachable member, `changed`/`unknown` keys skipped and counted) and `refreshAssignments`/`missingCount` for the sync loop and `host.state` | K4, K6, K7, K8, K9 |
| `personal.ts` | The person's own tools, views and favorites (SP05 §2–§4): the write goes to `host_outbox` while a `host` row exists and to the `tool`/`meta` tables otherwise; `p-…` ids; `host.remove` keeps or drops the personal half; `adoptLocalTool` turns a leftover local tool into a personal one (RF-40) | B7, B8b |
| `repo.ts` | `user_version = 7`: `host`, `host_outbox`, `event.client_id`/`sent_at`, `vault_item.origin`, `vault_item.credential_id`/`scope` (K4/K6), password V2, `tool.scope`/`owner_id` (a personal row carries both), `tool.category` (RF-62's tool categories, `NULL` on a personal row), `peer_keys` (pinned + pending pairs, K2), `secret` (RF-63: the `bv1.` values, `secret`/`setSecret`/`deleteSecret`); `rekeyVaultTool` moves a credential's index rows to a new tool id (B8b) | B1–B4, B7, B9, B8b, K1–K4, K6, RF-63 |
| `secret-store.ts` | RF-63 (0.5.1): `createSecretStore` — the backend's one `SecretStore`: `nod.bio.*` to the system keychain, every other key to the `secret` table (only `bv1.` values; a value an older Nod left in the keychain moves on its first read); `sealedSecrets` seals the guild bearer under the session's `vaultKey` (AAD = its key) | RF-63 |
| `session.ts` | `PasswordHashV2` from account creation on (keys in memory immediately), keys in memory while unlocked, `adoptConnectedAccount`, `wipeVault`, `onActivated` (§7 reset hook), the password change re-sealing the vault items, the E02 pair's value **and** the `sealedExtras` (the guild bearer, RF-63) in one batch (`reencryptVaultItems`, M1), biometric item holding `base64url(vaultKey)` with enable/disable, and the `biometric_people` flag in `store` that keeps the entry screen and the password unlock off the keychain (SP02 §6, §7, §9; RF-63) | B2, B3, V1, RF-63 |
| `vault.ts` | Fill only on the origin the credential was saved for (RF-38); every value sealed as `bv1.` (AAD = keychain key), `migrateLegacy` on the first unlock, `reencryptVaultItems` for the password change (SP02 §8) — it also carries the extra `bv1.` values that live under the same `vaultKey` (the E02 pair's keychain value, M1), opened first and written in the same batch; `save` carries the credential group and scope of an accepted share (K4/K6) and calls the `afterSave` call-out (K9: the owner edit's update fan-out; best-effort, never fails the save) | B9, V1, K4, K9 |
| `main.ts` | `host.*` (`state`/`discover`/`activate`/`signIn`/`syncNow`/`remove`/`bootstrap`/`localLeftovers`/`adoptLocalAsPersonal`/`sessions`/`revokeSession`), `events.syncStatus`, `people.sessions`/`people.revokeSession`, `personal.*`/`favorites.*` (B7), `session.disableBiometric`, `keys.mine` (→ `MineKeys`) / `peers.list` / `peers.confirm` (K1–K2), `vault.copy`/`vault.setScope` and `shares.recipients`/`send`/`inbox`/`accept`/`decline`/`removeHolder` and, admin, `assignments.set`/`missing`/`sealMissing` (K4–K8, K9) over the `authenticate` gate of K5 — `app.authenticate` wherever the machine reports the capability (the canonical rule), the unlocked person's password where it does not or in a non-release dev run marked by the `resources/build-mode` stamp (`nod.info.devRun`; `nod.info` also carries `biometricAvailable`), `authentication required`/`authentication cancelled`; admin methods routed to the host; the O2 disconnected-guild gate — `HOST_WRITES`/`HOST_READS` refused with `UPDATE_REQUIRED_ERROR`, the snapshot-derived reads answering empty, `beginAuth` refusing a join and a sign-in over the discovery's `minAppVersion`, and `guildConnection()` handing every other host caller a `null` connection; `afterUnlock` runs `vault.migrateLegacy`; a same-person reset wipes the vault and reports `wipedVault`, while an F1 adoption re-seals it (SP02 §7–§8) and the E02 pair is ensured on activation (`session.onActivated`), on unlock and after every applied snapshot (SP06 §2) — every access-code activation (and setup) reports `reset: true`, so the pair is regenerated unless the host's blob opens under the new `vaultKey`; `leftoverTools` (RF-40 leftovers, B8b); a fresh-machine `host.signIn` runs the first sync before it answers, so the returned session carries the host's `me.admin` and name (F2, RF-48 finding 2) | B2, B6, B7, B8a, B8b, O1, O2, V1, K1–K2, K4–K7, K9 |

Block 2 has landed: the E02 key pairs and the pin table (K1–K2, `keys.ts`, one pair per person
across machines, canonico §22 — `keys.mine` answers `MineKeys`, a `reset: true` activation
regenerates the pair unless the host's blob opens under the new `vaultKey`), the share flows of
K4, K6 and K7 with the K5 gate (`shares.ts`, `main.ts`), the rotation flow of K9 — the owner's
save re-seals the new value to the holders (`update`, through the vault's `afterSave`), an incoming
`update` of a held credential is applied with no gate (`applyUpdates`), a failed update retries at
the next sync (`retryPending`), `removeHolder` revokes one (`shares.ts`, `host-client.ts`,
`main.ts`), and a save after a revocation also sends the explicit rotation signal
(`signalRotated`/`markRotated`, RF-48) so the state clears even with no holder left to update — the
assignments of K8 — `assign` (the admin's assignment plus the seal to the
missing members in the same gated step), `missing`, `sealMissing` and the per-sync
`refreshAssignments` that feeds `HostState.missingCopies` (`shares.ts`, `host-client.ts`,
`sync.ts`, `main.ts`) — and the personal writes in the O2 gate (B8b). The `share.*` event family of
E02 §6 also landed (ShareEvents): the Nod raises content-free `share.sent`/`share.accepted`/
`share.declined` and the host writes `share.expired` on the expiry purge
(`docs/handovers/share-events.md`).

Contracts: `docs/specs/SP02-auth-and-keys.md`, `SP04-sync.md`, `SP05-nod-connected.md`,
`SP06-credential-sharing.md`.

## Rules

- The page never receives `authKey`, `vaultKey`, the host token or a private key; at most a
  revealed credential, after the gate (E02 §5).
- Many RPC params carry a password, a code or a secret (the list is in `AGENTS.md`, "Não pode"), so
  `TINYJS_DEBUG=1` must never run with real credentials; a new method of that kind joins that list.
- Backend timers, not page timers, for anything periodic. The page is throttled when hidden
  (`docs/tinyjs.md` §3).
- Check capabilities with `!== false` before using biometrics, tray or global shortcuts
  (`docs/tinyjs.md` §6).
- Tests: pure parts go to `shared/` and run under `bun test`; runtime-bound parts are proved by
  the smoke (`test/smoke/`).
- **O2**: while the host's `minAppVersion` is above the running app the guild is **disconnected**
  (owner decision 2026-10-17). A sync ends after the version check (outbox, events and snapshot all
  stop) and no other route of the host is reached; every RPC that would reach it is refused with
  `UPDATE_REQUIRED_ERROR` — a write through `HOST_WRITES` (`main.ts`), a read only the host can
  answer through `HOST_READS` — so a new method that reaches the host belongs in one of the two; the
  reads of the cached snapshot answer empty; the catalog layer serves the local tables
  (`shared/catalog.ts`'s `catalogMode`, read in `refreshConnectedCatalog`); and `host.state` still
  reports the guild with `updateRequired: true`. `host.activate` and `host.signIn` refuse themselves
  over the discovery's `minAppVersion` (`main.ts`'s `beginAuth`), before any credential.
- **O2, the connection**: `backend/keys.ts`'s key publish, `backend/shares.ts`, `backend/guild-icon.ts`
  and the admin routes all take `main.ts`'s `guildConnection()` — `null` while the gate is up — so
  they make no call of their own; the sync loop is the only caller of the ungated `connectionOf()`.
  The `host` row, the bearer and the cached body stay on disk while disconnected.
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
- **Rotation (K9, SP06 §4)**: the owner's save is the gate of an `update` — the person typed the
  secret, so no second biometric prompt is asked; SP06 §4 gates the *send*, and an edit of a
  credential the owner already shared re-seals it (`update`, called by the vault's `afterSave`). A
  holder whose pinned key is `changed` is skipped with a warning and never sealed to (RF-45); a save
  that cannot reach the host leaves a `meta` marker (`shares.pendingUpdates`) and is retried on every
  sync (`retryPending`). An incoming `update` of a credential this Nod already holds is applied with
  no gate and nothing shown (`applyUpdates`, on each applied snapshot); any other share stays in the
  inbox. `shares.removeHolder` and the host's `DELETE …/holders/:personId` are the revoke; the
  owner's `rotationPending` (snapshot-driven, K7's chip) clears when the update share exists or the
  owner sent the explicit rotation signal (`POST /v1/credentials/:id/rotated`, RF-48) — the vault
  save that clears it is the same one that fans it out, and the signal covers having nobody left to
  fan out to.
- **Assignments (K8, SP06 §4, RF-47)**: `assignments.set` and `assignments.sealMissing` reach the
  host and are in `HOST_WRITES`; all three `assignments.*` methods are admin-only (the host refuses
  a member the same way). `assign` writes the row for a role (`PUT /v1/admin/assignments`) and then
  seals to the members the host lists as missing in the same gated step; a `personId` is the direct
  assignment — one `kind:'assign'` copy, no row. The missing list is read once per sync
  (`refreshAssignments`, best effort) and lives in memory only; its count rides `HostState.missingCopies`.
  Every copy travels with the credential's own scope, and a member whose pinned key is `changed` or
  `unknown` is skipped and counted, never sealed to (RF-45).

Block 2 review fixes: `holders.ts` (new) builds the admin's holders list (`holders.list`, M7) from
the verified snapshot; `main.ts` wires the handler and resolves each credential's tool from the
vault, the incoming shares and the missing-copy rows (a credential it cannot name is listed under
its own id).

**0.5.0 (RF-59/60/61) — the entry screen, the guild invites and the optional seed.** The locked
window draws `session.profiles`: the Offline tile (this machine's account or the offer of one) and
each guild tile from the single `host` row, whose icon is the verified `guild-icon.png` read from
disk (`backend/guild-icon.ts`'s `dataUri`) — no call leaves the machine, so a locked Nod still shows
the guild it is disconnected from. `session.unlock`/`session.unlockBiometric` take the tile
(`EntryTarget`): a `guild` target opens only while that `host` row is there and only for its
`personId` — anything else is the same `invalid credentials` — and the tile used is kept as
`last_entry` in `store.json` (a preference, never a secret; `backend/session.ts` owns the key).
`SessionState.mode` says which way the session entered and `HostState.offlineSession` says the same
to the page; both are cleared by `lock()`. **An offline session is the O2 disconnect** — one
predicate, `main.ts`'s `disconnectedSession(updateRequired, mode, hasHost)` (pure, exported; a Nod
with no `host` row is never disconnected — its Offline session is the plain local Nod), is what
`catalogMode`, `guildConnection()`, `snapshotBody()`, `host.localLeftovers` and the two gate tables
read, so an offline session reaches no host exactly as being too old does; the refusal sentence
distinguishes the two (`OFFLINE_SESSION_ERROR`, `backend/session.ts`, against
`UPDATE_REQUIRED_ERROR`), `afterUnlock` publishes no pair and starts no loop, and the sync publishes
`offlineSession: true` for the sidebar's banner. `host.activate` routes by `codeKindOf` (setup →
`/v1/auth/setup`, invite → `/v1/auth/join`, access → `/v1/auth/activate`; the first two require the
name — `activateRoute`, exported and pure), and every join (any code kind, and `host.signIn`) enters
in `guild` mode and remembers that guild. `host.invitePreview` is the join's discovery (fingerprint
refusal, O2 minimum — `discoverFor`, the half `beginAuth` shares) plus `POST /v1/auth/invite`,
answering the invite card (`inviteView`: role names, the icon re-encoded from base64url to a data
URI); the host's two `404`s are this side's sentences (`invalid invite`, and the deleted role of a
join). `guildInvites.list|create|revoke` are admin-only, go through `guildConnection()` and sit in
`HOST_READS`/`HOST_WRITES`; `create` answers the code once and the `nod://join` link built from the
row (`shared/join-link.ts`, which also replaced `main.ts`'s private `parseJoinLink`).
`session.importSeed` (RF-61) is the first run's optional seed: only while no person exists, applied
in boot mode through `backend/seed.ts`'s `applySeedFile` — the same core `applyBundledSeed` uses —
recording `catalog_imported` with `result: 'seed'`; the runtime origin gate stays the embedded
seed's (it is built, never read at runtime), so an imported seed fills the catalog and never widens
what a tool may call. `scripts/gen-config.ts` no longer requires `resources/seed.json` in `build`,
and a release without one ships no `seed.json` at all. `POST /v1/admin/people` is gone with 0.5.0
(its client, `backend/host-admin.ts`'s `createPerson`, with it): a person who does not exist yet
joins through a guild invite, and `invites.issue`'s connected path is only the reissue for an
existing person.
