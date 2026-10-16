# Fatia G1-palcos — `backend/palcos.ts`, `backend/adaptador.ts`, `test/adaptador.test.ts`

Issue que autoriza: `docs/issues/B02-integracao-backend.md` (status `em-curso`, autoriza tocar
`backend/`). Contrato: `docs/arquitetura.md` §2 (guarda de origin, eval só na origin da entrada) e §4
(`palcos.ts`, `adaptador.ts`); fatos de janela: `docs/tinyjs.md` §2 e §3. Requisitos:
`docs/canonico.md` §7 (rail, palco, troca; RF-19 a RF-22), §8 e §11 (cascata, cofre), §13
(auditoria), §14 (RF-02, RF-04, RF-09, RF-10, RF-25).
Lógica pura consumida: `shared/rail.ts` (`geometria`, `Quentes`, `digitos`, `combo`, `LARGURA_RAIL`),
`shared/cascata.ts` (`novaCascata`, `passoCascata`), `shared/catalogo.ts` (`origemDe`),
`shared/types.ts` (`JANELA`, `PREFIXO_PALCO`, `Entrada`, `EstadoRail`, `EstadoReport`, `Evento`,
`ResultadoLogin`, `SistemaRail`, `TipoEvento`). API do runtime: `backend/tiny.d.ts`.

## Arquivos tocados

- `backend/palcos.ts` (novo) — `criarPalcos(app, deps)`, `DepsPalcos`, `Palcos`.
- `backend/adaptador.ts` (novo) — `scriptAdaptador({ preencher, usuario?, segredo? })`.
- `test/adaptador.test.ts` (novo) — aceite do adaptador (literais JSON, validade sintática e
  execução do script contra um DOM mínimo).
- `docs/handovers/g1-palcos.md` (este arquivo).

Nenhum outro arquivo foi aberto para escrita; `shared/types.ts`, `src/api.ts` e os módulos já
testados ficaram intactos; nenhuma dependência nova.

## Critério de aceite e como foi atendido

Evidência desta fatia: **`leitura`**. Não rodei teste, typecheck, build, linter nem formatador (regra
do despacho: só editar). O que segue é o que o código diz, não resultado observado.

### `backend/palcos.ts` — mapa do despacho para o código

| Regra do despacho | Onde está | Como |
| --- | --- | --- |
| Ids de janela `palco:<entrada>` e `palco:<entrada>:<indice>` | `trocar`, `abrirVista`, `recarregar`, `fechar` | `PREFIXO_PALCO + id` e `PREFIXO_PALCO + ferramentaId + ':' + String(indice)`; casca e carregamento por `JANELA.casca`/`JANELA.carregando` |
| Geometria: `screens()` → `primary` → `visible` → `geometria`; guardada e recalculada em `modoCasca` | `calcularGeometria`, `geometriaAtual`, `modoCasca` | `telas.find(t => t.primary) ?? telas[0]`; `geometria(tela.visible)`; cache em `geo`, refeito no início de `modoCasca` |
| `modoCasca('rail')`: `setSize(LARGURA_RAIL, palco.height)`, `setPosition(rail.x, rail.y)`, `setAlwaysOnTop(true)`, `setResizable(false)` | `modoCasca` | Nessa ordem, sobre `app.window('main')`, tudo dentro de `try` |
| `modoCasca('desbloqueio')`: `setAlwaysOnTop(false)`, `setResizable(false)`, `setSize(420, 560)`, `center()` | `modoCasca` | Nessa ordem; sem geometria envolvida |
| `trocar(id)` recusa entrada fora de `deps.entradas()` | `trocar` | `find` em `deps.entradas()` → `throw new Error('ferramenta não permitida')` |
| Quente: `hide({ app: false })` no ativo, `show()` no destino, marca ativo, `quentes.tocar`, fecha descartados | `ativar`, `descartar` | `ativar` esconde o anterior, mostra o destino, põe no topo do LRU e fecha o que `tocar` descartou |
| Frio: `win.open('palco:'+id, { page, title, x, y, size })` na geometria do palco | `acordar` | `app.win.open(janelaId, { page: endereco, title: titulo, ...posicaoDoPalco(g) })`; `posicaoDoPalco` monta `x`, `y`, `size` de `g.palco` |
| Carregando: abre uma vez, depois só show/hide; `push('carregando', { id, titulo, estado: 'carregando' })` | `acenderCarregando`, `publicarCarregando` | `carregandoAberta` guarda se a janela já foi criada; `setTitle` + `show` a cada carga; push com o id da **entrada** |
| Cascata: `novaCascata(origem)` no frio | `acordar` | `cascata: novaCascata(origem)`, com `origem` de `origemDe(endereco)` (endereço aberto naquela janela) |
| Evento `abriu_ferramenta` | `trocar` | Só quando `acordar` devolveu `true` (a janela nasceu agora) |
| Push `rail` a cada mudança de estado | `publicar` | Chamado no fim de `trocar`, `abrirVista`, `fechar`, `recarregar`, `configurar`, `fecharTodos`, `aoFinish`/`aoReport` (por `terminar`) e `aoFalha`/`aoJanelaFechada` |
| `abrirVista` modo `janela` → palco próprio, mesmo fluxo de frio/quente | `abrirVista` | `acordar` com `PREFIXO_PALCO + ferramentaId + ':' + indice`, título `entrada.titulo · vista.rotulo` |
| `abrirVista` modo `navegar` → garante o palco e faz `eval('location.href = ' + JSON.stringify(endereco))` | `abrirVista` | `acordar` no palco da ferramenta e, se o palco existe, `avaliar(janelaId, 'location.href = ' + JSON.stringify(vista.endereco))`; um eval recusado num palco já carregado vira `falhou` no rail (num palco ainda em carga, quem relata é o `fail` do `onNavigate`) |
| Evento `abriu_vista` | `abrirVista` | Sempre, com `url: vista.endereco` e `detalhe: vista.rotulo` |
| `fechar(id)` fecha a janela e limpa estado | `fechar` | Tira do mapa e do LRU, esconde o carregamento se era o ativo, fecha a janela, publica |
| `recarregar(id)` fecha e reabre frio | `recarregar` | Fecha **todas** as janelas da ferramenta (palco e vistas `janela`), limpa a falha e chama `acordar` |
| `configurar(n)` → `quentes.definirLimite(n)` e fecha os descartados | `configurar` | `descartar(quentes.definirLimite(limite))` |
| `fecharTodos()` fecha todos os palcos e o carregando e zera o estado | `fecharTodos` | Fecha cada palco, esvazia o LRU, fecha `carregando` (`carregandoAberta = false`), zera `ativo`/`logins`/`falhas`/`focadas`, remove os atalhos e publica |
| `aoNavegar` só trata janelas `palco:*` | `aoNavegar` | `startsWith(PREFIXO_PALCO)` e palco existente; qualquer outra janela → `undefined` |
| `policy`: não-http(s) → `'external'`; http(s) → `undefined` | `aoNavegar` | `new URL(url).protocol` em `try`; http(s) permite, o resto vira evento `navegacao_externa` e `'external'` |
| `finish`: alimenta a cascata; primeiro finish esconde o carregando se o palco é o ativo e marca `carregando = false` | `aoFinish` | `p.url = url`, `p.falhou = null`, `if (p.carregando)` → esconde `carregando` (só se `ativo === p.janela`) e zera a flag; depois `passoCascata({ tipo: 'finish', url }, { tem_credencial: true, nao_preencher })` |
| Ação `injetar` → `eval(scriptAdaptador(...))` com a credencial, buscada só quando `preencher`; sem credencial → `preencher: false` | `aplicar` | `deps.credencial(p.entradaId)` só no ramo `injetar` com `preencher`; `credencial === null` → `preencher = false` |
| Ação `resultado` → `login` no sistema do rail e evento `login` | `aplicar` | `logins.set(p.entradaId, resultado)` (é o que `estado()` publica em `SistemaRail.login`) e evento `login` com `resultado` |
| Segurança: só faz eval se a origin de `ev.url` é exatamente a origin da janela | `aplicar` | `origemDe(p.url) === p.origem` antes do eval, em `try` (URL inválida nunca injeta) |
| `fail`/`crash`: `falhou = ev.error ?? 'falha ao carregar'`, push `carregando` `'falhou'`, evento `carregamento_falhou` | `aoNavegar`, `aoFalha` | `aoFalha(p, ev.error ?? FALHA_CARGA)`: marca o palco, acende/push o aviso se o palco é o ativo, registra o evento |
| `aoReport` só aceita janela `palco:*` existente; alimenta `passoCascata({ tipo: 'report' })`; aplica a ação | `aoReport` | Mesmo caminho de `aoFinish` para a ação, por `terminar` |
| `aoJanelaFechada(id)`: palco fechado pela pessoa → remove do estado e do LRU; push `rail` | `aoJanelaFechada` | Remove do mapa, do LRU e das focadas; esconde o carregamento se era o ativo; reavalia os atalhos; publica |
| `aoFoco(janela, focada)`: conjunto das janelas do Bond; registra/remove os atalhos, nunca duas vezes | `aoFoco`, `atualizarAtalhos`, `registrarAtalho` | `focadas` só aceita `main`, `admin`, `paleta`, `carregando` e `palco:*`; com alguma focada registra `digito-1..9` e `paleta`, sem nenhuma remove todos; `registrados` impede registro repetido |
| `aoAtalho('digito-N')` → `trocar` do sistema daquele dígito | `aoAtalho` | `digitos(deps.entradas().map(e => e.id)).get(numero)` → `trocar` |
| `aoAtalho('paleta')` → `win.open('paleta', { page, size: '560x420' })` centrada sobre o palco, ou `show` se já aberta | `aoAtalho`, `abrirPaleta` | `app.windows()` decide entre `show` e abrir; `x`/`y` centram 560×420 sobre `geo.palco` |
| `estado()` monta `EstadoRail` de `deps.entradas()` (ordem dada), `deps.icone`, dígitos, quentes, ativo, carregando, falhou, login | `estado` | Um `SistemaRail` por entrada, na ordem de `deps.entradas()`; `digito` pelo `Map` de `digitos`; `quente` pelo LRU; `ativo` pela entrada do palco ativo; `limite_quentes` do LRU |
| Erros do runtime não derrubam o backend; o efeito entra no estado | `janela`, `abrirJanela`, `fecharJanela`, `esconder`, `mostrar`, `avaliar`, `publicar`, `publicarCarregando`, `evento` | Toda chamada a `app.*`/handle tem `try`; falha de abertura vira `falhas` (`NAO_ABRIU`, aparece em `SistemaRail.falhou`), falha de eval/injeção vira `p.falhou` (`NAO_FALOU`), atalho recusado é ignorado |

### `backend/adaptador.ts` — mapa do despacho para o código

| Regra | Como |
| --- | --- |
| IIFE com valores por `JSON.stringify` | `var dados = <JSON.stringify({preencher[, usuario, segredo]})>;`; nenhuma concatenação de valor em código |
| Campo de senha = primeiro `input[type=password]` visível (`offsetParent !== null` ou `getClientRects().length > 0`) | `acharSenha` + `visivel` |
| Sem senha visível → relata `'sem-formulario'` | Ramo inicial do `try` principal |
| Usuário no mesmo `form` (ou documento): primeiro visível `type` email/text/sem type com `autocomplete`/`name`/`id` casando `/user|email|login|username/i`; senão o primeiro input de texto visível antes da senha | `acharUsuario` (duas passadas: pista primeiro, depois o primeiro campo de texto antes da senha) + `ehTexto` + `pistaDeUsuario` |
| Escrita pelo setter nativo de `HTMLInputElement.prototype.value` + `input`/`change` | `escrever` com `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` e `new Event('input'|'change', { bubbles: true })` |
| Envio: `form.requestSubmit()`, senão clique em `[type=submit]`, senão `form.submit()` | `enviar` |
| Relato por `window.tiny && window.tiny.api.call('login.report', { estado })` em `try` | `relatar` |
| `preencher` com valores → relata `'preenchido'`; com formulário e sem preencher → `'formulario'` | Ramo de preenchimento e `relatar('formulario')` |
| O script não pode lançar para fora | Todo o corpo do miolo está em `try { … } catch { relatar('formulario') }` |
| O script nunca lê nada da página para executar | Só lê `type`/`autocomplete`/`name`/`id` para decidir onde escrever; nenhum dado da página vira código |

### `test/adaptador.test.ts`

| Aceite do despacho | Teste |
| --- | --- |
| Script com `{ preencher: true, usuario: 'a"b', segredo: "x'</script>" }` contém os valores só como literais JSON | `literalDados` fatia o literal de `var dados = …` contando chaves e respeitando string/escape; o teste compara com `JSON.stringify` do objeto e faz `JSON.parse` de volta (`usuario` e `segredo` idênticos aos originais) |
| Não há concatenação crua | O teste prova que cada valor só aparece dentro do literal (fora dele, nem o valor cru nem o JSON) e que o script inteiro não contém `' + ` nem `" + ` |
| O script é sintática e semanticamente válido (`new Function(script)` não lança) | Um teste por combinação (`true` com valores, `true` sem valores, `false`, `false` com valores vazios) com `new Function`; e execução real do script contra um DOM de mentira (inputs falsos, `HTMLInputElement.prototype.value` com acessor, `window.tiny.api.call` de mentira) cobrindo `'sem-formulario'` (sem campo de senha e com senha escondida), `'formulario'` (senha visível sem preencher), `'preenchido'` (preenche usuário e senha, dispara `input`/`change`, chama `requestSubmit` uma vez) e usuário achado pela pista e pelo fallback antes da senha |
| Com `preencher: false` não contém o segredo | Teste dedicado: nem o segredo cru nem o JSON dele aparecem, e o literal é `{"preencher":false}` |
| Bônus fiel ao contrato | `preencher: true` sem os dois valores não embute credencial nenhuma; sem `window.tiny` o script não lança e não relata nada |

## Comando rodado e resultado observado

Nenhum. Por instrução explícita do despacho ("NÃO rode testes, typecheck, build, linter nem
formatador. Só edite."), a evidência é `leitura`. Fica com o coordenador, no fim da fase:
`bun test test/adaptador.test.ts`, `bun test test/` e `bun run typecheck` (`tsc -p tsconfig.json` +
`tsc -p backend/tsconfig.json`), mais o smoke em `test/smoke/` para a superfície real (janela do
palco abrindo, troca, descarte, atalhos e login injetado).

## O que ficou de fora, e por quê

- **`auth.adaptador` específico por entrada** (`shared/types.ts` → `AuthOverride.adaptador`, canonico
  §11): a §4 só define o adaptador genérico `scriptAdaptador({ preencher, usuario, segredo })` — não
  há registro de adaptadores nomeados em lugar nenhum do contrato. `palcos` usa o genérico sempre;
  `auth.nao_preencher` **é** respeitado (entra no `ctx` da cascata). Adaptador específico exige
  assinatura nova: decisão do coordenador.
- **Persistir o limite de palcos quentes**: `configurar` só aplica no LRU em memória (§4 não dá a
  `palcos` acesso a `store`/`repo`); quem guarda o valor entre execuções é o `main.ts`.
- **Título/estado do palco de carregamento por palco**: a janela `carregando` é única e pertence ao
  palco ativo — o aviso de falha de um palco escondido aparece só no rail, não no palco de
  carregamento (ele não pode cobrir uma janela que não é a da frente).
- **Escrita em `index.html`/`src/*`**: nada; a casca e as páginas são de outras fatias.
- **Testes de `palcos.ts`**: a superfície é o runtime de janelas (`app.win`, `app.screens`,
  `app.hotkey`), sem seam puro; o despacho pede a prova por leitura e o coordenador exercita pelo
  smoke. O seam testável do adaptador está em `test/adaptador.test.ts`.

## Desvios e decisões que o coordenador deve conferir

1. **`Quentes` é indexado pelo id da janela** (`palco:<id>`/`palco:<id>:<i>`), não pelo id da
   entrada: é o que faz "id descartado tem a janela fechada" (§4) ser 1:1 com o runtime. O efeito é
   que uma vista em modo `janela` também conta no limite de quentes (RF-22/LRU), e `SistemaRail.quente`
   é verdadeiro se qualquer janela daquela ferramenta está no LRU.
2. **`origem` de cada palco é a origin do endereço aberto naquela janela** (a entrada no palco da
   ferramenta; a vista no palco da vista). A guarda de eval compara `ev.url` com essa origin — a
   mesma que `novaCascata` recebeu —, então o cheque extra nunca contradiz a cascata. Endereço fora
   do contrato (`origemDe` lança) fica com `origem = ''` e **nunca** injeta.
3. **`ctx.tem_credencial: true` fixo no passo da cascata**: a credencial é lida do chaveiro só quando
   a ação é `injetar`. Com `tem_credencial: false` o passo daria `preencher: false`; com o valor fixo
   e a leitura devolvendo `null`, `palcos` rebaixa `preencher` para `false` — mesmo resultado, sem
   uma leitura de chaveiro por carregamento. Quem decide o `preencher` final é `aplicar`.
4. **`recarregar(id)` fecha todas as janelas da ferramenta** (o palco e as vistas em `janela`) e
   reabre frio o palco da ferramenta: o "tentar de novo" do palco de carregamento recebe o id da
   **entrada** (o push `carregando` carrega `id`, não o id da janela), então a recuperação é por
   ferramenta. Se o coordenador quiser recuperar a vista exata, o payload do push muda de contrato.
5. **`abriu_ferramenta` só no frio** (janela nasce agora): trocar entre palcos quentes não gera
   evento, para não inundar a auditoria com uma linha por clique no rail. `abriu_vista` é sempre
   registrado.
6. **`aoJanelaFechada` também trata as janelas fixas**: fechar `carregando` libera a janela para a
   próxima carga, e fechar `main`/`admin`/`paleta` tira a marca de foco e reavalia os atalhos (senão
   um atalho global ficaria registrado sem nenhuma janela do Bond focada). O despacho só citava o
   palco; sem isso o rail ficaria com `⌘1`…`⌘9` registrados depois de fechar a paleta no foco.
7. **`aoAtalho` engole erro de `trocar`**: o disparo vem de um atalho global, sem chamador para
   receber o erro; o efeito da falha de janela já entra no estado do rail.
8. **`terminar` sempre publica** `rail` depois de aplicar a ação (inclusive `resultado`), porque o
   `login` do rail e o `falhou` de uma injeção recusada só aparecem no estado depois disso.
9. **Vista `navegar` num palco que acabou de nascer não marca falha**: o `eval` de
   `location.href` pode ser recusado enquanto o documento da janela nova não existe, e isso não é
   falha de carregamento; o `fail` do `onNavigate` é quem conta essa história.

## O que outro dono (`backend/main.ts`, fatia G3) precisa fazer

1. **`registrar` preenchendo a pessoa**: `palcos` manda `pessoa_id: null` (não conhece a sessão). O
   `registrar` passado a `criarPalcos` deve sobrepor: `(e) => repo.registrarEvento({ ...e, pessoa_id:
   sessao.pessoaAtual()?.id ?? null })` — sem isso a auditoria perde a pessoa (canonico §13, RF-12).
2. **Fios das janelas**: chamar `aoFoco(win, true/false)` no hook de foco, `aoJanelaFechada(id)` no
   hook de fechamento, `aoNavegar(ev)` no `onNavigate` e `aoReport(meta.window, params.estado)` no
   handler de `login.report` (guarda da §2: só janelas `palco:*`).
3. **`onNavigate` das janelas que não são palco**: `palcos.aoNavegar` devolve `undefined` para
   `main`/`admin`/`paleta`/`carregando`; se a casca/admin precisarem de `'external'` para
   `mailto:`/`app://`, o tratamento é do `main.ts`.
4. **`modoCasca('desbloqueio')` no boot e `modoCasca('rail')` ao desbloquear**, e `fecharTodos()` ao
   bloquear.
5. **`janelas.abrir({ qual: 'paleta' })`**: a §4 não dá a `palcos` um método público para abrir a
   paleta, e a centralização sobre o palco está em `aoAtalho('paleta')`. Se o `main.ts` quiser a
   mesma posição vinda da API, o caminho é chamar `palcos.aoAtalho('paleta')` (o atalho é idempotente:
   se a janela já existe, só `show`) — combinação a confirmar com o coordenador.
6. **`configurar(limite)`**: chamar com o valor persistido e guardar o novo valor; `palcos` não
   persiste.

## Onde a evidência cai no handover da frente

Este arquivo, na seção de comando/resultado: `leitura` + os comandos que o coordenador deve rodar
(acima). A prova de superfície real (janela do palco, troca, descarte, atalhos, login injetado)
pertence ao smoke da fatia R/H e vai para o handover da fase F2.

## Correção 2

Sintoma observado pelo coordenador por execução de `TINYJS_DEBUG=1 tinyjs dev`: a cascata inteira
passou na superfície real (palco abriu, `finish`, EVAL do adaptador, formulário enviado, segundo
`finish`, relato `sem-formulario`), mas o relato foi recusado pelo backend:

```
<< CALL palco:ferr-a:2 ["{\"method\":\"login.report\",\"params\":{\"estado\":\"preenchido\"}}","http://127.0.0.1:59486"]
>> RET palco:ferr-a:2 1 "login.report só vale dentro de um palco"
```

### Causa

O id da janela de um palco levava `:`, e o runtime descobre a janela que chamou a API pelo texto
antes do **primeiro** `:` do id da chamada (`~/.tinyjs/runtime/bridge.js:3181`, tinyjs 0.57.2:
`const callerWin = id.includes(':') ? id.slice(0, id.indexOf(':')) : 'main';`). O id da chamada é
`<janela>:<seq>`, então a janela `palco:ferr-a` chegava ao handler de `login.report` como
`meta.window === 'palco'` — que não tem o prefixo `palco_` da guarda da §2. A chamada aparecia na
recusa com o id composto (`palco:ferr-a:2`) e o backend julgava `palco`.

Distância entre causa e sintoma: o sintoma diz "o backend recusou todo relato"; a causa é o
separador do id da janela. O sintoma não nomeia o id nem o runtime; o id só aparece porque o debug
imprime o id da chamada inteiro. Por isso a primeira hipótese — guarda de origin do `aoReport`
recusando a ferramenta — foi descartada: a mensagem é a da guarda de janela do `login.report`
(`backend/main.ts`), que dispara **antes** de qualquer coisa do palco; a cascata tinha acabado de
rodar naquela mesma janela, e a guarda não olha origin. Também descartado o adaptador: o script
chamou `login.report` com `{"estado":"preenchido"}`, que é o parâmetro esperado.

### Mudança

O contrato de `shared/types.ts` já tinha mudado (pelo coordenador): `PREFIXO_PALCO = 'palco_'`,
`idPalco(entrada, vista?)` e `entradaDoPalco(janela)`. O id de janela nunca leva `:`; `_` separa
entrada e vista, e não aparece em id de entrada (slug). Arquivos tocados nesta correção:

- **`backend/palcos.ts`**: toda construção de id de palco passou por `idPalco` — `trocar` e
  `recarregar` (`idPalco(id)`), `fechar` (`idPalco(id)`), `abrirVista` modo `navegar`
  (`idPalco(ferramentaId)`) e a vista em modo `janela`, que era `PREFIXO_PALCO + ferramentaId + ':'
  + String(indice)` e virou `idPalco(ferramentaId, indice)`. Comentários do cabeçalho (linhas 4–5)
  com o formato novo (`palco_<entrada>` / `palco_<entrada>_<indice>`) e apontando `idPalco`. O
  arquivo importa `idPalco` ao lado de `JANELA`/`PREFIXO_PALCO` (o prefixo continua sendo o que
  `aoNavegar`, `aoReport` e `aoFoco` usam para reconhecer janelas de palco). Nenhum mapeamento
  janela→entrada por fatia de texto existe aqui: o mapa `palcos` é indexado pelo id da janela e cada
  `Palco` guarda `entradaId`, então não houve o que trocar por `entradaDoPalco`.
- **`backend/main.ts`** (arquivo do dono G3, listado no despacho desta correção): a função local
  `entradaDePalco` (que fazia `opener.slice(PREFIXO_PALCO.length).split(':')[0]`) foi removida e
  `onWindowOpen` passou a usar `entradaDoPalco` de `shared/types` — `const opener = info.opener; const
  id = opener === undefined ? null : entradaDoPalco(opener);` (`opener?: string` em
  `TinyPopupEvent`). A guarda de `login.report` (`meta.window.startsWith(PREFIXO_PALCO)`) e o resto
  do arquivo não mudaram.
- **`backend/adaptador.ts`**: só o comentário que citava `palco:*` → `palco_*`. Nenhuma linha de
  código.
- **`test/smoke/smoke.html`**: o id de vista do detalhe do passo 9 (`palco:ferr-b:0`) virou
  `palco_ferr-b_0`, nas duas ocorrências (o rótulo e o `sistema(...)`).

Nada de comportamento mudou além dos ids: as chamadas de janela, os maps do LRU/foco e a guarda
continuam iguais; o que mudou é o texto do id. As seções acima deste arquivo (tabela de aceite,
"Desvios", "O que outro dono precisa fazer") continuam escrevendo o formato antigo `palco:<entrada>`
— são o registro do que valia naquela fatia e não foram reescritas; onde elas falam do formato do
id, vale esta correção.

### Confirmação

Evidência: **`leitura`**. Por instrução explícita do despacho ("NÃO rode testes, tsc, build, smoke,
linter nem formatador. Só edite."), não rodei o smoke nem o typecheck. Fica com o coordenador, no
fim da fase: `TINYJS_DEBUG=1 tinyjs dev` com o smoke (`bun test/smoke/rodar.ts`) — o relato
`login.report` de uma janela de palco tem de ser aceito e o debug tem de imprimir o id da chamada
com `palco_` (sem `:`) —, mais `bun run typecheck` (`tsc -p tsconfig.json` + `tsc -p
backend/tsconfig.json`) e `bun test test/`. Conferência por leitura já feita: `grep -n "palco:"
backend test/smoke/smoke.html` só devolve ocorrências que **não** descrevem o formato do id (`{ rail:
Retangulo; palco: Retangulo }`, "popup de palco:", "Acorda um palco:"), e nenhuma construção de id
de janela no backend passa de `idPalco`.

### Onde a evidência cai

Este arquivo, seção de comando/resultado: `leitura` + os comandos acima. A prova de superfície real
(novo `CALL`/`RET` de `login.report`) pertence ao smoke e será do runner, na fase F2.

## Correção 3

Sintoma observado pelo coordenador por execução de `bun test/smoke/rodar.ts` (superfície real): os
passos 1–8 passaram; o passo 9 falhou por esgotamento de tempo, com
`palco_ferr-b_0.login = null` e eventos `login de ferr-b = ["sessao","sessao"]`.

```
FALHOU 9 rail.abrirVista (SSO/provedor) (20092 ms) erro: tempo esgotado (20000 ms); último estado: palco_ferr-b_0.login=null, eventos login de ferr-b=["sessao","sessao"]
```

A vista abre `origemB/sso`, que responde 302 para o provedor (outra origin), que responde 302 de
volta para `origemB/sso/volta`, que responde 303 para `/painel`. Nenhum documento do provedor chega
a carregar.

### Causa

A cascata do palco só recebia `finish` e `report` neste arquivo: `aoNavegar` tratava `policy`
(permitir ou mandar para fora) e `finish` (alimentar a cascata), e ignorava `start`. Como a
navegação que sai da origin não carrega documento do provedor, **não havia `finish` fora da origin**
— e portanto `saiu_da_origem` nunca ficava verdadeiro. No `finish` final, na própria origin, o
relato `sem-formulario` caiu na regra 4 com `saiu_da_origem = false` e `tentativas = 0`, isto é,
`sessao` em vez de `provedor` (docs/arquitetura.md §3, regra 4). O passo 9, que espera o evento
`login` com resultado `provedor`, esperou até o limite.

Distância entre causa e sintoma: o sintoma fala de um passo que não termina e de um login `sessao`;
a causa é um sinal de navegação que o backend não repassava à cascata. O trace com
`TINYJS_DEBUG=1` mostra o que o runtime oferecia e ninguém consumia: uma pergunta de política
(`NAVQ` → `onNavigate` com `kind: 'policy'`) **para cada salto de redirect, inclusive o alvo do
303**, e o `start` da navegação. Hipóteses descartadas: (a) o runtime não pergunta a política nos
redirects — descartada pelo próprio trace, que mostra `NAVQ` por salto; (b) o provedor não responde
— descartada porque o sintoma é de espera, não de falha de carga, e porque a volta ao `origemB/sso/volta`
e o 303 para `/painel` só existem se o provedor respondeu; (c) a guarda de origin do `aplicar`
recusando a injeção final — descartada porque o resultado final foi `sessao`, que é a regra 4 com a
origin casando, não um `falhou`.

### Mudança

Contrato: `docs/arquitetura.md` §3 — o sinal `{ tipo: 'navegou'; url }` e a regra 2b (o coordenador
acrescentou ambos; a lógica pura já está em `shared/cascata.ts`, com testes em
`test/cascata.test.ts`). Arquivos tocados nesta correção:

- **`backend/palcos.ts`** — só `aoNavegar`:
  - `kind 'policy'` com URL http(s): antes de devolver, alimenta a cascata com
    `{ tipo: 'navegou', url: ev.url }` quando `ev.isMainFrame !== false`, com o mesmo `ctx`
    (`tem_credencial: true`, `nao_preencher` da entrada) e o mesmo fecho de passo dos outros sinais
    (`p.cascata = passo.estado` e `void terminar(p, passo.acao)`). O retorno da política não mudou:
    `undefined` para http(s), `'external'` (com o evento `navegacao_externa`) para os outros
    esquemas.
  - `kind 'start'`: mesmo tratamento, com o mesmo sinal e o mesmo filtro de main frame.
  - `finish`, `fail` e `crash` inalterados; `aoFinish`, `aoReport`, `aplicar` e `terminar`
    inalterados.
  - O passo da cascata roda dentro do `try`/`catch` de protocolo? Não: `passoCascata` é lógica pura
    de `shared/`, não lança, e a única leitura que pode lançar (`deps.entradas()`) é a mesma que
    `aoFinish`/`aoReport` já faziam sem `try`. Nada aqui é `await`: a resposta à política sai na
    mesma volta (o runtime permite ~400 ms e fecha a pergunta por conta própria se passar disso —
    `TinyNavEvent` em `backend/tiny.d.ts`); `terminar` é disparado, não aguardado.
  - `null` em `isMainFrame` conta como main frame: o filtro é `!== false`, exatamente o do
    despacho (o runtime devolve `null` quando a engine não sabe dizer, e `policy` de http(s) que
    chega ao hook é de main frame por definição — `backend/tiny.d.ts`).
- **`docs/handovers/g1-palcos.md`** (este arquivo) — esta seção.

### Confirmação

Evidência: **`leitura`**. Por instrução explícita do despacho ("NÃO rode testes, tsc, build, smoke,
linter nem formatador. Só edite"), não rodei o smoke, o typecheck nem `bun test`. O que segue é o que
o código diz, não resultado observado.

Por leitura, o passo 9 da vista `SSO` passa a contar a história assim: a pergunta de política do
salto para o provedor traz uma URL de outra origin → regra 2b →
`saiu_da_origem = true` e ação `nada`; os saltos de volta e o 303 para `/painel` são na própria
origin (`origemB`) → ação `nada`, estado preservado; o `finish` de `/painel` → ação `injetar`; o
relato `sem-formulario` do adaptador → regra 4 com `saiu_da_origem = true` → resultado `provedor`,
que é o evento `login` que o passo 9 espera (marco: `[INFERENCE]` — é a leitura do código contra o
trace do coordenador, não execução).

Fica com o coordenador, no fim da fase: `bun test/smoke/rodar.ts` (o passo 9 tem de terminar com o
evento `login` de `ferr-b` com resultado `provedor`), mais `bun run typecheck` (`tsc -p
tsconfig.json` + `tsc -p backend/tsconfig.json`) e `bun test test/`. Conferência por leitura já
feita: `aoNavegar` devolve exatamente os mesmos valores de antes para as mesmas entradas dos ramos
antigos; os dois ramos novos devolvem `undefined` (policy http(s)) e `undefined` (`start`), e o
`'deny'` do tipo de retorno continua não sendo produzido por este arquivo; nenhum `await` foi
introduzido.
