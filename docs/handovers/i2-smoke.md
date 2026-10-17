# Slice I2 — the guild icon end to end in the connected smoke

Owner: the implementation track's **smoke** slice of the guild icon (`test/smoke/`). The host side is
I2h's and the Nod side is I2b's; this slice only drives them, on the real app, against the real host.

Authorized by the coordinator's assignment in this session, on the same footing `h2.md`, `c1.md`,
`i2h-guild-icon-host.md` and `i2b-guild-icon-app.md` recorded: this repository has no `em-curso`
label, and there is **no guild-icon issue** among #1–#38 — the request is the owner's of 2026-10-16.
**Finding for the coordinator**: if this work needs a permanent record, it needs an issue; nothing
here can create one.

Contracts followed: `docs/specs/SP05-nod-connected.md` §6 (the file, the verification, the
preference, the four methods) and §5 (the phases and their order); `docs/specs/SP04-sync.md` §2
(`Snapshot.guildIcon` is inside the signed bytes, and the client keeps the fetched bytes only when
they hash to it) and §3 (the states a snapshot is applied on); `docs/specs/SP03-host-api.md` §1–§2
(`PUT`/`DELETE /v1/admin/guild/icon`, the `413`/`400` answers, the `{ sha256 }` body);
`docs/specs/README.md` (base64url without padding, lowercase hex for digests); the two handovers
above (what the app and the host actually answer). Rules: `AGENTS.md`, `test/context.md` and the
`--force` contract of `test/smoke/connected.ts` itself.

## Files touched

| File | What changed |
| --- | --- |
| `test/smoke/connected.ts` | The fixture `GUILD_ICON_PNG` (= `resources/tray.png`, the repository's own versioned 32×32 PNG, 304 bytes) and `GuildIconFixture` (`{ png, sha256 }`), read and hashed once in `main` with `shared/encoding.ts`'s `toBase64url`/`sha256Hex`; `Phase`'s name union and `PHASES` gain `admin-clear` and `person-cleared` (between `person-join` and `admin-revoke` — the only window in which the icon can be removed while P still syncs: after the revocation P's sync is the `signed-out` one); `generatePage`/`runPhase` carry the fixture into the page's config as `guildIcon: { png, sha256 }`; two runner-side readers, `personGuildIconFile(icon)` (the SHA-256 of `<app data dir>/guild-icon.png`, printed as 12 hex) and `personGuildIconGone()`, called in the phase loop right after `person-join` and right after `person-cleared`; the header comment lists the two new phases. One new import from outside the smoke: `GUILD_ICON_FILE` of `backend/guild-icon.ts` — the runner reads the constant instead of copying the string `'guild-icon.png'` (that module imports no runtime, so loading it is inert). |
| `test/smoke/connected.html` | The page's header lists the two new phases and the §6 steps; `CONFIG` carries `guildIcon`; six new steps in a `SP05 §6 — the guild icon` section — `stepSetGuildIcon` (uploads `CONFIG.guildIcon.png` and asserts the answer's `sha256` is the digest of exactly those bytes), `stepGuildIconSync`, `stepPersonGuildIconAvailable` (polls `nod.appIcon` until `guildIconAvailable === true`), `stepPersonAppIconGuild` (`nod.setAppIcon({ choice: 'guild' })` and the read-back), `stepClearGuildIcon`, `stepPersonGuildIconGone` (polls until `guildIconAvailable === false`); the `PHASES` map gains `6.1`/`6.2` at the end of `admin-publish`, `6.3`/`6.4` after `3.5` in `person-join`, and the two phases `admin-clear` (`6.5`, `6.6`) and `person-cleared` (`6.7`, `6.8`, `6.9`). |
| `docs/handovers/i2-smoke.md` | This file. |

**Not edited on purpose**: `backend/main.ts` and `backend/guild-icon.ts` — the wiring was not broken,
so nothing of another owner's slice needed a fix (the mandate allowed it in case a step failed; none
did). `test/smoke/run.ts` was not run; no project gate was run.

No new dependency, no new file under the repo besides this handover, and nothing outside
`test/smoke/.gerado/` is written by a run (the runner's own `--force` contract moves and restores
`resources/seed.json`, and `clean()` wipes both smoke data dirs and the temp host data dir).

## Acceptance criterion — how each item was met

Command run: `bun test/smoke/connected.ts --force`, exit `0` (`execucao`). The log quoted below is a
verbatim extract of that run; a previous run of the same command was green too (same six phases, 53
steps).

| Item | How it was met | Evidence |
| --- | --- | --- |
| The PNG uploaded is small and valid | `GUILD_ICON_PNG` is `resources/tray.png`, the repository's own versioned 32×32 RGBA PNG (304 bytes, `docs/arquitetura.md` §1) — the tray's icon, so the smoke invents no bytes and copies no constant. The runner hashes exactly what it read and hands the page the base64url of those bytes. | `guild icon fixture: …/resources/tray.png (304 bytes, sha256 24f0b734d647…)` |
| Admin phase: upload, then sync | `6.1` calls `host.setGuildIcon({ png })` and asserts the host's `sha256` equals the fixture's digest; `6.2` is the `host.syncNow` that brings the body carrying it. | `ok 6.1 host.setGuildIcon (the guild PNG) (9 ms) the host stored the PNG (406 base64url chars) and answered sha256 24f0b734d647…` / `ok 6.2 host.syncNow (the signed digest) (3 ms) status connected; the signed body carries the icon digest` |
| Person phase, before the revoke: after `host.syncNow`, `nod.appIcon` reports `guildIconAvailable: true` | `6.3`, right after `3.5 host.syncNow` in `person-join`. The fetch of the bytes is chained and not awaited (`backend/main.ts`), so the step polls `nod.appIcon` (20 s budget); in this run the bytes were already on disk — the join's own sync had fetched them. | `ok 6.3 nod.appIcon (guildIconAvailable) (0 ms) nod.appIcon reports guildIconAvailable true (choice "default")` |
| `nod.setAppIcon({ choice: 'guild' })` succeeds and `nod.appIcon` reads back `guild` | `6.4`: the call itself answers `choice: 'guild'`, and the following `nod.appIcon` reads `guild` with the icon still available (that call only succeeds while a verified icon is on disk — `backend/guild-icon.ts` refuses `guild` otherwise, which is what makes the step a proof and not a formality). | `ok 6.4 nod.setAppIcon (guild) (2 ms) the choice is guild and it reads back: {"choice":"guild","guildIconAvailable":true}` |
| Runner side, after the phase: P's data dir holds `guild-icon.png` whose SHA-256 is the uploaded PNG's, printing only the first 12 hex | `personGuildIconFile()` reads `<app data dir>/guild-icon.png` (the runner's own `dataDir(PERSON_APP_ID)`) right after `person-join`, before `clean()` wipes it, and compares the digest of the bytes on disk with the fixture's. This is the one link of the chain the page cannot see: the app wrote the file itself, so the runner is what names and opens it. | `P's guild icon file after the phase (SP05 §6):` / `  guild-icon.png: 304 byte(s), sha256 24f0b734d647… (the uploaded PNG's 24f0b734d647…)` |
| Optional: admin `host.clearGuildIcon`, person sync → `guildIconAvailable: false` and the file is gone | The two extra phases, placed between the join and the revocation: `admin-clear` (`6.5` unlock, `6.6` `host.clearGuildIcon`) and `person-cleared` (`6.7` unlock, `6.8` `host.syncNow`, `6.9` polls `nod.appIcon` until the guild icon is unavailable). The runner then reads the same file again after that phase. | `ok 6.6 host.clearGuildIcon (10 ms) the host dropped the icon; the next signed body says guildIcon null` / `ok 6.9 nod.appIcon (the guild icon is gone) (0 ms) guildIconAvailable false after the sync (the stored choice is still "guild")` / `P's guild icon file after the clear (SP05 §6):` / `  guild-icon.png: (gone)` |
| The smoke is green with the new steps, and the rest of it still is | `exit=0` and the runner's own summary: six phases, 53 steps (19 + 18 + 2 + 3 + 7 + 4), every phase's steps `ok` — including the ones the icon phases sit between (the join's `3.x`, §5.5's `5.x` with the host stopped and started, and the revoke's `4.x`). | `connected smoke ok: 6 phases, 53 steps, admin-publish:19 person-join:18 admin-clear:2 person-cleared:3 admin-revoke:7 person-signed-out:4` |
| The run leaves the repository as it found it | `clean()` ran: the private seed was restored, `tinyjs.json` regenerated in dev, both smoke data dirs and the temp host data dir removed. Checked afterwards: `resources/seed.json` back at 962 bytes, `test/smoke/.gerado/connected` gone, no `tinyjs dev` or `host/main.ts` process left. | `private seed restored` / `tinyjs.json regenerated in dev` / `smoke app data wiped (both app ids) and the temp data dir removed` (`execucao`, plus `ls`/`pgrep` after the run) |

## Command run and observed result

```
$ bun test/smoke/connected.ts --force
private seed moved to …/test/smoke/.gerado/seed.json.bak
local tools: A=http://127.0.0.1:50077 B=http://127.0.0.1:50076 (fake servers, loopback only)
smoke app data wiped before the run (both app ids)
host up on 127.0.0.1:50079
setup code issued by host/cli/setup-code.ts (19 chars, not printed)
contract: publish=host.bootstrap body=false, person=invites.issue email=true
guild icon fixture: …/resources/tray.png (304 bytes, sha256 24f0b734d647…)

phase admin-publish (app id copland.nod.smoke-admin, dev port 5199)
ok     2.13 host.syncNow (the grant travels) (3 ms) the snapshot carries the grant to team (tool-a (roles ["team"], 0 view(s)))
ok     6.1 host.setGuildIcon (the guild PNG) (9 ms) the host stored the PNG (406 base64url chars) and answered sha256 24f0b734d647…
ok     6.2 host.syncNow (the signed digest) (3 ms) status connected; the signed body carries the icon digest

phase person-join (app id copland.nod.smoke-person, dev port 5200)
ok     3.4 host.activate (access code) (846 ms) activated with the access code; the session is unlocked and P is not an admin
ok     3.5 host.syncNow (10 ms) status connected, guild Smoke Guild
ok     6.3 nod.appIcon (guildIconAvailable) (0 ms) nod.appIcon reports guildIconAvailable true (choice "default")
ok     6.4 nod.setAppIcon (guild) (2 ms) the choice is guild and it reads back: {"choice":"guild","guildIconAvailable":true}
… 3.6–3.8, 5.1–5.8 (unchanged: the granted tool, the vault, the fill, the host down/up) …
ok     5.8 host.syncNow (back online) (23 ms) status connected again; nothing is pending

P's guild icon file after the phase (SP05 §6):
  guild-icon.png: 304 byte(s), sha256 24f0b734d647… (the uploaded PNG's 24f0b734d647…)

phase admin-clear (app id copland.nod.smoke-admin, dev port 5199)
ok     6.5 session.unlock (admin) (395 ms) admin unlocked
ok     6.6 host.clearGuildIcon (10 ms) the host dropped the icon; the next signed body says guildIcon null

phase person-cleared (app id copland.nod.smoke-person, dev port 5200)
ok     6.7 session.unlock (P) (441 ms) P unlocked from the cache
ok     6.8 host.syncNow (guildIcon null) (24 ms) status connected, guild Smoke Guild
ok     6.9 nod.appIcon (the guild icon is gone) (0 ms) guildIconAvailable false after the sync (the stored choice is still "guild")

P's guild icon file after the clear (SP05 §6):
  guild-icon.png: (gone)

phase admin-revoke (app id copland.nod.smoke-admin, dev port 5199)
ok     4.1–4.6 … (unchanged: unlock, sync, events.syncStatus, people.revoke)

phase person-signed-out (app id copland.nod.smoke-person, dev port 5200)
ok     4.7–4.10 … (unchanged: signed-out, org tools gone)

host rows after the run: … (unchanged: 2 people, 2 roles, 2 org entries, 1 grant, 10 events of P)
P's vault rows after the run: … (unchanged: 1 item on the tool's origin, 0 local `tool-` rows)
the admin Nod's vault row after the adopt (F1): … (unchanged)
connected smoke ok: 6 phases, 53 steps, admin-publish:19 person-join:18 admin-clear:2 person-cleared:3 admin-revoke:7 person-signed-out:4
private seed restored
tinyjs.json regenerated in dev
smoke app data wiped (both app ids) and the temp data dir removed
```

Observed: output as above, `exit=0`, ≈ 22 s of wall time with the runner's own steps (the two extra
app launches cost ≈ 5 s; the smoke is a local-loopback run). The blocks marked "unchanged" are the
steps that were not touched — their lines are in the run, abbreviated here only for length.

## Decisions and findings for the coordinator

1. **The fixture is the repository's own PNG, not an invented byte string.** `resources/tray.png` is
   versioned, 304 bytes and a real 32×32 RGBA image, so the smoke uploads something a browser could
   actually open and nothing is duplicated from `test/smoke/tools.ts`'s 1×1 constant. The runner
   reads it before the phases and refuses to start without it (a missing fixture prints its path and
   returns 1). If the tray icon ever leaves the repository, this fixture moves with it — that is a
   one-line constant.
2. **Two extra phases, for one reason.** The removal can only be observed while P can still sync: the
   phase after the revocation syncs with a `401`, and SP04 §3's `clearOrgData` carries the cached
   body's `guildIcon` instead of dropping it (I2b's finding 6), so a revoked machine keeps the file
   and says nothing about a removal. `admin-clear` + `person-cleared` therefore sit between the join
   and `admin-revoke`; the runner-side file check for the *presence* of the icon stays with
   `person-join`, whose phase is the last one in which the file exists.
3. **The two `nod.appIcon` steps poll, and both answered on the first read.** `syncGuildIcon()`
   chains `icon.sync(hash)` without awaiting it (`backend/main.ts`), so the state the sync answers and
   the state of the file on disk can be one turn apart. Both steps use the page's existing
   `waitUntil` (20 s); in the observed run each needed a single read (0 ms), which is what the
   0 ms figures above are.
4. **The runner reads the file, the page never says where it is.** `personGuildIconFile` is the only
   read of an app data dir that is not a `bun:sqlite` one (`hostRows`/`adminVault`/`personVault` are
   the others), and it is deliberately placed inside the phase loop: `clean()` wipes both data dirs at
   the end of the run, so a check after it would read nothing.
5. **The step numbers say which spec section they exercise.** The new steps are `6.x` (SP05 §6) even
   though they run inside the phases of §5.2/§5.3/§5.4: `6.1`–`6.9` are the §6 story in the order it
   happens, and the phase each one belongs to is on the line above it.
6. **One import from outside the smoke.** `test/smoke/connected.ts` now imports `GUILD_ICON_FILE` from
   `backend/guild-icon.ts` instead of repeating `'guild-icon.png'`. The module imports no runtime
   (`tjs`, `tiny`, `bun:*`) — its dependencies are injected — so loading it from the runner is inert;
   the alternative was a second copy of a path the contract names once.
7. **Nothing of the app or the host needed a fix.** Every new step passed on the first run: the
   upload, the signed digest, the availability, the choice and its read-back, the removal, the
   deletion. `backend/main.ts` and `backend/guild-icon.ts` are untouched by this slice; the mandate
   allowed touching them only if a step had failed.

## What was left out

- **`test/smoke/run.ts`** (the single-instance smoke) and every project gate: not this slice's, and
  the mandate names only `test/smoke/connected.ts`. The only command run is the acceptance's own.
- **A check on the admin machine's own icon.** The admin's Nod fetches the bytes too (its `onState`
  runs the same `syncGuildIcon`), and its file is deleted by the clear's sync as well; the mandate
  asks for the person's, and the person's is the machine that chose the guild icon. Adding the admin
  side would prove the same wiring twice.
- **The Dock tile / taskbar icon itself.** The steps prove the two API surfaces and the file on disk;
  that the OS shows the PNG is `app.icon`'s own behavior (`docs/tinyjs.md` §6) and cannot be asserted
  from a page.
- **A `413`/`400` case for the upload.** SP03 §1–§2's refusals have their own host tests
  (`host/guild-icon.test.ts`); the smoke carries a valid PNG end to end, which is what it is for.
- **`bun run typecheck` and the repo-wide `bun test`**: the coordinator's, not run. `test/smoke/` is
  outside the root `tsconfig.json`'s `include` (`src`, `shared`), so the smoke is not in that gate
  either way; both changed files were parsed (`Bun.Transpiler` for the runner, `node --check` on the
  page's extracted `<script>`) before the run.

## What another owner must do

- **Coordinator**: the `em-curso` issue (see the top of this file). Nothing else — no name in
  `shared/types.ts`, no route and no file of I2b's or I2h's had to move for this slice.
- **I2b (Nod side)**: nothing. The four methods behave as `docs/specs/SP05-nod-connected.md` §6 writes
  them, including the two details the smoke leans on: `nod.setAppIcon({ choice: 'guild' })` succeeds
  only with a verified file on disk, and the stored choice survives the removal.
- **I2h (host side)**: nothing. `PUT`/`DELETE /v1/admin/guild/icon` and the signed `guildIcon` are
  what the smoke drove.
- **R3TestsConfig**: nothing — no test of yours was touched, and the smoke was not added to any gate.

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, written only by its owner: the files
touched, the acceptance and how it was met, the command and the observation, and what was left out).
The state of the work is not declared here; the coordinator's handover for the front carries it. The
runner's own printed output is the evidence of `execucao`; the line it prints for the file on P's disk
and the line it prints for the file being gone are the two the coordinator can grep for.
