# Fatia K2 — janela `admin` como conta + correções de tipo

Dono: fatia K2 (arquivos `src/admin.ts`, `admin.html` e o botão do rodapé em `src/casca.ts`).
Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md` (`em-curso`, §5 páginas).
Contrato: `docs/arquitetura.md` §2 (métodos de admin, guarda de janela) e §5 (linhas "Casca" e
"Admin / conta"). Requisitos: `docs/canonico.md` §9, §11, §12, §14 (RF-08, RF-24, RF-28).

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `src/admin.ts` | boot passa a ler `sessao.estado`; abas Cofre e Conta para toda pessoa desbloqueada, Ferramentas/Papéis/Pessoas/Auditoria/Catálogo só com `pessoa.administrador`; aba `Conta` nova (trocar senha, habilitar biometria); `ouvir('sessao')` reavalia as abas e sessão bloqueada só mostra o aviso; `app` possivelmente nulo e `papeis.length` sobre `HTMLDivElement` corrigidos na origem |
| `admin.html` | título da página: `Bond — Admin` → `Bond — Conta` (só o `<title>`) |
| `src/casca.ts` | botão do rodapé do rail: era `admin` e só para administrador; agora `conta`, com `aria-label` "Conta e configurações", para toda pessoa desbloqueada, chamando `janelas.abrir({ qual: 'admin' })` |
| `docs/handovers/k2-conta-admin.md` | criado: este handover |

Nada mais foi tocado: `src/style.css`, `src/admin.css`, `src/api.ts`, `shared/types.ts`, os módulos de
`shared/` e todo o `backend/` ficaram como estavam. Nenhuma classe CSS nova foi necessária: a aba
Conta usa só o vocabulário de `src/style.css` (`.painel .campo .campo-bloco .botao
.botao-primario .linha .coluna .rotulo .erro .aviso .ok .mono .chip .vazio`) mais `.muted`, que é de
`src/admin.css`.

## Evidência: `leitura`

Não executei nada — nem `tsc`, nem `bun test`, nem build, nem o app (o despacho desta fase proíbe).
Toda afirmação abaixo é **leitura** do que escrevi contra o contrato lido (`docs/arquitetura.md` §2,
§4, §5), contra `shared/types.ts` (`EstadoSessao`, `Pessoa`, `ApiContrato`, `EventosPush`) e contra
`src/api.ts` (`chamar`, `ouvir`, `mensagemDeErro`). Nada aqui é chamado de verificado por execução.

## Critério de aceite e como cada item foi atendido

### 1. Pessoa não-admin vê só Cofre e Conta; admin vê todas

`ABAS` (uma tabela só, com ordem de tela e marcação `soAdmin`) e `abasVisiveis()`, que filtra por
`!aba.soAdmin || ehAdmin()`; `ehAdmin()` é `pessoa()?.administrador === true`, e `pessoa()` devolve
`null` sem `sessao.desbloqueada`. O `<nav class="abas">` é desenhado a partir de `abasVisiveis()`, e
`trocarAba()` recusa (`if (!abaVisivel(aba)) return;`) qualquer aba fora dessa lista.

- não-admin: `cofre`, `conta`;
- admin: `ferramentas`, `papeis`, `pessoas`, `cofre`, `conta`, `auditoria`, `catalogo`.

Aba de entrada: `abaInicial()` → `ferramentas` para admin, `cofre` para os demais, aplicada no boot
(`iniciar` → `aplicarSessao`) e sempre que a aba corrente deixa de ser visível (`aplicarSessao`
depois de um push `sessao`). O `h1` acompanha: "Bond — Admin" com `administrador`, "Bond — Conta` sem
(ver "Decisões").

### 2. Nenhum método de admin é chamado quando `administrador` é false

`carregarAba()` começa com `if (!abaVisivel(estado.aba)) return;` — a mesma fonte de verdade da
listagem de abas. Com isso, a única carga alcançável por não-admin é:

| Aba visível a todos | Métodos chamados |
| --- | --- |
| Cofre | `cofre.listar`, `cofre.salvar`, `cofre.revelar`, `cofre.remover`, `cofre.exportar`, `cofre.importar`, `catalogo.listar` |
| Conta | `app.info` (uma vez, para saber o SO), `sessao.trocarSenha`, `sessao.habilitarBiometria` |

Nenhum deles está na lista de métodos de admin da §2 (`catalogo.sondar|salvar|remover|exportar|importar`,
`papeis.salvar|remover|conceder`, `pessoas.*`, `convites.emitir`, `eventos.*`,
`app.instalarAtualizacao`). Os handlers que chamam método de admin (`salvarFerramenta`, `sondar`,
`criarPapel`, `renomearPapel`, `removerPapel`, `conceder`, `alternarPapelPessoa`, `revogarPessoa`,
`emitirConvite`, `exportarEventos`, `filtrarEventos`/`carregarEventos`, `exportarSeed`,
`importarSeed`, `verificarAtualizacao`, `instalarAtualizacao`) só são alcançáveis pelos botões das
abas que não existem sem `administrador`; e a guarda de `carregarAba` cobre o caminho do push
`catalogo`, que dispara carga sem clique.

O boot chama `sessao.estado` (isento de sessão desbloqueada na §2) e nada mais antes de saber quem é a
pessoa. Com `sessao.estado` falhando, `estado.sessao` fica `null`, `pessoa()` é `null` e a janela
desenha só o aviso — nenhuma chamada de aba acontece.

### 3. Senhas não ficam em variável global nem em console/storage; campos limpos após sucesso

- A senha local existe só como `value` de `<input type="password">` e como argumento de
  `chamar('sessao.trocarSenha', { atual, nova })` / `chamar('sessao.habilitarBiometria', { senha })`.
  Nenhum campo do objeto `estado` guarda senha (nem a nova, nem a atual, nem a do cofre).
- Nada de `localStorage`/`sessionStorage`/`console`/`document.title` no arquivo (só o comentário de
  cabeçalho dizendo isso, como antes).
- `trocarSenha()` limpa os três campos (`atual`, `nova`, `confirmar`) depois do sucesso de
  `sessao.trocarSenha`, e `habilitarBiometria()` limpa o campo depois do sucesso de
  `sessao.habilitarBiometria`. Em falha os campos ficam como estão, de propósito, para a pessoa
  corrigir e tentar de novo sem redigitar — mesma escolha já usada em `salvarCredencial` (o redesenho
  não sobrevive a um bloqueio: `aplicarSessao` troca a tela inteira pelo aviso).
- `aplicarSessao` com sessão bloqueada limpa `estado.revelado` (via `esconderRevelado()`), zera o
  código de convite (`estado.convite`) e limpa as mensagens antes de desenhar — nenhum segredo fica na
  tela nem na memória (canonico §9, §13).

### 4. Aba Conta

- **Trocar senha**: três campos (`senha atual`, `senha nova`, `confirmar senha nova`, todos
  `type="password"`, `autocomplete` `current-password`/`new-password`). Confirmação divergente é erro
  local (`'a confirmação não bate com a senha nova'` em `.erro`), sem chamar o backend; senão
  `chamar('sessao.trocarSenha', { atual, nova })`. A regra de força da senha nova continua sendo do
  backend (`shared/auth.validarSenhaNova`), que é quem a aplica; a página não duplica a regra.
- **Habilitar biometria**: campo de senha local + botão `habilitar biometria` →
  `chamar('sessao.habilitarBiometria', { senha })`; o `EstadoSessao` devolvido é guardado em
  `estado.sessao`, então o painel passa a mostrar "biometria habilitada nesta máquina" (classe `.ok`)
  ou "biometria não habilitada" (`.muted`) conforme `EstadoSessao.biometria`, e a mensagem de sucesso
  segue o mesmo campo (`atualizada.biometria ? 'biometria habilitada' : 'a biometria não ficou
  habilitada nesta plataforma'`).
- **Sua conta**: nome, e-mail e chip `administrador` quando for o caso, direto de `EstadoSessao.pessoa`
  (nenhuma chamada extra).

### 5. `ouvir('sessao')` e sessão bloqueada

`ouvir('sessao', (nova) => aplicarSessao(nova))` no fim do arquivo. `aplicarSessao` grava o estado,
normaliza a aba se ela deixou de ser visível e redesenha + recarrega a aba. Sem pessoa desbloqueada
(`desbloqueada === false`, ou `pessoa === null`), `desenhar()` chama `desenharBloqueada()`, que
substitui todo o conteúdo por um único `<p class="erro">sessão bloqueada</p>` — sem abas, sem
conteúdo, sem botão. O mesmo caminho vale para o push de bloqueio com a janela aberta.

### 6. Erros de tipo corrigidos na origem

Os dois erros que o coordenador obteve por execução de `bunx tsc -p tsconfig.json`:

| Erro | Correção |
| --- | --- |
| `src/admin.ts(211,3): error TS18047: 'app' is possibly 'null'` | o `const app = document.getElementById('app'); if (!app) throw …` virou `function exigirRaiz(): HTMLElement` (checa e lança) + `const raiz = exigirRaiz()`, com tipo não-nulo — a mesma guarda de `src/casca.ts:32-38`. O uso em `desenhar()` passou a ser `raiz.replaceChildren(...)`. Nenhum `!` nem `as`. |
| `src/admin.ts(969,12): error TS2339: Property 'length' does not exist on type 'HTMLDivElement'` | em `itemPessoa`, `papeis` é o `div.linha.papeis` que recebe uma caixa por papel do catálogo; a linha pretendia testar se **há papéis para atribuir**, não o número de filhos do `div`. Passou a `estado.papeis.length > 0`, a mesma condição já usada em `abaPapeis()` (`estado.papeis.length > 0 && estado.catalogo.length > 0`) |

### 7. Botão do rodapé da casca

`src/casca.ts` → `rodapeRail()`: o bloco `if (sessao?.pessoa?.administrador === true)` saiu; o botão
passou a ser `botaoAcao('conta', 'Conta e configurações', () => void abrirJanela('admin'))`, sempre no
rodapé. `renderRail()` só roda com `sessao.desbloqueada`, então o botão aparece exatamente para toda
pessoa desbloqueada, que é o que a §2 diz de `janelas.abrir({ qual: 'admin' })`.

## Superfície a exercitar (limitação declarada: prova só de leitura)

Não houve execução. O caminho que o coordenador precisa exercitar no app:

1. Desbloquear como **administrador** → rail com `⌘K`, `conta`, `bloquear`; `conta` abre a janela
   `admin` com o título "Bond — Admin" e sete abas (Ferramentas, Papéis, Pessoas, Cofre, Conta,
   Auditoria, Catálogo), começando em Ferramentas. Cofre e Conta funcionam como antes e como abaixo.
2. Desbloquear como **não-admin** (pessoa de convite) → mesma janela com título "Bond — Conta" e só
   duas abas (Cofre, Conta), começando em Cofre; nenhuma chamada de admin deve aparecer no registro de
   eventos da auditoria.
3. Aba **Conta**: "trocar senha" com confirmação diferente mostra o erro local e não chama o backend;
   com confirmação igual, a senha muda (bloquear e desbloquear com a nova), os três campos ficam
   vazios e a mensagem "senha local trocada" aparece; com a senha atual errada, o erro vem do backend.
4. Aba **Conta**: "habilitar biometria" com a senha local correta passa a mostrar "biometria
   habilitada nesta máquina"; bloquear e usar "Desbloquear com biometria" na casca deve entrar.
   No Linux o painel mostra o aviso de que não existe biometria, sem botão.
5. Com a janela `admin` aberta, bloquear pela casca → a janela passa a mostrar só "sessão bloqueada";
   desbloquear de novo como não-admin → volta em Cofre com duas abas.

## Decisões e desvios declarados

1. **`h1` acompanha o papel** ("Bond — Admin" / "Bond — Conta"). O despacho pediu o título do
   `admin.html`; manter "Bond — Admin" na tela de quem só tem conta seria contraditório. Se o dono
   preferir um título fixo, é uma linha.
2. **`app.info` na aba Conta.** `EstadoSessao.biometria` significa "disponível **e** habilitada"
   (`shared/types.ts`), então `false` não distingue "não habilitada" de "não existe aqui". Para não
   oferecer um botão que sempre falha no Linux (canonico §9: `app.authenticate` devolve `false`
   sempre), a aba lê `app.info` uma vez e mostra o aviso em vez do formulário quando `os === 'linux'`.
   `app.info` é isento da exigência de sessão desbloqueada na §2 e não é método de admin. A decisão do
   backend continua sendo a que vale: se a chamada for feita e falhar, o erro aparece em `.erro`.
3. **Em falha, os campos de senha ficam preenchidos.** "Limpando os campos depois" foi lido como
   depois do **sucesso**, alinhado ao que `salvarCredencial` já faz e ao aceite ("campos limpos após
   sucesso"). Limpar no erro obrigaria a redigitar três campos por causa de uma confirmação errada.
4. **A regra de força da senha nova não foi duplicada** na página: só a confirmação é erro local, como
   o despacho pede; o mínimo de 8 caracteres continua em `shared/auth.validarSenhaNova`, aplicado por
   quem chama (backend).
5. **`cofre.listar` + `catalogo.listar` continuam na aba Cofre** para não-admin: nenhum dos dois é
   método de admin (§2 lista `catalogo.sondar|salvar|remover|exportar|importar`), e o segundo é o que
   preenche o select de ferramentas do formulário de credencial.
6. **Sem classe CSS nova.** A aba Conta reusa `.painel`, `.coluna`, `.linha`, `.campo`, `.campo-bloco`,
   `.rotulo`, `.botao`, `.botao-primario`, `.ok`, `.muted`, `.aviso`, `.mono`, `.chip` e, para a tela
   bloqueada, `.casca` e `.erro` de `src/style.css`. `src/style.css` e `src/admin.css` não foram
   tocados.

## O que ficou de fora, e por quê

- **Execução de qualquer verificação** (`bunx tsc`, `bun test`, `app:dev`/`app:build`, smoke): o
  despacho da fase proíbe; a verificação é do coordenador, no fim da fase.
- **Exportar/importar o cofre cifrado** (RF-28): já existe na aba Cofre e não fazia parte desta
  fatia — nada foi mudado ali além do gate de aba.
- **Recuperação de senha**: não existe por decisão de canonico §9 (o administrador reemite o acesso);
  a aba Conta não inventa caminho.
- **Credencial de terceiros / rotação pendente**: fora do contrato de API desta fase, como já
  registrado no handover `docs/handovers/fatia-f2-admin.md`.
- **Aprovar, fechar issue, mexer em `_proposto/` ou em `estagio`**: não é desta fatia.

## O que outro dono precisa fazer

- **Dono de `backend/main.ts` (fatia G3)**: a guarda da §2 precisa deixar `sessao.estado`,
  `sessao.trocarSenha`, `sessao.habilitarBiometria`, `cofre.*`, `catalogo.listar`, `papeis.listar` e
  `app.info` passarem para pessoa desbloqueada **sem** exigir `administrador`, e barrar
  `catalogo.sondar|salvar|remover|exportar|importar`, `papeis.salvar|remover|conceder`, `pessoas.*`,
  `convites.emitir`, `eventos.*` e `app.instalarAtualizacao` sem ele. Se algum desses métodos que a
  aba Conta usa exigir admin, a janela de conta de quem não é admin para de funcionar.
- **Dono de `backend/sessao.ts` (fatia G2)**: `habilitarBiometria` precisa devolver o `EstadoSessao`
  com `biometria: true` quando habilitou (é esse campo que a tela mostra) e `trocarSenha` precisa
  validar a senha nova (mínimo 8, `validarSenhaNova`) e a atual, devolvendo erro pt-BR único.
- **Dono de `src/style.css` (fatia F1)**: manter `.casca`, `.erro`, `.painel`, `.campo`,
  `.campo-bloco`, `.botao`, `.botao-primario`, `.linha`, `.coluna`, `.rotulo`, `.ok`, `.aviso`,
  `.mono`, `.chip`, `.vazio` e as variáveis do tema — a janela `admin` inteira depende delas.
- **Quem escrever o smoke (fatia H)**: os passos da seção "Superfície a exercitar" acima, em especial
  a janela `admin` aberta por pessoa não-admin com só duas abas.

## Onde a evidência caiu

Este arquivo é o handover da fatia (`docs/handovers/k2-conta-admin.md`), conforme
`docs/handovers/README.md` e a issue B01.
