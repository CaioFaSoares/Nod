# Slice O1 + O2 (Nod side) — device sessions in Settings and the People screen; the minimum app version gate and the host's update manifest

Authorizing issues: **#27** (O1) and **#28** (O2), the copies the coordinator handed over
(`/tmp/nod/issue-27.md`, `/tmp/nod/issue-28.md`), pointing at `docs/epics/E01-connected-mode.md`
(Block 2 — "Mine and shared") with gate #1 closed. Requirements: RF-39 and RF-14
(`docs/canonico.md` §14). The host half of both stories is `docs/handovers/h7-o1-o2-host.md` (H7's
slice, in flight in this same phase) — this file is the Nod half and claims nothing about the host.

Contracts followed: `docs/specs/SP03-host-api.md` §2 (`DeviceSession`, `GET`/`DELETE /v1/sessions`,
`GET /v1/admin/people/:id/sessions`, `DELETE /v1/admin/sessions/:id`) and §3 (`GET /v1/meta/app` →
`{ minAppVersion, update: { url } | null }`, public); `SP04-sync.md` §1 (the discovery's
`minAppVersion`, the `401` of a revoked session) and §3 (the triggers, the order, the stale state);
`SP05-nod-connected.md` §3 (`host.sessions`/`host.revokeSession`, block 2) and §4 (the screens);
`docs/distribuicao.md` §6/§8 (the update channel and the manifest `tinyjs publish` writes). Rules:
`AGENTS.md`, `backend/context.md`, `src/context.md`, `shared/context.md`, `host/context.md`.

Nothing here is a secret: a `DeviceSession` has no token and no hash of one (SP02 §5), the app
version is public, and no new log, event or `store.json` entry was added.

## Files touched

| File | What changed |
| --- | --- |
| `shared/version.ts` | **New.** `compareVersions(left, right)` — semver 2.0.0 §11 for the gate (three numeric components with 1–2 padded by zeros, optional pre-release, build metadata ignored, a leading `v` accepted). A text that is not a version answers `0`, i.e. "no opinion": a `minAppVersion` the Nod cannot read never stops it from syncing. Pure, no import (the runtime's own comparison, `~/.tinyjs/runtime/update.js`, is not the repository's to reuse). |
| `shared/types.ts` | `HostState` gains `updateRequired: boolean` and `minAppVersion: string \| null`; `ApiContract` gains `'host.sessions': [void, DeviceSession[]]`, `'host.revokeSession': [{ id: Id }, true]`, `'people.sessions': [{ personId: Id }, DeviceSession[]]`, `'people.revokeSession': [{ id: Id }, true]`; one **type-only** import of `DeviceSession` from `shared/host-api.ts` (the device rows are the host's document; nothing is emitted, so the two files keep their direction without a runtime cycle). |
| `backend/host-client.ts` | `HostConnection` gains `sessions()`, `revokeSession(id)` (both with the bearer) and `appMeta()`. `appMeta` goes out **without** any bearer (SP03 §3: public) and its answer is shape-checked by a new `readAppMeta` beside `readDiscovery`/`readSnapshot`. One new private `routePath(template, id)` fills `:id` with `encodeURIComponent`. |
| `backend/host-admin.ts` | `HostAdmin` gains `sessions(personId)` and `revokeSession(id)` → `GET /v1/admin/people/:id/sessions`, `DELETE /v1/admin/sessions/:id`. |
| `backend/sync.ts` | `SyncDeps.appVersion: () => string \| null`; `Sync.observeMinVersion(version)`; module state `minAppVersion`; `updateRequiredNow()`, `refreshMinVersion(connection)` and the exported `UPDATE_REQUIRED_ERROR`. `runOnce` reads `GET /v1/meta/app` **first** and, while this Nod is older, pushes nothing (no outbox, no events, no snapshot); `state()` reports the two new fields. |
| `backend/main.ts` | `appVersion` (read once in `init` from `app.info()`); `appVersion` handed to `createSync`; `HOST_WRITES` + the refusal in the §2 `guarded()`; `requiresUpdate()`; `ADMIN_ONLY` gains `people.sessions`/`people.revokeSession`; the four handlers `host.sessions`, `host.revokeSession`, `people.sessions`, `people.revokeSession`; `sync.observeMinVersion(...)` on `host.discover`, `host.activate` and `host.signIn`. |
| `src/settings.ts` | Account: `devicesCard()` (name, OS, app version, last seen, Revoke) shown only while a host is connected, fed by `host.state` + `host.sessions`; `deviceRow()` shared with the admin side. People: a Devices toggle per person (`people.sessions`) with Revoke (`people.revokeSession`). State: `sessions`, `devicesFor`, `personDevices`. |
| `src/app.ts` | `renderUpdateRequiredNotice(slot)` — the persistent banner (no dismiss) with the guild, the required version and a "Check for updates" button that opens Settings → Account; rendered first in `renderNotices()`. |
| `src/style.css` | Four lines: `.notice-danger` (the danger left border), so the out-of-date state is not confused with the signed-out notice. |
| `test/version.test.ts` | **New.** 6 tests: ordering, padding, `v`/spaces, pre-release and build metadata, an unreadable text, and the gate's own reading of current vs old. |
| `test/sync.test.ts` | Harness: fake `sessions`/`revokeSession`/`appMeta`, `Script.meta`, `calls.meta`, `setAppVersion`, `SyncDeps.appVersion`; one existing `toEqual` on the whole `HostState` gained the two new fields. 8 new tests in `describe('minimum app version (O2)')`. |
| `test/host-client.test.ts` | The fake host answers `GET /v1/meta/app` (mutable through `host.meta(...)`) and `/v1/sessions*`; 4 new tests: the meta document with **no** bearer, `update: null`, an unreadable document refused, the session list + revoke, and a list with no bearer behind it. |
| `test/host-admin.test.ts` | `appVersion` in both `createSync` calls (that gate is not those tests' subject); `activate` returns the `authKey` and a `signIn` helper joins a second device; 3 new tests in `describe('device sessions (O1, SP03 §2)')` against the real host: the own list + revoke (the revoked bearer answers `401`, the other device still `200`), a person revoking another person's session (`403`), and the admin listing and revoking any person's device. |
| `backend/context.md`, `src/context.md` | The module/screen rows for `sync.ts`, `host-client.ts`, `host-admin.ts`, `main.ts` and the two screens, plus the new O2 rule (*a method that reaches the host belongs in `HOST_WRITES` and in the sync's gate*). |
| `docs/handovers/o1-o2-nod.md` | This file. |

Not touched, and why: `shared/host-api.ts` (`HOST_ROUTES.appMeta` and `AppMeta` were already there —
appended by H7, whose file list names both); `backend/repo.ts` (no new column: the minimum version is
the host's fact, re-read every run, and nothing local is decided by a stale copy); `host/**` (the
host's half is H7's); `src/api.ts` and `src/palette.ts` (nothing new for them).

## Acceptance — how each item is met

Evidence per claim is `leitura` unless the row says `execucao`.

| Acceptance item | Where it is met | How the code answers |
| --- | --- | --- |
| O1 — Settings → Account lists this person's devices | `src/settings.ts` `devicesCard()` + the `account` case of `load()` (`host.state`, then `readOwnSessions()` → `host.sessions`); `backend/main.ts` `'host.sessions'` → `connection.sessions()` → `GET /v1/sessions` `execucao` (test/host-client.test.ts, test/host-admin.test.ts) | each row shows the device name, the OS, the app version and `lastSeenAt`, with the Revoke button; the row carries no token (SP02 §5) and the page shows no session id |
| O1 — revoking one signs that device out at its next sync | `src/settings.ts` `revokeOwnSession()` → `host.revokeSession` → `DELETE /v1/sessions/:id`; the device's next request is the `401` `backend/sync.ts` already turns into the signed-out state (SP04 §3, RF-39) `execucao` (the revoked bearer answers `401` in test/host-admin.test.ts; the existing `describe('401')` of test/sync.test.ts pins the Nod's side) | the host ends the row; the Nod's own session is untouched, and revoking *this* machine's session is the same `401` path |
| O1 — the admin revokes any person's session | `src/settings.ts` `personItem` (Devices toggle) + `togglePersonDevices`/`revokePersonSession`; `backend/main.ts` `'people.sessions'`/`'people.revokeSession'` (both in `ADMIN_ONLY`) → `backend/host-admin.ts` `sessions`/`revokeSession` `execucao` (the admin lists and revokes another person's device in test/host-admin.test.ts) | the People tab reads one person's rows on demand and revokes one of them; the page never offers the card without a host |
| O1 — local mode: the card is hidden | `src/settings.ts` `viewAccount` (`if (hasHost())`), `readOwnSessions` (returns `[]` for `none`) `leitura` | `host.state` answers `none` without a `host` row, so no card is drawn and no session method is called |
| O2 — an older app is told to update and keeps working read-only from cache | `backend/sync.ts` `runOnce` (`refreshMinVersion` → `updateRequiredNow()` → `publish()` before the outbox), `state()` (`updateRequired`, `minAppVersion`); `src/app.ts` `renderUpdateRequiredNotice` `execucao` (7 tests in `describe('minimum app version (O2)')`) | with the host above this build, the run makes no write request, no event batch and no snapshot read; the outbox and the pending events stay; the state is `connected` (the host answered) with `updateRequired: true`, and the banner is persistent |
| O2 — nothing is pushed while too old | `backend/sync.ts` `runOnce`; `backend/main.ts` `HOST_WRITES` + `requiresUpdate()` in `guarded()` `execucao` (the sync tests assert `calls.request` empty and `calls.snapshot === 0`) | the sync pushes nothing, and every method that writes to the host answers the English `UPDATE_REQUIRED_ERROR` before anything leaves the machine; the person's writes through the outbox are covered by the same stop |
| O2 — a newer app is normal | `backend/sync.ts` `updateRequiredNow()`; the tests read `updateRequired: false` and a full run `execucao` | equal, newer, an unreadable minimum and a host with no meta route all leave the run as it was |
| O2 — a newer Nod restores the writes by itself | `backend/sync.ts` (`minAppVersion` is re-read on every run, `observeMinVersion` on every discovery) `execucao` | a host that lowers its minimum (or an app that is upgraded and restarted) resumes the pushes on the next run, without a restart of the host or a re-join |
| O2 — the host-served manifest URL is used by the update check | **Not met — the runtime cannot take a URL** (finding 1 below); the built-in channel is kept. The value is read (`AppMeta.update` arrives with the same call that carries the minimum) and deliberately not stored | `nod.checkUpdate` and `nod.installUpdate` both go through `app.update.check()`/`install()`, which read the `update.url` of `tinyjs.json` captured when the app was created |

## Commands run and observed results

Only the files this slice touches were run — no `bun run typecheck`, no full `bun test`, no
formatters, no smoke (the orchestrator runs the gates once at the end of the phase).

```
$ bun test test/version.test.ts
6 pass, 0 fail, 30 expect() calls — Ran 6 tests across 1 file. [76.00ms]

$ bun test test/sync.test.ts
41 pass, 0 fail, 213 expect() calls — Ran 41 tests across 1 file. [153.00ms]

$ bun test test/host-client.test.ts
31 pass, 0 fail, 84 expect() calls — Ran 31 tests across 1 file. [127.00ms]

$ bun test test/host-admin.test.ts
16 pass, 1 fail, 142 expect() calls — Ran 17 tests across 1 file. [3.08s]
  (fail) F1 — a join whose email is already an account of this Nod >
         with the choice made and the account unlocked, the join adopts it and the credential comes along
         error: the vault is locked — unlock with your password first
         at requireVaultKey (backend/vault.ts:85) ← test/host-admin.test.ts:800 (vault.save)
```

The one failure is **not this slice's**: `backend/vault.ts` is being rewritten in this same phase
(the `vaultKey` dependency, `git diff backend/vault.ts`) by the vault-encryption slice, and that
harness does not pass the new dependency yet. It fails at `vault.ts`'s own `requireVaultKey`, on a
`vault.save` line this slice never touches; before the vault rewrite the same test passed. Reported,
not worked around: freeing it is either that slice's test update or the orchestrator's gate.

The three new O1 tests (real host, real routes, real client) and the 8 O2 tests (scripted connection)
did run and pass, as did the 4 new client tests on the fake host and the 6 on the pure helper.

## Findings and decisions for the coordinator

1. **Finding — the update check cannot be pointed at the host's manifest at runtime, so the
   built-in channel is kept.** `nod.checkUpdate` is `app.update.check()`, and tinyjs fixes the URL
   when the app is created: `~/.tinyjs/runtime/bridge.js:2586`
   (`check: () => checkForUpdate({ url: update?.url, version })`, with `update` the `update` key of
   the generated `tinyjs.json`) and `backend/tiny.d.ts:1077-1079` (`check(): Promise<…>` — no
   argument). So "the Nod's update check uses `AppMeta.update.url` while connected" is not reachable
   from this side, and the built-in source stands (`backend/main.ts` `startUpdateWatch`,
   `refreshUpdateNotice`). The value is still read on every run (`backend/sync.ts`
   `refreshMinVersion` holds only `minAppVersion`; `AppMeta.update` is dropped on purpose rather than
   kept as dead state). Options for the owner, none of them this slice's to take: the runtime gains
   an argument, or the Nod implements the check *and* the install itself from the manifest — which
   puts one manifest in two homes, and `install` verifies the sha256 and the signature today
   (`docs/distribuicao.md` §6), so a second implementation would have to carry that too. In the
   deployment `docs/distribuicao.md` §8 describes, both channels point at the same file
   (`https://github.com/…/releases/latest/download/manifest.json`), which is what makes the
   difference a finding and not a broken acceptance item.
2. **Decision — "read-only from cache" also stops the snapshot read.** While `updateRequired`, the
   run stops *before* `GET /v1/state`, not only before the writes: the reason a host serves a
   minimum version is that an older build may not read a newer snapshot, and applying one would
   change the cache the sentence says the Nod keeps working from. The state still says `connected`
   when the host answered — the guild is reachable, this Nod is what is behind. If the owner wants
   the read half to continue (a snapshot that only ever adds fields is harmless), the change is one
   line in `runOnce`.
3. **Decision — `session.changePassword` is in `HOST_WRITES`.** With a host it rewrites the salt and
   the hash there first (SP02 §7), so while too old the call is refused whole: the local change
   travels with the host's, and a half-applied password change would leave the two disagreeing. A
   person who wants it can update and change it after.
4. **Finding — the "this device" marker is not determinable, and the card does not fake one.** The
   host answers no identifier for the calling session: `POST /v1/auth/login` answers `{ token,
   personId }` only, and `DeviceSession.id` is the host's row, which the Nod never learns. The only
   local clue is the device tuple (`deviceOf()` → `${os} ${arch}` + the app version), identical on
   every machine of the same OS and arch — a person with a laptop and a desktop of the same kind
   would see two rows labelled alike. Marking one of them would be a guess. A real marker needs a
   spec-side field (`DeviceSession.current: true`, or a `sessionId` in the login answer); reported
   for the owner, who owns SP03 §2.
5. **Decision — an unreadable `minAppVersion` leaves the Nod syncing.** `shared/version.ts`
   `compareVersions` answers `0` for a text that is not a version (`test/version.test.ts` pins
   `latest`, `1.2.3.4`, `1.x.0`), so O2's gate stays shut. The host's boot refuses such a value
   (H7's `loadAppMeta`; `docs/handovers/h7-o1-o2-host.md` decision 8 already notes the asymmetry):
   strictness at the deployment, tolerance at the client. The two are deliberate, and the Nod's half
   is the one that would lock a whole guild out of its own writes if it guessed instead.
6. **Hand-off for B7 (personal tools and favorites).** The person's writes of block 2 reach the host
   through the outbox (`SP04 §4`), which the O2 gate already stops, so a screen that only calls a
   `personal.*` method that queues the write needs nothing from this slice. If B7 lands a method that
   writes to the host *directly*, its name belongs in `HOST_WRITES` (`backend/main.ts`) —
   `backend/context.md` now says so in its Rules.
7. **Note — the fingerprint helper's duplication is unchanged.** `backend/host-client.ts`
   `fingerprintOf` still carries its own base32 copy beside `shared/host-api.ts`'s private one (the
   finding in B1's handover). This slice did not touch it.

## What was left out

- **The host's half of O1 and O2** — H7's slice, in `docs/handovers/h7-o1-o2-host.md`.
- **A "this device" marker** (finding 4): not determinable from the contract as it stands.
- **Repointing `update.install()`** at the host's manifest (finding 1): a runtime limitation, not a
  choice of this slice.
- **The smoke and the gates**: `bun run typecheck`, the full `bun test` and the two smokes were not
  run here; nothing in `test/smoke/` was touched, and neither smoke sets `NOD_MIN_APP_VERSION`, so
  the host's `0.0.0` default leaves the O2 gate out of their way (`host/config.ts`).
- **`docs/specs/`**: SP03 §2's table, SP04 §1/§3 and SP05 §3 are the owner's; this slice follows
  them and reports the two places they are silent (findings 1 and 4) instead of editing them.

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, its owner's: files touched, the
acceptance and how each item was met, how it was obtained, and what was left out). The state of #27
and #28 is the GitHub issues; this file closes nothing and decides no spec.

## Owner decision 2026-10-17 — the disconnected guild (replaces the read-only reading of O2)

The owner decided issue #28 on 2026-10-17 (`docs/canonico.md` §22, row "Nod older than the host's
`minAppVersion`", **Decidido**): a Nod below the host's minimum **does not connect** — no sync, no
host call but the discovery and `GET /v1/meta/app`, no join and no sign-in, and nothing from the
cached snapshot shown. It runs on its local catalog, keeps the `host` row, the bearer and the cache
on disk untouched, and shows the update banner until it is updated. That replaces this file's
decision 2 ("read-only from cache") and the sentence the banner used to carry.

| File | What changed |
| --- | --- |
| `shared/catalog.ts` | **New** `CatalogMode` + `catalogMode(hasHostRow, updateRequired)`: the one place that says which catalog a Nod serves — the snapshot's only while a `host` row exists **and** the app is not older than the minimum. |
| `shared/version.ts` | **New** `tooOldFor(appVersion, minAppVersion)`: the gate's predicate (`null` on either side is no verdict). `backend/sync.ts`, `backend/main.ts` and their tests read it instead of comparing inline. |
| `backend/sync.ts` | `updateRequiredNow()` is `repo.hostRecord() !== null && tooOldFor(...)`; `runOnce` ends after `refreshMinVersion` (as before) and its comments say what the state now means: the guild is disconnected and the run re-reads the minimum, which is the whole of what restores it. |
| `backend/main.ts` | The O2 rule grew to the whole call surface: `HOST_READS` (new) + `HOST_WRITES` behind one guard (`hostReadRefused` next to `hostWriteRefused`), `host.revokeSession` moved into `HOST_WRITES`; `guildConnection()` (the former `keysConnection`) hands the key publish, the shares, the guild icon **and** the admin routes a `null` connection while disconnected; `refreshConnectedCatalog()` derives `connectedMode` from `catalogMode` and reports a mode that moved as a change (so the page re-reads the catalog on the transition, both ways); `snapshotBody()`, `leftoverTools()`, `vault.list` (no `decorate`), `shares.inbox`, `shares.recipients`, `assignments.missing` and `peers.list` answer empty; `host.presence` answers `[]`; `keys.mine` stays what it always was (this machine's own pair, read from `meta` and the keychain — it never reaches the host, so there is nothing to hide); **new exported `beginAuth`** is the prologue `host.activate` and `host.signIn` run — the discovery, the `minAppVersion` gate over it, and only then the salt request — so a Nod the guild's minimum is above sends no code, no `authKey` and no password. |
| `src/app.ts` | The banner: `… needs a newer Nod (X or newer). Update to reconnect — the guild stays disconnected until then.` (no "read-only from its cache"). |
| `src/settings.ts` | `hasHost()` and `sharing()` are false while the guild is disconnected, so Account (devices, fingerprint, colleagues), the People tab's Devices, Activity's host counters, the vault's inbox/holders/scope cards and the send/assign dialogs are the local-mode ones; the Hosts tab keeps the guild's card and now says on it why the guild is disconnected; the guild-icon card, the publish offer and the leftover offer are not drawn (`host.revokeSession`, `host.bootstrap` and `host.adoptLocalAsPersonal` are refused). |
| `test/catalog.test.ts` | 4 tests: `catalogMode` and the catalog each half of the switch answers — local below the minimum (the `host` row staying), the snapshot's at and above it, local with no row at all. |
| `test/join.test.ts` | **New.** 4 tests over `beginAuth` with a scripted discovery and connection: too old → refused with `update required — this guild needs a newer Nod`, no request out and no connection built, the minimum still observed; equal/newer/unreadable/a runtime without a version → the salt call goes out and the prologue answers. |
| `test/sync.test.ts` | The O2 describe now says the guild is disconnected; the push-nothing test also pins `calls.meta === 1` and that the whole `host` row is byte-identical after the run. |
| `test/smoke/ui-driver.ts` | `admin-final` creates one org tool the admin's machine never had locally (`catalog.save`, `Guild Only`); #28 asserts the new banner (it says `disconnected`, it does not say `read-only`), that the guild's tool left the sidebar, that the personal tool of the snapshot left with it, that the local `Tool A`/`Tool B` are what is shown, and that the host's card carries the reason. |
| `docs/specs/` | SP03 §3 (the meta row + what a too-old Nod may call), SP04 §3 (the version gate rewritten), SP05 §3 (`HostState`'s two fields + the disconnected-guild bullet). |
| `backend/context.md` | The O2 rules (the call surface and the connection) and the `sync.ts`, `connected-catalog.ts` and `main.ts` rows. |

Not changed: `host/**` (nothing of the host's side moves: the deployment already serves the minimum),
`backend/sync.ts`'s push-nothing behavior (it was already the gate; what changed is what the rest of
the Nod does with it), `backend/repo.ts` (no new column and no migration — the disconnected state is
derived, and nothing on disk is touched), `shared/host-api.ts`.

Commands run and observed (this change's own files and the three smokes; no `typecheck`, no full
`bun test`, no formatter):

```
$ bun test test/catalog.test.ts test/join.test.ts test/sync.test.ts test/version.test.ts
114 pass, 0 fail, 394 expect() calls — Ran 114 tests across 4 files. [191.00ms]

$ bun test/smoke/ui.ts --force
ok     #35 holders list and admin card (106 ms) both people hold Tool A with date and scope; the admin card lists it
ok     #30 changed colleague key (102 ms) the changed key is shown, Confirmed and the warning clears
ok     #27 admin sees the person devices (102 ms) 1 device row(s) with Revoke
ok     #28 update-required banner (279 ms) banner: UI Smoke Guild needs a newer Nod (9.9.9 or newer).
       Update to reconnect — the guild stays disconnected until then.Check for updates;
       sidebar 4 → 2 tool(s), guild tool gone
ui smoke: ok (8 phase(s))

$ bun test/smoke/connected.ts --force
connected smoke ok: 14 phases, 111 steps, … plaintext hits: 0

$ bun test/smoke/run.ts --force
export: ok 14 event(s), no secret
kdf vectors: ok 3 vectors matched …
seal vectors: ok 2 vectors matched, 6 tampered refused …
smoke ok: 14 steps
```
