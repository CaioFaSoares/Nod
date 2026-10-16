# Fatia v2-catalog — catálogo puro (`shared/catalog.ts`)

Dono: fatia v2-catalog. Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md`
(`em-curso`). Contrato: `docs/arquitetura.md` §3 (`shared/catalog.ts`) e §2 (regras de módulo,
`auditUrl` em evento); tipos: `shared/types.ts` (v2, não tocado); requisitos: `docs/canonico.md`
§8 (catálogo), §9 (convites), §10 (papéis), §19 (seed privado; RF-13, RF-26, RF-27). Vocabulário:
`CONTEXT.md`.

## Arquivos tocados

- `shared/catalog.ts` (novo) — as sete exportações do §3: `originOf`, `auditUrl`, `slug`,
  `validateEntry`, `validateSeed`, `visibleEntries`, `planSeed`, `exportSeed`. Substitui
  `shared/catalogo.ts`. Sem `tjs`, sem `tiny`, sem DOM: só `URL`, `String`, `Date`, `Object`,
  `Array`; tipos em `import type` de `./types`; imports sem extensão.
- `test/catalog.test.ts` (novo) — `bun:test`, determinístico, sem rede, sem PBKDF2 e sem relógio
  real (`new Date('…')`/`new Date(0)` explícitos); lê `resources/seed.example.json` com
  `Bun.file(...).json()`. Substitui `test/catalogo.test.ts`.
- `shared/catalogo.ts`, `test/catalogo.test.ts` — apagados.
- `docs/handovers/v2-catalog.md` (este arquivo).

Nenhum outro arquivo foi aberto para escrita. Um arquivo, um dono: nem `shared/types.ts`, nem
`src/api.ts`, nem `src/ui.ts`, nem qualquer arquivo de `backend/`, `src/`, `scripts/` ou `test/`
foram tocados. Nenhuma dependência nova.

## Diferenças estruturais contra a v1 (todas do contrato)

| v1 | v2 |
| --- | --- |
| `origemDe` | `originOf`; recusa `user:password@`, host fora de `^[a-z0-9.-]+$` (o parser WHATWG aceita `*` e `_`) e mantém `[::1]` como caso explícito |
| — | `auditUrl(url)`: `origin + pathname`, `null` quando o endereço não serve (nunca query nem fragmento) |
| `validarEntrada` com `icone`, `papeis`, `credencial`, `api`, `ativo` | `validateEntry` com `icon`, `order`, `roles`, `views`, `auth`, `active` — **sem `api` e sem `credencial`**; `AuthOverride` é só `{ noFill?: boolean }` |
| `validarSeed` com `versao`, `gerado_em`, `papeis`, `entradas`, `convites`, `atualizacao` | `validateSeed` com `version`, `generatedAt`, `roles`, `entries`, `invites`, `update` |
| `aplicarSeed(atual, seed)` | `planSeed(current, seed, mode)` com `boot`/`merge`/`overwrite` e `updateEntries`/`updateRoles` |
| `visiveis` (locale `pt-BR`) | `visibleEntries` (locale `en`) |
| `exportarSeed` | `exportSeed` |

## Critério de aceite e como foi atendido

Evidência por `leitura` (o despacho da fatia proíbe executar testes, typecheck, build, smoke, linter
e formatador): o que segue é o que o código e os testes dizem, não resultado observado de execução.

### `originOf` — `shared/catalog.ts`

`parseAddress` é a única porta: `new URL` em `try`/`catch` (`parsed = null` no `catch`), depois as
três guardas na ordem (1) credenciais, (2) host, (3) esquema.

1. **https ok** — `originOf('https://kanban.example.com/boards/1?x=2#y')` devolve a origin
   (`https://kanban.example.com`); teste "returns the origin for https".
2. **http só em loopback** — `http:` só passa com host `localhost`, `*.localhost` (`endsWith`),
   `[::1]` ou `^127(\.\d{1,3}){3}$`; teste "accepts http on loopback only" cobre
   `localhost:3000`, `app.localhost:8080`, `127.0.0.1:5173`, `127.10.20.30:9000` e `[::1]:8080`.
3. **http fora de loopback lança** — `http://example.com` e `http://192.168.0.10:3000` →
   `'address must be https'`; teste "rejects http outside loopback". Outro esquema (`ftp:`) dá a
   mesma mensagem ("rejects another scheme with the same message").
4. **credencial no endereço lança** — `username` ou `password` não vazios →
   `'address must not contain credentials'` antes de qualquer outra decisão; teste "rejects
   credentials in the address" (`https://user:pw@x.com` e `https://user@x.com/board`).
5. **host do WHATWG recusado** — `hostname !== '[::1]' && !/^[a-z0-9.-]+$/.test(hostname)` →
   `'invalid address'`; teste "rejects hosts the WHATWG parser accepts":
   `https://*.copland.studio` (o `*` que o parser engole) e `https://my_host.example.com`.
6. **lixo lança** — `new URL` falhando → `'invalid address'`; teste "rejects garbage" (`'junk'`,
   `''`, `'kanban.example.com'` sem esquema).

### `auditUrl` — `shared/catalog.ts`

Reusa `parseAddress` e devolve `parsed.origin + parsed.pathname` dentro de `try`/`catch` → `null` em
qualquer recusa. Aceite literal: `auditUrl('https://x.com/a/b?code=1#t=2')` = `'https://x.com/a/b'`
(teste "keeps origin and pathname, never query or fragment"); `null` para `http:` fora de loopback,
lixo, credencial e host com `*` (teste "returns null for what originOf refuses"); loopback http
passa (`http://localhost:3000/dashboard?x=1` → `http://localhost:3000/dashboard`).

### `slug` — `shared/catalog.ts`

Mesma regra da v1 (minúsculas, NFD sem `\p{M}`, `[^a-z0-9]+` → `-`, colapso, apara, corte em 40):
`slug('Kanban da Equipe!')` = `'kanban-da-equipe'`, `slug('Ação Já')` = `'acao-ja'`,
`slug('--Sales  &  Marketing--')` = `'sales-marketing'`, 60 `a` → 40 `a`, `slug('!!!')` = `''`.

### `validateEntry` — `shared/catalog.ts`

- **Padrões num objeto novo** — devolve exatamente
  `{ id, title, url, icon: null, order: 0, roles: [], views: [], auth: null, active: true }`,
  `not.toBe(bruto)` e o objeto recebido intacto (teste "applies the defaults into a new object").
  Listas vêm copiadas (`roles`, `views` e cada vista: `not.toBe`), teste "copies the lists instead of
  sharing them".
- **Id inválido** — `^[a-z0-9][a-z0-9-]{0,39}$` → `'invalid id'`; testes "rejects an id with an
  uppercase letter" e "rejects an id longer than 40 characters" (41 caracteres).
- **Título, endereço e auth** — `'title is required'` para vazio/só espaços; endereço passa por
  `originOf` (logo `'address must be https'` e `'address must not contain credentials'` valem também
  aqui); `auth` só carrega `noFill` booleano (`'invalid noFill'`), `{}` continua `{}` e `null`
  continua `null`. Ordem, `active`, `roles` e `icon` de tipo errado → `'invalid order'`,
  `'invalid active'`, `'invalid roles'`, `'invalid icon'`; não-objeto → `'invalid entry'`.
- **Vista de outra origin** — `validateView` compara `originOf(view.url)` com a origin da entrada →
  `'view outside the tool origin'` (teste com `https://other.example.com/boards/42`); vista com
  endereço que não serve (`https://*.copland.studio/…`) → `'invalid address'`; modo desconhecido →
  `'invalid view mode'`; modo ausente completa `'window'`.

### `validateSeed` — `shared/catalog.ts`

- **Segredo em qualquer profundidade** — `rejectSecrets` roda **antes** de tudo e percorre arrays e
  objetos com `Object.entries`, comparando a **chave** com `/password|secret|token|senha|segredo/i`
  → `'the seed must not contain secrets: <key>'`; testes com `password` e `token` na entrada,
  `token` aninhado (`invites[0].meta.token`) e `secret`/`senha` dentro de um array (`roles`).
- **Papel desconhecido** — `requireRoles` cobre os papéis da entrada e os do convite →
  `'unknown role: <id>'` (testes "rejects an unknown role cited by an entry/by an invite", com
  `finance`).
- **Resto do contrato** — `version` inteiro ≥ 1 (`'invalid seed version'`), `generatedAt`
  obrigatório (`'invalid generatedAt'`), `roles`/`entries`/`invites` arrays, id de entrada repetido
  (`'duplicate entry: kanban'`), `codeHash` em hex minúsculo de 64 (`'invalid codeHash'`, inclusive
  `A` maiúsculo), `update` nulo ou `{ url }` passando por `originOf` (`'address must be https'` e
  `'invalid address'`).
- **Campos ausentes completados** — `invites` → `[]`, `update` → `null`, e por entrada `active` →
  `true`, `icon` → `null`, `auth` → `null`, `views` → `[]`.
- **Aceita `resources/seed.example.json`** — lido com `Bun.file('resources/seed.example.json').json()`
  e passado a `validateSeed`: versão 1, papéis `['admin', 'team']`, entradas `['kanban', 'docs']`,
  a vista da primeira entrada `[{ label: 'Sprint', url: 'https://kanban.example.com/boards/1',
  mode: 'window' }]`, `invites []` e `update null`. O arquivo versionado do repositório é o mesmo
  que a fatia de release usa em `test/gen-config.test.ts`, então o formato está provado nos dois
  lugares.

### `visibleEntries` — `shared/catalog.ts`

Filtra `active` e, para quem não é admin, exige papel em comum (`entry.roles.some((role) =>
person.roles.includes(role))`); ordena por `order` ascendente e desempata por
`title.localeCompare(other, 'en')`. Testes: admin vê todas as ativas e **nunca** a inativa
(`['finance', 'kanban', 'docs']`); pessoa com papel `team` não vê a de papel `finance`; pessoa sem
papel nenhum não vê nada; `order` e desempate por título (`['c', 'a', 'b']`); o array recebido
continua igual (`filter` já devolve cópia, a ordenação é na cópia).

### `planSeed` — `shared/catalog.ts`

Assinatura exata do §3 (`current`, `seed`, `mode` → plano ou `null`).

- **`boot`** — `null` quando `current.seedVersion !== null && seed.version <= current.seedVersion`
  (testes "boot with the same version applies nothing" e "boot with an older version applies
  nothing"); com `seedVersion: null` insere tudo e carimba a versão do seed; com versão maior insere
  **só o que falta** por id/hash e devolve `updateEntries`/`updateRoles` vazios (teste "boot with a
  newer version inserts only what is missing and never updates": entra só `docs`, papéis só `admin`,
  convites só o hash novo).
- **`merge`** — sempre aplica, mesmo com versão menor que a carimbada, e nunca atualiza: teste
  "merge applies even with an older version and never updates" (versão 2 contra `seedVersion: 3` →
  plano existe, `seedVersion` continua 3, `updateEntries` e `updateRoles` vazios, só `docs` entra);
  "merge raises the stamped version to the seed version" (1 → 7).
- **`overwrite`** — sempre aplica e separa o que é novo do que já existe: teste "overwrite inserts
  the new entries and roles and hands back the existing ones" (insere `docs` e o papel `finance`;
  `updateEntries` = `['kanban']` com o título novo `'Kanban edited'`; `updateRoles` = `['admin',
  'team']`); "overwrite keeps the highest version already stamped" (`seedVersion: 9` contra seed 4 →
  9).
- **`seedVersion`** = `Math.max(current.seedVersion ?? 0, seed.version)` — no `boot` isso é sempre
  `seed.version`, porque o único caminho que chega ali já tem `seed.version > seedVersion`.
- **Convites** — só os `codeHash` que não existem em `current.invites` entram em `insertInvites`
  (teste "inserts only the invite hashes that are missing"); os convites já vistos nunca voltam.

### `exportSeed` — `shared/catalog.ts`

Monta `{ version, generatedAt: now.toISOString(), roles, entries, invites, update }` e **devolve o
resultado de `validateSeed`** — logo o resultado passa por construção, e o teste "builds a seed that
passes validateSeed" confere isso com `toEqual` (e `icon` → `null` para toda entrada, `generatedAt`
vindo do `Date` recebido, `update` preservado). As entradas recebidas não são mutadas (`{ ...entry,
icon: null }` cria objeto novo, vista `not.toBe` no caminho de `validateEntry`); `invites` viaja com
`roles` copiado; `update: null` viaja como `null`.

## Comando rodado e resultado observado

Nenhum. Instrução explícita do despacho ("**DO NOT run tests, typecheck, build, smoke, linter or
formatter. Only edit.**"): toda a evidência acima é `leitura` do contrato §3 e dos testes escritos.
A confirmação que fecha o critério fica com o coordenador: `bun test test/catalog.test.ts` e, no fim
da fase, `bun test test/`, `bunx tsc -p tsconfig.json` (`shared/catalog.ts` está no `include` do
tsconfig da raiz; `test/catalog.test.ts` não está em nenhum `include`, como os demais testes) e
`bunx tsc -p backend/tsconfig.json`.

## O que ficou de fora, e por quê

- **Gravar o plano no banco** (aplicar `insertEntries`/`updateEntries`, `meta.seed_version`, evento
  `seed_applied`) — é `backend/seed.ts` e `backend/main.ts` (§4 do contrato), de outros donos.
  `planSeed` é puro: diz o que falta, quem chama grava.
- **Ícone e sonda da entrada** — o ícone não viaja no seed (RF-13, §19) e a sonda é `shared/probe.ts`
  + `backend/probe-net.ts`. `validateEntry` só normaliza `icon` como string ou `null`.
- **Convite em si** (código, hash, validade em relação a "agora") — `shared/auth.ts`
  (`generateInviteCode`, `hashInviteCode`, `inviteIsValid`) e `backend/repo.ts`. Aqui o convite do
  seed é só `{ codeHash, roles, expiresAt }` validado.
- **Ordem de exibição de papéis, concessões e nomes** — `visibleEntries` decide o que a pessoa vê a
  partir de `entry.roles`; a concessão por papel (`role_grant`) é do repositório.

## Achados para o coordenador (fora do meu escopo de escrita)

- **Consumidores da v1 ainda de pé** — `backend/main.ts:7`, `backend/palcos.ts:13`, `backend/repo.ts:6`,
  `backend/seed.ts:4`, `backend/sonda-rede.ts:4` e `src/admin.ts:7` importam `../shared/catalogo`
  (nomes portugueses: `origemDe`, `validarEntrada`, `validarSeed`, `visiveis`, `aplicarSeed`,
  `exportarSeed`). O contrato já lista esses arquivos entre os removidos/reescritos na v2, cada um
  com seu dono; até as fatias aterrissarem, `bunx tsc -p backend/tsconfig.json` e o `tsc` da raiz não
  fecham — é a ordem esperada das fatias, não defeito desta. Já `scripts/gen-config.ts:12` e
  `test/gen-config.test.ts:6` estão na v2 e importam `originOf`/`validateSeed` **de
  `../shared/catalog`** com os nomes que escrevi — conferido por leitura, nada a ajustar de lá.
- **`backend/repo.ts` (dono: fatia do repositório) precisa de `originOf`** para preencher a coluna
  `origin` — o contrato §4 põe `originOf` como a única origem da regra; o que escrevi mantém a
  assinatura `originOf(url: string): string` e as mensagens `'invalid address'` /
  `'address must be https'`.
- **Janelas de ferramenta (dono: fatia de integração)** usam `auditUrl` para o campo `url` de evento
  (`login`, `load_failed`, `navigation_blocked`, `external_opened`, `download`): a função é nova na
  v2, é `origin + pathname` e devolve `null` quando o endereço não serve — o chamador precisa tratar
  o `null`.
- **`backend/seed.ts` (dono: fatia de seed/API)** troca `aplicarSeed` por
  `planSeed(current, seed, mode)`; `boot` é o seed do pacote, `merge`/`overwrite` são o import manual
  (`importSeedFile(repo, json, mode, icons)` do §4). `overwrite` é o único modo que devolve
  `updateEntries`/`updateRoles` — no §4 do contrato o import manual **nunca atualiza** (RF-27), então
  a fatia que consome precisa decidir explicitamente se usa esses campos.
- **Nenhuma decisão de contrato foi tomada aqui**: mensagens de erro fora das cinco do despacho
  ficaram em inglês e no mesmo formato da v1 traduzida (`'invalid views'`, `'invalid view mode'`,
  `'invalid auth'`, `'invalid noFill'`, `'invalid order'`, `'invalid active'`, `'invalid roles'`,
  `'invalid icon'`, `'invalid entry'`, `'invalid seed'`, `'invalid seed version'`,
  `'invalid generatedAt'`, `'invalid seed roles'`, `'invalid seed entries'`, `'invalid seed
  invites'`, `'invalid role'`, `'invalid invite'`, `'invalid expiresAt'`, `'invalid invite roles'`,
  `'duplicate entry: <id>'`, `'invalid update'`, `'invalid update address'`). Se o coordenador
  quiser outro texto para alguma, é troca de uma linha.

### Decisões declaradas

1. **`auditUrl` devolve `origin + pathname` literalmente** — um endereço sem caminho produz barra
   final (`https://x.com/`), como o WHATWG define `pathname` (`/`). "Nunca query nem fragmento" é a
   regra; a barra é consequência literal de "origin + pathname".
2. **Pertencimento por `Array.includes`, não `Set`** — o catálogo é de dezenas de entradas; `includes`
   sobre `current.entries/roles/invites` e sobre `seen` mantém o módulo sem estado intermediário e a
   regra legível. Se a lista crescer, o ponto de troca é só `planSeed` e o `seen` de `validateSeed`.
3. **`auth` só tem `noFill`** — `validateAuth` ignora chaves desconhecidas do objeto (como a v1
   ignorava) e recusa `noFill` não booleano. O campo `api` e o `credencial` da v1 não existem na v2 e
   não são aceitos de volta: a entrada normalizada tem exatamente os nove campos de `Entry`.
4. **Host com `_` ou `*` recusado em `originOf`, não só na montagem do gate** — a regra fecha na
   origem, então `validateEntry`, `validateSeed` (entrada, vista e `update`) e `gen-config.ts`
   herdam a recusa de graça; `test/gen-config.test.ts` ("a wildcard origin never becomes a tool key")
   conta com isso.
