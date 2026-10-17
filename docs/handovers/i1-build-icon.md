# Slice i1-build-icon — a build with a custom app icon (RF-56)

Authorized by the implementation-track coordinator's brief (slice, files and expected evidence
declared before the work started). Contract followed: `docs/arquitetura.md` §2 (origin gate) and §6
(build and dev); requirements: `docs/canonico.md` RF-56 (this slice) and RF-57 (documented here, built
by the host/app slices), §19. Owner's step by step: `docs/distribuicao.md` §9. Types: none touched
(`shared/`, `backend/`, `src/`, `host/` are other slices).

## Files touched

| File | What changed |
| --- | --- |
| `scripts/gen-config.ts` | New icon resolution (RF-56), pure and exported: `iconSource(envIcon, privateIconExists, defaultIconExists)` (precedence `NOD_ICON` > `resources/icon.png` > `assets/icon.png`), `iconConfigPath(source)` (the `icon` value, staging the env file), `assertIconPng(bytes, source)` (PNG header + IHDR, 1024×1024 minimum, path and size in the message) and the constants `DEFAULT_ICON`/`PRIVATE_ICON`/`STAGED_ICON`/`MIN_ICON_SIZE`. `generateConfig` gained the 6th parameter `icon: string \| null = null` and writes `config.icon` only when it is not `null`. The I/O half `iconForConfig(root)` runs in the `import.meta.main` block before `generateConfig`: reads `NOD_ICON`, stats the two project files, validates the bytes and copies an env PNG to `.nod-icon.png`. Header comment now cites RF-56 and the flow. |
| `test/gen-config.test.ts` | 6 new tests under `describe('app icon (RF-56)')` (13 → 19): precedence, the config path per source, `generateConfig` carrying the icon (and not carrying it without one), the tracked default passing the check, a real 32×32 PNG (`resources/tray.png`) refused with `32x32`/`1024x1024` in the message, and non-PNG bytes (JSON file, empty, truncated, right signature with a wrong first chunk) refused. |
| `.gitignore` | Two lines in the "Nod: privado ou gerado" block: `resources/icon.png` (the private icon) and `.nod-icon.png` (generated copy of a `NOD_ICON` file). |
| `.github/workflows/release.yml` | `restore private resources` reports which icon the release will wear (`resources/icon.png` from the secret, else the tracked default); `generate tinyjs.json` reads `"icon"` back from the generated file with `bun -e` (no new tool in the matrix) and **fails the build** when the secret carries `icon.png` and `tinyjs.json` says otherwise. Citation added to `docs/distribuicao.md` §9. |
| `docs/distribuicao.md` | New §9 "Custom builds (app icon)" (English, like everything from 2026-10-16 on): the three sources, the 1024×1024 PNG rule, the staging, "the app title stays Nod", and the CI secret. §1 points at §9 (entry icons vs. app icon); §7 lists the two new gitignored paths; §8 shows the `tar -czf - -C resources seed.json icon.png …` variant. |
| `docs/canonico.md` | §14: RF-56 and RF-57 rows with the acceptance text of the brief, after RF-55. §22: one `Decidido (2026-10-16)` row "Custom icons" with the owner's quote, after the "Internal rename to Nod" row. |
| `docs/handovers/i1-build-icon.md` | This file. |
| `package.json` | **Not touched.** The owner flow needed no script: `bun scripts/gen-config.ts build && tinyjs build` already resolves the icon on its own, and `NOD_ICON=… bun run app:build` passes the env through (proved by execution below). A new script would have been a knob with nothing behind it. |

## The mechanism, from the runtime (leitura)

tinyjs picks the app icon from a config key, **not** from a CLI flag, so the tracked
`assets/icon.png` never had to be staged aside:

| Fact | Where |
| --- | --- |
| `tinyjs.json` accepts `icon?` | `.agents/skills/tinyjs/SKILL.md:67` |
| Resolution is `cfg.icon` → else `assets/icon.png` → else a root `icon.png` | `~/.tinyjs/cli.js:831-834` |
| Every reader goes through `cfg.icon \|\| 'icon.png'` | `cli.js:2426` (macOS sips + iconutil → `AppIcon.icns`, 16…1024), `:2378` (Linux `dist/icon.png`), `:2357` (Windows `.exe`/`launcher.exe` embed), `:2148` (dev window via `TINYJS_ICON`) |
| No icon flag on the CLI: `tinyjs build` takes only `--dmg`, `--arch`, `--universal` (`--cli` for the shim) | `cli.js` usage block, `:3095-3110` |
| No icon env override either — the only `ENV_OVERRIDES` are `TINYJS_SIGN_IDENTITY` and `TINYJS_NOTARY_PROFILE` | `cli.js:772-775` |
| One PNG serves every OS, documented as 1024×1024 | `.agents/skills/tinyjs/SKILL.md:109-110`; `.agents/skills/tinyjs/references/release.md:22` |

That is also why a PNG given through `NOD_ICON` is **staged**: Windows builds the embedder path as
`cwd + '/' + winIcon` (`cli.js:2357`) and dev as `cwd + '/' + iconSrc` (`cli.js:2149`), so only sips
takes a path outside the project. Staging it as `.nod-icon.png` keeps every OS correct without ever
writing a tracked file.

## Acceptance criterion, item by item

| Item (RF-56 / brief) | Evidence | How |
| --- | --- | --- |
| `resources/icon.png` used as the build icon | real build A: `==> generating icon from resources/icon.png`, generated `tinyjs.json` had `"icon": "resources/icon.png"`, `dist/Nod.app/Contents/Resources/AppIcon.icns` **c056f36e…**, different from the default-icon build **7aecb306…** | `execucao` |
| `NOD_ICON=/path/to.png` used as the build icon | real build B, with `resources/icon.png` still in place: generated config `"icon": ".nod-icon.png"`, `==> generating icon from .nod-icon.png`, staged `.nod-icon.png` sha256 **7ef0e4df…** = the source file's, and the same `AppIcon.icns` **c056f36e…** as build A (same source bytes) | `execucao` |
| Without either, the repo's `assets/icon.png` | `bun scripts/gen-config.ts build` with no `resources/icon.png` and no `NOD_ICON` → `"icon": "assets/icon.png"`; tinyjs then reads the tracked file (build baseline log `==> generating icon from assets/icon.png`) | `execucao` |
| The tracked `assets/icon.png` is never modified | `git status --porcelain` in every step above: `assets/icon.png` never appears; no write path touches it (`iconForConfig` only reads it) | `execucao` + `leitura` |
| `git status` stays clean with a private icon in place | with a real `resources/icon.png` present, `git status --porcelain` did not list it and `git check-ignore -v` → `.gitignore:28:resources/icon.png`; same for `.nod-icon.png` (`.gitignore:29`) | `execucao` |
| PNG signature validated, clear error | `NOD_ICON=tinyjs.base.json bun scripts/gen-config.ts build` → `tinyjs.base.json is not a PNG: the app icon must be a PNG file (RF-56)`, exit 1 | `execucao` |
| Minimum size validated, clear error | `cp resources/tray.png resources/icon.png; bun scripts/gen-config.ts build` → `resources/icon.png is 32x32: the app icon must be at least 1024x1024 (tinyjs builds the macOS .icns up to that size, so a smaller image only ships upscaled)`, exit 1 | `execucao` |
| Missing file reported, not ignored | `NOD_ICON=/tmp/nope.png bun scripts/gen-config.ts build` → `icon file not found: /tmp/nope.png`, exit 1 | `execucao` |
| Precedence and the check are proven by tests | `bun test test/gen-config.test.ts` → **19 pass, 0 fail**, 50 `expect()` calls; the 6 new ones cover `iconSource` (all four outcomes), `iconConfigPath`, `generateConfig` (`icon` set / key absent when `null`) and `assertIconPng` against real files (`assets/icon.png` accepted, `resources/tray.png` refused, JSON/empty/truncated/wrong-chunk bytes refused) | `execucao` |
| CI uses the icon from the secret tarball | workflow prints `app icon: …` after restoring and fails when `resources/icon.png` is present but `tinyjs.json` disagrees; the secret command in `docs/distribuicao.md` §8 now shows `icon.png` in the archive | `leitura` (workflow not runnable here) |
| RF-57 documented where the requirement lives | `docs/canonico.md` §14 RF-57 row + §22 "Custom icons" row (`Decidido (2026-10-16)`, owner quote) | `leitura` |
| Owner's docs | `docs/distribuicao.md` §9 (sources, size rule, staging, "the app title stays Nod", CI), §1 pointer, §7 list, §8 command | `leitura` |

## Commands and observed output

- `bun test test/gen-config.test.ts` → `19 pass / 0 fail, 50 expect() calls` (13 tests before).
- **Baseline (default icon), before any change of mine:** while checking whether `tinyjs build` had
  an icon flag, `tinyjs build --help` ran a real build instead of printing help (the CLI has no help
  for it). It printed `==> generating icon from assets/icon.png` and left `dist/` behind; I used it
  as the baseline and deleted `dist/` afterwards. `AppIcon.icns` = `7aecb306f9c1…`.
- **Throwaway icon:** `sips -z 1024 1024 resources/tray.png --out /tmp/nod-icon-1024.png` →
  `pixelWidth 1024`, `pixelHeight 1024`, `format png`, sha256 `7ef0e4df…` (real PNG, visibly not the
  Nod icon). `/tmp/nod-icon-1024.png` was deleted in the cleanup.
- **Build A — private icon:** `cp /tmp/nod-icon-1024.png resources/icon.png` then
  `bun run app:build` → `==> generating icon from resources/icon.png` … `==> done`;
  `shasum -a 256 dist/Nod.app/Contents/Resources/AppIcon.icns` → `c056f36e…`;
  `sips -g pixelWidth -g pixelHeight …/AppIcon.icns` → `1024`, `1024`.
- **Build B — `NOD_ICON`:** `NOD_ICON=/tmp/nod-icon-1024.png bun run app:build` (with
  `resources/icon.png` still there) → `==> generating icon from .nod-icon.png` … `==> done`;
  `shasum -a 256 .nod-icon.png /tmp/nod-icon-1024.png` → both `7ef0e4df…`;
  `shasum -a 256 dist/Nod.app/Contents/Resources/AppIcon.icns` → `c056f36e…` (identical: the two
  sources are the same bytes, so both flows reach the same shipped icon); generated `tinyjs.json`
  `"icon"` = `.nod-icon.png`.
- **Error paths:** the four commands in the table above (`exit=1` each, messages as quoted).
- **Restore:** `rm -rf dist .nod-icon.png /tmp/nod-icon-1024.png resources/icon.png` then
  `bun scripts/gen-config.ts dev` → `tinyjs.json` back to dev, `"icon": "assets/icon.png"`,
  `"id": "copland.nod"`, dev origin 5173. Final `git status --porcelain` shows only the tracked edits
  of this slice (plus the other slices' files); no `dist/`, no staged icon.

## What could not be done, and why

- **RF-57's app side is not here** — host routes, `Snapshot.guildIcon`, the fetch-and-verify step,
  `app.icon(pngPath)` and the Settings choice belong to the host/app slices. This slice only writes
  the requirement down and keeps the icon sources separate: the release icon is a **build input**
  (`resources/` list of the release does not include it) while the guild icon arrives at runtime from
  the host, so the two never collide in the packaged app.
- **No build for Windows or Linux.** Their icon steps are read from the CLI (`cli.js:2357`, `:2378`),
  not observed: this machine is macOS and the CI workflow is not runnable here.
- **No project gates run** (typecheck, `bun test test/`, smoke, formatters) — the phase contract
  allows only `bun test` on this slice's test file and one real `bun run app:build`; I ran two builds
  to compare the before/after icon, both deleted afterwards.

## What other owners must align

- **`docs/arquitetura.md` §6 (coordinator)**: it lists what `gen-config.ts` reads and writes; it
  should now mention the icon (`NOD_ICON`, `resources/icon.png`, the `icon` key) and `docs/distribuicao.md`
  §9 as the owner's house of the step by step. The file is not mine.
- **`shared/host-merge.ts`**: mid-flight it failed `tsc` because `Snapshot.guildIcon` became
  required (`error TS2741` at line ~182) while its owner had not set it; that blocked my first build.
  The owner landed it minutes later and both builds then went through — nothing left for me, but the
  pairing is worth remembering: **changing `Snapshot` in `shared/host-api.ts` breaks every snapshot
  literal in the same commit.**
- **CI / release**: `NOD_PRIVATE_RESOURCES` must carry `resources/icon.png` for a custom-icon
  release (§8, §9). The workflow now refuses a release that would wear a different icon than the one
  in the secret.

## Where the evidence lands in the front's handover

This file is the slice's evidence: `scripts/gen-config.ts`, `test/gen-config.test.ts` (19 tests),
`.gitignore`, `.github/workflows/release.yml`, the `docs/distribuicao.md` and `docs/canonico.md`
sections, and the two builds above. The coordinator/reviewer confirms with
`bun test test/gen-config.test.ts`, the repo gates, and — to see the artifact — a
`bun run app:build` with and without `resources/icon.png`, comparing the shipped
`AppIcon.icns`/`dist/icon.png`.
