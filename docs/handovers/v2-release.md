# Fatia v2-release — config de release, ícone de bandeja, distribuição e README

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (em-curso).
Contrato seguido: `docs/arquitetura.md` §2 (gate de origin) e §6 (build e dev); requisitos:
`docs/canonico.md` §19, §9, RF-13, RF-26, RF-27; vocabulário: `CONTEXT.md`. Tipos:
`shared/types.ts` (v2, não editado). Reescrita em inglês do que existia na v1
(`docs/handovers/r-release.md`), reaproveitando a lógica provada.

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `scripts/gen-config.ts` | reescrito em inglês. `generateConfig(base, seed, mode, appId?)` pura (sem I/O, sem `process.exit`) + bloco `if (import.meta.main)`: lê `tinyjs.base.json`, lê e valida `resources/seed.json` quando existe (`validateSeed`), grava `tinyjs.json` com 2 espaços + `\n`. Cadastrada a guarda de `*` (D4) e a lista `resources` com `tray.png`. |
| `test/gen-config.test.ts` | reescrito em inglês, com o seed de exemplo lido de `resources/seed.example.json` e as chaves v2 (`entries`, `url`, `icon`, `update`). 10 testes; acrescentados o da origin com `*` (D4) e o de `resources` com `tray.png`. |
| `resources/tray.png` | criado — PNG 32×32 RGBA, glifo monocromático (anel claro com alfa), 304 bytes reais. É o ícone da bandeja no Linux (`docs/arquitetura.md` §4) e entra na lista `resources` do build. |
| `docs/distribuicao.md` | atualizado para a v2: chaves do seed em inglês, `private seed missing: …` e `invalid seed: …`, `tray.png` empacotado, bandeja/AppIndicator e o que fechar a janela principal faz, export/import de seed por diálogo em **Settings → Catalog**, `update.url`, aviso de `TINYJS_DEBUG` apontando `AGENTS.md`. Estrutura (7 seções) mantida. |
| `README.md` | só a descrição de uma linha (parágrafo de abertura) e a seção `## Como rodar`: janela principal única com sidebar, Home, paleta (`⌘K`) e Settings abrindo cada ferramenta em janela própria; comandos com `bun test/smoke/run.ts`. Nada mais do arquivo foi tocado. |
| `docs/handovers/v2-release.md` | este arquivo. |

## Critério de aceite — como cada item foi atendido

Evidência por `leitura` (não rodei teste, typecheck nem build, conforme o contrato da fase). A única
execução foi a que produziu o `tray.png` (permitida pela fatia) mais `file`/`sips` para conferir que
o arquivo é um PNG válido.

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| `generateConfig` pura | a função não abre arquivo, não lê env, não escreve e não chama `process.exit`; o I/O mora só no bloco `import.meta.main` | `scripts/gen-config.ts`: monta `{ ...base }` e devolve um objeto novo, sem tocar `base` |
| `file://*: 'all'` | teste `build: exact gate per entry origin, no dev origin` | primeiro par de `origins`: `[FILE_ORIGIN]: 'all'` |
| `http://127.0.0.1:5173: 'all'` **só em dev** | `build: exact gate…` (a chave dev não existe, `'http://127.0.0.1:5173' in o` é `false`), `dev without a seed releases only the app pages` (objeto inteiro) | `if (mode === 'dev') origins[DEV_ORIGIN] = 'all'` |
| cada origin de entrada → `['login.report']`, sem `api` por entrada | `build: exact gate…`, `dev with a seed adds the entry gate to the page gate`, `two entries on the same origin share one key` | `originOf(entry.url)` por entrada, chave criada com `['login.report']`; não existe mais soma de `api` da entrada |
| duas entradas na mesma origin → uma chave | `two entries on the same origin share one key` (`https://x.example.com` e `…/v2`) | `toolOrigins` deduplica por origin preservando a ordem do seed |
| nunca `"all"` para ferramenta; nenhuma chave de ferramenta com `*` (D4) | `build: exact gate…` (`Object.keys(o).sort()` tem só as três chaves) e `a wildcard origin never becomes a tool key (D4)` (a função lança) | origins de ferramenta entram **depois** das de página; antes de entrar, `if (origin.includes('*')) throw new Error('tool origin must not be a wildcard: …')` |
| `build` sem seed → `private seed missing: resources/seed.json (see resources/seed.example.json)` e código 1 | teste `build without a seed fails with the RF-26 message` (a função lança); o bloco `main` imprime a mensagem em stderr e faz `process.exit(1)` | `throw new Error(MISSING_SEED_MESSAGE)` dentro de `generateConfig`; `catch` no `main` |
| seed inválido → `invalid seed: <msg>` e código 1 | — `leitura` do bloco `main` | `catch` do `validateSeed`: `console.error(\`invalid seed: ${…}\`)` + `process.exit(1)` |
| `build` → `resources` = `['seed.json', 'tray.png', …ícones relativos sem '..']` | `build: bundles the seed and the tray icon…` (`['seed.json', 'tray.png']`) e `build: relative icons join resources, without '..' or repetition` (`['seed.json', 'tray.png', 'icons/a.png']`, data URI e `../` fora) | `BUNDLED = ['seed.json', 'tray.png']` + `relativeIconPath` (descarta `data:`, normaliza `./` e `/`, descarta `..` e vazio, deduplica) |
| `update` do seed → `{ url, auto: 'daily' }` | `seed update turns on the daily update`; ausente em `build: bundles the seed…` (`config.update` é `undefined`) | `if (seed !== null && seed.update !== null) config.update = { url, auto: 'daily' }` |
| env `BOND_APP_ID` não-vazia substitui `id` | `appId replaces the base id` (com e sem o 4º argumento) | `if (appId !== undefined && appId !== '') config.id = appId`; no `main`, `process.env.BOND_APP_ID` |
| demais chaves do base preservadas | `build: bundles the seed and the tray icon, keeping the other base keys` | `const config = { ...base }` e só `api`/`update`/`resources`/`id` são sobrescritos |
| `dev` sem seed permitido | `dev without a seed releases only the app pages` | `generateConfig` só lança com `mode === 'build' && seed === null` |
| `resources/tray.png` é PNG 32×32 de verdade | `file resources/tray.png` → `PNG image data, 32 x 32, 8-bit/color RGBA, non-interlaced`; `sips -g pixelWidth -g pixelHeight -g hasAlpha -g format` → `32`, `32`, `hasAlpha: yes`, `format: png` | arquivo binário escrito por script descartável (IHDR 32×32, tipo 6, IDAT deflate, CRC próprio); o script foi apagado depois |
| nenhum segredo nem origin de seed real em arquivo versionado | os testes usam `*.example.com` e o `resources/seed.example.json` (dados falsos) não foi tocado; nenhum arquivo meu traz endereço do catálogo real | `tinyjs.json` é gerado e está no `.gitignore`; o `tray.png` é imagem, sem dado embutido |
| `docs/distribuicao.md` na v2 | o arquivo cobre: chaves em inglês (§1), mensagem de RF-26 e `invalid seed` (§2), `tray.png` empacotado (§1 e §4), bandeja/AppIndicator e fechar a janela principal (§4), export/import por diálogo em Settings → Catalog (§1 e §5), `update.url` (§6), `TINYJS_DEBUG` → `AGENTS.md` (§2) | `docs/distribuicao.md`, apontando `docs/canonico.md` §7/§9/§19 e `docs/tinyjs.md` §1/§8 em vez de copiar |
| `README.md` descreve a janela única e o smoke | descrição de abertura e bloco de comandos | `README.md` |

## Comandos

- `bun /tmp/bond-gen-tray.ts` — script descartável (fora do repositório, apagado em seguida) que
  escreveu `resources/tray.png`: resultado observado `wrote 304 bytes`.
- `file resources/tray.png` → `PNG image data, 32 x 32, 8-bit/color RGBA, non-interlaced`.
- `sips -g pixelWidth -g pixelHeight -g hasAlpha -g format resources/tray.png` → `32`, `32`,
  `hasAlpha: yes`, `format: png` (o `sips` decodifica o arquivo; o `file` só lê o cabeçalho).
- `bun test test/`, `bunx tsc …`, `bun run app:build` (com e sem seed) e `bun test/smoke/run.ts`:
  **não rodados** por mim — são do coordenador no fim da fase.

## Desvios do contrato (decisões tomadas, para o coordenador confirmar)

1. **A guarda de `*` roda depois de `originOf` e lança `tool origin must not be a wildcard: <origin>`.**
   A fatia descreve a guarda como profundidade (D4) e pede um teste que monte o seed **por fora** do
   `validateSeed`. Como `originOf` do §3 já recusa host com `*` (`invalid address`), a origem
   patológica pode morrer antes de chegar à guarda; por isso o teste afirma só `toThrow()`, sem fixar
   a mensagem — quem recusar primeiro está correto. Se o `shared/catalog.ts` final aceitar host com
   `*`, é a guarda que dispara.
2. **`resources` continua só no modo `build`.** Em `dev` o seed é opcional e a chave não aparece —
   comportamento da v1 que o §6 descreve ("Em `build` … grava `resources`").
3. **`tray.png` é deduplicado como qualquer ícone**: se uma entrada apontar para `tray.png`, ele não
   entra duas vezes na lista (o conjunto de vistos já nasce com `seed.json` e `tray.png`).
4. **A origin de dev é o literal `http://127.0.0.1:5173`**, como no §2, e não lida de
   `base.frontend.devUrl`.
5. **`build` sem seed lança dentro de `generateConfig`**, não escreve em stderr sozinho: a mensagem de
   RF-26 é a mesma do contrato e quem imprime/sai é o bloco `main`. Mantém a função pura e testável
   (mesma decisão da v1, confirmada pelo contrato §6).
6. **`README.md`**: só o parágrafo de abertura e `## Como rodar` foram tocados, como pedido. A seção
   `## Estado` ("Não existe código ainda") ficou como estava — é de outro dono e não está na fatia.

## O que ficou de fora (e por quê)

- **Nenhum teste, typecheck, build ou smoke rodado** — o contrato da fase diz "só edite"; a única
  execução permitida (gerar o PNG) foi feita e conferida.
- **Não escrevi em `shared/`, `src/`, `backend/`, `resources/seed.example.json` nem em
  `tinyjs.base.json`** (um arquivo, um dono). O script importa `shared/types` (tipo `Seed`) e
  `shared/catalog` (`originOf`, `validateSeed`) — os dois nomes que o contrato §3 declara.
- **`docs/issues/`, `docs/canonico.md` e o status da fatia** não foram tocados: marcar, aprovar ou
  mudar etapa é gate do dono.

## Precisa de outro dono

- **`backend/main.ts` (packaging/runtime)**: o caminho do ícone da bandeja no Linux é
  `paths.resources + '/tray.png'` (`docs/arquitetura.md` §4) e o arquivo agora existe em
  `resources/`; a lista `resources` do build já o inclui, então o build não falha por caminho
  faltando.
- **Smoke (`test/smoke/run.ts`)**: o gerador mudou de nome (`gerarConfig` → `generateConfig`) e o gate
  das entradas virou `['login.report']` sem `api` por entrada; o seed temporário do smoke não precisa
  mais declarar `api`. A env `BOND_APP_ID` continua sendo o 4º argumento (vinda de
  `process.env.BOND_APP_ID`), e a mensagem de seed ausente em `build` mudou para inglês.
- **Coordenador**: `docs/distribuicao.md` agora depende de `resources/tray.png` estar versionado —
  confirme que o arquivo entra no commit (o `.gitignore` não o cobre).

## Onde a evidência cai no handover da frente

Este arquivo é a evidência da fatia `v2-release`: `scripts/gen-config.ts`,
`test/gen-config.test.ts` (10 testes), `resources/tray.png` (304 bytes, 32×32 RGBA),
`docs/distribuicao.md` e os dois trechos do `README.md`. O coordenador confirma rodando
`bun test test/gen-config.test.ts`, os dois `tsc` e `bun run app:build` com e sem
`resources/seed.json`.

## Fix 2 — a porta de dev sai do `BOND_DEV_PORT`

**Sintoma (reproduzido pelo coordenador, por execução):** `bun test/smoke/run.ts` com um
`bun run app:dev` do dono aberto morria em `error when starting dev server: Error: Port 5173 is
already in use` e o `tinyjs dev` do smoke saía. Smoke e sessão do dono disputavam a 5173 — e, mesmo
que um dos dois subisse, o `devUrl` de 5173 mandava a janela do smoke para o servidor do dono.

**Correção.** `generateConfig` ganhou o 5º parâmetro `devPort` (`devPort: number =
DEFAULT_DEV_PORT`, com `DEFAULT_DEV_PORT = 5173`). Em `dev`, a chave da origin de página em
`api.origins` **e** `frontend.devUrl` passam a ser `http://127.0.0.1:<devPort>`: a janela e o gate
nomeiam a mesma origem. Em `build` nada muda — a chave dev continua inexistente e `frontend` continua
saindo inteiro do `tinyjs.base.json` (o `toEqual` do teste de build continua valendo, porque o bloco
de `devUrl` só roda em `dev`).

O bloco `import.meta.main` lê `BOND_DEV_PORT`: ausente → 5173; só dígitos entre 1024 e 65535 →
aquele porto; qualquer outra coisa (vazio, `5199x`, `80`, `70000`) → stderr
`invalid BOND_DEV_PORT: <valor>` e `exit 1`. A validação roda logo depois do uso/`argv[2]` e antes de
ler `tinyjs.base.json`, então um valor torto falha antes de qualquer escrita.

**Arquivos deste Fix 2:** `scripts/gen-config.ts` e `test/gen-config.test.ts` (mais este handover).
`vite.config.ts` (`server.port = Number(process.env.BOND_DEV_PORT ?? 5173)`) e o script `dev`
(`vite --host 127.0.0.1 --strictPort`, sem porta fixa) já tinham sido mudados pelo coordenador: a
variável do ambiente é o elo entre os dois lados — vite escuta o porto pedido, o gate e o `devUrl`
apontam para ele. O runtime confirma o acoplamento por leitura do CLI instalado
(`/Users/caio/.tinyjs/cli.js:2075` sobe `frontend.dev`, `:2092` espera `frontend.devUrl` responder —
porta torta em um dos lados vira `frontend dev server did not respond at …`).

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| `generateConfig` aceita porta opcional de dev (5º parâmetro, padrão 5173) | `test/gen-config.test.ts:128` (`generateConfig(BASE, null, 'dev', undefined, 5199)`) e os testes antigos, que seguem chamando sem o 5º argumento e continuam passando a 5173 | `devPort: number = DEFAULT_DEV_PORT` (`scripts/gen-config.ts:79`) |
| em `dev` a origin de página é `http://127.0.0.1:<devPort>` e vale `'all'` | teste `dev on another port moves the page gate and the dev url together` (`o['http://127.0.0.1:5199'] === 'all'` e `Object.keys(o).sort()` = `['file://*', 'http://127.0.0.1:5199']`) | `if (mode === 'dev') origins[\`http://127.0.0.1:${devPort}\`] = 'all'` (`scripts/gen-config.ts:91`) |
| sem chave 5173 quando a porta é outra | mesmo teste: `'http://127.0.0.1:5173' in o === false` | a chave dev é uma só, montada com o `devPort` recebido |
| `frontend.devUrl` = `http://127.0.0.1:<devPort>` | mesmo teste: `config.frontend` `toEqual` `{ dist: 'dist', devUrl: 'http://127.0.0.1:5199' }` (o `dist` do base fica) | bloco `if (mode === 'dev')` copia `frontend` do base — com a chave do base já checada como objeto — e troca só `devUrl` (`scripts/gen-config.ts:98-109`) |
| `build` inalterado | `build: bundles the seed and the tray icon, keeping the other base keys` (`config.frontend` `toEqual` o `frontend` do `BASE`, com o `devUrl` de 5173) | o bloco de `frontend` está dentro de `if (mode === 'dev')` |
| `BOND_DEV_PORT` inteiro 1024–65535; qualquer outro → stderr `invalid BOND_DEV_PORT: <valor>` e `exit 1`; ausente → 5173 | `leitura` de `scripts/gen-config.ts:125-136` | `!/^[0-9]+$/.test(raw) \|\| parsed < 1024 \|\| parsed > 65535` → `console.error(\`invalid BOND_DEV_PORT: ${raw}\`)` + `process.exit(1)`; `BOND_DEV_PORT` ausente deixa `devPort = DEFAULT_DEV_PORT` |
| os testes antigos ficam | `bun test test/gen-config.test.ts` passa a ter 11 testes (10 + 1); nenhum teste foi removido nem afrouxado | o novo teste é aditivo, ao lado de `dev with a seed adds the entry gate to the page gate` |

**Superado por este Fix 2:** a linha do quadro de aceite acima que diz
`if (mode === 'dev') origins[DEV_ORIGIN] = 'all'` e o desvio 4 ("a origin de dev é o literal
`http://127.0.0.1:5173`, e não lida de `base.frontend.devUrl`"). A constante `DEV_ORIGIN` não existe
mais; sobra `DEFAULT_DEV_PORT = 5173`, que é o valor quando ninguém pede outro. A origem continua
**não** sendo lida de `base.frontend.devUrl`: quem manda é a porta, e o `devUrl` do arquivo é
reescrito a partir dela.

**Não rodado:** nenhum teste, typecheck, build, smoke, linter ou formatador — o contrato da fase diz
"só edite"; a evidência deste Fix 2 é `leitura`.

**Precisa de outro dono (ou do coordenador):** `docs/arquitetura.md` §2 (linha 53) ainda descreve o
gate de dev como `http://127.0.0.1:5173` literal, e o §6 não cita `BOND_DEV_PORT`. O arquivo não
está na fatia deste Fix 2, então a linha ficou como estava — a decisão de atualizar o contrato é do
coordenador.
