# Fatia v2 — sessão e cofre (`backend/session.ts`, `backend/vault.ts`)

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (em-curso).
Contrato seguido: `docs/arquitetura.md` §2, §3 e §4; conceitos em `docs/canonico.md` §9, §11 e §13
(RF-07, RF-23, RF-24, RF-28). Tipos: `shared/types.ts` (v2, em inglês). Achados atendidos:
P6 (primeira conta com revogados na conta), D7 (consumo do convite numa transação), A6 (limpar o
cofre ao remover a ferramenta), A14 (`bond.bio.<pessoa>`), A23 (`refresh`).
Nada de `tjs`/`tiny` aqui: repositório, chaveiro, `store` e autenticador entram por `deps` — por
isso a fatia roda com `bun test`.

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `backend/session.ts` | criado (substitui `backend/sessao.ts`, apagado). `SessionDeps`, `Session` e `createSession`: `state`, `createAccount`, `unlock`, `unlockBiometric`, `enableBiometric`, `changePassword`, `lock`, `current`, `refresh`. Primeira conta administradora só com `countPeople() === 0` (revogados incluídos) **e** sem convite aberto; fora disso o código é obrigatório e a conta sai de `createPersonWithInvite` (`null` → `'invalid invite'`). Backoff em `meta` `unlock_failures`/`unlock_last_failure`, erro único `'invalid credentials'` com derivação de custo igual para e-mail inexistente, biometria em `bond.bio.<pessoa>` e `last_person` no `store`. Eventos: `account_created`, `unlocked` (`'password'`/`'biometric'`), `unlock_failed` (sem e-mail no detalhe), `password_changed`, `locked`. |
| `backend/vault.ts` | criado (substitui `backend/cofre.ts`, apagado). `VaultDeps`, `Vault` e `createVault`: `key`, `list`, `save`, `read`, `remove`, `removeAllOf`, `removeAllForTool`, `export`, `import`. Valor só no chaveiro (`JSON.stringify({ username, secret })`), índice no repositório; `save` recusa ferramenta inexistente (`repo.entry` → `'unknown tool'`) **antes** de tocar no chaveiro e só grava o índice se o chaveiro aceitou. Nenhum evento é registrado aqui. |
| `test/session.test.ts` | criado (substitui `test/sessao.test.ts`, apagado). 17 testes: estado inicial, conta e convite, validações, desbloqueio com backoff, troca de senha com item de cofre, `refresh`, biometria e bloqueio. SQLite em memória, chaveiro e `store` em memória, relógio fixo, `iterations: 1000`. |
| `test/vault.test.ts` | criado (substitui `test/cofre.test.ts`, apagado). 12 testes: chave, gravação nos dois lados, ferramenta inexistente, recusa do chaveiro, leituras ilegíveis, remoção (item, pessoa, ferramenta) e export/import cifrado de ida e volta. |
| `backend/sessao.ts`, `backend/cofre.ts`, `test/sessao.test.ts`, `test/cofre.test.ts` | apagados (v1, nomes em português). |
| `docs/handovers/v2-session-vault.md` | este arquivo. |

Arquivos de outras fatias **não** foram tocados (`backend/repo.ts`, `backend/main.ts`, `shared/*`,
`src/*`, `scripts/*`, `test/helpers/*`).

Evidência: **leitura** do código dos dois módulos e dos testes que os exercitam. Não rodei
`bun test`, `tsc` nem o build: o contrato da fase manda só editar, e o coordenador roda os gates.

## Critério de aceite — como cada item foi atendido

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| 1ª conta administradora | `test/session.test.ts › createAccount › the first account without invites becomes the administrator and is already unlocked` | `firstAccount = countPeople() === 0 && !hasOpenInvite()` → `createPerson({ …, roles: [ensureAdminRole().id] })`; conta já desbloqueada, `last_person` no `store`, evento `account_created` |
| 2ª conta sem código → `'invalid invite'` | `createAccount › the second account needs an invite and takes the invite roles` | `firstAccount` falso → `code.length === 0` → `throw new Error('invalid invite')` |
| Com código → papéis do convite | idem | `createPersonWithInvite({ email, name, password }, codeHash, now())` cria a pessoa já com os papéis do convite (transação do repositório) |
| Reuso do código → `'invalid invite'` | idem | o convite é consumido na primeira criação; `activeInvite` volta `null` e o repositório devolve `null` |
| Convite aberto com zero pessoas → 1ª conta sem código não é admin | `createAccount › an open invite with zero people already demands the code and keeps the first account out of admin` | `state().requiresInvite` (`countPeople() > 0 \|\| convite com usedAt null`) e o ramo de admin exigir `!hasOpenInvite()` |
| Banco só com revogados → ainda exige convite | `createAccount › a database with revoked people only still requires an invite` | `countPeople()` conta revogados (P6) → `hasAccount` e `requiresInvite` verdadeiros; sem código → `'invalid invite'`; com convite → papéis do convite |
| 5 falhas → `waitMs` 1000 | `unlock › four failures do not wait; the fifth waits 1000 ms and the clock releases it` | `waitMs()` = `unlockWait(failures())` − decorrido (`meta('unlock_last_failure')`, `deps.now`); a 6ª dobra para 2000 e o acerto grava `unlock_failures = '0'` |
| Dentro da espera → `'wait before trying again'` | idem | o guarda é a primeira linha de `unlock`, antes da consulta por e-mail |
| Mesma mensagem para e-mail desconhecido | idem, e `unlock › a wrong password and an unknown email give the same message, with no hint in the event` | durante a espera o e-mail desconhecido recebe o mesmo `'wait before trying again'`; fora dela, `'invalid credentials'` para senha errada e e-mail inexistente, que deriva contra o hash falso (`FAKE_PASSWORD`, iterações de `deps`) |
| `changePassword` mantém o cofre legível | `changePassword › the old password stops working, the new one works and the vault stays readable (RF-24)` | `repo.changePassword(id, hashPassword(next, iterations))` + evento `password_changed`; o chaveiro não é tocado e o item continua legível |
| `refresh` após revogação bloqueia | `refresh › reloads the current person from the repository and locks it when it was revoked (A23)` | `refresh()` recarrega por `personById` (pega papéis novos) e, com `null`, registra `locked` e esquece a pessoa |
| Biometria indisponível / habilitada / recusada | `biometrics › without biometrics on the system…`, `› enabled, biometrics stores the person key and unlocks the session`, `› a refusal from the system leaves the session closed` | `'biometrics are not available on this system'` quando `biometricAvailable` é falso (habilitar confere a senha antes); `bond.bio.<pessoa>` no chaveiro e `'Unlock Bond'` como motivo; recusa → `'biometrics were declined'`. Sem chave ou pessoa revogada → `'biometrics are not enabled'` |
| Ferramenta inexistente recusada sem escrever no chaveiro | `test/vault.test.ts › key and index › a tool that does not exist is refused before the keychain is written` | `if (deps.repo.entry(p.toolId) === null) throw new Error('unknown tool')` antes do `keychain.set`; chaveiro e índice seguem vazios |
| Recusa do chaveiro não mexe no índice | `key and index › a keychain that refuses the credential: error and no new or changed index row` | `if (!stored) throw new Error('the system keychain refused the credential')`; sem item novo e, com item existente, ele continua o mesmo |
| `removeAllForTool` limpa o item de duas pessoas | `remove › removeAllForTool clears every person item and index row of that tool (A6)` | `vaultItemsByTool(toolId)` → `keychain.delete` + `repo.removeVaultItem(pessoa, ferramenta)` para cada linha; o item de outra ferramenta fica |
| Export/import de ida e volta | `export and import › the encrypted round trip restores the items in another person keychain` | `export` lê o chaveiro item a item e chama `exportVault(itens, senha, iteracoes)`; `import` chama `importVault(blob, senha)` e regrava por `save`, devolvendo o total |

## O que ficou fora, e por quê

- **E-mail de pessoa revogada.** `personByEmail` ignora revogados (contrato §4), mas a linha continua
  no banco e o `UNIQUE NOCASE` de `person.email` vale para ela. Criar conta com o e-mail de alguém
  revogado, portanto, falha por erro do SQLite, e não com `'email already registered'`. A superfície
  do `Repo` do §4 não tem consulta por e-mail incluindo revogados; sem mudar `backend/repo.ts` (de
  outro dono) `session.ts` não consegue distinguir esse caso. Fica como achado para o coordenador.
- **Convite expirado e não usado conta como "aberto"** em `requiresInvite` (`usedAt === null`), como
  no v1 e como diz o contrato do `SessionState` ("there is an account or an open invite"); a
  validade é conferida na hora de criar a conta (`activeInvite` + `createPersonWithInvite`).
- **`'a username is required'` / `'a secret is required'`**: validação herdada do v1 (usuário sem
  espaços vazios, segredo não aparado), traduzida. Não está na lista de mensagens do pedido, mas
  também não foi pedido para removê-la; o comportamento observável é o do v1.
- **`refresh()` registra `locked`** ao derrubar uma sessão de pessoa revogada: `locked` está na lista
  de eventos que a sessão registra e é o único evento que descreve o fato. Nenhum evento novo foi
  inventado.
- **Nada de evento no cofre**, como manda o §4: `credential_saved`, `credential_removed`,
  `vault_exported` e `vault_imported` são do `backend/main.ts`.

## Dependências de outra fatia

- `shared/vault-export.ts` (`exportVault`/`importVault`, §3) é da fatia da sonda/export e **não
  estava no repositório** quando esta fatia foi escrita: `backend/vault.ts` importa de
  `'../shared/vault-export'` e o teste do round trip depende do arquivo existir para rodar.
- `test/helpers/sqlite-bun.ts` é reescrito no mesmo caminho pela fatia do repositório, com
  `memorySqlite` no lugar de `sqliteMemoria`; os dois testes desta fatia importam `memorySqlite`.
- `backend/main.ts` (outro dono) precisa: registrar os eventos do cofre; chamar
  `vault.removeAllForTool(id)` **antes** de remover a entrada (A6); em `people.revoke`, chamar
  `session.refresh()` e `vault.removeAllOf(pessoa)` e apagar `bond.bio.<pessoa>` (A14); usar
  `session.refresh()` depois de mexer em papéis ou pessoas (A23).
