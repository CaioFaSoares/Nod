# Distribuição do Nod

Como montar, publicar e liberar uma release do Nod. O **porquê** e as decisões do dono estão em
`docs/canonico.md` §19; os fatos do runtime, em `docs/tinyjs.md` §1 e §8. Aqui só o passo a passo.

## 1. Montar o seed privado

O seed carrega catálogo, papéis, convites (só os hashes) e o endereço de atualização. Ele **não entra
no git** e **não carrega segredo** nenhum (`docs/canonico.md` §19, RF-27). As chaves são em inglês
(`version`, `generatedAt`, `roles`, `entries`, `invites`, `update`), como o modelo em
`shared/types.ts` e o exemplo versionado `resources/seed.example.json`.

Duas origens para o arquivo:

- copiar `resources/seed.example.json` para `resources/seed.json` e preencher à mão; ou
- usar o **export seed** de **Settings → Catalog** numa instalação já configurada (RF-13): o arquivo
  sai pelo diálogo do sistema e vai para `resources/seed.json`. O caminho de volta, **importar seed**
  na mesma tela (modo `merge` ou `overwrite`), serve para aplicar um seed novo sem recompilar.

Os ícones referenciados pelas entradas ficam em `resources/` (caminho relativo, sem `..`); o
`scripts/gen-config.ts` os lista no `tinyjs.json` e o build os empacota junto com o seed e com o
`tray.png`, o ícone da bandeja no Linux. O **ícone do app** (o do Dock/taskbar, outro assunto) tem
a sua própria seção: §9.

**From 0.5.0 o seed é opcional** (RF-61, `docs/canonico.md` §22 "Seed as optional import"): uma
release pode sair sem `resources/seed.json`, e o app sai vazio; o tile Offline do primeiro uso
oferece "Import a seed file" (`session.importSeed`) enquanto não houver conta. O gate de origins,
camera/mic e a URL de atualização continuam vindo só de um seed embutido — uma release sem seed não
tem esses extras.

## 2. Gerar o artefato

```
bun install
bun run app:build
```

`app:build` roda `scripts/gen-config.ts build` (grava `tinyjs.json` com o gate de origin das
entradas e a lista `resources`) e em seguida `tinyjs build`. Desde 0.5.0 o build **não exige** mais
`resources/seed.json` (RF-61): sem ele o `tinyjs.json` sai válido, sem `seed.json` na lista
`resources`, e o app instalado abre vazio; com um seed que não valida, falha com
`invalid seed: <motivo>`. O `tinyjs.json` é gerado e **gitignored**: o gate de origins sai do seed e
não pode vazar.

No desenvolvimento do app a partir do código (`bun run app:dev`), **não** rode com `TINYJS_DEBUG=1`
usando credenciais reais: o trace do runtime imprime o EVAL do adaptador de login e cada chamada de
API. A lista do que não pode está em `AGENTS.md`.

O artefato sai em `dist/`, por sistema (`docs/tinyjs.md` §8):

- **macOS**: binário + `Nod.app` codesigned em modo ad-hoc (`--dmg` para o instalador,
  `--arch`/`--universal` para as CPUs).
- **Windows**: pasta `dist/` portátil.
- **Linux**: pasta portátil, empacotada como tarball por arquitetura.

## 3. Liberar no macOS

Ad-hoc só roda na máquina que construiu; nas outras o Gatekeeper bloqueia. Decisão do dono em
`docs/canonico.md` §19: o passo de liberação é aceitável, feito à mão por quem recebe.

Na máquina de destino, com o `Nod.app` em `/Applications`:

1. abrir **Ajustes do Sistema → Privacidade e Segurança**;
2. na seção de segurança, clicar em **Abrir assim mesmo** para o Nod (no macOS 15+ o atalho de
   right-click não funciona mais); ou, no terminal,
3. `xattr -d com.apple.quarantine /Applications/Nod.app`.

**Move it to `/Applications` before the first launch, and always launch it from there.** A
quarantined app opened from Downloads or straight from the `.dmg` runs from a new random path on
every launch (macOS "App Translocation", `/private/var/folders/…/AppTranslocation/<UUID>/d/Nod.app`),
and the keychain treats each of those paths as a different app: the Touch ID item (`nod.bio.*`, RF-63)
asks for the login password again every time. Seen on 2026-10-17 in the item's access list, which
named `Nod 2.app`, `Nod 3.app` and `Nod 4.app` under three translocation folders. Clearing the
quarantine (step 3) on the copy in `/Applications` is what stops it; an update installed by the app
itself is not quarantined. One prompt per new unsigned build remains until releases are signed with a
fixed certificate (`signIdentity`/`TINYJS_SIGN_IDENTITY`).

Distribuição sem esse passo exige **Developer ID Application + notarização** (Apple Developer
Program) — melhoria opcional, ver `docs/canonico.md` §19.

## 4. Windows e Linux

Não há estratégia de assinatura documentada pelo runtime. O caminho é a **pasta portátil** do build
(Windows) e o **tarball por arquitetura** (Linux); no Linux o `.desktop` se registra na primeira
execução. Requisitos de sistema por SO (macOS 15+, Windows 10/11 com WebView2, Linux glibc 2.35+ com
`webkit2gtk-4.1`): `docs/tinyjs.md` §1.

**Bandeja** (`docs/canonico.md` §7): o ícone do Linux é o `resources/tray.png` empacotado; lá a
bandeja depende de um **AppIndicator** instalado no ambiente (`libayatana-appindicator`). Com
bandeja, fechar a janela principal apenas a **esconde** — as janelas de ferramenta continuam abertas
e o menu da bandeja traz `Open Nod`, `Lock` e `Quit Nod`. Sem bandeja (Linux sem AppIndicator),
fechar a janela principal **encerra** o Nod.

## 5. Convites entre máquinas

Sem host, o convite viaja pelo seed (`docs/canonico.md` §9):

1. o administrador **emite o convite** em **Settings → People** — o código aparece uma única vez;
2. **export seed** em **Settings → Catalog** (RF-13) já leva o hash do convite;
3. esse seed entra na **próxima release**;
4. na máquina da pessoa, o app aceita o código cujo hash está no seed (uso único por máquina).

## 6. Atualização

Com `update.url` no seed, o `scripts/gen-config.ts` grava
`"update": { "url": …, "auto": "daily" }` no `tinyjs.json`. O `tinyjs publish` gera o zip e o
`manifest.json` (versão, url, **sha256**, notas) — `docs/tinyjs.md` §8. O manifesto é hospedado onde
o dono quiser; o app verifica checksum e assinatura antes de trocar a release.

From 0.7.0 macOS does not ship the tinyjs build: the same `manifest.json` carries the Electrobun
`Nod.app` zips, and both runtimes read it the same way (§8 "How an installed Nod updates", §10).

## 7. O que nunca vai para o git

- `resources/seed.json` — o seed privado;
- `resources/icon.png` — o ícone privado de uma build customizada (RF-56, §9);
- `.nod-icon.png` — cópia gerada de um ícone dado por `NOD_ICON` (§9);
- `.eb-icon.iconset/` — the macOS icon set `scripts/eb-icon.ts` renders from that same icon (§10);
- `tinyjs.json` — gerado, e o gate de origins sai do seed;
- `resources/build-mode` — written by `scripts/gen-config.ts` with the mode it ran in (`dev`/`build`);
  it is the stamp `backend/main.ts` reads to tell a dev run from a release (SP02 §9), and it is **not**
  in the release's `"resources"` list, so a built app never carries one.

Todos já estão no `.gitignore`. O versionado no lugar deles é só `resources/seed.example.json`, com
dados falsos (e o ícone versionado é o `assets/icon.png`).

## 8. Automated release (GitHub Actions)

`.github/workflows/release.yml` builds and publishes on every push to a branch named `release-*`
(and on demand with "Run workflow").

**From 0.5.0 the branch is created for you.** `.github/workflows/release-branch.yml` runs when a
pull request from `dev` is merged into `main`: it reads `version` from `tinyjs.base.json`, pushes
`release-<version>` at the merge commit and dispatches `release.yml` on it (a branch pushed with
`GITHUB_TOKEN` does not start the `push` trigger by itself, GitHub's rule against loops). If
`release-<version>` already exists the job fails on purpose: the version was not bumped, and
republishing the same version is a decision for a person (push the branch by hand).

The release text is the body of the `Release <version>:` commit (found by `git log --grep`, with
GitHub's `Merge pull request #…` header removed); it is what an installed Nod shows in the update
notice. Write it as patch notes for the people using Nod.

1. **Check** (`prepare`, ubuntu): reads `version` from `tinyjs.base.json`. A branch named
   `release-X.Y.Z` must match it; other `release-*` names skip this check. Then
   `bun run typecheck:app` and `bun test test/`. The full `bun run typecheck` also checks the
   Electrobun project, which needs the Hutch devkit projected; under CI (`CI=true`) it refuses
   instead of skipping, so it runs on the macOS legs right after `eb:build` has projected the
   devkit — never on a machine that has no devkit at all.
2. **Build**, one job per target, with tinyjs and bun pinned (`TINYJS_VERSION`, `BUN_VERSION` at the
   top of the workflow):

   | Target | Runner | Runtime | Output |
   | --- | --- | --- | --- |
   | macOS arm64 | `macos-15` | Electrobun | `nod-<v>-macos-arm64.zip` |
   | macOS x86_64 (Intel) | `macos-15` | tinyjs | `nod-<v>-macos-x86_64.zip` |
   | Linux x86_64 | `ubuntu-24.04` | tinyjs | `nod-<v>-linux-x86_64.tar.gz` |
   | Linux arm64 | `ubuntu-24.04-arm` | tinyjs | `nod-<v>-linux-arm64.tar.gz` |
   | Windows | `windows-2025` | tinyjs | `nod-<v>-win.zip` |

   The Apple silicon leg never runs `tinyjs publish`. It restores the private resources, refuses
   a build that would wear the wrong icon (§9), runs `NOD_APP_ID=copland.nod bun run eb:build` (which
   ends by re-signing the bundle ad hoc, §10), `bun run typecheck` (the Electrobun project, now that
   the devkit exists), `bun run eb:verify`, fails the job when `codesign --verify --strict --deep`
   rejects the bundle, and finally `bun scripts/eb-publish.ts build`: the `Nod.app` zipped with
   `ditto -c -k --keepParent` under the name `tinyjs publish` uses for the same architecture, its
   **sha256**, and the `mac.arm64` half of the manifest (§10). Intel Macs stay on tinyjs
   (`tinyjs publish --arch x86_64`): Electrobun 2.0.4 publishes no `darwin-x64` core or Hutch (the
   assets of its v2.0.4 release; the first 0.7.0 run failed with "release manifest is incomplete
   for macos-x64"). The Linux and Windows legs are the tinyjs publish they always were.

3. **Release**: merges the halves into the one `manifest.json` — `mac.arm64` from the Electrobun
   leg, `mac.x86_64`, `linux.<arch>` and `win` from the tinyjs ones — sets the top-level `url`/
   `sha256` to the arm64 zip (all a reader from before the `mac` block looks at), refuses a
   disagreement on `version` or a missing macOS architecture, and then creates release
   `release-<version>` — the `prepare` job prints the tag, the prefix included (`docs/canonico.md`
   §19) — with every archive and the merged manifest, marked as latest.

### How an installed Nod updates

One file, one address: `<release>/download/manifest.json`, which is the seed's `update.url`
(`https://github.com/CaioFaSoares/Nod/releases/latest/download/manifest.json`). Who reads what:

- **tinyjs readers** — every Nod on 0.6.0c or older, and every Windows/Linux Nod today: `win`,
  `linux.<arch>`, `mac.<arch>`, and the top-level `url`/`sha256` when the reader predates the
  blocks (`~/.tinyjs/runtime/update.js` `checkForUpdate`/`installUpdate`).
- **the Electrobun target** (§10): the same address and the same file. It reads `version`, `notes`
  and `mac.<arch>` and ignores the rest (`electrobun/bun/facade/update.ts`).

**A 0.6.0c Mac becomes an Electrobun Nod.** That build runs the tinyjs runtime, and from 0.7.0 the
macOS entries of the manifest point at a zip of the **Electrobun** `Nod.app`. Its daily check finds a
newer version, takes `mac.<arch>` (the tinyjs runtime probes the hardware, so a Rosetta install
still gets the native arm64 build), downloads the zip, verifies the sha256, extracts it with `ditto`,
requires `codesign --verify --strict --deep` to pass and swaps the single `.app` into place — which
is why the release job fails when that check fails on the runner. The identifier of the Electrobun
build is `copland.nod`, the same one the tinyjs releases wear, so the app data directory, the
keychain namespace and the URL scheme carry over. From the next launch, `install()`/`check()` are the
Electrobun facade's. **Windows and Linux stay tinyjs** and keep updating exactly as before.

**One-time setup:**

- Secret `NOD_PRIVATE_RESOURCES`: the private files of `resources/` (§1, §7) as base64 of a
  tar.gz, with paths relative to `resources/`. With `seed.json` plus any icons it references:

  ```
  tar -czf - -C resources seed.json icons | base64 | gh secret set NOD_PRIVATE_RESOURCES
  ```

  A custom app icon rides in the same secret (RF-56, §9) — add `resources/icon.png` to the archive
  and the release wears it, no other step:

  ```
  tar -czf - -C resources seed.json icon.png | base64 | gh secret set NOD_PRIVATE_RESOURCES
  ```

  GitHub caps a secret at 48 KB. If the icons don't fit, put them in the seed as data URIs.
- Auto-update from GitHub Releases: the seed's `update.url` must be
  `https://github.com/CaioFaSoares/Nod/releases/latest/download/manifest.json`. Every macOS entry is
  derived from that address by `scripts/eb-publish.ts` and every Windows/Linux entry by `tinyjs
  publish`; the release job warns when they don't point at the release repository. With the channel
  set, an installed Nod that finds a newer release shows the notice by itself (RF-55,
  `docs/canonico.md` §14): no step in the app and no release by hand.

**Caveats:**

- **Version bump.** Pushing again with the same `version` replaces the release's files. Installed
  apps only update when `version` in `tinyjs.base.json` goes up.
- **Hotfix versions (0.5.5a).** A hotfix keeps the release's three numbers and adds lowercase
  letters right after the patch: `0.5.5a`, then `0.5.5b`, `…z`, `aa`. The order is `0.5.5` <
  `0.5.5a` < `0.5.5b` < `0.5.6` (`shared/version.ts`). The release gate accepts the form, and the
  branch, tag and notes commit carry it as is: `release-0.5.5a`, `Release 0.5.5a: …`. The tinyjs
  runtime's own update check reads only the three numbers, so it would never offer `0.5.5a` to a
  Nod on `0.5.5`; the backend decides the offer with `shared/version.ts` instead
  (`backend/main.ts` `withHotfixes`), and the install itself does not compare versions. The same
  form is a valid `NOD_MIN_APP_VERSION` on the host (SP07 §2). macOS shows the letters in the
  bundle's version string as written.
  - **A build older than 0.5.5a never sees a letter.** `withHotfixes` ships inside the app, so a
    Nod on `0.5.5` or older only has the runtime's three-number check (`update.js` `parseVer`)
    and reads `0.5.5a`, `0.5.5b`… as `0.5.5`. A fix those installs must receive automatically
    goes out as a patch bump instead — that is why 0.5.6 exists (`docs/canonico.md` §22).
- **Public repository: auto-update works.** The repository is public, so release files download
  without authentication and an installed Nod fetches its manifest and its archives straight from
  GitHub Releases. The release repository is this one — `RELEASE_REPO` already defaults to
  `github.repository`. `NOD_RELEASE_REPO` plus a `NOD_RELEASE_TOKEN` with `contents: write` are
  only for putting the release in *another* repository, which then has to be public too.
- **Public repository: the seed becomes public.** Every archive carries the seed (§1): addresses,
  roles, grants and invite hashes. With a public repository anyone who downloads a release reads
  them, not just the people who received it. `docs/canonico.md` §19 accepts that; what keeps it
  acceptable is RF-27 — the seed carries organization, never a password, a credential or a token.
- **Unsigned.** macOS builds (tinyjs and Electrobun alike) are signed ad hoc, so the release step in
  §3 still applies. Windows builds are unsigned (§4).
- **macOS runner cost.** On a private repository, macOS runner minutes cost more than Linux ones
  (`https://docs.github.com/en/billing/reference/actions-runner-pricing`).

## 9. Custom builds (app icon)

Written in English, like everything from 2026-10-16 on; the rest of this file is the pt-BR text of
before. Requirement: RF-56 (`docs/canonico.md` §14).

A release wears the tracked `assets/icon.png` — 1024×1024, the size tinyjs documents
(`.agents/skills/tinyjs/SKILL.md` §"Project layout"). A custom build wears another icon without
editing one tracked file:

| Source | How |
| --- | --- |
| `resources/icon.png` | drop the PNG there; private and gitignored, like the seed — this is the flow to keep |
| `NOD_ICON=/path/to.png` | `NOD_ICON=/path/to.png bun run app:build`; a one-off, the file stays where it is |
| neither | `assets/icon.png`, exactly as before |

`scripts/gen-config.ts` resolves the source in that order (`NOD_ICON` wins, then
`resources/icon.png`, then `assets/icon.png`) and writes the winner into the generated `tinyjs.json`
`"icon"` key — the key tinyjs reads instead of its own default (`cfg.icon || 'icon.png'`). One PNG
serves every OS: sips turns it into the macOS `.icns` (16…1024), Linux copies it to
`dist/icon.png` and Windows embeds it (`~/.tinyjs/cli.js`, `tinyjs build`; release facts in
`.agents/skills/tinyjs/references/release.md`).

- The file must be a PNG of at least 1024×1024. Anything else fails the build with the path and the
  real size in the message (`scripts/gen-config.ts`, `assertIconPng`) — a smaller image would only
  ship upscaled, and a non-PNG would fall back to the default icon silently.
- A PNG passed through `NOD_ICON` is copied to `.nod-icon.png` (generated, gitignored) because
  tinyjs resolves `icon` from the project root and hands that same path to sips, to
  `dist/icon.png` and to the Windows icon embedder. The tracked `assets/icon.png` is never written,
  so `git status` stays clean either way.
- `bun run app:dev` wears the same icon in the dev window; the seeded `resources/` list of the
  release does not ship it — the icon is a build input, not app data.
- **The app title stays Nod.** `title`/`name` in `tinyjs.base.json` are outside this flow: a release
  with another name is a different decision, not a knob of the icon.
- In CI (§8) the icon travels inside `NOD_PRIVATE_RESOURCES`; the workflow prints which icon the
  build will wear and refuses the release when the secret carries `icon.png` and `tinyjs.json` says
  otherwise.
- The Electrobun target (§10) wears the same file through the same `iconForConfig`: its config
  names the PNG for Windows/Linux and the `.iconset` rendered from it for macOS.

Everything else of a custom build is the normal step (§2): the seed is still the private one, and from
0.5.0 a build without it is valid — it just starts empty (RF-61, §1).

## 10. Electrobun target build and publish (E06)

Written in English, 2026-10-22; rewritten 2026-10-23 for 0.7.0. From 0.7.0 the **macOS artifacts of
every release are the Electrobun target**: `release.yml` builds them on its two macOS legs and they
ship in the same `manifest.json` as the tinyjs Windows/Linux builds (§8). Windows and Linux stay
tinyjs. The runtime switch in `docs/canonico.md` §22 is what moved.

### Build

```sh
bun run eb:build
```

The script builds the native helper (`scripts/build-nod-native.ts` →
`electrobun/native/build/libNodNative.dylib`), writes the macOS icon set
(`scripts/eb-icon.ts` → `.eb-icon.iconset`, generated and gitignored), generates the gitignored
`electrobun.config.ts` (`scripts/gen-electrobun-config.ts build`), runs the page build
(`tsc && vite build --base=./`) and then `electrobun build --env=stable`. Output:
`build/stable-macos-<arch>/Nod.app` — measured at **21 MB** for macos-arm64 — and Electrobun's own
artifacts under `artifacts/`. `bun run eb:dev` is the development counterpart (identifier
`copland.nod.eb-dev`, port 5173); neither touches `copland.nod` data or `/Applications/Nod.app`.

**Release identity and signature (E07).** A release build may set `NOD_APP_ID=copland.nod`
(`gen-electrobun-config.ts` accepts it for `build`; `dev` still refuses it), so 0.7.0 replaces the
tinyjs installation under the same identifier and scheme. The packaged app reads its identifier
from `Resources/version.json`, not the environment. The backend's data directory is the tinyjs one
(`~/Library/Application Support/<id>`), so `nod.db`, `store.json` and the icons survive the update
(`electrobun/bun/facade/data-dir.ts`). `eb:build` ends with `scripts/eb-sign.ts`, which re-signs the
bundle ad hoc **after** `eb-postbuild.ts` patched `Info.plist` and verifies it with the exact
`codesign --verify --strict --deep` the tinyjs updater runs — without it, the wrapper keeps hutch's
pre-patch signature and the update is refused. Cookies and WebKit storage are **not** migrated: the
Electrobun target uses a `persist:default` partition, while tinyjs used the default WebKit store
(`docs/handovers/e07-migration.md` §3). The 0.7.0 release sets `NOD_APP_ID=copland.nod`, the
identifier the tinyjs releases wear, so an update keeps the same app data, keychain namespace and
URL scheme (§8).

The bundle carries `Resources/app/views/mainview` (the page), `views/bridge` (the document-start
preload), `resources/` (seed, tray, entry icons, `build-mode` in dev) and
`native/libNodNative.dylib`. Camera/microphone usage strings are written into the wrapped plist by
`scripts/eb-postwrap.ts`, because the Electrobun config type has no field for them; the build is
refused earlier if `tinyjs.base.json` lacks the two sentences. hutch packs the self-extracting
payload *before* `postWrap` and skips the hook in `--env=dev`, so `scripts/eb-postbuild.ts` also
runs as `scripts.postPackage` (and as the last step of `eb:build`): it repairs the payload tar and
then refuses the build if any bundle or `artifacts/*.tar.zst` still lacks either string
(handover `e06-surface-check.md` §13). `eb:build` builds the page before generating the config,
since `gen-electrobun-config.ts build` requires `dist/index.html`.

The last step of `eb:build` is `scripts/eb-sign.ts`. `postbuild` patches the bundle's `Info.plist`
*after* hutch signed it, so macOS rejects the bundle as shipped (`code has no resources but
signature indicates they must be present`); the script re-signs every `build/stable-macos-*/Nod.app`
ad hoc (`codesign --force --deep --sign -`) and then requires `codesign --verify --strict --deep` to
pass. That is the same check the tinyjs updater runs on the bundle it is about to swap in, and
`release.yml` runs it again on the bundle it publishes (§8).

**App icon (RF-56).** The Electrobun target wears the same PNG the tinyjs release wears:
`gen-electrobun-config.ts` imports `iconForConfig` from `scripts/gen-config.ts`, so the precedence
(`NOD_ICON` → `resources/icon.png` → `assets/icon.png`), the ≥1024 PNG check and the
`.nod-icon.png` staging are one implementation, never a second copy. macOS takes a `.iconset`
folder rather than a PNG, so `scripts/eb-icon.ts` renders the ten `iconutil` images with `sips` and
the config names the folder as `build.mac.icons`; hutch converts it to the bundle's `.icns`.
Windows and Linux name the PNG itself as `build.win.icon` / `build.linux.icon`. With no icon
resolved, all three keys stay out and Electrobun keeps its default — the same outcome as tinyjs
with `icon: null` (§9).

### The macOS artifact

```sh
bun scripts/eb-publish.ts build \
  --arch arm64 \
  --version 0.7.0 \
  --base-url https://github.com/<owner>/<repo>/releases/latest/download \
  --notes-file notes.md \
  --out dist/publish
```

Run by the macOS runner after the build and the signature gate. It zips
`build/stable-macos-<arch>/Nod.app` with `ditto -c -k --keepParent` as
`nod-<version>-macos-<arch>.zip` — the name, and the shape, `tinyjs publish` uses for the same
architecture — refuses a bundle whose `Resources/version.json` (or plist) does not already say
`--version`, refuses a zip without `Contents/Info.plist`, computes the **sha256**, and writes one
half of the release manifest to `dist/publish/manifest.json`: `version`, `notes` and
`mac.<arch> = { url, sha256 }`. The other macOS runner writes the other half; the release job merges
both with the `linux.<arch>`/`win` halves the tinyjs legs published, refuses a disagreement on
`version` or a missing macOS architecture, and sets the top-level `url`/`sha256` to the arm64 zip.

Why not Electrobun's own `artifacts/*-update.json`: it has a 13-character content hash (not a digest
of the bytes), no notes, and an updater that cannot apply a verified local file
(`docs/handovers/e06-electrobun-spike.md` §5). And why a `.zip` and not `artifacts/*.tar.zst`: the
tinyjs updater on 0.6.0c Macs only knows `ditto -x -k` of a zip, and it is the installer that
performs the migration (§8).

### The channel the app reads

`electrobun/bun/facade/update.ts` reads the seed's `update.url` itself — the same
`…/releases/latest/download/manifest.json` the tinyjs runtime reads, with a cache-busting nonce
appended. It parses the tinyjs format, taking `version`, `notes` and `mac.<arch>` and ignoring
`win`, `linux` and the top-level `url`/`sha256`; Electrobun's `x64` is the manifest's `x86_64`.
`check()` never applies anything. `install()` requires a newer version (`shared/version.ts`, hotfix
letters included), downloads the zip with the sha256 verified while streaming, extracts it with
`ditto -x -k`, requires the staged bundle to carry the same identifier and version as the running
one, then arms a swap helper that waits for the app to exit, moves the bundle aside and keeps the
previous one under `updates/rollback/`. Every attempt — refusals included — lands in
`updates/install.log`, and the helper's own trace in `updates/swap.log`. The install is not signed
(the manifest carries no signature); the sha256 rules out corruption, a CDN mix-up and a swapped
asset.

### CI

There is no separate Electrobun workflow: `.github/workflows/electrobun.yml` is gone. The two
macOS legs of `release.yml` (§8) restore the private resources, check the app icon against the
generated `electrobun.config.ts`, run `NOD_APP_ID=copland.nod bun run eb:build`, typecheck the
Electrobun project (the root script refuses to skip it under `CI=true`; `eb:build` has just
projected `.hutch/devkit`), run `bun run eb:verify`, fail the job when `codesign --verify --strict
--deep` rejects `build/stable-macos-<arch>/Nod.app`, and publish the zip + manifest half. The
release job merges and uploads them with the rest of the release.

**State.** The pipeline and the migration are `leitura` in CI until a 0.7.0 release runs them. What
was exercised by hand is the channel itself: a local HTTP server, a 0.6.0d artifact, the
tampered-sha refusal, the install/relaunch and one rollback
(`docs/handovers/e06-surface-check.md` §9). There is no signing/notarization beyond the ad-hoc
signature.
