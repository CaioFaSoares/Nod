# E06 — built-app surface check

`execução` on 2026-10-22, macOS 27.0.0 arm64, Electrobun 2.0.4 (devkit), Bun 1.4.3. Throwaway
identifier `copland.nod.eb-check`, built with
`NOD_APP_ID=copland.nod.eb-check bun run eb:build` (`build/stable-macos-arm64/Nod.app`, 21 MB) and
launched from that bundle and from a temporary copy at `~/Applications/Nod.app`. UI was driven with
AppleScript `System Events` (AX tree of the WKWebView, `AXEnhancedUserInterface`), global keys with
`keystroke`/`key code`, and real mouse events for the download link. Everything below is `execução`
unless a line says `leitura`. The owner's `/Applications/Nod.app` and `copland.nod` data were never
started or modified.

| # | Item | Result |
| --- | --- | --- |
| 1 | Boot from the built bundle, entry screen, local account, unlock, tool window, lock | **ok** |
| 2 | Tray icon and Open Nod / Lock / Quit Nod | **ok** |
| 3 | ⌘K / ⌘1 while focused; not registered while unfocused | **ok** |
| 4 | `nod://open` and `nod://join` on a copy installed in `~/Applications` | **ok** (handler restored) |
| 5 | Close main from the title bar → hidden, app alive, reopen from tray | **ok** |
| 6 | Touch ID sheet on `vault.reveal`, cancel → password fallback | **ok** |
| 7 | Settings → Account app icon Guild/Default | **blocked** (no guild icon offline) |
| 8 | Vault export/import panels appear and cancel | **ok** |
| 9 | Local update channel: notice, tampered sha, install/relaunch, rollback | **ok** (one finding) |
| 10 | Tool `<a download>` saves to `~/Downloads` and audits a `download` event | **ok** (fixed after this pass: §10) |
| 11 | Bundle size and RSS with main + one tool window | **ok** (numbers below) |
| 13 | Camera/microphone TCC from a docked tool view; right-click menu in the view and in the shell | **ok** (one caveat: prompt naming under ad-hoc signing) |
| 12 | Update/rollback from a just-swapped bundle, 5× | **ok** (was: §9's silent no-op; fixed, §12) |

## 1. Boot, account, unlock, tool window, lock — ok

- The packaged main window loads `views://mainview/index.html` (`electrobun.config.ts` build block:
  `copy.dist = views/mainview`; `electrobun/bun/index.ts` uses that URL because
  `BuildConfig.channel !== 'dev'`). The entry screen rendered with Offline selected
  (`Set up Nod on this machine`, NAME/EMAIL/PASSWORD/CONFIRM PASSWORD).
- Created a local account (`Check Admin` / `check@teste.com` / `correct-horse-42`); the app moved to
  the catalog (`TOOLS`, `Add personal tool`, `Settings`, `Lock`). Locked and unlocked with the
  password; the locked screen reads `Offline` with the email prefilled.
- Added a personal tool `Fake Tool A` at `http://127.0.0.1:47821/` (local Bun server, page served
  with `bridge: api,win,store,dialog,clipboard,fetch`). `tools.open` produced a window tab; a second
  window titled `Not from your org — Fake Tool A` was created by the window manager, same pid.
  `Lock` from the sidebar closed the tool window and left the main window on the lock screen.

## 2. Tray — ok

- Menu-bar extras: process `Nod` has a second menu bar with one item, `status menu`, named `Nod`
  (icon present).
- Opening it listed, in order: `Open Nod`, `Lock`, separator, `Quit Nod`.
- `Lock` → main window shows the `Offline` lock screen, pid alive.
- `Open Nod` → main window shown/raised (the WM tiled it at 1235x1312@2326,-1350).
- `Quit Nod` → `app.quit()`; the launcher and bun processes of the run disappeared (pids 91903 and
  91907 gone; `pgrep` empty).

## 3. Global hotkeys — ok

- Main focused, `⌘K`: the palette opened (`Search tools, views and actions…`, with `Tab: Fake Tool A`,
  `Settings › Vault`, `Lock`, `Quit`, …).
- Closed the tool window, focused main, `⌘1`: tool 1 opened as a new window
  (`Not from your org — Fake Tool A`, window id 7486).
- Focused Finder (`osascript -e 'tell application "Finder" to activate'`) and sent `⌘K`: Finder's
  `Connect to Server` opened and the Nod palette did not (`Search tools` count 0 in the Nod AX tree).
  The app log shows `GlobalShortcut` register/unregister cycle while focus changes.

## 4. Deep links — ok, handler restored

- `lsregister -dump` showed several `nod:` claimants (`/Applications/Nod.app` = owner's tinyjs app,
  `.Trash` copies, the smoke build, and this build). `LSCopyDefaultHandlerForURLScheme("nod")` first
  answered `copland.nod`.
- Copied the build to `~/Applications/Nod.app`, registered it (`lsregister -f`) and set it as the
  temporary default with `LSSetDefaultHandlerForURLScheme("nod", "copland.nod.eb-check")`.
  `LSCopyAllHandlersForURLScheme` then listed `copland.nod.eb-check` first.
- `open 'nod://open?url=https://example.org/dl-check'` reached the running app
  (`onOpenUrl` → `openLink`): a new window titled `example.org/dl-check`. No second process.
- `open 'nod://join?host=http://127.0.0.1:59998&fp=abc123&code=INST-1234'` raised main and opened
  the join screen with the INVITE LINK field prefilled with that exact link.
- Caveat observed once: while both the build bundle and the `~/Applications` copy were registered
  with the same identifier, `open nod://…` launched a second instance from the build path instead of
  reaching the running copy. After `lsregister -u` of the build bundle, the installed copy received
  the second launch in-process. This is a LaunchServices consequence of two bundles sharing one
  identifier, not a change to `onOpenUrl`.
- At the end: `lsregister -u ~/Applications/Nod.app`, copy deleted, default handler set back to
  `copland.nod` (`LSSetDefaultHandlerForURLScheme` status 0; query answers `copland.nod`).

## 5. Close → hide (RF-15) — ok

- Pressed the main window's red close button. The main window left the CG window list, the tool
  window and the process stayed alive (`pid 91907` still running).
- Tray → `Open Nod`: main window returned (new CG window id), still unlocked.

## 6. Touch ID gate — ok

- Settings → Vault → saved one credential (`Fake Tool A`, `vaultuser`, label `Check Login`), then
  pressed `Reveal`. The system sheet appeared: `coreautha`, layer 1000, 260×257 at 1017,331, text
  `bun is trying to Authenticate to reveal a credential.` / `Touch ID or enter your password to
  continue with bun.` (the known attribution to `bun`, `e06-native.md`).
- Pressed the sheet's `Cancel` button. The page showed its password fallback:
  `The system prompt did not confirm: until you lock Nod, actions take your password.` and a PASSWORD
  field (`src/settings.ts:1910`; the generic `src/vault-gate.ts:57` string differs:
  `The system prompt did not confirm — use your Nod password instead`). The task's quoted wording
  does not occur verbatim in the page; the observed string is the one above.

## 7. App icon Guild/Default — blocked

- Offline local account; no `host` row and no guild icon. Settings → Account says verbatim: `This
  guild has no icon yet — the option appears once an admin uploads one.` (`src/settings.ts:1252`), so
  neither `Guild` nor `Default` is offered and `nod.setAppIcon` was not reachable from the surface.
- `nod.appIcon` answers `guildIconAvailable: false` unless the cached snapshot signs a guild icon and
  the bytes hash to it (`backend/guild-icon.ts` `available()`), which needs a connected guild; no dev
  hook exposes `app.icon` on a packaged build. Not exercised; no code was changed.

## 8. Vault export/import panels — ok

- Filled `LOCAL PASSWORD`, pressed `Export`: a `Save` panel appeared (`Nod`, layer 8, 370×204) and
  was cancelled with Escape. No file was written.
- Filled the second `LOCAL PASSWORD`, pressed `Import`: an `Open` panel appeared (880×448) and was
  cancelled with Escape. Both go through `native.saveFile`/`openFile` (`facade/native.ts`).

## 9. Update over a local channel — ok, with a UI finding

Channel: `http://127.0.0.1:47830/eb-manifest.json` + artifacts, served by a Bun server. Seed
`update.url` was temporarily `http://127.0.0.1:47830/manifest.json`; the installed app was rebuilt
with that seed. `scripts/eb-publish.ts build` published `nod-0.6.0d-eb-macos-arm64.tar.zst`
(sha256 `ca4c287b…d19a96`) from a 0.6.0d build. `resources/seed.json` and `tinyjs.base.json` were
restored afterwards.

- **Notice:** after the 5 s first check (and again from Settings) the main notice read
  `Version 0.6.0d available`; Settings read `Version 0.6.0e available (current 0.6.0d)` when the
  manifest named 0.6.0e, with the manifest notes.
- **Tampered sha256:** manifest sha set to 64 zeros. The app fetched `eb-manifest.json` and the
  archive (server log `GET /nod-0.6.0d-…tar.zst`), then nothing: `updates/` empty afterwards, bundle
  still `CFBundleVersion 0.6.0c`, same pid. Refused. **Finding:** the page still shows the banner
  `Update installed` (the page ignores the `false` returned by `nod.installUpdate`; it cannot tell a
  refusal from a success).
- **Correct sha256:** click `Install`; `updates/swap.log` records
  `swapping /Users/caio/Applications/Nod.app <- …/staged-96798-…/Nod.app` and
  `updated …; previous bundle kept at …/rollback/Nod.app-96798-…`; the app quit, the bundle became
  `CFBundleVersion 0.6.0d`, a new pid relaunched, and Settings showed
  `Nod 0.6.0d · seed 1 · macos`.
- **Rollback:** manifest 0.6.0e with a correctly hashed archive of a bundle that has the same
  identifier and version but no `Contents/MacOS/launcher` (sha256 `ad200d6e…42ef`). `Install` →
  `swap.log`: `swapping … <- …/staged-98927-…/Nod.app`, `The application cannot be opened because
  its executable is missing.`, `the new bundle did not launch; restoring the old one`; a new pid
  reopened `~/Applications/Nod.app` and the bundle is again `0.6.0d`. One earlier attempt of the same
  broken artifact (from pid 97444, the bundle the helper had just opened) produced the artifact fetch
  but neither a swap nor a log line; the later attempts (pids 98346 and 98927) reached and exercised
  the rollback. The cause of that first silent refusal was isolated in the next round and fixed —
  see §12 (a `tar --zstd` that could not find its `zstd` on the stripped `PATH` the helper passes on
  to the app it reopens).
- Staged/downloaded artifacts and swap scripts were removed with the app data dir at the end.

## 10. Tool download — fixed (was: failed)

The failure this pass found, then the fix and its measurements (execução, 2026-10-22, throwaway
identifier `copland.nod.eb-dl`, `NOD_APP_ID=copland.nod.eb-dl bun run eb:build`, launched from the
build bundle; the owner's `/Applications/Nod.app` and `copland.nod` data were never touched).

**What was measured failing (before the fix).** In the tool view, the page's
`<a download href="/report.txt">` was pressed with `AXPress` and with a real mouse click. No `download`
row appeared in `event`, no file in `~/Downloads`, and the app log printed repeatedly
`sandbox_extension_issue_file failed for /Users/caio/Downloads: 1 (Operation not permitted)`.

**Why the devkit cannot do it as-is.** The wrapper's download path is a `WKDownload` whose destination
is hardcoded to the account's Downloads directory, decided inside `libNativeWrapper.dylib`
(`download:decideDestinationUsingResponse:suggestedFilename:completionHandler:`, strings confirmed in
`build/dev-macos-arm64/Nod-dev.app/Contents/MacOS/libNativeWrapper.dylib`). The devkit exposes only
the four events and no way to change the destination:

- `.hutch/devkit/api/sdks/main/proc/native.ts:3428-3431` — `download-started|progress|completed|failed`
  are the whole download surface; the `initWebview` argument list (`proc/native.ts:747-771`) has no
  download directory, save path or handler parameter, and no other FFI symbol carries one.
- `.hutch/devkit/api/sdks/main/core/BrowserView.ts:359-380` — `BrowserView.on` accepts only those
  four names.
- `.hutch/devkit/api/config/ElectrobunConfig.ts` — no `downloads` key (unlike tinyjs
  `"downloads": "auto" | "ask" | "deny"`).
- The failure happens before any delegate callback, so neither `download-completed` nor
  `download-failed` fires and `onDownload` never runs (the same shape as
  `docs/handovers/e06-electrobun-spike.md` row 41, where a copy in `~/Applications` failed with
  `Cannot create file`).

**The fix (tool views stay `sandbox: true`; nothing is unsandboxed).** The one channel a sandboxed view
keeps is `window.__electrobunSendToHost`, so a click on `<a download>` is handed to the host, which
fetches and writes the file with its own (non-sandboxed) process:

- `electrobun/view/tool-bridge.ts` — the sandboxed preload installs a capture-phase `click` listener.
  For an `<a download>` with a same-origin `http(s)` URL it calls `preventDefault()` and sends
  `{ id: 0, method: 'nod.download', params: { url, filename } }`; for a `blob:`/`data:` URL it reads
  the bytes and sends them as base64 (ceiling 8 MiB); anything else keeps the page's default (the
  HTML rule ignores `download` for cross-origin URLs, and so does this).
- `electrobun/bun/facade/gate.ts` — `admitDownload` admits `nod.download` under the same rule as the
  api: a view the runtime created, not the main window, and a committed origin the runtime observed
  (never one the page claims). It is not an api method and can never reach a backend handler; the
  page gets back only `{ filename, path }` or an error message.
- `electrobun/bun/facade/downloads.ts` — fetches the URL with the view's session cookies
  (`Session.fromPartition('persist:default')`, recomputed per redirect hop, same-origin only), or
  takes the page's base64 bytes, writes into `Utils.paths.downloads` with the macOS de-dup naming
  (`report.txt`, `report (1).txt`, … — the shape the devkit's own WKDownload produced in the spike),
  and emits `onDownload({ state: 'done' | 'failed', … })` into `backend/main.ts` `onDownload`, which
  writes the audit row.
- `electrobun/bun/index.ts` — wires the service (save dir, cookie header, `backend.onDownload`).

**Measured (execução, after the fix).** Local Bun server on `:47991` standing in for the tool page; one
tool row pointing at it; the tool opened as the in-window tab.

- `save report` (`<a download href="/report.txt">`): the server logged `GET /report.txt ua=Bun/1.4.0`
  (the **main process** fetched it, not WebKit), `~/Downloads/report.txt` exists — 17 bytes, `Plain
  Text`, "Today at 16:44" (Finder's own AX tree; the agent's shell has no Downloads TCC), and
  `event` has `type='download'`, `url=http://127.0.0.1:47991/report.txt`, `result='done'`,
  `detail='report.txt'`.
- Two more presses: `report (1).txt` and `report (2).txt`, and the audit rows carry those names —
  de-dup naming and the reported filename both hold.
- `save missing` (404): `event` has `result='failed'`,
  `detail='missing.txt: the server answered 404 Not Found'`, and `missing.txt` is absent from
  Downloads. A failed download is audited.
- `save generated` (`blob:` URL, `download="generated.csv"`): `generated.csv` saved and audited
  `done` with an empty `url` (the bytes never had one).
- No `sandbox_extension_issue_file failed` line appeared for any of these saves; the write came from
  the bun main process.

**Remaining gaps (precise, follow-up material).**

1. A *plain navigation* to a URL that answers `Content-Disposition: attachment` — no `download`
   attribute, no page-side `blob:` — still reaches the wrapper's native `WKDownload` and is still
   lost: the destination is decided in native code (`libNativeWrapper.dylib`, symbol
   `download:decideDestinationUsingResponse:suggestedFilename:completionHandler:`) and no devkit
   API exposes it (`proc/native.ts:747-771`, `:3428-3431`). Closing it needs a devkit destination
   hook (or a page-visible navigation decision, which the devkit does not deliver:
   `webviewDecideNavigation` is documented as never called, `proc/native.ts` around the
   `webviewEventJSCallback`).
2. Cross-origin `<a download>` is left untouched (the HTML rule drops the attribute there); those
   links keep the engine's behavior, i.e. gap 1 if the server sends an attachment.
3. A click inside a child frame is not intercepted: the preload is the top document's.
4. `blob:`/`data:` files above 8 MiB are refused with an audited failure (`the file is larger than
   8 MiB`): the one-way host channel carries them as base64 inside one JSON message.
5. The main window keeps the native path; only tool, popup, link and embed views route through the
   host. `~/Downloads` writes from the bun main process are subject to macOS Files-and-Folders (TCC)
   for the app bundle; a refusal surfaces as an audited `failed`
   (`Cannot create file: … Operation not permitted`) rather than a silent loss.

## 11. Size and memory — ok

- `du -sh build/stable-macos-arm64/Nod.app` = **21 MB** (built bundle).
- `du -sh ~/Applications/Nod.app` after the update/rollback tests = **68 MB**
  (`Contents/MacOS` 66 MB — the Bun runtime the launcher carries, `Contents/Resources` 2 MB).
- `du -sh ~/Library/Application Support/copland.nod.eb-check` at the same moment = **150 MB**
  (`stable/updates` 68 MB of test artifacts, `stable/self-extraction` 81 MB, DB ≈1.5 MB). The data
  dir was deleted afterwards, so this is the spike's high-water mark, not a steady-state number.
- RSS after 15 s with the main window and one tool window open (`ps -o rss`):
  launcher 736 KB + bun 23,168 KB = **23,904 KB ≈ 23.3 MB** total.

## 12. Update rollback from a just-swapped bundle — fixed (was: §9's silent no-op)

`execução` on 2026-10-22/23, throwaway identifier `copland.nod.rb`. Built from an rsync copy of the
tree (`.hutch/locks` excluded, `node_modules` symlinked) — first in `/tmp/nod-rb-build`, then, after
the system reaper deleted that staging in the middle of a run, in `/var/tmp/rbv/tree`. No build ran in
the repo and the owner's live `eb:dev` lock was never waited on. Bundles: `0.6.0p` (X) and `0.6.0q`
(X+letter) from `NOD_APP_ID=copland.nod.rb bun run eb:build`; the broken artifact is the X+letter
bundle with `Contents/MacOS/launcher` removed and its plist/`version.json` bumped (`0.6.0r`,
`0.6.0t`, `0.6.0v` — same identifier and version as the manifest names). Channel: a Bun server on
loopback (`:47871`, then `:47881`) holding `eb-manifest.json` + the artifacts; every artifact
published with `bun scripts/eb-publish.ts build --arch arm64 --version <v> --base-url …`. The copies
carried a throwaway, build-only driver in `electrobun/bun/index.ts` (a control-directory poll that
calls `update.install()` and logs the answer and `refusal()`), since clicking Settings needs an
unlocked account; the repository's file was never the driver.

**Reproduced.** Installed X and installed X+letter from it (`swap.log`: `swapping …` then `updated …`,
new pid with `CFBundleVersion 0.6.0q`). From that just-relaunched app, an install of the broken
artifact answered **`false`**: the server logged `GET /eb-manifest.json` and
`GET /nod-0.6.0r-eb-macos-arm64.tar.zst`, `swap.log` gained no line, no `staged-*`/`download-*`
survived, and the pid did not change — exactly the §9 no-op, and repeatable.

**Cause.** `tar --zstd` does not contain zstd: libarchive runs a `zstd` binary it finds on `PATH`, and
macOS has none in `/usr/bin` (this machine's is `/opt/homebrew/bin/zstd`). The swap helper launched the
new Nod with `open`, and `open` hands the caller's environment to the app it starts; the helper's
environment was `PATH` alone, stripped to `/usr/bin:/bin:/usr/sbin:/sbin`. So the app the helper had
just swapped in could not run zstd: `Bun.spawnSync('/usr/bin/tar', ['--zstd', …])` exited 1
(`tar: Error opening archive: Can't initialize filter; unable to run program "zstd -d -qq"`),
`extractArchive` answered `false`, and `installOnce` returned `false` after its `console.error` — which
under `open` goes nowhere. §9's *later* attempts reached the rollback because that app had been
launched from a shell whose `PATH` carried Homebrew. Every Finder-launched Nod has the same defect, so
this was not limited to the helper.

**Fix (`electrobun/bun/facade/update.ts`, `backend/main.ts`).**

- A `.tar.zst` is decompressed with Bun's native zstd and the plain tar handed to `/usr/bin/tar`
  without a filter program: no external binary, no `PATH` dependency (the decompressed bundle is one
  ~70 MB buffer, written out and released before the swap).
- The helper runs with an allowlist — `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`,
  with the tool directories appended — never the whole environment of the process it replaces, so the
  Nod it reopens has the environment a Finder launch has.
- Every refusal (before or after the download) appends one line to `updates/install.log` —
  `install <v> from <channel>` then `refused: <reason>` or `armed the swap helper (pid …)` — and is
  answered by `UpdateFacade.refusal()`. `nod.installUpdate` audits a second `update` event
  (`result='failed'`, `detail` = that reason) beside the `requested` one it already wrote.
- The helper cleans its own archive and staging on every exit path (rollback and abort included) and
  keeps exactly one bundle in `updates/rollback/`; before, each swap left a 26 MB archive, an empty
  `staged-*` and one more 70 MB bundle for an hour.

**Re-check (execução, after the fix).** Two series on the fixed tree, both from a helper-relaunched
app. The first (`0.6.0u` installed, broken `0.6.0v` five times, then a successful `0.6.0u` → `0.6.0x`)
measured the environment the helper now passes on: the boot line of the app the helper reopened
carried the user `PATH`, `HOME` and `TMPDIR`, and the upgrade swapped and relaunched cleanly. The
final one-shot series re-ran the whole thing on the final code: built `0.6.0p` and `0.6.0q` from a
fresh copy, `0.6.0p` installed it as `0.6.0q` (`swap.log`: `swapping …`, `updated …`; new pid booting
`version=0.6.0q`), then five installs of the broken `0.6.0r` artifact **from the app the helper had
just reopened**, one per relaunch (pids 46017, 46068, 46158, 46224, 46326). Every attempt wrote
`install 0.6.0q from …` and `armed the swap helper (pid …)` in `install.log`, and `swapping …`,
`The application cannot be opened because its executable is missing.`,
`the new bundle did not launch; restoring the old one` in `swap.log`; the server logged the manifest
fetch and one artifact `GET` per attempt; each time the bundle came back `0.6.0q` and a new pid
reopened it (46068, 46158, 46224, 46326, 46441). `updates/rollback/` afterwards held exactly one
bundle (`Nod.app-45920-…`, the one the successful swap replaced) and no `download-*`/`staged-*` was
left behind. `test/eb-publish.test.ts` (29 pass) covers the decisions changed: a `.tar.zst` unpacks
with `PATH=/nonexistent`, a non-zstd file is refused with its reason, the helper environment is the
allowlist plus tool dirs, and a refused/absent channel is logged and answered by `refusal()`. The
`update` event of `nod.installUpdate` is `leitura` + typecheck in this round: writing one needs an
unlocked session, so the page's click path was not re-driven here (the facade was called from a
throwaway, copy-only driver, exactly as the handler calls it).

**Remaining.** The audit event for a refusal has no UI of its own: the page shows
`The update could not be installed` and the reason is only in the `event` row and `install.log`.

## 13. Camera/microphone and the context menu — ok, with a signing caveat

A second throwaway build (`NOD_APP_ID=copland.nod.mm bun run eb:build`, identifier `copland.nod.mm`,
copy at `/private/tmp/nod-mm-build`) drove two local origins (Bun servers, `127.0.0.1:47861` and
`:47862`) served with `text/html`, no special headers, and a page that calls
`navigator.mediaDevices.getUserMedia({video: true, audio: true})` on load. `47861` is a **seed entry**
(org tool, `mmorg`, role `admin`, one view); `47862` is a **personal tool** created through
`catalog.save`, i.e. not from the release seed. The copy's `electrobun/bun/index.ts` had an
env-gated probe (`NOD_MM_PROBE`) that created the local account and called `tools.openView` /
`tools.open` — the product path that docks the tab (`chrome.frame=false`); the repository was not
modified. A built app cannot be pointed at a driver page (`NOD_MAIN_URL` is dev-only), so the probe
is the equivalent of the smoke runner's page.

**The plist is load-bearing.** With the usage strings present in the wrapped `Contents/Info.plist`,
the docked tool page reports `typeof navigator.mediaDevices === "object"` and
`isSecureContext === true` (secure context: loopback). With a build whose packed plist lacked them
(see “Fixed” below; a manual `ELECTROBUN_WRAPPER_BUNDLE_PATH=… bun scripts/eb-postwrap.ts` writes
them into the wrapper), the **same page**
reports `navigator.mediaDevices === undefined` — in the docked view **and** in the main
`views://mainview` page — and the call throws
`TypeError: undefined is not an object (evaluating 'media.getUserMedia')`. WebKit itself gates the
API on the usage descriptions; this is why the generator refuses a build without them and why the
postwrap exists. The main page (`views://`) is not asked to capture in the product; the shell's
`mediaDevices` came back with the strings, i.e. the views:// origin is not excluded from media.

**Fixed after this pass — hutch packs before `postWrap`.** Three consecutive incremental `eb:build`
runs from an rsync copy in `/tmp` (throwaway identifier `copland.nod.pwg1`, symlinked
`node_modules`, the owner's `eb:dev` lock untouched) reproduced the caveat deterministically and
named its cause. The outer `build/stable-macos-arm64/Nod.app/Contents/Info.plist` carried both
strings after every run; the self-extracting payload — `Contents/Resources/<hash>.tar.zst`,
byte-identical to `artifacts/stable-macos-arm64-Nod.app.tar.zst` — carried neither. Measured order
on Electrobun 2.0.4 / hutch 0.28.1: the payload tar is written ~150 ms **before**
`scripts.postWrap` runs (so the hook patches a bundle that has already been packed), and
`--env=dev` does not run `postWrap` at all (the dev bundle had 0/2 keys). Since the payload tar is
what an installed/updated app runs, the media gate was real even when the wrapper looked patched.
`scripts/eb-postbuild.ts` now runs as `scripts.postPackage` — after packaging, when both tars
exist — and as the last step of `eb:build` / the workflow (`bun run eb:verify`): it patches the
outer plist when needed, rewrites a payload tar whose inner plist lacks the strings, then asserts
every bundle and tar, exiting non-zero (`HookFailed`) on a surviving gap. The pure decisions live
in `scripts/eb-plist.ts` and are covered by `test/gen-electrobun-config.test.ts`. Re-measured with
three consecutive incremental builds from the copy: outer 2/2, bundle payload 2/2 and artifact
payload 2/2 on every run; `electrobun build --env=dev` also produces 2/2. The caveat is closed.

**The TCC prompt.** With the strings in place the request produces two system prompts, microphone
first and camera second (`Allow “launcher” to access your microphone?` / `… your camera?`). The
prompt is attributed to the bundle's executable name (`launcher`), and **no usage-description line
appears under the question** even though `plutil -extract NSMicrophoneUsageDescription raw` and
`NSCameraUsageDescription` both return the Nod sentences from `tinyjs.base.json`; the two prompts
also agree with `tccd`'s records (`IDENTITY_ATTRIBUTION: …/launcher = copland.nod.mm`). This is the
same packaging family as the Touch ID sheet attributed to "bun" and the keychain ACL prompt (§Gaps
21–22 of the matrix): the build is ad-hoc signed with `Identifier=launcher`, `Info.plist=not bound`,
so TCC does not present the bundle's display name or usage sentence. Not a facade change.

**No site prompt, either origin.** The devkit's `MyWebViewUIDelegate` has a per-origin dialog
("This page wants to access your camera…", `libNativeWrapper.dylib`). It is **never shown** here:
the unified log shows `UserMediaPermissionRequestManagerProxy::processUserMediaPermissionValidRequest
… action: Prompt` and then the AVCapture/TCC path, with no `WKWebView: Media capture permission
requested` line. WebKit 605.1.15 (macOS 27) performs the TCC check first and never asks the app's
delegate, so on this engine there is no origin-level prompt to suppress (the devkit's cache/dialog
is dead code on macOS, whatever its limit). Consequences for parity:

- **Org tool (seed origin)** — the person sees only the system dialog, which is exactly what
  `docs/canonico.md` §22 describes for org tools (tinyjs grants WebKit's per-origin prompt; the
  system dialog is what remains). **Parity holds.**
- **Non-org origin (personal tool)** — the same system dialog, no per-site question. tinyjs would
  keep WebKit's per-origin prompt here; Electrobun keeps the engine's own prompt (the TCC dialog)
  and the Nod's "Not from your org" banner is the visible difference. Recorded as the H4 gap, not a
  regression in this target.

**Outcomes.** Denying both prompts on the org tool rejected the promise with
`NotAllowedError: The request is not allowed by the user agent or the platform in the current
context, possibly because the user denied permission.` A later request under the same TCC denial
rejects with the same `NotAllowedError` without a prompt. In the non-org run one prompt round was
allowed (camera and microphone `Allowed (User Consent)` in `tccd`); the promise resolved with
`audio,video` tracks. The grant was revoked immediately: the copy was registered with
`lsregister`, `tccutil reset Microphone copland.nod.mm` and `tccutil reset Camera copland.nod.mm`
both reported success, and the copy was unregistered and deleted. No capture was requested again
afterwards.

**Context menu.** A right-click inside the docked tool view (`x=1700,y=500`) and one in the main
page's sidebar (`x=1200,y=700`) each opened a layer-101 `Nod` menu window. Its items are the
WKWebView default — `Reload` (`WKMenuItemIdentifierReload`), separators, `Inspect Element`
(`WKMenuItemIdentifierInspectElement`) — the same menu `contextMenu: true` leaves in place on tinyjs
(the page had no selection or editable field, so Copy/Look Up are absent in both). No facade code
participates; nothing to fix.

## Cleanup

- Removed `~/Applications/Nod.app` and `~/Library/Application Support/copland.nod.eb-check` (data,
  DB, `updates/`, `self-extraction/`), unregistered the copy, and set the `nod:` handler back to
  `copland.nod` (owner's app untouched and not launched).
- Killed the two local test servers (`:47821`, `:47830`) and the app processes; `ps` shows no
  `Nod.app/Contents/MacOS/*` process and no `copland.nod.eb-check` data dir.
- `resources/seed.json` and `tinyjs.base.json` restored byte-for-byte from backups;
  `electrobun.config.ts` regenerated in dev mode (identifier `copland.nod.eb`, version `0.6.0c`).
- No keychain item with service `copland.nod.eb-check` was found by `security
  find-generic-password`/`delete-generic-password` (the native helper uses the identifier as the
  service; nothing to delete was reported).
