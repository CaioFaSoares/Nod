# Fatia R — release configurada (`scripts/gen-config.ts`, `docs/distribuicao.md`)

Issue que autoriza: `docs/issues/B03-smoke-e-release.md` (em-curso).
Contrato seguido: `docs/arquitetura.md` §2 (gate de origin) e §6 (build e dev); requisitos:
`docs/canonico.md` §19, §9, RF-14, RF-26, RF-27. Fatos do runtime: `docs/tinyjs.md` §1 e §8.
Tipos: `shared/types.ts` (não editado).

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `scripts/gen-config.ts` | criado. `gerarConfig(base, seed, modo, appId?)` pura (sem I/O, sem `process.exit`) + bloco `if (import.meta.main)`: lê `tinyjs.base.json`, lê e valida `resources/seed.json` se existir (`validarSeed`), grava `tinyjs.json` com 2 espaços + `\n`. |
| `test/gen-config.test.ts` | criado. 9 testes com `bun:test` sobre a config gerada a partir de `resources/seed.example.json` e de seeds sintéticos. |
| `docs/distribuicao.md` | criado. Passo a passo de distribuição (seed, build, liberação no macOS, Windows/Linux, convites, atualização, o que fica fora do git), apontando os caminhos em vez de copiar o canônico. |
| `README.md` | acrescentada a seção `## Como rodar` (nova, no fim); nada mais do arquivo foi tocado. |
| `docs/handovers/r-release.md` | este arquivo. |

## Critério de aceite — como cada item foi atendido

Evidência por `leitura` (não rodei teste, script nem build, conforme o contrato da fase). Cada linha
aponta o teste que prova o comportamento e o trecho do código que o produz.

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| `gerarConfig` é pura | `gerarConfig` não abre arquivo, não lê env, não escreve e não chama `process.exit`; o I/O mora só no bloco `import.meta.main` | `scripts/gen-config.ts`: a função só monta e devolve um objeto novo (`{ ...base }` + chaves derivadas do seed/`modo`/`appId`), sem mudar `base` |
| `api.origins` com `file://*: "all"` | `build: gate exato por origin de entrada…`, `dev sem seed libera só as páginas próprias` | primeiro par do objeto `origins`, `[ORIGIN_ARQUIVO]: 'all'` |
| em `dev` também `http://127.0.0.1:5173: "all"` | `dev sem seed libera só as páginas próprias` (objeto inteiro `toEqual`), `dev com seed soma…` | `if (modo === 'dev') origins[ORIGIN_DEV] = 'all'` |
| cada entrada do seed com a origin exata → `["login.report", ...api]` sem duplicatas | `build: gate exato por origin de entrada…`, `duas entradas na mesma origin unem a api sem repetir` | `origemDe(entrada.endereco)` + `apiDaEntrada` (unshift de `login.report` sem repetir, `push` só do que falta, ordem estável) |
| duas entradas na mesma origin unem as listas | idem | `apiPorOrigem.set(origin, apiDaEntrada(apiPorOrigem.get(origin) ?? [], entrada))` |
| nunca `"all"` para ferramenta; nenhuma chave com `*` além de `file://*` | `build: gate exato por origin de entrada…` (`Object.keys(o).sort()` tem só as 3 chaves; as duas de ferramenta são `toEqual(['login.report'])`) | as origins de ferramenta entram **por último** (`for (const [origin, api] of apiPorOrigem) origins[origin] = api`), então sobrescrevem qualquer `'all'`; as chaves vêm de `origemDe`, que devolve `url.origin` (sem `*`) |
| `update` com `{ url, auto: 'daily' }` quando o seed tem `atualizacao` | `seed com atualizacao liga o update diário`; ausente em `build: empacota o seed…` (`config.update` é `undefined`) | `if (seed !== null && seed.atualizacao !== null) config.update = { url, auto: 'daily' }` |
| `build` sem seed → mensagem de RF-26 e código 1 | `build sem seed falha com a mensagem de RF-26` (a função lança); o bloco `main` imprime a mensagem em `console.error` e faz `process.exit(1)` | `throw new Error(MENSAGEM_SEED_AUSENTE)` em `gerarConfig`; `catch` no `main` escreve em stderr e sai 1 |
| `build` com seed → `resources: ["seed.json"]` + ícones relativos sem `..` | `build: empacota o seed…` (`resources` é `['seed.json']` para o exemplo) e `build: ícones relativos entram na lista…` (dedup, `..` recusado, data URI ignorada) | `['seed.json', ...iconesRelativos(seed)]`; `iconesRelativos` descarta `data:`, normaliza `./` e `/` da frente e descarta o que contém `..` |
| `dev` sem seed é permitido (só o gate das páginas próprias) | `dev sem seed libera só as páginas próprias` | `gerarConfig` só lança quando `modo === 'build' && seed === null`; em `dev`, `seed` nulo deixa `apiPorOrigem` vazia |
| env `BOND_APP_ID` substitui o `id` | `appId substitui o id do base` | `if (appId !== undefined && appId !== '') config.id = appId`; no `main`, `process.env.BOND_APP_ID` é o 4º argumento |
| mantém as outras chaves do base | `build: empacota o seed e mantém as demais chaves do base` | `const config = { ...base }` antes de sobrescrever só `api`/`update`/`resources`/`id` |
| nenhum segredo nem origin do seed real em arquivo versionado | — (o `seed.json` real não existe neste repositório; `resources/seed.example.json` tem dados falsos) | `tinyjs.json` é gerado e está no `.gitignore`; o seed de exemplo só traz `*.example.com` |
| `docs/distribuicao.md` cobre os 7 pontos e aponta caminhos | o arquivo tem uma seção por ponto (1–7), cada uma citando `docs/canonico.md` §9/§19 ou `docs/tinyjs.md` §1/§8 | `docs/distribuicao.md` |
| `README.md` ganha `## Como rodar` sem mexer no resto | o `diff` é um único bloco acrescentado no fim | `README.md:34` |

## Comandos

Nenhum gate foi rodado por mim (o contrato da fase diz "só edite"; o coordenador roda `bun test test/`,
os dois `tsc` e o build no fim). Não rodei o próprio `scripts/gen-config.ts` nem `bun test`. Toda a
evidência acima é `leitura`.

## Desvios do contrato (decisões tomadas, para o coordenador confirmar)

1. **Seed ausente vira `throw` em `gerarConfig`, não `process.exit(1)` dentro dela.** A função tem de
   ser pura/testável; a mensagem de RF-26 é a mesma (`seed privado ausente: resources/seed.json
   (veja resources/seed.example.json)`), impressa em stderr pelo bloco `main`, que é quem dá o
   `exit(1)`. O teste `build sem seed falha…` cobre o `throw`.
2. **Seed inválido em `dev` também é fatal.** O `main` valida o seed sempre que o arquivo existe
   (`validarSeed`); se a validação falha, imprime `seed inválido: <mensagem>` em stderr e sai 1 nos
   dois modos. O §6 só exige isso para `build`; um `dev` com seed corrompido falhar cedo parece
   melhor do que rodar com metade das regras. Se o coordenador preferir tolerar em `dev`, é uma
   condição na linha do `catch`.
3. **Origin de dev é o literal `http://127.0.0.1:5173`**, como no §2, e não lido de
   `base.frontend.devUrl`. Preferi a fonte única do contrato a derivar do base (o `tinyjs.base.json`
   repete o mesmo valor; se um dia divergirem, o §2 manda no gate).
4. **`resources` só é escrito em `build`.** Em `dev` o seed é opcional e a lista fica de fora.
5. **Ordem das origins de ferramenta depois das de página.** Garante o "nunca `"all"` para
   ferramenta" mesmo no caso patológico de uma entrada apontar para o próprio servidor de dev
   (`document-order` não é usado por ninguém; o teste compara as chaves ordenadas).
6. **`appId` vazio (`BOND_APP_ID=""`) é ignorado** — mantém o `id` do base. Um id vazio não é app.

## O que ficou de fora (e por quê)

- **Não rodei nada**: `bun scripts/gen-config.ts`, `bun test test/`, `bun run app:build` (com e sem
  seed) e o smoke são do coordenador (fim de fase). O `tinyjs.json` que está na raiz hoje é do probe
  do scaffold, não deste script — não o regenerei (é gerado, gitignored, e rodá-lo seria "executar").
- **Não escrevi em `shared/`, `src/`, `backend/` nem em `tinyjs.base.json`** (um arquivo, um dono).
  `scripts/gen-config.ts` só importa `shared/types` (tipos) e `shared/catalogo`
  (`origemDe`, `validarSeed`).
- **`test/smoke/`** é da fatia H (`docs/issues/B03`), não desta.

## Precisa de outro dono

- **Fatia H (smoke)**: o consumo é a env `BOND_APP_ID` — `bun scripts/gen-config.ts build` com
  `BOND_APP_ID=<algum.id>` grava `tinyjs.json` com esse `id`, e é isso que dá ao smoke um diretório
  de dados próprio. O modo é o `argv[2]` (`dev`|`build`). Nada além disso é necessário do meu lado.
- **Coordenador**: `docs/distribuicao.md` é um documento novo na raiz de `docs/`; se quiser registrá-lo
  na tabela de `README.md` (`## Como ler`) ou no `AGENTS.md` ("Onde cada coisa mora"), é edição desses
  arquivos — `AGENTS.md` não é da minha fatia e o `README.md` eu só acrescentei a seção pedida.

## Onde a evidência cai no handover da frente

Este arquivo é a evidência da fatia R: `scripts/gen-config.ts`, `test/gen-config.test.ts` (9 testes),
`docs/distribuicao.md`, a seção `## Como rodar` do `README.md`. O coordenador confirma rodando
`bun test test/gen-config.test.ts` e `bun run app:build` (com e sem `resources/seed.json`).
