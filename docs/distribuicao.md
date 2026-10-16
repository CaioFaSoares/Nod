# Distribuição do Bond

Como montar, publicar e liberar uma release do Bond. O **porquê** e as decisões do dono estão em
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
`tray.png`, o ícone da bandeja no Linux.

## 2. Gerar o artefato

```
bun install
bun run app:build
```

`app:build` roda `scripts/gen-config.ts build` (grava `tinyjs.json` com o gate de origin das
entradas e a lista `resources`) e em seguida `tinyjs build`. Sem `resources/seed.json` o passo falha
de propósito, com `private seed missing: resources/seed.json (see resources/seed.example.json)`
(RF-26); com um seed que não valida, falha com `invalid seed: <motivo>`. O `tinyjs.json` é gerado e
**gitignored**: o gate de origins sai do seed e não pode vazar.

No desenvolvimento do app a partir do código (`bun run app:dev`), **não** rode com `TINYJS_DEBUG=1`
usando credenciais reais: o trace do runtime imprime o EVAL do adaptador de login e cada chamada de
API. A lista do que não pode está em `AGENTS.md`.

O artefato sai em `dist/`, por sistema (`docs/tinyjs.md` §8):

- **macOS**: binário + `Bond.app` codesigned em modo ad-hoc (`--dmg` para o instalador,
  `--arch`/`--universal` para as CPUs).
- **Windows**: pasta `dist/` portátil.
- **Linux**: pasta portátil, empacotada como tarball por arquitetura.

## 3. Liberar no macOS

Ad-hoc só roda na máquina que construiu; nas outras o Gatekeeper bloqueia. Decisão do dono em
`docs/canonico.md` §19: o passo de liberação é aceitável, feito à mão por quem recebe.

Na máquina de destino, com o `Bond.app` em `/Applications`:

1. abrir **Ajustes do Sistema → Privacidade e Segurança**;
2. na seção de segurança, clicar em **Abrir assim mesmo** para o Bond (no macOS 15+ o atalho de
   right-click não funciona mais); ou, no terminal,
3. `xattr -d com.apple.quarantine /Applications/Bond.app`.

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
e o menu da bandeja traz `Open Bond`, `Lock` e `Quit Bond`. Sem bandeja (Linux sem AppIndicator),
fechar a janela principal **encerra** o Bond.

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
- `tinyjs.json` — gerado, e o gate de origins sai do seed.

Ambos já estão no `.gitignore`. O versionado no lugar deles é só `resources/seed.example.json`, com
dados falsos.

## 8. Automated release (GitHub Actions)

`.github/workflows/release.yml` builds and publishes on every push to a branch named `release-*`
(and on demand with "Run workflow").

1. **Check**: reads `version` from `tinyjs.base.json`. A branch named `release-X.Y.Z` must match
   it; other `release-*` names skip this check. Then `bun run typecheck` and `bun test test/`.
2. **Build**, one job per target, with tinyjs and bun pinned (`TINYJS_VERSION`, `BUN_VERSION` at the
   top of the workflow):

   | Target | Runner | Output |
   | --- | --- | --- |
   | macOS | `macos-15` | `bond-<v>-macos-arm64.zip` and `bond-<v>-macos-x86_64.zip` (`publish --arch` twice) |
   | Linux x86_64 | `ubuntu-24.04` | `bond-<v>-linux-x86_64.tar.gz` |
   | Linux arm64 | `ubuntu-24.04-arm` | `bond-<v>-linux-arm64.tar.gz` |
   | Windows | `windows-2025` | `bond-<v>-win.zip` |

3. **Release**: merges the per-OS `manifest.json` files into one, then creates release
   `release-<version>` — the `prepare` job prints the tag, the prefix included (`docs/canonico.md`
   §19) — with every archive and the merged manifest, marked as latest.

**One-time setup:**

- Secret `BOND_PRIVATE_RESOURCES`: the private files of `resources/` (§1, §7) as base64 of a
  tar.gz, with paths relative to `resources/`. With `seed.json` plus any icons it references:

  ```
  tar -czf - -C resources seed.json icons | base64 | gh secret set BOND_PRIVATE_RESOURCES
  ```

  GitHub caps a secret at 48 KB. If the icons don't fit, put them in the seed as data URIs.
- Auto-update from GitHub Releases: the seed's `update.url` must be
  `https://github.com/CaioFaSoares/Bond/releases/latest/download/manifest.json`. `tinyjs publish`
  derives every download URL from that address, and the release job warns when they don't point at
  the release repository. With the channel set, an installed Bond that finds a newer release shows
  the notice by itself (RF-55, `docs/canonico.md` §14): no step in the app and no release by hand.

**Caveats:**

- **Version bump.** Pushing again with the same `version` replaces the release's files. Installed
  apps only update when `version` in `tinyjs.base.json` goes up.
- **Public repository: auto-update works.** The repository is public, so release files download
  without authentication and an installed Bond fetches its manifest and its archives straight from
  GitHub Releases. The release repository is this one — `RELEASE_REPO` already defaults to
  `github.repository`. `BOND_RELEASE_REPO` plus a `BOND_RELEASE_TOKEN` with `contents: write` are
  only for putting the release in *another* repository, which then has to be public too.
- **Public repository: the seed becomes public.** Every archive carries the seed (§1): addresses,
  roles, grants and invite hashes. With a public repository anyone who downloads a release reads
  them, not just the people who received it. `docs/canonico.md` §19 accepts that; what keeps it
  acceptable is RF-27 — the seed carries organization, never a password, a credential or a token.
- **Unsigned.** macOS builds are signed ad hoc, so the release step in §3 still applies. Windows
  builds are unsigned (§4).
- **macOS runner cost.** On a private repository, macOS runner minutes cost more than Linux ones
  (`https://docs.github.com/en/billing/reference/actions-runner-pricing`).
