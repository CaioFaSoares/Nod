# E06 — Electrobun spike: measured capability report

Throwaway spike for E06 §12 (option "Electrobun"), run on 2026-10-22 on the owner's Mac.
It answers one question only: **can the Nod reach full parity on Electrobun, and what blocks it.**

- Spike: `/tmp/nod-electrobun-spike/nod-spike-app` (identifier `copland.spike.electrobun`, scheme
  `nod-spike`). Not in the repository, not a proposal.
- Host: macOS 27.0.0 arm64 (MacBook Pro, Apple M4), system Bun 1.4.3, `electrobun` npm 2.0.4.
- Evidence: `/tmp/nod-electrobun-spike/evidence/run.jsonl` (JSON-lines log written by the app),
  `dev-run*.log`, `menu-run*.log`, `measure.py` output in this report.

Method per `AGENTS.md`: every claim below is tagged `leitura` (read from source) or `execução`
(observed on this machine). Nothing executed is called verified.

## 1. How Electrobun 2.x actually ships (leitura)

The npm package is a **bootstrap only**: `node_modules/electrobun/package.json` exports
`./lib/moved.cjs`, which throws "Electrobun 2.x APIs come from the Hutch devkit, not node_modules"
(`node_modules/electrobun/lib/moved.cjs:5-12`). `electrobun <cmd>` resolves a pinned Hutch
(`node_modules/electrobun/bin/resolve-hutch.cjs`), which downloads Electrobun core, the Bun
toolchain and the SDK into `~/.hutch`, and **projects the SDK into the project's `.hutch/devkit`**.

What that means for the Nod:

- No `import ... from "electrobun"` inside `node_modules`; imports resolve through the generated
  devkit (`electrobun/main`, `electrobun/view`, `electrobun/rpc`; see
  `.hutch/devkit/package.json` `exports`).
- `electrobun init <dir> --template=<name>` fetches templates from the network; `init` is the only
  step that needs the network besides the SDK download.
- The projected devkit is TypeScript source + a native core (`libElectrobunCore.dylib`,
  `libNativeWrapper.dylib`), so every API below is readable at `.hutch/devkit/api/**` — this report
  cites those paths.
- Artifacts: `build/<channel>-<os>-<arch>/<Name>.app` and `artifacts/<prefix>-update.json` +
  `artifacts/<prefix>-<Name>.app.tar.zst`.
- Commands used: `npx electrobun init ... --template=hello-world --skip-install`,
  `npx electrobun dev --env=dev`, `npx electrobun build --env=canary|stable`.

## 2. Capability matrix

Status: **works** = measured end-to-end; **partial** = works with a documented gap;
**missing** = no API, only a workaround.

| # | Capability the Nod needs | Status | API (devkit path) | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Main window, bundled page | works | `new BrowserWindow({ url: "views://mainview/index.html" })` `core/BrowserWindow.ts:14-57` | execução: `window.main` id 1, page origin `views://mainview` |
| 2 | Main window, dev page over `http://` | works | `url: "http://127.0.0.1:5199/app"` | execução (dev run 4/5): `rpc.page {href, origin:"http://127.0.0.1:5199"}`, embedded views created from that page |
| 3 | Extra windows with x/y/size | works | `frame:{x,y,width,height}`, `centered` when x/y omitted | execução: request 520×420 at (1240,80) → frame `520×452` (outer; +32 px titlebar) |
| 4 | Frameless window | works at creation, **missing** as a runtime toggle | `titleBarStyle: "hidden" \| "hiddenInset" \| "default"`, `styleMask{}` (creation only) `core/BrowserWindow.ts:29-57,229`; only `setWindowButtonPosition` at runtime | leitura: no `setTitleBarStyle`/`setStyleMask` anywhere in `api/`; execução: frameless window id 3 created |
| 5 | setPosition / setSize / getFrame | works | `core/BrowserWindow.ts:349,389,408` | execução: `(1100,120)` + `600×460` read back exactly |
| 6 | show / hide without reload | works | `hide()`, `show()`, `showInactive()`, `isVisible()` | execução: `performance.timeOrigin` identical before/after a hide+show, `__ticks` advanced 0→5 (top window) and 43→46 (embedded) |
| 7 | Focus / blur / close / move / resize events | works | `Electrobun.events.on("focus"\|"blur"\|"close"\|"move"\|"resize", …)`; per-window `win.on(name, …)` `core/BrowserWindow.ts:454` | execução: focus/blur for ids 1–5, `move`/`resize` payloads, `close` for the scratch window |
| 8 | Minimize state | partial | `minimize()`, `unminimize()`, `isMinimized()` `core/BrowserWindow.ts:333-351` | execução: `isMinimized()` true then false; **no minimize/unminimize event** in `events/windowEvents.ts` |
| 9 | Window size = page box (tinyjs `size`) | missing | — | execução: frame 1235×1312 → page `innerWidth/Height` 1235×1280; `frame` is the outer box |
| 10 | Embedded webview inside the page | works | `<electrobun-webview src=…>` custom element, `api/preload/webviewTag.ts:107-190`, `api/browser/webviewtag.ts` | execução: 4 tag views created with correct `hostWebviewId`/`windowId`/`frame` |
| 11 | Load `https://claude.ai/` inside the main window | works | same tag, `renderer: "native"` (WKWebView), no XFO involvement | execução: `did-navigate` → `https://claude.ai/login`, `title "Sign in - Claude"`, body 2959 chars, cookies set |
| 12 | Shared cookie jar with a top-level window | works | default partition `persist:default`; `session.dataset`/`partition` option `core/BrowserView.ts:54` | execução: cookie set in the **sandboxed embedded** view → read in a top-level window on the same origin; `Session.defaultSession.cookies.get` returned it |
| 13 | Read/write/remove cookies from the main process | works | `Session.defaultSession.cookies.get/set/remove/clear`, `Session.fromPartition(p).cookies` `proc/native.ts:3285-3394` | execução: `set ok:true`, `remove removed:true`, embedded view saw set and removal |
| 14 | Execute JS in the embedded top frame (autofill) | works | `BrowserView.executeJavascript(js)` `core/BrowserView.ts:269` | execução: filled `#user`/`#pass` and read them back; retitled claude.ai (`probe-16`) |
| 15 | Navigation hooks with URL | works | `view.on("will-navigate"\|"did-navigate"\|"did-navigate-in-page"\|"did-commit-navigation"\|"dom-ready")`, detail = URL string (`will-navigate` detail is JSON `{url,allowed}`) | execução: every navigation logged with the target URL, including `https://claude.ai/…/hcaptcha` |
| 16 | Navigation allow/deny | works at creation | `navigationRules: string \| null` (`core/BrowserView.ts:294 setNavigationRules`) | leitura: `will-navigate` carries `allowed`; not exercised for denial |
| 17 | New-window / popup hook with opener | partial | `view.on("new-window-open")`, detail `{url,isCmdClick,modifierFlags}` `events/webviewEvents.ts:5-12` | execução: `window.open("https://example.com/spike-popup")` → `{url,isCmdClick:false,modifierFlags:0}`; **no opener id in the payload** — the opener is known only by *which view's* listener fired; no automatic window is created |
| 18 | Resize / hide / show embedded view without reload | works | element CSS + `syncDimensions()`, `toggleHidden()` (`api/browser/webviewtag.ts:38-76`) | execução: after resize to 420×320 and two hide/show toggles, `timeOrigin` unchanged |
| 19 | Typed RPC main ↔ page | works | `BrowserView.defineRPC`, `Electroview.defineRPC`, `api/shared/rpc.ts` | execução: page request `whoAmI` answered; `rpc.page`/`rpc.views` messages delivered |
| 20 | Main process learns the caller (view/window id) | **missing** | handler receives **only `params`** (`api/shared/rpc.ts:455` `requestHandler(method, params)`); wire packet has no id/origin (`api/shared/rpc.ts:3-8`) | execução: variadic handler logged `argCount: 1, args:[{claimedOrigin,href}]` — origin is *self-reported* by the page |
| 21 | Per-origin API gate (remote page gets no backend methods) | **missing** as an API; achievable structurally | per-*view* RPC object (`new BrowserView({rpc})`), `sandbox` flag | execução: a page can only reach the rpc object attached to its own view; but the handler cannot see the origin, so "same view, navigated elsewhere" is invisible |
| 22 | Remote view with no preload/RPC at all | works | `sandbox` attribute on the tag / `sandbox: true` on `BrowserView`/`BrowserWindow` `core/BrowserWindow.ts:55`, `api/preload/index-sandboxed.ts` | execução: in the sandboxed view `typeof window.__electrobun === "undefined"`, no internal/host bridge, `customElements.get("electrobun-webview")` false |
| 23 | Sandboxed view can still talk to the host | **partial leak** | `window.__electrobunSendToHost(msg)` survives sandboxing (`api/preload/index-sandboxed.ts:26`), arrives as `host-message` | execução: `{from:"sandbox"}` received by the main process, with no origin attached |
| 24 | Internal bridge from a foreign page | unproven | `internalBridgeHandler` dispatches by id with **no ownership check** (`proc/native.ts:3567-3640`), exposing `webviewTagExecuteJavascript`, `webviewTagUpdateSrc`, `webviewTagSetHidden`, devtools… (`proc/native.ts:3750-4042`) | execução: 2 hand-built request packets from a trusted remote view had no effect (self- and sibling-target); reachability unresolved, so treat every non-sandboxed remote view as fully trusted |
| 25 | Persistent key-value store | missing | — | execução: own `store.json` written/read at `Utils.paths.userData`; no framework store |
| 26 | App data path | works | `Utils.paths` (`appData`, `userData`, `userCache`, `userLogs`, `logs`, `cache`, `downloads`) `core/Utils.ts:649` — note `PATHS` from `electrobun/main` is only `RESOURCES_FOLDER`/`VIEWS_FOLDER` | execução: `userData = ~/Library/Application Support/copland.spike.electrobun/canary` |
| 27 | SQLite from the main process at the app data path | works | `bun:sqlite` (main process is Bun 1.4.0) | execução: `spike.db` created, `sqlite_version()` 3.54.0, insert+select |
| 28 | Keychain secrets | missing (workaround) | none in `api/`; `Bun.spawnSync(["security", …])` works; FFI to `Security.framework` resolves `SecItemAdd/CopyMatching/Delete` | execução: `security add/find/delete-generic-password` round-trip, exit 0, value read back; FFI symbol load ok |
| 29 | Touch ID / LocalAuthentication | missing (workaround) | none; FFI: `dlopen(LocalAuthentication)` then `objc_getClass("LAContext")` + `objc_msgSend` | execução: `canEvaluatePolicy(biometrics)=true`, `(deviceOwner)=true`, `biometryType=1` (Touch ID). **`objc_getClass` returns null until the framework is `dlopen`ed** — a naive probe reports a false positive |
| 30 | Tray with menu and click | works | `new Tray({image,width,height})`, `setMenu`, `on("tray-clicked")` `core/Tray.ts:21-118` | execução: item visible as "N"; menu items `Open Nod`/`Quit`; click → `{id:1, action:"open"}` |
| 31 | Global hotkeys | works | `GlobalShortcut.register/unregister/isRegistered/unregisterAll` `proc/native.ts:3085-3111` | execução: registered `Cmd+Shift+F12`, real keypress fired the callback, unregister → `isRegistered false` |
| 32 | App menu | partial | `ApplicationMenu.setApplicationMenu([...])`, `on("application-menu-clicked")` `core/ApplicationMenu.ts` | execução: items landed in the **app menu** (title forced to the bundle name); click → `{id:0, action:"settings"}`; a second top-level menu (`role:"edit"`) was **not** installed |
| 33 | Notifications | partial | `Utils.showNotification({title, body})` → `void` `core/Utils.ts:119` | execução: call returns; core logs a real permission flow with legacy fallback (dev log); **no permission API**, no delivery confirmation |
| 34 | Clipboard read/write | works | `Utils.clipboardReadText/WriteText/ReadImage/WriteImage/Clear/AvailableFormats` `core/Utils.ts:318-407` | execução: text round-trip, formats `["text"]`, image `null` |
| 35 | Deep link (`nod://`-style scheme) | partial | `app.urlSchemes: ["nod-spike"]` → `CFBundleURLTypes`; `Electrobun.events.on("open-url")` | execução: from `/tmp` the scheme did **not** resolve ("No application knows how to open URL"); after copying the app to `~/Applications` both a cold start and a running-app `open` delivered `open-url` |
| 36 | Single instance + forwarding | works | implicit (LaunchServices) | execução: a second `open`/`open -n` did not create a second process; the URL reached the same pid |
| 37 | Open external URL in the browser | works | `Utils.openExternal(url)` `core/Utils.ts:35` | execução: returned `true` (browser opened) |
| 38 | Autoupdate check | partial | `Updater.getLocalInfo/channelBucketUrl/checkForUpdate/downloadUpdate/applyUpdate/onStatusChange` `core/Updater.ts:2379-2435` | execução: manifest served from a local HTTP base URL → `update-available` (`1ik271zq → abcdefab`), `checkForUpdate` → `{version:"9.9.9", updateAvailable:true, updateReady:false}` |
| 39 | Autoupdate install | partial | `downloadUpdate()` + `applyUpdate()` (bsdiff patch chain, full `.tar.zst` fallback) | leitura only (`core/Updater.ts:1904-2065`): loop `while (currentHash !== manifest.hash)` applying `<prefix>-<hash>.patch`; not executed end-to-end |
| 40 | Code signing / notarization | partial | `build.mac.codesign`, `notarize`, `entitlements`, `createDmg` `config/ElectrobunConfig.ts:378-435` | execução: default build is **ad-hoc, link-signed**, `Info.plist=not bound`, no entitlements; notarize needs credentials (not run) |
| 41 | Downloads | partial | `view.on("download-started"\|"-progress"\|"-completed"\|"-failed")`, `BrowserView.on` list `core/BrowserView.ts:359-380` | execução: `<a download>` → path `~/Downloads/spike-download (6).txt`, progress 100, completed; navigating straight to a `Content-Disposition` URL only navigated; from `~/Applications` the same download failed with `"Cannot create file"` (missing Downloads TCC grant) |
| 42 | Camera / microphone in a webview | partial, **unsafe to ship** | core implements a per-origin media-capture dialog (`strings libNativeWrapper.dylib`: "Media capture permission requested…"); no API and no config field | execução/leitura: built `Info.plist` has **no** `NSCameraUsageDescription`/`NSMicrophoneUsageDescription`; `ElectrobunConfig` has no such field (Windows has `autoGrantPermissions` only) |
| 43 | Context menu | partial | `ContextMenu.showContextMenu(items)`, `on("context-menu-clicked")` `core/ContextMenu.ts` | execução: menu displayed and the click event carries `action`; the webview's own right-click menu is WKWebView's default (not measured) |
| 44 | Per-view cookie partition | untested API | `partition` (`core/BrowserView.ts:54`), `Session.fromPartition("ephemeral")` | execução: `ephemeral` session with empty cookies; isolation between two partitions not measured |

## 3. Numbers (execução)

**Build**

| Build | Artifact | Unpacked | Notes |
| --- | --- | --- | --- |
| hello-world (stable) | 21 MB `.app` | — | `electrobun build --env=stable`, 26 s |
| spike (canary) | 21 MB `.app` (launcher + 20.5 MB tar.zst) | 67 MB after the first run (66 MB `Contents/MacOS`: Bun + dylibs) | `--env=canary`, 12 s; `artifacts/` = 20.5 MB tar.zst + 222-byte manifest |
| spike app data | — | 82 MB (`self-extraction/*.tar` 69.8 MB + `spike.db` 8 KB + `store.json`) | the retained tar is what patch generation needs |

**Memory after 10–12 s, summed RSS of every process the app spawned** (bun main + launcher + all
WebKit XPC: WebContent per page, GPU, Networking). Sum double-counts shared pages; bun's RSS drifts
with JIT warm-up, so the hello-world spread is real, not an error.

| Scenario | Processes | Summed RSS |
| --- | --- | --- |
| hello-world, one window | 5 | 83 / 142 / 150 MB (3 samples) |
| spike, one window + **one** embedded `claude.ai` webview (minimal mode) | 6 | **221 MB** (bun 69, claude WebContent 91, main page WebContent 19, GPU 26, Networking 15, launcher 1) |
| spike canary build, one window + 4 embedded views (claude + 3 local) | 13 | 709 MB (claude's hCaptcha WebContent alone 372 MB) |

The Nod's RNF-02 premise is 6 MB; tinyjs costs ~50 MiB per extra window (`docs/tinyjs.md` §3).
Electrobun's fixed cost is the Bun main process plus **one WebKit WebContent process per webview**,
i.e. an embedded tab is a page process, not a cheap view.

## 4. The origin gate (the decisive finding)

The Nod's security model is the `"api"` gate: a remote page gets *no* backend methods, and the
caller's origin is stamped by the launcher (`docs/tinyjs.md` §9, `backend/tiny.d.ts`
`TinyApiMeta`). On Electrobun:

- `requestHandler(method, params)` (`api/shared/rpc.ts:455`) — the handler gets **two arguments and
  nothing else**; the packet is `{type,id,method,params}` (`:3-8`). Measured arg count for a
  variadic handler: 1 (`params` only).
- The transport *does* know the sender: `hostBridgePostmessageHandler(id, msg)` resolves the
  `BrowserView` by `id` and calls `webview.rpcHandler(msgJson)` (`proc/native.ts:3511-3533`) —
  identity is dropped exactly at the boundary the Nod needs it.
- Consequently a handler cannot ask "which origin called me". A page that navigates from a trusted
  origin to a remote one keeps the same view, the same rpc object, and the same permissions.
- Two structural mitigations exist: (a) one RPC object per `BrowserView` (a closure can hold the
  view id), and (b) `sandbox: true` for every remote view, which removes RPC, the internal bridge
  and the `<electrobun-webview>` element entirely. What remains in a sandboxed view is
  `__electrobunSendToHost` (one-way `host-message`, no origin), so a "remote page can only emit
  events" rule is enforceable, but every event must be treated as untrusted and origin-less.
- Workaround for a per-origin gate: keep a `Map<webviewId, origin>` fed by `did-commit-navigation`,
  attach one RPC per view, and check the map inside the handler. This is a Nod-built layer, not a
  framework feature; the race between navigation and in-flight calls is the Nod's problem.
- The internal bridge (`webviewTagExecuteJavascript`, `webviewTagUpdateSrc`, …) has **no ownership
  check** in source (`proc/native.ts:3567-3640`), so a non-sandboxed remote page is, in principle,
  able to drive sibling views. Two hand-built request packets from a trusted remote view did
  nothing at runtime, so this is *unproven* rather than exploitable — but it is the reason the
  verdict below insists on `sandbox` for every remote view.

## 5. Autoupdate and distribution vs `docs/distribuicao.md`

`docs/distribuicao.md` today: `tinyjs publish` → per-OS zip + one merged `manifest.json` (version,
url, **sha256**, notes), hosted anywhere; `.github/workflows/release.yml` builds macOS arm64/x86_64,
Linux x86_64/arm64, Windows, merges the manifests, creates `release-<version>`; hotfix letters
(`0.5.5a`) are ordered by `shared/version.ts`, not by the runtime.

Electrobun (leitura + execução):

| Aspect | Electrobun 2.0.4 | Consequence for the Nod |
| --- | --- | --- |
| Manifest | one **per platform prefix**: `<channel>-<os>-<arch>-update.json`, flat, next to the tarball (`api/shared/naming.ts:175-200`; generated `artifacts/canary-macos-arm64-update.json`) | **no merged manifest**; the release job must upload N manifests and the URL is `<baseUrl>/<channel>-<os>-<arch>-update.json` |
| Manifest fields | `schemaVersion, identifier, channel, version, hash, platform, arch, artifact.file` (`core/Updater.ts:135-146`) | **no sha256, no notes, no URL** (the artifact name is derived from the prefix) |
| Integrity | 13-char content hash per build (`SAFE_HASH_PATTERN /^[a-z0-9]{1,13}$/`), tar-header validation, patch chain must end at `manifest.hash` | **no cryptographic signature** (tinyjs 0.61+ has Ed25519 `update.publicKey`); HTTPS is the only transport guarantee |
| Version decision | pure hash inequality: `updateAvailable = manifest.hash !== info.hash` (`core/Updater.ts:1813`) | the runtime never compares semvers; **hotfix letters (`0.5.5a`) and downgrade protection must be built by the Nod** (as `withHotfixes` already is) |
| Delta updates | bsdiff per hop: `<prefix>-<oldhash>.patch`, chain applied until `manifest.hash`, full `.tar.zst` fallback (`core/Updater.ts:1904-2065`; `zig-bsdiff` in `api/shared/build-dependencies.ts:7`) | better than tinyjs's whole-zip; patches are generated **at build time** and need the previous manifest reachable (`build` printed "could not fetch previous update metadata (ConnectionRefused); skipping delta patch" when `release.baseUrl` was down) |
| Channels | `dev` / `canary` / `stable`, chosen at build (`--env`), baked into `Resources/version.json` (`channel`, `baseUrl`, `hash`) | three build pipelines, three manifest sets; dev builds disable updates ("Dev channel - updates disabled") |
| Artifacts | self-extracting `.app` (launcher + tar.zst), `.dmg` optional (`build.mac.createDmg`, default true), `artifacts/*.tar.zst` + manifest | the release job uploads the tarball + manifest per target; the `.app` in `build/` is not the distributable for updates |
| macOS signing | `build.mac.codesign` (default **false** → ad-hoc, `Info.plist=not bound`), `notarize` (needs codesign), `entitlements` | a documented path to Developer ID + notarization exists; **nothing is signed by default**, so the Gatekeeper step of `docs/distribuicao.md` §3 remains until credentials are wired |
| Windows signing | nothing in `ElectrobunConfig` (`win` has CEF/WGPU/icon/permissions only) | same gap as tinyjs: no documented Authenticode story |
| URL scheme in the manifest | `CFBundleURLTypes` generated from `app.urlSchemes`; launches from `/tmp` are **not** registered | the release must live in `/Applications` (the framework documents this for URL schemes) |

## 6. What the Nod's `TinyApp` surface would need

Mapping of `backend/tiny.d.ts` (frontend `tiny` and backend `TinyApp`) onto the measured APIs:

| Nod surface | Electrobun today |
| --- | --- |
| `win.open/getState/setPosition/setSize/show/hide/minimize/setChrome` | `BrowserWindow` (rows 1–9); chrome is creation-time only, page-box sizing missing |
| `app.eval` / `window(id).eval`, `app.push` | `BrowserView.executeJavascript` + RPC (`push` becomes a per-view message; there is no broadcast API) |
| `app.api` handlers with `meta.window/meta.origin` | RPC with **no meta** (row 20–21); the Nod must own the view→origin map |
| `tiny.menu`, `tiny.tray`, `tiny.hotkey` | `ApplicationMenu` (single app menu), `Tray`, `GlobalShortcut` (rows 30–32) |
| `app.store` + SQLite at the data dir | own JSON + `bun:sqlite` (rows 25–27) |
| `app.secrets`, `app.authenticate` | nothing; `security` CLI / Security.framework FFI, LocalAuthentication FFI (rows 28–29) |
| `app.clipboard`, `app.notify` | `Utils.clipboard*`, `Utils.showNotification` (rows 33–34) |
| `app.update.check/install` | `Updater` (rows 38–39) with the manifest/hash caveats of §5 |
| `app.paths`, `app.info`, `app.system.capabilities`, `app.screens` | `Utils.paths`, `BuildConfig`, `Screen` (`api/sdks/main/proc/native.ts:3136`); no capabilities-probing API |
| `app.permissions.check/request` | missing (row 42) |
| `app.audio.*`, `app.playSound`, `app.macos.*`, `app.spotlight`, `app.pickColor`, `app.badge`, `app.print/printToPDF`, `app.icon`, `app.theme`, `app.progress` | **no equivalent found** in the devkit export list (`api/sdks/main/index.ts:222-290`); `Utils` has `moveToTrash`, `showItemInFolder`, `openFileDialog`, `showMessageBox`, `screenCapture` (permission only, no capture) |
| `tiny.api.call/on` (page) | `Electroview` (`api/browser/index.ts:31`) |
| `<electrobun-webview>` for embedded tools | the tag itself (rows 10–18) — this is the capability the Nod is looking for |

So parity is not "a facade over the same primitives": roughly a third of `TinyApp` has no
counterpart and must be rebuilt on OS APIs (secrets, biometrics, permissions, audio, print, badges,
macOS extras), and the RPC/gate model has to be redesigned around per-view trust.

## 7. Verdict

**Conditional go — but not as a runtime swap in this effort.** Electrobun is the only option
measured so far that gives a real embedded webview for any site (Claude included), with
`executeJavascript` on the top frame, a shared cookie jar with top-level windows, hide/show/resize
without reload, navigation and popup hooks — i.e. it clears the technical wall E06 hit on tinyjs.

Blockers, in the order they must be closed (each is a work item, not a detail):

1. **The origin gate does not exist and cannot be added from outside.** RPC handlers receive no
   sender and no origin; the transport knows the view id and drops it. A compatible gate needs a
   Nod-owned layer (per-view RPC + a `viewId → origin` map fed by `did-commit-navigation`) *and*
   `sandbox: true` on every remote view. Without that, a shell that renders third-party tools has
   strictly less isolation than tinyjs's `api.origins`.
2. **Non-sandboxed remote views are over-privileged in source.** `internalRpcHandlers` exposes
   `webviewTagExecuteJavascript`/`UpdateSrc`/`SetHidden`/devtools by numeric id with no ownership
   check. Not reproduced at runtime, but it means "trusted view" must never be a remote origin.
3. **No secrets, no biometrics, no permission API, no print/audio/badge/macOS extras.** Touch ID is
   reachable only through `objc_msgSend` FFI (measured working, including `canEvaluatePolicy`); the
   Keychain only through the `security` CLI or a Security.framework FFI layer. That is a new
   security-critical subsystem the Nod would have to own and audit.
4. **Media capture is unsafe to ship.** The core implements a per-origin capture dialog, but the
   bundle carries no `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` and the build config
   has no field for them — the same TCC kill the Nod already saw on tinyjs (unmeasured here; the
   failure mode is documented in `docs/tinyjs.md` §6). `scripts.postWrap` could patch the plist
   after the build; that is a fork of the build recipe, not a supported option.
5. **Windows and Linux are unmeasured**, and several APIs are macOS-only by construction
   (`urlSchemes`, `fileAssociations`, `app.menu` roles, `setSpellCheck`, `Session` cookie backends).
   The Nod ships four targets; nothing here says they work.
6. **Update integrity is weaker than today's runtime**: no sha256 field, no signature, and the
   version decision is hash inequality, so hotfix ordering and downgrade protection move into the
   Nod. The release pipeline (`docs/distribuicao.md` §8) would be rebuilt around per-platform
   manifests.
7. **Cost**: 21 MB artifact → 67 MB unpacked → ~150 MB on disk with the retained tar; 221 MB summed
   RSS for one window plus one embedded Claude tab, against a 6 MB premise. If the Nod takes this
   path, RNF-02 and the "~50 MiB per extra window" line in `docs/tinyjs.md` §3 both need a decision
   from the owner, not a footnote.

Recommendation: keep Electrobun as the **fallback path for the embedded tabs (RF-69/70)**, not as
the Nod's runtime. Before any rewrite: (a) prototype the per-view origin gate and prove a remote
view cannot reach a backend method after navigating; (b) prove Touch ID + Keychain through FFI in a
signed build (the ACL names the binary, as on tinyjs); (c) run the same matrix on Windows and Linux.
If (a)–(c) hold, the embedded tab can ship on Electrobun as a **sidecar app** with its own window
(the Nod's backend stays on tinyjs) — that captures the one capability tinyjs lacks without
reversing `canonico.md` §22 "Runtime". A full swap is justified only if the owner accepts the
runtime change and the cost in §7.7.

## 8. Not measured (bounded)

- `downloadUpdate`/`applyUpdate` end-to-end (would replace the app under test), notarization,
  Developer ID signing, and patch generation against a live previous release.
- Camera/microphone capture (deliberately not triggered: it would raise OS prompts and could kill
  the unsigned bundle).
- `preload` document-start injection into a third-party page, and per-`partition` cookie isolation.
- Page-level right-click context menu inside a webview.
- Windows/Linux behaviour of any row above.
- The internal-bridge reachability puzzle of row 24.

## 9. Reproduce

```sh
cd /tmp/nod-electrobun-spike/nod-spike-app
npx electrobun dev --env=dev                     # views:// page, full harness, self-quits (~45 s)
NOD_SPIKE_MAIN_URL=http://127.0.0.1:5199/app \
  npx electrobun dev --env=dev                   # main window from an HTTP dev URL (needs
                                                 # evidence/mainview.js staged from a prior build)
NOD_SPIKE_MINIMAL=1 NOD_SPIKE_MAIN_URL=views://claudeonly/index.html \
  npx electrobun build --env=canary && <launch>  # window + one embedded webview
```

`/tmp/nod-electrobun-spike/measure.py <app binary> <label> [seconds]` prints the per-process RSS
table used in §3. The harness writes `/tmp/nod-electrobun-spike/evidence/run.jsonl`; app data
(`~/Library/Application Support/copland.spike.electrobun`) and the `~/Applications` copy were
deleted after the run.
