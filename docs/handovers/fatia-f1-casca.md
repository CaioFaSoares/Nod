# Fatia F1-casca — `index.html`, `src/casca.ts`, `src/style.css`

Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md` (status `em-curso`).
Contrato: `docs/arquitetura.md` §5 (linha "Casca") e §2/§4 no que toca a casca; requisitos
`docs/canonico.md` §7 (rail, paleta, dígitos), §9 (conta, convite, senha local, espera de
desbloqueio), §10 (administrador), §13 (auditoria — nenhum segredo na UI), §14 (RF-19, RF-20, RF-23).
Tipos: `shared/types.ts` (`EstadoSessao`, `EstadoRail`, `SistemaRail`, `ResultadoLogin`,
`ApiContrato`). Cliente: `src/api.ts`.

## Arquivos tocados

- `index.html` (sobrescrito; era o `index.html` do template com `<title>tjprobe</title>` e
  `/src/main.ts`): `<html lang="pt-BR">`, `<title>Bond</title>`,
  `<link rel="stylesheet" href="/src/style.css">`, `<div id="app"></div>`,
  `<script type="module" src="/src/casca.ts"></script>`. Sem o `favicon.svg` do template e sem
  referência a `main.ts` (que não existe em `src/`).
- `src/style.css` (criado): tema escuro sóbrio, fonte monospace
  (`ui-monospace, 'JetBrains Mono', 'IBM Plex Mono', Menlo, monospace`), contraste alto, foco visível
  por `:focus-visible`, `color-scheme: dark`, sem dependência. Variáveis `--fg --muted --bg --surface
  --border --accent --ok --warn --erro` (mais `--raio`, `--fonte`, `--largura-rail = 72px`, igual a
  `LARGURA_RAIL` de `shared/rail.ts`) e o vocabulário compartilhado `.painel .campo .botao
  .botao-primario .botao-perigo .lista .item .item-ativo .abas .aba .aba-ativa .erro .aviso .ok .mono
  .linha .coluna .rotulo .vazio .chip`. Classes do rail: `.rail` (coluna, 72px, `height: 100vh`,
  `overflow-x: hidden`), `.rail-icone` (48×48 com `.ativo`, `.quente`, `.carregando` com
  `@keyframes rail-pulso` desligada em `prefers-reduced-motion`, `.falhou`), `.rail-digito` (badge
  pequena no canto), `.rail-rodape` (rodapé com botões de 10px, sem texto longo). Acréscimos da casca
  no mesmo arquivo: `.casca`, `.casca-cabecalho`, `.casca-titulo`, `.casca-erro`, `.campo-bloco`,
  `.botao-link`.
- `src/casca.ts` (criado): boot, os três estados, rail, atalhos locais. Usa só `chamar`, `ouvir` e
  `mensagemDeErro` de `./api` e os tipos de `../shared/types` (`import type`); não toca em `tiny`,
  `tjs`, `localStorage` nem `console`.
- `docs/handovers/fatia-f1-casca.md` (este arquivo).

## Critério de aceite e como foi atendido

Evidência deste handover: `leitura`. Não executei build, typecheck, linter nem formatador (contrato
do despacho: só escrever; o coordenador verifica no fim da fase).

| Item do despacho | Onde é atendido |
| --- | --- |
| Boot: `chamar('sessao.estado')` e renderiza | `iniciar()` chama `sessao.estado` e passa o resultado a `render()`; falha → `telaErro(mensagemDeErro(e))` |
| `ouvir('sessao', …)` re-renderiza | listener no fim do arquivo: `sessao = novo; render()` |
| `ouvir('rail', …)` re-renderiza o rail | listener: `rail = novo; if (sessao?.desbloqueada === true) renderRail()` (não mexe na tela de desbloqueio nem na contagem) |
| Sem conta (`!tem_conta`) ou criando conta → formulário criar conta | `render()`: `!sessao.tem_conta \|\| criandoConta` → `renderCriarConta()` com nome, e-mail, senha, confirmar senha |
| Campo "código de convite" quando `exige_convite` | `renderCriarConta()` só acrescenta `campo('codigo', 'código de convite', …)` se `sessao.exige_convite`; o valor entra em `params.codigo` (com `trim()`) |
| Confirmação diferente → erro local, sem chamar o backend | no `submit`: `senha.entrada.value !== confirmar.entrada.value` → `erroEl.textContent = 'as senhas não conferem'` e `return`, antes de `criarConta(...)` |
| Envio de criar conta → `sessao.criarConta` | `criarConta()` chama `chamar('sessao.criarConta', params)` com `{ email, nome, senha, codigo? }` |
| Bloqueada: formulário e-mail + senha → `sessao.desbloquear` | `renderDesbloquear()` e `desbloquear()` |
| `biometria` → botão "Desbloquear com biometria" → `sessao.desbloquearBiometria` | botão criado só com `sessao.biometria`; handler chama `desbloquearBiometria()` |
| `espera_ms > 0` → "aguarde N s", envio desabilitado até passar, contagem com `setInterval` | `armarEspera(espera_ms, aviso, enviar)`; `window.setInterval(passo, 1000)` guardado em `contagem`, `window.clearInterval` em `pararContagem()`, chamada em `renderRail`, `renderDesbloquear`, `renderCriarConta` e no catch de `iniciar` (limpa ao sair da tela) |
| Link "tenho um convite" alterna para criar conta quando `tem_conta` | `renderDesbloquear()` acrescenta o botão só se `sessao.tem_conta`; clique faz `criandoConta = true; render()` |
| Erro do backend → `.erro` com `mensagemDeErro(e)` | `erroEl.textContent = mensagemDeErro(e)` em `desbloquear`, `desbloquearBiometria`, `criarConta`; falha de ação do rail vira faixa `.erro.casca-erro` por `falhaRail` |
| Desbloqueada: rail com `chamar('rail.estado')` | `render()` → `renderRail()`; com `rail === null` pede `rail.estado` uma vez (`pediuRail`) em `carregarRail()` |
| Um botão por sistema: `<img>` do `icone` data URI ou 2 primeiras letras do título em `.chip` | `botaoSistema()`: `sistema.icone === null` → `no('span', { class: 'chip' }, [titulo.trim().slice(0,2).toUpperCase()])`; senão `no('img', { src: sistema.icone, alt: '' })` |
| `title` = título + resultado de login quando houver | `const titulo = sistema.login === null ? sistema.titulo : \`${sistema.titulo} · ${ROTULO_LOGIN[sistema.login]}\`` |
| Badge do dígito e classes de estado | `no('span', { class: 'rail-digito' }, [String(sistema.digito)])` quando `digito !== null`; classes `ativo`, `quente`, `carregando`, `falhou` conforme `SistemaRail` |
| Clique → `rail.trocar({id})` | `botaoSistema` → `trocar(sistema.id)` → `chamar('rail.trocar', { id })` |
| Rodapé: '⌘K' → `janelas.abrir({qual:'paleta'})` | `rodapeRail()` → `botaoAcao('⌘K', …)` → `abrirJanela('paleta')` |
| Rodapé: 'admin' só se `pessoa.administrador` → `janelas.abrir({qual:'admin'})` | `if (sessao?.pessoa?.administrador === true)` antes de acrescentar o botão; `abrirJanela('admin')` |
| Rodapé: 'bloquear' → `sessao.bloquear` | `botaoAcao('bloquear', …)` → `bloquear()`: chama `sessao.bloquear`, zera `rail`/`pediuRail`/`erro`/`criandoConta` e re-renderiza |
| `⌘/Ctrl+K` abre a paleta na própria página | `keydown`: `(metaKey \|\| ctrlKey)`, sem alt/shift, `ev.key === 'k'` → `preventDefault()` + `abrirJanela('paleta')` |
| `⌘/Ctrl+1..9` chama `rail.trocar` do sistema daquele dígito | `keydown`: tecla `1`..`9` → procura `rail.sistemas.find(s => s.digito === digito)` → `trocar(sistema.id)` |
| Acessível: botões com `aria-label`, `aria-pressed` no ativo | `.rail-icone` com `aria-label` (título, ou `título — falhou: …`) e `aria-pressed`; botões do rodapé com `aria-label` descritivo ('Abrir a paleta de ferramentas', 'Abrir o painel de administração', 'Bloquear a sessão'); links-botão com `aria-label` mais claro que o texto curto |

### Aceite do despacho

| Aceite | Onde é atendido |
| --- | --- |
| Os três estados renderizam do `EstadoSessao` sem recarregar a página | `render()` despacha por `sessao.desbloqueada` / `tem_conta` / `criandoConta` e é chamado pelo push `sessao` (e pelo retorno de cada ação); o rail vem do push `rail`. Nenhum `location`/`reload` no arquivo |
| Nenhum segredo vai para `localStorage`/console | nenhuma chamada a armazenamento do navegador, `console` ou `document.title` no arquivo (só um comentário dizendo isso); `senha` e `codigo` existem apenas como valor de `<input>` e como parâmetro de `chamar(...)`, e são descartados com o formulário no `render()` seguinte |
| Só métodos existentes em `ApiContrato` são chamados | chamadas: `sessao.estado`, `sessao.criarConta`, `sessao.desbloquear`, `sessao.desbloquearBiometria`, `sessao.bloquear`, `rail.estado`, `rail.trocar`, `janelas.abrir` — todas em `ApiContrato` (`shared/types.ts:261-313`) |
| NÃO rodei build, typecheck nem formatador | nenhum comando executado nesta fatia |

## Comando e resultado

Nenhum. Evidência desta fatia é `leitura`, conforme o contrato ("NÃO rode testes, typecheck, linter
nem formatador. Só edite.").

Comandos que o coordenador deve rodar no fim da fase: `bunx tsc -p tsconfig.json` (cobre `src/` e
`shared/`), `bun run dev` + abrir `http://127.0.0.1:5173/` para os três estados, e o smoke em
`test/smoke/`. A prova de interface de verdade (janela em modo `desbloqueio` 420×560 e em modo `rail`
72px) depende do `backend/main.ts`, de `backend/palcos.ts` e do `tinyjs dev`, que não são desta fatia.

## O que ficou de fora (e por quê)

- **Habilitar biometria e trocar senha** (`sessao.habilitarBiometria`, `sessao.trocarSenha`): a linha
  "Casca" da §5 do contrato pede só criar conta, desbloquear (senha e biometria) e rail; os outros
  dois fluxos não têm casa definida no despacho nem tela pedida aqui.
- **Paleta, painel de admin e palco de carregamento** (`paleta.html`, `admin.html`,
  `carregando.html`): outras fatias; a casca só os abre por `janelas.abrir`.
- **Testes automatizados da casca**: o despacho não os pede e o contrato manda não executar nada; a
  superfície é DOM + `tiny.api`, sem seam puro. A prova fica no smoke do coordenador.
- **Rótulo do atalho fixo em '⌘K'**: o texto do botão é o do despacho; fora do macOS o combo real é
  `ctrl+k` (`shared/rail.combo`), decidido no backend.
- Sem dependência nova, sem troca de runtime, sem tocar em arquivo de outro dono
  (`shared/types.ts`, `src/api.ts`, `vite.config.ts`, `package.json` ficaram como estavam).

## Desvios / decisões que o coordenador deve conferir

- Acréscimos ao vocabulário CSS dentro do arquivo que é meu: `.campo-bloco` (label em coluna),
  `.botao-link` (link-botão), `.casca`, `.casca-cabecalho`, `.casca-titulo`, `.casca-erro` (faixa de
  erro do rail, com `overflow-wrap: anywhere` porque a janela do rail tem 72px).
- Botão **"já tenho conta"** na tela de criar conta, mostrado só quando `tem_conta`: é o inverso do
  link "tenho um convite" pedido, para ninguém ficar preso na tela de criar conta. Se o dono não
  quiser, é uma linha para remover.
- `⌘K`/`⌘1..9` com o foco na casca chamam a API local **e** o backend também dispara o atalho global
  (a janela do Bond está focada); as duas chamadas convergem no mesmo estado (`rail.trocar` é
  idempotente e `janelas.abrir` abre a mesma janela).
- Botões de texto cheio ("Desbloquear", "Criar conta") usam o próprio texto como nome acessível; o
  `aria-label` ficou onde o texto é curto ou icônico.

## O que outro dono precisa fazer

Nada bloqueia esta fatia. Quem consome `src/style.css` (`src/admin.ts`, `src/paleta.ts`,
`src/carregando.ts`) usa as classes do vocabulário compartilhado sem redefini-las e acrescenta o que
for seu no próprio CSS; `admin.html`, `paleta.html` e `carregando.html` continuam sendo dos donos das
fatias F2/F3.
