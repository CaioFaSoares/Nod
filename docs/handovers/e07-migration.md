# E07 — tinyjs → Electrobun migration (0.6.0c → 0.7.0, macOS)

Written 2026-10-23. Everything below is `execução` on this machine unless marked `leitura`.
Throwaway identifier `copland.nod.mig` (`copland.nod.mig2` for the canary, `copland.nod.mig3` for the
keychain-only control). The owner's `~/Library/Application Support/copland.nod`, its keychain items,
`/Applications/Nod.app` and its cookies were not modified. `resources/seed.json` was never touched
(299 B before and after); the builds ran from rsync copies under `/tmp/nod-mig/`.

## 1. Where each runtime keeps state (leitura + execução)

| Fact | tinyjs 0.6.0c | Electrobun 0.7.0 |
| --- | --- | --- |
| Backend data (`nod.db`, `store.json`, `guild-icon.png`, `icons/`) | `~/Library/Application Support/<id>` (`~/.tinyjs/runtime/bridge.js:1084`; `paths().data` at `:2407`) | `Utils.paths.userData` = `~/Library/Application Support/<identifier>/<install-root>` (`.hutch/devkit/api/sdks/main/core/Utils.ts:696-700`) — `stable` for a packaged build |
| Keychain item | generic password, service `<App id>`, account `<key>` (`bridge.js:2152-2172`; `SECRET` op of the compiled launcher). Measured: service `copland.nod.mig`, account `nod.bio.<person>`. | generic password, service = bundle identifier (default, `electrobun/native/NodNative.swift:47,151-157`), account = key (`facade/native.ts:395-455`). Same naming as tinyjs. |
| Relaunch after install | `app.update.install()` → `installUpdate` → `relaunch()` = `tjs.spawn(['open','-n',bundle])`, then `app.quit()` 250 ms later (`~/.tinyjs/runtime/bridge.js:2586-2592`; `update.js:524-532`) | own swap helper waits for exit, `mv` staged bundle into place, `open "$app"` (`electrobun/bun/facade/update.ts` `SWAP_HELPER`) |
| Website data (cookies) | default `WKWebsiteDataStore` → `~/Library/WebKit/<bundle-id>/WebsiteData` plus `~/Library/HTTPStorages/<bundle-id>.binarycookies` | `persist:default` partition → `~/Library/WebKit/<bundle-id>/WebsiteDataStore/<uuid>/{Cookies,…}` (`Session.fromPartition`, `facade/downloads.ts:46-47`). Separate cookie jar. |

The keychain and data facts were re-measured after the swap: `lsof` on the Electrobun process showed
`.../Application Support/copland.nod.mig/nod.db`; `security dump-keychain` showed the item as
`svce=copland.nod.mig`, `acct=nod.bio.<person>`.

## 2. Builds measured

- tinyjs: `NOD_APP_ID=copland.nod.mig bun run app:build` (version 0.6.0c from `tinyjs.base.json`) →
  `dist/Nod.app`, `CFBundleIdentifier copland.nod.mig`, `codesign --verify --strict --deep` OK.
- Electrobun: `NOD_APP_ID=copland.nod.mig bun run eb:build` with `version 0.7.0` →
  `build/stable-macos-arm64/Nod.app`, `CFBundleIdentifier copland.nod.mig`.
- **Before the fix the Electrobun bundle failed the tinyjs updater's check**:
  `codesign --verify --strict --deep` → `code has no resources but signature indicates they must be
  present`, `Identifier=extractor`, `Info.plist=not bound`. Cause: hutch signs the wrapper, then
  `scripts/eb-postwrap.ts` / `eb-postbuild.ts` patch `Info.plist`. An ad-hoc re-sign as the last
  step fixes it: `codesign --force --deep --sign -` → `Signed Resources version=2`, verify exit 0.
- Update archive: `ditto -c -k --keepParent` → 26 MB. Extracted copy verifies with the same flags.
  sha256 of the final archive: `b86e8706670ac51f9dac013d480041c1f4056bf543021788870be482bea7e66b`.
- The manifest served to the tinyjs app was tinyjs-format
  `{version:"0.7.0", notes, mac:{arm64:{url:"http://127.0.0.1:47831/…zip", sha256}}}` (HTTP loopback
  is accepted by `update.js` `assertSafeUrl` and by `shared/catalog.ts` `parseAddress`).

## 3. End-to-end run (tinyjs app drives the install, Electrobun app boots in its place)

Steps driven by a page script in the throwaway build: create the local account, set the `appIcon`
preference, `session.enableBiometric` (writes the tinyjs keychain item), `tools.open` on a local fake
tool that sets a cookie, then `nod.installUpdate`.

- **Swap**: `update.install` returned true; the zip's sha256 and `codesign --verify` passed; the
  bundle was replaced and `open -n` launched the Electrobun build **from the same path**. `ps` showed
  `Contents/MacOS/bun …/Resources/main.js`, version 0.7.0.
- **Data (after fix)**: `session.unlock` with the same email/password succeeded, same person row;
  `store.json` `appIcon` and `biometric_people` present; `guild-icon.png` unchanged
  (`sha256 15d962bf889719a4622b2c62311ead5009c44ad3308e4cd6f4bc9a9a977d5bd6`). `lsof` confirmed the
  Electrobun process had `…/Application Support/copland.nod.mig/nod.db` open.
- **Cookies**: **do not carry over.** The tinyjs tool window wrote `mig=1` for
  `http://127.0.0.1:47831` (server saw `had=0` then the cookie); after the swap the same tool URL
  from the Electrobun window answered `had=0` again. The jars are the two different paths in §1.
  Not copied by hand (owner's rule).
- **Keychain item**: the Electrobun app read `nod.bio.<person>` from service `copland.nod.mig`
  (`readable: true`), no prompt observed (no `SecurityAgent` during the read).
- **`nod://`**: on this machine `open nod://…` still launched `/Applications/Nod.app` (the real
  tinyjs install), not the swapped copy in `/tmp`, because LaunchServices prefers the copy in
  `/Applications`. On a real user machine the swapped bundle *is* `/Applications/Nod.app`, so the
  scheme stays with it; this spike could not prove that without touching `/Applications`.

### What was missing before the fixes

Two independent bugs made the swap install a stranger's app data:

1. `electrobun/bun/index.ts` used `<Utils.userData>` (`…/<id>/stable`) for the backend, so the
   updated app showed **“Set up Nod on this machine”** while the tinyjs account sat one directory
   above (`nod.db`, `store.json`, `guild-icon.png` untouched).
2. The same file defaulted the identifier to `copland.nod.eb` when `NOD_APP_ID` was absent —
   which is always true when LaunchServices relaunches the app — so the fixed data path would still
   have been `~/Library/Application Support/copland.nod.eb`. Measured: the swapped app opened
   `copland.nod.eb/nod.db` (`lsof`) and showed the setup screen.

## 4. Fixes in the repository

- `electrobun/bun/facade/data-dir.ts` (new): `tinyjsDataDir()` mirrors `bridge.js`; `resolveDataDir()`
  uses the tinyjs directory when it holds `nod.db`/`store.json`, keeps an Electrobun-only directory
  when the tinyjs one is empty, and otherwise starts in the tinyjs layout.
  `bundledIdentifier()` reads `Resources/version.json` beside the executable.
- `electrobun/bun/index.ts`: identifier = `NOD_APP_ID`, else `Resources/version.json`, else
  `copland.nod.eb`; backend `paths().data` and the update facade's `dataDir` use the resolved
  directory. `copland.nod` is refused only for a dev channel.
- `scripts/gen-electrobun-config.ts`: `appIdentifier(value, mode)` accepts `copland.nod` for
  `build` only; `dev` still refuses it.
- `scripts/eb-sign.ts` (new): signs every `build/stable-macos-*/Nod.app` ad hoc and verifies it with
  `codesign --verify --strict --deep`; wired as the last step of `eb:build` in `package.json`.
- Tests: `test/electrobun-migration.test.ts` (data-dir layout, precedence, `bundledIdentifier`) and
  the identifier case in `test/gen-electrobun-config.test.ts`. Final `bun test` on both files: 33
  pass; `npx tsc -p electrobun/tsconfig.json --noEmit` exit 0.

## 5. Security observation (recorded, not fixed)

`security dump-keychain -a` for the migrated item (`copland.nod.mig`, `nod.bio.<person>`):

```
access: 5 entries
 entry 0: encrypt …
 entry 1: decrypt derive export_clear export_wrapped mac sign
   applications (3):
     0: /usr/bin/security (OK)        identifier "com.apple.security" and anchor apple
     1: …/Nod.app/Contents/MacOS/bun (OK)  identifier bun, anchor apple, OU 7FRXF46ZSN
     2: …/Nod.app (status …)          cdhash H"08b89349…"   ← the tinyjs bundle that wrote it
```

The Electrobun runtime's `Contents/MacOS/bun` is signed with Bun's real Developer ID
(`TeamIdentifier=7FRXF46ZSN`). A second Electrobun canary (`copland.nod.mig2`, same bun binary,
different bundle path/id) reading the **same service/account** returned `readable: true` with no
`SecurityAgent` prompt observed. A pure tinyjs item (`copland.nod.mig3`, untouched by Electrobun)
trusts only the writer's **cdhash** (`applications (1): …/Nod.app, requirement cdhash H"c29f36…"`),
so another tinyjs build (different ad-hoc cdhash) is a different identity. Conclusion: the ACL is
only as strong as the writer's identity; the ad-hoc tinyjs bundle gets a cdhash, while the
Developer-ID-signed `bun` gets a stable team identity that every Electrobun build shares. No code
change was made (owner decision pending); a future fix would be a keychain item written with an
explicit access control list or a real Developer ID for the outer bundle.

## 6. Verification run and cleanup

- `bun test test/electrobun-migration.test.ts test/gen-electrobun-config.test.ts` and
  `npx tsc -p electrobun/tsconfig.json --noEmit`: see the final agent report.
- Reproduced twice after the fix (runs at 18:27 and 18:29 UTC): both unlocked the same account and
  opened the tool; cookies stayed absent in both.
- Removed: the throwaway app data (`copland.nod.mig`, `.mig2`, `.mig3`), their `/tmp` build trees,
  the keychain items, the WebKit/HTTPStorages entries, the local server, and the screenshots.
  `resources/seed.json` is still 299 B.
