# Fatia C — rail e cascata (`shared/rail.ts`, `shared/cascata.ts`)

Dono: fatia C (rail e cascata). Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md`
(`em-curso`). Contrato: `docs/arquitetura.md` §3. Vocabulário: `CONTEXT.md` (rail, palco, troca,
cascata de login). Requisitos: `docs/canonico.md` §7 (RF-22), §8 e §11.

## Arquivos tocados

- `shared/rail.ts` (novo) — `LARGURA_RAIL`, `Retangulo`, `geometria`, `Quentes`, `digitos`, `combo`.
- `shared/cascata.ts` (novo) — `EstadoCascata`, `SinalCascata`, `AcaoCascata`, `novaCascata`,
  `passoCascata`.
- `test/rail.test.ts` (novo) — geometria, LRU, dígitos e combos.
- `test/cascata.test.ts` (novo) — uma bateria por regra numerada de `docs/arquitetura.md` §3 e os
  dois fluxos completos (formulário e provedor).
- `docs/handovers/fatia-c-rail-cascata.md` (este arquivo).

Nenhum outro arquivo foi aberto para escrita; nenhuma dependência nova; `shared/types.ts` e
`src/api.ts` intactos.

## Critério de aceite e como foi atendido

Evidência por `leitura` (o contrato da fase proíbe executar testes/typecheck nesta fatia): o que
segue é o que o código e os testes dizem, não resultado observado de execução.

### `shared/rail.ts`

- `LARGURA_RAIL = 72`; `Retangulo = { x, y, width, height }`; `type Id` importado de
  `shared/types.ts` com `import type`.
- `geometria(visivel)`: `rail = { x, y, 72, height }` encostado na esquerda; `palco` começa em
  `visivel.x + LARGURA_RAIL` e tem `visivel.width - LARGURA_RAIL`; todos os campos passam por
  `Math.round`. Teste `test/rail.test.ts` cobre `{x:0,y:25,width:1440,height:875}` → rail
  `{0,25,72,875}` e palco `{72,25,1368,875}`, o arredondamento com offsets fracionários
  (`x:10.6, y:0.5, height:700.5`) e a invariante `palco.x + palco.width = visivel.x + visivel.width`.
- `Quentes`: LRU sobre um vetor de ids, do mais recente para o mais antigo. `tocar(id)` remove a
  ocorrência anterior, insere no topo e devolve os descartados do fim (o recém-tocado nunca sai,
  porque o limite mínimo é 1 e ele está no índice 0). `remover(id)` idempotente. `lista()` devolve
  cópia. `definirLimite(n)` reaplica o mínimo e devolve os descartados do fim. `limite` é getter;
  construção e `definirLimite` usam `Math.max(1, Math.floor(...))`.
- `digitos(ids)`: `Map<number, Id>` de 1 a 9 na ordem dada; do 10º em diante é ignorado (11 ids →
  9 entradas, `1 → primeiro`).
- `combo(tecla, os)`: `'cmd+' + tecla.toLowerCase()` no macOS, `'ctrl+' + tecla.toLowerCase()` em
  `windows` e `linux`.

Aceite de rail coberto: `Quentes(3)` com `a,b,c,d` descarta `['a']`; tocar `b` de novo não descarta
e o topo vira `b`; `lista()` do mais recente ao mais antigo; `definirLimite(1)` descarta todos menos
o mais recente; `new Quentes(0).limite === 1`; `digitos` com 11 ids → 9 entradas; `combo('1','macos')
=== 'cmd+1'` e `combo('K','linux') === 'ctrl+k'`.

### `shared/cascata.ts`

Seis regras aplicadas na ordem de `docs/arquitetura.md` §3, com um teste por regra em
`test/cascata.test.ts`:

1. `resultado !== null` → `{ tipo: 'nada' }` e estado devolvido igual ao recebido (testado com
   `finish` na origem, `finish` fora e os três `report`).
2. `finish` com origin ≠ `origem` → `saiu_da_origem = true` e `nada`; o estado recebido não é
   mutado. Origin obtida por `new URL(url).origin`; URL inválida cai no `catch` e conta como origin
   diferente (`''` nunca casa com a origem validada da entrada) — há teste para `'não é uma url'`.
3. `finish` na `origem` → `{ tipo: 'injetar', preencher: tem_credencial && !nao_preencher &&
   tentativas === 0 }`; testado com credencial e 0 tentativas (`true`), sem credencial
   (`false`), com `nao_preencher` (`false`) e com `tentativas = 1` (`false`).
4. `report 'sem-formulario'` → `provedor` se `saiu_da_origem` (tem prioridade mesmo com tentativas),
   senão `preenchido` se `tentativas > 0`, senão `sessao`; o `resultado` entra no estado devolvido e
   na ação, que é `{ tipo: 'resultado', resultado }`.
5. `report 'preenchido'` → `tentativas + 1`, ação `nada`, `resultado` continua `null`.
6. `report 'formulario'` → `falhou` se `tentativas > 0`, senão `manual`, com `tentativas` preservado.

`passoCascata` nunca muta `e`: devolve `e` quando nada muda e um objeto novo quando muda (um teste
congela o estado com `Object.freeze` antes de passar por `finish`/`report`, o que em módulo ESM
estoura se houver escrita). Fluxo completo do aceite coberto nos dois sentidos: `finish(origem)` →
`injetar(preencher: true)` → `report preenchido` (tentativas 1, `nada`) → `finish(origem)` →
`injetar(preencher: false)` → `report sem-formulario` → `resultado 'preenchido'`; e o caminho do
provedor: sair da origem → `saiu_da_origem` → `report sem-formulario` → `resultado 'provedor'`.

## Comando rodado e resultado observado

Nenhum. Por instrução explícita do despacho desta fatia ("NÃO rode testes, typecheck, linter nem
formatador. Só edite."), a evidência acima é `leitura`; a execução de `bun test test/rail.test.ts
test/cascata.test.ts` fica com o coordenador, no gate de fim de fase.

## O que ficou de fora, e por quê

- **Fechar/reabrir janelas ao descartar um palco quente** — `Quentes` só diz *quais* ids saíram; a
  ação sobre as janelas é de `backend/palcos.ts` (`docs/arquitetura.md` §4), de outro dono.
- **Persistir a cascata entre navegações, registrar evento de `login` e chamar o `eval` do
  adaptador** — `shared/cascata.ts` é puro: guarda o estado quem chama (`backend/palcos.ts`), como
  a assinatura do §3 exige (devolve `{ estado, acao }`).
- **Validação da origem da entrada** — `passoCascata` compara strings de origin; validar `https` é
  de `shared/catalogo.ts` (`origemDe`), de outro dono. Por isso não há import entre os dois módulos.
- **`auth.adaptador` específico e o conteúdo do script do adaptador** — de `backend/adaptador.ts`;
  a cascata só decide `preencher: true | false`.

## Correção

Falha delimitada observada pelo coordenador por execução de `bun test/smoke/rodar.ts` (superfície
real), no passo 9 da corrida:

```
FALHOU 9 rail.abrirVista (SSO/provedor) (20092 ms) erro: tempo esgotado (20000 ms);
último estado: palco_ferr-b_0.login=null, eventos login de ferr-b=["sessao","sessao"]
```

### Causa

A vista abre `origemB/sso` → 302 para o provedor (outra origin) → 302 de volta para
`origemB/sso/volta` → 303 para `/painel`. Nenhum documento do provedor chega a carregar, então não
há `finish` fora da origin; e a regra 2 da cascata só aprendia "saiu da origin" por `finish`. Sem
essa marca, `saiu_da_origem` continuava `false` e a regra 4 (`report 'sem-formulario'`) concluía
`sessao` em vez de `provedor` — duas vezes, exatamente os `["sessao","sessao"]` do sintoma.

Distância entre causa e sintoma: o sintoma diz "tempo esgotado" e um `login` ausente; a causa é o
sinal de política que a cascata não aceitava.

O runtime já entrega o sinal, e o contrato §3 já o descrevia: no trace de `TINYJS_DEBUG=1` o runtime
emite uma pergunta de política (`NAVQ` → `onNavigate` com `kind: 'policy'`) para cada salto de
redirect, inclusive o alvo do 303, e `start` para a navegação. Faltava `SinalCascata` aceitar esse
sinal e aplicar a regra 2b.

Hipóteses descartadas, com o motivo: (a) o `onNavigate` não veria o redirect — vê, o `NAVQ` aparece
no trace a cada salto; (b) o provedor estaria bloqueado pelo gate de origin — a navegação chega a
`/painel`, o que só acontece se os saltos foram permitidos; (c) falha do adaptador — o passo 9 nem
chega a injetar, porque a cascata conclui antes.

### Mudança

`shared/cascata.ts`:

- `SinalCascata` ganha `| { tipo: 'navegou'; url: string }` (policy/start de main frame, inclusive
  cada salto de redirect), como o §3 descreve.
- Regra 2b em `passoCascata`: com `resultado` já definido continua valendo a regra 1 (`nada`);
  `navegou` com origin ≠ `origem` → `saiu_da_origem = true` e `nada`; `navegou` na própria `origem`
  → `nada` sem mudar o estado. Como as demais regras, não muta `e`: devolve `e` quando nada muda e
  um objeto novo quando muda.
- A obtenção da origin (`new URL(url).origin`, URL inválida → `''`, que nunca casa com a origin da
  entrada) saiu do corpo do `finish` para o helper local `originDeUrl`, agora usado pelas regras 2 e
  2b — antes eram duas cópias da mesma regra.
- Comentário de cabeçalho passa a citar os três sinais (`finish`, `navegou`, `report`).

`test/cascata.test.ts` — quatro testes novos, sem alterar nenhum existente, mais o helper `navegar`
no mesmo padrão de `chegar`/`relatar`:

- `2b. navegou para outra origin marca saiu_da_origem e devolve nada` (estado recebido intacto);
- `2b. navegou com URL inválida conta como origin diferente da entrada`;
- `2b. navegou na própria origin não muda o estado` (inclusive com `saiu_da_origem` já `true`);
- `2b. fluxo SSO silencioso: redirects até o provedor e de volta, sem finish no provedor` —
  `navegou(origem/sso)` → `navegou(provedor/authorize)` → `navegou(origem/sso/volta)` →
  `finish(origem/painel)` → `injetar(preencher: true)` → `report sem-formulario` →
  resultado `provedor`, `tentativas` 0;
- `2b. com resultado definido, navegou é nada e não toca o estado`.

### Confirmação

Nenhuma por execução: o despacho desta correção proíbe rodar testes, typecheck, linter, build e
formatador ("NÃO rode testes, tsc, build, smoke, linter nem formatador. Só edite."). A evidência
acima é `leitura` do código, do contrato §3 e do trace do runtime relatado pelo coordenador — nada
aqui foi observado em execução por esta fatia. A confirmação que fecha o critério fica com o
coordenador: `bun test test/cascata.test.ts` (os cinco casos 2b) e o passo 9 do smoke na superfície
real.

### O que não foi tocado

- **`backend/palcos.ts`** (outro dono): as duas chamadas a `passoCascata` — o `finish` do
  carregamento e o `report` do adaptador — continuam emitindo só `finish`/`report`. Sem uma terceira
  chamada com `{ tipo: 'navegou', url }` no `onNavigate` `policy`/`start` de main frame, a regra 2b
  fica sem quem a alimente e o passo 9 continua reprovando. A união é aditiva: o que já existe lá
  compila sem mudança.
- **`docs/arquitetura.md` §3** (dono: coordenador): a linha do `navegou` e a regra 2b já estavam no
  contrato quando esta correção começou; nada foi escrito ali.
- **`shared/types.ts`**: intacto.

### Onde a evidência cai

Esta seção, no handover da fatia C, é a evidência da correção (`shared/cascata.ts`,
`test/cascata.test.ts`). O critério de aceite é o passo 9 de `bun test/smoke/rodar.ts`, cuja
evidência de corrida cabe ao coordenador (`docs/handovers/h-smoke.md`) e à issue que autoriza a
fatia, `docs/issues/B01-modulos-puros-e-frontend.md`.
