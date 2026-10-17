# Slice K10 (smoke) — block 2 end to end in the connected smoke

Owner: the **smoke** half of K10 (issue #38, `/tmp/nod/issue-38.md`), the last story of block 2
("Mine and shared"). The rest of the block landed in the slices the coordinator listed
(`h7-o1-o2-host.md`, `k3-host-shares.md`, `v1-vault.md`, `b7-personal.md`, `o1-o2-nod.md`, `b8b.md`,
`k1-k2-keys.md`, `k4-k6-shares-core.md`, `k5-k7-shares-ui.md`, `k8-assign.md`, `k9-rotation.md`);
this slice drives them on the real surface.

Contracts followed: `docs/specs/SP06-credential-sharing.md` §4 (the flows and the gate), §5 (the
three scopes) and §6 (the acceptance, the no-plaintext dump and the holders); `SP02-auth-and-keys.md`
§9 (the gate and its password fallback) and §6 (the verifier); `SP05-nod-connected.md` §2 (the
effective catalog), §3 (the personal writes), §4 (the sidebar order), §5 (the phases) and §6 (the
guild icon); `SP04-sync.md` §2 (the snapshot's personal half, `holders`, `rotationPending`);
`docs/canonico.md` §22 (one key pair per person across machines) and §11 (the reveal countdown);
`AGENTS.md`, `test/context.md`, `backend/context.md`.

## Files touched

| File | What changed |
| --- | --- |
| `backend/main.ts` | **The K5 gate's factor** (SP02 §9): the new exported pure `GateFactor`/`gateFactor(password, biometrics)` — a non-empty password the call carries is always the factor, biometrics only when it carries none, `unavailable` (the `authentication required` refusal) when there is neither — and `authenticate` rewritten around it: the password is verified against the unlocked person's verifier (`verifyStoredPassword`) *before* the biometric branch is even considered, so a person who cancels the operating system's prompt can type the password instead. Nothing else in the file moved. |
| `test/gate.test.ts` | **New.** One test on `gateFactor`: the password wins wherever the machine has biometrics, no password means biometrics, and neither means the refusal. Reaches `backend/main.ts` through the dynamic import with the `tjs:sqlite` stub `test/personal.test.ts` uses (the module reads the built-in at import time). |
| `test/smoke/connected.ts` | Four app ids instead of two (`...smoke-person2` = the second member of `team`, `...smoke-admin2` = the admin's second machine), `APP_IDS` for the wipes; **a free dev port per launch and a page file named after the launch's nonce** (a fixed port or a fixed page path let a `tinyjs dev` a previous smoke left behind serve, or reload, the wrong launch — see finding 3); `Phase`'s union and `PHASES` grow to the fourteen phases below; the page config gains `originB`, `originC`, `otherEmail`, `secrets` (the values the sharing steps write) and `notes` (the desk note of each fingerprint); the desk gains a second access code (`who: 'person' | 'other'`) and the note channel (fingerprints only — public digests); `hostRows` prints the personal entries, favorites, shares, live holders and assignments; the new `hostPlaintext(needles)` asks **every text column of every table** of `host.db` for the username and the secrets of the run and prints counts only; `personVault` gains the accepted item's `credential_id`/`scope`; the new `machinePersonalRows(appId)` reads the second machine's own `tool` table; `main` asserts the host's personal/favorites counts, the two vault facts, the second machine's zero personal rows and the no-plaintext dump. |
| `test/smoke/connected.html` | The header lists the fourteen phases; `CONFIG.secrets`/`CONFIG.notes`/`originB`/`originC`/`otherEmail` drive the new steps; **every gated call now carries `password: ACCOUNT_PASSWORD`** (`vault.reveal` in F1's step, `vault.copy`, `shares.send`, `shares.accept` of a send/assign, `assignments.set`, `assignments.sealMissing`); the new steps of the personal half (save/favorite/sync/read-back on both machines), the pins (`peers.list` against the fingerprints the other machines reported), the send/accept/reveal/copy/holders path, the assignment, the update, the rotation and the second machine's sign-in; `stepCreateOther` and the two-code `stepHandOver`; `stepRevokeHolder` resolves its ids itself (a phase is its own launch). |
| `test/context.md` | The connected smoke's row, the block 2 proof row, the four app ids, the fourteen-phase table and the runner's checks (the dump of `host.db` included). |
| `docs/handovers/k10-smoke.md` | This file. |

**Not edited on purpose**: `test/smoke/run.ts` and `smoke.html` (the local smoke calls no gated
method — checked — and its subject is block 1); `host/**`; `backend/shares.ts`, `backend/session.ts`,
`backend/keys.ts`, `backend/vault.ts`, `shared/**`, `src/**` — other owners' files, and none of them
needed a fix for the smoke to pass (see the findings for the two product observations, neither of
which this slice may patch).

No new dependency, no new file outside the repository's test/handover conventions, and a run writes
only under `test/smoke/.gerado/` (the `--force` contract moves and restores `resources/seed.json`;
`clean()` wipes the four app data dirs and the temp host data dir).

## The fix the smoke needed (SP02 §9)

`bun test/smoke/connected.ts --force` hung at step `2.4c` (180 s) on macOS: `vault.reveal` is gated
since K5, and `authenticate` asked `app.authenticate` (the Touch ID dialog) **whenever the machine
has biometrics**, whatever the call carried — and the smoke passes no password, so nobody answered
the dialog. The same would happen to any page that lets the person cancel the prompt and type the
password, which is exactly what SP02 §9 describes ("calls `app.authenticate` each time, or asks for
the password where biometrics are unavailable" — the fallback the owner asked for).

The fix is in the product, not in the smoke: `gateFactor` decides the factor from the call and the
machine, and a password the call carries is verified against the unlocked person's verifier before
the biometric branch. `test/gate.test.ts` pins the decision without a runtime. The smoke then passes
`ACCOUNT_PASSWORD` to every gated call — on a machine with biometrics it would otherwise still open
the prompt, which is the behaviour the fix makes *optional* rather than mandatory.

## Acceptance — how each item was met

`execucao` = run and observed. Commands and their output are in the next section.

| Item (issue #38 / the assignment) | How | Evidence |
| --- | --- | --- |
| Two-instance smoke covers personal tools/favorites across machines | The admin adds a personal tool on an origin no seed carries (`personal.saveTool`, Tool C's address) and favorites it; the sync takes both up to the host (the runner counts 1 personal entry and 1 favorite row in `host.db`); a later launch of the same machine reads them out of the snapshot; and the **second machine of the same person** (`host.signIn` on a wiped data dir) finds the tool with `ownerId === me` and the favorite leading `catalog.list` — with **no local `tool` row** for it, which is what proves the snapshot was the carrier. The other person's machine sees neither (`3.6b`). | `ok 2.15 … personal tool p-… saved on this machine`, `ok 2.16 … the list is [p-…] and it leads the order`, `ok 2.17 … nothing pending`, `ok 7.2 the snapshot carries the personal tool and the favorite: p-… leads`, `ok 13.3 the personal tool and its favorite came with the snapshot (p-… leads)`, `local personal rows: 0 (expected 0: the snapshot carries the personal tool)` |
| …send/accept/assign/update/revoke | `7.3`–`7.8` (save, scope `role`, `shares.send` to both members, the assignment to `team`), `8.x`/`9.x` (inbox, accept, reveal, copy, holders), `10.x` (the owner's new secret), `11.x` (the sync applies the update with no gate), `12.x` (`removeHolder` → `rotationPending` → the save that clears it). | the fourteen phases, 111 steps, all `ok` |
| The host's `host.db` holds no username or secret (SP06 §6, RF-44) | The runner asks every text column of every table for the username and the three secrets this run wrote (`LIKE`), and prints the counts of tables, columns and hits. | `tables read: 15, columns scanned: 101` / `plaintext hits: 0` |
| P's fingerprint visible in the admin's `peers.list` as pinned | Each machine reports its own `keys.mine` fingerprint to the desk; the admin's `peers.list` must show both members `pinned` **with exactly the fingerprint that machine reported** (and `shares.recipients` must then allow both). | `ok 7.1 the first member pinned PW7G-GAHW-64…; the second member pinned 4T90-VKTS-7R…` |
| The holders list shows both people (RF-54) | P's `vault.list` after the accept names the admin (owner) and P, each with `since` and `scope`; the admin's names all three. | `ok 8.6 both holders with date and scope (2 rows, owner Smoke Admin)`, `ok 10.3 both credentials hold the admin, Smoke Person and Smoke Other (3 rows each, no rotation)` |
| An update reaches a holder with no gate | `11.2` is a plain `host.syncNow`: the applied snapshot runs `shares.applyUpdates`, which accepts the update of a held credential with no password; `11.3` reveals the new value and `11.4` shows the host purged the share. | `ok 11.2 … the sync accepted the update of a held credential (no gate)` / `ok 11.3 the vault holds the value the owner saved last` / `ok 11.4 the inbox is empty` |
| Revocation of P stays last | The phases run …`admin-rotate`, `admin-second-machine`, `admin-revoke` (`people.revoke`), `person-signed-out` — the holder revocation of K9 is before it and P's last sync is still the doomed one. | `ok 4.9 status signed-out (lastError set)`, `ok 4.10 the org tools are gone from the cache (0 entries left)` |
| Nothing printed is a code, a token, a password, a secret or a sealed blob | Grepped both runs' logs for the password and the three credential values: 0 matches. The desk carries fingerprints (public digests); the runner prints counts, booleans and digests only. | `grep -c 'smoke-share-secret\|smoke-share-user\|smoke-local-secret\|smoke-connected-1' <log>` → `0` |
| Docs updated to what was built | `test/context.md` (the smoke's row, the four app ids, the phase table, the runner's checks) and this file. | — |

## Commands run and observed results

```
$ bun test test/gate.test.ts
 1 pass
 0 fail
 6 expect() calls
Ran 1 test across 1 file. [82.00ms]
```

```
$ bun test/smoke/connected.ts --force
private seed moved to …/test/smoke/.gerado/seed.json.bak
local tools: A=http://127.0.0.1:61870 B=http://127.0.0.1:61869 C=http://127.0.0.1:61871 (fake servers, loopback only)
smoke app data wiped before the run (4 app ids)
host up on 127.0.0.1:61872
setup code issued by host/cli/setup-code.ts (19 chars, not printed)
contract: publish=host.bootstrap body=false, person=invites.issue email=true
guild icon fixture: …/resources/tray.png (304 bytes, sha256 24f0b734d647…)

phase admin-publish (app id copland.nod.smoke-admin, dev port 64539)
ok     2.14 keys.mine (this machine's pair, K1) (4 ms) this machine holds a pair: fingerprint SXRX-NQRD-YK… (reported to the desk)
ok     2.15 personal.saveTool (B7) (1 ms) personal tool p-xp36jzywh9 saved on this machine (own origin, no view)
ok     2.16 favorites.list/set (the star, SP05 §4) (1 ms) favorited: the list is [p-xp36jzywh9] and it leads the order
ok     2.17 host.syncNow (the personal half goes up) (20 ms) status connected; the personal tool and the favorite went up (nothing pending)

phase person-join (app id copland.nod.smoke-person, dev port 64652)
ok     3.6b catalog.list/favorites.list (the personal half is mine, B7) (1 ms) no personal tool and no favorite of another person (2 entries)
ok     3.9 keys.mine (this machine's pair, K1) (7 ms) this machine holds a pair: fingerprint PW7G-GAHW-64… (reported to the desk)

phase person2-join (app id copland.nod.smoke-person2, dev port 64713)
ok     3q.6 keys.mine (this machine's pair, K1) (4 ms) this machine holds a pair: fingerprint 4T90-VKTS-7R… (reported to the desk)

phase admin-share (app id copland.nod.smoke-admin, dev port 64539)
ok     7.1 peers.list (both members pinned, K2/RF-45) (7 ms) the first member pinned PW7G-GAHW-64…; the second member pinned 4T90-VKTS-7R…
ok     7.2 catalog.list/favorites.list (the personal half, B7) (1 ms) the snapshot carries the personal tool and the favorite: p-xp36jzywh9 leads
ok     7.3 vault.save (the credential to share, K4) (23 ms) the credential of tool-a saved (value only in the keychain)
ok     7.4 vault.setScope/shares.recipients (role, K6) (2 ms) scope role: both members of team are recipients (["Smoke Other","Smoke Person"])
ok     7.5 shares.send (one copy per member, K4) (380 ms) one sealed copy per member (2), nothing printed
ok     7.6 host.syncNow (the holders, K7) (16 ms) the owner holder row is the admin (1 row(s) so far)
ok     7.7 vault.save (the credential to assign, K8) (6 ms) the credential of tool-b saved for the assignment (value in the keychain)
ok     7.8 assignments.set/missing (role team, K8) (396 ms) role team assigned; 2 member(s) without a copy yet, both pinned

phase person-share (app id copland.nod.smoke-person, dev port 64652)
ok     8.3 shares.inbox (the send and the assign, K4) (1 ms) two open shares: a send of tool-a and an assign of tool-b (metadata only)
ok     8.4 shares.accept (the send, gated, K4) (421 ms) accepted: the copy is in the vault under the credential its sender owns
ok     8.5 vault.reveal (the sender's value, K5) (369 ms) revealed behind the password: the sender's own value (not printed)
ok     8.5b vault.copy (the same gate, the clipboard, K5) (370 ms) copied through the gate: the answer is true, and the value never came back to the page
ok     8.6 host.syncNow + vault.list (both holders, K7/RF-54) (9 ms) both holders with date and scope (2 rows, owner Smoke Admin)
ok     8.7 shares.accept (the assign, gated, K8) (384 ms) the assigned copy is in the vault (tool-b)

phase person2-accept (app id copland.nod.smoke-person2, dev port 64713)
ok     9.4 shares.accept (the send, gated, K4) (382 ms) accepted: the copy is in the vault under the credential its sender owns
ok     9.5 vault.reveal (the same value, K4) (368 ms) revealed behind the password: the sender's own value (not printed)
ok     9.6 shares.accept (the assign, gated, K8) (378 ms) the assigned copy is in the vault (tool-b)

phase admin-update (app id copland.nod.smoke-admin, dev port 64539)
ok     10.3 vault.list (three holders, K7) (4 ms) both credentials hold the admin, Smoke Person and Smoke Other (3 rows each, no rotation)
ok     10.4 vault.save (the owner's new secret, K9) (41 ms) the owner saved a new secret; the update went out to both holders (no warning)
ok     10.5 assignments.missing/sealMissing (nothing missing, K8) (425 ms) nothing is missing: the gated seal had nothing to send

phase person-update (app id copland.nod.smoke-person, dev port 64652)
ok     11.2 host.syncNow (the update applies, no gate, K9) (18 ms) status connected: the sync accepted the update of a held credential (no gate)
ok     11.3 vault.reveal (the new value, K9) (435 ms) the vault holds the value the owner saved last (not printed)
ok     11.4 host.syncNow (the share is purged) (11 ms) the inbox is empty: the host purged the share the sync accepted

phase admin-rotate (app id copland.nod.smoke-admin, dev port 64539)
ok     12.3 shares.removeHolder (P, RF-48) (19 ms) the holder was revoked and the credential is rotation pending (3 row(s) kept)
ok     12.4 vault.save (the rotation clears, K9) (51 ms) the new secret reached the remaining holder and cleared the rotation

phase admin-second-machine (app id copland.nod.smoke-admin2, dev port 64968)
ok     13.1 host.discover/host.signIn (SP05 §5.3) (892 ms) signed in as the guild admin on a second machine of the same person
ok     13.2 keys.mine/host.syncNow (the pair is the person's, canonico §22) (35 ms) the same pair as the first machine (adopted, nothing published): 2QPH-NTQX-4N…
ok     13.3 catalog.list/favorites.list (the personal half, B7) (1 ms) the personal tool and its favorite came with the snapshot (p-4w50586a7b leads)

host rows after the run:
  people: 3
  roles: 2
  org entries: 2
  grants: 2
  personal entries: 1
  favorites: 1
  shares: 7
  live holders: 5
  assignments: 1
  events of person@smoke.test: 15 (account_created×1, credential_saved×1, locked×1, login×2, seed_applied×1, tool_opened×5, unlocked×4)

P's vault rows after the run:
  vault items: 2
  item of tool-a: origin "http://127.0.0.1:62280" (expected "http://127.0.0.1:62280")
  local tool-a rows in tool: 0 (expected 0)
  item of tool-a: credential yes, scope "role" (expected "role")

the admin's second machine, own rows after the run (B7):
  local tool rows: 2
  local personal rows: 0 (expected 0: the snapshot carries the personal tool)

the host's own database, asked for the run's credentials (SP06 §6):
  tables read: 15, columns scanned: 101
  plaintext hits: 0

connected smoke ok: 14 phases, 111 steps, admin-publish:26 person-join:20 person2-join:6 admin-clear:2 person-cleared:3 admin-share:11 person-share:9 person2-accept:7 admin-update:5 person-update:4 admin-rotate:4 admin-second-machine:3 admin-revoke:7 person-signed-out:4
private seed restored
tinyjs.json regenerated in dev
smoke app data wiped (4 app ids) and the temp data dir removed
```

`exit=0`, ≈ 51–55 s of wall time (the same run repeated back to back with the local smoke: `72.55 s`
for both). The phases not quoted above are the ones the slice before this one already carried (the
F1 adoption, the offline/online pair of SP05 §5.5, the two guild-icon phases, `people.revoke`), and
they passed unchanged.

```
$ bun test/smoke/run.ts --force
ok     1 session.state (2 ms) no account and locked
… 14 steps, all ok …
export: ok 14 event(s), no secret
kdf vectors: ok 3 vectors matched in 375 ms (/Users/caio/.tinyjs/bin/tjs)
seal vectors: ok 2 vectors matched, 6 tampered refused in 16 ms (/Users/caio/.tinyjs/bin/tjs)
smoke ok: 14 steps
private seed restored
tinyjs.json regenerated in dev
```

`exit=0`, ≈ 24 s. The local smoke was run because the gate fix lives in the backend both smokes
drive; it calls no gated method, so nothing of it changed.

**Stability, after the launch hygiene fix (finding 3):** the two smokes were then run in one
sequence — `run.ts` × 3, `connected.ts`, `run.ts` — and every one exited `0` with no `FAILED` line
(`smoke ok: 14 steps` four times, `connected smoke ok: 14 phases, 111 steps`), `138 s` for the five.
The earlier `hasAccount = true` failure of `run.ts` did not reproduce, which matches its cause: a
`tinyjs dev` of a previous run that had not died yet.

**Not run**: `bun run typecheck`, the repo-wide `bun test`, any formatter (the process rule of this
phase). The two smoke files were parsed before the runs (`bun build` on the runner and on the page's
extracted `<script>`), which proves syntax and nothing else.

## Open findings

1. **`rotationPending` never clears when the last holder is revoked (`host/repo.ts:2028`, the
   `NOT EXISTS` on `shares` at `:2038`; `backend/shares.ts:651`).** The host clears the state only
   when it sees an `update` share from the owner created at or after the removal, and the Nod's
   `update` returns early — sending nothing — when there is no live holder left besides the owner
   (`backend/shares.ts:651`). So an owner who revokes their **only** holder and then saves a new
   secret keeps the credential "rotation pending" forever, while the new value has nowhere to go.
   This is why the smoke has a second member of `team` (Q): with P and Q holding the credential, the
   revocation of P leaves Q to rotate to, which is the flow SP06 §4 describes. **Not fixed here** —
   it is another slice's file and the fix is a reading decision (either the host stops asking for an
   update when no live holder is left, or the Nod sends an empty `update`), so it goes to the
   coordinator with this evidence.
2. **A fresh machine's sign-in reports the person as a non-admin until its first snapshot
   (`backend/main.ts:1700`).** `host.signIn` (and `host.activate`) build the local row with
   `admin: local !== null && local.admin`, and on a machine with no local account that is `false`;
   the snapshot's `me.admin` arrives with the first sync (`reconcileConnectedIdentity`). The page
   therefore sees `session.state.person.admin === false` for an admin right after the sign-in — the
   admin UI would hide its admin actions for that window. The smoke asserts the flag *after* the
   sync (step `13.2`) and says so in the step. **Not fixed here**: a one-line change in another
   owner's handler, and it self-corrects.
3. **A `tinyjs dev` a smoke left behind can be served, or can reload, the next smoke's page — and the
   two smokes shared dev port 5199.** Observed twice: `run.ts` failed at step 1 with
   `hasAccount = true` right after another smoke had run. The evidence is in the app data dir: the
   local account (`person@test`) had been created *during* the failing run, and `store.json` held
   `open_tools`/`last_person` beside a `smoke_result` whose step 1 failed — i.e. **two page
   executions with the same nonce**: the launch the runner spawned (which created the account and
   opened a tool) and a stale instance of the same app id, which reloaded the rewritten
   `test/smoke/.gerado/smoke.html` (the page file is a fixed path, and `tinyjs dev` reloads it when
   it changes) and wrote its own failing result over the other's. A clean re-run passes, and neither
   smoke's assertions are wrong; it is a launch-hygiene race.
   **Fixed**: `connected.ts` takes a free loopback port per launch and names each launch's page
   after its nonce, so a leftover process can neither hold the port nor reload the page; `run.ts`
   now does the same (free dev port per launch, page named `smoke-<nonce>.html`, the nonce carried
   in the page's config and matched by `waitForResult`), and the shared `freePort()` lives in
   `test/smoke/tools.ts`.
4. **The smoke puts the admin in `team`** (`2.12c people.setRoles`). SP06 §5's `role` scope needs a
   role in common with the sender, and the guild's admin shares with the team it is in — the
   alternative was to scope the credential `org`, which would have exercised a different row of the
   table. Recorded because it is a configuration choice a reader will wonder about.
5. **The `assign` seal and the missing list are one step apart in time.** `assignments.set` seals to
   the members the host lists as missing *at that moment*, and the list clears on the member's
   **accept**, not on the seal (K8's decision 1) — so `7.8` legitimately still lists both members and
   the later `10.5` sees an empty list. No product change; a reader of the phase may otherwise
   expect the list to be empty right after the seal.

## What was left out

- **B7's other real-surface item**: no step opens a personal tool window and captures media (the
  "not from your org" banner and the absence of a camera/mic grant). The banner is injected by
  `backend/tool-windows.ts` on load and the media grant is a `tinyjs.json` origin-gate decision, so
  neither is observable through `tinyjs.api.call`; B7's own handover records the same limit.
- **A member who joins `team` after the assignment** (the missing list and `sealMissing` with real
  work): `test/assign.test.ts` drives it against the real host app; the smoke's `sealMissing` call
  has nothing to seal and says so.
- **The key sync's other rows of canonico §22** (a reset replacing both halves, a password change
  re-sealing the blob without touching the publics): `test/keys.test.ts` covers them; the smoke
  covers the row that needs two machines.
- **`bun run typecheck`, the repo-wide `bun test`, formatters**: the coordinator's, per the phase's
  process rule.

## For other owners

- **Coordinator**: finding 1 (the `rotationPending` dead end) is a product decision, not a test
  problem; finding 2 is a small handler fix in `backend/main.ts`; finding 3 (the two smokes sharing
  dev port 5199 and the fixed page path) is closed — both smokes now take a free port and a
  nonce-named page, and `freePort()` is shared from `test/smoke/tools.ts`. `test/context.md` and this
  handover carry the block 2
  state of the smoke; the smoke's own output is the evidence.
- **K9's owner (`backend/shares.ts`)**: the smoke now depends on the update fan-out reaching a live
  holder and on `updateWarning` being `null`/absent on a successful save; both hold.
- **The page's owner (`src/settings.ts`)**: the gate's password fallback is now real in the backend
  (`backend/main.ts`), so the page's prompt path (`state.session.biometric === false`) is no longer
  the only way to pass the gate — a person with biometrics can type the password too, which is
  SP02 §9's fallback.
- **Whoever owns `host/repo.ts` next**: finding 1 names the exact query and the branch that makes the
  state unreachable-clear.

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, written by its owner: the files
touched, the acceptance and how it was met, the commands and the observations, and what was left
out). The state of the block is not declared here; the coordinator's handover carries it. The lines
the coordinator can grep for are `connected smoke ok: 14 phases, 111 steps` and `plaintext hits: 0`.

Follow-up on finding 3: `test/smoke/run.ts` now takes a free dev port per launch and writes its page
as `test/smoke/.gerado/smoke-<nonce>.html` (the nonce in the page's config, `waitForResult` matching
it), reusing `freePort()` from `test/smoke/tools.ts`; `bun test/smoke/run.ts --force` ran twice and
both passed (`smoke ok: 14 steps`, `kdf vectors: ok`, `seal vectors: ok`, seed restored).

## Review fixes — M3 (`docs/handovers/block2-review.md`)

The gate no longer decides on `session.biometric` (the per-person shortcut). `gateFactor(password,
biometrics, devRun)` (`backend/main.ts:934`) is now: where the runtime reports the `authenticate`
capability the factor is `biometrics`, and a typed password is a factor there **only** in a
non-release dev run; where the capability is absent the typed password is the only factor, as on
Linux before. `authenticate` therefore runs `app.authenticate` on every machine that has it, which is
the `docs/canonico.md` §22 decision ("gate where biometrics exist").

The dev exception (`docs/canonico.md` §22, "gate in a dev run", Proposto) is what keeps this smoke's
`ACCOUNT_PASSWORD` working. It is read from a **build-mode stamp**, never from the environment:
`scripts/gen-config.ts <dev|build>` writes `resources/build-mode` with the mode it was asked for
(`shared/build-mode.ts`), `backend/main.ts` reads it once at start-up (`readDevRun`,
`backend/main.ts:209`), and the stamp is deliberately not in `buildResources`' list — a release's
`"resources"` list stages only the files it names, so a built app finds no stamp and answers `false`
whatever the environment, the seed or the page say. `TINYJS_DEBUG='dev'` (the sentinel `tinyjs dev`
seeds) was rejected for exactly that reason: a release launched with it set would honour the
exception, and the coordinator's own debug runs set `TINYJS_DEBUG=1`, which loses that sentinel.

The page reads both facts from `nod.info` (`biometricAvailable`, `devRun`): `src/settings.ts`'s
`gate` sends no password where the capability exists outside a dev run (the fix), keeps the password
field where it does not (Linux, unchanged), and keeps it in a dev run so an unattended UI path still
has a way through — the hint above the field says which of the two it is. The enable-biometrics card
now uses the same capability instead of the `os !== 'linux'` proxy.

Tests: `test/gate.test.ts` pins the eight combinations of (password, capability, `devRun`) plus
`stampMode` (only the exact `dev` text opens the exception; no stamp, junk or `build` is a release).
`test/smoke/connected.html` is untouched and keeps passing `ACCOUNT_PASSWORD` — the backend takes it
because the run is a dev one, which is the whole point of the exception.

Spec: SP02 §9 rewritten with the rule and the Proposto dev exception.
