# Fatia v2-cascade — cascata de login e atalhos (`shared/login-cascade.ts`, `shared/shortcuts.ts`)

Dono: fatia v2-cascade. Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md`
(`em-curso`). Contrato: `docs/arquitetura.md` §3 (`shared/login-cascade.ts`, `shared/shortcuts.ts`);
requisitos: `docs/canonico.md` §7 (atalhos), §8 e §11 (cascata). Vocabulário: `CONTEXT.md` (cascata de
login, sidebar, janela de ferramenta).

## Arquivos tocados

- `shared/login-cascade.ts` (novo) — `CascadeState`, `CascadeSignal`, `CascadeAction`,
  `newCascade`, `stepCascade`, com as oito regras numeradas do §3 do contrato. Substitui
  `shared/cascata.ts`.
- `shared/shortcuts.ts` (novo) — `digits`, `combo`. Substitui `digits`/`combo` de `shared/rail.ts`.
- `test/login-cascade.test.ts` (novo) — uma bateria por regra numerada (1–8), o caso do segundo
  preenchimento, os três fluxos completos do aceite e a prova de não-mutação. Substitui
  `test/cascata.test.ts`.
- `test/shortcuts.test.ts` (novo) — dígitos e combos. Substitui a parte correspondente de
  `test/rail.test.ts`.
- `shared/cascata.ts`, `shared/rail.ts`, `test/cascata.test.ts`, `test/rail.test.ts` — apagados.
- `docs/handovers/v2-cascade.md` (este arquivo).

Nenhum outro arquivo foi aberto para escrita; nenhuma dependência nova; `shared/types.ts`,
`src/api.ts` e `src/ui.ts` intactos.

## Critério de aceite e como foi atendido

Evidência por `leitura` (o despacho da fatia proíbe executar testes/typecheck/linter/formatador): o
que segue é o que o código e os testes dizem, não resultado observado de execução.

### `shared/login-cascade.ts`

Assinaturas exatamente as do §3: `CascadeState { origin; attempts; leftOrigin; result }`,
`CascadeSignal` (`navigated` | `finished` | `report`), `CascadeAction`
(`none` | `inject` | `result`), `newCascade(origin)`, `stepCascade(s, signal, ctx)`. `LoginResult` e
`ReportState` vêm de `shared/types.ts` com `import type`; o módulo não importa `tjs`, `tiny` nem DOM.

As oito regras, aplicadas na ordem numerada e com um teste por regra em
`test/login-cascade.test.ts` (descrição `describe('stepCascade — one test per numbered rule')`):

1. `result !== null` → `none` e o estado recebido de volta. Coberto com estado
   `{ attempts: 1, leftOrigin: true, result: 'manual' }` contra os oito sinais possíveis
   (`navigated`/`finished` dentro e fora da origin, e os quatro `report`).
2. `navigated`/`finished` com origin ≠ `origin` → `leftOrigin = true` e `none`; o estado recebido
   continua com `leftOrigin = false`. A origin sai de `new URL(url).origin` num `try`; URL inválida
   fica com `''`, que nunca casa com a origin validada da entrada, e o mesmo teste cobre
   `'not a url'` (nos dois sinais) e a string vazia. Também coberto que outro esquema no mesmo host
   (`http://kanban.copland.studio`) é outra origin.
3. `navigated` na `origin` → `none`, estado idêntico ao recebido — inclusive a partir de
   `{ attempts: 1, leftOrigin: true }`, para provar que navegar dentro da origin não apaga o que a
   cascata aprendeu.
4. `finished` na `origin` → `inject` com `fill = hasCredential && !noFill && attempts === 0` e, **quando
   `fill`, `attempts += 1` na hora**: `finish` na origin com `attempts 0` devolve
   `{ type: 'inject', fill: true }` e estado com `attempts 1`; sem credencial, com `noFill` ou com
   `attempts 1` a ação é `{ type: 'inject', fill: false }` e `attempts` não muda. A comparação é por
   origin: `${ORIGIN}/panel` também injeta.
5. `report 'no-form'` → `provider` se `leftOrigin`; senão `filled` se `attempts > 0`; senão `session`.
   Os três ramos testados, mais o desempate: com `attempts 1` **e** `leftOrigin`, ganha `provider`.
   Nos três a ação é `{ type: 'result', result }` e o `result` entra no estado devolvido.
6. `report 'filled'` → `none`, estado idêntico ao recebido (a tentativa já foi contada na injeção do
   passo 4; `attempts` continua 1 e `result` continua `null`).
7. `report 'form'` → `failed` se `attempts > 0`; senão `manual`.
8. `report 'error'` → `failed` — testado com `attempts 0`, com `attempts 1` e com
   `{ attempts: 1, leftOrigin: true }`. Regra nova da v2 (na v1 o `error` caía no ramo 7).

Não muta o estado recebido: o teste `never mutates the received state` congela o estado com
`Object.freeze` (módulo ESM: escrita em objeto congelado estoura) e passa os oito sinais, conferindo
o valor do estado original depois de cada passo; por fim, `finished` na origin devolve objeto novo
(`not.toBe`) com `attempts 1` enquanto o recebido segue `attempts 0`.

**Segundo preenchimento (a correção do laço de login).** No teste
`without any report, finishing on the origin never fills a second time`: `finished(ORIGIN)` →
`inject fill: true` (attempts 1); `finished(ORIGIN)` de novo → `inject fill: false` com `attempts` 1
— sem relato nenhum, nunca há segundo preenchimento. O terceiro `finished` (outro caminho da origin)
continua `fill: false`.

**Fluxos completos do aceite**, em `describe('stepCascade — login-loop fix and full flows')`:

- formulário: `finished` → `inject fill: true` → `report 'filled'` (none) → `finished` →
  `inject fill: false` → `report 'no-form'` → result `filled`, `attempts 1`, `leftOrigin false`;
- SSO silencioso: `navigated(ORIGIN/sso)` → `navigated(PROVIDER)` (`leftOrigin true`) →
  `navigated(ORIGIN/sso/back)` → `finished(ORIGIN/panel)` → `inject fill: true` →
  `report 'no-form'` → result `provider`;
- sessão: `finished` sem credencial → `inject fill: false` (`attempts 0`) → `report 'no-form'` →
  result `session`.

### `shared/shortcuts.ts`

- `digits(ids)`: `Map<number, Id>` de 1 a 9 na ordem dada; do 10º em diante é ignorado — 11 ids → 9
  entradas, `1 → tool-1`, `9 → tool-9`, `10 → undefined`, chaves exatamente 1..9. Sem ids → `size 0`;
  um id → [[1, id]].
- `combo(key, os)`: `'cmd+'` no macOS, `'ctrl+'` em `windows` e `linux`, com a tecla em minúsculas.
  Aceite literal coberto: `combo('1','macos') === 'cmd+1'` e `combo('K','linux') === 'ctrl+k'`; mais
  `combo('k','macos') === 'cmd+k'`, `combo('K','windows') === 'ctrl+k'`, `combo('1','windows') ===
  'ctrl+1'` e `combo('PALETTE','linux') === 'ctrl+palette'`.
- Geometria (`LARGURA_RAIL`, `Retangulo`, `geometria`) e palcos quentes (`Quentes`) **não** vieram
  para a v2: saem do `shared/` junto com o rail (ver "O que ficou de fora").

## Comando rodado e resultado observado

Nenhum. Instrução explícita do despacho ("**DO NOT run tests, typecheck, build, smoke, linter or
formatter. Only edit.**"): toda a evidência acima é `leitura` do código, do contrato §3 e dos testes
escritos — nada aqui foi observado em execução por esta fatia. A confirmação que fecha o critério fica
com o coordenador, no gate de fim de fase: `bun test test/login-cascade.test.ts test/shortcuts.test.ts`
(e, no fim da fase, `bun test test/`, `bunx tsc -p tsconfig.json`, `bunx tsc -p backend/tsconfig.json`).

## O que ficou de fora, e por quê

- **Aplicar a ação da cascata** (buscar a credencial quando `fill`, reconferir a janela e a última URL
  antes do `eval`, temporizador de 4 s sem `finish`, evento `login`) — é `backend/tool-windows.ts`
  (§4 do contrato), de outro dono. `stepCascade` é puro: devolve `{ state, action }` e quem chama
  guarda o estado.
- **Geometria da janela de ferramenta e o `Quentes`** — a §4 do contrato põe a geometria (1280×800
  limitada a 90% da área útil da tela da janela `main`, em cascata +28 px a partir do canto dela)
  dentro de `backend/tool-windows.ts`; não há módulo puro para isso na v2, então `LARGURA_RAIL`,
  `Retangulo` e `geometria` saíram com o `rail.ts`. O warm-pool de palcos não existe mais na v2.
- **Validar a origin da entrada** (`https`, loopback, IPv6) — é `originOf` de `shared/catalog.ts`, de
  outro dono; `stepCascade` só compara strings de origin e nunca importa `catalog.ts`.
- **O script do adaptador de login** (`login-adapter.ts`) e o conteúdo do relato — de outro dono; a
  cascata só decide `fill: true | false` e lê `ReportState`.
- **Persistência da lista de janelas abertas, atalhos globais no runtime (`app.hotkey.register`)** —
  `backend/tool-windows.ts`; `digits`/`combo` só produzem o mapa e o nome do combo.

## Achados para o coordenador (fora do meu escopo de escrita)

- `backend/palcos.ts` (dono: fatia de janelas de ferramenta) ainda importa `../shared/rail` e
  `../shared/cascata`, que esta fatia apagou. O contrato já lista `backend/palcos.ts` entre os arquivos
  removidos na v2 e `backend/tool-windows.ts` substitui `digits`/`combo` por `shared/shortcuts.ts` e
  a cascata por `shared/login-cascade.ts`. Até essa fatia aterrissar, o repositório não passa em
  `bunx tsc -p backend/tsconfig.json`; é a ordem esperada das fatias, não um defeito desta.
- `src/style.css:19` (dono: fatia de frontend) traz o comentário `/* = LARGURA_RAIL de shared/rail.ts */`
  sobre `--largura-rail: 72px`, e o bloco `.rail*` segue no arquivo; `shared/rail.ts` não existe mais.
  Quem reescreve a página precisa atualizar esse comentário/bloco — não é arquivo meu.
- `test/smoke/rodar.ts` não importa os módulos apagados (só `node:*` e `./ferramentas`): o que ele
  cita é a cascata em comentário. O smoke é reescrito na fatia de integração. Já
  `docs/handovers/g1-palcos.md` e `fatia-c-rail-cascata.md` citam `shared/rail.ts`/`shared/cascata.ts`
  pelo nome; são registro do que foi feito na v1 e não devem ser editados.

## Onde a evidência cai

A evidência desta fatia é este arquivo, mais `shared/login-cascade.ts` e `shared/shortcuts.ts` com
`test/login-cascade.test.ts` e `test/shortcuts.test.ts`. O critério de aceite do despacho (uma bateria
por regra 1–8, o caso do segundo preenchimento, os três fluxos completos, `digits` com 11 ids e os
dois combos) é o que os testes citados acima afirmam por `leitura`; a corrida de `bun test` cabe ao
coordenador, e a issue que autoriza a frente é `docs/issues/B04-v2-janela-unica-e-ingles.md`.
