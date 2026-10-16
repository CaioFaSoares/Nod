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
