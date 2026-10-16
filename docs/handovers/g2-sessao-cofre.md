# Fatia G2 — sessão e cofre (`backend/sessao.ts`, `backend/cofre.ts`)

Issue que autoriza: `docs/issues/B02-integracao-backend.md` (em-curso).
Contrato seguido: `docs/arquitetura.md` §4; conceitos em `docs/canonico.md` §9, §11, §13 e RF-07,
RF-08, RF-23, RF-24, RF-28. Tipos: `shared/types.ts`. Nada de `tjs`/`tiny` aqui: repositório,
chaveiro, `store` e autenticador entram por `deps` (por isso a fatia roda com `bun test`).

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `backend/sessao.ts` | criado. `DepsSessao`, `Sessao` (interface do que `criarSessao` devolve) e `criarSessao`: `estado`, `criarConta`, `desbloquear`, `desbloquearBiometria`, `habilitarBiometria`, `trocarSenha`, `bloquear`, `pessoaAtual`. Backoff em `meta` (`falhas_desbloqueio` + `ultima_falha_em`), erro único `'credenciais inválidas'`, derivação de custo igual para e-mail inexistente, convite por `hashCodigo`+`conviteAtivo`+`consumirConvite`, biometria em `bond.bio.<pessoa>` no chaveiro e `ultima_pessoa` no `store`. |
| `backend/cofre.ts` | criado. `DepsCofre`, `Cofre` (interface) e `criarCofre`: `chave`, `listar`, `salvar`, `ler`, `remover`, `removerTudo`, `exportar`, `importar`. Valor só no chaveiro (`JSON.stringify({usuario, segredo})`); índice no repositório; nenhum evento registrado aqui. |
| `test/sessao.test.ts` | criado. 17 testes: estado inicial, conta/convite, validações, desbloqueio, backoff, troca de senha com item de cofre, biometria e bloqueio. |
| `test/cofre.test.ts` | criado. 11 testes: chave, gravação nos dois lados, recusa do chaveiro, leituras ilegíveis, remoção, `removerTudo` e export/import cifrado. |
| `docs/handovers/g2-sessao-cofre.md` | este arquivo. |

Arquivos de outras fatias **não** foram tocados (`backend/repo.ts`, `shared/*`, `backend/main.ts`,
`src/*`, `scripts/*`).

## Critério de aceite — como cada item foi atendido

Evidência por `leitura` do código dos dois módulos e dos testes que os exercitam (não rodei
`bun test`, `tsc` nem build: o contrato da fase manda só editar e o coordenador roda os gates no
fim). Cada linha traz o teste que prova o comportamento e o trecho que o produz.

| Item do aceite | Onde está provado | Como o código atende |
| --- | --- | --- |
| 1ª conta sem convites → admin e desbloqueada | `criarConta › a primeira conta sem convites vira administradora e já fica desbloqueada` | ramo `semPessoas && !temConvite` → `papeis = [repo.garantirPapelAdmin().id]`; `atual = criada`, `store.set('ultima_pessoa', id)`, evento `conta_criada` |
| 2ª conta sem código → `'convite inválido'` | `criarConta › a segunda conta exige convite…` | sem pessoas/convites é falso → `codigo === ''` → `throw new Error('convite inválido')` |
| convite válido → papéis do convite; reusar o código falha | idem, e `convite expirado, inexistente e ausente dão a mesma mensagem` | `papeis = encontrado.papeis`, `consumirConvite(code_hash, id, agora)`; na segunda vez `conviteAtivo` devolve `null` (usado) → `'convite inválido'` |
| convite ativo e zero pessoas → `exige_convite` true e 1ª conta não vira admin | `criarConta › convite no repositório com zero pessoas…` | `estadoLocal`/`estado`: `exige_convite: total > 0 \|\| listarConvites().some(c => c.usado_em === null)`; o ramo de admin exige `!temConvite` |
| 5 falhas → `espera_ms` 1000; dentro da espera → `'aguarde para tentar de novo'`; relógio libera; acerto zera | `desbloquear › quatro falhas não esperam; a quinta espera 1000 ms e o relógio libera` | `esperaMs()` = `esperaDesbloqueio(falhas) − decorrido` (com `meta('ultima_falha_em')` e `deps.agora`); o guarda é a primeira linha de `desbloquear`; sucesso grava `definirMeta('falhas_desbloqueio','0')` |
| e-mail inexistente e senha errada dão a mesma mensagem | `desbloquear › senha errada e e-mail inexistente dão a mesma mensagem…` | uma única constante `ERRO_CREDENCIAIS`; e-mail inexistente deriva contra `SENHA_FALSA` (hash/salt base64 fixos com as iterações de `deps`) antes de falhar |
| evento de falha sem o e-mail digitado | idem | `evento('desbloqueio_falhou', null)`: `pessoa_id`, `url` e `detalhe` nulos; o teste varre o JSON dos eventos atrás do e-mail e da senha |
| `trocarSenha`: antiga para de funcionar, nova funciona, cofre legível (RF-24) | `trocarSenha › a senha antiga para de funcionar…` | `verificarSenha(atual, …)` → `validarSenhaNova(nova)` → `repo.trocarSenha(id, hashSenha(nova, iteracoes))` + evento `senha_trocada`; o chaveiro não é tocado |
| biometria indisponível → erro | `biometria › sem biometria no sistema…` | `deps.biometriaDisponivel === false` → `'biometria indisponível neste sistema'` em `habilitarBiometria` (depois do verify) e em `desbloquearBiometria` (antes de tudo) |
| habilitada + `autenticar` true → desbloqueia | `biometria › habilitada, a biometria grava a chave da pessoa…` | `chaveiro.set('bond.bio.<id>', id)`; `desbloquearBiometria` lê `ultima_pessoa`, chama `autenticar('Desbloquear o Bond')`, confere a chave e faz `atual = repo.pessoaPorId(ultima)` |
| `autenticar` false → `'biometria recusada'` | `biometria › recusa do sistema deixa a sessão fechada` | `if (!(await deps.autenticar(...))) throw new Error('biometria recusada')` |
| chave ausente ou pessoa revogada → `'biometria não habilitada'` | `biometria › sem chave no chaveiro ou com pessoa revogada…` | `chave !== ultima \|\| achada === null` (o valor gravado é o id da pessoa; `pessoaPorId` ignora revogada) |
| cofre: índice sem segredo, valor em JSON no chaveiro, `ler` | `chave e índice › salvar grava o índice…` | `salvarCofreItem({rotulo, usuario, chave_chaveiro})` + `chaveiro.set(chave, JSON.stringify({usuario, segredo}))`; `ler` lê pelo `chave_chaveiro` do índice |
| chaveiro recusando → erro e sem índice | `chave e índice › chaveiro que recusa a credencial…` | `if (!(await deps.chaveiro.set(...))) throw new Error('o chaveiro do sistema recusou a credencial')` **antes** de `salvarCofreItem`; o teste confere que um item anterior fica intacto |
| `remover` apaga chaveiro e índice | `remover › remover apaga a chave do chaveiro e a linha do índice` | `chaveiro.delete(item.chave_chaveiro)` + `repo.removerCofreItem` |
| `removerTudo` por pessoa | `remover › removerTudo limpa só a pessoa pedida` | `repo.removerCofrePessoa(pessoaId)` devolve os removidos e cada `chave_chaveiro` é apagada |
| export/import de ida e volta | `exportar e importar › ida e volta cifrada…` | `exportar` monta `CofreExportItem[]` (pulando índice sem valor legível) e chama `exportarCofre(itens, senha, deps.iteracoes)`; `importar` chama `importarCofre` e `salvar` item a item, devolvendo a contagem; senha errada → a mensagem do módulo puro, sem gravar nada |
| nenhum evento no cofre | `backend/cofre.ts` (leitura) | o módulo não importa `registrarEvento` nem recebe o `repo` para eventos: `credencial_*`/`cofre_*` ficam no `main.ts` |

Cobri também o que o aceite não listou, por serem as fronteiras do contrato: e-mail/nome/senha
recusados antes de gravar, convite expirado/ausente/inexistente com a mesma mensagem, e-mail já
cadastrado sem queimar o convite, `usuario`/`segredo` vazios, JSON ilegível no chaveiro, `lista`
vazia exportável, `bloquear` idempotente.

## Comandos

Nenhum gate da fase foi rodado (contrato: só editar; o coordenador roda `bun test test/`,
`bunx tsc -p tsconfig.json`, `bunx tsc -p backend/tsconfig.json` e o build). O único comando de
`execucao` foi uma sonda de semântica para escrever os literais do hash falso, porque errar o
base64 do salt faria a derivação comparar arrays de tamanhos diferentes:

| Comando | Resultado observado |
| --- | --- |
| `head -c 16 /dev/zero \| base64` | `AAAAAAAAAAAAAAAAAAAAAA==` (salt de 16 bytes nulos) |
| `head -c 32 /dev/zero \| base64` | `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` (hash de 32 bytes nulos) |
| `printf '%s' 'AAAAAAAAAAAAAAAAAAAAAA==' \| wc -c` | `24` → 22 `A` + `==`, que é 16 bytes em base64 |

## Desvios e decisões (para o coordenador confirmar)

1. **`deps.iteracoes?` em `criarSessao` e `criarCofre`.** O §4 não lista o campo; a fatia pede
   "para os testes usarem 1000". É opcional, com padrão `PBKDF2_ITERACOES` (§3), então a assinatura
   do §4 continua satisfeita.
2. **`Sessao` e `Cofre` são interfaces declaradas, não `type X = ReturnType<typeof criar…>`.**
   Continua existindo o nome exportado que a fatia pede (`import type { Sessao, Cofre }` funciona
   igual), mas o contrato dos métodos fica visível no arquivo que o possui — regra de tipagem do
   repositório. `criarSessao`/`criarCofre` têm o tipo de retorno anotado, então o compilador cobra
   que o objeto devolvido case com a interface.
3. **`bloquear()` é síncrono (§4) e o chaveiro é assíncrono.** O campo `biometria` do estado
   devolvido por ele vem da última leitura assíncrona (`estado()`, chamada no desbloqueio, na
   criação de conta e na habilitação; é ela que a casca chama para empurrar `sessao`). Não é
   adivinhação: `habilitarBiometria` passa por `estado()` no fim, então na tela de entrada — logo
   depois de `bloquear()` — o campo está correto.
4. **A troca de senha bate no `estado()` do fim.** `desbloquear`/`criarConta`/`habilitarBiometria`/
   `desbloquearBiometria` devolvem `await estado()`, e não um objeto montado à mão: assim
   `biometria` e `espera_ms` nunca divergem do que o banco e o chaveiro dizem.
5. **`habilitarBiometria` confere a senha antes de olhar a plataforma** — ordem literal do brief da
   fatia ("verifica `verificarSenha` da pessoa atual; sem `biometriaDisponivel` → throw"). Quem
   chamar com senha errada numa máquina sem biometria recebe `'credenciais inválidas'`; com senha
   certa, `'biometria indisponível neste sistema'`.
6. **Evento `desbloqueio` com `resultado: 'senha'` ou `'biometria'`.** O §13 usa `resultado` para
   "como entrou"; o tipo do evento é `desbloqueio` nos dois caminhos. Os desvios de `detalhe`
   continuam nulos em tudo que a sessão registra.
7. **Mensagens novas** (as do §2 continuam únicas e intocadas: `'credenciais inválidas'`,
   `'convite inválido'`): `'informe um e-mail válido'`, `'informe o nome'`, `'e-mail já
   cadastrado'`, `'aguarde para tentar de novo'`, `'sessão bloqueada'` (método que exige sessão),
   `'biometria indisponível neste sistema'`, `'biometria recusada'`, `'biometria não habilitada'`,
   `'informe o usuário'`, `'informe o segredo'`, `'o chaveiro do sistema recusou a credencial'`
   (esta veio do brief da fatia).
8. **`salvar` apara o `usuario` e não apara o `segredo`**: espaço nas pontas de uma senha de
   ferramenta pode fazer parte dela. Os dois continuam obrigatórios (não vazios).
9. **O índice do cofre tem chave estrangeira para `ferramenta`** (`backend/repo.ts`, §16): os testes
   criam as linhas de ferramenta antes de salvar credencial. Não é regra nova — é o schema.

## O que ficou de fora e por quê

- **Wire da API e push de estado** (`sessao.*` no `ApiContrato`, guarda de janela, eventos
  `credencial_*`/`cofre_*`, `app.info`): são de `backend/main.ts`, arquivo de outra fatia.
- **Importar/exportar com a senha da sessão**: o `main.ts` passa a senha recebida da janela
  `admin`; aqui a senha entra por parâmetro e não é guardada em lugar nenhum.
- **`semear`/`sonda-rede`/`icones`/`palcos`/`adaptador`**: outras fatias do §4.
- **Rodar os gates** (`bun test`, `tsc`, build): decisão do contrato da fase (o coordenador
  verifica no fim). A fatia entrega os testes escritos, não os resultados.

## Correção

Falha delimitada: `bun test test/sessao.test.ts test/cofre.test.ts` reprovava dois casos —
`biometria › sem chave no chaveiro ou com pessoa revogada, a biometria não abre nada` (throw de
`'sessão bloqueada'` em `backend/sessao.ts:147` a partir de `habilitarBiometria`, chamado em
`test/sessao.test.ts`) e `chave e índice › chaveiro que recusa a credencial: erro e nenhum índice
novo ou alterado` (throw de `'o chaveiro do sistema recusou a credencial'` em `backend/cofre.ts:63`,
chamado em `test/cofre.test.ts:157`).

A causa **não** está na implementação: por `leitura`, `backend/sessao.ts` (guarda
`exigirDesbloqueada` na 1ª linha de `habilitarBiometria`) e `backend/cofre.ts` (`if (!gravou) throw
new Error(ERRO_CHAVEIRO)` antes de `salvarCofreItem`) já cumprem a regra. As duas falhas são do
cenário:

1. `test/sessao.test.ts` chamava `c.sessao.desbloquear({ email, senha })` **sem `await`**;
   `desbloquear` é `async`, então `atual` continuava `null` e o `habilitarBiometria` seguinte batia
   na guarda de sessão bloqueada. Corrigido com `await` (e um comentário de uma linha explicando por
   quê); a prova da regra continua a mesma — chave `bond.bio.<pessoa>` ausente e, depois,
   `repo.revogarPessoa(id)` (com `pessoaPorId` filtrando `revogada_em IS NULL`) levam a
   `'biometria não habilitada'` com `desbloqueada` false.
2. `test/cofre.test.ts` ligava a recusa do chaveiro (`c.recusar()`) e **nunca a desligava**: o
   `salvar` da segunda metade do teste (o que grava `'antigo'` para provar que uma recusa posterior
   não mexe no que existe) recebia `false` do chaveiro. O `chaveiroMemoria` do próprio arquivo
   ganhou o espelho `aceitar: () => { recusa = false; }`, exposto pela cena como `aceitar`, e o caso
   passou a chamar `c.aceitar()` antes desse save. Nada de produção mudou; os asserts seguem
   provando erro com a mensagem exata e índice intacto (`c.repo.cofreItem(...)?.id === item.id` e
   `ler` devolvendo `'antigo'`).

Nenhum teste além desses dois casos foi alterado (a mudança no helper é só um método novo, sem uso
fora do caso corrigido). Não rodei `bun test`, `tsc`, build, linter nem formatador: contrato da
fatia. Evidência por `leitura` dos trechos citados acima e das linhas ajustadas em `test/sessao.test.ts`
e `test/cofre.test.ts`.
