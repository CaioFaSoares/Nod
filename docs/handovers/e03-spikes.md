# Slice E03 — spikes S0–S4 (docked tabs: geometry, frame toggle, follow, focus, popup adoption)

Authorizing issue: epic E03 (`docs/epics/E03-docked-tabs.md` §4), release 0.6.0, owner 2026-10-19.
Environment: macOS 27.0.0 arm64 (Apple M4), tinyjs 0.57.2 (txiki.js 26.6.0), one display
2294×1490 with the usable area 2294×1382 at y=49, Bun 1.4.3.

Everything below is `execucao` on this machine. It was obtained with a **throwaway app outside the
repo**: `/tmp/nod-e03-spike/`, app id `copland.spike.e03`, which the repo's `tinyjs.json`, `.build/`
and the `copland.nod*` data directories were never touched for. No repo file is changed by this
slice other than `docs/handovers/e03-spikes.md` and the appended section of
`docs/issues/B05-geometria-janelas-ferramenta.md`.

Spike harness (all of it under `/tmp/nod-e03-spike/`, kept for the re-run):

| Piece | What it is |
| --- | --- |
| `tinyjs.json` | id `copland.spike.e03`, `popups: "window"`, `api.origins` = `{ "file://*": "all", "http://127.0.0.1:47811": "all" }` (47812 deliberately absent) |
| `backend/main.ts` | everything runs here: it opens windows, drives page-side code with `app.window(id).eval`, samples `getState()`, and appends every measurement to `results.json` (plus `E03 …` lines on stdout). Phases S0…S7. |
| `frontend/index.html` | main window page: a `#slot` rect, its `getBoundingClientRect()` reporter, a `ResizeObserver` on `#slot`, a `setSlot(w,h)` used to trigger it |
| `frontend/win.html` | tool-window page: input, `window.__spike` (`setInput`/`readInput`/`reportState`/`openPopup`/`clickBlank`), a body `ResizeObserver`, a `message` listener |
| `server.ts` | Bun fixture "site" on 47811 (`/remote.html` — the http page mirroring the repo's remote tool pages; `/popup.html` — posts to `window.opener`, then closes itself) and on 47812 (`/unlisted.html` — a page whose origin is **not** in `api.origins`) |
| `winlist.swift` → `winlist` | compiled Swift helper: `CGWindowListCopyWindowInfo` front-to-back window list (order/pid/owner/title/level/bounds) + the frontmost app. Real on-screen truth, next to `getState()` |

## 1. The environment decides S0/S1/S2 on this machine (found by `execucao`)

This machine runs **OmniWM 0.7.4** (`/Applications/Nix Apps/OmniWM.app`, `~/.config/omniwm`), a
Niri/dwindle **tiling** window manager, configured with no floating/app rule for a tinyjs app. It
manages the app's windows:

```
$ omniwmctl query windows --app "E03 Spike" --fields title,frame,mode,layout-reason,is-visible --format json
… every window: "mode": "tiling", "layoutReason": "standard",
   and at that moment every one of them had the same frame 1102×1303 at x=0,y=97 …
```

That is byte-for-byte the symptom of B05: the app's windows all sharing one identical rect. While
OmniWM is arranging, the frames the Nod asks for are overridden (`docs/issues/B05-…` now carries the
cause). Two regimes were measured, and the numbers below say which one every figure comes from:

- **regime T (tiler arranging)** — run 2, session active at the start: requested rects land
  (`getState()` at +62 ms is exact) and the tiler moves the windows to its own tiles **within
  ≲200 ms** (the overlay of S1 read the requested 637,299 500×340 at +200 ms and 1160,90 1102×1303
  after the tile; S0's `s0a` read 80,129 640×440 at +62 ms and 1102×1271 by +738 ms).
- **regime I (tiler inert)** — runs 3 and 4, when the session was locked (`frontmost =
  loginwindow`): every requested rect landed **and held** (S5 polled `s5poll` 60 times over 1.6 s at
  exactly 100,500 560×380; S0's variants all exact). In regime I `getState()` and the real
  `CGWindowList` frame diverge (S7) — see §7.

Both regimes agree on the API itself, which is what the epic needs.

## 2. S0 — does `x`/`y`/`size` at open land? Does an immediate `setPosition`/`setSize` land?

Run (`execucao`, runs 2/3/4), all from the backend:

```js
app.win.open('s0a', { page: <abs win.html>, title: 's0a', x: 80, y: 129, size: '640x440' });
// readback right after, then in the same tick:
app.window('s0a').setPosition(90, 139); app.window('s0a').setSize(660, 460);
```

| Request | `getState()` readback | Verdict |
| --- | --- | --- |
| open at 80,129 640×440 | 80,129 640×440, outer 640×472, `open()` returns in ≤1 ms, readback at +39 ms | **lands** |
| `setPosition(90,139)`+`setSize(660,460)` in the same tick | 90,139 660×460 at +4.8 ms; the two calls cost 0.13–0.36 ms together | **lands** |
| the same `setPosition`/`setSize` *after* the page's load | exact | **lands** |
| `chrome: {frame:false}` at open (x 780 y 129, `'520x380'`) | 780,129 520×380, `outer == page box` (520×380), `chrome.frame === false` | **lands** |
| an **http** page (47811/remote.html, x 80 y 609, `'560x400'`) — the shape of the repo's tool windows | exact at +80 ms and still exact at +1.5 s; `setPosition(120,649)`+`setSize(600,420)` exact | **lands** |
| the repo's own numbers (`main.x+28`, `main.y+28`, 1280×800 capped at 90 % of the visible area) | 625,235 1280×800, exact at once and 300 ms later | **lands** |
| **no** geometry at all (`{page,title}`) | 847,287 600×400 (tinyjs's default 600×400 page and its default position) | **not** the main window's rect |
| `size` only | 847,287 600×400 (default position, requested size) | — |
| `x`/`y` only | 280,329 (requested) with the default 600×400 | — |

Verdict: **S0 passes**. The cause of B05 is not in this code path — `x`/`y`/`size` at open and an
immediate `setPosition`/`setSize` both land, on a local `file://` page and on an http page, framed or
frameless, with or without the page loaded, from the same tick as `open()`. What made the repo's
tool windows come out at the main window's bounds is the tiling WM of §1 (and, per §7, `getState()`
never shows it in regime I, which is why the repo's own readbacks never caught it). B05 is closed
with that cause and the recipe of §8.

## 3. S1 — frame toggle on a live window, and the slot-rect formula

Main window (`execucao`, run 4): `getState()` → `x 597 y 207 width 1100 height 720`,
`outer 1100×752`. The main page reported `innerWidth/innerHeight = 1100×720`, so **`getState()`'s
page box is exactly the viewport in CSS px (1 CSS px = 1 point here)** and the viewport's origin is
the page box's top-left. Therefore:

```
dx = outer.width  - width  = 0        // no side borders on macOS
dy = outer.height - height = 32       // the title bar
screen_rect = {
  x: main.x + dx / 2 + rect.left,     // rect = element.getBoundingClientRect() of the slot
  y: main.y + dy     + rect.top,
  w: rect.width,
  h: rect.height
}
```

Measured: `#slot` at (40,60) 500×340 → (597+0+40, 207+32+60) = **637,299 500×340**; the overlay
window opened frameless at exactly that rect read back **637,299 500×340** with
`outer == page box` (`matchesRequest: true`, `outerEqualsPageBox: true`).

Frame toggle on the **live** window, same rect, `chrome.frame` false → true → false:

| | `setChrome` call | `chrome.frame` | frame x,y | outer | page box | page state |
| --- | --- | --- | --- | --- | --- | --- |
| before | — | false | 637,299 | 500×340 | 500×340 | `timeOrigin` T0, input `DRAFT-E03`, `window.__marker = 'M-overlay'` |
| `setChrome({frame:true})` | 0.022 ms | **true** | 637,267 | 500×372 | **500×340** | `timeOrigin` still T0, input still `DRAFT-E03`, marker still set |
| `setChrome({frame:false})` | 0.098 ms | **false** | 637,299 | 500×340 | 500×340 | same |

- The frame grew **upward** by the 32 pt title bar (y 299→267, outer 340→372) and the **page box did
  not change**: no reflow, no resize of the page.
- **The page did not reload.** `performance.timeOrigin` was identical before and after both toggles,
  the typed input and a JS global set before the toggle survived, and the window produced exactly
  **1 navigation** in the whole run (its initial load: 1 `finish` event).
- Regime T behaves the same way for state, but the WM pins the window frame, so the toggle takes the
  32 pt out of the page box instead (1303→1271→1303 in run 2). Either way the page keeps its state.

Verdict: **S1 passes on macOS**: the frameless window lands exactly on the computed slot rect, and
`setChrome({frame:true/false})` toggles the frame of a live window with the page state intact (a
draft typed in an `<input>` survives detach and dock).

## 4. S2 — follow (move polling) and resize (`ResizeObserver` → `api` → `setSize`)

`execucao`, run 4:

- **`getState()` cost**, 200 rounds after 3 warm-ups: min **0.029**, median **0.034**, p90 **0.051**,
  max **0.112**, mean **0.038 ms** (whole 200 rounds: 7.7 ms). Runs 2/3: median 0.034–0.035,
  max ≤0.246.
- **`setPosition` is synchronous** on the backend: the call itself costs **0.015–0.017 ms** and
  `getState()` right after returns the new x/y (so the launcher applies it before the next bridge
  round-trip).
- **Follow while `main` moves**, with the backend polling `app.win.getState()` and re-placing the
  overlay every 50 ms (the poll's own read of both windows cost 0.20–1.16 ms per tick):
  main moved 347,287→747,167 at t=1231.8 ms, the overlay reached 787,259 at t=1284.1 ms →
  **lag 52.3 ms**; main moved 747,167→597,207 at t=2416.4 ms, the overlay reached 637,299 at
  t=2467.8 ms → **lag 51.5 ms**. That is exactly one poll interval: no extra lag, no drift while the
  poll runs.
- **Resize round trip** (`ResizeObserver` in the main page → `tiny.api.call('slotRect')` → backend
  `setPosition`/`setSize` on the overlay): page→backend **1–2 ms**, the two handle calls **0.026–0.057
  ms**, and the overlay's own `ResizeObserver` reported the new page box **2–4 ms** after the
  page-side change (`overlayConfirmed` 560×400; run 2: 1 ms backend-side, 4 ms page-side). End to end
  **≈2–4 ms**.

Verdict: **S2 passes on macOS**: a 50 ms poll costs ~0.04 ms per `getState()` and holds the docked
tab on the slot with a ~50 ms lag during a move (invisible at rest, noticeable only while dragging);
resize propagation is ~4 ms.

## 5. S3 — stacking and focus

Order below is the real front-to-back order from `CGWindowList` (0 = frontmost), matched by window
title (`execucao`, run 4; `frontmost = loginwindow`, i.e. the session was locked, so the OS would not
give the app focus and every `focused` flag read false):

| Step | main | overlay | s0a |
| --- | --- | --- | --- |
| before | 19 | **11** | 18 |
| `app.win.show()` (main, activate) | **11** | 12 | 19 |
| `app.window('overlay').show({ activate: false })` | 12 | **11** | 19 |

So focusing main puts main in front **and drops the docked tab behind it** — exactly the failure the
epic worries about — and `show({activate:false})` on the tab puts it back **above** main. Run 2
(session partly active) reproduced the same two orderings.

Focus events: `onWindowState` does receive the main window and carries the id and the flag — run 2
delivered `{win:"main", focused:true}`, then `{win:"main", focused:false}` and `{win:"s0a",
focused:true}` when a tool window took focus; run 4's locked session emitted `focused:false` for every
window because the OS never activated the app.

Verdict: **S3 passes for the stacking half** (`show({activate:false})` is the recipe), and the
focus/`activate` half is **inconclusive here**: the session was locked, so neither activation nor the
`focused` flags could be exercised. Re-run needed with the machine unlocked; the flag and the hook
are otherwise proven to work (run 2).

## 6. S4 — popup adoption, `window.opener`, the origin gate

`execucao`, runs 1–4, `"popups": "window"` in `tinyjs.json`, popups opened from the tool page `s0a`:

- **id format: `popup<N>`** — `popup1`, `popup2`, … sequential within the app run (never reused while
  the app lives; the popups of one run were `popup1…popup7`).
- **Events on `window.open`**: first
  `{ window:"popup1", opener:"s0a", url, kind:"policy", mode:"window" }`, then
  `{ window:"popup1", url, action:"window", kind:"open" }`. The **`opener` comes on the `policy`
  event only**; the `open` event carries the id and `action`.
- **Adoption works**: `app.window('popup1').setChrome({frame:false})`, `.setPosition(120,180)` and
  `.setSize(500,380)` on the live popup read back exactly (120,180 500×380, `frame:false`); the three
  calls cost **0.045–0.074 ms**; the popup page did **not** reload (`timeOrigin` unchanged,
  `innerWidth/Height` 500×380).
- **`onNavigate` fires for the popup with its id**: `{window:"popup1", url, kind:"policy"}` and
  `{window:"popup1", kind:"finish", url}`.
- **`window.opener.postMessage` reaches the opener**: the popup (origin
  `http://127.0.0.1:47811`) posted and the opener page received it (`win_message`, `who:"s0a"`,
  `origin:"http://127.0.0.1:47811"`). The OAuth-style callback path holds.
- **The `api.origins` gate refuses the unlisted origin**: the page on 47812 (not in `api.origins`)
  got `"note" is disabled by tinyjs.json "api"` and tinyjs logged
  `tinyjs: denied "note" for http://127.0.0.1:47812 (tinyjs.json "api")`, while the listed origin
  47811 was served. `scripts/gen-config.ts` (`leitura`) builds exactly this: `origins` gets
  `"file://*": "all"`, the dev origin `"all"` in dev, and each seed tool origin
  `["login.report","media.camera","media.microphone"]` — an origin that matches no key inherits
  nothing.
- **`window.close()` from the popup**: in run 1 (session active) a popup the backend **never touched**
  closed itself (`window.close()` after the page's own 2.6 s timer → `onWindowClosed` for `popup2`),
  while `popup1`, which the backend had re-chromed and re-positioned, **never closed**, not even on an
  explicit `window.close()` eval later in the session. Runs 2–4 reproduced that (every touched popup
  stayed open); those runs are confounded by the locked session and occluded windows (throttled
  timers), so the clean A/B is run 1. `app.window(id).close()` from the backend always worked.
- A programmatic `<a target=_blank>` click in a test page opened **nothing** (tried `a.click()` and a
  dispatched `MouseEvent('click')` 60 ms later); `window.open(url,'_blank')` opened a popup normally.
  Not a product limit — a limit on how the spike could synthesise the link click.

Verdict: **S4 passes on macOS**, with one caution: keep the popup's chrome/geometry untouched until
it closes itself if the flow closes itself (an OAuth popup), or close it from the backend.

## 7. What fed B05's cause: the tiler, and `getState()` vs the real frame

- `execucao` (run 2, session active): `omniwmctl query windows --app "E03 Spike"` returns every
  window with `"mode":"tiling"`, `"layoutReason":"standard"`, all sharing one frame — the exact
  artifact B05 recorded with `CGWindowListCopyWindowInfo`.
- `execucao` (run 4, session locked): for the same window, `getState()` reports what the Nod asked
  for (120,160 560×380) while `CGWindowList` reports the tiler's frame (222,218 505×372); two
  `setPosition`/`setSize` re-applies and two window creations changed **neither**. So under a tiling
  WM, `getState()` is not the on-screen truth, and re-applying the rect does not take the window back.
- `parent: 'main'`, `setLevel('floating')` and `chrome:{frame:false}` were opened side by side (S5/S7)
  and the tiler moved all of them; the floating-level window did leave the normal window layer (it
  stopped appearing in the layer-0 `CGWindowList` list), which is the only hint that a level change
  is visible to the WM at all — not enough to call it a fix.
- `execucao` (run 3, tiler inert): all S5 rects landed and held, including through new-window events.

## 8. The recipes (implementation contract for E03)

1. **Fallback for a screen `main` sits on that cannot be told** — keep `geometry()` as it is; when it
   returns `null` do **not** expect the main window's rect: tinyjs's own default is a 600×400 page at
   its own default position (measured 847,287).
2. **Docked tab** — `app.win.open(id, { page, title, x, y, size: 'WxH', chrome: { frame: false } })`
   with the §3 formula; then, still in the same tick,
   `app.window(id).setPosition(x, y); app.window(id).setSize(w, h);`. Both land. Do not wait for a
   navigation event to place it (it lands immediately).
3. **Detach** — on the live handle: `setChrome({ frame: true })` then a step off the slot
   (`setPosition`). **Dock back**: `setPosition`/`setSize` to the slot, then
   `setChrome({ frame: false })`. No reload, page state and drafts survive (measured).
4. **Follow** — a backend `setInterval` of **50 ms** reading `app.win.getState()` and calling
   `setPosition`/`setSize` on the visible tab; cost ≈0.04 ms per tick, lag ≈ one interval (52 ms
   measured). Only poll while `main` is focused and visible, as the epic says.
5. **Resize** — the main page's `ResizeObserver` on the slot calls `tiny.api.call('slotRect', …)`;
   the backend applies `setPosition`/`setSize`; end to end ≈4 ms.
6. **Stacking** — on `main`'s focus, `app.window(id).show({ activate: false })`; it raises the tab
   above main **without** activating it. Never use a plain `show()` on the tab.
7. **Popup adoption** — keep `"popups": "window"`; use the `policy` event's `opener` to place the new
   tab after its source (`window` id is `popup<N>`); re-chrome/re-place it only if the flow does not
   close itself; if it does, leave the chrome alone (or close it from the backend).
8. **The gate** — a tab whose origin is not in `api.origins` gets no method; nothing else to add.
9. **On a tiling-WM desktop this recipe cannot hold the rect.** The window manager owns the frame:
   the tab will be tiled, `getState()` may still report the requested rect (measured divergence
   above), and re-applies do not win. Detect it (a `getState()` vs real-frame check, or a coarse
   "position did not change after setPosition" probe) and, per the epic's own rule for a failing OS,
   do not offer docked mode there — offer Windows mode. On OmniWM specifically the person can float
   the app's windows (`omniwmctl command toggle-focused-window-floating`, or an app rule in
   `~/.config/omniwm/settings.toml`); the Nod cannot force this through the tinyjs API.

## 9. Not run

- **Windows**: not run (no machine).
- **Linux / Wayland**: not run (no machine). The `canPosition` half of the epic therefore has no
  measurement from here.

## 10. Open items

1. Re-run S3 with the session unlocked to record `focused` flags and, above all, that
   `show({activate:false})` really does not steal focus from main (the ordering half is measured).
2. Pin down why a popup the backend re-chromed no longer honours its own `window.close()` (run 1's
   clean A/B; likely the launcher's popup bookkeeping, not the WM).
3. Decide whether E03 should ship the tiler detector of §8.9 or simply offer Windows mode when the
   first `setPosition` probe does not move the real frame.
