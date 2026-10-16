# v2 — `backend/main.ts`, `backend/probe-net.ts`, `backend/seed.ts`, `backend/icons.ts`

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (status `em-curso`).
Contrato: `docs/arquitetura.md` §2 (guarda de janela), §4 (`backend/main.ts`, `backend/probe-net.ts`,
`backend/seed.ts`, `backend/icons.ts`) e §6; requisitos `docs/canonico.md` §7, §8, §11, §13, §14
(RF-12, RF-15, RF-16, RF-26 a RF-29), §19, §20.

## Arquivos tocados

- `backend/icons.ts` (criado): a lógica provada da v1 passa a `createIcons(dir)` → `{ save(icon):
  Promise<string>; dataUri(hash): Promise<string | null> }` (tipo `Icons`), com o hash SHA-256 em hex
  como nome do arquivo e data URI na saída. Exporta também os três helpers que o seed e a sonda
  precisam (`typeOfPath` extensão → tipo, `typeOfMime` media type → tipo, `bytesToBase64`).
  Substitui `backend/icones.ts` (apagado).
- `backend/probe-net.ts` (criado): `probe(url)` = `originOf` (mensagem de `shared/catalog`) +
  `fetch` com redirect, **prazo de 10 s** e HTML até 2 MiB lido por `getReader`, ícones só `http(s)`
  e ≤ 512 KiB (por `content-length` e por contagem de bytes), `analyzeHtml`/`detectProvider`/
  `iconType` de `shared/probe.ts`; corrida com o relógio e checagem de prazo dentro dos laços de
  leitura; falha → `"couldn't open the address: <reason>"`. Substitui `backend/sonda-rede.ts`
  (apagado).
- `backend/seed.ts` (reescrito, inglês): `applyBundledSeed(repo, resourcesDir, icons, readFile?)`
  (boot; `readFile` injetável, default `tjs.readFile`; registra `seed_applied`), `importSeedFile(repo,
  json, mode, icons)` (merge/overwrite por `planSeed`) e `gateOrigins(seed)`; mais
  `storedSeedVersion(repo)`. Ícone relativo só entra sem `..`, sem absoluto e sem unidade; ícone por
  data URI continua aceito; qualquer outro caminho é ignorado.
- `backend/main.ts` (reescrito, inglês): `init` (banco, `migrate`, `ensureAdminRole`, seed do pacote
  com erro virando evento, `capabilities()` uma vez, sessão, cofre, janelas de ferramenta,
  `setMinSize(760, 500)` na `main`, bandeja), a guarda da §2 (mapa tipado `{ [M in Method]: Handler<M> }`
  embrulhado por `guarded`, garantindo todas as chaves de `ApiContract`) e os hooks `onNavigate`,
  `onWindowOpen`, `onDownload`, `onWindowClosed`, `onWindowState`, `onHotkey`, `onTray`.
- `test/seed.test.ts` (criado): `memorySqlite()` de `test/helpers/sqlite-bun.ts` + `createRepo` +
  ícones falsos + `readFile` injetado. Não havia teste de seed na v1 (a lista de remoções do §1 não
  inclui nenhum), então este arquivo não substitui outro.
- `docs/handovers/v2-main.md` (este arquivo).

## Critério de aceite e como cada item foi atendido

| Item | Como foi atendido | Evidência |
| --- | --- | --- |
| Guarda: tudo menos `login.report` só de `meta.window === 'main'` | `guarded` recusa qualquer outra janela com `this method is only available in the main window` | `leitura` |
| `login.report` só de janela de ferramenta, com `meta.origin` | `toolOfWindow(meta.window)` nulo → `login.report only comes from a tool window`; com origin carimbada, ela tem de ser igual a `originOf(entry(toolId).url)` (`login.report only comes from the tool origin`); `toolWindows.onReport(meta.window, state, meta.origin)` recebe a origin | `leitura` |
| Listas de sem-sessão e de admin exatamente as da §2 | `WITHOUT_SESSION` = `session.state`, `session.createAccount`, `session.unlock`, `session.unlockBiometric`, `bond.info`, `bond.quit`; `ADMIN_ONLY` = `catalog.get/probe/save/remove/exportToFile/importFromFile`, `roles.save/remove/grant`, `people.list/setRoles/revoke`, `invites.issue`, `events.list/exportToFile`, `bond.installUpdate` | `leitura` |
| `bond.info` = `AppInfo` com `gateOrigins` do seed embutido e `tray` | `{ version, seedVersion: storedSeedVersion(repo), os, gateOrigins: gateOrigins(bundledSeed), tray }`; `bond.quit` → `app.quit()` e `true` | `leitura` |
| Capacidades lidas uma vez no `init` | `app.system.capabilities()` (`backend/tiny.d.ts:1437-1445`); regra “ausente = suportado” (`!== false`) para `tray`, `hotkey` e `authenticate`; biometria só fora do Linux; a bandeja só existe se `app.tray.set` não lançar | `leitura` |
| Bandeja da §4 | menu `open` ("Open Bond"), `lock` ("Lock"), separador, `quit` ("Quit Bond"); clique = `open`; ícone `sf:rectangle.stack` no macOS, `emoji:🔗` no Windows e `paths.resources + '/tray.png'` no Linux; `app.win.setHideOnClose(true)` só com bandeja | `leitura` |
| Hook da bandeja com nome e assinatura do runtime | `export function onTray(id: string | null, app: TinyApp)` (`.agents/skills/tinyjs/references/recipes.md:17`, `api.md:605`) | `leitura` |
| Desbloquear/criar conta → `session`, `tools`, `restore()` | `afterUnlock(state)`: `push('session')`, `push('tools')`, `await windows.restore()`, `push('tools')` | `leitura` |
| Bloquear → `closeAll()` e `push session` | `lockSession()`: `session.lock()`, `windows.closeAll()`, `push('session')`, `push('tools')` | `leitura` |
| Mudança em catálogo/papéis/concessão/pessoas → `refresh`, `reconcile`, `catalog`, `tools`, `session` | `afterChange()` chamado por `catalog.save/remove/importFromFile`, `roles.save/remove/grant`, `people.setRoles/revoke` | `leitura` |
| `catalog.remove` limpa o cofre antes (A6) | `await vault.removeAllForTool(id)` antes de `repo.removeEntry(id)` | `leitura` |
| `catalog.get` devolve `usualLogin` | mais frequente entre `repo.loginResults(id, 20)`; empate fica com o mais recente (a lista vem do mais novo para o mais antigo e a comparação é estrita) | `leitura` |
| `catalog.save` persiste `probe` e trata o ícone por presença de chave | `extras = {}`; `icon` ausente preserva, `null` remove, `RawIcon` grava; `probe` presente entra em `probeValue` | `leitura` |
| Export/import por arquivo | `catalog.exportToFile` escreve `JSON.stringify(exportSeed(...), null, 2)` com `tjs.writeFile`; `catalog.importFromFile` lê com `tjs.readFile` e chama `importSeedFile`; `vault.exportToFile` confere a senha local antes; `vault.importFromFile` e `events.exportToFile` idem; caminho vazio recusado por `text()` | `leitura` |
| `people.revoke` | recusa a própria pessoa (`"you can't revoke yourself"`) e o último admin (`'the last admin cannot be revoked'`); remove o índice do cofre sempre (`removeVaultOf` ou `removeAllOf` com `deleteCredentials`); apaga `bond.bio.<id>` do chaveiro; evento `access_revoked` | `leitura` |
| Convite: código mostrado uma vez, evento sem o código | resposta `{ code, expiresAt }`; evento `invite_issued` guarda só papéis e validade | `leitura` |
| `bond.installUpdate` registra o evento antes (A13) | `addEvent({ type: 'update', result: 'requested' })` e só depois `app.update.install()` | `leitura` |
| `probe-net.ts`: prazo de 10 s, 2 MiB / 512 KiB, ícones `http(s)`, mensagem de erro | `TIMEOUT_MS = 10_000` com relógio correndo contra o `fetch` e checagem de prazo em cada laço de leitura; `HTML_LIMIT`/`ICON_LIMIT`; `/^https?:/` nos ícones; `couldn't open the address: <reason>` | `leitura` |
| `seed.ts` com `applyBundledSeed`/`importSeedFile`/`gateOrigins` e `readFile` injetável | assinaturas idênticas ao §4 (mais `SeedCounts` e `storedSeedVersion`); caminho relativo só sem `..`/absoluto/unidade; `gateOrigins` devolve a origin exata de cada entrada, na ordem do seed e sem repetição | `leitura` |
| Hooks com os nomes do runtime | `onNavigate`, `onWindowOpen`, `onDownload` (evento com `auditUrl`), `onWindowClosed`, `onWindowState` (foco), `onHotkey`, `onTray` — todos `(info, app)` exceto onde a doc diz `(id, app)` | `leitura` |
| `test/seed.test.ts` cobre o critério | seed aplicado uma vez (segundo boot com a mesma versão não faz nada), versão nova insere só o id que falta, ícone com `..`/absoluto/unidade ignorado, `importSeedFile` overwrite atualiza o título de uma entrada existente (e merge não), `gateOrigins` devolve as origins exatas | `leitura` |
| `api` com as chaves de `ApiContract` | objeto `{ [M in Method]: Handler<M> }` (todas as 39 chaves, cada uma checada pelo tipo) e `export const api: Record<string, TinyApiHandler>` | `leitura` |

## Comando rodado e resultado observado

Nenhum. A fatia foi instruída a **não** rodar testes, typecheck, build, smoke, linter ou formatador;
toda a evidência acima é `leitura`. A verificação é do coordenador (§6: `bun test test/`, os dois
`tsc`, `bun run app:build` com e sem seed, `bun test/smoke/run.ts`).

## O que ficou de fora e por quê

- **Arquivos de outros donos.** `backend/palcos.ts`, `backend/adaptador.ts` e os módulos v1 de
  `shared/` e `src/` continuam no repositório: cada fatia apaga os seus (o §1 lista os removidos).
  Nada do meu lado os referencia (`grep` por `icones`, `sonda-rede`, `criarIcones`, `sondar(`: só as
  minhas ocorrências).
- **Guarda de origin no runtime.** Quem fecha a porta de verdade é `scripts/gen-config.ts` (já em
  v2); a checagem em `requireToolOrigin` é a segunda camada (a mesma que o `tool-windows.ts` faz).
- **Nada de `store` para senha.** O export do cofre vai para o arquivo escolhido pela janela
  principal; nenhum valor de credencial passa por evento, `store` ou log.

## Conferência de leitura contra o smoke v2 (`test/smoke/smoke.html`, já reescrito)

Cruzamento dos passos do smoke com o que `backend/main.ts` entrega (evidência `leitura`, nenhuma
execução):

| Passo | O que ele exige | O que a fatia entrega |
| --- | --- | --- |
| 1–2 | `session.state` com sessão bloqueada; `session.createAccount` devolvendo pessoa admin desbloqueada | guarda deixa os dois passar sem sessão; `afterUnlock` empurra `session`/`tools` e restaura |
| 3 | `catalog.probe` com título, formulário e ícone png | `probe()` de `probe-net.ts` |
| 4 | `catalog.save` com `icon` (RawIcon) e `probe`; `catalog.list` com data URI; `catalog.get` com a sonda salva | `extras.iconHash`/`extras.probe` por presença de chave; ícone via `icons.dataUri` |
| 5, 14 | `vault.save`/`vault.list`/`vault.remove` sem segredo de volta | `vault.*` com evento e sem valor no retorno |
| 6–10 | `tools.open`/`openView`/`state` | `toolWindows` repassado tal como o §4 pede |
| 11 | `events.exportToFile` → `true` | `writeTextFile(path, repo.eventsJsonl())` |
| 12 | `session.lock` fecha as janelas e `tools.state`/`catalog.list` falham com a sessão bloqueada | `lockSession()` + guarda (`tools.state` e `catalog.list` não estão em `WITHOUT_SESSION`) |
| 13 | senha errada com `invalid credentials`; desbloqueio restaura tool-a | mensagem vem de `shared/auth`/`session`; `afterUnlock` chama `windows.restore()` |

Nada no smoke chama `bond.info`, `bond.checkUpdate`, `bond.installUpdate`, `roles.*`, `people.*`,
`invites.issue` ou `catalog.exportToFile`; essas chaves existem pelo mapa tipado e seguem o §2.

## Decisões que o coordenador pode querer revisar

1. **`push('tools')` no lock.** A §4 pede `closeAll()` + `push session`; eu também empurro `tools`
   para a sidebar não mostrar ferramenta aberta depois de bloquear (o `tool-windows` também empurra
   por conta própria, então é redundante e idempotente).
2. **`login.report` não passa pela checagem de sessão.** A regra da §2 para ele é janela de
   ferramenta + origin; seguir a v1 (que também pulava a sessão) evita erro na página quando um
   relato atrasado chega logo depois do bloqueio.
3. **`seed_applied` registrado dentro de `applyBundledSeed`** (como na v1), porque só lá existem as
   contagens; `init` registra o evento de **falha**. `catalog_imported` é registrado no `main.ts`
   (é lá que existe a pessoa).
4. **`update` do export do catálogo** vem do seed embutido (o canal de atualização é da release, não
   da edição local); a v1 lia um `meta.atualizacao_url` que nada escrevia.
5. **`storedSeedVersion(repo)` e `SeedCounts`** são exports a mais de `backend/seed.ts` (o §4 lista
   só as três funções): sem `storedSeedVersion` o `main.ts` teria de repetir a chave
   `meta.seed_version` e o parse. A chave é privada da minha fatia — o repo trata meta como opaco.
6. **`capabilities()` pode não ter as chaves `tray`/`hotkey`/`authenticate`.** A regra “ausente =
   suportado” (§2) cobre isso; a bandeja ainda é confirmada por tentativa real em `app.tray.set`, de
   modo que no Linux sem AppIndicator não há bandeja e fechar a `main` encerra o app.

## O que outro dono precisa fazer

- Quem apagar `backend/palcos.ts`/`backend/adaptador.ts` deve lembrar que `backend/main.ts` já não os
  importa (nem `shared/catalogo.ts`, `shared/rail.ts`, `shared/cascata.ts` etc.).
- O smoke v2 (`test/smoke/run.ts`, `smoke.html`, `tools.ts`) já está em inglês e nos nomes da v2; ele
  depende desta fatia exatamente nos pontos da tabela acima.
- A página (`src/app.ts`, `src/settings.ts`, `src/palette.ts`) consome `bond.*`, `catalog.get`,
  `catalog.exportToFile/importFromFile`, `vault.exportToFile/importFromFile` e
  `events.exportToFile` com o caminho vindo de `tiny.dialog.*`; nada disso exige mudança no backend.
