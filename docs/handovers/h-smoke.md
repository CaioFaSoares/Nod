# Fatia H — smoke na superfície real (`test/smoke/`)

Issue que autoriza: `docs/issues/B03-smoke-e-release.md` (em-curso; "Autoriza `test/smoke/` e
`docs/distribuicao.md`"). Contrato seguido: `docs/arquitetura.md` §2 (guarda de janela), §6 (build e
gates); receita do runtime: `.agents/skills/tinyjs/references/recipes.md` §"Self-driving test page"
(resumo em `docs/tinyjs.md`).

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `test/smoke/ferramentas.ts` | criado. `subirFerramentas(): Ferramentas` (`{ origemA, origemB, origemProvedor, parar() }`): três `Bun.serve({ hostname: '127.0.0.1', port: 0 })`. **A** serve `GET /` (formulário de login com `<title>Ferramenta A · Teste</title>`, `<link rel="icon" href="/icone.png">`, `input name=username`, `input type=password name=password` e botão submit) ou 'logado em A' com o cookie `sessao=ok`; `POST /entrar` confere `pessoa@teste`/`segredo-a` → `303 /` + `Set-Cookie: sessao=ok; Path=/`, senão 200 com o formulário; `GET /icone.png` → PNG 1×1 (70 bytes fixos no arquivo, `content-type: image/png`). **B** serve `GET /` ('B aberto', sem formulário), `GET /sso` (sem cookie → 302 para `origemProvedor/authorize?volta=<origemB>/sso/volta`), `GET /sso/volta` (303 `/painel` + `Set-Cookie: sso=ok; Path=/`) e `GET /painel` (com cookie → 'painel B'). **Provedor** serve `GET /authorize?volta=` → 302 de volta (recusa `volta` que não seja da origem B com 400). Exporta `USUARIO`/`SEGREDO_A`, os mesmos valores que a página usa. |
| `test/smoke/smoke.html` | criado. Template da página de teste: JavaScript puro inline, sem bundler, com o marcador `__CONFIG__` (uma só ocorrência, no `const CONFIG = ...`). Poll de 100 ms até `window.tiny`; 13 passos numerados, cada um `{ passo, ok, detalhe, ms }`, com `try/catch` por passo e o próximo só rodando se o anterior passou (os não rodados entram como `ok:false, detalhe:'não rodou'`); gravação incremental em `tiny.store.set('resultado_smoke', { fim, passos, erro })` e `fim: true` no fim. |
| `test/smoke/rodar.ts` | criado. Runner (bun): recusa sem `--forcar` se `resources/seed.json` existir; sobe as ferramentas; escreve o seed temporário (`versao 1`, papel `administrador`, entradas mínimas cujas origins são A e B, `convites: []`); `BOND_APP_ID=studio.copland.bond.smoke bun scripts/gen-config.ts dev`; apaga o diretório de dados do app de smoke; gera `test/smoke/.gerado/smoke.html`; roda `tinyjs dev` com `TINYJS_HTML` e `BOND_APP_ID` (`Bun.spawn` por `node:child_process.spawn`, grupo de processo próprio); poll do `store.json` até `resultado_smoke.fim` (120 s, ou o app sair antes); mata o app **e os filhos** (`SIGTERM` no grupo `-pid`, depois `pkill -P` + `SIGKILL`); limpa no `finally` (e em `SIGINT`/`SIGTERM`): seed temporário fora, backup restaurado, `tinyjs.json` regenerado em dev; imprime `ok/FALHOU passo (ms) detalhe` e sai com 0 só com os 13 passos passando. |
| `docs/handovers/h-smoke.md` | este arquivo. |

Nada mais foi tocado: `resources/seed.json`, `tinyjs.json` e `test/smoke/.gerado/` são artefatos de
execução (gitignored) que o runner cria e desfaz.

## Critério de aceite — como cada item foi atendido

Evidência por `leitura` do código (o contrato da fase diz "não rode testes, typecheck, build, linter
nem formatador; só edite") e por `execução` das sondas fora do app, listadas na seção seguinte.

| Item do aceite | Como o runner atende |
| --- | --- |
| Roda o app de verdade e exercita a API pelo caminho real | `rodar.ts:274-288` sobe `tinyjs dev` com `TINYJS_HTML` apontando para a página de teste e espera o resultado; a página chama `tiny.api.call` (`smoke.html`) e o backend responde com a guarda de janela valendo (`meta.window === 'main'`) |
| Receita do runtime (poll do `tiny`, `store.set`, leitura do `store.json`) | `smoke.html` (poll de 100 ms em `esperarTiny`, `tiny.store.set('resultado_smoke', …)`) e `rodar.ts` (`diretorioDeDados()` + `esperarResultado()` lendo `<dados>/store.json`) |
| Os 13 passos, na ordem, com o próximo só rodando se o anterior passou | `smoke.html` (`sequencia` + `rodar()`, `parou = !ok`, `anotar(nome, false, 'não rodou', 0)`) |
| Passos 3, 4, 5, 6, 7, 9, 10 com as asserções pedidas | `passo3` (título/formulário/ícone png), `passo4` (as duas entradas, ícone `data:image/png;base64,`), `passo5` (cofre sem o segredo em `JSON.stringify`), `passo6`/`passo7` (poll de `rail.estado` até `login` `preenchido`/`sessao`), `passo9` (poll de `rail.estado` + `eventos.listar` até evento `login` com `resultado === 'provedor'`), `passo10` (JSONL válido e sem `segredo-a`) |
| Passo 8 mede a troca quente (< 150 ms) | `passo8` mede a ida e volta da própria chamada `rail.trocar` e exige `ms < 150`, `ativo === 'ferr-a'` e `ferr-a.quente === true` |
| Passos 11, 12, 13 | `passo11` (bloqueia e exige que `catalogo.listar` lance), `passo12` (senha errada lança 'credenciais inválidas'; a certa desbloqueia), `passo13` (`cofre.remover`) |
| Recusa sem `--forcar` quando `resources/seed.json` existe, com backup e restauração | `rodar.ts:200-205` (recusa com código 2) e `rodar.ts:247-251` + `limpar()` (`rodar.ts:216-243`) move para `test/smoke/.gerado/seed.json.bak` e restaura |
| Seed temporário só para gerar o gate; entradas mínimas com as origins A e B | `criarSeed()`; o comentário na função registra por que o provedor não entra (a cascata não injeta fora da origin da entrada) |
| Limpeza no `finally` (e o repositório como estava) | `limpar()` (uma vez só, chamada do `finally` e dos sinais): mata o app e o grupo, para os servidores, apaga o seed temporário, restaura o backup e regenera `tinyjs.json` em dev; se a regeneração falhar, repõe o `tinyjs.json` de antes (ou o remove) |
| Sem rede externa | tudo é `127.0.0.1`: as três ferramentas são locais e o seed temporário tem `atualizacao: null` (o `gen-config` não escreve chave `update`); o smoke não chama `app.atualizacao`/`app.instalarAtualizacao` |
| Sai com 0 só se todos passaram | `rodar.ts:298-307`: exige `resultado.ok`, 13 passos e todos `ok` |

## Sondas (execução, fora do app)

O smoke em si **não** foi rodado — é o coordenador que roda (fim de fase). O que rodei foram sondas
de semântica (em `/tmp`, fora do repositório) e do próprio fixture, para não escrever código sobre
suposição:

| Sonda | Resultado observado |
| --- | --- |
| `bun probe1.ts`: `Bun.spawn(['sleep','30'], { detached: true })` + `ps -o pid=,pgid=` | o filho abre grupo próprio (`pgid == pid`) e `process.kill(-pid, 'SIGTERM')` mata o grupo inteiro |
| `bun probe3.ts`: `node:child_process.spawn('sh', ['-c','sleep 30 & sleep 30'], { detached: true })` + `SIGTERM` no grupo | `vivo()` via `process.kill(pid, 0)` vira `false`, `signalCode === 'SIGTERM'`, `pgrep -f "sleep 30"` → 0 restos; `Bun.spawnSync(['pkill','-P',pid], { stdout:'ignore' })` roda sem imprimir |
| `bun probe2.ts`: `Bun.serve({ port: 0 })` ×2 + `Response.redirect`/`set-cookie` | `server.port` devolve a porta efêmera, `stop(true)` derruba, o 302 do provedor devolve `volta` e o 302 de B carrega a query `volta` codificada |
| bytes do ícone: `printf … \| base64 -d > p1.png; file p1.png` | `PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced` (70 bytes) |
| exercício das rotas do fixture (importando `test/smoke/ferramentas.ts` num processo bun e batendo em cada rota com `redirect: 'manual'`) | A: `/` 200 com título, `<link rel="icon" href="/icone.png">`, `input name=username`, `type="password" name=password` e botão submit; `POST /entrar` errado → 200 com o formulário; certo → `303 /` + `sessao=ok; Path=/`; `/` com cookie → 'logado em A' sem campo de senha; `/icone.png` → 200 `image/png`, 70 bytes, assinatura `137,80,78,71,13,10,26,10`. B: `/` 200 'B aberto' sem `<form`; `/sso` → 302 para `<provedor>/authorize?volta=<origemB>/sso/volta`; provedor → 302 de volta para `origemB/sso/volta`; `/sso/volta` → 303 `/painel` + `sso=ok; Path=/`; `/painel` com cookie → 'painel B', sem cookie → 303 `/sso`; `/authorize` com `volta` de outra origem → 400; rota desconhecida → 404; `parar()` derruba os três |
| sintaxe da página: extrair o `<script>` e `node --check` | `sintaxe ok`; e a geração do runner (trocar o marcador pelo JSON) deixa **0** marcadores restantes e o `const CONFIG = {"origemA"…` no lugar |
| parse dos dois `.ts`: `new Bun.Transpiler({loader:'ts'}).transformSync(...)` | `parse ok` nos dois |

## Desvios do contrato e decisões (para o coordenador)

1. **O resultado `provedor` do passo 9 depende de o palcos alimentar a cascata no pulo cross-origin.**
   A topologia é a pedida: `B /sso` → 302 para o provedor → 302 de volta para `B /sso/volta` → 303
   `/painel`. Nessa cadeia inteira o documento final é da origin de B; `saiu_da_origem` (regra 2 do
   §3 do `docs/arquitetura.md`) só fica `true` se o backend receber um sinal de cascata com a URL do
   provedor — o `finish` de uma navegação com redirect de servidor tende a ser só o do documento
   final. Ou seja: o passo 9 passa se `backend/palcos.ts` (G1) alimentar a cascata no pulo
   cross-origin (o `policy`/`start` da URL do provedor chega ao backend; §4 diz que o provedor
   "precisa carregar" e que a cascata rastreia "provedor já visto"). Se o G1 reportar só `finish` do
   documento final, o passo 9 esgota os 20 s — e o detalhe impresso pelo runner já traz
   `palco:ferr-b:0.login` e os `login` observados de `ferr-b`, o que separa "não viu o provedor" de
   "o palco não abriu". Não mudei a topologia por conta própria: ela está escrita na fatia.
2. **O provedor não entra no seed temporário** (como pedido): ele não recebe injeção de adaptador e
   nunca chama `login.report`, então não precisa de chave no gate de origin.
3. **`registro`/`anotar` gravam um parcial a cada passo** (`fim: false`) além do resultado final 
   (`fim: true`). O runner só considera pronto com `fim === true`; o parcial é o que ele imprime
   quando a espera estoura.
4. **Sinais**: `SIGINT`/`SIGTERM` também passam por `limpar()`, porque o app é filho destacado
   (grupo próprio) e um Ctrl-C sem isso deixaria o `tinyjs dev` de pé e o seed temporário no lugar.
5. **Sem o seed do dono**: sem `--forcar` o runner nem começa; com `--forcar`, o seed dele é movido
   para `test/smoke/.gerado/seed.json.bak` e restaurado antes da regeneração final do `tinyjs.json`.
6. **Código de saída**: o runner termina com `process.exit(await principal())`; 0 = todos os 13
   passos ok; 1 = smoke falhou/estourou; 2 = recusado (seed presente sem `--forcar`); 3 = cenário não
   montou (`gen-config` falhou).
7. **Chaveiro**: o smoke grava a credencial de `ferr-a` no chaveiro do sistema (macOS Keychain) e a
   remove no passo 13. Se a corrida falhar antes disso, sobra uma entrada `bond.cred.<uuid>.ferr-a`
   órfã (o uuid muda a cada corrida, então ela nunca é reusada); o runner não mexe no chaveiro —
   elemento fora do ambiente que a fatia autoriza.

## O que ficou de fora (e por quê)

- **Rodar o smoke**: é o gate do coordenador (`docs/arquitetura.md` §6, "smoke em `test/smoke/`").
  Toda a evidência de execução acima é de sondas fora do app.
- **`docs/distribuicao.md`**: a issue B03 autoriza os dois arquivos, mas a fatia desta rodada é só o
  `test/smoke/` (release é `R`, com dono próprio).
- **Nada em `backend/`, `src/`, `shared/`, `scripts/` ou nos arquivos de configuração** (um arquivo,
  um dono): o runner só consome as assinaturas do §4 e o `scripts/gen-config.ts` do `R`.
- **Biometria, paleta, bandeja e release** não entram no smoke desta fase (a fatia pede os 13 passos
  acima).

## Precisa de outro dono

- `scripts/gen-config.ts` (fatia R): precisa aceitar `dev|build` e respeitar `BOND_APP_ID` no `id` do
  `tinyjs.json` — o runner depende disso para o app de smoke não encostar nos dados do dono
  (`rodar.ts:113-141`).
- `backend/palcos.ts` (fatia G1): o passo 9 depende de a cascata enxergar o pulo cross-origin do
  provedor (item 1 dos desvios). O passo 6 depende do adaptador preencher o formulário com a
  credencial do cofre e do resultado virar `login: 'preenchido'` no `SistemaRail`.
- `backend/main.ts` (fatia G3): a página roda na janela `main` (guarda do §2) e só usa os métodos de
  `ApiContrato`; nada além disso.

## Onde a evidência cai no handover da frente

Este arquivo é a evidência da fatia H: `test/smoke/ferramentas.ts`, `test/smoke/smoke.html`,
`test/smoke/rodar.ts`. O coordenador confirma rodando `bun test/smoke/rodar.ts` e conferindo que o
repositório volta como estava (`resources/seed.json` ausente, `tinyjs.json` regenerado em dev,
nenhum app de smoke de pé).

## Correção

Falha delimitada observada pelo coordenador por execução de `bun test/smoke/rodar.ts`:

```
página do smoke: /Users/caio/.../Bond/.build/smoke.html
app: tinyjs dev (TINYJS_HTML=/Users/caio/.../Bond/.build/smoke.html, BOND_APP_ID=studio.copland.bond.smoke)
smoke sem resultado: o app saiu antes de gravar o resultado (código 1, sinal null)
--- saída do app ---
==> bundling backend (esbuild)
... [vite] (client) page reload .build/app/frontend/index.html
... [vite] (client) page reload .build/smoke.html
Error: ENOENT: no such file or directory
```

### Causa

Duas causas independentes, ambas no próprio runner:

1. `DIR_BUILD` (`<raiz>/.build`) é o diretório de trabalho do `tinyjs dev`, que o recria ao subir
   (`.build/app/...`): a página gerada dentro dele é apagada antes de o launcher abrir, e a abertura
   morre com `ENOENT` — o app sai com código 1 e nunca grava `resultado_smoke`. Confirmado pelo
   coordenador por execução: a mesma página gerada em `/tmp/bond-probe.html` com `TINYJS_HTML`
   funcionou (app subiu, `tiny.api.call('sessao.estado', {})` respondeu e `tiny.store.set` gravou em
   `<dados>/store.json`). Distância entre causa e sintoma: o sintoma diz "o app saiu antes de gravar
   o resultado" (qualquer morte precoce), e a causa é o caminho do artefato gerado — o sintoma não
   nomeia o `.build/`. Hipóteses descartadas com o motivo: (a) falha do `tinyjs dev`/bundler — o
   `bundling backend (esbuild)` completa e o vite serve normalmente, o único erro é o `ENOENT` da
   página; (b) falha das ferramentas locais ou do seed/`gen-config` — a corrida chega a gerar a
   página e a subir o app, e a sonda em `/tmp` passa com o mesmo seed e as mesmas ferramentas.

2. A regeneração final do `tinyjs.json` no `limpar()` herdava `BOND_APP_ID` do ambiente, então o
   `tinyjs.json` da raiz terminava com `"id": "studio.copland.bond.smoke"` em vez do id do
   `tinyjs.base.json`.

### Mudança

`test/smoke/rodar.ts` (único arquivo de código tocado):

- `DIR_BUILD = <raiz>/.build` → `DIR_GERADO = test/smoke/.gerado` (já no `.gitignore`), criado com
  `mkdirSync(..., { recursive: true })` antes de qualquer uso; `PAGINA_SMOKE` e `SEED_BACKUP`
  passaram a apontar para ele — nenhum caminho do runner escreve mais em `.build/`.
- `gerarConfig()` → `gerarConfig(idDeSmoke: boolean)`: o env do processo filho é `{ ...process.env }`
  com `BOND_APP_ID` **adicionado** só quando `idDeSmoke` é `true` e **removido** (`delete`) caso
  contrário. O `gen` do cenário chama `gerarConfig(true)`; o `genFinal` do `limpar()` chama
  `gerarConfig(false)`, e é isso que devolve o `tinyjs.json` ao id do `tinyjs.base.json`.
- Comentários de cabeçalho e o doc de `gerarPagina` atualizados para os novos caminhos.
- Nada mais mudou: o `spawn` do `tinyjs dev` continua com `TINYJS_HTML=PAGINA_SMOKE` e
  `BOND_APP_ID=APP_ID` (o app de smoke precisa do id de smoke), e o resto do template `smoke.html`
  não foi tocado (só o comentário de cabeçalho, que citava o caminho antigo da página gerada).
- Neste handover os caminhos `.build/…` do corpo viraram `test/smoke/.gerado/…`. As referências de
  linha do corpo (`rodar.ts:NNN`) são anteriores a esta correção — o arquivo andou com ela —; as
  referências desta seção são as atuais.

### Evidência (leitura)

- `rodar.ts:28-33` — `DIR_GERADO`, `PAGINA_SMOKE` e `SEED_BACKUP` em `test/smoke/.gerado/`; nenhuma
  ocorrência de `.build` como caminho do runner (a única menção restante é o comentário de `:15-16`
  que registra por que nada daqui escreve lá).
- `rodar.ts:114-126` — `gerarConfig(idDeSmoke)` monta o env sem `BOND_APP_ID` quando `idDeSmoke` é
  `false`.
- `rodar.ts:212` (`mkdirSync(DIR_GERADO, …)`) e `rodar.ts:270` (`gerarConfig(true)`, cenário);
  `rodar.ts:235` (`gerarConfig(false)`, regeneração final).
- Sem execução: contrato da fase — quem roda é o coordenador. O smoke não foi rodado por mim.

