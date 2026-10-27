# Electrobun — the Nod's runtime

Electrobun replaced tinyjs in 0.8.0 and is the project's only desktop runtime. This file is the
house of the runtime facts the canon and the distribution guide cite. The old tinyjs notes stay in
`docs/tinyjs.md` as history (migration source, up to 0.7.0c).

## 1. What runs

| Fact | Value |
| --- | --- |
| Runtime | Electrobun 2.0.5 (`package.json`), paired Hutch 0.28.2 |
| Main process | Bun 1.4.4 (packaged by Hutch); the backend is `backend/main.ts`, unchanged |
| Page | the vite bundle in `dist/`, copied to `views/mainview`; one `BrowserView` per tool |
| Native engine | the system webview (WKWebView, WebView2, WebKitGTK). `bundleCEF: false` on all targets |
| App identity | `copland.nod` (the identity the tinyjs releases wore, so an update keeps data) |
| Dev identity | `copland.nod.eb-dev` (`bun run eb:dev`); never touches a release installation |

The app manifest is `app.json` (name, title, version, window size, URL scheme, popups, camera and
microphone usage strings). `electrobun.config.ts` is generated from it by
`scripts/gen-electrobun-config.ts` and is gitignored.

## 2. Targets

Hutch builds for the host OS/arch. The release workflow runs one leg per target:

| Target | Runner | Output |
| --- | --- | --- |
| macOS arm64 | `macos-15` | `Nod.app` zip + `stable-macos-arm64-update.json`/`.tar.zst` |
| macOS x86_64 | `macos-15-intel` | the same, `x64` |
| Linux x86_64 | `ubuntu-24.04` | installer `.tar.gz` + `stable-linux-x64-update.json`/`.tar.zst` |
| Linux arm64 | `ubuntu-24.04-arm` | the same, `arm64` |
| Windows x64 | `windows-2025` | installer `.zip` + `stable-win-x64-update.json`/`.tar.zst` |
| Windows arm64 | `windows-11-arm` | the same, `arm64` |

System floors: macOS 15+ (RNF-01; Hutch's own x64 build and `LSMinimumSystemVersion` say 14, the
project still supports 15+), Windows 10/11 with WebView2, Linux glibc 2.35+ with
`libwebkit2gtk-4.1-0`. Linux tray icons need an AppIndicator implementation
(`libayatana-appindicator3-1`); without one the app runs and closing the main window quits.

Electrobun 2.0.5 is the first release with a `macos-x64` core and Hutch artifact; 2.0.4 could build
only Apple silicon, which is why 0.7.0 kept tinyjs on Intel.

## 3. Build and dev

```sh
bun install
bun run eb:dev      # vite + electrobun dev, identifier copland.nod.eb-dev
bun run eb:build    # release build for the host OS/arch
bun run validate    # typecheck, unit tests, page build
bun run validate --smoke   # + the four real-surface smokes (Electrobun only)
```

`eb:build` is `scripts/eb-build.ts`: on macOS it compiles the native helper (`swiftc`, AppKit) and
writes the `.iconset`, then always builds the page, generates the config and runs
`electrobun build --env=stable`. On Windows/Linux the Swift and `sips` steps are skipped and the
PNG icon from `app.json`'s resolution is embedded as is. The macOS post-build repairs the camera and
microphone usage strings in the `.app` and in the payload tar, then ad-hoc signs the bundle
(`scripts/eb-postbuild.ts`, `scripts/eb-sign.ts`); Windows and Linux ship unsigned.

Artifacts land in `build/<env>-<os>-<arch>/` and `artifacts/`.

## 4. State

- **Backend data** stays in the legacy tinyjs layout — `~/Library/Application Support/copland.nod`
  (macOS), `%APPDATA%/copland.nod` (Windows), `$XDG_DATA_HOME/copland.nod` or
  `~/.local/share/copland.nod` (Linux) — so an installation updated from 0.6/0.7 keeps `nod.db`,
  `store.json` and icons (`electrobun/bun/facade/data-dir.ts`). A fresh install starts there too.
- **Website data** (cookies, local storage) is the runtime's partition (`persist:default`), separate
  from the tinyjs `WKWebsiteDataStore`; cookies do not carry over a migration
  (`docs/handovers/e07-migration.md` §1, §3).
- **Secrets**: the encrypted vault lives in `nod.db`; the only system-keychain item was the
  biometric key, and biometric unlock is off on Electrobun (`biometricUnlock: false`, 0.7.0 decision,
  `docs/handovers/e07-migration.md` §5). macOS keeps the native helper to delete legacy items;
  Windows/Linux have no keychain helper, and `app.secrets` reports unavailable. Password unlock is
  the only factor, on every target.

## 5. Windows, tabs and dialogs

- **Docked tabs are macOS only.** Docking and detaching re-parent a live view between windows, an
  AppKit operation the native helper performs. Electrobun 2.0.5 exposes no cross-platform re-parent,
  so Windows/Linux answer `canDock: false` in `win.getState()` and the backend keeps the **windows
  mode** (`docs/canonico.md` §7): one framed window per tool, opening an open tool focuses it, no
  reload. The tab strip stays empty there.
- **File dialogs**: macOS uses `NSOpenPanel`/`NSSavePanel` in the native helper. Windows/Linux use
  the runtime's native open chooser (`Utils.openFileDialog`); Electrobun has no save panel, so
  `dialog.saveFile` asks for a directory and writes the proposed name there (sanitised,
  de-duplicated) — `electrobun/bun/facade/dialogs.ts`.
- **Tray**: the runtime's `Tray` with the bundled `resources/tray.png` on Windows/Linux and an
  SF Symbol on macOS. `sf:`/`emoji:` specs fall back to `tray.png` where the native renderer is
  unavailable. A tray that cannot be created makes `app.tray.set` throw, so the backend keeps
  "closing main quits" instead of hiding the last window with no way back.

## 6. Updates

Two mechanisms, one release:

- **macOS** keeps `facade/update.ts`: it reads `manifest.json`, verifies the zip's sha256, extracts
  it with `ditto`, requires the bundle identity/version to match and swaps the `.app` with a
  rollback helper.
- **Windows/Linux** use Electrobun's `Updater` (`facade/update-runtime.ts`) over the runtime's
  `stable-<os>-<arch>-update.json` + `.tar.zst`, which Hutch writes and the release job uploads
  unchanged. The runtime owns the platform swap (scheduled helper on Windows, in-place on Linux).
  It has no signature; the transport is HTTPS and the archive carries the runtime's own metadata
  hash.

Both read the seed's `update.url`; the generated config's `release.baseUrl` is its directory
(`releaseBaseUrl`). An installation on 0.7.0c Windows/Linux runs tinyjs and cannot be swapped into
an Electrobun build automatically: 0.8.0 is a one-time reinstall there (the release notes say so).
macOS 0.6/0.7 updates itself from the same manifest, as it did on the 0.7.0 cutover.

## 7. Known limits (recorded, not hidden)

| Limit | Consequence |
| --- | --- |
| No code signing | macOS ad-hoc signs; Gatekeeper needs the release step (§3 of `docs/distribuicao.md`). Windows/Linux are unsigned. |
| No keychain helper on Windows/Linux | Biometric unlock is unavailable and legacy `nod.bio.*` items are not read or deleted. Credentials still work (sealed in `nod.db`). |
| No view re-parent on Windows/Linux | Tools open as windows, not tabs; detach/dock does not exist there. |
| No save panel in Electrobun 2.0.5 | Saving picks a directory, not a file name. |
| No update signature | The macOS path verifies sha256; the runtime path verifies the runtime's archive metadata. Neither authenticates the publisher. |
| Linux tray needs AppIndicator | Without it the app quits when the main window closes, by design (RF-15). |

## 8. Verification status

Executed on this machine (macOS 27 arm64, Bun 1.4.3, Electrobun 2.0.5, Hutch 0.28.2): `bun run
eb:build` produced `build/stable-macos-arm64/Nod.app` with valid ad-hoc signature, `eb:verify`
passed, and the four smokes passed on the Electrobun target — `run` 15/15 plus the KDF/seal vectors,
`ui` 8/8 stages (7 launches), `tabs` 20/20 with 0 blocked, and `connected` 14 phases / 114 steps.
`bun run validate` passed 4/4. Windows/Linux were not executed here; the release workflow builds them
on their own runners. Treat their first green release as the execution proof.
