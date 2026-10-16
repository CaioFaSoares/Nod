# Fatia G3 — integração do backend (`backend/main.ts`, `backend/sonda-rede.ts`, `backend/seed.ts`, `backend/icones.ts`)

Issue que autoriza: `docs/issues/B02-integracao-backend.md` (em-curso).
Contrato seguido: `docs/arquitetura.md` §2 e §4; requisitos: `docs/canonico.md` §7–§19 (RF-01 a
RF-29); tipos: `shared/types.ts`; runtime: `backend/tiny.d.ts`, `backend/tjs.d.ts`, `docs/tinyjs.md`.
Evidência desta fatia: **tudo por `leitura`**. Não executei teste, `tsc`, build nem o app (o contrato
da fase diz "só edite").

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `backend/icones.ts` | criado. `criarIcones(dir)` com `salvar(i: IconeBruto)` (bytes de `atob(i.base64)`, sha256 hex por `crypto.subtle`, `tjs.makeDir(dir, {recursive:true})` + `tjs.writeFile('<dir>/<hash>.<tipo>')`) e `dataUri(hash)` (procura `png`→`svg`→`jpeg`→`webp` com `readFile` em `try/catch`, devolve `data:image/png|svg+xml|jpeg|webp;base64,…` ou `null`; hash que não casa `^[0-9a-f]{64}$` devolve `null` sem tocar o disco). Exporta também `base64DeBytes`, `tipoPorExtensao` e `tipoPorMime`, que o seed e a sonda usam. |
| `backend/sonda-rede.ts` | criado. `sondar(endereco)`: `origemDe` (recusa não-https/loopback com a mensagem de `shared/catalogo`), `fetch(endereco, { redirect: 'follow' })`, `url_final = res.url || endereco`, HTML lido até 2 MiB por `res.body.getReader()` com `TextDecoder`, `analisarHtml`, `detectarProvedor`, e o primeiro ícone da lista de `analisarHtml` com `tipoIcone` aceito e corpo ≤ 512 KiB (por `content-length` e por contagem de bytes lidos), devolvido em base64. Falha de rede/leitura → `throw new Error('não consegui abrir o endereço: <motivo>')`; falha de ícone é enfeite e só passa ao próximo. |
| `backend/seed.ts` | criado. `aplicarSeedDoPacote(repo, resourcesDir, icones)`: `resourcesDir` nulo ou `seed.json` ausente (`readFile` lança) → `null`; senão `JSON.parse` + `validarSeed` + `gravarSeed(..., false)`, e com resultado grava `meta.seed_versao` (só se a versão avançar), o evento `seed_aplicado` e devolve a versão. `gravarSeed(repo, seed, icones, resourcesDir, permitirVersaoMenor)` é o miolo exportado (usado pelo import manual do catálogo): `aplicarSeed` sobre os ids/hashes atuais + as regras de gravação. Ícone do seed: `data:` decodificado pelo media type, caminho relativo lido de `resourcesDir` (recusa absoluto, `..` e segmento vazio), o resto ignorado. |
| `backend/main.ts` | sobrescrito o do template. Estado do módulo (`repo`, `sessao`, `cofre`, `palcos`, `icones`, `aplicacao`, `sistema`) montado em `init(app)`; `api` com as 41 chaves de `ApiContrato`; hooks `onNavigate`, `onWindowOpen`, `onDownload`, `onWindowClosed`, `onWindowState`, `onHotkey`. |
| `docs/handovers/g3-main.md` | este arquivo. |

## Critério de aceite — como cada item foi atendido

| Item | Onde está | Como o código atende |
| --- | --- | --- |
| `api` tem exatamente as chaves de `ApiContrato` | `backend/main.ts` (`const metodos: { [M in Metodo]: HandlerDe<M> }`, `export const api`) | o mapa é um tipo mapeado sobre `Metodo`, então o `tsc` exige as 41 chaves e nenhuma a mais; `HandlerDe<M>` fixa `Resultado<M>` como retorno de cada handler; `api` é derivado de `Object.keys(metodos)`. Conferi a lista por comando: 41 chaves, idênticas ao `ApiContrato` de `shared/types.ts`. |
| Cada chave aplica a guarda certa | idem (`SO_ADMIN`, `SEM_SESSAO`, `JANELAS_DA_CASCA`, `comGuarda`) | `login.report` só aceita `meta.window` com prefixo `palco:`; qualquer outro método vem de `main`/`admin`/`paleta`/`carregando`; `SO_ADMIN` (15 chaves: `catalogo.sondar|salvar|remover|exportar|importar`, `papeis.salvar|remover|conceder`, `pessoas.*`, `convites.emitir`, `eventos.*`, `app.instalarAtualizacao`) exige pessoa desbloqueada com `administrador`; `SEM_SESSAO` (`sessao.estado`, `sessao.criarConta`, `sessao.desbloquear`, `sessao.desbloquearBiometria`, `app.info`) é o único que passa bloqueado; todo o resto exige desbloqueio. Erro sempre `throw new Error('<pt-BR>')`. |
| Seed só com versão maior | `backend/seed.ts` (`gravarSeed` + `versaoDeMeta`) | `aplicarSeed` recebe `seed_versao: versaoDeMeta(meta('seed_versao'))` e devolve `null` quando `seed.versao <= seed_versao`; `aplicarSeedDoPacote` então não grava nada nem registra evento. |
| Import manual nunca sobrescreve | `backend/main.ts` (`catalogo.importar` → `gravarSeed(..., true)`) | `aplicarSeed` só devolve o que **não existe** (entradas por id, papéis por id, convites por `code_hash`) — o mesmo caminho do seed, com `seed_versao: null` para aplicar mesmo com versão menor. `meta.seed_versao` só sobe (`if (versaoAtual === null \|\| seed.versao > versaoAtual)`), então um arquivo antigo não rebaixa o estado. Contagens devolvidas em `{ entradas, papeis, convites }`. |
| `catalogo.salvar` preserva/remove/grava ícone | `backend/main.ts` | a chave `icone_hash` só entra em `extras` quando o parâmetro `icone` **veio**: ausente → `extras = {}` (o repo preserva, decisão por presença de chave, `backend/repo.ts:462`), `null` → `{ icone_hash: null }`, `IconeBruto` → `icones.salvar` do valor validado (`iconeBruto`). A sonda não é parâmetro e não é gravada aqui. |
| `catalogo.listar` serve o ícone | `backend/main.ts` + `backend/icones.ts` | `visiveis(repo.listarEntradas(), pessoa)` e `icone: icones.dataUri(repo.iconeHash(id))` (data URI ou `null`), como o painel de admin espera (`docs/handovers/fatia-f2-admin.md`, itens 2 e 3). |
| Desbloquear/bloquear mexem na casca | `backend/main.ts` (`desbloqueou`, `sessao.bloquear`) | desbloquear/criar conta/biometria → `palcos.modoCasca('rail')` + `push('sessao', estado)` + `push('rail', palcos.estado())`; bloquear → `bloquear()`, `palcos.fecharTodos()`, fecha `admin`/`paleta` se abertas, `modoCasca('desbloqueio')`, `push('sessao', estado)`. |
| Sonda, cofre e auditoria | `backend/main.ts` | `catalogo.sondar` → `sondar(endereco)`; `cofre.*` → `criarCofre` com a pessoa da sessão, eventos `credencial_salva`/`credencial_removida`/`cofre_exportado`/`cofre_importado`, nunca com o segredo (só o rótulo); `eventos.listar` monta o `FiltroEventos` campo a campo e `eventos.exportar` → `eventosJsonl()`. |
| Eventos que a fatia exigiu | `backend/main.ts`, `backend/seed.ts` | `seed_aplicado` (aplicado: resultado = versão, detalhe = contagens; falha: resultado `falhou`, detalhe = motivo), `catalogo_alterado` (salvo/removido), `catalogo_importado`, `papeis_alterados`, `concessao_alterada`, `acesso_revogado`, `convite_emitido` (sem o código; resultado `null`, detalhe com papéis e validade), `atualizacao`, `download`. |
| Hooks do runtime | `backend/main.ts` | `onNavigate` → `palcos.aoNavegar` (retorno repassado); `onWindowOpen` → `'window'` só quando o `opener` é `palco:*`, a entrada existe e a origin do popup é a da entrada (ou um fluxo de identidade dela); senão `'external'`; `onDownload` → evento `download` só em `done`/`failed`; `onWindowClosed` → `palcos.aoJanelaFechada`; `onWindowState` → `palcos.aoFoco(info.win, info.focused)`; `onHotkey` → `palcos.aoAtalho`. Os seis nomes e as assinaturas existem em `backend/tiny.d.ts` e em `.agents/skills/tinyjs/references/api.md:605`. |
| A pessoa entra nos eventos dos palcos | `backend/main.ts` (`registrar` de `criarPalcos`) | `backend/palcos.ts:201` registra com `pessoa_id: null` (o palco não conhece a sessão); o `registrar` de `main.ts` sobrepõe com `sessao.pessoaAtual()?.id ?? null`, que é o que `docs/handovers/g1-palcos.md` (item 1 de "o que outro dono precisa fazer") e o canonico §13/RF-12 pedem. |
| `init(app)` na ordem do contrato | `backend/main.ts` | `app.paths()` → `tjs.makeDir(paths.data, {recursive:true})` → `abrirSqlite('<data>/bond.db')` → `criarRepo` → `migrar()` → `garantirPapelAdmin()` → `criarIcones('<data>/icones')` → `aplicarSeedDoPacote` (falha vira evento e o app segue) → cache de ícones → `criarSessao` (`chaveiro: app.secrets`, `store: app.store`, `autenticar: app.authenticate`, `biometriaDisponivel: os !== 'linux'`) → `criarCofre` → `criarPalcos` → `palcos.modoCasca('desbloqueio')`. |
| Mensagens pt-BR, sem segredo | os quatro arquivos | todas as mensagens de erro são pt-BR; `cofre.revelar` é o único caminho que devolve segredo, e nenhum evento/`detalhe`/log recebe senha, código de convite ou valor de credencial. |

## Decisões e desvios declarados

1. **`aplicarSeedDoPacote` ganhou um terceiro parâmetro (`icones`).** `docs/arquitetura.md` §4 traz
   `aplicarSeedDoPacote(repo, resourcesDir: string | null)`, mas o seed precisa gravar os ícones das
   entradas novas e o contrato da fatia manda acrescentar `icones` ao fim da assinatura. Quem
   consome a assinatura antiga é só `backend/main.ts`, que chama com os três argumentos.
2. **O export do cofre confere a senha local com `repo.pessoaPorEmail` + `verificarSenha`**
   (`backend/main.ts`, `conferirSenhaLocal`). A `Sessao` de §4 não expõe verificação de senha, e
   `desbloquear()` mexeria no backoff de `meta.falhas_desbloqueio` por um motivo que não é
   desbloqueio. Erro: `'senha incorreta'` (sem contar falha de desbloqueio).
3. **`onWindowOpen` usa `detectarProvedor` (de `shared/sonda`) como teste de "provedor".** §4 fala
   em "origin da entrada ou de provedor **visto**", mas a interface de `Palcos` não expõe nenhuma
   consulta sobre os provedores já vistos na cascata daquele palco. Uso a mesma regra pura que a
   sonda usa (URL com caminho de OIDC/SAML/SSO fora da origin da entrada); sem ela, um popup de
   login de terceiro iria para o navegador do sistema. Se o coordenador quiser o estado real de
   "visto", `Palcos` precisa expor um predicado e `main.ts` passa a usá-lo.
4. **`Entrada.icone` é preenchido com data URI em `catalogo.listar` e `catalogo.salvar`** (o
   comentário do tipo em `shared/types.ts` diz "runtime: data URI ou null"), e os palcos recebem o
   ícone por um `Map<Id, string>` mantido em `main.ts`, porque a dependência `icone(id)` de
   `criarPalcos` é **síncrona** e `icones.dataUri` é assíncrona. O cache é recarregado no boot, em
   `catalogo.salvar`, `catalogo.remover` e `catalogo.importar`.
5. **`os` vem de `app.system.os()`**, não de `app.info()`: `TinyAppInfo` (`backend/tiny.d.ts:283`)
   só tem `version`, `tinyjs` e `runtime`. É chamado uma vez em `init` e guardado no módulo.
6. **Evento `download` fica com `ferramenta_id: null`**: `TinyDownloadEvent`
   (`backend/tiny.d.ts:1565`) não traz a janela nem a ferramenta de origem. O endereço, o nome do
   arquivo e o estado vão para `url`/`detalhe`/`resultado`.
7. **`init` cria `paths.data`** (`tjs.makeDir(..., {recursive:true})`) antes de abrir o SQLite: o
   runtime documenta que `data`/`cache`/`logs` **não** são criados pelo app
   (`backend/tiny.d.ts:576`), e `new Database(caminho)` falharia sem a pasta.
8. **Push `catalogo`/`rail` em `papeis.*`, `pessoas.*` e `janelas.fechar`**: §4 só exige push em
   `catalogo.salvar` e no desbloquear/bloquear. As mudanças de papel e concessão mexem na
   visibilidade (RF-06, RF-11) e o evento `catalogo` é o que faz a página de admin reler as listas
   (`docs/handovers/fatia-f2-admin.md`), então `papeis.salvar|remover|conceder`,
   `pessoas.atribuirPapeis` e `pessoas.revogar` empurram `catalogo` e `rail`.
9. **`convites.emitir` valida que os papéis existem** (`papel desconhecido: <id>`), como
   `validarSeed` faz com os papéis do seed; sem isso um convite poderia conceder um papel
   inexistente.
10. **`janelas.abrir`/`janelas.fechar` usam `app.windows()`** para não abrir uma janela já aberta
    nem fechar uma que não existe; `admin` abre com `page: 'admin.html'`, `size: '960x680'` (§4) e
    `paleta` vira `palcos.aoAtalho('paleta')`.
11. **Extras exportados** que o contrato não nomeia, todos usados dentro desta fatia:
    `icones.ts` → `base64DeBytes`, `tipoPorExtensao`, `tipoPorMime`; `seed.ts` → `gravarSeed`,
    `versaoDeMeta`, `ContagensSeed`. Não há dependência nova.

## O que ficou de fora e por quê

- **Nada foi executado.** Nem `bun test`, nem `tsc`, nem `tinyjs dev`/`build`, nem o app — o
  contrato da fase reserva a verificação para o coordenador. Portanto: nenhuma linha deste handover
  afirma comportamento observado em execução. O único comando que rodei foi a conferência das 41
  chaves da `api` contra o `ApiContrato` (`grep -o "^  '[^']*'"` nos dois arquivos + `sort -u` +
  `diff` → "IDENTICOS: 41 chaves únicas").
- **Conferência por leitura depois que as fatias irmãs entraram**: `backend/sessao.ts` (interface
  `Sessao`, `DepsSessao`, `bloquear(): EstadoSessao` síncrono), `backend/cofre.ts` (interface `Cofre`
  e `DepsCofre`, sem registro de evento) e `backend/palcos.ts` (interface `Palcos`, `DepsPalcos` com
  `entradas`/`icone`/`credencial`/`registrar`/`os`) conferem com o que `main.ts` importa e chama por
  §4. Também conferi os chamadores reais: `src/api.ts`, `src/casca.ts`, `src/admin.ts`,
  `src/paleta.ts`, `src/carregando.ts` e `test/smoke/smoke.html` usam exatamente os formatos de
  parâmetro que os handlers validam, e a guarda não barra os passos do smoke (conta nova → admin
  desbloqueado chama `catalogo.sondar`; `catalogo.listar` com a sessão bloqueada lança).
- **Não toquei** `shared/`, `src/`, `resources/`, `scripts/`, `test/`, `backend/repo.ts`,
  `backend/sqlite.ts`, `backend/sessao.ts`, `backend/cofre.ts`, `backend/palcos.ts`,
  `backend/adaptador.ts`, `backend/tiny.d.ts`, `backend/tjs.d.ts`, `tinyjs.base.json` nem qualquer
  outro arquivo.

## Achados para o coordenador (não implementei)

1. **Limite de palcos quentes não persiste.** `docs/handovers/g1-palcos.md` (item 6) diz que a
   persistência do limite é do `main.ts`, mas §4 não dá chave de `meta` nem método para isso, e
   nenhuma página chama `rail.configurar` (`grep` em `src/` e `docs/` não acha `rail.configurar`). O
   handler chama `palcos.configurar(limite)` e pronto. Escolher uma chave (`meta('quentes_limite')`,
   por exemplo) é decisão de formato de persistência: fora do meu contrato.
2. **`onNavigate` de janelas que não são palco.** `palcos.aoNavegar` devolve `undefined` fora de
   `palco:*` (`backend/palcos.ts`), então uma navegação de `mailto:`/`app://` a partir da casca ou do
   admin é permitida pelo backend e o webview a recusa sozinho. Nenhuma página tem link externo hoje
   (conferi `src/*.ts`), então tratar isso agora seria inventar comportamento; fica registrado.
3. **"Provedor visto" em popup** (desvio 3): §4 pede esse estado e a interface de `Palcos` não o
   expõe. Ou o coordenador aceita o predicado puro de `shared/sonda`, ou `Palcos` ganha um método e
   `main.ts` passa a usá-lo.
4. **Ícone de seed que começa com `/`**: `scripts/gen-config.ts` (`iconesRelativos`) tira as barras
   iniciais e embute o arquivo no pacote, tratando `/icone.png` como `icone.png` dentro de
   `resources/`; o `lerIcone` de `backend/seed.ts` recusa caminho que começa com `/` (o contrato da
   fatia diz "absoluto → ignora"), então esse arquivo iria no pacote sem virar ícone. As duas regras
   precisam coincidir: escolher uma e ajustar o outro lado é do coordenador (as fatias têm donos
   diferentes).

## Precisa de outro dono

- `backend/sessao.ts` (G2): `Sessao` com `estado`, `criarConta`, `desbloquear`,
  `desbloquearBiometria`, `habilitarBiometria`, `trocarSenha`, `bloquear`, `pessoaAtual` — conferido
  no arquivo já escrito. `main.ts` chama `bloquear()` **de forma síncrona** (§4), registra os
  eventos de catálogo/cofre/papéis e empurra `sessao`/`rail` depois de `criarConta`/`desbloquear*`;
  a sessão registra sozinha os eventos de sessão (`conta_criada`, `desbloqueio`,
  `desbloqueio_falhou`, `bloqueio`, `senha_trocada`), então `main.ts` não registra nenhum deles (não
  há evento repetido), e nenhum dos dois empurra o mesmo push duas vezes (`fecharTodos()` publica o
  `rail`, o `main.ts` publica o `sessao`).
- `backend/cofre.ts` (G2): `Cofre` com `listar`, `salvar`, `ler`, `remover`, `removerTudo`,
  `exportar`, `importar` — conferido no arquivo; o cabeçalho do módulo diz que os eventos de
  credencial são do `main.ts`, e é o que `main.ts` faz.
- `backend/palcos.ts` (G1): `Palcos` com os métodos de §4, incluindo `registrar` (eventos de abrir
  ferramenta, login, carregamento) e o push de `rail` a cada mudança de estado — conferido no
  arquivo.
- `scripts/gen-config.ts` (R): em dev, `paths.resources` existe e aponta para `resources/`; se o
  `seed.json` privado não existir, `aplicarSeedDoPacote` devolve `null` sem erro. No build, o
  pacote precisa levar `seed.json` (`"resources": ["seed.json"]`), senão o app abre sem catálogo —
  o gate do §6 já exige o seed no build.
- `tinyjs.base.json` já tem `"popups": "window"` (leitura): sem isso o retorno `'window'` de
  `onWindowOpen` não é honrado pelo runtime.

## Onde a evidência cai no handover da frente

Este arquivo é a evidência da fatia G3, junto com os quatro módulos. O coordenador confirma com os
gates do §6 de `docs/arquitetura.md`: `bun test test/`, `bunx tsc -p tsconfig.json`,
`bunx tsc -p backend/tsconfig.json`, `bun run app:build` com e sem seed, e o smoke em
`test/smoke/` — este último é o único que prova o caminho real (`init`, seed, `api`, palcos).

## Correção

Sintoma observado pelo coordenador (`bunx tsc -p backend/tsconfig.json`, TypeScript 6): oito erros —
um `TS2345` em `backend/icones.ts`, um `TS18047` em `backend/main.ts` e seis `TS2322` de
`Promise<boolean>` contra `HandlerDe<...>`.

| Erro (execução do coordenador) | Causa | Mudança |
| --- | --- | --- |
| `icones.ts(56,77) TS2345` — `Uint8Array<ArrayBufferLike>` não é `BufferSource` | `bytesDeBase64` declarava o retorno como `Uint8Array` solto, ou seja `Uint8Array<ArrayBufferLike>` no TypeScript 6; a anotação larga apagava o `Uint8Array<ArrayBuffer>` que o `new Uint8Array(n)` já produz, e `crypto.subtle.digest('SHA-256', bytes)` exige `BufferSource`. | `bytesDeBase64` passa a devolver `Uint8Array<ArrayBuffer>` — mesmo padrão do `binarioParaBytes` de `shared/auth.ts` e do `base64ParaBytes` de `shared/exportar-cofre.ts` —, com a nota de tipos no JSDoc. Corpo inalterado. |
| `main.ts(109,42) TS18047` — `'r' is possibly 'null'` | `entradasVisiveis` calculava `pessoa` e checava o `null` numa expressão só (`r === null \|\| s === null ? null : s.pessoaAtual()`); o estreitamento de `r` não sobrevivia até `r.listarEntradas()` no ramo `pessoa !== null`. | Saída antecipada `if (r === null \|\| s === null) return [];` antes de tocar `r`, e só então `const pessoa = s.pessoaAtual()`. Mesmo comportamento, sem `!`. |
| os seis `TS2322` — `sessao.trocarSenha`, `catalogo.remover`, `pessoas.revogar`, `cofre.remover`, `janelas.abrir`, `janelas.fechar` | `ApiContrato` (`shared/types.ts:267,273,284,290,301-302`) fixa o resultado desses métodos como o literal `true`; um `async` com `return true` infere `Promise<boolean>`, e `boolean` não é atribuível a `true`. | Cada um dos seis handlers ganhou a anotação de retorno `: Promise<true>` na própria função. Os corpos continuam devolvendo `true` onde já devolviam; o contrato de `shared/types.ts` não foi tocado. |

Evidência: **leitura** — não rodei `tsc`, teste, build nem o app (o contrato da fase reserva a
verificação ao coordenador). Nenhum `any`, `@ts-ignore`, `@ts-expect-error` nem `!` foi usado, e
nenhum outro comportamento mudou.
