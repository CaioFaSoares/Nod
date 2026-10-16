# v2 — `index.html`, `src/app.ts`, `src/palette.ts`, `src/style.css`

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (status `em-curso`).
Contrato: `docs/arquitetura.md` §5 (`index.html`, `src/app.ts`, `src/palette.ts`, `src/style.css`) e
§2 (regras de frontend: só `./api`, nada de sistema na página). Requisitos: `docs/canonico.md` §7
(modelo de janelas), §8 (catálogo), §11 (cascata de login). Glossário: `CONTEXT.md`.

## Arquivos tocados

- `index.html` (reescrito): `lang="en"`, título `Bond`, `<link rel="stylesheet" href="/src/style.css">`,
  `<div id="app">`, `<script type="module" src="/src/app.ts">`. É a única página do app.
- `src/app.ts` (criado): boot (`session.state` + `bond.info` em paralelo), tela bloqueada (criar a
  conta de admin / criar conta com convite / desbloquear / Touch ID / espera), sidebar, Home e
  roteamento para Settings; atalhos de teclado da própria janela; assinatura dos pushes `session`,
  `tools`, `catalog` e `palette`. Fala com o backend só por `call`/`on`/`errorMessage` de `./api` e
  desenha só com `el`/`button`/`field`/`input`/`message`/`clear` de `./ui`.
- `src/palette.ts` (reescrito): `export function openPalette(ctx)` — overlay dentro da janela, busca
  por subsequência (sem caixa e sem acento, prefixo primeiro), itens = ferramentas, vistas
  (`Título › Vista`) e ações (Home, cada aba de Settings permitida, Lock, Quit), ↑/↓/Enter/Esc, foco
  preso, `aria-activedescendant`, fecha depois de agir e devolve o foco.
- `src/style.css` (reescrito): tema escuro sóbrio, monospace, contraste alto, `:focus-visible`, layout
  de janela cheia (100vh, sem rolagem externa) e as classes genéricas que Settings consome.
- `docs/handovers/v2-ui-app.md` (este arquivo).
- Apagados (obsoletos na v2): `admin.html`, `paleta.html`, `carregando.html`, `src/casca.ts`,
  `src/paleta.ts`, `src/carregando.ts`.

## Critério de aceite e como cada item foi atendido

| Item | Como foi atendido | Evidência |
| --- | --- | --- |
| `index.html` conforme §5 | `lang="en"`, `<title>Bond</title>`, `/src/style.css`, `<div id="app">`, módulo `/src/app.ts` | `leitura` |
| Tela bloqueada | Card centrado. Primeiro uso (`!hasAccount && !requiresInvite`) → `Create the admin account` (name, email, password, confirm); sem conta e com convite aberto → `Create your account` com `Invite code`; com conta → `Unlock` (email, password) e o link `I have an invite` que troca para criar conta com código; `Unlock with Touch ID` quando `session.biometric` e `info.os === 'macos'`, `Unlock with biometrics` fora do macOS; `waitMs` vira contagem `wait N s` com o submit desabilitado. Erros sempre por `message(container, 'error', errorMessage(e))` | `leitura` |
| Layout desbloqueado | `.shell` é grid de duas colunas (sidebar de 68 px, 64 px abaixo de 900 px de largura) com `.content` rolando e `.main` sem rolagem; sidebar = marca do Bond (botão que volta para Home) + um botão por ferramenta + rodapé com Settings e Lock | `leitura` |
| Ícone da ferramenta | `ToolStatus.icon` (data URI do backend) ou as duas primeiras letras do título em `.chip`; badge de dígito; classes `open`/`loading`/`error`; `title` = título + resultado de login; `click` → `tools.open` | `leitura` |
| Home | Header `Tools` + grid responsivo (`repeat(auto-fill, minmax(250px, 1fr))`) de cartões de `catalog.list` casados com `tools.state` por `id`: ícone, título, host, linha de estado (`Open`, `Not open`, `Loading…`, `Failed: <msg>`), linha de login (`Signed in with session` / `Signed in by Bond` / `Signed in via provider` / `Sign in manually` / `Sign-in failed`, omitida quando `login === null`), botões `Open`/`Bring to front`, `Close` quando aberta, `Try again` quando `error !== null` e as vistas como botões pequenos (`tools.openView`) | `leitura` |
| Estado vazio | `No tools yet.` e, para admin, `Add a tool in Settings → Tools` | `leitura` |
| Settings | `mountSettings(container, { session, info, tab })` montado em `.settings-view`; `update(session)` quando só a sessão muda, `setTab(tab)` quando a paleta troca de aba, `destroy()` em toda desmontagem (Home, lock, view trocada) | `leitura` |
| Teclado | Cmd/Ctrl+1..9 → `tools.open` do dígito de `tools.state`; Cmd/Ctrl+K → paleta; Cmd/Ctrl+, → Settings; os mesmos atalhos só valem desbloqueado | `leitura` |
| Pushes | `palette` → abre a paleta; `session` → re-render (bloqueado ↔ desbloqueado, troca de papéis; lock limpa ferramentas, catálogo e volta para Home); `tools` → sidebar e Home; `catalog` → `catalog.list` e depois sidebar e Home | `leitura` |
| Paleta | Overlay modal com input; itens na ordem ferramentas → vistas → ações; subsequência sem caixa/acento com prefixo primeiro; ↑/↓/Enter/Esc; foco preso (`focusin` devolve o foco ao campo, Tab fica no campo) e devolvido ao elemento anterior no fecho; `aria-activedescendant`/`role=listbox`/`role=option`; fecha depois de agir e **só** fecha quando a ação deu certo (erro fica na paleta, por `message`) | `leitura` |
| `style.css` | Todas as classes de `src/ui.ts` (`.button .button-primary .button-danger .button-ghost .field .field-label .field-hint .input .message .message-error .message-ok .message-info`) e as genéricas que Settings usa (`.tabs .tab .tab-active .table .muted .chip .row .stack .card .grid .empty`), mais as classes de layout; `prefers-reduced-motion` corta animação/transição; `:focus-visible` com contorno de 2 px | `leitura` |
| Sem português | `grep` por `[áàâãéêíóôõúçÁÀÂÃÉÊÍÔÕÚÇ]` e por palavras pt em `index.html`, `src/app.ts`, `src/palette.ts`, `src/style.css`: nenhuma ocorrência | `leitura` |
| Sem `innerHTML`, sem storage, sem console | `grep` por `innerHTML|localStorage|sessionStorage|console\.` nos quatro arquivos: nenhuma ocorrência; todo texto entra por `textContent` (via `el`/`message`) | `leitura` |
| Só métodos de `ApiContract` | Métodos chamados: `session.state`, `session.unlock`, `session.unlockBiometric`, `session.createAccount`, `session.lock`, `catalog.list`, `tools.state`, `tools.open`, `tools.close`, `tools.reload`, `tools.openView`, `bond.info`, `bond.quit` — todos em `ApiContract` | `leitura` |

## Como a superfície foi exercitada

**Somente `leitura`** — a fatia foi instruída a editar e nada mais. Não rodei teste, typecheck, build,
smoke, linter nem formatador. Conferência de `leitura` feita com `grep` (idioma, APIs proibidas,
métodos da API) e com contagem de chaves em `src/style.css`, `src/app.ts` e `src/palette.ts`; a
checagem de tipo e a prova na interface real são do coordenador, pelos gates da §6 do contrato
(`bunx tsc -p tsconfig.json`, `bun run app:build`, `bun test/smoke/run.ts`). O smoke da v1 usava
`admin.html`/`paleta.html`/`carregando.html`: esses caminhos não existem mais.

## Decisões dentro da fatia (não são divergência de contrato, mas o coordenador deve saber)

- **Marca do Bond é o botão de Home.** A §5 pede a marca no topo da sidebar e a Home como conteúdo;
  sem um controle de volta, Settings virava beco sem saída no mouse. A marca virou `<button>` com
  rótulo `Home`.
- **Settings abre em `account`.** Vale para todos; a paleta alcança cada aba permitida. `settings.ts`
  também tem seu próprio default (`tools` para admin), que só valeria sem `tab` explícito.
- **`entry.icon` só entra na Home quando é data URI.** `repo.listEntries()` devolve `icon = null` e o
  caminho do seed (ex.: `icons/kanban.png`) não é legível pela página; o ícone confiável é
  `ToolStatus.icon`. Sem data URI, o cartão cai nas duas letras.
- **`Try again` chama `tools.reload`.** É o único método de recarga do `ApiContract`; `tools.open`
  numa janela já aberta só traz para a frente.
- **Espera após falha de desbloqueio.** `session.unlock` lança `'wait before trying again'` sem
  `waitMs`; nesse erro a tela relê `session.state` e arma a contagem com o `waitMs` que o backend
  mantém. Se o push `session` chegar com `waitMs > 0`, a contagem é rearmada na renderização.
- **Formulários com `novalidate`**: a validação é da própria página (`fill in every field`,
  `passwords do not match`) para não herdar mensagem nativa no idioma do sistema.
- **A paleta guarda o teclado** enquanto está aberta: combinações Cmd/Ctrl são interrompidas dentro
  dela (`stopPropagation`), então ⌘1..⌘9 não abre ferramenta por baixo do overlay.

## O que ficou de fora e por quê

- **Rótulos das abas duplicados.** A paleta precisa dos rótulos e do flag de admin de cada aba; o
  `TABS` de `src/settings.ts` tem os mesmos dados, mas não é exportado. Não toquei em `settings.ts`
  (arquivo de outro dono): a lista vive em `src/palette.ts` (`SETTINGS_TABS`). Se o coordenador quiser
  fonte única, `settings.ts` passa a exportar esse metadado e a paleta importa — mudança de outro
  dono.
- **`backend/main.ts` v1 ainda referencia as páginas apagadas.** `janelas.abrir` abre `admin.html` e
  `backend/palcos.ts` abre `paleta.html`/`carregando.html`; os dois são de outras fatias (o
  `tool-windows.ts` v2 já existe). Avisei o dono de `backend/main.ts`; enquanto o v1 estiver no
  repositório, essas chamadas apontam para arquivos que não existem mais.
- **Nada de execução.** Sem rodar nada, não há prova de comportamento observado — só a checagem de
  texto e de estrutura descrita acima.

## Onde a evidência caiu

Neste arquivo; o estado da fatia é o `em-curso` da issue B04 e a entrega no `FRENTE.md` do front.

## Fix

Causa: `const root = document.getElementById('app')` guardava o tipo `HTMLElement | null` e o
estreitamento do `if (root === null) throw …` do topo do módulo não sobrevive dentro dos corpos de
função (o *flow analysis* do TypeScript reinicia no escopo de cada função), então os três usos de
`root` em `renderLocked`, `buildShell` e `boot` foram vistos como possivelmente nulos — `TS18047`
em `src/app.ts:105`, `:321` e `:623`.

Mudança (só `src/app.ts`, sem outra alteração de comportamento): a obtenção do `#app` virou a função
`requireRoot(): HTMLElement`, que faz o `getElementById` e lança `new Error('index.html must provide
#app')` quando o elemento não existe; o módulo guarda o resultado em
`const root: HTMLElement = requireRoot();`. O tipo é `HTMLElement` sem `null`, então os três usos
passam a ser não nulos por tipo — sem `!`, sem `as`, sem guarda repetida em cada uso. A mensagem de
erro e a checagem única na inicialização continuam as mesmas.

Evidência: `leitura` — os três pontos de erro (`:105`, `:321`, `:623`) são os únicos usos de `root`
no arquivo (`grep 'root' src/app.ts`), e todos leem a mesma constante agora tipada `HTMLElement`.
Não rodei `tsc`, teste, build, smoke, linter nem formatador: a checagem de tipo é do coordenador.
