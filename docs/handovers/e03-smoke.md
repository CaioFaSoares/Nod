# Slice E03 — the docked-tabs smoke (`test/smoke/tabs.ts`)

Release 0.6.0, requirement set RF-49…RF-52 and RF-66…RF-68 (`docs/canonico.md` §14), epic
`docs/epics/E03-docked-tabs.md`, implementation contract `local://e03-design.md`. Proof:
`bun test/smoke/tabs.ts --force` on this machine (macOS 27.0.0, arm64, tinyjs 0.57.2).

Everything below is `execucao` (`leitura` where said). The run quoted in §2 is the last one: **17
steps, 4 blocked by the session, verdict `ok`, 10.1 s** (`app id copland.nod.smoke-tabs`, local
account `tabs@nod.test`).

## 1. What is under test, and how it is measured

| Piece | What it is |
| --- | --- |
| `test/smoke/tabs.ts` | runner: refuses while `resources/seed.json` exists (`--force` moves it to `test/smoke/.gerado/seed.json.bak` and restores it), one `tinyjs dev` launch under the throwaway app id, a free dev port, a generated page (`src/app.ts` + the driver), a loopback desk, and the WM/window-server readings. Steps are printed as they land, and each carries `ok`/`FAILED`/`blocked` |
| `test/smoke/tabs-driver.ts` | the checks, on the real page: a **local** account (`session.createAccount`, no host), sidebar and strip clicks, the Open link dialog, the Account Window-mode card, the lock + Offline-tile unlock |
| `test/smoke/tools.ts` (`startTabTools`) | three reporting tool pages on three origins: each writes a random draft on load, reports `performance.timeOrigin`, its page box and what the Nod API answered it, and polls its own server for one-shot commands (`report`, `open <url>`, `api <method>`) |
| `test/smoke/winlist.swift` | compiled on demand into `.gerado/winlist`: `CGWindowListCopyWindowInfo` — every window's real frame and title, the session's lock state, the frontmost app |

Geometry, all of it measured here, decides how a tab is checked:

| Fact | Consequence |
| --- | --- |
| `window.screenX/screenY` are `0,1490` and `window.outerWidth/outerHeight` are `0x0` in the window that loads `src/app.ts` | a page cannot report where its own window is (`backend/tiny.d.ts`, `TinyWinState.outer`, says the same of the outer box) |
| a tool page's `tiny.win.getState()` throws `"win.getState" is disabled by tinyjs.json "api"` (`scripts/gen-config.ts` grants a tool origin only `login.report`/`media.*`) | the tool page brings its **page box**, its `timeOrigin` and its draft — not its frame |
| the slot's screen rect comes from the main page (`tiny.win.getState()` + the slot's `getBoundingClientRect()`, the `slotToScreen` of `shared/tabs.ts`); the real frame comes from `CGWindowList` | the two halves are the backend's own aim and the screen's own truth, not the same reading twice |
| the window server's units are not this app's points: main `597,207 1100x752` pt is `652,260 990x678` (`scale 0.9000`, offset `115,74`) | the map is read at every measurement from main itself (its real frame against its own `getState()`) and applied to the tool window: a frameless docked tab comes out with a `0 pt` frame, a detached one with `33 pt` |
| this machine's screen was **locked** for every run here (`CGWindowList` → `CGSSessionScreenIsLocked: true`, frontmost `loginwindow`), so the page is `visibilityState hidden` | `src/tabs.ts` `currentRect()` reports the empty slot by design; every step whose subject needs the slot is reported **blocked** with its numbers, never as a pass |
| OmniWM sees **none** of this run's windows (`omniwmctl query windows`, matched by pid: 0 of 24) | the "float the windows the tiler would re-tile" step is a no-op here, and the geometry is not the WM's doing |

## 2. The unlocked run (OmniWM active, 17 steps, 0 blocked, `ok`, 25.2 s)

Run under the owner at the machine, `winlist` reading `screenLocked: false`, frontmost `Notion`:
OmniWM tiles the app's windows, the smoke floats **its own** (`omniwmctl window focus` +
`command toggle-focused-window-floating`; the log shows `"Nod" floating` and `"Tool A" floating`), and
every geometry step passed with real numbers:

| Step | Result | Numbers |
| --- | --- | --- |
| RF-52 default mode | ok | `mode=docked dockable=true tabs=0`; main `1160,90 1102x1303` pt = server `1160,90 1102x1303` → scale `1.0000` offset `0,0` (this display's spaces coincide; the earlier display's did not) |
| RF-49 sidebar click opens one docked tab | ok | `tool_tool-a` docked+active, slot `1034x1181`, page loaded at `1102x1303` in 947 ms |
| **RF-49 the docked tab lands on the slot** | **ok** | page `1034x1181` on the slot `150,171 1034x1181`; `CGWindowList`: **1** tool window `1034x1181@150,171 = 150,171 1034x1181` pt, settled in **462 ms** |
| **RF-49 the docked tab follows a resize** | **ok** | main `1102x1271 → 942x1131`: followed in **406 ms** to `150,171 874x1041` (real frame = the slot); back in **534 ms** to `1034x1181` |
| RF-50 + opens a second tab | ok | `tool_tool-a, tool_tool-a_t2`; own page `…179660`/`draft-9w83g4` ≠ tab 1's `…174256`/`draft-03fg98` |
| **RF-50 the second tab takes the slot** | **ok** | page `1034x1181` on the slot `150,171 1034x1181`; 1 real tool window, settled in **434 ms** |
| RF-50 switching tabs keeps the draft | ok | 1→2→1, same `timeOrigin`+draft, **1 load** |
| RF-51 detach brings the frame back | ok | frame **0 → 122 pt** (the tiler had sized the window to main's tile before the float, so it kept its rect; the frame is what the detach adds), 1 load |
| **RF-51 the strip docks it back** | **ok** | docked back onto `150,171 1034x1181`: page `1034x1181` on the slot, 1 real tool window (settled 489 ms), same `timeOrigin`+draft, 1 load |
| RF-66 popup becomes a tab beside its opener | ok | `popup1` right after `tool_tool-a`; **it took the slot in 127 ms** |
| RF-66 Open link… by hand | ok | `link_1` after the active tab, `link_2` after it (1.1 s, two dialog round trips) |
| RF-68 ad-hoc tab gets no API | ok (same run) | tool tab → `ok`; `popup1` → `login.report only comes from a tool window`; `link_1` → `"login.report" is disabled by tinyjs.json "api"` |
| RF-67 save a known origin (view) | ok | view `doc` of `tool-b` (`mode: window`), the tab stays ad-hoc |
| RF-67 save a new origin (tool) | ok | personal tool (`p-…`) with the probed title `Tool C`, sidebar `2 → 3` rows, the tab became its tool tab without reloading |
| RF-52 Windows mode | ok | `mode=windows active=null`, the 5 tabs left the panel, toolbox window `1280x800` with a 33 pt frame |
| RF-19 second open | ok | same window, 1 load, same `timeOrigin` |
| T6 lock + unlock | ok | `tool_tool-a, tool_p-…, tool_tool-a_t2, tool_tool-b` reopened in order; the 2 ad-hoc tabs did not come back |

## 3. The run tally (unlocked screen, current files, 2026-10-19)

| Run | Verdict | Detail |
| --- | --- | --- |
| 1 | **ok**, 17 steps, 0 blocked, 25.2 s | every step above; RF-67 "new origin" passed |
| 2 | 9 steps ok, then **failed at "RF-51 the strip docks it back"** | after the reseat the real frame read `150,142` against the slot `150,171` — **29 pt**, the height of a title bar — and the window list carried a duplicate `"Tool A"` at `x=-1022` while `main` was missing from it (so the points↔server map fell back to identity). **Cause not established.** Hypotheses: a stale or mid-animation window-list entry read through the identity map; or a dock-back whose window still carried its frame when it was placed (a backend bug in `dock`). Neither was proven; 1 occurrence in 8 unlocked runs |
| 3 | ok through "RF-49 the docked tab lands on the slot" (settled 789 ms), then failed | the captured tail is truncated, so the failing step and its cause are unknown; the landing itself passed with the real frame on the slot |
| 4–8 | **ok** ×5, 17 steps each, 0 blocked, 20.5–24.5 s | run by the orchestrator with `bun test/smoke/tabs.ts --force` after the settle poll landed; no step failed, no `tinyjs` process left behind, `resources/seed.json` restored after each |

Total: 6 of 8 unlocked runs passed all 17 steps; run 2's cause was not established and run 3's was
not captured.

RF-67 "new origin" passed in every run since the driver's syntax error was fixed (run 1 and the two
earlier locked-screen runs of §4); the one failure before that is not reproducible.

The `CGWindowList` list is the flaky part of the measurement: macOS animates a window out (a hidden
docked tab shrinks away) and keeps recently ordered-out windows in the list for a moment. Observed by
execução: before the settle poll, two orchestrator runs failed at "the second tab takes the slot"
with a second `"Tool A"` at the slot rect inset by 12 pt per side, and only one window left at the
end of each run. `measure()` therefore polls the list until it is **identical for 300 ms** (budget
2 s) and prints the settle time in every step (`settled in 462 ms`, `… 434 ms`, `… 489 ms`); a list
that never settles fails the step with its numbers. Whether this explains run 2's failure is not
known.

## 3b. For the record: the locked regime (4 steps blocked, never passed)

Every run before the owner unlocked the screen had `winlist` read `screenLocked: true` (frontmost
`loginwindow`), so the page was `visibilityState hidden` and `src/tabs.ts` reported the empty slot —
by design ("no docked tab while the page is hidden"). Those runs reported **blocked** with their
numbers, never a pass:

| Step | Numbers measured then |
| --- | --- |
| RF-49 the docked tab lands on the slot | slot box `665,329 1032x630`, page `1280x800`, real frame `625,236 1281x800` (the cascade, `main+28`) |
| RF-49 the docked tab follows a resize | `1100x720 → 940x580`, nothing followed (slot `872x490`, page `1280x800`) |
| RF-50 the second tab takes the slot | same reason, same numbers |
| RF-51 the strip docks it back | docked+active again, same `timeOrigin`/draft/1 load; the snap was not observable |

## 4. Product fix found by this smoke

`src/style.css` (3 lines): an empty `.notice-slot`/`.banner` is `display: none` (`:empty`), and a
hidden element is no grid item — so in `.main`'s `grid-template-rows: auto auto minmax(0,1fr)` the
content auto-placed into the **first** row and shrank to its own height. Measured in the running app
before the fix: `.content 1032x46`, computed rows `46px 0px 674px`, `.tab-slot 1022x0`. The tab view
is `position: absolute; inset: 0` inside `.content` (RF-49), so the slot was 0 px tall,
`currentRect()` returned null and the backend never placed a docked tab (the tool window stayed at
the cascade `1280x800`). After the fix: `.content 1032x720`, rows `0px 0px 720px`, `.tab-slot
1032x630`, and the smoke's RF-49 steps reach the slot question. Fix: `grid-row` 1/2/3 on
`.notice-slot`/`.banner`/`.content`.

No other product bug was found: the strip and its order, the tab ids, `tabs.new`, the frame toggle
(detach and dock), the ad-hoc API gate, `tabs.save` in both branches, the mode switch and the
restore all behaved as the contract says.

## 5. Not covered

- a run where the `CGWindowList` list never settles: that is the flaky part of the measurement, and
  §3 records what it looked like (run 2's 29 pt reading and the duplicate window entry);
- `nod://open?url=` (RF-66's deep link) — the palette path and the Open-link dialog are the ones the
  smoke drives, and the deep link enters `tabs.openLink` in `backend/main.ts` (`leitura`);
- a `window` view's own tab, `navigate` views, and the identity-provider popup policy (S4) — outside
  this smoke's scope;
- Windows and Linux: not run (no machine), as in the spikes.

## 6. RF-69 embedded tabs (0.6.0a), and the tiling-WM rule

Owner decision 2026-10-19: the smoke adds **no** window-manager configuration. It keeps what it
already did (float this run's own windows before a measurement) and gained the rule below; a geometry
step the tiler has taken over is recorded, never passed, and the run goes on.

> A geometry check whose window `omniwmctl query windows` reports as `mode: "tiling"` at check time is
> **`blocked by the tiling WM`**, with the windows and frames quoted. Never `ok`; never a hard abort.

The runner's `/desk/onscreen` now also answers *which of this run's windows the WM has tiled*
(`tiled: string[]`, title + frame), and the driver asks it at the start of every placement step
(`checkOnSlot`, the resize follow, the dock-back, "Open as window"). The step's detail reads e.g.
`blocked by the tiling WM (Nod 1235x1312@2326,1528; Tool A 1235x1312@3587,1528): the tool window is
on an OmniWM tile, not on the slot … the slot box is 2394,-1228 1167x1190, the tab's page is
1235x1312 and the real frame is 3587,-1350 1235x1312`.

New fake tool and steps: **origin D** answers `X-Frame-Options: SAMEORIGIN` (`startTabTools`), the
seed names it `tool-d`; six steps were added, and the lock/unlock one now comes **before** "Open as
window" so it runs whatever happens to the conversion step:

| Step | What it drives |
| --- | --- |
| RF-69 docked again with one tab to embed | the Account card back to Docked, the old tabs closed, `tool_tool-a` as one docked tab |
| RF-69 Show inside Nod: no window, an iframe on the slot | the toolbar action; the row becomes `embed_tool-a` ▣ with no dock button, the window server shows **no** tool window, the visible `iframe.tab-embed`'s rect is the slot's, its `src` is the tool's URL, and the framed page reports itself |
| RF-69 switches and Home never reload the frame | another tab, back, Home, sidebar back: the same iframe node (a `data-smoke` marker survives), same `timeOrigin`/draft, one load |
| RF-69 an X-Frame-Options tool is refused | Tool D: the banner carries `X-Frame-Options: SAMEORIGIN`, the tab stays a window, the preference stays `["tool-a"]` |
| RF-69 lock and unlock restore it embedded | embedded, locked, entered through the Offline tile: `embed_tool-a` comes back embedded with its iframe |
| RF-69 Open as window brings the tab back | "Open as window": a docked window again, the iframe removed, the real frame on the slot (tiler-guarded) |

### Results (execução, unlocked screen, OmniWM active)

One run (before the tiling guard) reached the RF-69 steps with every printed step green:

| Step | Result | Numbers |
| --- | --- | --- |
| RF-52 default | ok | `mode=docked dockable=true`, no strip |
| RF-49 open one docked tab | ok | `tool_tool-a` docked+active, slot `1167x1190`, loaded in 957 ms |
| RF-49 lands on the slot | ok (that run) | page `1167x1190` on the slot; CGWindowList 1 tool window = the slot |
| RF-49 follows a resize / RF-50 second tab slot | ok (that run) | landed per the slot after the reseat |
| RF-50 second tab / switching | ok | `tool_tool-a, tool_tool-a_t2`; 1→2→1, draft+`timeOrigin` kept, **1 load** |
| RF-51 detach / dock back | ok | frame **0 → 122 pt**; docked back onto `2444,-1278 1167x1190`, 1 load |
| RF-66 popup / Open link… | ok | `popup1` after its opener, took the slot in **110 ms**; `link_1`/`link_2` in place |
| RF-68 ad-hoc API | ok | tool tab `ok`; `popup1` → `login.report only comes from a tool window`; `link_1` → `"login.report" is disabled by tinyjs.json "api"` |
| RF-67 view / tool | ok | view `doc` of tool-b; personal tool `p-…` with the probed title, sidebar `3 → 4` |
| RF-52 Windows mode | ok | `mode=windows active=null`, 5 tabs off the panel, Tool B window with a frame |
| RF-19 | ok | same window, 1 load |
| T6 | ok | tabs reopened in order, 2 ad-hoc tabs gone |
| RF-69 docked again | ok | 4 tabs closed, `tool_tool-a` one docked tab, embedded list `[]` |
| **RF-69 Show inside Nod** | **ok** | `embed_tool-a` ▣, no dock button, active; **0 tool windows** (settled 572 ms); iframe `1167x1190` at `68,90` = the slot; `src …/tab`; framed page reported (`timeOrigin 1792420944577`, `draft-6c8x8p`) |
| **RF-69 switches + Home** | **ok** | same iframe node, same `timeOrigin`/draft, **1 load** |
| **RF-69 XFO refused** | **ok** | `Tool D cannot be shown inside Nod — X-Frame-Options: SAMEORIGIN`; tab stays a window; preference `["tool-a"]` |
| **RF-69 lock/unlock embedded** | **ok** | locked from the sidebar, entered through the Offline tile: `embed_tool-a` (embedded, tool-a) reopened with its iframe (`src …/tab`), a fresh framed page (27.0 s for the step) |
| RF-69 Open as window | **blocked by the tiling WM** | `Tool A 1235x1312@3360,1528` — the WM took the window, so the slot measurement is not observable; the conversion itself is the step before it |

### The three-run tally on the tiling-guard build

| Run | Steps | Where it stands |
| --- | --- | --- |
| 1 | 14 ok, 4 blocked by the WM, then failed at RF-52 Windows mode | `the windows-mode window has no frame (-157 pt of border)`: that check took the *tiled* Tool B window (`omniwmctl` says `Tool B tiling 1235x1312@4672,1528`) and subtracted its page box from the tile's height. **Not a product failure**; in run 3 the same step passed (the WM had not taken that window then). The same tiler guard belongs on that check and on the popup's `waitPlaced` |
| 2 | 8 ok, 3 blocked by the WM, then failed at RF-66 popup | `the tab did not land on the slot within 2000 ms: … page box 1235x1312`: the popup was re-tiled while `waitPlaced` waited. Same class as above |
| **3** | **`ok`: 19 ok, 4 blocked by the WM, 23 steps, 50.2 s** | everything ran: RF-52, RF-49 (open ok; landing/follow blocked by the WM with their frames), RF-50 (second tab; its slot blocked), RF-51 detach+dock ✓, RF-66 ✓, RF-68 ✓, RF-67 ✓✓, RF-52 Windows ✓, RF-19 ✓, T6 ✓, RF-69 docked ✓, Show inside Nod ✓, switches/Home ✓, XFO refused ✓, lock/unlock embedded ✓, Open as window → blocked by the WM |

Every run: the owner's `resources/seed.json` came back (299 B) and `pgrep -fl tinyjs` showed nothing.

### Non-WM failures, with causes

1. **`timeOrigin` moving by 1 ms** (`…763 → …764`) failed "RF-50 switching keeps the draft" and
   "RF-19" once each: WKWebView's `performance.timeOrigin` is not stable to the millisecond between
   reads. The check now tolerates ±2 ms and keeps the **load count** as the proof of a reload.
2. **The harness sometimes records "did not run" after a step printed `ok`** (the XFO step's
   successor in the best run). Not diagnosed: no recorded step failed, yet the loop stopped. Worth a
   look at `run()`'s `stopped` bookkeeping.
3. The parse gate and the boot abort, both added after the owner saw a vite overlay on screen: the
   runner refuses to launch unless `Bun.build` parses `test/smoke/tabs-driver.ts`, and a launch with
   no window and no result after 25 s is killed and reported instead of waiting the full timeout.

### Dev runs and framed logins

`docs/handovers/e03-iframe-spike.md` stands: under `bun run app:dev` the top page is
`http://127.0.0.1`, so a framed tool's cookies are third-party and blocked — **a framed login is
release-only** (a release's `file://` top keeps them, except `SameSite=Lax`/`Strict`). Everything
asserted here is framing, geometry, state and no-reload; the framed reporting page needs no cookies,
which is why it works in dev.

## 7. 0.6.0b — Open tabs button and the embedded Sign in group

Two steps were added after the RF-69 block, on the same page:

| Step | Result (two green runs) | Numbers |
| --- | --- | --- |
| 0.6.0b Open tabs from Home, and not in Windows mode | **ok** (157 ms / 356 ms) | from Home the sidebar's `.mark-tabs` carries badge `3` for 3 open tabs (badge = `state.tabs.length`), clicking it brings the strip back with 3 rows; with the tabs closed the button is **disabled** (`true`); after switching to Windows mode the card redraws and `.mark-tabs` is **absent**; switched back to Docked for the next step |
| 0.6.0b embedded Sign in copies username and password | **ok** (910 ms / 623 ms) | `vault.save({ toolId: 'tool-a', username: 'person@test', secret: 'secret-a' })` (the fake pair `tools.ts` accepts, never a real credential), then "Show inside Nod" on Tool A → the banner reads `Tool A will not be signed in automatically inside Nod — use Sign in on the tab to copy your login.`; **Copy username** put `"person@test"` on the clipboard; **Copy password** passed the dev gate with the account password and put `"secret-a"` there; the clipboard was cleared afterwards (`""`) through `tiny.clipboard.write` |

Clipboard: read with `tiny.clipboard.read()` (the native pasteboard through the runtime, no polling);
`setClipboard`/the final clear try `write({ text })` and fall back to `write(text)`.

### Runs after the two steps (unlocked screen)

| Run | Verdict | Detail |
| --- | --- | --- |
| A | **`ok`, 25 steps, 3 blocked, 22.3 s** | both 0.6.0b steps green; RF-69 "Open as window" green that time (real frame on the slot) |
| B | **`ok`, 25 steps, 4 blocked, 21.8 s** | both 0.6.0b steps green; "Open as window" `blocked by the tiling WM` |
| C | failed at "RF-69 Open as window" | the WM tiled the freshly converted window between the guard and the measurement: the real frame is the tile (`3619,-1400 1235x1312`) while the slot is `3687,-1278 1167x1190`. **WM timing, not the product**: the guard is read a moment before `measure`, so a re-tile in between still reaches the assertion |

Every run restored `resources/seed.json` (299 B, the owner's) and left no `tinyjs` process
(`pgrep -fl tinyjs` empty).

### Fixes made to the smoke in this round (no product code touched)

1. **A page module may only take *types* from `test/smoke/tools.ts`.** Importing its values pulled
   `node:child_process` into the page bundle: vite failed the module and the page never booted (two
   240 s runs, windows left on screen). The fake pair is now two literals in the driver, and the
   pre-launch gate also refuses a page module whose own imports name a runtime builtin.
2. **The boot guard** no longer waits for "no window": a launch that writes nothing to the store for
   25 s is killed and reported (a booted page that cannot write is just as broken).
3. **`checkEmbedRestored` tolerates an already-embedded tab** (the toolbar then offers "Open as
   window"), and **"Open as window" measures the page the new window loads**, not the dead iframe's
   page box (which is what made its page-box assertion fail).
4. **The Account card's radios are read again after the card redraws** — the nodes a mode switch
   leaves behind are out of the document, and a click on them did nothing.
5. The tiling-WM rule is judged **at check time**, after the reseat, in "Open as window" — run C above
   shows the remaining window of a few hundred milliseconds in which the WM can still take the window.

## 8. 0.6.0c — RF-70 login-block (`loginCookieRisk`, `embedBlocked`)

A fifth reporting tool and two steps were added. They first failed or hung (table below), then passed
in two orchestrator runs on current files.

### Added

- **origin E** (`startTabTools`) — the same reporting page with a same-origin `/cookies.js` that
  carries the js-cookie shape `shared/tabs.ts` `loginCookieRisk` looks for:
  `Cookies.set("t", "v", {expires: 365, path: "/", secure: true, sameSite: "strict"});` (flat literal,
  `expires:` beside `sameSite: "strict"`). The seed names it `tool-e`.
- **0.6.0c a strict-cookie login write refuses the iframe** — opens Tool E as a window, "Show inside
  Nod": the banner must carry the reason (the matcher is the tolerant `shown inside Nod` plus
  `/samesite/i`), the tab must stay a window, the preference must stay without `tool-e`, and
  `embedBlocked['tool-e']` must carry the string.
- **0.6.0c Login won't stay? Open as window blocks the tool** — on the embedded Tool A of the Sign in
  step: the toolbar button converts the tab to a window **at the same strip index**, `embedBlocked`
  gets `tool-a`, the preference drops `tool-a`, and a second "Show inside Nod" is refused with
  `the tool did not keep its login inside Nod`.

### What execution showed

| Attempt | Result | Detail |
| --- | --- | --- |
| runs A/B (before the wording fix) | failed at the **existing** "RF-69 an X-Frame-Options tool is refused" step | the 0.6.0c product changed that banner to `… can't be shown inside Nod: …` while the check still waited for `cannot be shown inside Nod`; 20 s timeout, everything after it did not run. The check was fixed to match `shown inside Nod` (both wordings) |
| runs C/D (after the fix) | **no verdict** — both were killed past 5 minutes with no step lines | the page wrote nothing this time and the launch had to be killed by hand: the app (pids seen by `pgrep -fl tinyjs`) and the temporary seed were left behind and were restored afterwards (`resources/seed.json` 299 B, `tinyjs.json` `devUrl` 5173, no process left). The cause is not diagnosed; the pre-launch parse gate passed, so the module is syntactically valid — the next step is to read the app's own output for those launches (the runner prints it on failure) and to check whether the new Tool E page's script breaks the report page's module |
| runs E/F (orchestrator, `bun test/smoke/tabs.ts --force`) | **`ok`**, 27 steps; run E 3 blocked (page hidden), run F 4 blocked (tiling WM) | both 0.6.0c steps green in both runs: Tool E refused with `the tool's page saves its login in a SameSite=strict cookie, which a tab inside Nod cannot store`; "Login won't stay? Open as window" put `tool_tool-a` at strip index 0, `embedBlocked[tool-a]` = `the tool did not keep its login inside Nod`, preference `[]`, and the next "Show inside Nod" was refused. No `tinyjs` process left, seed restored. The C/D hang did not recur and stays undiagnosed |

The rule was also checked against the live tools (execução, orchestrator, `shared/tabs.ts`
`scriptSources` + `loginCookieRisk` under Bun): `kanban.copland.studio` (Planka) → flagged;
`affine.copland.studio`, `jitsi.copland.studio`, `copland.studio` → not flagged. A first, broader
rule flagged Jitsi (library cookie defaults in its bundle); the rule was narrowed to a flat object
literal carrying `expires:` beside `sameSite:"strict"|"lax"`.

### Note on the contract

`local://e03-loginblock.md`'s two signals are both covered by the fake tool chosen here (the script
shape); the `Set-Cookie: SameSite=…` half is not exercised by the smoke — a deliberate omission, it
would need a second tool and the same page.
