# Fatia E — repositório SQLite (`backend/sqlite.ts`, `backend/repo.ts`)

Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md` (em-curso).
Contrato seguido: `docs/arquitetura.md` §4 e `docs/canonico.md` §16. Tipos: `shared/types.ts`.

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `backend/sqlite.ts` | criado. `abrirSqlite(caminho): SqlDb` sobre `tjs:sqlite`: `new Database(caminho)`, `PRAGMA foreign_keys = ON` e `PRAGMA journal_mode = WAL` na abertura, `exec` → `db.exec`, `all` → `prepare(sql).all(...)`, `run` → `prepare(sql).run(...)`. |
| `backend/repo.ts` | criado. `Repo` (interface explícita, o contrato §4 inteiro) e `criarRepo(db: SqlDb): Repo`. Schema completo em `ESQUEMA` (10 tabelas), leituras que ignoram pessoa revogada, `salvarEntrada` com vistas/concessões reescritas em transação, `pessoa.administrador` derivado dos papéis, `consumirConvite` por `changes()`, `listarEventos`/`eventosJsonl`, meta. |
| `test/helpers/sqlite-bun.ts` | criado. `sqliteMemoria(): SqlDb` sobre `bun:sqlite` (`new Database(':memory:')`), mesmos PRAGMAs e mesma delegação do runtime. |
| `test/repo.test.ts` | criado. 16 testes com `bun:test` cobrindo o critério de aceite da fatia. |
| `docs/handovers/fatia-e-repo.md` | este arquivo. |

## Critério de aceite — como cada item foi atendido

Evidência por `leitura` (não executei nada do repositório, conforme o contrato da fase): cada linha
aponta o teste que prova o comportamento em `test/repo.test.ts` e o trecho do código que o produz.

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| `migrar()` duas vezes não lança | `esquema › migrar() duas vezes não lança` | `ESQUEMA` é só `CREATE TABLE IF NOT EXISTS`; `migrar` é `db.exec(ESQUEMA)` |
| pessoa com papel admin → `administrador` true | `pessoas › administrador deriva dos papéis…` | `montarPessoa` chama `ehAdministrador` (join `pessoa_papel` × `papel.administrador = 1`) |
| `pessoaPorEmail('X@Y.com')` acha `x@y.com` | idem | e-mail gravado com `trim().toLowerCase()`; coluna `COLLATE NOCASE UNIQUE`; busca com o mesmo normalizador |
| revogada some de `pessoaPorEmail`/`listarPessoas` | `pessoas › pessoa revogada some de todas as leituras` | `WHERE revogada_em IS NULL` nas três leituras (`pessoaPorEmail`, `pessoaPorId`, `listarPessoas`) e em `contarPessoas` |
| `salvarEntrada` com 2 vistas e 2 papéis; regravar com 1 e 1; `conceder(..., false)` remove | `catálogo › salvarEntrada regrava vistas e concessões a cada gravação` | `DELETE FROM vista`/`DELETE FROM concessao` + reinserção dentro de `transacao` (BEGIN/COMMIT/ROLLBACK via `exec`); `conceder` faz `INSERT OR IGNORE`/`DELETE` |
| `extras` só sobrescreve o que vem | `catálogo › icone_hash e sonda só mudam quando vêm em extras` | a decisão é por presença da chave (`'icone_hash' in extras`), não por valor: `null` explícito limpa, chave ausente preserva |
| `removerPapel('administrador')` lança | `papéis › removerPapel apaga concessões e vínculos…` | `throw new Error('o papel administrador não pode ser removido')` |
| convite: consumir 1ª true, 2ª false; expirado false; `conviteAtivo` respeita uso e validade | `convites › usado uma vez só, expirado não vale…` | `UPDATE ... SET usado_em = ? WHERE code_hash = ? AND usado_em IS NULL AND expira_em > ?` e `SELECT changes()` para o booleano; `conviteAtivo` lê com o mesmo filtro |
| `salvarConvite` ignora `code_hash` repetido | idem | `SELECT` antes: se existe, devolve montado, sem `INSERT` |
| cofre: salvar o mesmo par atualiza | `cofre › salvar o mesmo par atualiza…` | `ON CONFLICT (pessoa_id, ferramenta_id) DO UPDATE` mantendo `id`/`criado_em` |
| cofre: `removerCofrePessoa` devolve os removidos | idem | lê os itens, apaga e devolve os `CofreItem` dentro de uma transação |
| eventos: filtro por ferramenta | `eventos › registrar devolve o id; filtro por ferramenta…` | `listarEventos` monta `WHERE` só com os filtros presentes e `LIMIT ?` (`limite` padrão 500) |
| eventos: 2 eventos → 2 linhas JSON válidas em ordem cronológica | `eventos › eventosJsonl: uma linha JSON por evento…` | `ORDER BY em ASC, id ASC`, um `JSON.stringify(evento)` + `\n` por linha |
| meta get/set | `meta › get/set com sobrescrita` | `SELECT valor` / `INSERT ... ON CONFLICT (chave) DO UPDATE` |

## Comandos

Nenhum gate da fase foi rodado por mim (o contrato da fatia diz "só edite"; o coordenador roda
`bun test test/`, os dois `tsc` e o build no fim). O que rodei foram sondas de **semântica**, fora
do repositório (`/tmp`), para não escrever código sobre suposição:

| Sonda | Resultado observado |
| --- | --- |
| `tsc` em `/tmp/probe` com `declare module 'tjs:sqlite'` dentro de um arquivo de módulo | `error TS2664: Invalid module name in augmentation, module 'tjs:sqlite' cannot be found.` → a declaração **não** funciona no próprio arquivo |
| `tsc` em `/tmp/probe3` com `// @ts-ignore` na linha do import + `SqlDb` local | `exit=0` → o import silenciado compila e o objeto devolvido satisfaz `SqlDb` |
| `tsc` em `/tmp/probe2` com `crypto.randomUUID()` e `types: []` | `exit=0` → a lib DOM entra por padrão no `tsconfig` do backend, então `crypto` já está declarado |
| `bun /tmp/probe4/p.js` sobre `bun:sqlite` | `INSERT ... RETURNING id` via `.all()` devolve `[{"id":1}]`; `SELECT changes()` funciona; `PRAGMA journal_mode = WAL` em `:memory:` não lança; `ON CONFLICT` com `UNIQUE(pessoa_id, ferramenta_id)` e `LIMIT ?` funcionam; e-mail `COLLATE NOCASE UNIQUE` barra caixa diferente |

## Desvios do contrato (decisões tomadas, para o coordenador confirmar)

1. **`@ts-ignore` na linha do `import { Database } from 'tjs:sqlite'`** (`backend/sqlite.ts`), com um
   tipo local `SqliteDatabase` fixando a superfície usada. O contrato da fatia pedia `declare module
   'tjs:sqlite'` no próprio arquivo "só se `backend/tjs.d.ts`/`backend/tiny.d.ts` não o declararem";
   conferi: nenhum dos dois declara `tjs:sqlite` (o `tjs.d.ts` só tem `declare const tjs: any`). Mas
   a declaração no próprio arquivo é impossível em TypeScript (sonda acima, TS2664: dentro de um
   módulo `declare module` é *augmentation*, não declaração de módulo novo). A correção limpa é
   declarar o módulo em `backend/tjs.d.ts`, que é um arquivo de script e por isso aceita `declare
   module` — arquivo que **não é da minha fatia**, então não toquei. Fica como pedido ao coordenador.
2. **`Repo` é uma `interface` explícita** em `backend/repo.ts`, não `export type Repo =
   ReturnType<typeof criarRepo>`: uma regra do projeto (`ts-no-return-type`) proíbe publicar contrato
   por `ReturnType<typeof …>`. O nome exportado e as assinaturas são os do §4 — quem importa
   `Repo` de `backend/repo.ts` não muda nada.
3. **`contarPessoas()` conta só pessoa não revogada** (e `pessoaPorId` também ignora revogada):
   coerente com `listarPessoas`, e evita o beco sem saída de "a única pessoa foi revogada e não dá
   mais para criar conta sem convite" em `sessao.criarConta`. Se o coordenador quiser contar a
   tabela inteira, é uma linha em `backend/repo.ts`.
4. **`removerEntrada` apaga também as linhas de `cofre_item` daquela ferramenta** (o ponteiro). O
   valor correspondente no chaveiro do sistema precisa ser apagado por quem conhece a chave — a
   fatia do cofre (`backend/cofre.ts`). Deixar o ponteiro seria referência órfã com `foreign_keys`
   ligado.
5. **`evento` não tem chave estrangeira** de propósito: a auditoria (§13) sobrevive à remoção da
   ferramenta ou da pessoa. Por isso os eventos da fatia E também não dependem de
   `ON DELETE CASCADE`.
6. **Filhos apagados explicitamente** em `removerPapel` e `removerEntrada`, sem confiar em
   `ON DELETE CASCADE` (o pragma pode estar desligado em outro runtime).
7. **`trocarSenha` e `revogarPessoa` só agem em pessoa não revogada** (`AND revogada_em IS NULL`),
   pela mesma coerência do item 3.
8. **`salvarCofreItem` zera `rotacao_pendente` na atualização**: gravar um valor novo resolve a
   rotação pendente. Não há outro caminho que escreva essa coluna nesta fase.
9. **`consumirConvite(codeHash, pessoaId, agora)`**: `pessoaId` é aceito e não usado (`void
   pessoaId`), porque o schema do §16 não tem coluna de "quem usou" — registrar isso seria mudar o
   formato de persistência, que é decisão do coordenador.
10. **`listarEventos(f)` exige o argumento** (sem `= {}`), fiel à assinatura do §4; quem não tem
    filtro passa `{}`.
11. **Dependência de outra fatia:** `backend/repo.ts` importa `origemDe` de `shared/catalogo.ts`
    (contrato §3) para preencher a coluna `ferramenta.origem` — `Entrada` não carrega `origem`. O
    arquivo já existe (fatia do catálogo) e `origemDe` (`shared/catalogo.ts:20`) devolve
    `url.origin`, exigindo https (http só em loopback) — confere com o que os testes do repositório
    usam. Não dupliquei a regra de origem dentro do repositório: um fato, uma casa.
12. **`icone` sai `null` de todas as leituras do repositório** (`entrada`, `listarEntradas`,
    `salvarEntrada`): o §4 diz que o ícone vem por `iconeHash` (data URI servida pelo backend). O
    hash é gravado/lido por `salvarEntrada(..., extras)` e `iconeHash(id)`.

## O que ficou de fora (e por quê)

- **Não executei nada do repositório**: `bun test test/`, `bunx tsc -p tsconfig.json`,
  `bunx tsc -p backend/tsconfig.json`, `bun run app:build` e o smoke são do coordenador
  (fim de fase). Toda a evidência acima é `leitura`.
- **`abrirSqlite` não é exercitado pelos testes**: eles usam `sqliteMemoria()` (`bun:sqlite`), como
  o próprio critério pede — `tjs:sqlite` só existe dentro do runtime tinyjs. O caminho real de
  `abrirSqlite` é provado no smoke/app, não aqui.
- **Sem tipo completo de `tjs:sqlite`** (item 1 dos desvios): depende de arquivo fora da fatia.
- **Não escrevi em `shared/`, `src/`, `scripts/` nem nos arquivos de configuração** (um arquivo, um
  dono).
- **Export cifrado do cofre, chaveiro, sessão, janelas, sonda de rede e ícones** são outras fatias
  (`backend/cofre.ts`, `backend/sessao.ts`, `backend/palcos.ts`, `backend/sonda-rede.ts`,
  `backend/icones.ts`); aqui só o índice do cofre no banco.

## Precisa de outro dono

- `backend/tjs.d.ts` (dono do scaffold): declarar o módulo `tjs:sqlite` (`Database` com
  `exec`/`prepare`, `Statement` com `run`/`all`) para o `@ts-ignore` de `backend/sqlite.ts` poder
  sair. Alternativa aceita: manter como está.
- `backend/cofre.ts` (fatia do cofre): ao remover ferramenta ou pessoa, limpar as chaves
  `bond.cred.<pessoa>.<ferramenta>` do chaveiro — `removerCofrePessoa` já devolve os itens removidos
  com as chaves.
- `backend/main.ts` (dono da integração, B02): o painel de admin (`docs/handovers/fatia-f2-admin.md`)
  já manda o parâmetro `icone` só quando ele muda. O handler de `catalogo.salvar` precisa virar
  **presença de parâmetro em presença de chave** (`'icone_hash' in params`, e não
  `params.icone ?? null`, que apagaria o ícone em toda edição), e `catalogo.listar` precisa
  preencher `Entrada.icone` com `icones.dataUri(repo.iconeHash(id))`, porque o repositório devolve
  `icone: null` (item 12).

## Onde a evidência cai no handover da frente

Este arquivo é a evidência da fatia E: `test/repo.test.ts` (16 testes) + os quatro arquivos acima.
O coordenador confirma rodando `bun test test/` e os dois `tsc` do §6 do `docs/arquitetura.md`.
