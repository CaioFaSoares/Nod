# E06 — Electrobun parity matrix

Row-by-row answer to `docs/handovers/e06-tinyjs-surface.md` (sections A–J, numbering kept), plus the
surface the Electrobun target **adds or changes** (K). Built on 2026-10-22 by `leitura` of
`electrobun/**` and the E06 records; every status is about the **implementation that exists in the
tree**, while the evidence column says whether an `execução` ever proved it. The first matrix was
`leitura` only; the **final round** (`PS` §6) then ran the eight smokes and one packaged build, and
the rows it settled cite that round.

Status legend:

- **done** — the member/behavior has an implementation on the target and no known divergence.
- **done with gap** — implemented, with a named divergence or an unexercised branch (see §Gaps).
- **not applicable** — the tinyjs item has no counterpart **and no need** on this target (or was
  retired with the 2026-10-22 tab decision).
- **missing** — no implementation in the tree.

Evidence abbreviations (all records in `docs/handovers/`):

| Tag | Record | What it is |
|---|---|---|
| **SC** | `e06-surface-check.md` | `execução`, packaged `Nod.app` driven through the AX tree |
| **PS** | `e06-parity-smoke.md` | `execução`, the four smoke runners with `--runtime=electrobun` |
| **VS** | `e06-view-spike.md` | `execução`, throwaway spike: in-window views, detach/dock, focus |
| **NAT** | `e06-native.md` | `execução`, throwaway apps: keychain, LA sheet, icon, panels, re-parent |
| **ES** | `e06-electrobun-spike.md` | `execução`, throwaway spike: the 44-row capability matrix |

`leitura only` means the implementation was read, not run. `SC §9` etc. are the record's own
sections. Where a record covers several rows of a block, the row names the step that exercises it.

## A. Backend — `TinyApp` surface (26)

| # | tinyjs item | Electrobun implementation | Status | Evidence |
|---|---|---|---|---|
| A1 | `init(app)` | `electrobun/bun/index.ts` — `createApp(...)` then `backend.init(app)` | done | `execução`: SC §1 (packaged boot), PS §4.1 |
| A2 | `app.paths()` → `.data`, `.resources` | `facade/app.ts` `createApp` (`TinyPaths`, `resources` from `RESOURCES_FOLDER/app/resources`) | done | `execução`: SC §1 (DB/data dir), SC §9 (bundled seed read), SC §11 (`userData` size) |
| A3 | `app.system.capabilities()` | `facade/app.ts` `capabilities()` — `authenticate`, `hotkey`, `tray`, `icon` (exactly the four keys `backend/main.ts` reads) | done | `execução`: SC §2 (tray), §3 (hotkey), §6 (authenticate) |
| A4 | `app.system.os()` | `facade/app.ts` `system.os()`; OS from `process.platform` in `index.ts` | done | `execução`: SC §2/§3 (macOS combos, tray, dockability) |
| A5 | `app.info()` → `.version` | `facade/app.ts` `info` (`version` from `tinyjs.base.json`, `runtime: 'Electrobun'`) | done | `execução`: SC §9 (Settings shows the installed version after the swap) |
| A6 | `app.icon(path)` | `facade/app.ts` `icon()` → `facade/native.ts` `setIcon` → `NodNative.swift` `setAppIcon` | done with gap | `execução`: NAT (`setAppIcon` applied/restored); SC §7 **blocked** for the guild path (no guild icon offline) |
| A7 | `app.store.get(key)` | `facade/store.ts` `createStore` (JSON at `userData/store.json`, atomic write) | done | `execução`: PS §4.2 (page prefs preserved), SC §1 |
| A8 | `app.store.set(key, value)` | same `store.set` | done | `execução`: PS ui/tabs drivers (`tiny.store.set`) |
| A9 | `store.get('dismissed_update')` | same store, no special path | done | `leitura only` (same code path as A7) |
| A10 | `app.secrets.get/set/delete` | `facade/native.ts` `secrets` → `NodNative.swift` `keychain.*` | done | `execução`: NAT (`set/get/delete`, then `null`) |
| A11 | `app.authenticate(reason)` | `facade/native.ts` `authenticate` (`begin`/`poll`/`cancel`, 5-min deadline) | done | `execução`: NAT (sheet, pending, cancel); SC §6 (reveal + password fallback) |
| A12 | `app.window(id)` | `facade/windows.ts` `window(id)` (guarded handle factory) | done | `execução`: PS §4.1/§4.2 (tool windows opened and driven) |
| A13 | `main.setMinSize(760, 500)` | `facade/windows.ts` `setMinSize` → `native.setContentMinSize` | done | `execução`: NAT (`enqueued true`); floor not visually measured |
| A14 | `app.win.setHideOnClose(true)` | `facade/windows.ts` `setHideOnClose` + `hideOnClose`: close → `hideApp` (app hide) when `main` is the last OS window; window-only `hide()` when a tool/carrier window is on screen; `setTerminationHold` arms on macOS | done | `execução`: SC §5 (red button hides with a tool window open, app alive); PS §6.6 (a) last-window close with no other window: prevented, `NSApp.hide`, alive at 30 s, tray Open Nod shows the window; (b) main hidden, tool window stays; (c) tray Quit exits in 1 s. The earlier ~0.4–2 s death was the machine's Vorssaint utility, not macOS automatic termination, and hits tinyjs too — gap 27 |
| A15 | `app.win.open(id, opts)` | `facade/windows.ts` `open` → `createEmbedded` / `createCarrier` / `create` | done | `execução`: SC §1 (tool tab + popup window), PS §4.1 step 6 |
| A16 | `app.win.getState()` | `facade/windows.ts` `getState` / `embeddedState` (page box + screen rect) | done | `execução`: PS §2.3/§4.3 (tab placement read; WM blocked the measurement) |
| A17 | `app.screens()` | `facade/windows.ts` `screens()` over `Screen.getAllDisplays()` | done | `leitura only` |
| A18 | `app.hotkey.register(id, combo)` | `facade/app.ts` `toAccelerator` + `GlobalShortcut.register` | done | `execução`: SC §3 (⌘K, ⌘1) |
| A19 | `app.hotkey.unregister(id)` | same block, `unregister`; released on blur | done | `execução`: SC §3 (register/unregister cycle in the app log) |
| A20 | `app.tray.set(spec)` | `facade/app.ts` `tray` + `trayMenu` + `trayImage` → `facade/native.ts` `renderTrayIcon` → `NodNative.swift` `renderTrayIcon` (`sf:`/`emoji:` drawn to an 18 pt png in the app cache) | done | `execução`: SC §2 (menu order, click); `leitura only`: `sf:`/`emoji:` rendering (unit tests; built dylib rendered 18×18 pngs) |
| A21 | `app.push(event, data)` | `electrobun/bun/index.ts` `send()` → `mainRpc.send['api.event']` | done | `execução`: PS §4.2 (session/tools/tab/catalog/update/host/join pushes drive the pages) |
| A22 | `app.update.check()` | `facade/update.ts` `createUpdate().check` (`eb-manifest.json`) | done | `execução`: SC §9 (notice + notes) |
| A23 | `app.update.install()` | `facade/update.ts` `installOnce` (sha256, zstd/tar stage, swap helper, `refusal()`) | done | `execução`: SC §9 (install/relaunch, tampered sha refused, rollback) and SC §12 (5× rollback from a just-swapped bundle after the `tar --zstd`/`PATH` fix); refusals logged in `updates/install.log` and audited |
| A24 | `app.quit()` (`nod.quit`) | `electrobun/bun/index.ts` `quit` → `Utils.quit()` | done | `execução`: SC §2 (Quit Nod: pids gone) |
| A25 | `app.quit()` (tray `'quit'`) | same `quit` via `onTray` | done | `execução`: SC §2 |
| A26 | `main.show()` | `facade/windows.ts` `show` | done | `execução`: SC §5 (tray Open Nod) |

## B. Backend — `TinyWindowHandle` methods (8)

| # | tinyjs item | Electrobun implementation | Status | Evidence |
|---|---|---|---|---|
| B1 | `eval(js)` | `facade/windows.ts` handle `eval` → `BrowserView.executeJavascript` | done | `execução`: PS §4.1 step 10 (login fill); VS §1 (`executeJavascript` in a sandboxed view) |
| B2 | `close()` | handle `close` | done | `execução`: SC §1 (Lock closed the tool window), PS §4.4 |
| B3 | `show(opts?)` | handle `show` (`{activate:false}` → `showInactive`) | done | `execução`: PS §4.3 (tab switching), PS §4.1 step 8 |
| B4 | `hide({app:false})` | handle `hide` → `facade/native.ts` `hideApp` (`NSApp.hide` on `main`; `{app:false}` → window/view hide) | done | `execução`: PS §6.4 (RF-50 tab switches hide/show the inactive docked views, 338 ms, 1 load; A14's window hide in PS §6.5); `{app:true}` (`NSApp.hide`) still `leitura only` |
| B5 | `setPosition(x,y)` | handle `setPosition` (window / docked view) | done | `execução`: PS §4.3 (RF-51 detach/dock) |
| B6 | `setSize(w,h)` | handle `setSize` (page-box units, titlebar compensated) | done | `execução`: PS §4.3 (detached window sized) |
| B7 | `setChrome({frame})` | handle `setChrome` → `detachTab` / `dockTab` (AppKit re-parent, no reload) | done | `execução`: PS §4.3 (RF-51 detach 3355 ms, dock 1608 ms) |
| B8 | `setMinSize(w,h)` | handle `setMinSize` → `native.setContentMinSize` | done | `execução`: NAT (enqueued); main floor not visually measured |

## C. Backend — `tjs` globals & `tjs:sqlite` (13)

All file rows are `electrobun/bun/tjs-shim.ts` `installTjs()` over Bun's `node:fs/promises`; the DB
rows are `electrobun/bun/sqlite-shim.ts` `Database`/`Statement` over `bun:sqlite`, aliased by the
generated config (`build.bun.alias`).

| # | tinyjs item | Electrobun implementation | Status | Evidence |
|---|---|---|---|---|
| C1 | `tjs.makeDir(data,{recursive})` | `tjs-shim.ts` `makeDir` → `mkdir` | done | `execução`: SC §1 (data dir/DB created at boot) |
| C2 | `tjs.makeDir(icons)` | same `makeDir` | done | `execução`: PS §2.4 (icon file written in the Electrobun data dir) |
| C3 | `tjs.writeFile(icon)` | `writeFile` → `node:fs/promises.writeFile` | done | `execução`: PS §2.4 (P's `guild-icon.png`, 304 bytes) |
| C4 | `tjs.writeFile` (guild icon, export) | same `writeFile` | done | `execução`: PS §4.1 step 11 (`events.exportToFile`), PS §2.4 |
| C5 | `tjs.readFile` | `readFile` → `Uint8Array` | done | `execução`: PS §2.4 (DB/icon read back), SC §9 (seed read) |
| C6 | `tjs.readFile(icon)` | same `readFile` | done | `execução`: PS §2.4 |
| C7 | `tjs.readFile` (seed staging) | same `readFile` | done | `execução`: SC §1 (bundled seed applied) |
| C8 | `tjs.rename` | `rename` → `fs.rename` | done | `leitura only` (legacy-DB move not exercised) |
| C9 | `tjs.stat` | `stat` → `{isFile,isDirectory,size}`; `ENOENT` passes through | done | `leitura only` |
| C10 | `tjs.remove` | `remove` → `rm(force:false)` | done | `leitura only` |
| C11 | `tjs:sqlite` `Database` | `sqlite-shim.ts` `Database` (`new`, `exec`, `prepare`, `close`) | done | `execução`: PS §2.4 (DB scanned: 16 tables/112 columns, 0 plaintext) |
| C12 | `Statement.run/.all` | `sqlite-shim.ts` `Statement` | done | `execução`: PS §4.4 (all phases read/write through it) |
| C13 | `tjs.env` | `tjs-shim.ts` `env: process.env` | not applicable | `leitura only` — nothing in the backend reads it (surface inventory C13) |

## D. Backend — `fetch` specifics (7)

| # | tinyjs item | Electrobun implementation | Status | Evidence |
|---|---|---|---|---|
| D1 | Wiring (`createHostClient({fetch})`) | global Bun `fetch`; page `tiny.fetch` goes through `index.ts` `fetch` handler | done | `execução`: PS §4.1 step 3/4, PS §4.4 |
| D2 | Host calls `redirect:'error'` | `index.ts` fetch handler passes `init.redirect` through; `backend/host-client.ts` unchanged | done | `execução`: PS §4.4 (all host calls; a redirect would throw) |
| D3 | Deadline (timer race) | backend code unchanged; Bun timer + fetch | done | `execução`: PS §4.4 (sync calls complete/fail as before) |
| D4 | Probe page (`redirect:'follow'`, `response.url`) | backend unchanged over Bun `fetch` | done | `execução`: PS §4.1 step 3 `catalog.probe` |
| D5 | Probe icon (content-type/length, 512 KiB cap) | same | done | `execução`: PS §2.4 (icon fetched and cached) |
| D6 | Body readers (`getReader`, caps) | same | done | `execução`: PS §4.1 step 3 |
| D7 | Embed probe (`tool-windows.ts:366…`) | — | not applicable | `leitura only` — the probe left with the iframe-embedded kind (§22, 2026-10-22); no `embed` code remains in `backend/` |

## E. Backend — runtime hooks & `TinyApiMeta` (14)

| # | tinyjs item | Electrobun implementation | Status | Evidence |
|---|---|---|---|---|
| E1 | `init(app)` | `electrobun/bun/index.ts` | done | `execução`: SC §1 |
| E2 | `api` map | `facade/gate.ts` `createViewGate` + `index.ts` `'api.call'` → `gate.call` | done | `execução`: PS §4.2 (25 steps call the api) |
| E3 | `onOpenUrl(url, app)` | `index.ts` hook + `facade/app.ts` `onOpenUrl`; `nod://` recorded at build | done | `execução`: SC §4 (`nod://open`, `nod://join`) |
| E4 | `onNavigate(info)` | `facade/windows.ts` `reportNavigation`/`handlePolicy`/`handleCommit` (`policy/start/commit/finish`) | done with gap | `execução`: SC §4 (link opens a window), PS §4.3; gap: `fail`/`crash` cannot be reported (no devkit event) |
| E5 | `onWindowOpen(info)` | `facade/windows.ts` new-window listener → `onWindowOpen`, then popup/deny/external | done | `execução`: PS §2.3/§4.3 (popup adopted as a tab; placement blocked by the WM), SC §4 |
| E6 | `onDownload(info)` | `facade/windows.ts` native download events + `facade/downloads.ts` host route → `onDownload` | done with gap | `execução`: SC §10 (`done`/`failed` audit rows, de-dup names); gaps in §Gaps |
| E7 | `onWindowClosed(id)` | `facade/windows.ts` close events (`onWindowClosed`) | done | `execução`: PS §4.3 (tab close/bookkeeping) |
| E8 | `onWindowState(info)` | `facade/windows.ts` focus/blur/move/resize/minimize → `onWindowState` | done | `execução`: SC §3 (hotkeys released while unfocused) |
| E9 | `onHotkey(id)` | `index.ts` `onHotkey` → `backend.onHotkey` | done | `execução`: SC §3 |
| E10 | `onTray(id, app)` | `facade/app.ts` tray click → `onTray` | done | `execução`: SC §2 |
| E11 | `TinyApiMeta.window` | `facade/gate-core.ts` `decide` stamps `meta.window` from the runtime's view registry | done | `execução`: PS §4.2/§4.4 (guards hold: main-only methods work) |
| E12 | `TinyApiMeta.origin` | `gate-core.decide` + `gate.ts` `commit` (origin observed by `did-commit-navigation`) | done | `execução`: PS §4.1 step 10 (`login.report` accepted with the tool origin); denial pinned by `test/electrobun-gate.test.ts` (`leitura`) |
| E13 | `TinyApiHandler(params, app, meta)` | `gate.ts` `dispatchCall(method, params, meta)` | done | `execução`: PS §4.4 |
| E14 | Hook set completeness (no `onMenu`/`onSystem`/…) | — | not applicable | `leitura only` — neither target exports/uses them |

## F. Page — `tiny.*` in `src/` and `index.html` (19)

Main window: `electrobun/view/bridge.ts` `installMainBridge()` (document-start preload). Tool/popup/
link views: `electrobun/view/tool-bridge.ts` `toolBridgeSource(id)`.

| # | tinyjs item | Electrobun implementation | Status | Evidence |
|---|---|---|---|---|
| F1 | `tiny.api.call` | `bridge.ts` → RPC `'api.call'` → gate | done | `execução`: PS §4.2 (every step is an api call) |
| F2 | `tiny.api.on` | `bridge.ts` `'api.event'` subscription | done | `execução`: PS §4.2 (pushes drive the UI) |
| F3 | `dialog.openFile` (seed import) | `bridge.ts` → `'dialog.openFile'` → `native.openFile` | done | `execução`: PS §4.2 stage `seed-import` (#38); SC §8 |
| F4 | `dialog.saveFile` (vault export) | `'dialog.saveFile'` → `native.saveFile` | done | `execução`: SC §8 (Save panel) |
| F5 | `dialog.openFile` (vault import) | same as F3 | done | `execução`: SC §8 (Open panel) |
| F6 | `dialog.saveFile` (activity export) | same as F4 | done | `execução`: PS §4.2 (`events.exportToFile` through the page) |
| F7 | `dialog.saveFile` (seed export) | same as F4 | done | `execução`: PS §4.2 (settings-driven export) |
| F8 | `dialog.openFile` (seed import, settings) | same as F3 | done | `execução`: PS §4.2 |
| F9 | `on('session')` | `bridge.ts` `api.on` | done | `execução`: PS §4.2 |
| F10 | `on('tools')` | same | done | `execução`: PS §4.2/§4.3 |
| F11 | `on('tab')` | same | done | `execução`: PS §4.3 |
| F12 | `on('openLink')` | same | done | `execução`: SC §4 (deep link opened the dialog) |
| F13 | `on('catalog')` | same | done | `execução`: PS §4.2 |
| F14 | `on('palette')` | same | done | `execução`: SC §3 (⌘K opened the palette) |
| F15 | `on('update')` | same | done | `execução`: SC §9 (notice) |
| F16 | `on('host')` | same | done | `execução`: PS §4.4 |
| F17 | `on('join')` | same | done | `execução`: SC §4 (invite prefilled) |
| F18 | `on('catalog')` (settings) | same | done | `execução`: PS §4.2 |
| F19 | `on('host')` (settings) | same | done | `execução`: PS §4.4 |

## G. Config — `tinyjs.base.json` keys (17)

Source: `scripts/gen-electrobun-config.ts` (`generateElectrobunConfig`) + `electrobun/bun/index.ts`.

| # | tinyjs key | Electrobun use | Status | Evidence |
|---|---|---|---|---|
| G1 | `name` | `app.name` = `base.title ?? base.name ?? 'Nod'` (`generateElectrobunConfig`) | done | `execução`: SC (bundle/menu name `Nod`) |
| G2 | `title` | main window title is the literal `'Nod'` in `facade/windows.ts` `openMain` (the key itself feeds `app.name`, G1) | done | `execução`: SC §1 (window titled `Nod`) |
| G3 | `size` | `index.ts` `mainFrame()` parses `WxH`, converted to the page box | done | `leitura only` (the page/frame compensation is measured in the `windows.ts` header) |
| G4 | `id` | `app.identifier`, default `copland.nod.eb`; `copland.nod` refused | done with gap | `execução`: SC/PS (own data dir); gap: **different** data/keychain namespace by design |
| G5 | `version` | `app.version` + `info().version` + update compare | done | `execução`: SC §9 (`Nod 0.6.0d` after the swap) |
| G6 | `minTinyjsVersion` | — | not applicable | `leitura only` |
| G7 | `backend` | `build.bun.entrypoint = electrobun/bun/index.ts` (which imports `backend/main.ts`) | done | `execução`: SC §1 |
| G8 | `frontend.build` | `eb:build` runs `bun run build` before `electrobun build` | done | `execução`: SC (built bundle serves the page) |
| G9 | `frontend.dist` | `copy.dist = views/mainview` | done | `execução`: SC §1 (`views://mainview/index.html`) |
| G10 | `frontend.dev` | `eb:dev` starts `bun run dev` (vite) itself | done | `execução`: PS (dev runs over the vite URL) |
| G11 | `frontend.devUrl` | `index.ts` `devMainPage()` (`NOD_DEV_PORT`, or loopback `NOD_MAIN_URL`) | done | `execução`: PS §1 |
| G12 | `urlScheme` | `app.urlSchemes: ["nod"]` | done | `execução`: SC §4 |
| G13 | `popups` | `index.ts` `popupMode` → `facade/windows.ts` default popup mode | done | `execução`: PS §4.3 (popup adopted), SC §4 |
| G14 | `downloads` | not a config key: `facade/downloads.ts` route + the engine's native path | done with gap | `execução`: SC §10; gaps in §Gaps |
| G15 | `contextMenu` | engine (WKWebView) default; no facade member | done | `execução`: SC §13 — a right-click in a docked tool view and in the main page both open the WKWebView default menu (`WKMenuItemIdentifierReload`, `WKMenuItemIdentifierInspectElement`), the same menu tinyjs `contextMenu: true` leaves in place |
| G16 | `permissions.camera` | generator refuses a build without the string; `scripts/eb-postwrap.ts` writes it into the wrapped plist; `scripts/eb-postbuild.ts` (`scripts.postPackage` + `eb:verify`) repairs/asserts the packed payload | done | `execução`: SC §13 — with the string in the plist the packaged tool page has `navigator.mediaDevices` and the camera reaches the macOS TCC prompt; without it `mediaDevices` is `undefined` and no request is possible. SC §13 “Fixed” measured that hutch packs the payload tar before `postWrap`, so the assertion covers the tar the app runs |
| G17 | `permissions.microphone` | same | done | `execução`: SC §13 — same measurement, microphone prompt first (`getUserMedia({video,audio})`), string round-tripped by postwrap and asserted in the packed bundle |

## H. `gen-config` output & `resources/` handling (17)

Source: `scripts/gen-electrobun-config.ts` unless noted.

| # | tinyjs item | Electrobun behavior | Status | Evidence |
|---|---|---|---|---|
| H1 | `id` from `NOD_APP_ID` | `appIdentifier()`; refuses `copland.nod` | done | `execução`: PS §1 (per-smoke ids) |
| H2 | `api.origins['file://*']='all'` | `facade/gate-core.ts` `isAppOrigin` vs the app origin (`views://mainview` or the dev URL); no file: origin is ever trusted | done | `execução`: SC (packaged api calls work), PS §4.2 |
| H3 | dev origin `'all'` | `index.ts` `devMainPage()` only in `channel === 'dev'`, loopback enforced | done | `execução`: PS §4.2 |
| H4 | tool origins → `TOOL_METHODS` | `gate-core.ts` `TOOL_METHOD = 'login.report'` only; camera/mic are engine-level | done with gap | `execução`: PS §4.1 step 10 (`login.report`); SC §13 for media: the seed's tool origin reaches the TCC prompt with no site prompt (parity with tinyjs), but so does a personal tool's origin — on macOS 27 WebKit never calls the devkit's per-origin media `WKUIDelegate` (`action: Prompt`, then TCC), so the engine provides no origin-level prompt to keep |
| H5 | wildcard origin refused | exact-match gate, no wildcard branch | done | `leitura only` + `test/electrobun-gate.test.ts` |
| H6 | `frontend.devUrl` rewritten in dev | `index.ts` `devMainPage()`; window and gate take the same origin | done | `execução`: PS §1 |
| H7 | `update: {url, auto:'daily'}` from seed | `index.ts` `updateUrlFromSeed()` → `createUpdate`; generated `release.baseUrl` | done | `execução`: SC §9 (local channel from the seed) |
| H8 | `resources` list | `electrobunResources()` copied under `Resources/app/resources` | done | `execução`: SC §9 (seed and tray staged) |
| H9 | icon (env/private/default) | `iconForConfig()` (imported from `gen-config.ts`) resolves `NOD_ICON` → `resources/icon.png` → `assets/icon.png`; `win.icon`/`linux.icon` name that PNG, `build.mac.icons` the iconset `eb-icon.ts` writes from it | done | `execução`: PS §6.5 (default `assets/icon.png`; bundle `AppIcon.icns` 1024x1024, extracted 512@2x pixel-identical, 0/1,048,576 differing) + `test/gen-electrobun-config.test.ts` |
| H10 | build refuses missing usage strings | `mediaPermissions()` throws in `mode === 'build'` | done | `leitura only` |
| H11 | seed validation (exit 1) | `validateSeed()` from `shared/catalog` | done | `leitura only` + `test/gen-electrobun-config.test.ts` |
| H12 | `build-mode` stamp | `electrobunResources()` stages it in dev only | done | `leitura only` |
| H13 | `BUNDLED = ['tray.png']` | same constant | done | `execução`: SC §2 (tray icon present) |
| H14 | seed bundled only when present | `seed === null ? BUNDLED : ['seed.json', …]` | done | `leitura only` |
| H15 | entry icons by relative path | `relativeIconPath()` rejects data URIs/`..`; staged from `resources/` | done | `leitura only` |
| H16 | `NOD_DEV_PORT` validation | `index.ts` `devPort()` (same 1024–65535 rule) | done | `execução`: PS §1 |
| H17 | `NOD_ICON` + ≥1024 PNG check | same `iconSource()`/`iconConfigPath()`/`assertIconPng()` as tinyjs; a `NOD_ICON` file is staged as `.nod-icon.png` and named by the config | done | `execução`: PS §6.5 (the default branch: `assets/icon.png` 1024x1024 reached the bundle icon); `NOD_ICON` staging still `leitura` + `test/gen-config.test.ts` / `test/gen-electrobun-config.test.ts` |

## I. Build / release (26)

| # | tinyjs item | Electrobun behavior | Status | Evidence |
|---|---|---|---|---|
| I1 | `dev` script | unchanged (`vite --host 127.0.0.1 --strictPort`) | done | `execução`: PS (dev server started by the runners/`eb:dev`) |
| I2 | `build` script | unchanged (`tsc && vite build --base=./`), run by `eb:build` | done | `execução`: SC (build produced the bundle) |
| I3 | `app:dev` | `eb:dev` (native lib, generated config, vite, `electrobun dev`) | done | `leitura only` (the records launch `electrobun dev` directly) |
| I4 | `app:build` | `eb:build` (native lib, generated config, vite, `electrobun build --env=stable`) | done | `execução`: SC (21 MB `.app`) |
| I5 | `test` | unchanged (`bun test test/`) | done | `leitura only` |
| I6 | `typecheck` | root/backend/host + `electrobun/tsconfig.json` when `.hutch/devkit` exists | done | `leitura only` |
| I7 | `TINYJS_VERSION` pin | — | not applicable | `leitura only` (Electrobun 2.0.4 pinned in `package.json`, Bun 1.4.3 in the workflow) |
| I8 | `BUN_VERSION: 1.4.3` | same env in `.github/workflows/electrobun.yml` | done | `leitura only` |
| I9 | install tinyjs (unix) | — | not applicable | `leitura only` |
| I10 | install tinyjs (win) | — | not applicable | `leitura only` |
| I11 | `gen-config build` | `gen-electrobun-config.ts build` inside `eb:build` | done | `execução`: SC (generated config used by the build) |
| I12 | icon mismatch refusal | `electrobun.yml` "check the app icon" step: a private `resources/icon.png` must be the PNG the generated config names, else the build fails | done | `leitura only` (workflow never run) |
| I13 | release notes from `Release <v>:` commit | `electrobun.yml` "release notes" step (same grep, same merge-header strip) | done | `leitura only` (workflow never run) |
| I14 | `tinyjs version` self-report | `BuildConfig`/`info().runtime` instead | not applicable | `leitura only` |
| I15 | `tinyjs publish --arch arm64` | `scripts/eb-publish.ts build --arch arm64` (`.tar.zst` + manifest half) | done | `execução`: SC §9 (`nod-0.6.0d-eb-macos-arm64.tar.zst`) |
| I16 | `publish --arch x86_64` | same script, `macos-15-intel` matrix entry | done | `leitura only` (not built) |
| I17 | `publish` (Linux) | — | missing | `leitura only` |
| I18 | `publish` (Windows) | — | missing | `leitura only` |
| I19 | manifest version check | `parseManifest`/`normalizeVersion`; workflow prepare checks tag vs `tinyjs.base.json` | done | `execução`: SC §9 (manifest accepted/refused) |
| I20 | manifest merge | `eb-publish.ts mergeHalves` (version/notes/arch must agree) | done | `leitura only` + `test/eb-publish.test.ts` |
| I21 | update URL check (`/releases/latest/download/`) | workflow hardcodes that base URL instead of warning | done with gap | `leitura only` |
| I22 | `gh release` create/upload | `electrobun.yml` **attaches** to an existing release (`gh release upload --clobber`) | done with gap | `leitura only`; release creation remains `release.yml`'s |
| I23 | version/branch gate | `release-branch.yml` unchanged and dispatches `release.yml` only; the Electrobun workflow is `workflow_dispatch` with its own tag/version check | done with gap | `leitura only` |
| I24 | artifact mechanics | `eb:build` output + `docs/distribuicao.md` §10 | done | `execução`: SC §11 (21 MB artifact, 68 MB installed) |
| I25 | update mechanics (`publish` + sha256) | `eb-manifest.json` (version, notes, per-arch url+sha256) + swap helper | done with gap | `execução`: SC §9, SC §12; gap: no signature (Gaps 9) |
| I26 | icon mechanics (sips/`dist/icon.png`) | `scripts/eb-icon.ts` (wired into `eb:dev`/`eb:build` like `build-nod-native.ts`) runs `sips` into `.eb-icon.iconset`; hutch runs `iconutil`. No `dist/icon.png` on this target | done | `execução`: PS §6.5 (`eb:build` → `.eb-icon.iconset` from `assets/icon.png` → `AppIcon.icns` 1024², pixel-identical) |

## J. Tests / smokes touching the runtime (18)

| # | tinyjs item | Electrobun behavior | Status | Evidence |
|---|---|---|---|---|
| J1 | Fake `TinyApp` | unchanged (`test/tool-windows.test.ts`) | done | `leitura only` |
| J2 | Fake `window.tiny` | unchanged (`test/login-adapter.test.ts`) | done | `leitura only` |
| J3 | `tjs:sqlite` stub (entry) | unchanged | done | `leitura only` |
| J4 | `tjs:sqlite` stub (gate) | unchanged | done | `leitura only` |
| J5 | `tjs:sqlite` stub (join) | unchanged | done | `leitura only` |
| J6 | `tjs:sqlite` stub (personal) | unchanged | done | `leitura only` |
| J7 | `tjs:sqlite` stub (vault-events) | unchanged | done | `leitura only` |
| J8 | config generator tests | `test/gen-config.test.ts` unchanged + `test/gen-electrobun-config.test.ts` | done | `leitura only` |
| J9 | launch `tinyjs dev` | — | not applicable | `leitura only` — replaced by `launchSmokeApp` (`--runtime=electrobun`) |
| J10 | run txiki.js directly for vectors | bundle's Bun (`build/dev-macos-<arch>/Nod-dev.app/Contents/MacOS/bun`) | not applicable | `execução`: PS §2.1 (KDF 3/3, seal 2/2 + 6 refused) |
| J11 | `connected.ts` | `--runtime=electrobun` | done | `execução`: PS §4.4 (114/114) |
| J12 | `ui.ts` | `--runtime=electrobun` | done | `execução`: PS §4.2 (25/25) |
| J13 | `tabs.ts` | `--runtime=electrobun` | done | `execução`: PS §6.4 (16/16 ok, 0 blocked, 18115 ms; tinyjs 12 ok + 4 blocked) |
| J14 | `smoke.html` | unchanged page | done | `execução`: PS §4.1 (14/14) |
| J15 | `connected.html` | unchanged page | done | `execução`: PS §4.4 |
| J16 | `tabs-driver.ts` | unchanged; `tiny.win.*`/`tiny.clipboard.*` come from `bridge.ts` | done | `execução`: PS §6.4 (`RF-66 Open link…` 314 ms; the tool pages report `link_1`/`link_2`; `tiny.win.id` baked by `toolBridgeSource`) |
| J17 | `ui-driver.ts` | unchanged, except the `#37` timeout's diagnostics (sidebar node/title count, `tools.state`, `catalog.list`, banner) | done | `execução`: PS §4.2, §6.2 (the diagnostics isolated the stale-read race; no assertion changed) |
| J18 | `tools.ts` injected page | `tool-bridge.ts` `REFUSED_MEMBERS` answers the byte-identical gate sentence; `login.report` goes to the gate | done | `leitura only` (the RF-68/`getState` step did not run) |

## K. Added or changed on the Electrobun target

| # | Item | Electrobun implementation | Status | Evidence |
|---|---|---|---|---|
| K1 | Native docked view inside the main window | `facade/windows.ts` `createEmbedded` (`BrowserView` + `autoResize:false` + `placeEmbedded`), core `resizeWebview`/`webviewSetHidden` via `facade/native.ts` | done | `execução`: PS §6.4 (docked tab: page box 1167x1190 = slot 3604,-1328 1167x1190, **CGWindowList 0 tool windows**; resize 323/367 ms; RF-66 popup took the slot in 323 ms). Gap: internal core symbols still (gap 20) |
| K2 | Detach / dock without reload | `setChrome` → `detachTab` / `dockTab` → AppKit re-parent (`facade/native.ts` core view ops), rect re-applied | done with gap | `execução`: PS §4.3 (RF-51 detach/dock, on the target); VS §2 (`timeOrigin` identical, RPC survives — spike dylib). Gap: the same path is not proven in the product |
| K3 | Top-frame-only gate commits | `facade/windows.ts` `topFrameUrl`/`acceptTopFrame`/`notePolicyCorrection` (commit must match the live WKWebView top URL) | done | `leitura only`; VS §1 measured that subframe events fire without a frame identity |
| K4 | Host-routed downloads | `view/tool-bridge.ts` capture-phase click + `facade/gate.ts` `admitDownload` + `facade/downloads.ts` | done with gap | `execução`: SC §10 (`report.txt`, de-dup, 404 audited, `blob:` file) |
| K5 | sha256-verified update | `facade/update.ts` `downloadVerified`, `stagedBundleMatches`, swap helper with `updates/rollback` (one bundle kept) | done | `execução`: SC §9 (tampered sha refused; correct sha installed; rollback) + SC §12 (5× rollback from a just-swapped bundle, archive unpacked without an external `zstd`) |
| K6 | Page clipboard shim | `view/bridge.ts` `clipboard.read/write` → `index.ts` `Utils.clipboard*` | done | `leitura only` |
| K7 | Backend `app.clipboard` | `facade/app.ts` `createClipboard` (text/image, watch/unwatch, observed `changeCount`) | done | `execução`: PS §4.2 #33 ("Copied"), §4.4 8.5b |
| K8 | Native helper dylib | `NodNative.swift` + `scripts/build-nod-native.ts` + `facade/native.ts` (`bun:ffi`, in-process; the core view primitives are a second binding in the same file) | done with gap | `execução`: NAT (every helper op except the view re-parent); gaps: sheet attributed to `bun`, macOS only, ACL prompt after rebuild |
| K9 | Deep links `nod:` | generated `urlSchemes` + `onOpenUrl` | done with gap | `execução`: SC §4; gap: two bundles sharing one identifier can launch a second instance (LaunchServices) |
| K10 | Separate app identity / data namespace | `NOD_APP_ID`, default `copland.nod.eb`; `copland.nod` refused | done with gap | `execução`: SC/PS; gap: an Electrobun install does not see the tinyjs data/keychain |
| K11 | Observed-origin gate replacing `api.origins` | `facade/gate-core.ts` `decide` + `facade/gate.ts` `createViewGate` (`viewId → committedOrigin`), `sandbox: true` on every non-main view | done | `execução`: PS §4.2/§4.4; VS §1 (sandboxed view has no RPC) |

## Gaps

Open items, each with what closing it needs. Nothing below is called verified.

1. **Download by plain navigation to `Content-Disposition: attachment`** — still reaches the
   wrapper's native `WKDownload` and is lost (`SC` §10, gap 1; destination is decided inside
   `libNativeWrapper.dylib`, no devkit hook).
2. **Cross-origin `<a download>`** — left to the engine (the HTML rule drops the attribute), i.e.
   gap 1 applies if the server sends an attachment (`SC` §10, gap 2).
3. **Clicks inside a child frame** are not intercepted: the download listener is the top document's
   preload (`SC` §10, gap 3).
4. **`blob:`/`data:` downloads above 8 MiB** are refused with an audited failure — one-way host
   channel carries base64 in one JSON message (`SC` §10, gap 4).
5. **Main-window downloads stay native** and are subject to macOS Files-and-Folders (TCC); only
   tool/popup/link/embed views route through the host (`SC` §10, gap 5).
6. **`onNavigate` cannot report `fail` or `crash`** — the devkit has no did-fail-navigation/crash
   event (`facade/windows.ts` header; `E4`).
7. ~~**Update rollback no-op, observed once**~~ — **closed by the final round** (`SC` §12): the cause
   was `tar --zstd` running an external `zstd` on a `PATH` that the swap helper had stripped (and
   `open` passes on to the app it relaunches), so the extraction failed after the fetch and only a
   stranded `console.error` recorded it. Extraction is now in-process (Bun zstd → `/usr/bin/tar`
   without a filter), the helper's environment is an allowlist that keeps the launch environment, and
   every refusal is written to `updates/install.log` and audited as an `update` event. Reproduced and
   re-checked 5× (`SC` §12).
8. ~~**The update page shows `Update installed` after a refused install**~~ — **closed by the final
   round** (`PS` §6.5): in the packaged build, a manifest with a zero sha256 was refused
   (`GET eb-manifest.json` ×2 + `GET fake.tar.zst`) and the shell banner read exactly "The update
   could not be installed".
9. **No update signature** — `eb-manifest.json` carries only the sha256 and the transport is HTTPS;
   Electrobun ships no Ed25519 equivalent (`facade/update.ts` header; `I25`).
10. **App icon (guild path) blocked** — offline guild has no icon, so `nod.setAppIcon` was not
    reachable; `app.icon` itself is measured (`SC` §7; `A6`).
11. ~~**App icon key / `NOD_ICON` pipeline missing**~~ — **closed by the final round**: the packaged
    build's `AppIcon.icns` is 1024x1024 and its extracted 512@2x rep is pixel-identical to
    `assets/icon.png` (0/1,048,576 differing), from `.eb-icon.iconset` (`PS` §6.5, `H9`, `I26`);
    the `NOD_ICON` staging branch itself remains leitura + unit tests (`H17`).
12. **`onWindowOpen` placement under a tiling WM** — adoption works and the placement step is
    `blocked` with numbers when the tiler owns a tool/carrier window; the final round had 0 blocked
    on Electrobun (docked view) and 4 on tinyjs (`PS` §6.4). The rule is kept; not a failure.
13. ~~**The product's docked-view / detach path (K1, K2) is unproven by any execução**~~ — **closed**
    by `PS` §6.4: a docked tab is a view (0 tool windows, page box = slot), detach opens one 32 pt
    carrier, dock back removes it — all with the same `timeOrigin` and draft.
14. ~~**`tabs.ts` final round pending**~~ — **closed**: Electrobun 16/16, 0 blocked (`PS` §6.4).
15. ~~**Tool-page `win.id` fix unverified on the surface**~~ — **closed**: `RF-66 Open link…`
    passed with the page reporting `link_1`/`link_2` (`PS` §6.4, `J16`).
16. **Windows and Linux never run** — every E06 record is macOS arm64; the facade answers
    `available: false` for the native helper off macOS, and nothing else was measured (`G`, `I17`,
    `I18`, `K8`).
17. **x86_64 artifact never built** — the workflow matrix has `macos-15-intel`, not run (`I16`).
18. **`electrobun.yml` never run in CI** — build/attach is `leitura` only; the local channel was
    exercised by hand (`I13`, `I20`, `I22`, `I23`).
19. ~~**Camera/microphone capture unmeasured**~~ — **closed**: SC §13 triggered a packaged tool page's `getUserMedia({video,audio})`. The TCC prompt appears (microphone, then camera) and denial yields `NotAllowedError`; with the usage strings stripped, `navigator.mediaDevices` is `undefined` (WebKit gates the API, measured), so the strings are load-bearing. Remaining, packaging-shaped caveat: under ad-hoc signing the prompt names `launcher` and shows no usage-description line, although both strings are in `Contents/Info.plist` — same family as gaps 21–22, not a facade change (`G16`, `G17`, `H4`).
20. **Docked-tab geometry uses internal core symbols** (`resizeWebview`, `webviewSetHidden`,
    `listViews`) — not public SDK API; an Electrobun update can move them (`K1`, `VS` §1).
21. **Touch ID sheet attributed to “bun”** — packaging/signing work, not a helper change (`K8`,
    `NAT`).
22. **Keychain ACL prompt after every rebuild** — ad-hoc signing changes the binary identity
    (`NAT`).
23. **LaunchServices duplicate-identifier launch** — observed once with two bundles sharing one
    identifier (`SC` §4, `K9`).
24. **Separate data/keychain namespace** (`copland.nod.eb`) — an Electrobun install does not inherit
    the tinyjs installation (`G4`, `K10`).
25. ~~**Context menu unmeasured**~~ — **closed**: SC §13 measured the webview's own right-click menu in a docked tool view and in the main page; both are the WKWebView default, which is what `contextMenu: true` means on tinyjs (`G15`).
26. **Distribution story incomplete** — no Linux/Windows artifacts, no signing/notarization, release
    attachment only (`I17`, `I18`, `I22`).
27. **Close → hide on a machine configured to quit apps with no windows** — the earlier reading
    ("macOS automatic termination") was wrong. `Vorssaint` (the machine's menu-bar utility,
    `autoQuitEnabled=1`, no exceptions) posts a **Quit AppleEvent** when an app's last window goes
    away, and it hits **both** runtimes: tinyjs closed the same way (`PS` §6.6). The Electrobun
    target now survives it by hiding the **app** when `main` is the last window (`PS` §6.6 a/b:
    alive past 30 s, tray Open Nod shows it) — a deliberate difference from tinyjs, which still gets
    quit by the utility. A clean fix is a Vorssaint exception, i.e. machine configuration, not this
    target (`A14`).

## Counts

| Section | Rows | done | done with gap | not applicable | missing |
|---|---:|---:|---:|---:|---:|
| A. `TinyApp` | 26 | 24 | 2 | 0 | 0 |
| B. Window handle | 8 | 8 | 0 | 0 | 0 |
| C. `tjs` / sqlite | 13 | 12 | 0 | 1 | 0 |
| D. `fetch` | 7 | 6 | 0 | 1 | 0 |
| E. Hooks / meta | 14 | 11 | 2 | 1 | 0 |
| F. Page `tiny.*` | 19 | 19 | 0 | 0 | 0 |
| G. Config keys | 17 | 14 | 2 | 1 | 0 |
| H. Generator / resources | 17 | 14 | 1 | 0 | 2 |
| I. Build / release | 26 | 15 | 3 | 4 | 4 |
| J. Tests / smokes | 18 | 16 | 0 | 2 | 0 |
| **A–J subtotal** | **165** | **139** | **10** | **10** | **6** |
| K. Added / changed | 11 | 6 | 5 | 0 | 0 |
| **Total** | **176** | **145** | **15** | **10** | **6** |
