# E06 — the Electrobun target's native helper: measured design

Owner files: `electrobun/native/NodNative.swift`, `scripts/build-nod-native.ts`,
`electrobun/bun/facade/native.ts`, `test/electrobun-native.test.ts`.
Run: 2026-10-22, macOS 27.0.1 arm64 (Apple M4), Electrobun 2.0.4 (devkit in `.hutch/devkit`),
Bun 1.4.0 inside the app. Throwaway apps: `/tmp/nod-min-probe` (a minimal app),
`/tmp/nod-native-probe-app` (an isolated copy of the spike project), evidence in
`/tmp/nod-native-probe/`. Nothing here touched `copland.nod*` data or `/Applications/Nod.app`.

## Decision: an in-process dylib, not a stdio helper process

The parity contract sketched a long-lived helper process with JSON lines. Measured facts rule it out:

- `lsappinfo` on a running Electrobun app reports the foreground application as
  `<Name>.app/Contents/MacOS/bun` (a different pid from `Contents/MacOS/launcher`); the Bun process
  is the app.
- `pthread_main_np()` called from the Bun entry returns **0**; `sample` of the process shows the
  main thread inside `-[NSApplication run]` (`bun main → electrobun_core_run_main_thread →
  startEventLoop`), with the JS loop on a separate Bun worker.
- A child process is therefore a different app identity: it cannot own `NSApp.applicationIconImage`,
  its panels and Touch ID sheet are attributed to the helper binary, and a keychain item it writes
  gets an ACL naming the helper (the `docs/tinyjs.md` §5 trap, made permanent).

So `NodNative.swift` compiles to `libNodNative.dylib`, loaded in-process with `bun:ffi`. Wire
discipline is unchanged: one JSON request string per call (`id` echoed), one JSON response; secrets
exist only as in-memory arguments (never argv, env, a temp file or a log). AppKit work hops to the
main queue; the JS thread blocks only for panels/icon, never for the authentication sheet.

## Measured calls (throwaway launch, no real credential typed)

| Call | Result | Evidence |
| --- | --- | --- |
| `canAuthenticate` | `true` (`deviceOwnerAuthentication`) | `log-min.jsonl` |
| `keychain.set/get/delete` (service `copland.nod.eb-dev`, throwaway account) | set true, get returns the value, delete true, get after delete null; no prompt inside one build | `log.jsonl`, `log-min.jsonl` |
| `setAppIcon(path)` / `setAppIcon("")` | applied/restored, Dock shows the probe PNG, then the bundle icon again; timers unaffected | `dock-crop2.png`, `log-min.jsonl` |
| `authenticate.begin` | returns a token; the LA sheet appears (`coreautha`, layer 1000, 260×257) with the reason text | `auth-d3.png` |
| `authenticate.poll` while up | `{"status":"pending"}` | `log-min.jsonl` |
| `authenticate.cancel` then poll | `{"status":"done","result":false}`; no crash | `log-min.jsonl` |
| `openFile({types:["json"]})` | app-modal `NSOpenPanel` titled with the request, frontmost as the app; JSON-only files selectable. Closes on user cancel; returns the path on OK | `panel-min.png` |
| `setWindowFrame(ptr,false/true)` | enqueued true; the process kept ticking through both style-mask changes, so the async form avoids the synchronous-FFI abort Windows measured | `log-min.jsonl` |
| `setContentMinSize(ptr,760,500)` | enqueued true | `log-min.jsonl` |

The last two exist for Windows' slice (`windows.ts`), which owns the policy (page box, focus, dock
positions); the native side only applies the primitive on the main queue with the window delegate
nil'd.

## Protocol

`keychain.get/set/delete` (`service?`, `account`, `value?`) · `canAuthenticate` ·
`authenticate.begin/poll/cancel` · `setAppIcon` (`path`, `""` restores) ·
`openFile`/`saveFile` (`types?`, `name?`, `title?`) · `setWindowFrame` (`target`, `frame`) ·
`setContentMinSize` (`target`, `width`, `height`).

Authentication is begin/poll rather than one blocking call: the sheet is asynchronous, and blocking
the Bun loop while a person decides would freeze every backend task. The facade polls every 100 ms
and cancels at a 5-minute deadline. Panels are synchronous `runModal`, so the Bun loop is blocked
while an app-modal panel is up — the app is modal at that point anyway.

Build: `bun scripts/build-nod-native.ts [--arch=arm64|x86_64|universal]` → 
`electrobun/native/build/libNodNative.dylib`, deployment target macOS 15 (RNF-01). Shell's
`eb:dev`/`eb:build` run it before generating the config; the config copies it to
`Resources/app/native/libNodNative.dylib`, which the facade resolves beside `process.execPath` (with
repo fallbacks). Missing dylib or non-darwin: `available` is false and every method degrades
(`null`/`false`), never a crash.

## Known limits, recorded rather than hidden

- The LocalAuthentication sheet is attributed to **“bun”**, not to Nod: the running process is
  Electrobun's inner `Contents/MacOS/bun` binary and ad-hoc signing gives it its own identity. Fixing
  the displayed name is Electrobun packaging work (sign/rename the inner binary), not a native-helper
  change. The reason text is ours and correct.
- Keychain items are created by the ad-hoc signed `bun` binary; after every rebuild the ACL names a
  new signature, so a read may prompt once — the same behavior `docs/tinyjs.md` §5 documents for the
  tinyjs build.
- `NSSavePanel.allowedFileTypes` is deprecated but is the only API that accepts Nod's undeclared
  `nodvault`/`jsonl` extensions; `allowedContentTypes` alone would silently allow every file.
- macOS only. Windows/Linux are out of scope for this phase; `createNative` reports unavailable.
