# E06 — The same smokes on the Electrobun target

`execução` on 2026-10-22, owner's Mac (macOS 27.0.0 arm64, Bun 1.4.3, Electrobun 2.0.4 via the
project's `electrobun` CLI / hutch). The working tree already had the peer changes that landed
before the final batch (`electrobun/shared-rpc.ts`, sync `win.show`/`win.setSize`, and the
`NOD_MAIN_URL` block below).

Purpose: prove Electrobun parity with the **same** surface checks, not with a second set. The four
runners and their pages/drivers are unchanged in what they check; only the launch, the page channel
and the store file move to the target.

> Historical note (2026-10-22, after round 2): the owner's §22 "Seamless tabs: always inside, detach on
> demand" removed the Windows-mode switch and the embedded iframe kind, so `test/smoke/tabs.ts` now
> lists 16 steps (RF-52 default mode, RF-49 ×3, RF-50 ×3, RF-51 ×2, RF-66 ×2, RF-68, RF-67 ×2, T6,
> Open tabs). Rounds 1–2 below record the 27-step list as it ran then; the next `tabs` round will
> carry the new numbers.

## 1. The switch

```sh
bun test/smoke/run.ts       --runtime=electrobun --force
bun test/smoke/ui.ts        --runtime=electrobun --force
bun test/smoke/tabs.ts      --runtime=electrobun --force
bun test/smoke/connected.ts --runtime=electrobun --force

# equivalently
NOD_RUNTIME=electrobun bun test/smoke/ui.ts --force
```

`--runtime=<tinyjs|electrobun>` wins over `NOD_RUNTIME`, which wins over `tinyjs`. An unknown value
throws — a typo never silently measures the other target (`test/smoke/tools.ts:smokeRuntime`).

What changes per launch (`test/smoke/tools.ts:launchSmokeApp`):

| | tinyjs (default, unchanged) | Electrobun |
| --- | --- | --- |
| app id | `copland.nod.smoke…` | `copland.nod.smoke…-eb` (`smokeAppId`) |
| config | `scripts/gen-config.ts dev` -> `tinyjs.json` | `scripts/gen-electrobun-config.ts dev` with `NOD_APP_ID` + `NOD_MAIN_URL` |
| page | `TINYJS_HTML=<page>` (run/connected) or `frontend.devUrl` (ui/tabs, whose pages import `/src/app.ts`) | `http://127.0.0.1:<devPort>/<page under the repo>` served by vite, taken by the main window through `NOD_MAIN_URL` |
| dev server | started by `tinyjs dev` (`frontend.dev`) | started by the runner (`bun run dev`, one per launch) |
| store (`store.json`) | `<app data>/store.json` | `<app data>/dev/store.json` (`runtimeDataDir`) |
| result key | unchanged (`smoke_result`, `ui_smoke_result`, `tabs_smoke_result`) | unchanged |

`electrobun/bun/index.ts:70-93` (new): `NOD_MAIN_URL` is read **only when `build.channel === 'dev'`**
(a packaged build always loads `views://mainview/index.html`), must be a loopback `http:` URL, and
the gate's app origin follows it (`mainOrigin = new URL(NOD_MAIN_URL).origin`) — the window and the
gate name the same origin, exactly as `gen-config` does for tinyjs. `scripts/gen-electrobun-config.ts`
needed no change: it already accepts `NOD_APP_ID` and refuses `copland.nod`.

`run.ts` (only) also runs the SP02 §1 and SP06 §3 vector bundles: on tinyjs through
`<tinyjs>/bin/tjs run`, on Electrobun through the Bun binary the dev bundle ships
(`build/dev-macos-<arch>/Nod-dev.app/Contents/MacOS/bun`, the app backend's runtime), falling back to
the runner's Bun when that build is absent (`run.ts:vectorCommand`). Both targets must reproduce the
pinned hex; the same vectors are already pinned in Bun by `bun test`.

Runner-side data reads (`nod.db`, `guild-icon.png`) use `runtimeDataDir(appId, runtime)` — tinyjs:
`<app data>`, Electrobun: `<app data>/dev` (`Utils.paths.userData`;
`.hutch/devkit/api/sdks/main/core/Utils.ts:696`, `resolveInstalledRootNameForPaths`). This was found
by the first Electrobun `connected.ts` run, whose post-run DB/icon reads printed "missing" because
they still used the tinyjs path; the record below is after that fix (test code only).

No page driver needed a new bridge member: `tiny.store.set`, `tiny.fetch`, `tiny.win.*`,
`tiny.clipboard.*`, `tiny.dialog.*` and `tiny.api.call` are the members `electrobun/view/bridge.ts`
already exposed. This work did not edit `bridge.ts` (the peer's RPC-schema move and sync
`win.show`/`win.setSize` handlers were already in the tree).

## 2. Round 1 — Electrobun results (before the two fixes below)

| smoke | command exit | steps | wall |
| --- | --- | --- | --- |
| `run.ts` | **0** | 14/14 ok + 3 KDF vectors + 2 seal vectors | 25 s |
| `ui.ts` | 1 | 12 ok, **1 failed**; 4 of 8 stages reached (runner stops at the first failing stage) | 54 s |
| `tabs.ts` | 1 | 6 ok, 3 blocked (tiling WM), **1 failed** + 17 not run (driver stops after a failure) | 21 s |
| `connected.ts` | 1 | 105 ok, **9 failed** (1 root cause + cascade) | 56 s |

### 2.1 `run.ts` — 14/14 ok

Every step passed with its number: 1 `session.state` 29 ms, 2 `session.createAccount` 172 ms,
3 `catalog.probe` 49 ms, 4 `catalog.save` 68 ms, 5 `vault.save` 34 ms, 6 `tools.open (form)` 3294 ms,
7 `tools.open (session)` 3348 ms, 8 `tools.open (warm)` 27 ms, 9 `tools.openView` 3354 ms,
10 `tools.open (login loop)` 8172 ms, 11 `events.exportToFile` 17 ms, 12 `session.lock` 82 ms,
13 `session.unlock` 468 ms, 14 `vault.remove` 96 ms. Export check: 15 events, no secret.
Vectors: KDF 3/3 matched in 44 ms, seal 2/2 matched + 6 tampered refused in 6 ms, both under
`build/dev-macos-arm64/Nod-dev.app/Contents/MacOS/bun` (the Electrobun bundle's Bun).

### 2.2 `ui.ts` — failure #33

| stage | steps |
| --- | --- |
| admin-setup | 1 ok (0 ms) |
| person-join + headless | 4 ok (209, 203, 1, 306 ms) |
| admin-work | 5 ok (103, 103, 496, 238, 213 ms) |
| person-inbox + headless | `#32 accept` ok (206 ms), **`#33 reveal countdown and copy` FAILED**, headless ok (119 ms) |

**Failed step:** `#33 reveal countdown and copy` — 30232 ms,
`error: timeout (20000 ms) waiting for the status "Copied"; last: null`.
Reveal and its countdown passed; the **Copy** button produced no status with "Copied".

**Observed cause (product/facade gap):** `vault.copy` calls
`required(runtime, 'vault.copy').clipboard.write({ text: found.secret })`
(`backend/main.ts:3535`), but the Electrobun facade object (`electrobun/bun/facade/app.ts:266-407`,
cast at `:407`) has **no `clipboard` member** (the file has no `clipboard` at all), while
`backend/tiny.d.ts:1389` declares it. The handler throws
`undefined is not an object (evaluating 'required(runtime, "vault.copy").clipboard.write')`; the page
(`src/settings.ts:2600-2607`) sets an error status, so `ui-driver.ts:994`
(`waitForStatus('Copied')`) never matches. The same failure is named verbatim by `connected.ts` 8.5b
below. Note the page-side smoke bridge (`electrobun/view/bridge.ts` `clipboard.read/write` ->
`electrobun/bun/index.ts:194-215`) does exist; what is missing is the **backend** `app.clipboard` the
`vault.copy` handler needs.

The remaining 4 stages (`headless`, `third-join`, `seed-import`, `admin-final`) did not run: `ui.ts`
breaks the stage loop after a failing stage (existing behaviour, `ui.ts` stage loop).

### 2.3 `tabs.ts` — 27 steps: 6 ok, 3 blocked, 1 failed, 17 not run

Ok: `RF-52 default mode` 290 ms, `RF-49 sidebar click` 1264 ms, `RF-50 + opens a second tab` 259 ms,
`RF-50 switching keeps the draft` 762 ms, `RF-51 detach` 4113 ms, `RF-51 dock back` 1994 ms.

Blocked by the tiling WM (the kept rule; numbers from the WM and the page):
`RF-49 docked tab lands on the slot` 1055 ms, `RF-49 docked tab follows a resize` 850 ms,
`RF-50 second tab takes the slot` 961 ms — OmniWM held the run's windows at 1235x1312 tiles while
the slot was 1167x1190 (`Nod 1235x1312@3410,1528`; `Tool A 1235x1312@3587,1528` for the third).

**Failed step:** `RF-66 a tool popup becomes a tab beside its opener` — 2368 ms,
`the tab did not land on the slot within 2000 ms: slot 2444,-1328 1167x1190, page box 1235x1312,
real frame unread`. The adoption itself worked (the ad-hoc `popup*` tab appeared, active, beside its
opener, and the Tool B page reported); what failed is the placement measurement. The popup page's box
is an OmniWM tile (1235x1312), not the slot (1167x1190) — the same condition the three blocked steps
report as `blocked` — but `waitPlaced` (`test/smoke/tabs-driver.ts:891-930`) has no tiling-WM branch
and throws. `CGWindowList` showed only `Nod` windows for this run (the popup's frame was not
readable), so the check could not fall back to a frame comparison. On tinyjs the same step passed in
584 ms with the slot at 696x560 (same session, §3) — so this is Electrobun-specific in this run.

Consequence: the driver stops after a failure, so the following 17 steps record `did not run`:
`RF-66 Open link… by hand`, `RF-68 ad-hoc no API`, `RF-67 save view`, `RF-67 save tool`,
`RF-52 Windows mode`, `RF-19 second open`, `T6 lock/unlock restore`, seven `RF-69` embed steps,
`0.6.0b Open tabs from Home`, `0.6.0b embedded Sign in copies`, `0.6.0c strict-cookie refusal`,
`0.6.0c Login won't stay`.

### 2.4 `connected.ts` — 105 ok, 9 failed (1 root cause + cascade)

Phases that completed cleanly: admin-publish (26 ok), person-join (20 ok), person2-join (6 ok),
admin-clear (2 ok), person-cleared (3 ok), admin-share (13 ok), person2-accept (7 ok),
admin-rotate (4 ok), admin-second-machine (3 ok), admin-revoke (7 ok), person-signed-out (4 ok).

| step | ms | detail |
| --- | --- | --- |
| 8.5b `vault.copy` (the same gate, the clipboard, K5) | 35 | **FAILED** — `undefined is not an object (evaluating 'required(runtime, "vault.copy").clipboard.write')` (same root cause as ui #33: `backend/main.ts:3535`, no `clipboard` in `electrobun/bun/facade/app.ts:266-407`) |
| 8.6 `host.syncNow + vault.list` | 0 | did not run (after 8.5b) |
| 8.7 `shares.accept` (the assign) | 0 | did not run |
| 8.8 `host.syncNow` (the accepts go up) | 0 | did not run |
| 10.3 `vault.list` (three holders, K7) | 51 | FAILED — `tool-b: the holder rows are ["Smoke Admin","Smoke Other"]`; P is absent **because 8.7 never ran** (cascade, not a separate cause) |
| 10.4 `vault.save` (the owner's new secret) | 0 | did not run |
| 10.5 `assignments.missing/sealMissing` | 0 | did not run |
| 11.3 `vault.reveal` (the new value) | 91 | FAILED — `the vault did not move to the new value`; cascade from 10.4 |
| 11.4 `host.syncNow` (the share is purged) | 0 | did not run |

The runner's post-run disk checks all passed after the `runtimeDataDir` fix:
P's `guild-icon.png` = 304 bytes, sha256 `24f0b734d647…` (the uploaded PNG); P's own `nod.db`:
2 vault items, 2 credentials of `tool-a`, origin `http://127.0.0.1:55590`, 0 local `tool-a` rows,
accepted item has a `credential_id` and scope `role`; admin's second machine: 0 personal `tool` rows;
the host's DB scanned 16 tables / 112 columns with **0 plaintext hits**; the admin's adopted vault row
belongs to the guild person with key `nod.cred.<person>.tool-a.<item>`.

## 3. Round 1 — tinyjs baselines in the same session (unchanged target)

Run with the same tree, without `--runtime` (default tinyjs):

| smoke | result | wall |
| --- | --- | --- |
| `run.ts` | **ok** — 14/14 steps; KDF 3/3 in 367 ms, seal 2/2 + 6 refused in 16 ms (`~/.tinyjs/bin/tjs`) | 22 s |
| `ui.ts` | **ok** — 25 steps, 8 stages, 7 launches | 34 s |
| `tabs.ts` | **ok** — 27 steps, 3 blocked, 0 failed; `RF-66` passed in 584 ms (slot 696x560) | 27 s |
| `connected.ts` | **ok** — 114 steps, all phases | 43 s |

So the runtime switch left the tinyjs target working, and the two Electrobun failures are not
properties of the machine or of the drivers in general.

## 4. Round 2 — after the two fixes (same commands, same pages)

Two changes landed between the rounds; neither touches a page nor what a check asserts, and the
tinyjs target's behaviour is unchanged:

- **Facade `app.clipboard`** (`electrobun/bun/facade/app.ts:73-74`, `:238`, `:312`, `:423-585`,
  App's slice): `read/write/changeCount/watch/unwatch` over the devkit's text/image clipboard.
  `vault.copy` now reaches it, so the root cause of round 1's ui/connected failures is gone.
- **Harness blocked rule** (`test/smoke/tabs-driver.ts`): `waitPlaced` asks the desk for the WM's
  `tiling` windows every turn, again right before a success, and returns `blocked` with the tile
  frames and the slot/page/frame numbers — never `ok`; `checkResizeFollow` and `checkPopupAdoption`
  propagate it. A sibling race the tinyjs rerun exposed is also closed: `checkOpenAsWindow` judged
  the WM once before `measure` and once after it (`tabs-driver.ts:1818-1823`), so a window the tiler
  took in between is `blocked`, not a page-box failure the product never caused.

All eight runs were repeated on the final tree (`tabs` once more after the `clean()` fix in §5, whose
numbers are the ones quoted).

| smoke | Electrobun | tinyjs (regression) |
| --- | --- | --- |
| `run.ts` | **ok** 14/14; KDF 3/3 in 44 ms, seal 2/2 + 6 refused in 3 ms (bundle's Bun) | **ok** 14/14; KDF 373 ms, seal 17 ms (`~/.tinyjs/bin/tjs`) |
| `ui.ts` | **ok** 25/25 steps, 8 stages, 7 launches | **ok** 25/25 steps, 8 stages |
| `tabs.ts` | 6 ok, 4 blocked, **1 failed** + 16 not run (`RF-66 Open link…`) | **ok** 23 ok, 4 blocked, 0 failed |
| `connected.ts` | **ok** 114/114 steps, all 14 phases | **ok** 114/114 steps |

### 4.1 `run.ts` — Electrobun, 14/14 ok

`1 session.state` 31 ms; `2 session.createAccount` 105; `3 catalog.probe` 45; `4 catalog.save` 68;
`5 vault.save` 33; `6 tools.open (form)` 3352; `7 tools.open (session)` 3361;
`8 tools.open (warm)` 19; `9 tools.openView` 3380; `10 tools.open (login loop)` 8139;
`11 events.exportToFile` 17; `12 session.lock` 69; `13 session.unlock` 362; `14 vault.remove` 68.
Export check ok (15 events, no secret).

### 4.2 `ui.ts` — Electrobun, 25/25 ok (8 stages)

Stage times: admin-setup 4706 ms, person-join 3981, admin-work 4588, person-inbox 14675,
headless 161, third-join 5166, seed-import 6305, admin-final 7234.

`setup: activate, publish, people and codes` 0 ms · `#25 keep local tools` 207 · `#27 account
devices` 203 · `#29 key fingerprint` 1 · `setup: second and throwaway members joined` 243 ·
`#24 add personal tool dialog` 103 · `#24 sidebar order and favorite` 102 · `#34 blocked and role
send` 437 · `RF-65 second credential and the default chip` 239 · `RF-62 tools grouped by category`
210 · `#32 accept the incoming share` 306 · **`#33 reveal countdown and copy` 10161** (round 1's
failure; now reveals, clears at zero and copies with "Copied — paste it now…", value never in the
DOM) · `setup: second member accepted` 48 · `setup: second machine activated` 161 · `#37 invite join
through the entry screen` 475 · `#38 seed import at first run` 401 · `#35 holders list and admin
card` 104 · `#30 changed colleague key` 103 · `#27 admin sees the person devices` 103 · `#37 the
invite's role on the roster` 16 · `RF-64 owner chip on the roster` 1 · `RF-64 the owner renames a
member` 118 · `RF-64 the owner deletes a member` 119 · `#36 offline tile entry` 470 ·
`#28 update-required banner` 469.

### 4.3 `tabs.ts` — Electrobun: 6 ok, 4 blocked, 1 failed, 16 not run

Ok: `RF-52 default mode` 215 ms · `RF-49 sidebar click` 992 · `RF-50 + opens a second tab` 230 ·
`RF-50 switching keeps the draft` 364 · `RF-51 detach` 3355 · `RF-51 dock back` 1608.

Blocked (the kept rule, with numbers; slot 2394,-1278 / 3074,-1328 1167x1190):

| step | ms | WM (title frame@x,y) |
| --- | --- | --- |
| `RF-49 the docked tab lands on the slot` | 620 | `Nod 1235x1312@2326,1528`; `Tool A 1235x1312@3587,1528` |
| `RF-49 the docked tab follows a resize` | 788 | same two tiles |
| `RF-50 the second tab takes the slot` | 841 | same two tiles |
| `RF-66 a tool popup becomes a tab beside its opener` | 1097 | `Nod 1235x1312@3410,1528` (the adopted popup's frame unread) |

These are the final rerun's numbers (after the `clean()` fix in §5); the run prints
`in 15890 ms`.

**Failed step:** `RF-66 Open link… opens one by hand` — 175 ms,
`error: the window id is null`.

**Observed cause (tool-page bridge gap):** the driver's reporting page reads its own id with
`window.tiny.win.id` (`test/smoke/tools.ts`, `reportPage`: `win: bridge === null ? null : bridge.id`),
and asserts the hand-opened Tool C page lives in `link_1` (`test/smoke/tabs-driver.ts:1357-1358`).
On Electrobun a tool/popup view is `sandbox: true` and the injected
`electrobun/view/tool-bridge.ts:23-34` defines only `window.tiny.api` — no `win` — so every tool
page reports `win: null`. tinyjs tool pages carry `tiny.win.id`, which is why the same step passes
there. The adoption itself passed: the tab state shows `link_1` after the active tab and the Tool C
page loaded `/doc`; only the page's self-reported window id is missing.

Because the driver stops after a failure, these 16 steps record `did not run`: `RF-68 ad-hoc no API`,
`RF-67 save view`, `RF-67 save tool`, `RF-52 Windows mode`, `RF-19 second open`, `T6 lock/unlock
restore`, seven `RF-69` embed steps, `0.6.0b Open tabs from Home`, `0.6.0b embedded Sign in copies`,
`0.6.0c strict-cookie refusal`, `0.6.0c Login won't stay`.

### 4.4 `connected.ts` — Electrobun, 114/114 ok

`admin-publish` 26 · `person-join` 20 · `person2-join` 6 · `admin-clear` 2 · `person-cleared` 3 ·
`admin-share` 13 · `person-share` 10 · `person2-accept` 7 · `admin-update` 5 · `person-update` 4 ·
`admin-rotate` 4 · `admin-second-machine` 3 · `admin-revoke` 7 · `person-signed-out` 4.

Included: `8.5b vault.copy` (the clipboard, K5) and `8.6`/`8.7`/`8.8` that round 1 skipped;
`10.3 vault.list (three holders)` and `10.4`/`10.5`; `11.3 vault.reveal (the new value)` and
`11.4`. The runner's post-run disk checks are the same as round 1's fixed ones (P's icon PNG, P's
own rows, the second machine, 0 plaintext hits in the host DB, the admin's adopted vault row).

### 4.5 tinyjs round 2

`run` 14/14 ok (KDF 3/3 373 ms, seal 2/2+6 17 ms), `ui` 25/25 ok over 8 stages, `connected` 114/114
ok, `tabs` 23 ok + 4 blocked + 0 failed (`in 25008 ms`). One intermediate tinyjs `tabs` run failed
`RF-69 Open as window` with `the page box is 1235x1312 and the slot is 1167x1190` — the tiler took
the converted window between `checkOpenAsWindow`'s pre-measure check and the measurement (its own
numbers show the tile). The post-measure guard (§4 above) turns that into `blocked`; the rerun is
the green one quoted here.

## 5. Cleanup after the runs (`execução`, each batch)

- `pgrep -fl electrobun` → empty (exit 1); `pgrep -fl "Nod-dev|hutch electrobun|electrobun dev|tinyjs dev|vite"`
  → empty when checked between runners and at the end of the batch. (`pgrep -fl Nod` still lists 12
  unrelated helper processes whose command line contains "NodeService"/"Notion"; no Nod app is among
  them: `pgrep -fl "Nod-dev|Nod.app"` → empty.)
- `resources/seed.json` restored each time (299 bytes, mtime unchanged); no
  `test/smoke/.gerado/seed.json.bak` left.
- `electrobun.config.ts` back to `"identifier": "copland.nod.eb"`; `tinyjs.json` left with
  `id copland.nod` and `devUrl http://127.0.0.1:5173`. Round 2 exposed a gap here: `ui.ts` and
  `tabs.ts` did not regenerate the Electrobun config, so a run that ended on either left the
  smoke's identifier behind. Their `clean()` now does (`generateElectrobunDevConfig(ROOT, null,
  null)`), and a `tabs --runtime=electrobun` run was repeated last to prove the file is back to
  `copland.nod.eb` afterwards.
- `~/Library/Application Support/copland.nod.smoke-eb/` remains after `run.ts` (that runner wipes it
  before the launch and keeps it afterwards, exactly like `copland.nod.smoke`); the app data dirs of
  `ui`, `tabs` and `connected` (`…-eb`) were removed by their runners' `clean()`.

## 6. Final round — 2026-10-22, end of work (one run per smoke per runtime)

The tree at this round had the seamless-tabs cutover (docked tab = native view inside the main
window on Electrobun; carrier window on detach; the iframe/Windows-mode kind removed) and the
tool-page `tiny.win.id` bridge. `tabs.ts` listed 16 steps after the cutover.

| smoke | Electrobun (`--runtime=electrobun --force`) | tinyjs (`--force`) |
| --- | --- | --- |
| `run.ts` | **ok** 14/14; KDF 3/3 39 ms, seal 2/2 + 6 refused 3 ms (bundle's Bun) | **ok** 14/14; KDF 373 ms, seal 16 ms (`~/.tinyjs/bin/tjs`) |
| `ui.ts` | **ok** 25/25, 8 stages (after the §6.2 fix; 5 consecutive runs) | **ok** 25/25, 8 stages |
| `connected.ts` | **ok** 114/114, 14 phases | **ok** 114/114 |
| `tabs.ts` | **ok** 16/16, **0 blocked**, 18115 ms | **ok** 16 steps, 12 ok + 4 blocked, 16459 ms (after one harness correction, below) |

### 6.1 `run.ts` — 14/14

`1 session.state` 38 ms · `2 session.createAccount` 106 · `3 catalog.probe` 50 · `4 catalog.save` 68 ·
`5 vault.save` 33 · `6 tools.open (form)` 3224 · `7 tools.open (session)` 3232 · `8 tools.open (warm)`
17 · `9 tools.openView` 3236 · `10 tools.open (login loop)` 8160 · `11 events.exportToFile` 17 ·
`12 session.lock` 48 · `13 session.unlock` 281 · `14 vault.remove` 66. Export check ok (15 events,
no secret). KDF/seal under `build/dev-macos-arm64/Nod-dev.app/Contents/MacOS/bun`. The tinyjs run
is the same 14 steps with `~/.tinyjs/bin/tjs`.

### 6.2 `ui.ts` — the `third-join` failure, diagnosed and fixed (Electrobun 25/25)

**Final-round record:** stages admin-setup 4928 ms, person-join 3967, admin-work 4372, person-inbox
13424 (incl. `#33` 10161), headless 127, **third-join 23705** (failed); seed-import and admin-final
did not run (the loop stops on a failing stage). All 14 steps before the failure passed. **Failed
step:** `#37 invite join through the entry screen` — 20410 ms,
`error: timeout (20000 ms) waiting for the team role's tools in the new member's sidebar; last: null`.
The same stage passed on tinyjs (3536 ms, 25/25).

**Reproduced.** The focused Electrobun rerun the open item asked for failed **3 of 4** times, always
at that step. The step's failure message now carries what the round lacked — the page and the backend
at the moment of the timeout:

`the shell has 0 sidebar node(s) and titles []; tools.state 2 tool(s); catalog.list 2 entry(ies);
banner (nothing)`

The backend and the effective catalog hold the two `team` tools, and the joined shell is on screen;
only the page's own `tools` array is empty. The runner's result channel was working (the step's own
detail reached the store), so this was a stale write in the page, not a lost join, snapshot, role or
RPC.

**Cause.** The invite path of `host.activate` does not await its first sync — unlike `host.signIn`
(F2) — so `afterUnlock` pushes `session` and an **empty** `tools` (the snapshot has not landed yet)
and then starts the sync loop. On the `session` push, `src/app.ts` `loadUnlocked` issues five reads
in parallel (`tools.state`, `catalog.list`, `host.state`, `favorites.list`, `session.profiles`). The
first snapshot's `catalog`/`tools` push then lands **between** two of those answers: `Promise.all`
settles only with the last one, so `applyToolsState` wrote the read's empty list over the pushed
one — and the sync run had already published, so no later push corrected it. The sidebar stayed
empty for good. The two runtimes order those two differently: on tinyjs the same stage passed in the
round and after the fix (3536 ms then, 1562 ms now), while Electrobun failed 3 of 4 focused runs.

**Fix (`src/app.ts`, not the runtime).** `toolsRevision` / `catalogRevision` are bumped by the
`tools` and `catalog` pushes (and by a lock, which is newer than any read a shell left in flight).
`loadUnlocked` captures them before the reads; if either moved, the pushed `ToolsState` — the whole
answer, already applied as `tabsState` — is what the panel follows, and the read's catalog is not
written. A read with no interleaving is applied exactly as before. The fix is in the page because
the bridge routes the push correctly (the diagnostics read the pushed state back through
`tools.state`), and the ordering assumption is page-level, not runtime-specific: only the page sees
both the push and the read, and the bridge has no revision to compare them with.

**Harness.** The failing wait now reports the shell's sidebar node/title count, `tools.state`,
`catalog.list` and the banner on timeout — diagnostics only, no assertion change; it is what
isolated the cause.

**Verification.** After the fix, `bun test/smoke/ui.ts --runtime=electrobun --force` passed **5 of
5** consecutive runs (25/25, 8 stages each; stages of the first: admin-setup 8794 ms, person-join
7101, admin-work 10006, person-inbox 17124, headless 282, third-join 8231, seed-import 7202,
admin-final 8648). `#37` itself: 505–1001 ms (the timeout was 20410 ms), sidebar with 2 tools of the
`team` role; `#37 the invite's role on the roster` and all of `admin-final` (block 2's O2 banner, the
offline tile, RF-64) passed. The shared page change was re-checked on tinyjs: `bun test/smoke/ui.ts
--force` → **ok 25/25**, `#37` 1562 ms. `bun run typecheck` clean. `resources/seed.json` restored,
`electrobun.config.ts` back to `copland.nod.eb`, no smoke process or app data dir left.

### 6.3 `connected.ts` — 114/114 on both runtimes

Same 14-phase split as round 2 (`admin-publish` 26, `person-join` 20, `person2-join` 6,
`admin-clear` 2, `person-cleared` 3, `admin-share` 13, `person-share` 10, `person2-accept` 7,
`admin-update` 5, `person-update` 4, `admin-rotate` 4, `admin-second-machine` 3, `admin-revoke` 7,
`person-signed-out` 4). Includes `8.5b vault.copy`, the holder/update/rotation steps and the
runner's disk checks; no failures.

### 6.4 `tabs.ts` — Electrobun 16/16, 0 blocked; tinyjs 12 ok + 4 blocked

Electrobun (the docked tab is a **view**, no OS window; the detach opens a **carrier**):

| step | ms | proof |
| --- | ---: | --- |
| RF-52 default mode | 175 | `mode=docked`, no strip, main 1235x1312 |
| RF-49 sidebar click | 759 | tab + slot 1167x1190, page loaded at 1167x1190 |
| RF-49 docked tab lands on the slot | 1671 | page 1167x1190 = slot 3604,-1328 1167x1190; **CGWindowList 0 tool windows** |
| RF-49 follows a resize | 2674 | main 1235x1280→1075x1140: followed in 323 ms to 1007x1050, back in 367 ms; 0 tool windows |
| RF-50 + second tab | 220 | two pages, distinct timeOrigin/draft |
| RF-50 second tab takes the slot | 1350 | page 1167x1190 = slot; 0 tool windows; 2 tabs |
| RF-50 switching keeps the draft | 338 | 1 load, draft kept |
| RF-51 detach | 3133 | **1 carrier** "Tool A" 1235x1312 with a 32 pt frame; timeOrigin/draft kept |
| RF-51 dock back | 1607 | **carrier gone, 0 tool windows**; page 1167x1190 = slot; 1 load |
| RF-66 popup adopted | 635 | `tiny.win.id` = `popup1`; took the slot in 323 ms |
| RF-66 Open link by hand | 314 | `link_1`/`link_2` report their own ids |
| RF-68 ad-hoc no API | 504 | tool tab `ok`; popup/link refused with the gate sentence |
| RF-67 save view / save tool | 200 / 357 | view `doc` of Tool B; personal Tool C; no reload |
| T6 lock/unlock | 300 | 3 docked tabs reopen in order, ad-hoc ones do not; 7 loads |
| 0.6.0b Open tabs | 272 | badge 3, strip shown, disabled with 0 |

tinyjs (docked tab is an OS window): 12 ok, **4 blocked** by OmniWM with numbers — RF-49 lands
643 ms / RF-49 resize 626 / RF-50 second slot 820 (both `Nod` and `Tool A` tiles 1235x1312@2326/-1528
and @3587/-1528 vs slot 2394,-1228 1167x1190) and RF-66 popup 824 ms (a window tiled at
1235x1312@3486,1528). The rest passed, including detach (carrier 122 pt; two tool windows while the
old docked window was still on screen) and dock back (one window on the slot), `tiny.win.id`, RF-68,
RF-67, T6 and Open tabs.

**Harness correction (disclosed):** the first tinyjs `tabs` run failed at RF-51 detach because the
new check required **exactly one** tool window after the detach; tinyjs leaves the old docked window
on screen for a moment beside the carrier. The check now requires one framed **carrier** (and, for a
view, exactly one window), the same rule round 2 used; the run above is the rerun. This was a test
assertion error, not a product or WM failure.

### 6.5 Packaged build — `eb:build` with a throwaway identifier

`NOD_APP_ID=copland.nod.smoke-build bun run eb:build` → `build/stable-macos-arm64/Nod.app`
(identifier `copland.nod.smoke-build`, `CFBundleVersion 0.6.0c`), seeded temporarily with
`update.url=http://127.0.0.1:47841/manifest.json` (throwaway channel). **ok** for the icon, the tray,
Lock, Quit and the refused install; the close item failed in this round for the reason measured in
§6.6 and passes after the app-hide fix (re-checked there).

| check | result | evidence (`execução`) |
| --- | --- | --- |
| app icon | **ok** | `CFBundleIconFile=AppIcon`; `sips` reports the `.icns` **1024x1024** and `assets/icon.png` 1024x1024; `iconutil -c iconset` extracted `icon_512x512@2x.png` (1024²) and a 1024×1024 pixel compare against the source gave **0 differing pixels of 1,048,576** |
| tray rendered icon | **ok** | backend passes `sf:rectangle.stack`; the app cache holds `tray-sf-b7a1eb5c89ab2e17.png` (**18x18**, sha256 `3abaf26a…`, not `resources/tray.png` `585c89b5…`); the status item menus "Open Nod, Lock, ⎯, Quit Nod" |
| close → hide | **failed (app life) in this round; fixed and re-checked in §6.6** | the red button is **prevented and the window hidden** (`AppKit: windowShouldClose: prevented close`; WebKit visibility 0), and ~1.4–1.9 s later the process is gone. The Quit AppleEvent came from the machine's `Vorssaint` menu-bar utility, not from macOS (§6.6 has the log evidence: identical on tinyjs); the target now hides the **app** on last-window close and survives it. SC §5 had a tool window open and the app stayed |
| tray Lock | **ok** | tray → Lock put the main window on the lock screen (`Offline` / EMAIL / PASSWORD), pids alive |
| tray Quit Nod | **ok** | tray → Quit Nod; launcher and bun pids gone within 2 s |
| refused update install | **ok** | manifest `9.9.9` with sha256 `0…0`; server log `GET /eb-manifest.json` ×2 + `GET /fake.tar.zst`; after Install the shell banner reads verbatim **"The update could not be installed"** |

Cause for the close failure: the product's veto works (window prevented and hidden), then the
machine's `Vorssaint` utility posts a **Quit AppleEvent** because no window is left on screen, and
Electrobun's delegate forwards it to `Utils.quit()`. The earlier "macOS automatic termination" reading
was wrong — §6.6 replaces it and records that the same utility quits the tinyjs target. The
`_kLSApplicationWouldBeTerminatedByTALKey=1` log line is AppKit's state announcement, not the
trigger.

Cleanup after the round: all eight runners restored `resources/seed.json` (299 B); no smoke process
left; app and cache dirs for the throwaway build removed; `electrobun.config.ts` regenerated to
`copland.nod.eb` and `resources/build-mode` = `dev`; the owner's `eb:dev` session was not touched.

### 6.6 Close → hide re-check — the Quit comes from Vorssaint, not from macOS

**Root cause (measured, 2026-10-22).** With the main window hidden, no window is left on screen for
`Vorssaint` (pid 1206, `/Applications/Vorssaint.app`, `LSUIElement`), the owner's menu-bar utility
whose binary strings read "Quit apps when their last window closes" (`AutoQuitService`,
`AutoQuitWindowEvent`, "Some apps close their last window while they keep working … Those are quit
too, unless they are on the Exceptions list") and whose defaults hold `autoQuitEnabled = 1` with no
`autoQuitExceptions`. It posts the Quit AppleEvent itself:

`Vorssaint[1206] [com.apple.appleevents:send] AESendMessage(aevt,quit {aevt,quit target='psn '[Nod] …})`

~1.4–1.9 s after the window hid (control: `osascript` → Calculator logs `osascript` as the sender, so
the sender in the log is the real process). Electrobun's delegate forwards every Quit AppleEvent to
`Utils.quit()`, so the process ended. The `_kLSApplicationWouldBeTerminatedByTALKey=1` line is
AppKit's automatic-termination state (`_updateToReflectAutomaticTerminationState`), not the trigger:
`-[NSApplication _enableAutomaticTerminationIfWhitelisted]` never ran for Nod, and
`ProcessInfo.disableAutomaticTermination` (now armed by the new `setTerminationHold` op while
hide-on-close is on) does not stop an external Quit AppleEvent. **The tinyjs target is killed the
same way**: with `NOD_APP_ID=copland.nod.smoke-closehide-tj bun run app:dev`, closing its main window
got the same Vorssaint Quit and exited. This is a machine-configuration conflict, not an Electrobun
gap.

**Fix.** `facade/windows.ts`: the close veto now calls `hideApp` (`NSApp.hide`) when `main` is the
last OS window, and keeps the window-only `hide()` when a tool/carrier window is on screen (RF-15);
AppKit keeps a hidden app's windows in its window list, so the utility never sees "no windows".

**Re-check** (`NOD_APP_ID=copland.nod.smoke-closehide bun run eb:build` → a fresh
`build/stable-macos-arm64/Nod.app`, `CFBundleIdentifier copland.nod.smoke-closehide`; built from an
identical copy of the tree because the owner's live `eb:dev` session holds
`.hutch/locks/electrobun-build.lock` for its lifetime — the running dev bundle and its data were not
touched):

| check | result | evidence (`execução`) |
| --- | --- | --- |
| (a) close main, no other window | **ok** | pid 95982: close 22:25:02.390 → `windowShouldClose: prevented close` 22:25:02.524 → `SHOWHIDE: HIDE … err=0` (NSApp.hide) 22:25:02.527. Alive at 1/2/5/10/20/30 s (bun + launcher), `visible=false`, 0 on-screen `CGWindowList` windows; no `AESendMessage` from Vorssaint in that span. Tray "Open Nod" 22:25:48 → `visible=true`, 1 on-screen window "Nod" within 2 s |
| (b) tool window open, close main | **ok** | two managed windows ("Nod" + "Tool A"; opened with `win.open` — the probe hook is re-check instrumentation, never in the repo): close main 22:29:36.233 → prevented close; "Tool A" stays on screen (1 window), app not hidden and active, alive at 3/6/9/12/15 s; no Quit AppleEvent. Takes the window-only hide, so RF-15's tool window keeps working |
| (c) tray "Quit Nod" | **ok** | 22:25:58.815 → bun and launcher pids gone within 1 s (instrumented run: bun gone in 1 s; one `open -n` handoff `launcher` lingered and was killed by the check) |

**Deliberate difference from tinyjs.** Under this machine configuration tinyjs is still quit by
Vorssaint when its last window closes; the Electrobun target hides the app and survives. On a machine
without such a utility the two are equivalent (only `main` exists, so app-hide and window-hide show
the same thing).

## 7. Open items for the orchestrator

**Closed by the final round**: the facade `clipboard` and `waitPlaced` (round 2); the tool-page
`tiny.win.id` bridge (`RF-66 Open link…` passed with `"link_1"`); the docked-view/carrier path
(K1/K2: 0 tool windows for a docked view, one 32 pt carrier on detach, carrier gone on dock back);
the packaged icon pipeline (1024² `.icns` pixel-identical to `assets/icon.png`); the rendered tray
icon (`tray-sf-*.png`, 18x18); the refused-install banner ("The update could not be installed");
tray Lock and Quit.

1. **`ui.ts` `#37 invite join` on Electrobun — closed (§6.2).** Reproduced 3/4 focused runs; the
   timeout was a page-side stale write: `loadUnlocked`'s five reads (`Promise.all`) settled after the
   first snapshot's `tools` push, so the read's empty list replaced it with no later push to correct
   it. Fixed in `src/app.ts` with `toolsRevision`/`catalogRevision` (a push owns the answer newer than
   a read); Electrobun then passed 5/5 consecutive runs (25/25) and tinyjs 25/25. The step's failure
   message now reports the sidebar's node/title count, `tools.state`, `catalog.list` and the banner.
2. ~~**Close → hide does not keep the app alive with no other window**~~ — **closed (§6.6)**: the
   Quit was the machine's `Vorssaint` utility ("quit apps when their last window closes",
   `autoQuitEnabled=1`, no exceptions), not macOS automatic termination; tinyjs is quit by it too.
   The Electrobun target now hides the **app** when `main` is the last window and survives (alive
   past 30 s, tray Open Nod shows the window); a deliberate difference from tinyjs, which still gets
   quit by the utility. That is a machine-configuration conflict, not a product change.
3. `ui.ts` and `tabs.ts` stop after the first failing stage/step; "did not run" lines are
   consequences. The 16-step `tabs.ts` list is now covered end to end on Electrobun (16/16).
4. The tinyjs `tabs.ts` geometry steps are still judged against OmniWM at check time (`blocked`,
   with numbers, when a *tool/carrier* window is tiled): 4 of 16 in this round. The main window may
   be tiled without blocking a docked view. That is the kept rule, not a failure.

## 8. 0.7.0a — real mouse clicks with a tab open (2026-10-27, `execução`)

Owner report: with a tab open, buttons of the Nod window did not respond. The DOM-driven smokes
never saw it: `el.click()` skips AppKit's hit test.

**Cause (`leitura` of `libNativeWrapper.dylib`, Electrobun 2.0.4).**
`-[ContainerView updateActiveWebviewForMousePosition:]` runs on every mouse move and every
`resizeWebview`. It walks `abstractViews`, skips only views with `isMousePassthroughEnabled`, takes the
first whose `layer.frame` holds the point — never checking `isHidden` or whether the view still
lives in that window — and calls `toggleMirrorMode:YES` on every later view, which sets
`nsView.frame` to `(-10000, -10000)`. A hidden docked tab (Home, Settings, a dialog, another tab
active) or a tab detached into its carrier therefore parked the main window's own webview
off-screen while the mouse was over the slot, and its clicks went nowhere. A second, smaller defect:
`createEmbedded` handed the slot's top-left rect to `new BrowserView`, whose `initWithFrame:` reads
it bottom-left, so a new docked view sat on the wrong rows until the first `resizeWebview`.

**Fix.** `electrobun/native/NodNative.swift` replaces `shouldSuppressMirrorMode` on `AbstractView`
and `WKWebViewImpl` with one answering `true` (at the first native request, which also clears any
mirror already on), so no webview ever leaves its real frame and AppKit's own `hitTest:` — which
skips hidden views — routes the click. `electrobun/bun/facade/native.ts` sets
`webviewSetPassthrough(id, hidden)` beside `webviewSetHidden`. `electrobun/bun/facade/windows.ts`
creates a docked view at 1×1 and places it through `placeView`, as the carrier path already did.

**Proof.** `test/smoke/tabs.ts` gained `/desk/click` (`test/smoke/click.swift`: one `CGEvent`
left click, only when the topmost window at the point is this run's) and three driver steps:

| Step | Without the fix (Electrobun) | With the fix (Electrobun) | tinyjs |
| --- | --- | --- | --- |
| real clicks on the strip switch tabs | ok | ok | ok |
| a real click on Home reaches the page over a hidden tab | **FAILED**: "Bring to front" (page box 105,179 130x31, inside the slot) got no click; the page's last real mouse-downs were the Home mark | ok, the click inside the slot reached the page | ok |
| a real click reaches the main window while a tab is detached | not run (stops at the failure) | ok | ok |

Final runs: `bun run validate --smoke` 12/12 in 362.5 s (the two Electrobun real-click steps came
out `blocked` there — another app was frontmost); then `bun test/smoke/tabs.ts --runtime=electrobun
--force` alone: 19/19, 0 blocked, 24.9 s. Seed restored (299 B), no process left.
