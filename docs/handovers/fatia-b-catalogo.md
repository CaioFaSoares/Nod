# Fatia B — catálogo (lógica pura)

Autorização: `docs/issues/B01-modulos-puros-e-frontend.md` (`em-curso`), fatia de
`docs/arquitetura.md` §3 `shared/catalogo.ts`. Contrato lido antes de escrever: `docs/arquitetura.md`,
`shared/types.ts` (não tocado), `resources/seed.example.json`, `docs/canonico.md` §8, §9, §10, §14
(RF-13, RF-26, RF-27).

## Arquivos tocados

- `shared/catalogo.ts` (criado) — as sete exportações do contrato: `origemDe`, `slug`,
  `validarEntrada`, `validarSeed`, `visiveis`, `aplicarSeed`, `exportarSeed`. Sem `tjs`, sem `tiny`,
  sem DOM: só `URL`, `String`, `Date`, `Object`, `Array`, `Set`. Tipos importados com
  `import type` de `./types`, imports sem extensão.
- `test/catalogo.test.ts` (criado) — `bun test` (`bun:test`), determinístico, sem rede: nenhum PBKDF2,
  nenhum relógio real (`new Date('…')` e `new Date(0)` explícitos). Lê `resources/seed.example.json`
  com `Bun.file(...).json()`.
- `docs/handovers/fatia-b-catalogo.md` (este arquivo).

Nenhum outro arquivo foi lido/escrito em modo de edição. Um arquivo, um dono: `shared/catalogo.ts` e
`test/catalogo.test.ts` não têm outro dono declarado no despacho.

## Critério de aceite e como foi atendido

Evidência de tudo aqui: **`leitura`** — implementação lida contra o contrato e testes escritos; o
contrato da fase proíbe executar (`bun test`, `tsc`, linter, formatador). Nada foi executado.

| Item do critério | Onde | Como |
| --- | --- | --- |
| `origemDe`: https ok | `shared/catalogo.ts` `origemDe` | protocolo `https:` devolve `url.origin`; teste "https devolve a origin" |
| `origemDe`: `http://localhost:3000` ok | idem | `http:` só com host de loopback (`localhost`, `*.localhost`, `127.x.x.x`, `::1` com ou sem colchete); teste "http só em loopback" cobre `localhost`, `app.localhost`, `127.0.0.1`, `[::1]` |
| `origemDe`: `http://exemplo.com` lança | idem | `throw new Error('endereço precisa ser https')`; teste "http fora de loopback lança" |
| `origemDe`: lixo lança | idem | `new URL` em `try/catch` → `'endereço inválido'`; teste "endereço inválido lança" (`'lixo'`, `''`) |
| `slug('Kanban da Equipe!')` | `slug` | `toLowerCase` → NFD → remove `\p{M}` → `[^a-z0-9]+` vira `-` → colapsa → apara → corta em 40 |
| `slug('Ação Já')` = `acao-ja` | idem | teste "remove acento" |
| `validarEntrada` aplica padrões | `validarEntrada` | devolve objeto novo com `icone null, ordem 0, papeis [], vistas [], credencial null, auth null, api [], ativo true`; teste "aplica os padrões num objeto novo" (e `not.toBe(bruto)`) |
| `validarEntrada` rejeita id com maiúscula | idem | `^[a-z0-9][a-z0-9-]{0,39}$` → `'id inválido'`; testes "rejeita id com maiúscula" e "rejeita id longo demais" |
| `validarEntrada` rejeita vista de outra origin | `validarVista` | compara `origemDe(vista.endereco)` com a origin da entrada → `'vista fora da origem da ferramenta'` |
| `validarSeed` rejeita `entradas:[{..., senha:'x'}]` | `rejeitarSegredos` | varre o objeto inteiro antes de qualquer outra checagem, em qualquer nível e dentro de arrays → `'o seed não pode conter segredo: senha'` |
| `validarSeed` rejeita chave aninhada `token` | idem | teste com `convites[0].meta.token` (dois níveis) → `'o seed não pode conter segredo: token'` |
| `validarSeed` rejeita papel desconhecido | `exigirPapeis` | cobre `entrada.papeis` e `convite.papeis` → `'papel desconhecido: <id>'`; dois testes |
| `validarSeed` aceita `resources/seed.example.json` | `validarSeed` | teste lê o arquivo com `Bun.file('resources/seed.example.json').json()` e confere versão, papéis, ids e a vista `Sprint` |
| `visiveis`: admin não vê inativa | `visiveis` | filtro `e.ativo &&` antes do teste de administrador; teste "admin vê todas as ativas, nunca as inativas" |
| `visiveis`: sem papel em comum não vê | idem | interseção `entrada.papeis ∩ pessoa.papeis` |
| `visiveis`: ordem respeitada | idem | `ordem` asc, desempate por `titulo.localeCompare(…, 'pt-BR')`; testes de ordem e de desempate |
| `aplicarSeed`: versão igual → `null` | `aplicarSeed` | `seed.versao <= atual.seed_versao` com `seed_versao !== null`; teste "versão igual não aplica nada" |
| `aplicarSeed`: versão maior com id existente → não reaparece | idem | filtro por `atual.entradas`/`atual.papeis`/`atual.convites`; testes "versão maior só insere o que não existe" e "não sobrescreve a entrada já existente" |
| `aplicarSeed`: `seed_versao` atualizado | idem | devolve `seed_versao: seed.versao` |
| `exportarSeed` → `validarSeed` passa | `exportarSeed` | constrói o objeto e devolve `validarSeed(construído)` — a garantia é estrutural, não um teste a mais; teste compara `validarSeed(seed)` com `seed` |
| `exportarSeed`: `icone: null`, `gerado_em` | idem | `{ ...e, icone: null }` e `agora.toISOString()`; teste confere `2026-10-15T12:30:00.000Z` |

Cobertura adicional escrita na mesma fatia: padrões da vista (`modo: 'janela'`), modo inválido, `api`
com não-string, `ativo` não booleano, `auth` normalizado, lista copiada (não compartilhada), versão
não inteira, `gerado_em` ausente, id de entrada repetido, `code_hash` que não é hex de 64,
`atualizacao` sem https, `visiveis` sem mutar o array recebido, `exportarSeed` sem mutar as entradas.

## Decisões tomadas dentro do contrato (não são desvios)

- **Mensagens pt-BR onde o despacho não fixou texto**: `'entrada inválida'`, `'título obrigatório'`,
  `'vista inválida'`, `'rótulo da vista obrigatório'`, `'modo de vista inválido'`, `'vistas inválidas'`,
  `'ícone inválido'`, `'ordem inválida'`, `'papéis inválidos'`, `'credencial inválida'`,
  `'auth inválida'`, `'adaptador inválido'`, `'nao_preencher inválido'`, `'api inválida'`,
  `'ativo inválido'`, `'seed inválido'`, `'versão do seed inválida'`, `'gerado_em inválido'`,
  `'papéis do seed inválidos'`, `'entradas do seed inválidas'`, `'convites do seed inválidos'`,
  `'papel inválido'`, `'convite inválido'`, `'code_hash inválido'`, `'expira_em inválido'`,
  `'papéis do convite inválidos'`, `'atualização inválida'`, `'endereço da atualização inválido'`,
  `'entrada repetida: <id>'`. As fixadas no despacho (`'id inválido'`, `'endereço inválido'`,
  `'endereço precisa ser https'`, `'vista fora da origem da ferramenta'`,
  `'o seed não pode conter segredo: <chave>'`, `'papel desconhecido: <id>'`) são literais.
- **Ordem do `slug`** seguida como escrita: apara antes de cortar em 40. Um corte no meio de um
  separador pode deixar `-` no fim; o regex de id aceita `-` final, então não é desvio de contrato.
- **Campo presente com tipo errado lança** (em vez de cair no padrão): o padrão vale para campo
  ausente. `titulo`/`rotulo` são apenas checados não vazios (`trim`), guardados como vieram.
- **`convite.papeis` ausente → `[]`**, para casar com o padrão de lista do resto do módulo.
- **`atualizacao.url` passa por `origemDe`** (HTTPS obrigatório fora de loopback), alinhado a RNF-04.

## O que ficou de fora e por quê

- **Execução.** `bun test test/catalogo.test.ts` não foi rodado: o contrato da fase diz "NÃO rode
  testes, typecheck, linter nem formatador". A verificação é do coordenador.
- **Nada de `shared/` fora deste arquivo.** `shared/auth.ts`, `shared/rail.ts`, `shared/cascata.ts`,
  `shared/sonda.ts`, `shared/exportar-cofre.ts` têm outros donos; `shared/types.ts` e `src/api.ts` são
  contrato e não foram tocados.
- **Nada de `backend/` nem de `src/`.** Fora do escopo da fatia; `backend/seed.ts` (§4) vai chamar
  `validarSeed`/`aplicarSeed`, e o admin (§5, aba Catálogo) vai chamar `exportarSeed`.

## O que outro dono precisa fazer

- `backend/seed.ts` (Fatia D/E): `aplicarSeed` espera o estado atual como listas de ids já lidas do
  banco (`entradas`, `papeis`, `convites` = `code_hash`, `seed_versao` de `meta`); o retorno é só o
  delta a inserir — quem grava é o backend.
- `backend/repo.ts` (Fatia E): os ids de convite no estado são `code_hash`, não o código em claro.
- Admin (Fatia F2): `exportarSeed` já zera `icone` e valida o resultado; o ícone continua saindo por
  `iconeDe`/`repo.iconeHash`.
- Coordenador: rodar `bun test test/` e `bunx tsc -p tsconfig.json` — `shared/catalogo.ts` está no
  `include` do tsconfig da raiz, `test/catalogo.test.ts` não está em nenhum `include` dos dois
  tsconfigs (mesma situação dos outros `test/*.test.ts` da fase).
