# Fatia F2 — painel de admin

Dono: fatia F2 (janela `admin`). Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md`
(`em-curso`). Contrato: `docs/arquitetura.md` §5; requisitos: `docs/canonico.md` §7 a §14, §19.

## Arquivos tocados

| Arquivo | O que mudou |
| --- | --- |
| `admin.html` | criado: `lang="pt-BR"`, título `Bond — Admin`, `link` para `/src/style.css` e `/src/admin.css`, `<div id="app">`, `<script type="module" src="/src/admin.ts">` |
| `src/admin.ts` | criado: as seis abas do painel (Ferramentas, Papéis, Pessoas, Cofre, Auditoria, Catálogo), só por `chamar`/`ouvir`/`mensagemDeErro` de `./api` |
| `src/admin.css` | criado: só o que é desta página (cabeçalho, tabelas, grade de concessões, linhas que quebram, tons de chip). O tema e o vocabulário vêm de `src/style.css`, que não foi tocado |
| `docs/handovers/fatia-f2-admin.md` | criado: este handover |

Nada mais foi tocado: `src/style.css`, `src/api.ts`, `shared/types.ts` e os arquivos das outras
fatias ficaram como estavam.

## Evidência: `leitura`

Não executei nada — nem testes, nem typecheck, nem bundler, nem o app (o despacho da fatia proíbe).
Toda linha abaixo é **leitura** do código que escrevi contra o contrato lido
(`docs/arquitetura.md` §3–§5, `shared/types.ts`, `docs/canonico.md` §8–§14) e contra as fontes
citadas. Nada aqui é chamado de verificado.

## Critério de aceite e como cada item foi atendido

### 1. Cada aba chama só métodos de `ApiContrato` com os parâmetros tipados de `shared/types.ts`

Leitura do arquivo: todas as chamadas passam por `chamar()` de `src/api.ts`, com os nomes de
`ApiContrato` e o objeto de parâmetros do tipo declarado lá.

| Aba | Métodos chamados |
| --- | --- |
| Ferramentas | `catalogo.listar`, `catalogo.sondar` `{endereco}`, `catalogo.salvar` `{entrada, icone?}`, `catalogo.remover` `{id}`, `rail.trocar` `{id}`, `papeis.listar` |
| Papéis | `papeis.listar`, `papeis.salvar` `{papel}`, `papeis.remover` `{id}`, `papeis.conceder` `{papel_id, ferramenta_id, concedido}`, `catalogo.listar` |
| Pessoas | `pessoas.listar`, `pessoas.atribuirPapeis` `{pessoa_id, papeis}`, `pessoas.revogar` `{pessoa_id, apagar_credenciais}`, `convites.emitir` `{papeis, dias}`, `papeis.listar` |
| Cofre | `cofre.listar`, `cofre.salvar` `{ferramenta_id, usuario, segredo, rotulo?}`, `cofre.revelar` `{ferramenta_id}`, `cofre.remover` `{ferramenta_id}`, `cofre.exportar` `{senha}`, `cofre.importar` `{blob, senha}`, `catalogo.listar` |
| Auditoria | `eventos.listar` `FiltroEventos`, `eventos.exportar`, `catalogo.listar`, `pessoas.listar` |
| Catálogo | `catalogo.exportar`, `catalogo.importar` `{json}`, `app.info`, `app.atualizacao`, `app.instalarAtualizacao` |

Nenhum `tiny.api.call` direto, nenhum `import` de `tjs`/`tiny`, nenhum acesso a rede pela página.
O único import de fora de `src/` é `import type … from '../shared/types'` e `slug` de
`../shared/catalogo` (ver "Decisões").

### 2. O código de convite e a senha revelada não ficam visíveis depois de sair da aba / 10 s

- Convite: `emitirConvite()` guarda o retorno em `estado.convite` e o desenha uma única vez num
  campo `readOnly` com botão `copiar` (`navigator.clipboard.writeText`) e o aviso "guarde agora: este
  código não aparece de novo". `trocarAba()` zera `estado.convite` **antes** de redesenhar, então o
  código sai da tela em qualquer troca de aba; como `desenhar()` reconstrói o conteúdo, ele não
  sobrevive a nenhum outro caminho de renderização. Nada do código vai para `localStorage`, para o
  `console` nem para outro estado.
- Senha revelada: `revelar()` grava `estado.revelado` e arma `setTimeout(…, 10_000)` que zera o
  estado e redesenha; `esconderRevelado()` cancela o temporizador e limpa o estado ao trocar de aba e
  ao remover a credencial. O botão vira "esconder" enquanto o valor está na tela.

### 3. Superfície exercitada

Só **leitura**, como declarado acima — não houve execução. O caminho que o coordenador precisa
exercitar quando rodar o app (janela `admin`, aberta pelo botão Admin da casca com pessoa
desbloqueada e `administrador = true`):

1. **Ferramentas** → "Nova ferramenta" → colar `https://kanban.copland.studio` → "sondar": espero o
   formulário com título, id (`slug` do título), ícone (preview `data:image/svg+xml;base64,…` ou
   `data:image/png;base64,…`) e a linha "sonda: tem formulário de login" / "sonda: redireciona para
   <provedor>" / "sonda: sem login detectado"; "salvar" fecha o formulário e a entrada aparece na
   lista com papéis, vistas e chip ativa/inativa. "editar" reabre o mesmo formulário, sem sondar, com
   o botão "sondar de novo". "abrir" chama `rail.trocar`. "remover" pede confirmação.
2. **Papéis** → criar com nome ("Financeiro" → id `financeiro`), renomear, remover (com `confirm`); a
   grade papel × ferramenta marca e desmarca por `papeis.conceder`.
3. **Pessoas** → marcar/desmarcar papéis (`pessoas.atribuirPapeis`), "emitir convite" com papéis e
   dias (padrão 7): o código aparece uma vez, "copiar" copia, trocar de aba o remove da tela;
   "revogar" com a caixa "apagar credenciais do chaveiro".
4. **Cofre** → escolher ferramenta no select de `catalogo.listar`, usuário, senha, rótulo → salvar
   (a senha do campo é limpa no sucesso); "revelar" mostra usuário e senha e esconde em 10 s;
   "remover" apaga; "exportar cofre" baixa `bond-cofre.txt`; "importar cofre" pede arquivo e senha e
   mostra quantos itens entraram.
5. **Auditoria** → tabela com em, pessoa, ferramenta, tipo, resultado, url; filtros de ferramenta e
   resultado; "exportar jsonl" baixa `bond-eventos.jsonl`.
6. **Catálogo** → versão do app, do seed e do SO (`app.info`); "verificar atualização" mostra
   disponível/atual e, quando `available`, aparece "instalar"; "exportar seed" baixa `seed.json`;
   "importar seed" mostra as contagens devolvidas por `catalogo.importar`.

O evento `catalogo` (push) chama `carregarAba()`, que relê as listas da aba corrente.

## Decisões e desvios declarados

1. **`slug` vem de `shared/catalogo`, não é reimplementado aqui.** O id sugerido do título (também
   usado no id de papel novo) usa `slug()` do módulo puro da fatia B: uma regra, uma casa. Se o
   coordenador preferir a página sem dependência de `shared/`, é trocar três chamadas por uma cópia
   local.
2. **Editar sem tocar no ícone não envia `icone` em `catalogo.salvar`.** Envio o campo só quando o
   admin escolheu um ícone novo (sonda ou arquivo) ou removeu o ícone (`icone: null`). Confirmado do
   lado do repositório (resposta da fatia E, `leitura` de `backend/repo.ts`): `salvarEntrada(e,
   extras)` decide por **presença da chave** (`'icone_hash' in extras`), provado pelo teste
   `catálogo › icone_hash e sonda só mudam quando vêm em extras` em `test/repo.test.ts`. **O que falta
   é o handler de `backend/main.ts` (outra fatia) mapear ausência do parâmetro em ausência da chave**:
   `repo.salvarEntrada(e, { icone_hash: params.icone ?? null })` transformaria ausência em `null` e
   **apagaria** o ícone ao editar.
3. **Preview do ícone de entrada já salva depende da montagem de `catalogo.listar`.** A fatia E
   confirma que `Entrada.icone` sai sempre `null` de `repo.entrada`, `repo.listarEntradas` e
   `repo.salvarEntrada` (arquitetura §4). Para o preview aparecer, quem monta a resposta de
   `catalogo.listar` precisa preencher `icone` com `icones.dataUri(repo.iconeHash(id))`
   (`backend/icones.ts`). Sem isso, a lista e o formulário de uma entrada existente ficam sem a
   imagem atual — salvar continua preservando o ícone gravado (item 2); com isso, o preview aparece
   sem nenhuma mudança nesta fatia.
4. **Upload de ícone é lido no cliente** como bytes → base64 (`arquivo.arrayBuffer()` +
   `btoa`), sem `FileReader`, e o tipo sai do MIME do arquivo (PNG, SVG, JPEG, WebP); formato fora
   dessa lista dá erro em `.erro`. O tipo `svg` vira `svg+xml` no data URI.
5. **Filtro de resultado na auditoria** é um select montado com os valores que apareceram nos
   eventos carregados sem filtro de resultado (`Evento.resultado` é `string | null`, sem enum no
   contrato). Filtrar não apaga a lista de valores já vistos; ela só cresce.
6. **Classes novas só no `src/admin.css`**: `.muted`, `.chip.ok`, `.chip.warn`, `.linha > .campo-bloco`,
   `.conteudo .linha`, `.conteudo .item.coluna`, `.curta`, `.opcao`, `.papeis`, `.icone`,
   `.codigo-convite`, `.vistas`, `.grade`, `.tabela`, `.centro`, `.coluna-url`, `.revelado`,
   `.cabecalho`, `.mensagens`, `.conteudo`. Nenhuma delas existe em `src/style.css`; `.muted` usa a
   variável `--muted` do tema. `src/style.css` não foi editado.
7. **`app.instalarAtualizacao` devolve `boolean`**: a página ignora o valor e mostra sucesso se a
   promessa resolver, erro em `.erro` se rejeitar.
8. **`navigator.clipboard.writeText`** pode falhar (permissão/contexto): a falha vira a mensagem
   "não foi possível copiar; selecione o código e copie à mão" em `.erro`.

## O que ficou de fora, e por quê

- **Testes automatizados desta fatia.** Não há teste de página no repositório (o `bun test` cobre
  `shared/` e o repositório), e o despacho manda não executar nada; a prova da interface é a
  janela real, que é do passo de integração do coordenador.
- **"Cofre de terceiros"** (canonico §12: cadastrar credencial de outra pessoa, marcar rotação
  pendente) **não está no contrato de API** desta fase: `cofre.*` é sempre "a credencial da própria
  pessoa" (`docs/arquitetura.md` §4). Fica para quando existir método para credencial de terceiro.
- **Origem do catálogo (local / `host:<id>`)** não aparece em nenhum método de `ApiContrato`
  (`app.info` só traz versão, seed e SO); o painel mostra o que o contrato oferece.
- **Aprovar, fechar issue, mexer em `estagio`/`_proposto/`**: não é desta fatia.
- **`src/style.css`, `src/api.ts`, `shared/types.ts`**: arquivos de outros donos; não foram tocados.

## O que outra fatia precisa fazer

- **Dono de `backend/main.ts` (API)**: no handler de `catalogo.salvar`, mapear **presença** do
  parâmetro em presença da chave do extra — só incluir `icone_hash` em `extras` quando
  `params.icone !== undefined` (`null` explícito limpa, hash troca, ausente preserva). Escrever
  `{ icone_hash: params.icone ?? null }` apaga o ícone toda vez que alguém edita sem trocar o ícone.
  E, em `catalogo.listar`, preencher `Entrada.icone` com `icones.dataUri(repo.iconeHash(id))`
  (`null` quando não há ícone), senão o painel não mostra o ícone atual.
- **Fatia E (repo)**: sem pendência — a semântica de presença está confirmada e provada por
  `test/repo.test.ts` (`catálogo › icone_hash e sonda só mudam quando vêm em extras`).
- **Fatia B (`shared/catalogo`)**: `slug` é usado como está; qualquer mudança de assinatura quebra
  `src/admin.ts` (uma linha de import).
- **Fatia F1 (casca)**: `style.css` precisa manter `.painel .campo .campo-bloco .botao
  .botao-primario .botao-perigo .abas .aba .aba-ativa .lista .item .chip .linha .coluna .rotulo
  .erro .aviso .ok .mono .vazio` e as variáveis `--fg --muted --bg --surface --border --accent --ok
  --warn --erro`, que esta página consome.
- **Integração**: a janela `admin` já é entrada do `vite.config.ts` (multipágina) e é aberta por
  `janelas.abrir {qual: 'admin'}`, que é da casca.

## Onde a evidência caiu

Este arquivo é o handover da fatia (`docs/handovers/fatia-f2-admin.md`), conforme
`docs/handovers/README.md` e a issue B01.
