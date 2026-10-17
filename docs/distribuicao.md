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

## 7. O que nunca vai para o git

- `resources/seed.json` — o seed privado;
- `resources/icon.png` — o ícone privado de uma build customizada (RF-56, §9);
- `.nod-icon.png` — cópia gerada de um ícone dado por `NOD_ICON` (§9);
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

1. **Check**: reads `version` from `tinyjs.base.json`. A branch named `release-X.Y.Z` must match
   it; other `release-*` names skip this check. Then `bun run typecheck` and `bun test test/`.
2. **Build**, one job per target, with tinyjs and bun pinned (`TINYJS_VERSION`, `BUN_VERSION` at the
   top of the workflow):

   | Target | Runner | Output |
   | --- | --- | --- |
   | macOS | `macos-15` | `nod-<v>-macos-arm64.zip` and `nod-<v>-macos-x86_64.zip` (`publish --arch` twice) |
   | Linux x86_64 | `ubuntu-24.04` | `nod-<v>-linux-x86_64.tar.gz` |
   | Linux arm64 | `ubuntu-24.04-arm` | `nod-<v>-linux-arm64.tar.gz` |
   | Windows | `windows-2025` | `nod-<v>-win.zip` |

3. **Release**: merges the per-OS `manifest.json` files into one, then creates release
   `release-<version>` — the `prepare` job prints the tag, the prefix included (`docs/canonico.md`
   §19) — with every archive and the merged manifest, marked as latest.

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
  `https://github.com/CaioFaSoares/Nod/releases/latest/download/manifest.json`. `tinyjs publish`
  derives every download URL from that address, and the release job warns when they don't point at
  the release repository. With the channel set, an installed Nod that finds a newer release shows
  the notice by itself (RF-55, `docs/canonico.md` §14): no step in the app and no release by hand.

**Caveats:**

- **Version bump.** Pushing again with the same `version` replaces the release's files. Installed
  apps only update when `version` in `tinyjs.base.json` goes up.
- **Public repository: auto-update works.** The repository is public, so release files download
  without authentication and an installed Nod fetches its manifest and its archives straight from
  GitHub Releases. The release repository is this one — `RELEASE_REPO` already defaults to
  `github.repository`. `NOD_RELEASE_REPO` plus a `NOD_RELEASE_TOKEN` with `contents: write` are
  only for putting the release in *another* repository, which then has to be public too.
- **Public repository: the seed becomes public.** Every archive carries the seed (§1): addresses,
  roles, grants and invite hashes. With a public repository anyone who downloads a release reads
  them, not just the people who received it. `docs/canonico.md` §19 accepts that; what keeps it
  acceptable is RF-27 — the seed carries organization, never a password, a credential or a token.
- **Unsigned.** macOS builds are signed ad hoc, so the release step in §3 still applies. Windows
  builds are unsigned (§4).
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

Everything else of a custom build is the normal step (§2): the seed is still the private one, and from
0.5.0 a build without it is valid — it just starts empty (RF-61, §1).
