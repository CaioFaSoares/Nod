# Fatia `v2-repo` — repositório SQLite (`backend/sqlite.ts`, `backend/repo.ts`, testes)

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (`em-curso`), frente `bond`.
Contrato seguido: `docs/arquitetura.md` §4 (e §2, §6) e `docs/canonico.md` §13, §16, §20.
Tipos: `shared/types.ts` (v2, não editado). Glossário: `CONTEXT.md`.

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `backend/sqlite.ts` | reescrito em inglês: `openSqlite(path): SqlDb` sobre `tjs:sqlite` (mesmos PRAGMAs `foreign_keys`/`WAL` e mesma delegação `exec`/`prepare(sql).run/.all` da v1; só os nomes mudaram). |
| `backend/repo.ts` | reescrito: `export interface Repo` e `export function createRepo(db: SqlDb): Repo` com o schema **em inglês** (`person`, `role`, `person_role`, `tool`, `tool_view`, `tool_grant`, `vault_item`, `invite`, `event`, `meta`) e todos os métodos do §4. Saíram `api_json`/`credencial` e `rotacao_pendente`; entraram `countAdmins()`, `createPersonWithInvite()`, `probe()`, `vaultItemsByTool()`, `loginResults()`. `consumirConvite` deixou de existir como método público (o consumo é interno, D7). |
| `test/helpers/sqlite-bun.ts` | reescrito em inglês: `memorySqlite(): SqlDb` sobre `bun:sqlite` (mesmo path do arquivo; o export `sqliteMemoria` não existe mais — avisei `V2SessionVault`). |
| `test/repo.test.ts` | reescrito: 18 testes em inglês cobrindo o critério de aceite da fatia (inclui os novos comportamentos da v2). |
| `docs/handovers/v2-repo.md` | este arquivo. |

Nada aqui guarda segredo: o cofre guarda só o ponteiro (`vault_item.keychain_key`).

## Critério de aceite — como cada item foi atendido

Evidência `leitura` (nenhum gate do repositório foi rodado por mim, conforme o contrato da fatia):
cada linha aponta o teste em `test/repo.test.ts` e o trecho de `backend/repo.ts` que produz o
comportamento.

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| `migrate()` duas vezes não lança | `schema › migrate() twice does not throw` | `SCHEMA` é só `CREATE TABLE IF NOT EXISTS`; `migrate` é `db.exec(SCHEMA)` |
| papel admin garantido, id/nome canônicos | `schema › ensureAdminRole is idempotent…` | `ensureAdminRole()` = `saveRole({ id: 'admin', name: 'Admin', admin: true })`; `saveRole` é `ON CONFLICT (id) DO UPDATE` |
| admin derivado dos papéis | `people › admin is derived from the roles…` | `buildPerson` chama `isAdmin` (join `person_role` × `role.admin = 1`); `countAdmins()` conta pessoa ativa com papel admin |
| e-mail normalizado e sem caixa | idem | grava com `trim().toLowerCase()`; coluna `COLLATE NOCASE UNIQUE`; busca com o mesmo normalizador |
| revogada some de `personByEmail`/`listPeople` **mas conta em `countPeople`** | `people › a revoked person disappears from the reads but is still counted` | `WHERE revoked_at IS NULL` nas três leituras; `countPeople()` é `SELECT COUNT(*) FROM person` (tabela inteira — regra da primeira conta, P6) e `countAdmins()` exige `revoked_at IS NULL` |
| `saveEntry` regrava vistas e concessões; `grant` liga/desliga | `catalog › saveEntry rewrites views and grants on every write` | `DELETE FROM tool_view`/`DELETE FROM tool_grant` + reinserção dentro de `transaction` (BEGIN/COMMIT/ROLLBACK via `exec`); `grant` faz `INSERT OR IGNORE`/`DELETE` |
| `probe` só persiste quando vem em `extras`; `iconHash` idem | `catalog › icon hash and probe only change when they come in extras` | a decisão é por presença de chave (`'probe' in extras`, `'iconHash' in extras`), não por valor: `null` explícito limpa, chave ausente preserva; `probe(id)` lê `probe_json` |
| `auth_json` guarda `AuthOverride \| null` | `catalog › auth override round-trips through the entry` | `JSON.stringify(e.auth)` no upsert; `JSON.parse` em `buildEntry` |
| `listEntries` ordena por `order` e título; `removeEntry` leva vistas, concessões e cofre | `catalog › listEntries orders by order and title…` | `ORDER BY sort_order ASC, title COLLATE NOCASE ASC`; `removeEntry` apaga `tool_view`, `tool_grant`, `vault_item` e `tool` na mesma transação |
| `removeRole('admin')` lança | `roles › removeRole deletes grants and links; the admin role does not go` | `throw new Error('the admin role cannot be removed')` antes de qualquer escrita; o resto apaga filhos explicitamente |
| `saveInvite` ignora `code_hash` repetido; `activeInvite` respeita uso e validade | `invites › a repeated code_hash returns the existing invite…` | `SELECT` antes do `INSERT`; `activeInvite` lê com `used_at IS NULL AND expires_at > ?` (expirar exatamente agora já é fora) |
| `createPersonWithInvite`: 1ª chamada devolve a pessoa com os papéis do convite | `invites › createPersonWithInvite consumes the code and creates the person with the invite roles` | uma transação: `UPDATE invite SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`, `SELECT changes()`, `INSERT INTO person`, `replaceRoles` com o `roles_json` do convite, `COMMIT` |
| 2ª chamada com o mesmo código → `null`, e nenhuma segunda pessoa | idem | `changes() === 0` → `ROLLBACK` e `return null`; a contagem de pessoas continua 1 e `personByEmail` da segunda não acha ninguém |
| código expirado → `null` (e não é marcado como usado) | `invites › an expired invite is not consumed and creates nobody` | mesma cláusula `expires_at > ?`; o `ROLLBACK` desfaz qualquer efeito |
| consumo e criação são atômicos (D7) | `invites › a failure while creating the person rolls the consumption back (D7)` | falha dentro da transação (e-mail já registrado) → `ROLLBACK`: `used_at` volta a `NULL` e a pessoa não entra |
| cofre: gravar o mesmo par atualiza no lugar | `vault › saving the same pair updates in place…` | `ON CONFLICT (person_id, tool_id) DO UPDATE` mantendo `id`/`created_at` |
| `vaultItemsByTool` (todas as pessoas) | idem | `SELECT * FROM vault_item WHERE tool_id = ? ORDER BY person_id, label` |
| `removeVaultOf` devolve o que removeu | `vault › removeVaultOf returns what it removed and cleans the index` | lê os itens, apaga e devolve os `VaultItem` na mesma transação |
| eventos: filtro por pessoa/ferramenta/resultado e limite, mais recentes primeiro | `events › addEvent returns the id; filter by tool, result and limit` | `listEvents` monta o `WHERE` só com os filtros presentes e `LIMIT ?` (padrão 500), `ORDER BY at DESC, id DESC` |
| `eventsJsonl` em ordem cronológica, um JSON por linha | `events › eventsJsonl: one JSON line per event, in chronological order` | `ORDER BY at ASC, id ASC`, `JSON.stringify` + `\n` por evento |
| `loginResults` mais recentes primeiro, só `LoginResult` válido | `events › loginResults: newest first, only the valid results…` | `WHERE type = 'login' AND tool_id = ? AND result IN (<os 5 válidos>) ORDER BY at DESC, id DESC LIMIT ?`, com o type guard `isLoginResult` no fim (nada de `as`) |
| meta get/set com sobrescrita | `meta › get/set with overwrite` | `SELECT value FROM meta WHERE key = ?` / `INSERT … ON CONFLICT (key) DO UPDATE` |

## Comandos

Nenhum gate do repositório foi rodado por mim (o contrato da fatia diz "só edite"; o coordenador roda
`bun test test/`, os dois `tsc` e o build). O que rodei foram **sondas de semântica do SQLite**, fora
do repositório (`/tmp/bond-probe`), para não escrever código sobre suposição — `execucao`, ambiente
`bun 1.4.3` (`bun:sqlite`, mesmo motor SQLite do `tjs:sqlite`):

| Sonda | Resultado observado |
| --- | --- |
| DDL do `SCHEMA` copiado **verbatim** do arquivo (as 10 tabelas) em `:memory:` | cria sem erro; `key`/`value` (de `meta`) e `at`/`type`/`url`/`result`/`detail` (de `event`) valem como identificador |
| Todas as formas de statement do arquivo, contra esse DDL | `INSERT`/`ON CONFLICT` de `tool`, `vault_item` e `meta`, `DELETE`/`INSERT` de `tool_view` e `tool_grant`, `INSERT OR IGNORE` de `person_role`, `DELETE FROM tool` com `foreign_keys = ON`: sem erro; depois de remover a ferramenta, `vault_item` foi junto e o `event` ficou (não tem chave estrangeira) |
| `INSERT INTO event … RETURNING id` via `.all()` | devolve `[{ id: 1 }]` (o `run()` do runtime não devolve id) |
| `SELECT changes()` logo após o `UPDATE` do convite | `1` quando consumiu; `0` quando o código já estava usado/expirado (o `ROLLBACK` vazio é aceito) |
| `INSERT` de e-mail repetido dentro da transação + `ROLLBACK` | `SQLiteError: UNIQUE constraint failed: person.email` e, depois do `ROLLBACK`, `invite.used_at = null` e `COUNT(*) FROM person = 1` — a atomicidade do D7 |
| `ON CONFLICT (person_id, tool_id) DO UPDATE` | mantém `id` e `created_at`, troca `label`/`username`/`updated_at` |
| `result IN (5 placeholders)` com `LIMIT ?` (0 e 10) | `LIMIT 0` devolve `[]`; com 10 devolve só os resultados válidos, mais recentes primeiro; `'junk'` fica fora |

## Desvios do contrato (decisões tomadas, para o coordenador confirmar)

1. **`created_at` da pessoa criada por convite usa `nowIso()`**, não o `now` do parâmetro: o `now`
   decide a validade/consumo do convite (`used_at`), e `created_at` fica igual ao de
   `createPerson()`. Se o coordenador preferir o instante do chamador nas duas colunas, é uma linha.
2. **Não existe método público para consumir convite.** O §4 só lista `saveInvite`, `activeInvite` e
   `listInvites`; o `UPDATE` de consumo vive dentro de `createPersonWithInvite` (D7). Quem precisar
   consumir sem criar pessoa terá que falar comigo.
3. **`loginResults` filtra no SQL e no type guard.** O `IN` limita às cinco strings válidas e
   `isLoginResult` estreita o tipo sem `as`. Resultado de `login` fora da lista (dado antigo ou
   forjado) fica de fora da resposta.
4. **`Repo` é uma `interface` explícita** (`export interface Repo`), como na v1: a regra do projeto
   proíbe publicar contrato por `ReturnType<typeof …>`. As assinaturas são as do §4.
5. **Ordens escolhidas onde o §4 não diz**: `listRoles` por `name COLLATE NOCASE, id`;
   `vaultItemsByTool` por `person_id, label`; `listInvites` por `expires_at DESC, id`. Todas
   determinísticas; os testes não dependem de ordem onde ela não importa.
6. **`event` segue sem chave estrangeira** (a auditoria sobrevive à remoção da pessoa/ferramenta) e
   `person_role`/`tool_grant`/`tool_view`/`vault_item` apontam para os pais, com os filhos apagados
   explicitamente em `removeRole`/`removeEntry`, sem confiar em `ON DELETE CASCADE`.
7. **`vault_item` perdeu `rotacao_pendente`** (não está no schema do §4 e nenhum método da v2 a
   lê/escreve; a v1 a usava).
8. **`icon` sai `null`** de `entry`, `listEntries` e `saveEntry`: o backend serve os bytes por
   `iconHash` (§4). `saveEntry(e, { iconHash })` grava o hash; `iconHash(id)` o lê.
9. **`openSqlite` não é exercitado pelos testes** (eles usam `memorySqlite()`, como o critério pede;
   `tjs:sqlite` só existe dentro do tinyjs e o módulo está tipado em `backend/tjs.d.ts`).

## O que ficou de fora (e por quê)

- **Não rodei** `bun test test/`, `tsc`, `vite build`, `tinyjs dev`, o smoke, linter ou formatador: é
  o coordenador que verifica no fim (contrato da fatia). Toda a evidência acima é `leitura`, exceto
  as sondas de `/tmp/bond-probe`, que são `execucao` de semântica do SQLite.
- **Não toquei** em `shared/`, `src/`, `scripts/`, `backend/main.ts`, `backend/seed.ts`,
  `backend/session.ts`, `backend/vault.ts` nem nos testes das outras fatias (um arquivo, um dono).
- **Export/import do cofre, chaveiro, sessão, janelas de ferramenta, sonda de rede, ícones e
  catálogo (seed)** continuam com os donos das outras fatias; aqui só o índice do cofre no banco.

## Precisa de outro dono

- `shared/catalog.ts` (fatia do catálogo): `originOf` é importado por `backend/repo.ts` para a coluna
  `tool.origin` — já existe na v2 (`shared/catalog.ts:42`), nada a fazer além de não renomear.
- `backend/session.ts` (fatia da sessão): a conta com convite usa
  `createPersonWithInvite(p, codeHash, now)` e trata `null` como `'invalid invite'`; a regra de
  primeira conta usa `countPeople()` **com** revogadas (P6). O helper de teste agora exporta
  `memorySqlite` (arquivo `test/helpers/sqlite-bun.ts`, mesmo path).
- `backend/vault.ts` (fatia do cofre): ao remover ferramenta/pessoa, limpar as chaves
  `bond.cred.<person>.<tool>` do chaveiro — `removeVaultOf(personId)` e `vaultItemsByTool(toolId)`
  devolvem os itens com `keychainKey`.
- `backend/main.ts` (fatia da integração): `catalog.save` precisa virar presença de chave em
  presença de chave (`'probe' in params` → `saveEntry(e, { probe })`; idem `icon`), e `catalog.get`
  monta `usualLogin` a partir de `loginResults(id, 20)`; `catalog.list` preenche `Entry.icon` com o
  data URI do `iconHash`.

## Onde a evidência cai no handover da frente

Este arquivo é a evidência da fatia `v2-repo`: `test/repo.test.ts` (18 testes + os 5 do `## Fix`)
+ os quatro arquivos acima. O coordenador confirma rodando `bun test test/` e os dois `tsc` do §6 do
`docs/arquitetura.md`.

## Fix

Sintoma (reproduzido pelo coordenador, não por mim): `bun run app:dev` abre a janela principal com
só `SQL logic error`. No banco do dono (`~/Library/Application Support/studio.copland.bond/bond.db`),
`.tables` lista as tabelas v1 em português (`pessoa`, `papel`, `ferramenta`, `vista`, `concessao`,
`cofre_item`, `convite`, `evento`, `pessoa_papel`) **junto** com as da v2, e `.schema meta` é
`CREATE TABLE meta (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`.

Causa: `migrate()` era `db.exec(SCHEMA)`, e todo o `SCHEMA` é `CREATE TABLE IF NOT EXISTS`. O
`CREATE TABLE IF NOT EXISTS meta (key, value)` era pulado porque já havia um `meta` v1 com outras
colunas; a partir daí o primeiro `SELECT value FROM meta WHERE key = ?` (`meta()`/`setMeta()`, que o
`session.state` alcança) falha, e o txiki devolve esse fracasso como o genérico `SQL logic error` —
a mensagem não carrega tabela nem coluna. A distância entre causa e sintoma é essa: o erro não diz
"schema divergente", diz "logic error", e o arquivo parecia saudável porque as dez tabelas v2
existiam.

Hipóteses descartadas: (a) `key`/`value` como palavra reservada do SQLite — o DDL verbatim é aceito
(sonda do handover acima) e a falha só aparece sobre um arquivo que já tem `meta`; (b) WAL/`-wal`
corrompido — `.tables` mostra as duas gerações de tabelas no mesmo arquivo, não corrupção; (c)
`migrate` não chamado ou pulado pelo `init` — o `init` da v1 chamava `migrar()` e o da v2 chama
`migrate()` no `openDatabase`; (d) `user_version` do banco do dono já valendo algo — o `abrirSqlite` da v1 só
executava `foreign_keys` e `journal_mode` (`docs/handovers/fatia-e-repo.md:10`), então o arquivo é
`user_version = 0` e cai no caminho de detecção abaixo.

Mudança:

| Arquivo | O que mudou |
| --- | --- |
| `backend/repo.ts` | `export const SCHEMA_VERSION = 2`, `export class LegacyDatabaseError extends Error {}` e `SCHEMA_TABLES`, que lê os nomes de tabela do próprio `SCHEMA` (`SCHEMA.match(/CREATE TABLE IF NOT EXISTS \w+/g)`, os dez nomes) para os dois não divergirem. `migrate()` passou a ler `PRAGMA user_version`: `SCHEMA_VERSION` → só o `db.exec(SCHEMA)` idempotente, sem regravar a versão; `0` → `isLegacy()` decide — tabela que não é da v2 (via `sqlite_master`) ou `meta` sem a coluna `key` (via `PRAGMA table_info(meta)`) lança `LegacyDatabaseError('this database was created by an older Bond')` **antes de qualquer escrita**; senão roda o `SCHEMA` e grava `PRAGMA user_version = 2` (banco vazio ou v2-sem-versão); qualquer outra versão → `throw new Error(\`unsupported database version: ${version}\`)`. O `migrate` da `interface Repo` ganhou o comentário do contrato. |
| `backend/sqlite.ts` | `export interface OpenDatabase extends SqlDb { close(): void }` e `openSqlite(path): OpenDatabase`, com `close()` delegando a `Database.close` (o tipo já estava em `backend/tjs.d.ts`). O resto da delegação (`foreign_keys`, `WAL`, `exec`/`prepare(sql).run/.all`) não mudou. |
| `backend/main.ts` | `openDatabase(directory)`: abre, faz `migrate`; em `LegacyDatabaseError` fecha a alça, `moveDatabaseAside` renomeia `bond.db` e os irmãos `-wal`/`-shm` **que existem** (checados com `tjs.stat`, que rejeita com `ENOENT` quando não existem) para `bond.v1-<yyyyMMddHHmmss>.db` (UTC, 14 dígitos de `toISOString()`) no mesmo diretório com `tjs.rename`, reabre um banco novo, faz `migrate` e `setMeta('legacy_database', '<nome do arquivo movido>')`. Nada é apagado. `init` embrulha essa abertura: qualquer outra falha vira `bootFailure = "Bond couldn't open its database: <message>"` e `init` retorna sem montar sessão/cofre/janelas; `guarded` lança `bootFailure` na primeira linha, então `session.state` e **todo** handler respondem a mensagem legível no lugar do `SQL logic error` cru. |
| `test/repo.test.ts` | cinco testes novos em `describe('schema versioning')` (era pedido quatro; acrescentei o da tabela v1 `pessoa`): banco vazio → `migrate` grava `user_version` 2 e é idempotente; banco v2 sem versão (`user_version = 0` com o schema no lugar) → completado e carimbado, com o papel admin preservado; `meta (chave, valor)` → `LegacyDatabaseError` sem escrever nada (`user_version` continua 0 e `sqlite_master` só tem `meta`); tabela `pessoa` → idem; `user_version = 3` → `unsupported database version: 3`. Helper `userVersion(db: SqlDb)` lê `PRAGMA user_version` via `.all()[0]`. Cabecalho do arquivo passou a listar "schema versioning". |

Evidência: `leitura` (nenhum gate rodado por mim, conforme o contrato da fatia). O critério de
aceite — o banco do dono é movido para o lado no próximo boot e o app sobe limpo, sem apagar dado —
é atendido por: `isLegacy()` acha `pessoa` e o `meta (chave, valor)` do arquivo do dono, então
`migrate` lança `LegacyDatabaseError`; `openDatabase` fecha a alça (o binário do runtime referencia
`sqlite3_close_v2` — `grep -a sqlite3_close_v2 /Users/caio/.tinyjs/bin/tjs`, o fechamento que
tolera statement não finalizado), renomeia em vez de apagar e devolve um banco novo com o nome do
arquivo em `meta.legacy_database`. Ordem segura: a alça fechada antes do `rename` evita que o SQLite
continue escrevendo no inode antigo. Não rodei `bun test`, `tsc`, build, smoke, linter nem
formatador, e não abri o banco do dono: quem verifica é o coordenador.

Desvio declarado: o `close` entrou como `OpenDatabase` (contrato novo em `backend/sqlite.ts`), e não
como membro opcional de `SqlDb` — `shared/types.ts` não é desta fatia e é o único dos dois que os
testes de todas as fatias importam; a alternativa obrigaria `memorySqlite` a ganhar um `close` que
nenhum teste usa. `main.ts` usa o retorno de `openSqlite`, que é `OpenDatabase`, sem `!` nem `as`.
