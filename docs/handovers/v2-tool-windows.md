# Fatia v2-tool-windows — janelas de ferramenta, cascata e atalhos

Dono: fatia v2-tool-windows. Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md`
(`em-curso`). Contrato: `docs/arquitetura.md` §4 (`backend/tool-windows.ts`,
`backend/login-adapter.ts`) e §2 (eval só na origin da entrada, guarda de janela); requisitos:
`docs/canonico.md` §7 (janela de ferramenta, atalhos, restauração, bloqueio), §8 e §11 (cascata,
cofre), §10 (visibilidade), §13 (auditoria), §14 (RF-06, RF-09, RF-10, RF-19 a RF-21, RF-25);
ameaças: §20 (D1, D2, D3, A7, A8, A10, A20, P7, P9). Vocabulário: `CONTEXT.md` (janela de
ferramenta, sidebar, cascata de login, adaptador de login, evento).

## Arquivos tocados

- `backend/tool-windows.ts` (novo) — `createToolWindows(app, deps)`, `ToolWindowsDeps`,
  `ToolWindows`: `state`, `open`, `openView`, `close`, `reload`, `closeAll`, `restore`, `reconcile`,
  `onNavigate`, `onReport`, `onPopup`, `onWindowClosed`, `onFocus`, `onHotkey`. Substitui
  `backend/palcos.ts`.
- `backend/login-adapter.ts` (novo) — `adapterScript({ fill, origin, username?, secret?, waitMs? })`.
  Substitui `backend/adaptador.ts`.
- `test/tool-windows.test.ts` (novo) — o módulo contra um `TinyApp` de mentira que registra cada
  chamada de runtime.
- `test/login-adapter.test.ts` (novo) — literais JSON, validade sintática e execução do script
  contra um DOM mínimo, com um relógio controlado pelo próprio teste.
- `backend/palcos.ts`, `backend/adaptador.ts`, `test/adaptador.test.ts` — apagados.
- `docs/handovers/v2-tool-windows.md` (este arquivo).

Nenhum outro arquivo foi aberto para escrita; nenhuma dependência nova; `shared/types.ts`,
`backend/tiny.d.ts`, `src/api.ts` e `src/ui.ts` intactos.

## Como o critério de aceite foi atendido (evidência: `leitura`)

### Geometria (1280×800, 90% da tela da `main`, cascata +28 px)

`geometry()` lê `app.screens()` e `app.win.getState()`; escolhe a tela com maior área de interseção
com a moldura da `main` (empate ou nenhuma interseção → primária; sem janela `main` → primária, no
canto útil dela) e devolve `x = main.x + 28`, `y = main.y + 28`,
`width = min(1280, round(0.9 · visible.width))`, `height = min(800, round(0.9 · visible.height))`.
`createWindow` passa `page`/`title` e, quando há geometria, `x`/`y`/`size` para `app.win.open` e logo
depois chama `setPosition`/`setSize` no handle, com o motivo registrado em comentário (a v1 observou
por execução que o launcher ignora `x`/`size` do `win.open`). Testes: `opening` (cascata 128/108 e
`1280x800`, mais `setPosition`/`setSize` no handle), o teto de 90% numa tela de 1024×600 (`922x540`),
a tela que contém a `main` (duas telas, `1528/128`) e o caso sem janela `main` (`0/25`).

### RF-19 — abrir o que já está aberto só traz para a frente

`open()`/`openTool()` devolvem `show()` quando a janela existe, sem `eval` nenhum; um `opening` (Set)
impede duas aberturas simultâneas do mesmo id. Teste: abrir duas vezes → um `win.open`, um `show`,
zero `eval`.

### Cascata (A7, A10, D3) e credencial

`stepCascade` é alimentado em `policy`/`start` de main frame (`navigated`) e em `finish` de main
frame com `isMainFrame !== false` (`finished`), e em `onReport` (`report`). A ação `inject` só roda
com a última URL vista na origin da entrada; a credencial é lida **só quando `fill`** e, **depois do
`await`**, a janela é reconferida no mapa e a última URL é reconferida na origin da entrada antes do
`eval` (D3). O script recebe `origin` explícito. Injeção com `fill` arma um relógio de 4 s: nenhum
`finish` nesse prazo alimenta `{ type: 'finished', url: lastUrl }` (A7), e um `finish` real cancela o
relógio. `eval` recusado → evento `login` com resultado `failed` (A10), sem segundo preenchimento (a
tentativa foi contada no passo da cascata). Ação `result` → `ToolStatus.login` + evento `login`.
Testes: uma injeção com `"fill":true` e uma releitura de chaveiro só na primeira; segundo `finish`
com `"fill":false` e sem o segredo no script; `noFill` da entrada (override) sem leitura de chaveiro;
sem credencial o script ainda inspeciona a página (`"fill":false`); `eval` recusado → evento
`login`/`failed` e nenhuma segunda leitura de chaveiro; relato de outra origin ignorado (P9) e
relato da origin fechando a cascata em `filled`; relato de janela que não é nossa ignorado; sair da
origin bloqueia a injeção até a janela voltar, e ao voltar o `no-form` fecha em `provider`; o
relógio de 4 s (`vi.advanceTimersByTime`) só dispara depois de 4000 ms e não arma outro; a janela
fechada leva o relógio embora.

### Navegação (D2, A20) e popups (D1)

`onNavigate` só age em janelas de ferramenta: `http:` fora de loopback → `deny` + `navigation_blocked`;
`https:` e `http:` de loopback → permitido (e o sinal de cascata sai); `mailto:`/`tel:` de main frame
→ `external` + `external_opened`; qualquer outro esquema (ou `mailto:` de subframe) → `deny` +
`navigation_blocked`; main window → `undefined`. `onPopup` só decide para `opener` que é janela de
ferramenta viva: fora de `http(s)` → `deny`; `window` quando a origin é a da entrada, uma origin de
provedor já vista naquela janela (`seenOrigins`) ou `isIdentityPath(url)`; senão `external` +
`external_opened`; `kind 'open'` com `action 'window'` guarda a janela para o bloqueio. Todo evento
guarda `auditUrl(url)` — nunca a URL crua (query e fragmento ficam de fora). Testes: mailto/tel
externos e `javascript:`/`smb:` negados com os eventos certos; `mailto:` de subframe negado; `http://`
fora de loopback negado e `https://`/`http://127.0.0.1` permitidos; tela principal e janela
desconhecida fora do módulo; popup de mesma origin, de origin de provedor já vista e de caminho de
identidade viram janela; outra origin vai para o navegador; popup rastreado fechado no `closeAll`.

### Persistência, `closeAll`, `restore`, `reconcile`, `reload`

`persist()` reescreve `open_tools` a partir do mapa de janelas vivas a cada abrir/fechar;
`closeAll()` (bloqueio) fecha janelas de ferramenta e popups rastreados e **não** escreve a lista;
`close(id)` e o fechamento pela pessoa (`onWindowClosed`, que só encontra janelas ainda no mapa)
reescrevem a lista. `restore()` lê a lista, ignora o que não está visível, reabre o resto (vista em
modo `window` na própria janela dela) e reescreve a lista já filtrada; uma lista corrompida no store
não quebra o desbloqueio. `reconcile()` fecha as janelas de ferramentas que saíram de `entries()` e
podoa a lista; com nada visível (bloqueado) ele não toca na lista. Testes: `close` e fechamento pela
pessoa tirando da lista; evento tardio de janela fechada por nós sem tocar na lista; `closeAll`
mantendo a lista e `restore` reabrindo só o visível; `restore` reabrindo uma vista na janela dela;
store com lixo; `reconcile` fechando a janela que saiu e mantendo a lista no bloqueio; `reload`
fechando e reabrindo frio.

### Estado (`ToolsState`)

`state()` devolve, por entrada visível: `id`, `title`, `icon` (`deps.icon`), `digit` (1..9 via
`digits`), `openWindows`, `loading` (até o primeiro `finish`; `fail`/`crash` → `error` + evento
`load_failed` com `auditUrl`), `error` (a mensagem estável `failed to load`, ou
`could not open the tool window` quando o launcher recusa a janela) e `login`. O módulo publica
`tools` por conta própria (`app.push`) nas mudanças de estado, porque `deps` não recebe callback de
push (§4); o `record` sai com `personId: null` e quem preenche a pessoa é o `backend/main.ts`.

### Atalhos globais (canonico §7)

Registra `digit-1`..`digit-9` e `palette` com `combo(N, os)` só quando `deps.hotkeys` e há alguma
janela do Bond (a `main`, janela de ferramenta viva ou popup rastreado) focada; `unregister` quando
nenhuma está; nunca registra o mesmo id duas vezes. `onHotkey('palette')` mostra a `main` e publica
`palette`; `digit-N` abre a ferramenta da posição N. Testes: registro único com foco, liberação ao
perder o último foco, janela que não é nossa não segura os atalhos, capacidade falsa não registra
nada, dígito abrindo a ferramenta da posição e a paleta mostrando a `main`.

### `backend/login-adapter.ts`

`adapterScript` monta uma IIFE com `var data = <JSON>` (valores só por `JSON.stringify`; `fill` só
vira `true` quando os dois valores vêm juntos) e `var waitMs` (padrão 3000; `waitMs` é parâmetro de
teste do despacho). Sai sem fazer nada se `location.origin !== data.origin` ou
`window.top !== window`; espera por `input[type=password]` visível com `MutationObserver` (quando
existe) e teto de `waitMs`, então relata `no-form`; com o campo e sem `fill` relata `form`; com
`fill` acha o usuário (mesmo `form`, por `autocomplete|name|id` casando `user|email|login|username`,
senão o primeiro campo de texto visível antes da senha), escreve pelo setter nativo +
`input`/`change` e **só envia quando a origin de `form.action` (ou do documento, sem action) é a da
página** (P7) — `requestSubmit()`, senão `[type=submit]`, senão `form.submit()` — e relata `filled`;
formulário com action de outra origin não recebe nem a senha nem o envio, e relata `form`; exceção →
`error`. O relato é `window.tiny && window.tiny.api.call('login.report', { state })`. Testes: literal
JSON idêntico com `a"b`, `x'</script>` e `\u2028`; valores só dentro do literal (nenhuma
concatenação); segredo ausente com `fill:false`; `new Function(script)` válido nas quatro
combinações; origin diferente e frame que não é o de cima não relatam nada (nem agendam espera); DOM
quebrado → `error`; sem `window.tiny` não relata e não lança; sem campo → `no-form` só quando a
espera vence (o relógio é do teste); campo escondido não conta; `form`, `filled` (com
`input`/`change` e um envio), usuário por pista e por posição, action de outra origin sem escrita e
sem envio, action absoluta da própria origin enviando, e os dois fallbacks de envio.

## Comando rodado e resultado observado

Nenhum. O despacho da fatia proíbe executar teste, typecheck, build, smoke, linter ou formatador
("**DO NOT run tests, typecheck, build, smoke, linter or formatter. Only edit.**"). Toda a evidência
acima é `leitura` do contrato, do código e dos testes escritos. Fora do repositório, apenas três
leituras de fato, sem tocar no app: `~/.tinyjs/runtime/bridge.js` usa `setTimeout(fn, ms)` e
`clearTimeout(handle)` no escopo do backend (linhas 346, 355, 2591, 2776), e `backend/tsconfig.json`
não fixa `lib`, então o typecheck do backend enxerga esses globais pela lib padrão do `target`
(ES2022.Full, que inclui DOM) — por isso `tool-windows.ts` não declara temporizador nenhum e o
relógio de 4 s sai de `setTimeout`/`clearTimeout` diretos. A confirmação que fecha o critério fica com
o coordenador no gate: `bun test test/tool-windows.test.ts test/login-adapter.test.ts` e, no fim da
fase, `bun test test/`, `bunx tsc -p tsconfig.json`, `bunx tsc -p backend/tsconfig.json`,
`bun run app:build` com e sem seed e `bun test/smoke/run.ts`.

## Decisões de fatia (contrato omisso) e o que ficou de fora

- **Eventos `tool_opened`/`view_opened` saem daqui.** O §4 não diz quem os grava e o `canonico §13`
  exige "abriu ferramenta / abriu vista". Só este módulo sabe se a janela nasceu agora ou apenas
  voltou à frente, então a gravação ficou aqui; `backend/main.ts` (fatia v2-main) não grava nenhum
  dos tipos deste módulo — conferido por leitura. Combinei o limite com a v2-main por mensagem.
- **Vista em modo `navigate`** é a janela da ferramenta (id sem índice) e vai para a lista como
  `{ toolId }`; só vista em modo `window` gera `{ toolId, view }`. Restaurar uma vista que virou
  `navigate` (ou sumiu) reabre a ferramenta na URL da entrada.
- **`close(id)` não fecha popups** daquela ferramenta: o §4 só manda fechar popups no bloqueio (D1);
  `close` fecha "toda janela da ferramenta" (janela própria + vistas em `window`).
- **`reload(id)`** fecha janela e vistas em `window` e reabre frio na URL da entrada (como a v1); o
  resultado de login da sessão daquela ferramenta **não** é apagado (só `closeAll` limpa).
- **Falha de `eval`** grava o evento `login`/`failed` (A10) e **não** mexe em `ToolStatus.login` nem
  em `error` — o contrato só pede o evento, e `error` é "mensagem da última falha de carga".
- **Falha ao abrir a janela** (`app.win.open` lança) vira `error` = `could not open the tool window`
  no `ToolStatus` e evento `load_failed`/`failed`; o §4 descreve `fail`/`crash` para o `error`, mas
  não diz o que fazer quando o launcher recusa a janela, e a v1 já tratava esse caso no estado.
- **`waitMs`** existe só para o teste do adaptador (pedido do despacho); o script real usa 3000.
- **Não entrou**: bandeja, janela `main`, ícones, guarda de API, seed e release (de outras fatias);
  `docs/handovers/g1-palcos.md` cita `backend/palcos.ts`/`backend/adaptador.ts` pelo nome e é
  registro da v1 — não foi editado.

## Onde a evidência cai

Este arquivo, mais `backend/tool-windows.ts`, `backend/login-adapter.ts`,
`test/tool-windows.test.ts` e `test/login-adapter.test.ts`. O critério de aceite do despacho
(geometria, RF-19, as quatro políticas, cascata com o relógio de 4 s, persistência/restauração,
reconciliação, atalhos e o adaptador com DOM de mentira) é o que os testes acima afirmam por
`leitura`; a corrida dos gates cabe ao coordenador.

## Fix

Causa (duas, e nenhuma no módulo). (1) As asserções `expect(env.records).toEqual([])` de "a popup
outside a tool window is left to the configured mode" e de "a report from a window that is not ours
is ignored" pressupunham lista vazia, mas o `open('kanban')` do próprio teste já grava
`tool_opened` (`backend/tool-windows.ts:381`, origem da gravação declarada em "Decisões de fatia"
acima): a lista de eventos nunca começa vazia depois de abrir uma ferramenta, então o que a regra
pede é *nenhum evento novo*, não *nenhum evento*. (2) No teste da D1, `handle(env, 'pop_1')` só lê o
mapa `handles` do fake, e o fake só registra handle em `app.win.open` e em `app.window(id)`; a
janela do popup é criada pelo runtime (não passa por `win.open`), então o mapa não tinha `pop_1`
antes de o próprio módulo chamar `app.window('pop_1')` — o que só acontece dentro do `closeAll`,
depois da linha que capturava o handle. O fake não modelava a janela que o runtime abre sozinho.

Mudança (só `test/tool-windows.test.ts`; `backend/tool-windows.ts` intacto, porque a leitura mostra
que ele já grava `tool_opened` ao criar a janela e já fecha os popups rastreados no `closeAll`
(`:784-788`) por `closeWindow` → `app.window(id).close()` (`:159-167`)): (a) `FakeEnvironment`
ganhou `spawnWindow(id): FakeHandle`, que expõe o `handle` interno do fake (get-or-create) e modela
a janela nascida do runtime, não de `win.open`; (b) os dois testes de `records` tiram a baseline
`const recorded = env.records.length` depois do `open` e afirmam `toHaveLength(recorded)`; (c) o
teste da D1 chama `env.spawnWindow('pop_1')` antes do evento `open` (a janela existe antes de o
evento chegar ao módulo) e segue afirmando `popupHandle.close === 1` e `handles.has('pop_1') ===
false` depois do `closeAll`. Nenhum outro teste foi tocado.

Evidência: `leitura` — o `record(entry.id, 'tool_opened', auditUrl(entry.url), null, null)` em
`openTool` (`grep tool_opened backend/tool-windows.ts` → `:381`), o `for (const popup of [...popups])
… closeWindow(popup)` do `closeAll` (`:784-788`), o `handle(id)` do fake
(`test/tool-windows.test.ts:149-155`) e o helper de leitura estrita `handle(env, id)` (`:254-257`),
que lança `no fake handle for ${id}` quando o mapa não tem a janela — a mensagem do erro observado.
Não rodei teste, `tsc`, build, smoke, linter nem formatador: a corrida dos gates é do coordenador
(`bun test test/tool-windows.test.ts`).

## Fix 2

Sintoma reproduzido pelo coordenador na corrida do smoke real (`bun test/smoke/run.ts`):

```
ok     6 tools.open (tool-a, form) (3279 ms) tool-a opened filled
FAILED 7 tools.open (tool-b, session) (20241 ms) error: timeout (20000 ms); last state: tool-b.login="filled"
```

O passo 7 (`test/smoke/smoke.html:235-245`) espera `loginOf(s, 'tool-b') === 'session'`; tool-b não
tem formulário de login nem credencial guardada, então a cascata tinha de terminar em `session` — e
terminou em `filled`.

Causa: `cascadeContext` respondia `hasCredential: true` sempre, com o comentário "deliberate" acima
(versão anterior de `backend/tool-windows.ts:482-490`). Na v1 era inofensivo: a credencial só era
lida no `inject` e o resultado não dependia dela. Na v2, a regra 4 da cascata conta a tentativa no
momento em que `fill` é verdadeiro (`shared/login-cascade.ts:63-68`: `state: fill ? { ...s, attempts:
s.attempts + 1 } : s`) e a regra 5 decide pelo `attempts` (`:73-75`: `filled` se `attempts > 0`,
senão `session`). A ferramenta sem credencial, portanto, chegava ao relatório `no-form` com
`attempts = 1` e resolvia `filled`. O `apply` até rebaixava o `fill` para `false` ao ver a credencial
nula, mas tarde demais: a tentativa já tinha sido contada. Distância entre causa e sintoma: a
interface de deps não tinha `hasCredential` (o §4 já a trazia) e o único lugar que decide a tentativa
mentia `true`; a fiação de `backend/main.ts` (versão anterior, `:110-113`) não passava o índice do
cofre.

Hipóteses descartadas: (1) segredo indo para a página — não: `credentialOf` devolve `null`, o
`apply` injeta com `fill:false`, sem `username`/`secret`; (2) relatório `no-form` de outra origin —
não: o `onReport` só aceita a origin da entrada (P9) e o smoke usa a origin da entrada; (3) o timer
de 4 s (A7) alimentando um segundo `finish` — não: sem `fill` o `armFillCheck` não é armado.

Mudança (contrato §4, `docs/arquitetura.md:256-257`, já trazia `hasCredential(toolId): boolean`):

- `backend/tool-windows.ts` — `ToolWindowsDeps` ganhou `hasCredential(toolId: Id): boolean` (`:50-55`);
  `cascadeContext` passou a responder `deps.hasCredential(toolId)` (`:493-496`), e o comentário
  "deliberate" saiu; `signal` passa o estado que o passo produziu a `apply(window, action, stepped)`
  (`:499-507`); e `apply`, quando o passo pediu `fill: true` mas a `deps.credential()` aguardada volta
  `null` (ou vazia), injeta com `fill: false` e **devolve a tentativa** — `attempts` volta ao valor de
  antes do passo (`:560-570`) —, mas só enquanto `stepped` ainda é o estado da janela, porque um
  sinal que chegue durante o `await` é dono da cascata.
- `backend/main.ts` — `hasCredentialOf(toolId)` ao lado de `credentialOf` (`:210-219`) lê o índice do
  cofre (`repo.vaultItem(person.id, toolId)`, síncrono, com `currentPerson()`), e a fiação passa
  `hasCredential: (toolId) => hasCredentialOf(toolId)` (`:114`).
- `test/tool-windows.test.ts` — o fake ganhou `hasCredential` (`FakeState.hasCredential: true` por
  padrão, independente de `credential`, que é o chaveiro: `:100-102`, `:143`, `:217`) e dois testes de
  regressão (`:726-766`): ferramenta sem credencial no índice → o primeiro `finish` avalia com
  `fill:false`, nenhuma leitura de chaveiro (`calls.credential === 0`) e `no-form` → `session`;
  índice com o item e chaveiro sem a chave → avalia com `fill:false`, devolve a tentativa (o `finish`
  seguinte volta a tentar o fill: `calls.credential === 2`) e `no-form` → `session`. Nenhum teste
  existente foi alterado; o fake de 'without a credential…' segue com o índice dizendo sim (o caso
  índice-sim/chaveiro-não).
- `docs/handovers/v2-tool-windows.md` — este `## Fix 2`.

Critério de aceite "por leitura: nenhuma credencial nunca produz `filled`": com `hasCredential` falso
o passo devolve `{ type: 'inject', fill: false }` sem tocar em `attempts`
(`shared/login-cascade.ts:63-68`), e o `no-form` daí sai `session`
(`:73-75`) — a única porta para `filled` é `attempts > 0`, que só a regra 4 incrementa e que o
`apply` devolve quando a credencial não vem (`backend/tool-windows.ts:560-570`). Casos `manual` e
`failed` (regra 7) idem: com `attempts` devolvido a 0, um `form` na primeira visita é `manual`.

Evidência: `leitura` — as linhas citadas acima, mais o passo do smoke
(`test/smoke/smoke.html:235-245`, que espera `session` para tool-b) e o contrato §3 regra 4
(`docs/arquitetura.md:126-127`).

Não rodei teste, `tsc`, build, smoke, linter nem formatador: a corrida dos gates é do coordenador
(`bun test/smoke/run.ts`, `bun test test/tool-windows.test.ts`).
