# Fatia v2-ui-settings — a tela de Settings (`src/settings.ts`)

Dono: fatia v2-ui-settings. Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md`
(`em-curso`). Contrato: `docs/arquitetura.md` §5 (linha `src/settings.ts`) e §2 (regras de módulo);
tipos: `shared/types.ts` (v2, não tocado); clientes: `src/api.ts` e `src/ui.ts` (não tocados);
requisitos: `docs/canonico.md` §7 (uma janela), §8 (catálogo, RF-29), §9 (contas e convites),
§10 (papéis e concessões), §11 (cofre; RF-28), §12 (telas do admin), §13 (auditoria; RF-12),
§14 (RF-11, RF-13, RF-24, RF-25). Vocabulário: `CONTEXT.md`.

## Arquivos tocados

- `src/settings.ts` (novo) — `export type SettingsTab` com as sete abas e
  `export function mountSettings(root, ctx)` devolvendo `{ setTab, update, destroy }`, assinatura
  exata do §5. Toda a tela: abas, Account, Vault, Tools, Roles, People, Activity, Catalog.
- `src/admin.ts` — apagado (v1, português: painel de admin e página de conta).
- `src/admin.css` — apagado (v1; o estilo v2 é um só, `src/style.css`, de outro dono).
- `docs/handovers/v2-ui-settings.md` (este arquivo).

Nenhum outro arquivo foi aberto para escrita. Um arquivo, um dono: não escrevi em `src/app.ts`,
`src/palette.ts`, `src/style.css`, `src/api.ts`, `src/ui.ts`, `shared/`, `backend/` nem `test/`.
Nenhum arquivo CSS foi criado. Nenhuma dependência nova.

## Critério de aceite e como foi atendido

Evidência por `leitura`. O despacho proíbe executar testes, typecheck, build, smoke, linter e
formatador ("**DO NOT run tests, typecheck, build, smoke, linter or formatter. Only edit.**"), então
o que segue é o que o código diz, não resultado observado de execução. O que fecha o critério é do
coordenador (ver "Comando rodado e resultado observado").

### a) Nenhum texto em português; só métodos de `ApiContract`

- Nenhum acento, nenhuma palavra pt-BR no arquivo: `grep -nP "[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÇ]|chamar|
  cofre|sessao|papel|pessoa" src/settings.ts` não devolve nada (comando rodado; saída vazia). Comentário
  de topo, rótulos, botões, mensagens de erro locais e nomes de identificador são em inglês.
- Todo acesso ao backend passa por `call()` de `./api`; o único outro ponto do runtime é
  `tiny.dialog.saveFile`/`openFile` para escolher arquivo (§2). `grep -o "call('[A-Za-z.]*'"` lista 29
  nomes distintos, todos chaves literais de `ApiContract` em `shared/types.ts`: `session.changePassword`,
  `session.enableBiometric`, `catalog.list|get|probe|save|remove|exportToFile|importFromFile`,
  `roles.list|save|remove|grant`, `people.list|setRoles|revoke`, `invites.issue`,
  `vault.list|save|reveal|remove|exportToFile|importFromFile`, `tools.open`,
  `events.list|exportToFile`, `bond.info|checkUpdate|installUpdate`. Nenhum `app.*` (o contrato avisa
  que os builtins do runtime venceriam), nenhum `login.report`, nenhum método inventado.

### b) Quem não é admin nunca dispara método de admin

Três guardas, todas por leitura:

1. **Abas** — `canShow(tab)` reconhece a aba em `TABS` e exige `admin` só para Tools, Roles, People,
   Activity e Catalog; `load()` começa com `if (person() === null || !canShow(state.tab)) return;`,
   então nenhuma lista de aba de admin é lida fora dela.
2. **Desenho** — `render()` só desenha o botão das abas `admin` quando `isAdmin()`; e a carga de cada
   aba chama métodos de admin só nos seus próprios `case`. Não há caminho em que Account ou Vault
   chame `catalog.get|probe|save|remove|exportToFile|importFromFile`, `roles.save|remove|grant`,
   `people.*`, `invites.issue`, `events.*`.
3. **Install** — o botão `Install` (`bond.installUpdate`, método de admin no §2) só é anexado quando
   `update.available && isAdmin()`; `Check for updates` (`bond.checkUpdate`, que não é de admin) é de
   todos.

`update(session)`: se a sessão bloqueia, a tela volta a `Session locked` sem ler nada; se a pessoa
perdeu o papel de admin, `if (!canShow(state.tab)) state.tab = defaultTab();` tira a aba de admin da
tela antes de qualquer `load()`.

### c) Abas e estado da sessão

- `TABS` na ordem da tela: Account, Vault, Tools, Roles, People, Activity, Catalog; Account e Vault
  para todos, o resto só para admin.
- Aba inicial: `defaultTab()` = `'tools'` para admin, `'account'` para os demais; `ctx.tab` só vale se
  `canShow(ctx.tab)` (§5 manda Tools para admin e Account para os outros).
- Sessão bloqueada → `<p class="muted">Session locked</p>`, sem abas, sem dado e sem chamada.
- Clique de aba (`selectTab`) limpa a mensagem, esconde a credencial revelada, descarta o código do
  convite e o formulário de ferramenta em edição, e recarrega só a lista daquela aba.
- `setTab(tab)` da fatia usa a mesma `selectTab`, com a guarda de aba visível.

### d) Account

- Nome, e-mail, papéis (nomes vindos de `roles.list`, chip `admin`/`member`) — a aba carrega
  `roles.list` para isso (`roles.list` não é método de admin no §2).
- Trocar senha: atual, nova e confirmação; confirmação divergente é erro **local** ("The new password
  and its confirmation do not match"), o backend só vê a senha nova; sucesso → `session.changePassword`
  e a mensagem "Password changed"; como o cartão é reconstruído a cada desenho, os três campos voltam
  vazios no sucesso (o valor só existe no `<input>`, lido no clique).
- Biometria: cartão inteiro escondido no Linux (`ctx.info.os === 'linux'`, canonico §9 — lá não há
  biometria a oferecer); no resto, campo de senha local + `Enable biometrics` →
  `session.enableBiometric`; o `SessionState` devolvido passa a valer nesta montagem e o texto do
  cartão muda ("Biometrics enabled on this machine." / "Biometrics not enabled.").
- Versão e seed de `ctx.info`: `Bond <version> · seed <seedVersion|none> · <os>`.
- `Check for updates` → `bond.checkUpdate`; com `available` mostra a versão nova e (só admin) o botão
  `Install`; sem atualização, "No update (current X)"; `notes` quando vier.
- `ctx.info.tray === false` → "Closing the window quits Bond on this system.".

### e) Vault

- `vault.list` com o título da ferramenta (`catalog.list`), usuário e rótulo (chip); lista vazia →
  "No credentials saved.".
- Salvar: seletor de ferramenta (de `catalog.list`), usuário, senha, rótulo → `vault.save`; sem
  ferramenta escolhida, "Choose the tool of the credential"; o rótulo só vai quando não é vazio
  (`label` é opcional no contrato); sucesso → mensagem, lista recarregada e campo de senha vazio (o
  cartão é reconstruído).
- Revelar → `vault.reveal`, mostrado por 10 s (`REVEAL_MS`) e escondido pelo próprio timer; `Hide`
  esconde na hora; trocar de aba, bloquear a sessão ou `destroy()` cancelam o timer e zeram o valor.
- Remover → `confirm(...)` e então `vault.remove`.
- Export → `tiny.dialog.saveFile({ types: ['bondvault'], name: 'bond-vault.bondvault' })` e, com o
  caminho, `vault.exportToFile({ password, path })` com a senha local digitada no campo ao lado
  (vazio → "Enter the local password to export"; diálogo cancelado → nada acontece).
- Import → `tiny.dialog.openFile({ types: ['bondvault'] })` e `vault.importFromFile({ password, path })`,
  mostrando a contagem ("1 credential imported"/"N credentials imported"). A senha local é lida do
  campo no clique; o arquivo cifrado é do backend (§4), a página só passa o caminho.

### f) Tools

- Lista de `catalog.list`: título, id, endereço, papéis, número de vistas, chip `active`/`inactive` e os
  botões `Edit`, `Open` (`tools.open`, que exige só sessão desbloqueada) e `Remove`
  (`confirm` + `catalog.remove`).
- `Add tool` abre o formulário; `Probe` chama `catalog.probe` com o endereço digitado e preenche:
  título (quando a sonda traz), **id sugerido de `slug(title)` de `../shared/catalog`** (minúsculas,
  sem acento, não-alfanumérico → `-`, máximo 40 — a mesma regra do §3), endereço, ícone (da sonda) e a
  nota do resultado: `Redirects to <provider>` / `Has a sign-in form` / `No sign-in detected`.
- Ícone: prévia (`<img width/height 24>`) do ícone da sonda ou do arquivo enviado; upload aceita
  PNG/SVG/JPEG/WebP (`accept` + a lista de MIME) e vira `RawIcon { type, base64 }` com base64 puro (sem
  o prefixo `data:`); formato fora da lista → "Image format not accepted: use PNG, SVG, JPEG or WebP";
  `Remove icon` marca a remoção.
- Ordem, papéis (checkboxes de `roles.list`), `Active`, editor de vistas (rótulo, endereço, modo
  `window`/`navigate`, `Add view`, `Remove`) e `Never fill the sign-in form` → `auth: { noFill: true }`
  (`auth: null` quando desmarcado).
- Salvar → `catalog.save({ entry, icon, probe })`: `icon` **só** entra quando o ícone mudou nesta
  edição (inclusive quando foi removido — aí vai `null` explícito); `probe` entra quando há uma sonda
  desta edição; sem nenhum dos dois, a entrada salva mantém o ícone e a sonda do banco.
- `Edit` carrega `catalog.get` e mostra "Usually signs in via: `<usualLogin>`" quando vem, mais a nota
  da sonda salva.
- Fora de `ctx.info.gateOrigins` (origin calculada do endereço por `originOf`, com `try`/`catch`):
  "This tool will report sign-in results after the next release includes it in the seed."

### g) Roles

- Lista de `roles.list` com o id, o nome editável, chip `admin`; `Rename` → `roles.save`; `Remove`
  (`confirm` + `roles.remove`) **não existe** para papel com `admin: true` (o backend também recusa
  com `'the admin role cannot be removed'`).
- `Create role`: id = `slug(name)`; nome sem letra nem dígito → "Enter a name with letters or digits";
  papel novo sempre `admin: false`.
- Grade ferramenta × papel com checkbox por par → `roles.grant({ roleId, toolId, granted })`, com
  `aria-label` "`<papel>` on `<ferramenta>`".

### h) People

- `people.list` com checkbox por papel → `people.setRoles({ personId, roles })`.
- `Revoke` com `confirm` (o texto muda quando a caixa "Also delete their saved credentials" está
  marcada) → `people.revoke({ personId, deleteCredentials })`; o botão **não é desenhado** na sua
  própria pessoa (`target.id === owner.id`), que o backend também recusa.
- `Issue invite`: checkboxes de papéis + `Days` (7 por padrão) → `invites.issue({ roles, days })`;
  o código sai **uma vez** num campo `readOnly` (foco seleciona) com `Copy`
  (`navigator.clipboard.writeText`), o aviso "Save it now: this code will not be shown again." e a
  validade; `state.invite` é zerado ao sair da aba, então o código não volta a aparecer.

### i) Activity

- `events.list` com filtro de ferramenta e de resultado (os valores de resultado saem dos próprios
  eventos já vistos, ordenados); tabela com tempo (`at`), pessoa (nome de `people.list`), ferramenta
  (título de `catalog.list`), tipo, resultado e endereço (`url`).
- `Export JSONL` → `tiny.dialog.saveFile({ types: ['jsonl'], name: 'bond-activity.jsonl' })` e
  `events.exportToFile({ path })`.

### j) Catalog

- `Export seed` → `tiny.dialog.saveFile({ types: ['json'], name: 'seed.json' })` e
  `catalog.exportToFile({ path })`.
- `Import seed` → `tiny.dialog.openFile({ types: ['json'] })` com os rádios "Merge (add new only)" /
  "Overwrite existing" (padrão merge) e `catalog.importFromFile({ path, mode })`; o resultado mostra as
  contagens ("Seed imported: 2 entries, 1 role, 0 invites") e as listas de papéis e entradas voltam a
  ser lidas.

### k) Push `catalog`, segredos e ciclo de vida

- `on('catalog', …)` recarrega a aba atual; `destroy()` desliga esse listener, cancela o timer da
  revelação e limpa o container; um `alive = false` impede que uma resposta em voo volte a desenhar
  depois do `destroy()`.
- Nenhum segredo em log, console, `store`, `localStorage` ou mensagem de erro: a senha local e a
  credencial da ferramenta são lidas do `<input>` no clique e nunca passam para outra variável; o
  valor revelado vive só no estado da montagem, e só enquanto está na tela (`hideRevealed` zera).
- O único timer é o da revelação (10 s); `update()` com sessão bloqueada, troca de aba e `destroy()`
  cancelam.

## O que outro dono precisa fazer

- **`src/app.ts`** (já escrito, dono 43): confere por leitura — `mountSettings(container, { session,
  info, tab: view })` com `view: SettingsTab`, `SettingsHandle` local com os três métodos e
  `settings.setTab(target)` no `go()` da paleta. Nada a ajustar; a assinatura bate com o §5.
- **`src/style.css`** (dono 43): as classes que usei são as do §5 + as do `src/ui.ts` —
  `.tabs .tab .tab-active .table .row .stack .card .grid .empty .muted .chip` e
  `.button .button-primary .button-danger .button-ghost .field .field-label .field-hint .input
  .message .message-error .message-ok .message-info`. Conferido por leitura que o arquivo atual
  define todas. Não usei `.mono` nem `.painel/.campo/.botao/.abas` da v1.
- **`backend/main.ts`** (dono 42): a guarda de admin e "sem sessão" é dele (§2); a tela depende de
  `catalog.list` e `roles.list` responderem também para quem não é admin (títulos do cofre e nomes de
  papel na conta) e de `catalog.list` já devolver as entradas com `icon` (data URI) quando existir —
  ver o achado abaixo.

## O que ficou de fora, e por quê

- **Home, sidebar, paleta, tela de entrada, atalhos e ciclo da sessão** — `src/app.ts` e
  `src/palette.ts`, de outro dono (§5). Esta fatia só recebe `session`, `info` e a aba.
- **Estilo** — `src/style.css`, de outro dono; nenhum arquivo CSS novo.
- **Guardas de backend, eventos e leitura/escrita de arquivo** — `backend/main.ts`, `backend/session.ts`
  e `backend/vault.ts` (§2, §4). A página nunca lê nem escreve arquivo: só escolhe o caminho com
  `tiny.dialog` e o manda como parâmetro.
- **Papéis de admin, convites usados, backoff de desbloqueio, "rotação pendente" do cofre de
  terceiros** (canonico §12) — não existem na v2: `VaultItem` não tem rotação e o convite usado sai da
  lista sozinho (`listPeople` ignora revogados, `listInvites` só mostra os ativos).

## Achados para o coordenador (fora do meu escopo de escrita)

1. **Confirmações usam `window.confirm`** — o §2 só deixa a página escolher arquivo com
   `tiny.dialog`; para remover credencial/ferramenta/papel e revogar pessoa usei `confirm()` (a mesma
   chamada da v1, que passou no smoke de superfície real). Se o dono preferir o diálogo nativo
   (`tiny.dialog.confirm`), é mudança de contrato — e de três fatias.
2. **Timer da revelação de 10 s é da página** — `window.setTimeout`. O `docs/tinyjs.md` registra que
   janela ocluída é throttled; com a janela principal escondida o segredo pode ficar na tela mais que
   10 s. Trocar por relógio do backend (evento de push + `vault.reveal` sem retorno) resolve, mas mexe
   no contrato de `vault.reveal` — por isso deixei como está.
3. **Prévia do ícone salvo depende de `catalog.get`** — uso `details.entry.icon` (data URI por tipo).
   Se o backend devolver `icon: null` em `catalog.get` (como `listEntries` faz em `repo.ts`), a prévia
   da edição sai vazia até o admin sondar de novo; o fallback natural é `details.probe.icon`. O
   contrato não fecha esse ponto.
4. **Título no cofre** — um item de cofre de ferramenta que a pessoa não vê mais (`catalog.list`
   filtrado por `visibleEntries`) aparece com o **id** como título, porque o título vem só de
   `catalog.list`. Nada quebra (usuário e rótulo continuam certos); é limite assumido do §5.
5. **Pessoa que perde `admin` com a paleta/`setTab` em voo** — a guarda é `canShow` na hora do
   clique; o `update(session)` de `app.ts` corrige a aba na primeira mensagem de sessão seguinte.

### Decisões declaradas (dentro da liberdade da fatia)

1. **Editor de ferramenta descartado ao sair da aba Tools** (e não mantido entre abas, como na v1):
   estado velho na tela era a fonte de confusão da v1, e o formulário não guarda segredo.
2. **Código do convite zerado em qualquer troca de aba** (§5 pede "cleared when leaving the tab";
   zerei também ao voltar para People, que é o comportamento seguro).
3. **Rótulo da senha do cofre só vai quando não é vazio** — `label` é opcional no contrato e string
   vazia no banco é ruído.
4. **`state.info` é relido com `bond.info` depois de importar seed**, para a versão do seed mostrada
   em Account não ficar velha (a v1 fazia o mesmo com `app.info`). `bond.info` não é método de admin.
5. **`Roles`/`catalog.list` também na aba Account** — mostra os nomes dos papéis da pessoa; são os
   mesmos métodos que Vault e Tools já pedem.

## Comando rodado e resultado observado

Nenhum comando de verificação. A instrução do despacho ("DO NOT run tests, typecheck, build, smoke,
linter or formatter. Only edit.") foi seguida: toda a evidência acima é `leitura` do contrato §5, dos
tipos e do próprio arquivo. Rodaram-se apenas consultas de leitura sobre o texto
(`grep`/`ls`/`wc`) para conferir vocabulário, nomes de método, consumidores e classes de CSS.

Fica para o coordenador: `bunx tsc -p tsconfig.json` (o `include` cobre `src/` e `shared/`; é o que
pega qualquer desvio de tipo em `src/settings.ts` e o import de `../shared/catalog`), `bun test test/`
e o smoke `test/smoke/run.ts` — que é onde a tela aparece de verdade (abrir Settings, trocar de aba,
salvar credencial, revelar e esconder em 10 s, exportar/importar arquivo pelo diálogo nativo).
