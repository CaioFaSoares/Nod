# Fatia F3 — paleta e palco de carregamento

Dono: `FatiaF3Paleta`. Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md` (`em-curso`).
Contrato: `docs/arquitetura.md` §5 (páginas Paleta e Carregando) e o vocabulário de CSS de `src/style.css`.

## Arquivos tocados

- `paleta.html` — criado. Página da janela `paleta`: `lang="pt-BR"`, link `/src/style.css`, `<div id="app">`
  e `<script type="module" src="/src/paleta.ts">`. `<style>` curto só com o layout da paleta (altura cheia,
  campo, lista rolável); classes visuais (`.painel .campo .lista .item .item-ativo .erro .vazio`) vêm do
  vocabulário compartilhado.
- `src/paleta.ts` — criado. Ao abrir, chama `catalogo.listar` e monta, na ordem do catálogo, um item por
  entrada (rótulo = `titulo`) seguido das vistas daquela entrada (rótulo = `<titulo> › <vista.rotulo>`), cada
  item de vista guardando `ferramenta_id` e o índice da vista em `vistas`. Filtro por subsequência sobre o
  rótulo normalizado (NFD, `\p{M}` removido, minúsculo): quem começa com o termo vem primeiro, o resto mantém
  a ordem; termo vazio mostra tudo. Campo de busca com foco (e refocado no `focus` da janela); ↑/↓ movem a
  seleção com `aria-activedescendant` no campo e `scrollIntoView`; Enter executa; Esc fecha; clique no item
  executa igual. Execute de entrada → `rail.trocar({ id })`; de vista → `rail.abrirVista({ ferramenta_id, indice })`;
  em caso de sucesso, `janelas.fechar({ qual: 'paleta' })`. Falha em qualquer passo vira `.erro` com
  `mensagemDeErro`. `ouvir('catalogo', …)` recarrega a lista.
- `carregando.html` — criado. Página do palco de carregamento: `lang="pt-BR"`, link `/src/style.css`,
  `<div id="app">`, script módulo do `src/carregando.ts`. `<style>` curto com o indicador animado discreto
  (um ponto pulsante, desligado em `prefers-reduced-motion`).
- `src/carregando.ts` — criado. Renderiza `abrindo…` antes do primeiro evento. `ouvir('carregando', …)`
  guarda `d.id`; estado `carregando` → título + `abrindo…` com o indicador; estado `falhou` → título +
  `não carregou`, `d.erro` em `.erro` e botão `tentar de novo` que chama `rail.recarregar({ id })`.

## Critério de aceite e como foi atendido

- **Paleta operável só por teclado.** O único elemento focável é o campo de busca, que recebe foco ao abrir
  e a cada `focus` da janela; `keydown` trata ↑/↓/Enter/Esc sem depender de mouse. Os itens são `li role="option"`
  com id `item-<n>`, e o campo publica `aria-activedescendant` — navegável por leitor de tela. Clique existe
  como atalho equivalente, não como caminho único.
- **Enter na vista chama `rail.abrirVista` com o índice certo.** Cada item de vista guarda `indice` = posição
  da vista no array `entrada.vistas` da entrada que a originou; Enter nesse item chama
  `rail.abrirVista({ ferramenta_id: entrada.id, indice })`. Item de entrada chama `rail.trocar({ id })`.
- **Carregando alterna entre os dois estados só pelo evento `carregando`.** Nenhum caminho de código além do
  callback de `ouvir('carregando', …)` altera título, mensagem, `.erro` ou botão; o clique em `tentar de novo`
  só chama `rail.recarregar` e reporta erro, deixando a troca de estado para o próximo evento.

## Como a superfície foi exercida

`leitura`. Esta fatia não executa build, typecheck, linter nem testes (instrução do despacho). Conferido por
leitura: imports sem extensão; `import type` para os tipos de `shared/types.ts`; uso restrito a
`chamar`/`ouvir`/`mensagemDeErro` de `./api`; nenhuma escrita em `src/style.css` nem em arquivo de outra fatia;
`paleta.html` e `carregando.html` referenciados pelo `vite.config.ts` (input `paleta` e `carregando`).

## O que ficou de fora

- Não editei `src/style.css` (dono: fatia F1-casca) nem `vite.config.ts`; a paleta e o palco apenas importam
  `src/style.css` e acrescentam layout no `<style>` próprio, como manda o vocabulário compartilhado.
- Não há animação além do ponto pulsante do indicador; a paleta não ganha transições.
- O tamanho e a posição das duas janelas são do backend (`janelas.abrir`, `modoCasca`), fora desta fatia.
