# Distribuição do Nod

Como montar, publicar e liberar uma release do Nod. O **porquê** e as decisões do dono estão em
`docs/canonico.md` §19 e §22; os fatos do runtime, em `docs/electrobun.md`. Aqui só o passo a passo.
Electrobun é o único runtime: não existe mais build tinyjs.

## 1. Montar o seed privado

O seed carrega catálogo, papéis, convites (só os hashes) e o endereço de atualização. Ele **não entra
no git** e **não carrega segredo** nenhum (`docs/canonico.md` §19, RF-27). As chaves são em inglês
(`version`, `generatedAt`, `roles`, `entries`, `invites`, `update`), como o modelo em
`shared/types.ts` e o exemplo versionado `resources/seed.example.json`.

Duas origens para o arquivo:

- copiar `resources/seed.example.json` para `resources/seed.json` e preencher à mão; ou
- usar o **export seed** de **Settings → Catalog** numa instalação já configurada (RF-13): o arquivo
  sai pelo diálogo do sistema e vai para `resources/seed.json`. O caminho de volta, **importar seed**
  na mesma tela (modo `merge` ou `overwrite`), aplica um seed novo sem recompilar.

Os ícones referenciados pelas entradas ficam em `resources/` (caminho relativo, sem `..`);
`scripts/gen-electrobun-config.ts` os lista no `electrobun.config.ts` gerado e o build os empacota
junto com o seed e com o `tray.png`, o ícone da bandeja no Windows/Linux. O **ícone do app** (o do
Dock/taskbar) tem a sua própria seção: §9.

Desde 0.5.0 o seed é opcional (RF-61): uma release pode sair sem `resources/seed.json`, e o app sai
vazio; o tile Offline do primeiro uso oferece "Import a seed file" (`session.importSeed`) enquanto
não houver conta. O gate de origins, camera/mic e a URL de atualização continuam vindo só de um seed
embutido — uma release sem seed não tem esses extras.

## 2. Gerar o artefato

```
bun install
bun run eb:build
```

`scripts/eb-build.ts` roda a cadeia do host:

| Host | Passos |
| --- | --- |
| macOS | compila `electrobun/native/NodNative.swift` (`swiftc`), escreve `.eb-icon.iconset` (`sips`), `bun run build`, `gen-electrobun-config.ts build`, `electrobun build --env=stable`, repara/valida as usage strings (`eb-postbuild.ts`) e assina ad hoc (`eb-sign.ts`) |
| Windows/Linux | `eb-icon.ts` (o PNG de 256 px que o Hutch do Windows aceita), `bun run build`, `gen-electrobun-config.ts build`, `electrobun build --env=stable`; não há assinatura |

O `electrobun.config.ts` é gerado e **gitignored**: a origem do gate, a URL de atualização e a lista
de resources saem do seed e não podem vazar. A versão do app está em `app.json`; a release job recusa
`release-<v>` que não bata com ela.

Artefatos (por host, em `build/` e `artifacts/`):

- **macOS**: `Nod.app` em `build/stable-macos-<arm64|x64>/`, mais `artifacts/stable-macos-<arch>-Nod.app.tar.zst`
  e `stable-macos-<arch>-update.json` (o updater do runtime). A release publica também
  `nod-<v>-macos-<arch>.zip` (`ditto -c -k --keepParent`) para o cask e para o updater macOS do Nod.
- **Windows**: `artifacts/stable-win-<x64|arm64>-Nod.tar.zst` + `update.json` + o instalador
  `win-<arch>-Nod-Setup.zip`.
- **Linux**: `artifacts/stable-linux-<x64|arm64>-Nod.tar.zst` + `update.json` + o instalador
  `linux-<arch>-Nod-Setup.tar.gz`.

Não rode um build com credenciais reais e trace de runtime ligado: o trace pode imprimir o EVAL do
adaptador de login e chamadas de API. Use contas e segredos descartáveis (`AGENTS.md`).

## 3. Liberar no macOS

Ad-hoc só roda na máquina que construiu; nas outras o Gatekeeper bloqueia. Decisão do dono em
`docs/canonico.md` §19: o passo de liberação é aceitável, feito à mão por quem recebe.

Na máquina de destino, com o `Nod.app` em `/Applications`:

1. abrir **Ajustes do Sistema → Privacidade e Segurança**;
2. na seção de segurança, clicar em **Abrir assim mesmo** para o Nod (no macOS 15+ o atalho de
   right-click não funciona mais); ou, no terminal,
3. `xattr -d com.apple.quarantine /Applications/Nod.app`.

**Mova para `/Applications` antes do primeiro launch, e sempre abra de lá.** Um app em quarentena
aberto de Downloads ou do `.dmg` roda de um caminho aleatório a cada launch (App Translocation), e o
chaveiro trata cada caminho como um app diferente. Limpar a quarentena na cópia em `/Applications` é
o que evita isso; uma atualização instalada pelo próprio app não é colocada em quarentena.

Distribuição sem esse passo exige **Developer ID Application + notarização** (Apple Developer
Program) — melhoria opcional, ver `docs/canonico.md` §19.

### 3.1 Homebrew

O repositório é também um tap: `Casks/nod.rb` instala o zip macOS da última release, com o sha256 que
o `manifest.json` carrega para cada arquitetura.

```sh
brew tap caiofasoares/nod https://github.com/CaioFaSoares/Nod   # uma vez por máquina
brew install --cask nod
```

- O cask limpa a quarentena de `/Applications/Nod.app` depois de instalar (`postflight_steps`): o
  build ad-hoc abre sem o desvio em Ajustes e nunca é translocado.
- `auto_updates true`: o Nod instala as próprias atualizações (§6), então `brew upgrade` não o toca
  sem `--greedy`. `brew uninstall --cask nod` remove o app; `--zap` também remove os dados desta
  máquina (`~/Library/Application Support/copland.nod` e os caches) — os itens do chaveiro ficam.
- O primeiro launch depois do install é o auto-extrator do Electrobun: o zip carrega um wrapper
  pequeno que descompacta o app no lugar ("Installing application files…") e o abre. Launches
  seguintes abrem direto. Um Nod que não inicia também não se atualiza: use
  `brew upgrade --cask --greedy nod` (ou `brew reinstall --cask nod`).
- `depends_on macos: :sonoma` espelha o `LSMinimumSystemVersion` do bundle, que o `brew audit` exige;
  o piso suportado continua macOS 15 (`docs/canonico.md` RNF-01).
- O cask é escrito por `scripts/brew-cask.ts` a partir do manifesto, nunca à mão. O job `cask` do
  `release.yml` o roda depois de publicar e commita o resultado em `main`, o branch que o `brew tap`
  clona; rodar uma release antiga de novo não faz o cask voltar.

## 4. Windows e Linux

Não há assinatura de código. O caminho é o **instalador** que o Hutch gera:

- **Windows**: `win-<arch>-Nod-Setup.zip` — um setup com o payload ao lado. O app instalado é um
  executável GUI; o launch de desenvolvimento anexa o console.
- **Linux**: `linux-<arch>-Nod-Setup.tar.gz` — setup auto-extraível + README. O `.desktop` se
  registra na primeira execução.

Requisitos: Windows 10/11 com WebView2; Linux glibc 2.35+ com `libwebkit2gtk-4.1-0`. O build Linux precisa de ImageMagick (`convert`) ou ffmpeg para gerar o ícone de 256 px; o Windows usa `System.Drawing`. Para a bandeja,
um AppIndicator (`libayatana-appindicator3-1`): sem ele o app roda, e fechar a janela principal
**encerra** o Nod (`docs/canonico.md` §7).

Uma instalação tinyjs 0.7.0c em Windows/Linux **não** se converte sozinha: a 0.8.0 é um reinstall
único com o instalador acima (o updater tinyjs não é mais publicado). macOS se converte pelo próprio
updater da 0.7.0 (§6).

## 5. Convites entre máquinas

Sem host, o convite viaja pelo seed (`docs/canonico.md` §9):

1. o administrador **emite o convite** em **Settings → People** — o código aparece uma única vez;
2. **export seed** em **Settings → Catalog** (RF-13) já leva o hash do convite;
3. esse seed entra na **próxima release**;
4. na máquina da pessoa, o app aceita o código cujo hash está no seed (uso único por máquina).

## 6. Atualização

Um endereço, dois leitores:

- **macOS**: o manifesto da release (`<release>/download/manifest.json`) com `version`, `notes` e
  `mac.<arch>` (url + sha256). O Nod baixa o zip, confere o sha256, extrai com `ditto`, exige
  `codesign --verify --strict --deep` e troca o `.app` com rollback
  (`electrobun/bun/facade/update.ts`).
- **Windows/Linux**: o `Updater` do Electrobun, sobre
  `stable-<os>-<arch>-update.json` + `.tar.zst`, que o Hutch escreve e a release job publica sem
  renomear (`electrobun/bun/facade/update-runtime.ts`). O runtime faz a troca da instalação
  (helper agendado no Windows, swap no Linux). Não há assinatura: o transporte é HTTPS e o arquivo
  leva o hash de metadados do runtime.

O seed aponta `update.url` para
`https://github.com/CaioFaSoares/Nod/releases/latest/download/manifest.json`; o
`gen-electrobun-config.ts` deriva a pasta (`release.baseUrl`) e o `Updater` monta as URLs a partir
dela. A checagem diária e o aviso de atualização são do backend (`RF-55`); a decisão de versão é de
`shared/version.ts`, inclusive letras de hotfix.

O que **não** acontece: uma instalação 0.7.0c em Windows/Linux não vê a 0.8.0 (o manifesto deixa de
trazer `win`/`linux`); reinstale uma vez. Os cookies de ferramenta não migram entre runtimes
(`docs/electrobun.md` §4): cada ferramenta pede login uma vez.

## 7. O que nunca vai para o git

- `resources/seed.json` — o seed privado;
- `resources/icon.png` — o ícone privado de uma build customizada (RF-56, §9);
- `.nod-icon.png` — cópia gerada de um ícone dado por `NOD_ICON` (§9);
- `.eb-icon.iconset/` — o conjunto de ícones macOS que `scripts/eb-icon.ts` gera;
- `electrobun.config.ts` — gerado, e o gate de origem/canal sai do seed;
- `resources/build-mode` — escrito por `gen-electrobun-config.ts` com o modo (`dev`/`build`); é o
  selo que `backend/main.ts` lê para distinguir um dev run de uma release (SP02 §9), e **não** entra
  na lista de resources de uma release.

Todos já estão no `.gitignore`. O versionado no lugar deles é só `resources/seed.example.json`, com
dados falsos (e o ícone versionado é o `assets/icon.png`).

## 8. Release automatizada (GitHub Actions)

`.github/workflows/release.yml` compila e publica em todo push para um branch `release-*` (e sob
demanda com "Run workflow").

**O branch é criado para você** desde 0.5.0: `.github/workflows/release-branch.yml` roda quando um
pull request de `dev` é mesclado em `main`, lê `version` de `app.json`, empurra `release-<version>`
no commit do merge e dispara `release.yml` (um branch empurrado com `GITHUB_TOKEN` não inicia o
trigger `push`). Se `release-<version>` já existe o job falha de propósito: a versão não subiu, e
republicar a mesma versão é decisão de uma pessoa.

O texto da release é o corpo do commit `Release <version>:` (encontrado por `git log --grep`, com o
cabeçalho `Merge pull request #…` do GitHub removido); é o que um Nod instalado mostra no aviso de
atualização.

1. **Check** (`prepare`, ubuntu): lê `version` de `app.json`, confere o nome do branch, roda
   `bun run typecheck:app` e `bun test test/`.
2. **Build**, um job por alvo, com Bun preso (`BUN_VERSION` no topo do workflow):

   | Alvo | Runner | Saída |
   | --- | --- | --- |
   | macOS arm64 | `macos-15` | `nod-<v>-macos-arm64.zip` + `stable-macos-arm64-update.json` |
   | macOS x86_64 | `macos-15-intel` | `nod-<v>-macos-x86_64.zip` + `stable-macos-x64-update.json` |
   | Linux x86_64 | `ubuntu-24.04` | `linux-x64-Nod-Setup.tar.gz` + `stable-linux-x64-update.json` |
   | Linux arm64 | `ubuntu-24.04-arm` | `linux-arm64-Nod-Setup.tar.gz` + `stable-linux-arm64-update.json` |
   | Windows x64 | `windows-2025` | `win-x64-Nod-Setup.zip` + `stable-win-x64-update.json` |
   | Windows arm64 | `windows-11-arm` | `win-arm64-Nod-Setup.zip` + `stable-win-arm64-update.json` |

   Cada perna restaura os resources privados do secret `NOD_PRIVATE_RESOURCES`, confere o ícone,
   roda `NOD_APP_ID=copland.nod bun run eb:build`, tipa o projeto Electrobun com o devkit projetado
   e (no macOS) valida as usage strings e `codesign --verify --strict --deep`. Depois:
   `bun scripts/eb-publish.ts build --platform … --arch … --version … --base-url … --notes-file …`.
   macOS escreve o zip e a metade do `manifest.json`; Windows/Linux copiam os artefatos do Hutch.
3. **Release**: baixa todas as pernas, junta as metades macOS num `manifest.json` (exige arm64 e
   x86_64), copia os demais artefatos e cria/atualiza a release `release-<version>` com tudo,
   marcada como latest.

**Setup único:**

- Secret `NOD_PRIVATE_RESOURCES`: os arquivos privados de `resources/` (§1, §7) como base64 de um
  tar.gz, com caminhos relativos a `resources/`:

  ```
  tar -czf - -C resources seed.json icons | base64 | gh secret set NOD_PRIVATE_RESOURCES
  ```

  Um ícone customizado viaja no mesmo secret (RF-56, §9) — inclua `resources/icon.png` no arquivo.
  O GitHub limita um secret a 48 KB; se os ícones não couberem, coloque-os no seed como data URIs.
- Auto-update pelo GitHub Releases: `update.url` do seed precisa ser
  `https://github.com/CaioFaSoares/Nod/releases/latest/download/manifest.json`. O job `release`
  avisa quando as URLs não apontam para o repositório da release.

**Caveats:**

- **Bump de versão.** Empurrar de novo a mesma `version` substitui os arquivos da release. Apps
  instalados só atualizam quando a `version` em `app.json` sobe.
- **Hotfix (0.5.5a).** Mantém os três números e adiciona letras após o patch: `0.5.5a`, `0.5.5b`, …,
  `aa`. A ordem é `0.5.5` < `0.5.5a` < `0.5.5b` < `0.5.6` (`shared/version.ts`). O gate da release
  aceita a forma, e o branch, a tag e as notas a carregam como está: `release-0.5.5a`,
  `Release 0.5.5a: …`.
- **Repositório público: o seed fica público.** Todo instalador carrega o seed (§1): endereços,
  papéis, concessões e hashes de convite. O `docs/canonico.md` §19 aceita isso; o que mantém
  aceitável é a RF-27 — o seed carrega organização, nunca senha, credencial ou token.
- **Sem assinatura.** macOS é ad hoc (o passo de §3 continua); Windows/Linux não são assinados.
- **Custo de runner macOS.** Em repositório privado, minutos macOS custam mais que Linux
  (`https://docs.github.com/en/billing/reference/actions-runner-pricing`).

## 9. Builds customizadas (ícone do app)

A release veste o `assets/icon.png` versionado — 1024×1024. Uma build customizada veste outro ícone
sem editar um arquivo versionado:

| Origem | Como |
| --- | --- |
| `resources/icon.png` | coloque o PNG ali; privado e gitignored, como o seed — é o fluxo a manter |
| `NOD_ICON=/caminho/para.png` | `NOD_ICON=/caminho/para.png bun run eb:build`; uso único, o arquivo fica onde está |
| nenhum | `assets/icon.png`, como antes |

`scripts/app-config.ts` resolve nesta ordem (`NOD_ICON` vence, depois `resources/icon.png`, depois
`assets/icon.png`) e recusa qualquer coisa menor que 1024×1024. `scripts/eb-icon.ts` deriva
`.eb-icon-256.png` (Windows/Linux) e, no macOS, o `.iconset`; o `electrobun.config.ts` aponta para
eles.

## 10. Verificação manual antes de publicar

```
bun run validate          # typecheck, unit tests, page build
bun run eb:build          # o bundle do host
bun run eb:verify         # macOS: usage strings no app e no tar
bun test/smoke/run.ts --force
```

Os smokes abrem janelas reais e usam os quatro runners (`run`, `connected`, `ui`, `tabs`). Um smoke
que falha por a janela estar oculta/atrás de outro app não é uma falha do produto: traga a janela do
Nod para a frente e rode de novo. Em Windows/Linux, rode os smokes na máquina alvo; os primeiros
runners verdes da release são a prova de execução dessas plataformas.
