# Nod × tinyjs runtime — complete surface inventory
> leitura of the working tree on 2026-10-22, commit `f000a5c`. Read-only inventory; no file was modified.

## Summary

- **The Nod uses a very narrow slice of tinyjs.** The page touches exactly two globals: `tiny.api` (`call`/`on`) and `tiny.dialog` (`openFile`/`saveFile`). Everything else is backend-side.
- **Backend surface** = `init` + `api` + 8 event hooks (`onOpenUrl`, `onNavigate`, `onWindowOpen`, `onDownload`, `onWindowClosed`, `onWindowState`, `onHotkey`, `onTray`), a `TinyApp` used for `paths/system/info/icon/store/secrets/authenticate/update/tray/hotkey/screens/win/push/quit/window`, a window handle using 8 methods (`eval/close/show/hide/setPosition/setSize/setChrome/setMinSize`), the `tjs` globals (`readFile/writeFile/makeDir/rename/stat/remove`) plus `tjs:sqlite`, and global `fetch` with `redirect` control.
- **No `app.menu`, no `app.notify`, no clipboard/shell/badge/progress/power/permissions/audio/macos.*` on the backend.** The app menu, context menu, popups, downloads and permissions are pure `tinyjs.json` policy, not code.
- **Config is generated, not hand-written**: `tinyjs.base.json` (tracked) → `scripts/gen-config.ts` → gitignored `tinyjs.json`; the origin gate is the security boundary (all app pages `"all"`, tool origins only `login.report`/`media.*`).
- **Build/release is tinyjs-CLI-shaped**: `tinyjs dev|build|publish|version`, `.build/` staging, `dist/publish/manifest.json`, auto-update from GitHub Releases.
- **Smokes launch the real app** (`tinyjs dev` with `TINYJS_HTML`, own app id/port) and one runner also executes the txiki.js binary directly (`bin/tjs run`) to pin crypto vectors.
- **Facade implication:** an Electrobun facade needs ~60 concrete members (tables A–E), not the 300+ declared in `tiny.d.ts`. The two `tiny.d.ts` files (`backend/tiny.d.ts`, `src/tiny.d.ts`, both 68.7 KB) are ambient typing copies, not runtime dependencies.

---

## A. Backend — `TinyApp` surface (26)

| # | Member | file:line | Use | Criticality |
|---|---|---|---|---|
| 1 | `init(app: TinyApp)` | `backend/main.ts:203` | Runtime entry point; stores `runtime = app` | **data** (boot) |
| 2 | `app.paths()` → `.data`, `.resources` | `backend/main.ts:205` | Data dir (SQLite, icons, guild icon), resources dir (seed, tray, stamp) | **data** |
| 3 | `app.system.capabilities()` | `backend/main.ts:226` | Absent key = supported; keys read: `tray`, `icon`, `authenticate`, `hotkey` (`:230,:273,:438,:446`) | **UX / sec** (gate choice) |
| 4 | `app.system.os()` | `backend/main.ts:227` | Drives combos, tray icon, dockability | UX |
| 5 | `app.info()` → `.version` | `backend/main.ts:238` | O2 host `minAppVersion` gate | **sec** |
| 6 | `app.icon(path)` | `backend/main.ts:271` | Guild icon / bundle icon (`''` resets) | UX |
| 7 | `app.store.get(key)` | `backend/main.ts:281` | Preferences: `open_tools`, `appIcon`, biometric/session flags, update dismissal. (`window_mode`/`embedded_tools`/`embed_blocked` were removed on 2026-10-22 — the mode is derived from `canPosition`) | data (prefs) |
| 8 | `app.store.set(key, value)` | `backend/main.ts:281` | Same prefs; never secrets | data |
| 9 | `app.store.get('dismissed_update')` | `backend/main.ts:1353` | Update notice dismissal | UX |
| 10 | `app.secrets.get/set/delete` | `backend/main.ts:286` | Only `nod.bio.<person>` reaches the OS keychain (`backend/secret-store.ts:44-59`) | **sec / data** |
| 11 | `app.authenticate(reason)` | `backend/main.ts:292` | Touch ID / password sheet for reveal, copy, send, accept, assign | **sec gate** |
| 12 | `app.window(id)` | `backend/tool-windows.ts:438` | Handle factory for tool windows (guarded) | UX |
| 13 | `app.window('main').setMinSize(760, 500)` | `backend/main.ts:445` | Minimum main window | UX |
| 14 | `app.win.setHideOnClose(true)` | `backend/main.ts:449` | Tray mode: close hides, app lives (RF-15) | UX |
| 15 | `app.win.open(id, opts)` | `backend/tool-windows.ts:446`; opts built `:1030-1042` (`page,title,x,y,size,chrome:{frame:false}`) | Opens each tool/tab window | **UX core** |
| 16 | `app.win.getState()` | `backend/tool-windows.ts:637,696`; fields used `minimized,visible,x,y,width,height,outer,canPosition` (`:629,646-648`) | Slot geometry, docked tabs, cascade | **UX core** |
| 17 | `app.screens()` | `backend/tool-windows.ts:694` | Cascade origin, which screen main is on | UX |
| 18 | `app.hotkey.register(id, combo)` | `backend/tool-windows.ts:1813` | Digits 1-9, ⌘K, ⌘T, ⌘W, ⌘⇧D, ⌃Tab/⌃⇧Tab, ⌘L, ⌘D (`:1849-1861`) | UX |
| 19 | `app.hotkey.unregister(id)` | `backend/tool-windows.ts:1823` | Released when unfocused / windows mode | UX |
| 20 | `app.tray.set(spec)` | `backend/main.ts:815` (`title,icon,tooltip,menu[{open,lock,separator,quit}]`) | Tray presence; icon by OS `sf:`/`emoji:`/png (`:829-834`) | UX |
| 21 | `app.push(event, data)` | `backend/main.ts:1318`; `backend/tool-windows.ts:504,518,1907,1917` | Events: `session, tools, tab, catalog, update, host, join, palette, openLink` | **UX core** |
| 22 | `app.update.check()` | `backend/main.ts:1372` | Daily channel check; `available/current/latest/notes` | UX / **sec** (signed manifest) |
| 23 | `app.update.install()` | `backend/main.ts:3869` | Person-initiated install+relaunch | **data** (restart) |
| 24 | `app.quit()` | `backend/main.ts:3905` (`nod.quit`) | Quit RPC | UX |
| 25 | `app.quit()` | `backend/main.ts:3996-3999` (`onTray` `'quit'`) | Tray quit | UX |
| 26 | `app.window('main').show()` | `backend/main.ts:3943,3948,4003,4006` | Deep link, locked join, tray open/lock | UX |

## B. Backend — `TinyWindowHandle` methods (8)

| # | Method | file:line | Use | Criticality |
|---|---|---|---|---|
| 1 | `eval(js)` | `backend/tool-windows.ts:494`; call sites `:1520` (foreign-tool banner), `:1593` (login adapter), `:2542` (`location.href = view`) | Only channel into a tool page; login fill is credential-bearing | **sec** |
| 2 | `close()` | `backend/tool-windows.ts:457` | Close tab/popup on lock, `tools.close` | UX |
| 3 | `show(opts?)` | `backend/tool-windows.ts:472` (`{activate:false}` for docked), `:2086` | Raise tab with/without focus | UX |
| 4 | `hide({app:false})` | `backend/tool-windows.ts:484` | Hide non-active docked tabs, page stays alive (RF-50) | UX |
| 5 | `setPosition(x,y)` | `backend/tool-windows.ts:734,1079,1793,2079` | Slot placement, detach, adopt | **UX core** |
| 6 | `setSize(w,h)` | `backend/tool-windows.ts:735,1080,1794,2080` | Same | **UX core** |
| 7 | `setChrome({frame})` | `backend/tool-windows.ts:1787` (adopt frameless), `:2072` (detach framed), `:2105` (dock frameless) | Dock/detach without reload (RF-51) | **UX core** |
| 8 | `setMinSize(w,h)` | `backend/main.ts:445` | Main window floor | UX |

## C. Backend — `tjs` globals & `tjs:sqlite` (13)

| # | Global | file:line | Use | Criticality |
|---|---|---|---|---|
| 1 | `tjs.makeDir(data,{recursive})` | `backend/main.ts:208` | Data dir (runtime does not create it) | **data** |
| 2 | `tjs.makeDir(icons)` | `backend/icons.ts:59` | Icon cache dir | data |
| 3 | `tjs.writeFile(icon)` | `backend/icons.ts:60` | Icon bytes | data |
| 4 | `tjs.writeFile` | `backend/main.ts:278` (guild icon), `:1954` (export to file) | User-chosen export, guild png | **data** |
| 5 | `tjs.readFile` | `backend/main.ts:277,783,799,1963,2161` | Guild icon, bundled seed, build stamp, import/export reads | **data / sec** (stamp) |
| 6 | `tjs.readFile(icon)` | `backend/icons.ts:68` | Icon → data URI | data |
| 7 | `tjs.readFile` (default) | `backend/seed.ts:55,123` | Seed application & icon staging | data |
| 8 | `tjs.rename` | `backend/main.ts:491` | Move legacy DB aside (incl. `-wal`/`-shm`) | **data** |
| 9 | `tjs.stat` | `backend/main.ts:499` | `ENOENT` existence check | data |
| 10 | `tjs.remove` (cast, not in `tjs.d.ts`) | `backend/main.ts:1855` | Remove old guild icon | data |
| 11 | `tjs:sqlite` `Database` | `backend/sqlite.ts:6` (`new Database(path)`, `exec`, `prepare`, `close`) | Entire local DB; `PRAGMA foreign_keys/WAL` `:25-26` | **data** |
| 12 | `Statement.run/.all` | `backend/sqlite.ts:29-37` | Sync API; `INSERT … RETURNING` via `.all()` | **data** |
| 13 | `tjs.env` | declared `backend/tjs.d.ts:7` | **Unused** — nothing reads env at runtime | — |

## D. Backend — `fetch` specifics (7)

| # | Site | file:line | Details | Criticality |
|---|---|---|---|---|
| 1 | Wiring | `backend/main.ts:349` `createHostClient({ fetch, … })` | Global runtime `fetch` injected | **sec** |
| 2 | Host calls | `backend/host-client.ts:390` | `{ method, headers:{accept, authorization?, content-type?}, redirect:'error' }` — refuses redirects so the bearer cannot leak (F9) | **sec** |
| 3 | Deadline | `backend/host-client.ts:395` | Timer race; no `AbortSignal` | data |
| 4 | Probe page | `backend/probe-net.ts:38` | `fetch(url,{redirect:'follow'})`, `response.url`, 2 MiB text cap | UX |
| 5 | Probe icon | `backend/probe-net.ts:104` | `redirect:'follow'`, `content-type`, `content-length`, 512 KiB cap | UX |
| 6 | Body readers | `backend/probe-net.ts:66-90,127-160` | `body.getReader()`, chunk cap, `reader.cancel()` | UX |
| 7 | Embed probe | `backend/tool-windows.ts:366,371-403` | `redirect:'follow'`, deadline race, capped text; scans tool HTML + ≤8 same-origin scripts for cookie writes | **sec** (embed refusal) |

## E. Backend — runtime hooks & `TinyApiMeta` (14)

| # | Export / field | file:line | Use | Criticality |
|---|---|---|---|---|
| 1 | `init(app)` | `:203` | See A1 | data |
| 2 | `api: Record<string,TinyApiHandler>` | `:3918` | Every `ApiContract` method | **sec** |
| 3 | `onOpenUrl(url, app)` | `:3933` | `nod://join`, `nod://open?url=`; shows main, pushes `join` | **sec / UX** |
| 4 | `onNavigate(info)` | `:3952` | `policy/start/finish/fail/crash`; denies plain http, non-http schemes; `mailto/tel` → external | **sec** |
| 5 | `onWindowOpen(info)` | `:3958` | `open`/`policy`; decides `window/external/deny`, adopts popups as tabs | **sec / UX** |
| 6 | `onDownload(info)` | `:3963` | On `done`/`failed` writes an audit event (`url, filename, error`) | data (audit) |
| 7 | `onWindowClosed(id)` | `:3978` | Tab manager bookkeeping | UX |
| 8 | `onWindowState(info)` | `:3983` | Whole event down; uses `win, focused, minimized` | **UX core** |
| 9 | `onHotkey(id)` | `:3990` | `palette, open-link, tab-new, tab-close, tab-detach, tab-next, tab-prev, tab-save, digit-N` | UX |
| 10 | `onTray(id, app)` | `:3996` | `open`/`lock`/`quit`/bare click | UX |
| 11 | `TinyApiMeta.window` | `:1040,1045,3912` | Window allow-list (`main` only, except `login.report`) | **sec gate** |
| 12 | `TinyApiMeta.origin` | `:1042,3912` | Tool-origin check for `login.report` (undefined on Win/Linux) | **sec gate** |
| 13 | `TinyApiHandler` signature `(params, app, meta)` | `:844`, `:1034` | Guard wraps every method | **sec** |
| 14 | Hook set completeness | `backend/tiny.d.ts:1523-1600` | No `onMenu`/`onSystem`/`onQuit`/`onClipboard` hook is exported or used | — |

## F. Page — `tiny.*` in `src/` and `index.html` (19)

| # | Use | file:line | Details | Criticality |
|---|---|---|---|---|
| 1 | `tiny.api.call(method, params)` | `src/api.ts:9` | Sole RPC path; typed by `ApiContract` | **UX core** |
| 2 | `tiny.api.on(event, fn)` | `src/api.ts:13` | Sole push path; returns `off` | **UX core** |
| 3 | `tiny.dialog.openFile({types:['json']})` | `src/entry.ts:557` | Seed import at setup | **data** |
| 4 | `tiny.dialog.saveFile({types:['nodvault'],name})` | `src/settings.ts:2912` | Vault export | **data (secret file)** |
| 5 | `tiny.dialog.openFile({types:['nodvault']})` | `src/settings.ts:2933` | Vault import | **data** |
| 6 | `tiny.dialog.saveFile({types:['jsonl'],name})` | `src/settings.ts:4193` | Activity export | data |
| 7 | `tiny.dialog.saveFile({types:['json'],name})` | `src/settings.ts:4246` | Seed export | data |
| 8 | `tiny.dialog.openFile({types:['json']})` | `src/settings.ts:4262` | Seed import (settings) | data |
| 9 | `on('session')` | `src/app.ts:1783` | Session state push | UX |
| 10 | `on('tools')` | `src/app.ts:1820` | Tabs/window state | **UX core** |
| 11 | `on('tab')` | `src/app.ts:1840` | Backend-driven tab activation | UX |
| 12 | `on('openLink')` | `src/app.ts:1858` | Open-link dialog | UX |
| 13 | `on('catalog')` | `src/app.ts:1862` | Reload catalog | UX |
| 14 | `on('palette')` | `src/app.ts:1866` | Open palette (hotkey) | UX |
| 15 | `on('update')` | `src/app.ts:1870` | Update notice | UX |
| 16 | `on('host')` | `src/app.ts:1875` | Host state | UX |
| 17 | `on('join')` | `src/app.ts:1892` | Deep-link invite | UX |
| 18 | `on('catalog')` | `src/settings.ts:4308` | Settings reload | UX |
| 19 | `on('host')` | `src/settings.ts:4326` | Join form invalidation | UX |

`index.html` and `vite.config.ts`: **zero** tinyjs references. No `window.__TINY_WIN` use in `src/`.

## G. Config — `tinyjs.base.json` keys (17)

| # | Key | line | Value | Parity relevance |
|---|---|---|---|---|
| 1 | `name` | 2 | `nod` | app identity |
| 2 | `title` | 3 | `Nod` | window/app name |
| 3 | `size` | 4 | `1100x720` | main page box |
| 4 | `id` | 5 | `copland.nod` | **data dir + keychain namespace** (never touch other ids) |
| 5 | `version` | 6 | `0.6.0c` | release/branch check, update compare |
| 6 | `minTinyjsVersion` | 7 | `0.57.2` | runtime floor |
| 7 | `backend` | 8 | `backend/main.ts` | backend entry |
| 8 | `frontend.build` | 10 | `bun run build` | packaged page build |
| 9 | `frontend.dist` | 11 | `dist` | served/embedded dir |
| 10 | `frontend.dev` | 12 | `bun run dev` | dev server |
| 11 | `frontend.devUrl` | 13 | `http://127.0.0.1:5173` | dev page origin (rewritten by gen-config) |
| 12 | `urlScheme` | 15 | `nod` | deep links (`onOpenUrl`) — **packaged `.app` only** |
| 13 | `popups` | 16 | `window` | real window per `window.open` (policy overridden by `onWindowOpen`) |
| 14 | `downloads` | 17 | `auto` | ~/Downloads, de-duped; audited by `onDownload` |
| 15 | `contextMenu` | 18 | `true` | WebKit default right-click menu |
| 16 | `permissions.camera` | 20 | usage string | macOS crash without it (build refuses) |
| 17 | `permissions.microphone` | 21 | usage string | same |

## H. `scripts/gen-config.ts` output & `resources/` handling (17)

| # | Emitted / handled | file:line | Effect | Criticality |
|---|---|---|---|---|
| 1 | `id` override from `NOD_APP_ID` | `:230`, `:311` | Smoke isolation | test/infra |
| 2 | `api.origins['file://*'] = 'all'` | `:29,:200` | Packaged app pages unrestricted | **sec gate** |
| 3 | dev origin `http://127.0.0.1:<port>` = `'all'` | `:201` | Only in `dev` | **sec** |
| 4 | tool origins → `TOOL_METHODS` = `login.report, media.camera, media.microphone` | `:124,:206` | Tool pages cannot call `win.getState`, `api.call` others | **sec gate** |
| 5 | wildcard origin refused | `:203-205` | Defense in depth | **sec** |
| 6 | `frontend.devUrl` rewritten in dev | `:214-224` | Page origin == gate origin | sec/test |
| 7 | `update: { url, auto: 'daily' }` from `seed.update` | `:228` | Auto-update channel | UX/sec |
| 8 | `resources` list (build only) | `:229`, `buildResources :145-162` | Files staged into the bundle | data |
| 9 | `icon` (env/private/default) | `:231`, `:240-260` | `.icns`/exe icon | build |
| 10 | build refuses missing media usage strings | `:196` | Prevents macOS crash | build |
| 11 | seed validation (exit 1 on invalid) | `:294-305` | Gate cannot be built from junk | **sec** |
| 12 | `resources/build-mode` stamp written in both modes | `:313-316` | Dev-run exception for the biometric gate (`shared/build-mode.ts:18`) | **sec** |
| 13 | `BUNDLED = ['tray.png']` | `:137` | Always staged | UX |
| 14 | `seed.json` bundled only when present (RF-61) | `:136` | Optional seed ⇒ empty release | data |
| 15 | entry icons staged by relative path (no `..`, no data URI) | `:144-162` | Tool icons as files | data |
| 16 | `NOD_DEV_PORT` validation (1024-65535) | `:266-279` | Per-launch smoke port | test |
| 17 | `NOD_ICON` staging to `.nod-icon.png` + ≥1024×1024 PNG check | `:238-260`, `assertIconPng :91` | Icon pipeline | build |

`resources/` inventory: `seed.example.json` (template), `tray.png` (staged), `build-mode` (`dev`, gitignored), `seed.json` (private, gitignored), `icon.png` (private, gitignored). `tinyjs.json` is generated and gitignored (`.gitignore:35`); `.build/` is `tinyjs dev` scratch (`:36`).

## I. Build / release (26)

| # | Item | file:line | Effect | Criticality |
|---|---|---|---|---|
| 1 | `dev` script | `package.json:6` | `vite --host 127.0.0.1 --strictPort` | dev |
| 2 | `build` script | `package.json:7` | `tsc && vite build --base=./` | build |
| 3 | `app:dev` | `package.json:8` | `gen-config dev && tinyjs dev` | dev |
| 4 | `app:build` | `package.json:9` | `gen-config build && tinyjs build` | build |
| 5 | `test` | `package.json:10` | `bun test test/` | test |
| 6 | `typecheck` | `package.json:11` | root + backend + host `tsc` | build |
| 7 | `TINYJS_VERSION: v0.57.2` | `.github/workflows/release.yml:18` | Pinned runtime | build/parity |
| 8 | `BUN_VERSION: 1.4.3` | `release.yml:19` | Bun pin | build |
| 9 | install tinyjs (unix) | `release.yml:94-98` | `curl tinyjs.app/install`, `TINYJS_NO_MODIFY_PATH` | build |
| 10 | install tinyjs (win) | `release.yml:100-105` | `install.ps1` | build |
| 11 | `gen-config build` | `release.yml:129-131` | Produces release `tinyjs.json` | **sec** (gate) |
| 12 | icon mismatch refusal | `release.yml:132-139` | Private icon must be the one used | build |
| 13 | release notes | `release.yml:146-160` | `Release <version>:` commit body → `--notes-file` | UX (update notice) |
| 14 | `tinyjs version` | `release.yml:163,170,177` | Runtime self-report | build |
| 15 | `tinyjs publish --arch arm64` | `release.yml:164` | macOS arm64 zip + manifest | build |
| 16 | `tinyjs publish --arch x86_64` | `release.yml:165` | macOS x64 | build |
| 17 | `tinyjs publish` (Linux) | `release.yml:171` | Portable tarball per arch | build |
| 18 | `tinyjs publish` (Windows) | `release.yml:178` | Portable folder | build |
| 19 | manifest version check | `release.yml:181-187` | `dist/publish/manifest.json` must match | build |
| 20 | manifest merge | `release.yml:216-235` | Recursive merge of mac/linux/win manifests | build |
| 21 | update URL check | `release.yml:237-245` | Warns unless `…/releases/latest/download/` | UX/sec |
| 22 | `gh release` create/upload | `release.yml:247-263` | Assets + notes from manifest | build |
| 23 | version/branch gate | `.github/workflows/release-branch.yml:35-53` | `tinyjs.base.json` version → `release-<v>` | build |
| 24 | artifact mechanics | `docs/distribuicao.md:38-60` | `tinyjs build` → `dist/`, macOS ad-hoc codesign, Windows/Linux portable | build |
| 25 | update mechanics | `docs/distribuicao.md:105-108,172-176` | `publish` zip + `manifest.json` (sha256, notes); `update.auto: daily`; checksum+signature before swap | UX/sec |
| 26 | icon mechanics | `docs/distribuicao.md:227-231` | sips `.icns` 16–1024, `dist/icon.png`, Windows embed; ≥1024 PNG | build |

## J. Tests / smokes touching the runtime (18)

| # | Test | file:line | Runtime coupling | Criticality |
|---|---|---|---|---|
| 1 | Fake `TinyApp` | `test/tool-windows.test.ts:211-261` (`:100-105` opened-window opts) | Implements `push, win.open, win.getState, window(id){show,hide,close,eval,setPosition,setSize,setChrome}, screens, hotkey.register/unregister` | test |
| 2 | Fake `window.tiny` | `test/login-adapter.test.ts:218-222` | Stubs `tiny.api.call` for `login.report` | test |
| 3 | `tjs:sqlite` stub | `test/entry.test.ts:30` | Dynamic import boundary | test |
| 4 | `tjs:sqlite` stub | `test/gate.test.ts:11,41,53` | Same | test |
| 5 | `tjs:sqlite` stub | `test/join.test.ts:52` | Same | test |
| 6 | `tjs:sqlite` stub | `test/personal.test.ts:549` | Same | test |
| 7 | `tjs:sqlite` stub | `test/vault-events.test.ts:18` | Same | test |
| 8 | Config generator tests | `test/gen-config.test.ts:141-266` | Real `tinyjs.base.json`, icon checks | test |
| 9 | Launch `tinyjs dev` | `test/smoke/run.ts:769-788` | `TINYJS_HTML`, `NOD_APP_ID`, `NOD_DEV_PORT`; prints pid/port | **smoke** |
| 10 | Run txiki.js directly | `test/smoke/run.ts:224-232,311` | `Bun.spawnSync([<tinyjs>/bin/tjs, 'run', bundle])` for KDF + seal vectors | **smoke (crypto parity)** |
| 11 | Connected smoke | `test/smoke/connected.ts:419-428` | Spawns `tinyjs dev` per phase; restores `tinyjs.json` | smoke |
| 12 | UI smoke | `test/smoke/ui.ts:509-511` | Spawns `tinyjs dev`; rewrites `frontend.devUrl` (`:350-360`) | smoke |
| 13 | Tabs smoke | `test/smoke/tabs.ts:587-608` | Spawns `tinyjs dev`; deletes `TINYJS_DEBUG`/`TINYJS_HTML` (`:583-585`) | smoke |
| 14 | `smoke.html` | `:54,74,120,304` | `tiny.api.call`, `tiny.store.set`, `tiny` presence, `tiny.fetch`, `tiny.win.show` | smoke |
| 15 | `connected.html` | `:157,185,214,237,805` | `tiny.api.call`, `tiny.store.set`, `tiny.fetch`, `tiny.win.show` | smoke |
| 16 | `tabs-driver.ts` | `:193,230,310,596,944-946,992,1084-1107,1877-1887` | `tiny.store.set`, patches `tiny.api.call`, `tiny.fetch`, `tiny.win.getState/setSize/show`, `tiny.clipboard.read/write`, `tiny.win.id` | smoke |
| 17 | `ui-driver.ts` | `:134,150,319,1287-1304,1688` | `tiny.store.set`, `tiny` presence, `tiny.fetch`, `tiny.dialog.openFile` patch, `tiny.win.show` | smoke |
| 18 | `tools.ts` injected page script | `:541-548,575-578` | `window.tiny.win.getState()`, `window.tiny.api.call('login.report')` (expects api-gate refusal) | smoke |

---

## Architecture (how the pieces connect)

1. **Launcher** (tinyjs CLI/`tjs`) owns windows, menus, tray, hotkeys, dialogs, notifications, updates and the origin gate; it spawns **one backend process** (`backend/main.ts`) and webviews per `win.open`.
2. **Backend ↔ page**: page calls `tiny.api.call` → `api` map → `guarded()` checks `meta.window`/`meta.origin` + session/admin; backend pushes via `app.push` → page `api.on`.
3. **Backend ↔ OS**: `tjs` file ops + `tjs:sqlite` for data; `app.secrets` for the keychain; global `fetch` for host/probe traffic (with `redirect:'error'` for the bearer).
4. **Backend ↔ windows**: `app.win.open` + `TinyWindowHandle` (`eval/show/hide/setPosition/setSize/setChrome`) drive the tab/window manager; `onWindowState`/`getState` close the loop for docked geometry.
5. **Build**: `gen-config` folds the seed into `api.origins`/`update`/`resources`; `tinyjs build|publish` produce per-OS bundles and `manifest.json`; `app.update.check/install` consume it.

## Counts

| Area | Rows |
|---|---|
| A. Backend `TinyApp` | 26 |
| B. Window handle | 8 |
| C. `tjs` / `tjs:sqlite` | 13 |
| D. `fetch` | 7 |
| E. Hooks + `TinyApiMeta` | 14 |
| F. Page `tiny.*` | 19 |
| G. `tinyjs.base.json` keys | 17 |
| H. `gen-config` / `resources` | 17 |
| I. Build / release | 26 |
| J. Tests / smokes | 18 |
| **Total** | **165** |

Unused-but-declared surface confirmed absent from Nod code: `app.menu*`, `app.notify`, `app.clipboard`, `app.shell`, `app.badge`, `app.progress`, `app.power`, `app.permissions`, `app.launchAtLogin`, `app.macos.*`, `app.audio`, `app.nowPlaying`, `app.spotlight`, `app.captureScreen`, `app.pickColor`, `app.thumbnail`, `app.say`, `app.voices`, `app.keystroke/paste`, `app.mousePosition/mouseTracking`, `app.presence`, `app.print/printToPDF`, `app.share`, `app.setAsDefaultHandler`, `app.spawnHidden`, `app.theme`, `app.frontmostApp`, `app.eval/reload`, `window.menu`, `tjs.env`.
