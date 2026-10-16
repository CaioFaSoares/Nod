# Fatia v2-smoke — smoke na superfície real, em inglês (`test/smoke/`)

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (em-curso). Contrato seguido:
`docs/arquitetura.md` (v2) §2 (guarda de janela e mensagem de erro), §4 (janelas de ferramenta e
cascata), §6 (gates, "smoke em `test/smoke/`"); tipos e nomes de método: `shared/types.ts`
(`ApiContract`). Receita do runtime: `docs/tinyjs.md` §4–§5 e o histórico da fatia H
(`docs/handovers/h-smoke.md`), que já registra o tropeço de gerar a página dentro de `.build/`.

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `test/smoke/tools.ts` | criado (substitui `ferramentas.ts`). `startTools(): Tools` (`{ originA, originB, originC, originProvider, stop() }`) sobe **quatro** `Bun.serve({ hostname: '127.0.0.1', port: 0 })`. **A** serve `/` (formulário de login, `<title>Tool A · Test</title>`, `<link rel="icon" href="/icon.png">`) ou "signed in to A" com o cookie `session=ok`, `POST /login` confere `person@test`/`secret-a` → `303 /` + `Set-Cookie: session=ok; Path=/`, e `GET /icon.png` devolve o PNG 1×1. **B** serve `/` ("B is open", sem formulário), `/sso` (sem cookie → 302 para `provider/authorize?return=<originB>/sso/back`), `/sso/back` (303 `/panel` + `sso=ok`), `/panel` (com cookie → "panel B"; sem → 303 `/sso`). **C** é form login com a mesma forma de A mas **origin fora do seed**: conta cada `POST /login` que recebe e publica o contador em `GET /stats` (`{"posts": n}` com `access-control-allow-origin: *`). **Provedor**: só o desvio de ida e volta do `/authorize` (recusa `return` que não comece pela origin de B). |
| `test/smoke/smoke.html` | reescrito. Template da página de teste: JavaScript puro inline, sem bundler, com o marcador `__CONFIG__` (uma só ocorrência, em `const CONFIG = …`). Poll de 100 ms até `window.tiny`; **14** passos numerados, cada um `{ step, ok, detail, ms }`, `try/catch` por passo e o próximo só rodando se o anterior passou (os não rodados entram como `ok:false, detail:'did not run'`); gravação incremental em `tiny.store.set('smoke_result', { done, steps, error })` e `done: true` no fim. |
| `test/smoke/run.ts` | criado (substitui `rodar.ts`). Runner (bun): recusa sem `--force` se `resources/seed.json` existir; sobe as ferramentas locais; escreve o seed temporário (chaves em inglês, `version 1`, papel `admin`, entradas mínimas com as origins A e B, `invites: []`, `update: null`); `BOND_APP_ID=studio.copland.bond.smoke bun scripts/gen-config.ts dev`; apaga o diretório de dados do app de smoke; gera `test/smoke/.gerado/smoke.html`; roda `tinyjs dev` com `TINYJS_HTML` e `BOND_APP_ID` (filho **destacado**, grupo de processo próprio); poll de `<dados>/store.json` até `smoke_result.done` (120 s, ou o app sair antes); confere o export de eventos; mata o app **e os filhos** (`SIGTERM` no grupo `-pid`, depois `pkill -P` + `SIGKILL`); limpa no `finally` e em `SIGINT`/`SIGTERM`. |
| `test/smoke/rodar.ts`, `test/smoke/ferramentas.ts` | **apagados** (v1, nomes em português; o contrato v2 os lista como removidos nesta fatia). |
| `docs/handovers/v2-smoke.md` | este arquivo. |

Nada mais foi tocado: `resources/seed.json`, `tinyjs.json` e `test/smoke/.gerado/` são artefatos de
execução (gitignored) que o runner cria e desfaz.

## Critério de aceite — como cada item foi atendido

Evidência por `leitura` do código (o contrato da fase manda só editar; quem roda é o coordenador).
As referências de linha são as do estado atual dos arquivos.

| Item pedido | Como foi atendido |
| --- | --- |
| Porta do smoke v1 (que passou nos testes e no smoke real) para o inglês e para a API v2 (`ApiContract`) | `smoke.html` chama `tiny.api.call` com os nomes de `shared/types.ts`: `session.state/createAccount/unlock/lock`, `catalog.probe/save/list/get`, `vault.save/list/remove`, `tools.open/openView/state`, `events.list/exportToFile` (`smoke.html:127-388`); parâmetros em inglês (`email`, `password`, `entry`, `icon`, `probe`, `toolId`, `index`, `path`). Nenhum identificador em português em `test/smoke/`. |
| Página gerada em `test/smoke/.gerado/`, nunca em `.build/` | `run.ts:28-35` (`GENERATED_DIR`, `SMOKE_PAGE`, `SEED_BACKUP`, `EXPORT_PATH`); `mkdirSync(GENERATED_DIR, { recursive: true })` em `run.ts:239`; nenhum caminho do runner aponta para `.build/` (a única menção é o comentário de cabeçalho que registra o motivo). `generatePage()` exige **exatamente um** marcador (`run.ts:105-109`); o template tem uma ocorrência só — a menção em comentário foi reescrita para não repetir o literal, porque `String.replace` trocaria a primeira e deixaria um `__CONFIG__` solto no `const CONFIG` (página quebrada, sintoma só de "o app saiu"). |
| App id `studio.copland.bond.smoke` via `BOND_APP_ID` | `run.ts:26` e `run.ts:315` (env do `tinyjs dev`); `runGenConfig(true)` acrescenta `BOND_APP_ID` ao filho (`run.ts:122-136`, chamado em `run.ts:298`). |
| Diretório de dados apagado antes | `run.ts:305` (`rmSync(dataDir(), …)`) sobre `dataDir()` (`run.ts:61-66`, mesmo cálculo do runtime por sistema). |
| Seed temporário com chaves em inglês e só as origins A e B | `temporarySeed()` (`run.ts:74-100`): `version`, `generatedAt`, `roles: [{ id:'admin', name:'Admin', admin:true }]`, `entries` (`tool-a`→A, `tool-b`→B), `invites: []`, `update: null`. C e o provedor ficam fora: o gate só dá `login.report` às origins do seed. |
| Recusa sem `--force` quando `resources/seed.json` existe, com backup em `test/smoke/.gerado/` | `run.ts:232-237` (sai 2); `run.ts:285-288` move para `SEED_BACKUP` e `run.ts:259-262` devolve no `clean()`. |
| `tinyjs.json` final regenerado **sem** `BOND_APP_ID` | `runGenConfig(false)` em `run.ts:263`: o env do filho é copiado e a chave é **removida** (`delete env.BOND_APP_ID`, `run.ts:125`). Se a regeneração falhar, o `tinyjs.json` anterior volta (ou é removido): `run.ts:264-273`. |
| Kill do grupo de processo | `killTree()` (`run.ts:149-169`): `SIGTERM` no grupo `-pid`, espera até 3 s, depois `pkill -P` + `SIGKILL`; `spawn(..., { detached: true })` (`run.ts:310-316`). |
| Limpeza em `SIGINT`/`SIGTERM` | `run.ts:280-281` com a guarda `cleaned` (`run.ts:252-258`), que mata o app, para os servidores, apaga o seed temporário, restaura o backup e regenera o `tinyjs.json`. |
| Tempo limite de 120 s | `FINISH_TIMEOUT_MS = 120_000` (`run.ts:40`), aplicado em `waitForResult()` (`run.ts:172-205`). |
| Saída 0 só se todos os passos passaram | `run.ts:333-352`: exige resultado, `EXPECTED_STEPS` (14), todos `ok` **e** o export conferido. Códigos: 0 ok, 1 smoke falhou/estourou, 2 recusado, 3 cenário não montou. |
| Sem rede externa | tudo em `127.0.0.1` (`tools.ts:74` sobe os quatro servidores); o seed temporário tem `update: null`, então o `gen-config` não escreve chave `update` e o smoke não chama `bond.checkUpdate`/`installUpdate`. |
| Passo 1 `session.state` sem conta | `smoke.html:127-133` (`hasAccount === false` e `unlocked === false`). |
| Passo 2 `session.createAccount` → admin desbloqueado | `smoke.html:135-148`. |
| Passo 3 `catalog.probe` A → título 'Tool A', `hasLoginForm`, ícone png | `smoke.html:150-161` (a página de A tem `<title>Tool A · Test</title>`, cortado em `' · '` pelo `cleanTitle`). |
| Passo 4 `catalog.save` tool-a (ícone + probe) e tool-b (vista `{label:'SSO', url:B+'/sso', mode:'window'}`); `catalog.list` com as duas; ícone de tool-a começando em `data:image/png;base64,`; `catalog.get('tool-a').probe.title === 'Tool A'` | `smoke.html:163-208`. |
| Passo 5 `vault.save` tool-a; `vault.list` sem `secret-a` | `smoke.html:210-221` (`JSON.stringify(items).indexOf(SECRET_A) === -1`). |
| Passo 6 `tools.open` tool-a; poll de `tools.state` até `login === 'filled'` (20 s) | `smoke.html:223-234` + `STATE_TIMEOUT_MS` (`smoke.html:29`) e `waitUntil()` (`smoke.html:91`). |
| Passo 7 `tools.open` tool-b → `login === 'session'` | `smoke.html:236-246`. |
| Passo 8 `tools.open` tool-a de novo: ida e volta < 150 ms e `openWindows === 1` | `smoke.html:248-257` (`HOT_LIMIT_MS`, `smoke.html:32`). |
| Passo 9 `tools.openView` tool-b índice 0 → poll de `events.list({toolId:'tool-b'})` até evento `login` com resultado `provider` (20 s) | `smoke.html:259-280`; a falha imprime `tool-b.openWindows` e os resultados de `login` já vistos, para separar "não viu o provedor" de "a janela não abriu". |
| Passo 10 regressão do laço de login: `catalog.save` tool-c, `vault.save` tool-c com segredo **errado** `wrong`, `tools.open` tool-c, espera 8 s, `fetch(C + '/stats')` → `posts === 1` | `smoke.html:282-306` (`C_SETTLE_MS`, `smoke.html:33`); a origin de C está deliberadamente fora do seed, então o runtime não deixa C relatar `login.report` (é esse o caminho do laço). |
| Passo 11 `events.exportToFile({ path: CONFIG.exportPath })` → `true` | `smoke.html:308-313`; o caminho absoluto vem no CONFIG injetado (`run.ts:108-113`). |
| Passo 12 `session.lock` → travado; `tools.state` lança **ou** todo `openWindows` é 0 (registrando qual); `catalog.list` lança | `smoke.html:315-351`: tenta `tools.state`; se lançar registra `tools.state throws: <mensagem>`, senão espera até todas as janelas fecharem e registra `tools.state answers and every openWindows is 0`; depois exige que `catalog.list` lance. |
| Passo 13 `session.unlock` com senha errada → `invalid credentials`; com a certa → desbloqueado; poll de `tools.state` até tool-a `openWindows >= 1` (15 s) | `smoke.html:353-379` (`RESTORE_TIMEOUT_MS`, `smoke.html:30`). |
| Passo 14 limpeza: `vault.remove` tool-a e tool-c | `smoke.html:381-388` (confere depois que nenhum dos dois ficou no `vault.list`). |
| Sequência: próximo passo só roda se o anterior passou | `sequence` (`smoke.html:390-405`) + `run()` (`smoke.html:407-430`), com `stopped = !ok` e `record(name, false, 'did not run', 0)`. |
| Resultado em `tiny.store.set('smoke_result', { done: true, steps })` | `smoke.html:69` (`writeResult`) chamado a cada passo com `done: false` e no fim com `done: true`; o runner lê a mesma chave em `run.ts:192`. |
| Runner confere o export: existe, cada linha é JSON, nenhuma linha tem `secret-a` nem `wrong` | `checkExport()` (`run.ts:208-229`, `FORBIDDEN_IN_EXPORT` em `run.ts:45`); o runner apaga o export anterior antes de subir o app (`run.ts:240`) para que a checagem não passe por arquivo velho. |
| Runner imprime cada passo `ok/FAILED step (ms) detail` | `run.ts:326-328`. |

## Decisões e desvios (para o coordenador)

1. **Terceiro campo no resultado**: o objeto gravado é `{ done, steps, error }` — a fatia pede
   `{ done: true, steps }` na escrita final; `error` é aditivo e é o diagnóstico da fatia H para o
   caso "a página morreu antes de gravar" (`smoke.html:435-436` grava `done: true` com a mensagem).
   O runner trata `error` como opcional (`run.ts:47-51`).
2. **O passo 12 registra qual dos dois comportamentos aconteceu** (a guarda lança ou o estado vem com
   todas as janelas fechadas), como pedido, e o texto escolhido entra no `detail` do passo.
3. **O passo 10 mede o `sleep` de 8 s dentro do passo** — o `ms` impresso é ≥ 8000 e isso é
   intencional (é a janela em que um segundo preenchimento apareceria).
4. **Linha extra do runner**: além dos 14 passos da página, o runner imprime
   `export: ok|FAILED <n> event(s), no secret` (`run.ts:331`). Ela **não** conta em
   `EXPECTED_STEPS`; quando o smoke falha antes do passo 11, sai `export: FAILED missing …` e o
   retorno 1 já vinha dos passos.
5. **Credenciais duplicadas de propósito**: `tools.ts` exporta `USERNAME`/`SECRET_A` e o
   `smoke.html` repete os literais, porque a página é JS puro injetado por `TINYJS_HTML` e não
   importa `test/smoke/tools.ts` (mesma decisão da v1). Os dois pontos estão comentados um citando o
   outro; string vazia de um lado quebraria o passo 6 de forma visível.
6. **Sem `--forcar` herdado**: a flag passou a ser `--force` (o resto do smoke é em inglês).
7. **O diretório de dados do app de smoke não é apagado no fim**, só antes de subir (é o que a fatia
   pede); a v1 também deixava `store.json` para inspeção da corrida. Fica fora do repositório.
8. **`test/smoke/.gerado/` fica com a página gerada e o `events.jsonl` exportado** ao fim de uma
   corrida (o diretório inteiro é gitignored, como na v1); o backup do seed, esse sim, é consumido
   pela restauração. Nada disso fica em `.build/`.
9. **Marcador único no template**: `smoke.html` cita o marcador uma só vez (no `const CONFIG = …`).
   A primeira versão deste arquivo o repetia também num comentário e `String.replace` trocaria a
   ocorrência errada, deixando a página com `const CONFIG = __CONFIG__;` — passei a exigir contagem
   exata de um em `generatePage()` para que o erro apareça como exceção no runner, não como "o app
   saiu antes de gravar o resultado" (o sintoma que custou caro na v1).

## Precisa de outro dono

- `scripts/gen-config.ts` (fatia `v2-release`): precisa continuar aceitando `dev` e respeitando
  `BOND_APP_ID` no `id` do `tinyjs.json` — é o que dá ao app de smoke um diretório de dados próprio.
  O dono da release confirmou (mensagem, 2026-10-15) que o comando segue `bun scripts/gen-config.ts
  dev` com `BOND_APP_ID` no ambiente e o gate de cada origin de entrada em `['login.report']`, que é
  exatamente de que o seed temporário depende.
- `backend/main.ts`: o passo 12 depende de a guarda do §2 fechar `tools.state` e `catalog.list` com a
  sessão bloqueada; o passo 13 depende de o desbloqueio chamar `restore()`.
- `backend/tool-windows.ts`: o passo 13 depende de `closeAll()` (no bloqueio) **não** escrever a lista
  `open_tools` do `store`. O dono da fatia de janelas confirmou o desenho (mensagem, 2026-10-15):
  `closeAll()` fecha janelas e popups rastreados sem reescrever a lista, que só muda em
  abrir/fechar/reconcile; `restore()` a lê no desbloqueio e reabre só o que `entries()` ainda
  devolve. O passo 13 continua sendo a prova disso no smoke.

## O que ficou de fora (e por quê)

- **Rodar o smoke**: é o gate do coordenador (`docs/arquitetura.md` §6). Nenhuma execução, build,
  typecheck, linter ou formatador foi rodado nesta fatia.
- **Chaveiro**: o smoke grava e apaga credenciais de `tool-a`/`tool-c` no chaveiro do sistema. Numa
  corrida que falhe antes do passo 14 sobram itens órfãos `bond.cred.<uuid>.tool-c` (ou `.tool-a`);
  o uuid muda a cada corrida, então nunca são reusados. O runner não mexe no chaveiro.
- **Nada em `backend/`, `src/`, `shared/` ou `scripts/`** (um arquivo, um dono): o smoke só consome
  as assinaturas do §4 e o `gen-config.ts`.
- **Biometria, paleta, bandeja, release e export cifrado do cofre** não entram nos 14 passos.

## Onde a evidência cai no handover da frente

Este arquivo é a evidência da fatia `v2-smoke`: `test/smoke/tools.ts`, `test/smoke/smoke.html`,
`test/smoke/run.ts` (e a remoção de `test/smoke/rodar.ts` e `test/smoke/ferramentas.ts`). O
coordenador confirma com `bun test/smoke/run.ts` e confere que o repositório volta como estava
(`resources/seed.json` ausente, `tinyjs.json` regenerado em dev, nenhum app de smoke de pé,
`test/smoke/.gerado/` gitignored).

## Fix 2 — o smoke passa a rodar na porta 5199 (`BOND_DEV_PORT`)

**Sintoma (reproduzido pelo coordenador, por execução):** `bun test/smoke/run.ts` com um
`bun run app:dev` do dono aberto morria em `error when starting dev server: Error: Port 5173 is
already in use` e o `tinyjs dev` do smoke saía — a corrida ficava sem `smoke_result` e o runner
relatava "the app exited before writing the result".

**Causa:** o smoke subia o próprio vite na mesma 5173 da sessão do dono (a porta estava fixa em
`vite.config.ts` e no `devUrl` do `tinyjs.json` gerado). O acoplamento dos dois lados está no
runtime: o CLI sobe `frontend.dev` e espera `frontend.devUrl` responder
(`/Users/caio/.tinyjs/cli.js:2075` e `:2092`), então não bastava só trocar a porta de escuta — o
gate de página e o `devUrl` tinham de sair do `gen-config` já na porta do smoke.

**Correção em `test/smoke/run.ts`:**

- `SMOKE_DEV_PORT = 5199` (`run.ts:33`), com o comentário de que nunca é 5173.
- `runGenConfig(true)` acrescenta **as duas** chaves ao filho — `BOND_APP_ID=studio.copland.bond.smoke`
  e `BOND_DEV_PORT=5199` — e `runGenConfig(false)`, a regeneração final do `clean()`, **deleta as
  duas** (`run.ts:132-140`, chamadas em `run.ts:313` e `run.ts:278`). O `tinyjs.json` final volta ao
  id do `tinyjs.base.json` e à porta padrão 5173.
- O filho `tinyjs dev` recebe `BOND_DEV_PORT: String(SMOKE_DEV_PORT)` no `env` (`run.ts:330-336`);
  como o `tjs.spawn` do runtime não passa `env` (`/Users/caio/.tinyjs/cli.js:2076`), `bun run dev` →
  `vite` herdam a variável e escutam 5199, a mesma porta que o `tinyjs.json` gerado manda a janela
  carregar e o gate libera.
- A linha de log do app passou a imprimir `BOND_DEV_PORT` (`run.ts:343-345`) e o cabeçalho do runner
  registra por que a porta é própria (`run.ts:18-20`).

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| smoke e o `app:dev` do dono em portas diferentes | `run.ts:33` (`SMOKE_DEV_PORT = 5199`) contra `package.json` (`"dev": "vite --host 127.0.0.1 --strictPort"`, sem porta) e `vite.config.ts` (`Number(process.env.BOND_DEV_PORT ?? 5173)`) | o smoke põe `BOND_DEV_PORT=5199` no `env` do `tinyjs dev` e no do `gen-config`; sem a variável, vite e o `gen-config` ficam em 5173 |
| o cenário `gen-config` do smoke usa 5199 | `run.ts:134-137` (ramo `smokeId === true`) | `env.BOND_DEV_PORT = String(SMOKE_DEV_PORT)` junto com `BOND_APP_ID` |
| o `tinyjs.json` final é o padrão | `run.ts:138-140` (ramo `smokeId === false`): `delete env.BOND_APP_ID` e `delete env.BOND_DEV_PORT`; chamada no `clean()` (`run.ts:278`, que loga `tinyjs.json regenerated in dev`) | sem as chaves, `scripts/gen-config.ts` volta ao id do base e a `devPort` cai no padrão 5173 |
| a checagem do export e os 14 passos não mudam | nada em `smoke.html` nem em `checkExport()` foi tocado; a página de teste carrega por `TINYJS_HTML` (origin `file://*`, que continua `'all'`) | a mudança é só de ambiente/porta do cenário |

**Não rodado:** nenhum teste, typecheck, build, smoke, linter ou formatador — o contrato da fase diz
"só edite"; a evidência é `leitura` (do repo e do CLI instalado, que é o contrato real do runtime).

**Depende de outro dono:** `scripts/gen-config.ts` (Fix 2 da fatia `v2-release`): o 5º parâmetro
`devPort` (padrão 5173) põe a porta no gate e no `frontend.devUrl`, e a env `BOND_DEV_PORT` é
validada (1024–65535; fora disso sai `invalid BOND_DEV_PORT: <valor>` e código 1). `vite.config.ts` e
o script `dev` do `package.json` foram mudados pelo coordenador e são o outro lado do mesmo
contrato. `docs/arquitetura.md` §2/§6 ainda fala da 5173 literal — fora desta fatia.
