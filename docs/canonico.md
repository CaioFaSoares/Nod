# Nod — documento canônico

Out 15, 2026 · @Caio

Base de requisitos da casca de ferramentas internas de um time. Este documento é a fonte única do
escopo, dos requisitos e das decisões propostas. Fatos do runtime ficam em `docs/tinyjs.md`;
o corte da Carna fica em `docs/downscale-carna.md`. Nada aqui repete esses dois.

Toda afirmação sobre o que existe carrega caminho ou URL, e toda afirmação sobre o que funciona diz
como foi obtida. Nada aqui foi obtido por execução: é `leitura` de documentação e de código.

## 1. Visão e princípios

O Nod é a casca que uma pessoa abre para chegar às ferramentas internas: Affine, Kanban,
webmail, o Discord da tropa e o que mais entrar. O administrador cadastra cada ferramenta com ícone e
papéis; a pessoa navega por elas num ambiente só, com credenciais guardadas no chaveiro do sistema.

Princípios:

1. **A ferramenta é dado, não código.** Cadastrar uma ferramenta não recompila o Nod. O catálogo é
   um arquivo versionado, editado na própria casca.
2. **A casca é fina.** Ela não hospeda o conteúdo das ferramentas: abre cada uma na própria página,
   numa janela própria. Nada de proxy, nada de reimplementar as ferramentas.
3. **Offline primeiro.** Catálogo, papéis, concessões, cofre, auditoria e o painel de admin
   funcionam sem servidor nenhum. As ferramentas continuam exigindo rede — isso é do site, não do
   Nod.
4. **Segredo fica onde o sistema guarda segredo.** O padrão é o chaveiro do sistema operacional
   (Keychain, Credential Manager, Secret Service); o banco local e o `store.json` guardam índice e
   ponteiros, nunca valores. Autenticar uma vez abre a sessão inteira.
5. **Um fato, uma casa.** O que é do runtime mora em `docs/tinyjs.md`; o que é da Carna mora em
   `docs/downscale-carna.md`.
6. **Sem código de terceiros dentro.** O Nod não tem sistema de extensões: ele cadastra endereços.
7. **Escopo fino.** Nada entra no v1 sem uma linha de requisito aqui. O que não está na lista é
   próxima sprint — hoje isso inclui hospedar a casca em `nod.example.com` e as abas por iframe.

## 2. Escopo

Dentro:

- Casca multiplataforma (macOS 15+, Windows 10/11, Linux glibc 2.35+) que roda como app de desktop.
- Catálogo cadastrado pelo administrador: título, endereço, ícone, vistas, papéis.
- Navegação por paleta e por janelas de ferramenta, com sessão de login preservada por ferramenta.
- Identidade local: conta por pessoa, criada por convite, com papéis.
- Cofre de credenciais por pessoa e por ferramenta, no chaveiro do sistema, com preenchimento
  automático do login onde houver adaptador.
- Auditoria local em eventos exportáveis.
- Distribuição: build por sistema, manifesto de atualização, ícone e identidade do app.

Fora (não-objetivos do v1):

- Ser navegador: não há barra de endereço livre. Só o catálogo abre janelas de ferramenta.
  **Relaxed on 2026-10-16** (owner: "abrir link no bond e/ou salvar link novo na barra lateral mais
  rápido"): any `http(s)` link may open in an ad-hoc tab and be saved to the sidebar
  (`docs/epics/E03-docked-tabs.md` §5). Still no history, bookmarks bar or extensions.
- Ser provedor de identidade: SSO/OIDC por ferramenta é fase posterior, com o host.
- Ser VPN ou túnel: quem exige rede privada resolve isso fora do Nod.
- Ser gerenciador de senhas: o cofre guarda credenciais **das ferramentas cadastradas**, não um
  cofre pessoal com gerador e histórico.
- Hospedar código de terceiros: sem extensões, plugins ou scripts baixados.
- Editar conteúdo: nenhum editor, nenhuma base de conhecimento, nenhum agente.
- Isolar duas identidades da mesma ferramenta na mesma máquina: um app tem um perfil de cookies só
  (`docs/tinyjs.md` §3).

Adiado para a próxima sprint, por decisão do dono (2026-10-15): mapear `nod.example.com` e as
abas por iframe. Só volta quando hospedar algo além das regras do sistema virar atrativo — e aí
deixa de ser casca fina (§23, questão 11).

## 3. Vocabulário

Os termos canônicos — casca, ferramenta, endereço, vista, entrada, catálogo, papel, concessão,
cofre, chaveiro, evento, adaptador de login — estão em `CONTEXT.md`. Termo novo entra lá primeiro.

## 4. Ferramentas conhecidas hoje

Inventário do que o dono citou. É conteúdo do catálogo, cadastrado pelo administrador; esta tabela
registra o ponto de partida, não é uma lista que o código conheça.

| Entrada | Endereço | Produto | OIDC | Situação |
| --- | --- | --- | --- | --- |
| Affine | `https://affine.example.com` | Affine (documentos e notas) | a confirmar | citado pelo dono; produto a confirmar |
| Kanban | `https://kanban.example.com` | Planka (kanban) | a confirmar | citado pelo dono |
| Webmail | `https://mail.example.com` | cliente web de e-mail | a confirmar | produto a confirmar |
| Discord | `https://discord.com/...` | Discord — terceiro, fora do nosso domínio | não (conta Discord) | citado pelo dono; risco em §20 |
| Demais | — | — | algumas sim, não todas (dono, 2026-10-15) | a cadastrar |

## 5. Herança e corte da Carna

O Nod é um downscale da Carna. O que é herdado (identidade, convite, token, papéis, concessão,
auditoria, o desenho de host) e o que fica de fora (Postgres, Oban, Hocuspocus, LiveKit, cofre E2E,
Ash, Dockview, base de conhecimento, agentes, iOS, terminal) está em `docs/downscale-carna.md`, com
caminho de cada peça citada.

## 6. O que o runtime permite e proíbe

`docs/tinyjs.md` é a casa dos fatos. As quatro consequências que moldam este documento:

1. **Não há abas nativas e não há como compor sites de terceiros numa página.** O modelo é
   multi-janela; `win.open` abre `page` como URL `http(s)` ou página local (`docs/tinyjs.md` §2, §3).
2. **Não há servidor HTTP.** Um host Elixir só entra como serviço externo, consumido pelo backend do
   app (§18).
3. **Um app tem um só perfil de cookies.** Duas identidades da mesma ferramenta exigiriam dois apps.
4. **Site remoto não é empacotável offline.** "Offline" vale para a casca, nunca para a ferramenta.

## 7. Modelo de janelas: uma janela para gerenciar e usar

Decisão do dono, 2026-10-15: "quero que não tenha uma janela separada para os ícones da moldura, e
seja tudo em uma janela só para o lado de gerenciar/usar, aí abrimos as janelas a partir daí". Ela
substitui o desenho anterior de rail ancorado + palcos encostados (que tinha, além disso, a moldura
dimensionada errado — observado por execução: a barra de título somava altura e o palco vazava da
tela, e o launcher não respeitou `x`/`size` do `win.open`).

**Evolution decided on 2026-10-16**: the docked view becomes the default. Tools open as tabs shown
over the main window's center panel, several tabs per tool, detachable without reload, with links
from inside a tool opening as tabs next to it. What follows describes today's behavior, which stays
as the **Windows** mode. Design and spikes: `docs/epics/E03-docked-tabs.md`.

| Peça | O que é |
| --- | --- |
| **Janela principal** (`main`) | A única janela do Nod para gerenciar e usar: moldura nativa, redimensionável. À esquerda, a **sidebar** com um ícone por ferramenta permitida (dígito, estado: aberta, carregando, falhou) e, no rodapé, Settings e Lock. À direita, o conteúdo: **Home** (cartões das ferramentas, com abrir, vistas, fechar e o resultado de login) ou **Settings** (conta, cofre e, para o admin, ferramentas, papéis, pessoas, auditoria, catálogo). A tela de entrada (criar conta, entrar, convite, Touch ID) também vive nela. |
| **Paleta** (`⌘K`) | Overlay dentro da janela principal: busca ferramentas, vistas e ações (Home, cada aba de Settings, Lock, Quit). |
| **Janela de ferramenta** | Cada ferramenta abre numa janela própria, com moldura nativa, independente, aberta a partir da janela principal. Clicar de novo numa ferramenta já aberta só a traz para a frente — sem recarregar. |

Regras:

- **Nada de iframe**: as ferramentas mandam `X-Frame-Options`/CSP, e no Linux o carimbo de origin do
  gate `api` é frame-blind (`docs/tinyjs.md` §9).
- **Vista** é um endereço nomeado dentro de uma ferramenta, com modo `window` (janela própria — o caso
  de boards) ou `navigate` (navega a janela já aberta da ferramenta — o caso de pastas de e-mail; se
  ela não estiver aberta, abre direto no endereço da vista).
- **Estado de carregamento e falha** aparecem na sidebar e no cartão da ferramenta na Home, com
  "try again"; nenhuma janela extra de carregamento.
- **Atalhos**: `⌘1`…`⌘9` abrem/trazem a ferramenta do dígito, `⌘K` abre a paleta, `⌘,` Settings. Na
  janela principal funcionam pela própria página; nas janelas de ferramenta, o teclado é do site, então
  os mesmos atalhos são registrados como **globais** (`tiny.hotkey.register`) **só enquanto alguma
  janela do Nod está focada** — registrados o tempo todo, roubariam `⌘1` e `⌘K` de outros apps. Se o
  sistema pedir permissão de acessibilidade, isso entra no passo de instalação — a confirmar por
  execução.
- **Restauração**: as janelas de ferramenta abertas são lembradas e reabertas no próximo desbloqueio,
  só as que a pessoa ainda pode ver.
- **Fechar a janela principal** a esconde quando há bandeja (`Open Nod`, `Lock`, `Quit Nod`); as
  janelas de ferramenta continuam abertas. Sem bandeja (Linux sem AppIndicator), fechar encerra o app.
- **Bloquear** fecha todas as janelas de ferramenta e os popups que elas abriram.

## 8. Catálogo

Dado local, versionado, editado em Settings → Tools. Formato (o app é em inglês, então as chaves
também; o modelo exato está em `shared/types.ts`):

```json
{
  "version": 3,
  "generatedAt": "2026-10-15T18:00:00Z",
  "roles": [{ "id": "team", "name": "Team", "admin": false }],
  "entries": [
    {
      "id": "kanban",
      "title": "Kanban",
      "url": "https://kanban.example.com",
      "icon": "icons/kanban.png",
      "order": 10,
      "roles": ["team"],
      "views": [
        { "label": "Sprint", "url": "https://kanban.example.com/boards/42", "mode": "window" }
      ],
      "auth": null,
      "active": true
    }
  ],
  "invites": [],
  "update": null
}
```

- **O gate de origin é fixo e mínimo**: cada origin exata de entrada do seed só pode chamar
  `login.report`; as páginas do próprio Nod (`file://*`) têm a API toda. O campo `api` por entrada
  saiu na v2: o backend recusa qualquer outro método vindo de janela de ferramenta, então a lista
  não teria efeito. Ferramenta cadastrada depois da release funciona, mas só relata o resultado de
  login quando a próxima release a incluir no seed — Settings → Tools avisa (`AppInfo.gateOrigins`).
- **Camera and microphone (owner, 2026-10-16).** Org tools — the entries of the release seed —
  get camera and microphone without a prompt (`media.camera`, `media.microphone` on their exact
  origin). Any other origin keeps the engine's own prompt (macOS, Windows) or is denied (Linux),
  and the Nod warns when a link didn't come from the org. The release always declares the
  camera and microphone usage strings: macOS kills an app that captures without them, and the
  build refuses a `tinyjs.base.json` without them (`scripts/gen-config.ts`).
- **Não existe escolha de auth por ferramenta.** Decisão do dono em 2026-10-15: "acredito que OIDC
  todos têm… quero não ter que ficar sabendo desses ou não". A casca faz sempre a mesma coisa, na
  ordem, e para no primeiro passo que resolver (**cascata de login**, §11):

  1. **Já tem sessão?** Os cookies daquela origin valem no perfil do app: abre logado e acabou.
  2. **Tem formulário de login?** O adaptador genérico preenche usuário e senha do cofre e envia.
  3. **Redireciona para um provedor de identidade?** Segue o fluxo do próprio site (o provedor
     pergunta, ou já conhece a pessoa pela sessão do navegador/webview) — a casca não guarda
     credencial nenhuma para essa ferramenta.
  4. **Nada disso:** a página aparece como está, e o cartão da ferramenta na Home oferece ver e copiar a credencial
     do cofre.

  O campo `auth` na entrada é **opcional e é só override**: `{ "noFill": true }` onde o autofill
  atrapalha. Sem `auth`, não há nada a decidir nem a saber.
- **Cadastro assistido**: o administrador cola o endereço e a casca faz o resto — busca o título da
  página e o ícone (`apple-touch-icon`, `<link rel=icon>`, `og:image`), e **sonda** a página para
  saber se há formulário de login e se ela redireciona para um provedor. O que a sonda achou fica
  registrado na entrada; o administrador só confirma. Ícone enviado à mão continua possível. ICO fica
  de fora: não há decodificador de imagem no runtime.
- **`popups` e `downloads` são chaves do app, não da entrada** (`docs/tinyjs.md` §2): o padrão vive
  no `tinyjs.json` e o refino por ferramenta acontece nos hooks do backend — `onWindowOpen` decide
  por origin entre `window`, `external` e `deny`, e `onDownload` registra o que aconteceu. Isso
  importa para o webmail (anexo e "abrir em nova janela") e para o Discord (OAuth).
- **Ícones** ficam no diretório de dados do app, com hash no nome; a página da casca recebe o ícone
  por RPC (data URI), para não depender de `readAccess`. No cadastro, o backend busca
  `apple-touch-icon`, os `<link rel=icon>` ou `og:image` da própria página (o backend não tem CORS —
  `docs/tinyjs.md` §6) ou aceita um arquivo enviado pelo administrador. ICO fica de fora: não há
  decodificador de imagem no runtime.
- **O catálogo nasce de um seed privado**, um arquivo que fica fora do git e é embutido na release
  (§19). O seed traz entradas, papéis e concessões; o banco local recebe isso no primeiro boot e
  passa a valer por si. Atualizar depois é importar um seed novo (RF-13) ou receber do host (RF-18).
- **Toda entrada carrega a origem do seu endereço.** Concessão é por entrada; nada de conceder
  ferramenta por prefixo de URL.
- **Quem edita o catálogo local tem o poder do catálogo.** Enquanto não houver host, o arquivo não é
  assinado (§23).

## 9. Identidade, contas e convites

Herdado da Carna, reduzido ao que a casca precisa:

- A primeira conta de uma casca é o **administrador** — **só quando o seed não traz convites**: é a
  máquina do próprio administrador. As demais nascem com os papéis que o convite concedeu
  (`Carna/apps/api/lib/carna/accounts/changes/registration_rule.ex`).
- O **convite** é um código aleatório de 32 bytes url-safe, de uso único, com validade de 7 dias; o
  banco guarda SHA-256, e o código em claro aparece uma única vez
  (`Carna/apps/api/lib/carna/accounts/invite.ex`).
- **Convite entre máquinas, sem host**: o administrador emite o convite na casca dele, exporta o
  catálogo (RF-13) e o hash do convite entra no seed da próxima release. Na máquina da pessoa, a casca
  aceita o código cujo hash está no seed. O uso único vale por máquina — sem host não há como saber
  que o mesmo código foi usado em outra; limite aceito até a F5.
- **Senha local existe no v1** (decisão do dono, 2026-10-15). É a senha padrão de um serviço: um
  hash no banco local, uma tela de entrada, e pronto. O desbloqueio é digitar essa senha, e a
  biometria é atalho onde existe (`app.authenticate` no macOS e no Windows; **no Linux a chamada
  sempre devolve `false`** — `docs/tinyjs.md` §6 —, então lá o caminho é sempre a senha).
  - Hash: PBKDF2-HMAC-SHA256, salt de 16 bytes por conta, parâmetros guardados junto do hash
    (iterações na casa de 600 000, ajustáveis por medição). PBKDF2 é nativo no runtime —
    `saghul/txiki.js:src/js/polyfills/crypto/kdf.js` —, então não há dependência externa.
  - **Autenticar e pronto**: uma autenticação abre a sessão inteira. Não existe segundo portão, nem
    "desbloquear o cofre" como passo separado — as credenciais das ferramentas vêm do chaveiro
    (§11) já na sessão autenticada.
  - Erro único no desbloqueio, com espera crescente depois de tentativas seguidas (mesmo cuidado da
    Carna em `Carna/apps/api/lib/carna_web/rate_limit.ex`).
  - Trocar a senha reescreve o hash; nada mais depende dela. Se existir um export cifrado opcional
    (§11, RF-28), ele é regerado. Não existe recuperação da senha: sem ela e sem biometria, o
    administrador reemite o acesso e as credenciais das ferramentas.
- A pessoa pode ter mais de um **papel**; a visibilidade é a união das concessões dos seus papéis.
- Quando o **host** existir (§18), a conta ganha senha no host, e o token bearer (14 dias,
  revogável, como na Carna) vive no chaveiro.

## 10. Papéis, concessões e visibilidade

- `papel` é um nome (`administrador`, `time`, `financeiro`) e um conjunto de concessões.
- `concessão` liga um papel a uma entrada do catálogo. É a espinha da visibilidade, como a
  membership de projeto é a espinha das permissões na Carna
  (`Carna/docs/Documento canônico …`, §Organização).
- O administrador enxerga tudo e é o único que edita catálogo, papéis, concessões e convites.
- Uma pessoa sem concessão para uma ferramenta não vê a entrada — nem na paleta, nem nas janelas
  restauradas. Se ela perder a concessão com a janela aberta, a janela fecha no próximo evento de
  foco (a casca é a autoridade local; o site continua acessível pelo navegador, e isso é aceito).

## 11. Cofre e credenciais

Duas coisas separadas:

1. **Credencial da casca**: conta, convite e **senha local** (§9). Do lado do disco fica só o hash
   PBKDF2 com salt e parâmetros — nunca a senha.
2. **Credencial das ferramentas**: usuário e segredo de cada pessoa em cada ferramenta.

O cofre guarda a segunda. O objetivo é que ninguém precise saber de cor a senha de uma ferramenta e
que o administrador controle, por papel, o que cada pessoa enxerga.

**O padrão é o chaveiro do sistema** (decisão do dono, 2026-10-15: "a forma mais padrão possível de
guardar uma senha de um serviço. autenticar e pronto"):

- Cada credencial vive no **chaveiro do sistema operacional** via `app.secrets` — macOS Keychain,
  Windows Credential Manager, Linux Secret Service —, com chave `nod.cred.<pessoa>.<ferramenta>`.
  É o armazenamento que a própria documentação do runtime recomenda para token, e o único que o
  sistema operacional protege (`docs/tinyjs.md` §5).
- O banco local guarda só o índice: ferramenta, rótulo, usuário, chave no chaveiro, datas. Nunca o
  valor.
- **Autenticar e pronto**: a pessoa digita a senha local uma vez (ou usa biometria onde existe) e a
  sessão está aberta — a casca lê as credenciais do chaveiro e preenche os logins. Não há segundo
  portão, nem cofre separado para desbloquear, nem frase extra.
- O valor é **somente string** e o chaveiro do Windows recusa acima de 2560 bytes UTF-8
  (`tarwin/tinyjsapp-examples:trolley/.claude/skills/tinyjs/references/api.md` §"Store / secrets /
  sqlite"). Remover a credencial apaga o item do chaveiro e a linha do índice.
- **Limite honesto do chaveiro**: no macOS a ACL é por binário que gravou — um segredo salvo sob
  `tinyjs dev` faz o app construído pedir permissão uma vez, e reassinar o app pede de novo
  (`docs/tinyjs.md` §5). Qualquer processo rodando como o mesmo usuário consegue ler o item; o que a
  senha local protege é o **uso** das credenciais pela casca, não o cofre contra a própria conta do
  sistema. Isso é o comportamento padrão de um app que guarda senha no chaveiro, e é aceito.
- **Exportar é opcional, nunca o padrão** (RF-28): quem quiser levar as credenciais para outra
  máquina antes de existir o host pode gerar um arquivo cifrado pela chave derivada da senha local
  (AES-256-GCM com nonce por gravação; PBKDF2-HMAC-SHA256 com salt de 16 bytes). O arquivo é um
  extra de portabilidade, não a casa do segredo.
- **A cascata de login é o padrão e não se configura** (§8): a casca tenta, na ordem, sessão de
  cookie já válida, formulário de login preenchido do cofre, e o fluxo do provedor do próprio site;
  só o último caso mostra a tela de login com o botão de ver e copiar a credencial.
- **Como a casca preenche**: dois mecanismos existem e são nossos — o script document-start
  (`"inject"`, roda em qualquer origin) e `app.window(id).eval` em runtime (`docs/tinyjs.md` §2, §4).
  O adaptador é código nosso, versionado, mínimo, e **nunca** avalia dado vindo da página. O
  adaptador genérico procura os campos de login; o `auth_override` da entrada troca o genérico por um
  específico quando a ferramenta foge do padrão — e nenhum dos dois é obrigatório para cadastrar.
- **A casca aprende, o administrador não decide**: o resultado de cada passo (logado pela sessão,
  preenchido pelo adaptador, resolvido pelo provedor, ou manual) vira um **evento** (§13) e é o que a
  tela da entrada mostra como "como esta ferramenta costuma entrar".
- **Entregar credenciais a alguém antes de existir o host**: selo para a chave pública X25519 da
  pessoa (nativa no runtime, `saghul/txiki.js:src/js/polyfills/crypto/x25519.js`) ou digitação única
  pelo administrador (questão 7). É o mesmo problema que o convite resolve para a conta.
- **SSO/OIDC** não é um modo a escolher: quando o host existir, ele vira o provedor e as ferramentas
  apontam para ele — a cascata já segue o fluxo do provedor sem mudança do nosso lado. O que o v1 não
  faz é *configurar* SSO nas ferramentas; isso é trabalho de quem administra cada serviço (§18, §23).

## 12. Painel de admin

Telas da própria casca, restritas ao administrador:

| Tela | Ações |
| --- | --- |
| Ferramentas | Criar/editar/desativar entrada: colar o endereço e confirmar título, ícone e sonda de login; ordem, papéis, vistas, lista `api`; override de adaptador quando o genérico falhar. Testar abertura da janela. |
| Papéis | Criar/renomear/apagar papel; conceder e revogar ferramentas. |
| Pessoas | Emitir convite (mostra o código uma vez), atribuir papéis, revogar acesso, apagar credenciais do chaveiro. |
| Cofre de terceiros | Cadastrar a credencial de uma pessoa numa ferramenta; marcar rotação pendente. |
| Auditoria | Ver e exportar eventos; filtrar por pessoa, ferramenta, resultado. |
| Catálogo | Exportar e importar o catálogo (arquivo), ver versão e origem (local ou `host:<id>`). |

## 13. Auditoria

- Um **evento** por ação relevante: abriu ferramenta, abriu vista, falhou login, cadastrou
  credencial, revogou concessão, importou catálogo, atualizou o app.
- Cada evento: quando, quem, ferramenta, endereço, resultado, detalhe curto. Append-only, no banco
  local, exportável em JSONL.
- **Nenhum valor secreto entra em evento.** A Carna tem o mesmo cuidado com rastros
  (`Carna/apps/api/lib/carna/trace/redactor.ex`); aqui a regra é mais simples: credencial nunca é
  parâmetro de evento.
- Enquanto não houver host, o evento é local e privado. Com o host, ele é enviado em lote, e a
  pessoa vê o que foi enviado.
- E02 §6's `share.*` family obeys this section; `share.expired` is the one event the host writes
  itself, on the expiry purge (`docs/handovers/share-events.md`, 2026-10-17).

## 14. Requisitos funcionais

Cada RF tem um critério de aceitação observável. "Offline" significa sem servidor nenhum além da
máquina.

| ID | Requisito | Aceitação |
| --- | --- | --- |
| RF-01 | O administrador cadastra uma entrada (título, endereço, ícone, ordem, papéis, vistas, adaptador, `api`) na casca, offline. | Cadastro do Kanban e do Affine, reinício da casca, as duas entradas aparecem com ícone. |
| RF-02 | Clicar numa entrada abre a ferramenta em **janela própria**, com chrome nativo. | A janela carrega `https://kanban.example.com`; nenhum iframe é usado. |
| RF-03 | A sessão de login da ferramenta sobrevive ao fechamento da janela e ao reinício do app. | Logar no Planka, fechar a janela, reabrir pela paleta: continua logado. |
| RF-04 | Vista declarada abre em janela própria ou navega a janela da ferramenta, conforme o modo. | Vista "Sprint" (`modo: janela`) abre segunda janela; vista de pasta (`modo: navegar`) muda o endereço da janela existente. |
| RF-05 | A paleta (`⌘K`) lista entradas e vistas permitidas ao papel da pessoa e as abre por teclado. | Pessoa com papel `time` vê Kanban na paleta e não vê a entrada do financeiro. |
| RF-06 | Entradas sem concessão não aparecem nem são restauradas. | Revogar a concessão esconde a entrada na paleta e nas janelas restauradas. |
| RF-07 | O administrador emite convite de uso único, com validade, e a pessoa cria conta com ele. | Convite usado duas vezes falha na segunda; convite expirado falha com a mesma mensagem. |
| RF-08 | O cadastro da credencial de uma ferramenta grava o valor no chaveiro do sistema e o índice no banco local. | Inspeção do banco local não mostra o valor; o chaveiro do sistema mostra a chave `nod.cred.*`; apagar a credencial remove os dois. |
| RF-09 | Abrir uma ferramenta entra sem digitação, pela cascata: sessão existente, formulário preenchido, ou fluxo do provedor do próprio site. | Com credencial no cofre, a janela entra logada; numa ferramenta com SSO, o provedor resolve e o cofre não tem item dela; sem nada disso, mostra a tela de login. |
| RF-10 | Falha de adaptador é visível e reversível. | Adaptador quebrado deixa a tela de login utilizável e registra um evento de falha. |
| RF-11 | O administrador cria papéis e alterna concessões; a visibilidade muda sem reiniciar. | Conceder o Kanban ao papel `financeiro` faz a entrada aparecer na paleta do próximo uso. |
| RF-12 | Toda ação relevante gera evento exportável. | Exportar JSONL mostra os eventos do dia com pessoa, ferramenta e resultado. |
| RF-13 | Catálogo e concessões exportam e importam por arquivo. | Exportar numa máquina e importar em outra deixa as duas com as mesmas entradas. |
| RF-14 | O app se atualiza pelo manifesto, e o catálogo não exige recompilação. | `update.check` acusa versão nova; editar uma entrada não gera novo build. |
| RF-15 | Fechar a janela principal a esconde (com bandeja) e mantém as janelas de ferramenta abertas; a bandeja a traz de volta e tem "Quit Nod". | Fechar a janela principal com o Planka aberto: o Planka continua aberto; "Open Nod" na bandeja reabre a janela principal; "Quit Nod" encerra tudo. |
| RF-16 | Revogar acesso apaga o ponteiro e, a pedido, a credencial do chaveiro. | Após revogar, abrir a ferramenta não oferece login automático. |
| RF-17 | (Superseded by RF-30 to RF-43, 2026-10-16.) | — |
| RF-18 | (Superseded by RF-30 to RF-43, 2026-10-16.) | — |
| RF-19 | A sidebar da janela principal mostra um ícone por ferramenta permitida; clicar abre a ferramenta em janela própria ou, se já aberta, a traz para a frente sem recarregar. | Clicar no Affine com o Affine já aberto o traz para a frente em menos de 150 ms, mantendo o estado da página. |
| RF-20 | `⌘1`…`⌘9` abrem/trazem a ferramenta do dígito e `⌘K` abre a paleta, com o foco na janela principal ou dentro de qualquer janela de ferramenta. | Com o foco dentro do Planka, `⌘3` traz o webmail para a frente. |
| RF-21 | Carregando e falha de carregamento aparecem na sidebar e no cartão da ferramenta, com "try again". | Abrir uma ferramenta mostra o estado de carregando até o `finish`; com a rede cortada, o cartão mostra a falha e o botão de tentar de novo. |
| RF-22 | (Retirado na v2, 2026-10-15: não há mais palcos pré-aquecidos — janelas de ferramenta abertas ficam abertas até a pessoa fechá-las; a sessão sobrevive pelos cookies.) | — |
| RF-23 | A casca exige a senha local uma vez e abre a sessão inteira, com as credenciais já disponíveis. | Sem a senha correta, a casca não mostra catálogo nem injeta login; com ela (ou com biometria onde existe), abre direto no rail, sem segundo portão. |
| RF-24 | Trocar a senha local não perde credencial nenhuma. | Após a troca, o login automático continua funcionando nas mesmas ferramentas (os itens do chaveiro não mudam). |
| RF-25 | Nenhuma entrada exige escolher o jeito de autenticar. | Cadastrar a ferramenta sem tocar em auth funciona; a cascata resolve, e o resultado da sonda aparece na tela da entrada. |
| RF-26 | O build da release exige o seed privado e a release abre já com catálogo, papéis e concessões. | `tinyjs build` numa máquina sem o seed falha com mensagem clara; com o seed, o app recém-instalado abre com as ferramentas e os papéis do seed, sem rede. |
| RF-27 | O seed não contém segredo, e o primeiro boot não sobrescreve o que a pessoa já configurou. | Inspeção do seed não mostra senha nem credencial; reabrir depois de editar deixa as edições de pé. |
| RF-28 | (Opcional) Exportar as credenciais para outra máquina gera um arquivo cifrado pela senha local, e o padrão continua sendo o chaveiro. | Sem pedir o export, nada é escrito fora do chaveiro; com o export, o arquivo só abre com a senha e o importar repõe os itens do chaveiro. |
| RF-29 | O cadastro assistido preenche título, ícone e o resultado da sonda de login; o administrador só confirma. | Colar `https://kanban.example.com` devolve título e ícone preenchidos, o registro de que há formulário de login ou provedor, e a entrada salva sem digitar mais nada. |
| RF-30 | Without a host, the Nod makes no call to any host. | Network capture of a local session shows only tool traffic. |
| RF-31 | Add host pins the host key; later snapshots must verify against it. | Wrong `fp` aborts with one error, nothing stored; a host answering with another key is refused until re-added. |
| RF-32 | The host boots empty with a one-time setup code that creates the first admin. | Code works once; second use fails with the single error. |
| RF-33 | The admin creates a person and gets a short access code shown once; the person redeems it in the Nod and sets a password; later sign-ins use email + password. | Code works once and dies after 5 wrong tries or 72 h; wrong code or password returns one message. |
| RF-34 | Org tools, roles and grants come from the host; admin changes reach every connected Nod at next sync, no release. | Admin adds Jitsi granted to "team"; after "Sync now" only people with "team" see it. |
| RF-35 | A person adds personal tools, visible only to them, on every machine signed in to the host. | Personal tool added on machine A appears on machine B after sync; another person and the admin don't see it. |
| RF-36 | A person favorites org tools; favorites and their order follow the person. | Favorite on A shows first in the sidebar on B. |
| RF-37 | Connected Nod works offline from cache; personal edits made offline sync later. | Network off: unlock, sidebar, Home work; add a personal tool; network on: it reaches the host. |
| RF-38 | The vault never fills a login on an origin other than the one the credential was saved for. | Admin changes a tool URL; form fill stops for it. |
| RF-39 | Revoking a person or a device on the host ends that session. | Next sync fails with "signed out"; the cache is cleared of org tools. |
| RF-40 | Adding a host offers local tools as personal tools; an empty host's first admin may publish them as org tools. | After Add host, no local tool disappears. |
| RF-41 | The host runs as one compose with data on a volume and a scheduled backup. | Redeploy keeps data; a backup restores into a fresh host. |
| RF-42 | The password never leaves the machine: the host receives only `authKey`. | A capture of activation, sign-in and password change shows no password; the host DB has only `argon2id(authKey)` and the salt. |
| RF-43 | Vault values in the keychain are encrypted with `vaultKey`; a password reset by access code wipes that machine's vault. | Reading `nod.cred.*` with the system keychain tool shows ciphertext; after a reset, the old credentials are gone and the Nod asks for them again. |
| RF-44 | Credentials cross the host only sealed to the receiver's key and signed by the sender. | The host DB and a traffic capture show no username or secret in clear; a share with a bad signature is refused. |
| RF-45 | A changed public key of a colleague blocks sending until confirmed. | Swapping Bob's key on the host makes Alice's Nod warn and refuse until she confirms. |
| RF-46 | Revealing, copying, accepting and sending a credential each pass the gate; a revealed secret hides itself after a visible countdown. | With biometrics cancelled, nothing is shown, copied, accepted or sent; a revealed secret shows a countdown and is hidden when it ends. |
| RF-47 | Assigning to a role reaches every current member, and the admin sees members still missing a copy. | Add a member to the role; the list shows them until the admin's Nod seals their copy. |
| RF-48 | Revoking someone from a shared credential marks it rotation pending. | After revocation, the owner's vault shows "rotation pending" for that tool. |
| RF-53 | Each credential has a sharing scope — role, blocked or org — enforced on send and re-send. | A "role" credential can't be sent to someone with no common role; a "blocked" one offers no send at all. |
| RF-54 | Each credential shows its holders. | After Alice sends Figma to Bob, both see "Alice, Bob" with date and scope. |
| RF-55 | The Nod notices on its own when a newer release exists and tells the person, without them opening Settings. | With a release `release-X.Y.Z` newer than the installed version published, the Nod shows a new-version notice within one launch or one day; with none, no notice. |
| RF-56 | A build can carry a custom app icon without editing tracked files. | With `resources/icon.png` or `NOD_ICON` set, the built app shows that icon; without it, the default; `git status` stays clean. |
| RF-57 | An admin sets a guild icon; each person chooses Default or Guild icon for their app. | Admin uploads a PNG; after sync a member's Settings offers Guild icon and choosing it changes the Dock/taskbar icon; a tampered icon (hash not matching the signed snapshot) is refused. |
| RF-58 | A connected Nod shows who in the guild is online now. | With two people connected, each sees the other under "Online now" within one sync (≤ 6 min); a person who locked or quit drops off within 6 min; a revoked or disabled person never appears; local mode shows nothing. |

## 15. Requisitos não funcionais

| ID | Requisito |
| --- | --- |
| RNF-01 | Multiplataforma: macOS 15+, Windows 10/11 com WebView2, Linux glibc 2.35+ com `webkit2gtk-4.1`. Nenhuma função pode quebrar fora do macOS: testar `capabilities().x !== false` antes de usar (`docs/tinyjs.md` §6). |
| RNF-02 | Pegada: binário na casa dos 6 MB, app ocioso abaixo de 100 MB, casca utilizável em menos de 1 s, janela de ferramenta sem flash de chrome errado (chrome declarado no `win.open`). |
| RNF-03 | Offline: catálogo, papéis, concessões, cofre, auditoria, admin e restauração de janelas funcionam sem rede. |
| RNF-04 | Segurança: gate `api.origins` por origin exata, nunca `"all"` nem `"wrapper"` para terceiros; segredo só no chaveiro; HTTPS obrigatório fora de loopback; adaptador de login é código nosso e mínimo; sem telemetria externa. |
| RNF-05 | Privacidade: nenhum dado sai da máquina sem ação explícita; eventos ficam locais até existir host. |
| RNF-06 | Manutenção: TypeScript estrito; um fato em uma casa; nenhuma dependência que exija rede para compilar. |
| RNF-07 | Teclado: toda ação alcançável por teclado, com a paleta como caminho principal; atalhos globais opcionais. |
| RNF-08 | Language: the app is entirely in English — interface, messages, identifiers, API, tests (owner, 2026-10-15). From 2026-10-16, project documents are written in English too (owner: "é pra tudo ser em ingles a partir de agora"); existing pt-BR text stays until it is rewritten. |
| RNF-09 | Trazer para a frente uma ferramenta já aberta é perceptível como instantâneo: menos de 150 ms entre o clique e a janela à frente; nunca recarrega a página. |
| RNF-10 | Criptografia: o armazenamento padrão de segredo é o chaveiro do sistema. A senha local é hash PBKDF2-HMAC-SHA256 (salt de 16 bytes, parâmetros versionados); o único uso de AES-256-GCM é o export opcional, com nonce por gravação. Senha e chave derivada nunca tocam o disco nem entram em evento, log ou `store.json`. |
| RNF-11 | (Retirado na v2 junto com o RF-22.) |

## 16. Modelo de dados local

SQLite no backend (`tjs:sqlite`, síncrono), no diretório de dados do app: pessoas e papéis, catálogo
(ferramentas, vistas, concessões, última sonda), convites (só hash), índice do cofre, eventos e meta.
O schema exato, com os nomes em inglês do código, mora em `docs/arquitetura.md` §4
(`backend/repo.ts`). Segredo só no chaveiro do sistema (§11); nenhum arquivo do app guarda valor de
credencial. O `store.json` guarda só preferências e a lista de janelas abertas para restauração.

**Connected mode as built (block 1, 2026-10-16).** The local backend's schema is `user_version = 3`
and adds: a single `host` row (the pinned guild — address, kid, public key, person id, cached salt,
last snapshot, version, issuedAt, last sync, last error), a `host_outbox` of the person's pending
writes, `event.client_id`/`sent_at` for the event push, `vault_item.origin` (the origin a fill is
bound to, RF-38), and the `person` password V2 columns (`password_check`/`password_algorithm`).
While connected, org tools/roles/grants are read from `host.snapshot`, parsed once per change and
kept in memory — the local `tool`/`role` tables still hold the local-mode catalog, untouched (SP05
§2, `backend/connected-catalog.ts`). The host itself has its own SQLite (`host/`, SP01).

## 17. Offline e sincronização

- **Local é a fonte até existir host.** O catálogo tem `origem` (`local` ou `host:<id>`) e `versao`.
- **Regras de merge, quando o host existir**: catálogo, papéis e concessões descem e vencem;
  eventos locais sobem em lote e nunca são reescritos; credenciais nunca saem da máquina.
- **Conflito de conta** (mesma pessoa em duas máquinas) é resolvido pelo host; no local, cada
  máquina tem a conta que criou.
- **Nada de replicação em tempo real.** Sem websocket, sem presença, sem conflito de escrita
  simultânea: o catálogo é pull, os eventos são push.

**Connected mode as built (block 1, 2026-10-16; `docs/specs/SP04-sync.md`).**

- The host is a pull/push loop, not a replica. Triggers: right after unlock, every 5 minutes while
  unlocked (a backend timer), "Sync now", and after any admin write. Order: flush the outbox
  (personal tools, views and favorites, last-write-wins by `updatedAt`), push events in batches of
  500, then `GET /v1/state`.
- The signed snapshot is the org half's source: Ed25519 over the exact bytes, an `ETag`/`version`
  and an `issuedAt`; the client pins the host key and refuses a changed one until the host is
  removed and added again (RF-31).
- Offline keeps working: the cache stays usable and Settings → Hosts shows the last success; the org
  half hides 14 days after the last successful sync (owner's decision, §22 "Stale cache"). A `401`
  clears the token, drops the org half and asks for sign-in (RF-39).
- The `origem`/`versao` fields named in the first bullet were **not** built as such: `Entry` gained
  `scope: 'org' | 'personal'` and `ownerId`, and the local `tool`/`role` tables are simply not read
  while connected — the snapshot is (SP05 §2, c1).

## 18. Host fino (pesquisa futura)

O dono quer, mais adiante, um servidor para todos se conectarem. O desenho proposto:

Evolution proposed on 2026-10-16 — connected mode, host sign-in, personal tools and favorites,
sync contract, Coolify deployment, stack options: `docs/epics/E01-connected-mode.md`. Rows marked
`Decidido (2026-10-16)` in §22 already apply; the rest of this section waits for that epic's reading.

**The host now exists.** Block 1 shipped it (milestone "Block 1 — One guild, synced", 2026-10-16):
`host/` is a Bun + Elysia 2 beta service, one process with `bun:sqlite` on a volume, deployed as one
compose — the stack is **not** Elixir, so the BEAM rows below are the earlier proposal and are
superseded on that point (§22 "Host"). Layout and rules: `host/context.md`; contract:
`docs/specs/SP01–SP04` and `SP07`. Connected mode is what the Nod talks to.

- **Elixir/BEAM numa VPS com Coolify**, como a Carna já fez, consumido pelo **backend** do app (o
  runtime não tem servidor HTTP e a página não fala com a rede sem passar pelo backend —
  `docs/tinyjs.md` §10).
- **Fino de verdade**: GraphQL (`/gql`) com token bearer; convites; catálogo; papéis e concessões;
  ingestão de eventos. Sem Oban, sem Hocuspocus, sem LiveKit, sem object storage, sem agentes.
- **Reaproveitamento direto da Carna**: o par convite/registro
  (`Carna/apps/api/lib/carna/accounts/invite.ex`,
  `Carna/apps/api/lib/carna/accounts/changes/registration_rule.ex`), o bearer de 14 dias revogável
  (`Carna/apps/api/lib/carna/accounts/user.ex`, `…/accounts/token.ex`), a mensagem de erro única no
  login (`Carna/apps/api/lib/carna/accounts/graphql_errors.ex`), o rate limit por identidade e IP
  (`Carna/apps/api/lib/carna_web/rate_limit.ex`) e o CORS por origin exata
  (`Carna/apps/api/lib/carna_web/endpoint.ex`).
- **BEAM embutido: não.** Um release Elixir como sidecar (`executables/`) roda, mas pesa dezenas de
  MB e destrói a premissa de 6 MB da casca. O host é remoto, ou não existe.
- **Auth de verdade para as ferramentas**: com o host no ar, cada ferramenta passa a apontar para um
  OIDC/forward-auth do host, e a casca autentica uma vez. Isso é o que aposenta o adaptador de login
  — e depende de cada ferramenta aceitar OIDC (§23).

## 19. Distribuição: release privada com seed travado

O dono definiu o caminho em 2026-10-15: **ele mesmo manda releases com as regras embutidas**
(JSONs que ele mantém fora do git) para distribuir na mão entre as pessoas; depois, num segundo
momento, isso passa a ser validado online e a se atualizar sozinho.

**O mecanismo — seed privado:**

- O catálogo inicial, os papéis, as concessões e os **hashes dos convites** vivem num **arquivo de
  seed** que **não entra no git** (`resources/seed.json`, com `seed.example.json` versionado no lugar
  dele). O runtime empacota `resources/` dentro do app e o backend lê por
  `(await app.paths()).resources` (`docs/tinyjs.md` §1), então a release carrega as regras sem
  servidor e sem rede. O `tinyjs.json` também é gerado (`scripts/gen-config.ts`, gitignored), porque
  o gate de origins sai das entradas do seed e não pode vazar para o git.
- **Build sem seed falha de propósito**: o `tinyjs.json` lista o arquivo, e caminho de `resources`
  faltando falha o build (`docs/tinyjs.md` §1). Uma release sem as regras não existe por acidente.
- **Dev roda sem seed**: abre vazia, com aviso, para quem está desenvolvendo; o seed só é exigido na
  release.
- **Primeiro boot aplica o seed** e depois o que vale é o banco local: a pessoa edita, o
  administrador importa um seed novo (RF-13) ou, mais adiante, o host manda o catálogo (RF-18).
- **O seed não carrega segredo de ninguém**: nem senha de pessoa, nem credencial de ferramenta. Ele
  traz endereços, ícones, papéis e concessões — organização, não credencial. O que é secreto continua
  no cofre, cifrado pela senha local (§11).
- **Env travada**: a release fixa `TINYJS_VERSION` e o `id` do app; não existe endpoint configurável
  em runtime que redirecione catálogo ou atualização. Isso é o que o dono chamou de "envs travadas".
  **Superseded for the catalog on 2026-10-16** (owner: "env travada era algo como uma versão mais
  simples inicial"): the host address is configurable at runtime and the host is the central core
  (`docs/epics/E01-connected-mode.md` §2, §8). `TINYJS_VERSION` and the app `id` stay fixed per release.

**Depois do seed, a página de build normal:**

- `tinyjs build` por sistema; `tinyjs publish` gera zip + `manifest.json` com sha256; `update.auto`
  em `daily`. A atualização verifica checksum e assinatura antes de trocar o app
  (`docs/tinyjs.md` §8). É o passo seguinte do que o dono descreveu: hoje ele manda a release na mão,
  amanhã a release se valida online e se atualiza sozinha (F5).
- **macOS**: distribuição sem atrito exige Developer ID + notarização (US$ 99/ano). Sem o
  certificado, o padrão ad-hoc obriga cada pessoa a liberar em Ajustes → Privacidade e Segurança →
  "Abrir assim mesmo" (no macOS 15+ o atalho de right-click não funciona mais) ou a remover a
  quarentena. **O dono decidiu em 2026-10-15 que isso é aceitável**: "somos devs, não tem problema
  repassar isso pros outros". Então F4 entrega distribuição ad-hoc com o passo de liberação
  documentado, e o certificado vira melhoria opcional. **O mesmo bloqueio existe hoje na Carna**: a
  issue `C10-notarizacao-macos` está
  `bloqueada_por: certificado Developer ID Application no chaveiro do dono`
  (`_research/Frentes/carna/issues/C10-notarizacao-macos.md`).
- **Windows**: nenhuma estratégia de assinatura é documentada pelo runtime; o caminho é a pasta
  portátil do `build` enquanto isso não for estudado.
- **Linux**: tarball por arquitetura; `.desktop` se registra na primeira execução.
- O app declara `urlScheme` (`nod://`) para deep link de entrada/vista e instância única.

## 20. Segurança e ameaças

| Ameaça | Defesa |
| --- | --- |
| Site de terceiro (ou um subdomínio comprometido) chamando o backend da casca | Gate `api.origins` com a **origin exata** de cada ferramenta e lista explícita de métodos por entrada; nunca `https://*.example.com` nem `"all"`; o gate é imposto no backend e usa a origin real do frame (`docs/tinyjs.md` §2, §9). |
| Segredo guardado em arquivo do app | Nenhum: a credencial vive no chaveiro do sistema, e o banco local e o `store.json` guardam só índice. Valor nunca entra em evento ou em log (`docs/tinyjs.md` §5). |
| Alguém na máquina sem a senha | A casca não abre, não lista catálogo, não injeta login; erro único e espera crescente depois de tentativas; no Linux não há biometria, então o portão é só a senha (falha fechado, `docs/tinyjs.md` §6). |
| Credencial lida por outro processo do mesmo usuário | Comportamento padrão de quem usa o chaveiro do sistema: o item é do usuário, não do app. Aceito (2026-10-15). O que a senha local protege é o uso das credenciais pela casca; o export opcional (RF-28) é que fica cifrado sem a senha (`docs/tinyjs.md` §5). |
| Adaptador de login como superfície de ataque | Código nosso, versionado, sem `eval` de dado remoto; roda só na origin declarada daquela entrada. |
| Cookies compartilhados entre subdomínios | As ferramentas são origins distintas, mas um cookie com `Domain=.example.com` vale em todas: política é não usar cookie de domínio amplo e preferir sessão por origin. |
| Ferramenta que recusa webview embutida | UA override por sistema; se ainda recusar, `onNavigate` devolve `external` e a ferramenta abre no navegador do sistema, com evento registrado. |
| Catálogo local editado por quem tem a máquina | Aceito enquanto não houver host: quem tem a máquina tem o catálogo. Com o host, o catálogo passa a ser assinado e a origem remota vence (§17, §23). |
| Superfície de nomes e caminhos no app | O diretório de dados e os ids de janela são sanitizados; nada de caminho vindo de entrada do catálogo além de ícone dentro do diretório de dados. |

## 21. Roadmap por fases

| Fase | Entrega | Prova |
| --- | --- | --- |
| F0 — requisitos | Este documento, o glossário, os fatos do runtime e o corte da Carna. | Leitura do dono. |
| F1 — casca, catálogo e rail | Janela da casca, rail, paleta, cadastro assistido (título, ícone, sonda de login), palcos pré-aquecidos com troca instantânea, restauração, bandeja. Sem credenciais ainda. | RF-01 a RF-06, RF-14, RF-15, RF-19 a RF-22, RF-29 numa máquina, com catálogo real do `*.example.com`. |
| F2 — senha, cofre e login | Senha local com PBKDF2 e autenticação de um passo, credenciais no chaveiro do sistema, convite, cascata de login com adaptador genérico e override, fallback. | RF-07 a RF-10, RF-16, RF-23 a RF-25; RF-28 fica opcional. |
| F3 — papéis e auditoria | Papéis, concessões, eventos, exportação/importação do catálogo. | RF-11 a RF-13. |
| F4 — release privada | Seed travado embutido, build por sistema, manifesto, liberação manual no macOS documentada, deep link. | RF-26, RF-27 e instalação numa máquina que não a do build, seguindo o passo a passo da liberação. |
| F5 — host fino | Servidor Elixir com catálogo, contas, convites, concessões, eventos; validação online e auto-update; OIDC das ferramentas que aceitam. | RF-17, RF-18, RF-14. Fase de pesquisa: começa por um recorte escrito. The host shipped as Bun + Elysia in Block 1 (§18, §22 "Host"), not as Elixir; the remaining half (online validation, auto-update, tool OIDC) is still open. |
| Block 1 — one guild, synced (2026-10-16) | The host (`host/`, Bun + Elysia 2 beta, one compose) and connected Nod: add host and pin its key, sign-in by access code, org tools/roles/grants from a signed snapshot, personal tools and favorites, the event push, and the Coolify deploy — RF-30 to RF-43. | `bun test/smoke/connected.ts --force` (40 steps, two app ids, SP05 §5 steps 2–5), plus `bun test/smoke/run.ts --force` (14 steps) and `bun test test/ host/` (582). |
| Block 2 — mine and shared (2026-10-17) | Personal tools, personal views and favorites in the Nod and on the host; the leftover offer on Add host and the keep-personal reversal on Remove host; the vault sealed with `vaultKey` and wiped on a reset; device sessions, the minimum-app-version gate and the update manifest the host serves; the E02 key pairs (one per person across machines) with colleague pinning; credential send, assign and update with scope, holders and rotation pending; the content-free `share.*` event family of E02 §6 — RF-14, RF-24, RF-35 to RF-37, RF-39, RF-40, RF-43 to RF-48, RF-53, RF-54. | `bun test test/ host/` (859) and `bun test/smoke/run.ts --force` (14 steps); the two-machine block 2 smoke is issue #38 (K10). |
| Próxima sprint (fora das fases) | Mapear `nod.example.com` e as abas por iframe, e decidir se hospedar algo além das regras passou a ser atrativo. | Um recorte escrito com o custo (casca deixa de funcionar offline) e o ganho. |

## 22. Registro de decisões

Status: `Proposto` espera leitura do dono; `Aberto` espera pesquisa; só o dono vira uma decisão em
`Decidido`.

| Área | Decisão | Alternativas | Motivo | Status |
| --- | --- | --- | --- | --- |
| Runtime | TypeScript sobre tinyjs (txiki.js + webview nativa) | Electron; Tauri | Pedido do dono; ~6 MB; multiplataforma; sem servidor HTTP | Proposto |
| Janela única de gerenciar/usar | Uma janela principal com sidebar, Home, paleta e Settings; cada ferramenta em janela própria aberta a partir dela | rail ancorado + palcos encostados; janelas separadas para admin, paleta e carregando | Dono em 2026-10-15: "tudo em uma janela só para o lado de gerenciar/usar, aí abrimos as janelas a partir daí" | Decidido (2026-10-15) |
| Idioma do app | Todo o app em inglês: interface, mensagens, identificadores, API, tipos, testes; docs de projeto em pt-BR | só a interface em inglês | Dono em 2026-10-15: "tudo deve estar em inglês" (escopo escolhido: o app inteiro) | Decidido (2026-10-15); docs part superseded by "Project docs language" |
| Project docs language | Everything written from 2026-10-16 on is in English, project documents included; existing pt-BR text is not translated in bulk | keep project docs in pt-BR | Owner on 2026-10-16: "é pra tudo ser em ingles a partir de agora" | Decidido (2026-10-16) |
| Troca de sistema | Clicar ou `⌘N` traz a janela da ferramenta para a frente; abre se não estiver aberta | — | Pedido do dono (troca rápida), mantido na v2 sem palcos | Decidido (2026-10-15) |
| Moldura integrada | Superada pela "Janela única de gerenciar/usar" (2026-10-15) | — | — | Superada |
| Palco pré-aquecido | Superado pela janela única (RF-22 retirado) | — | — | Superada |
| Aba nativa | Não existe: agrupar janelas é do SO | tabbing do SO | O runtime não tem tabbing (`docs/tinyjs.md` §3) | Proposto |
| Abas de verdade numa janela | **Adiado para a próxima sprint** (2026-10-15): exigiria hospedar a casca num origin do mesmo site e iframar as ferramentas | manter o rail com palcos | Decisão do dono: mapear quando hospedar algo além das regras ficar atrativo; hoje custaria o funcionamento offline | Adiado |
| Release privada com seed travado | O dono monta a release com os JSONs de regras embutidos, fora do git, e distribui na mão | catálogo no repo; catálogo só importado à mão | Decisão do dono em 2026-10-15: "releases com envs travadas de jsons que eu ignoro" | Decidido (2026-10-15) |
| Seed embutido em `resources/` | Arquivo privado listado em `resources`, empacotado pela release; build sem ele falha | importar o seed à mão na primeira execução | O runtime já empacota `resources/` e falha o build quando o caminho falta (`docs/tinyjs.md` §1) | Proposto |
| Validação online e auto-update | Depois do seed: release validada online e se atualizando sozinha | continuar mandando release na mão | Próximo passo declarado pelo dono; é o que a F5 entrega | Proposto |
| Rail injetado na página | Superado: não há rail em janela de ferramenta | — | — | Superada |
| Catálogo | Dado local versionado, editado na casca | catálogo no código | Cadastrar ferramenta não pode exigir recompilar | Proposto |
| Ícones | PNG/SVG no diretório de dados, buscados no cadastro pelo backend ou enviados pelo admin | ICO embutido no build | Sem decodificador de imagem no runtime para ICO | Proposto |
| Senha local | Senha própria da conta na casca, com PBKDF2-HMAC-SHA256 salgado; biometria como atalho | sessão do SO sem senha | Pedido do dono em 2026-10-15; PBKDF2 é nativo no runtime (`saghul/txiki.js:src/js/polyfills/crypto/kdf.js`) | Decidido (2026-10-15) |
| Cofre | Chaveiro do sistema operacional (`app.secrets`) por pessoa e ferramenta; índice no banco local | arquivo cifrado próprio; `store.json` | Dono em 2026-10-15: "a forma mais padrão possível de guardar uma senha de um serviço. autenticar e pronto" | Decidido (2026-10-15) |
| Export cifrado | Opcional, para levar credenciais a outra máquina antes do host (AES-256-GCM com chave derivada da senha) | sem export; esperar o host | Portabilidade sem virar a casa do segredo | Proposto |
| Login automático | Cascata: sessão existente, adaptador genérico, fluxo do provedor, fallback manual visível | adaptador específico por ferramenta | Funciona sem saber o que a ferramenta usa, e sem depender do host | Proposto |
| Auth sem escolha | Cascata automática de login (sessão → formulário → provedor → manual), com `auth` só como override opcional | modo por entrada (`oidc` \| `adaptador` \| `manual`) escolhido pelo administrador | Dono em 2026-10-15: "acredito que OIDC todos têm… quero não ter que ficar sabendo desses ou não" | Decidido (2026-10-15) |
| Cadastro assistido | Colar o endereço e a casca buscar título, ícone e sondar o login | cadastro campo a campo | Serve a mesma decisão: o administrador não precisa saber o que a ferramenta usa | Proposto |
| Identidade | Conta por casca hoje, conta por host depois; convite de uso único com hash e validade | login por ferramenta na mão | Herdado da Carna, que já provou o fluxo | Proposto |
| Papéis | Papéis nomeados + concessão papel↔ferramenta; admin vê tudo | permissão pessoa a pessoa | Papel é o pedido do dono; concessão é a espinha, como a membership na Carna | Proposto |
| Auditoria | Tabela local de eventos, exportável, sem valor secreto | telemetria remota | Privacidade e operação offline | Proposto |
| Camera and microphone | Allowed by default for every tool the org added; a link from someone outside the org is warned about and keeps the system prompt. Usage strings always in the release | `media.*` for every origin; prompt for everything | Owner on 2026-10-16, after a release crashed on WebRTC: "permitir rodar por padrão para tudo que for adicionado pela pessoa da org, e avisar quando é um link de alguém que não é da org" | Decidido (2026-10-16) |
| Host | Bun + **Elysia 2.0 beta** (exact beta pinned, bumped on purpose), one process, SQLite via `bun:sqlite`, in this repo under `host/` (`docs/epics/E01-connected-mode.md` §11) | Elysia 1.4 stable; Elixir/Phoenix; Bun sem framework; Go + PocketBase; two services (data + rules) | Owner on 2026-10-16: "vamos de bun com elysia mesmo"; "usar logo a v2 pra testar impactos e encontrar bugs. é um projeto pessoal" | Decidido (2026-10-16) |
| Host tenancy | One host serves one guild; another guild is another container | several guilds per host | Owner on 2026-10-16: "cada container pode hospedar só uma guild, é isso mesmo" | Decidido (2026-10-16) |
| Host deployment | One compose on the owner's Coolify: one service, SQLite on a volume (`docs/epics/E01-connected-mode.md` §10) | — | Owner on 2026-10-16: "quero hospedar um compose do servidor no meu coolify" | Decidido (2026-10-16) |
| Host address | The host address is configurable at deploy through an environment variable; no address appears in the code | an address baked into the build | E01 q9, owner on 2026-10-16: configurable at deploy | Decidido (2026-10-16) |
| Host backup target | Scheduled backup to a local volume only; the off-VPS copy is deferred | backing up off the VPS now | E01 q7, owner on 2026-10-16 | Decidido (2026-10-16) |
| Stale cache | A connected Nod that is offline keeps showing org tools from cache for 14 days after the last successful sync, then hides them until a sync succeeds | hide them as soon as the sync fails | E01 q8, owner on 2026-10-16 | Decidido (2026-10-16) |
| Public repository and `release-*` versions | The repository becomes public; releases are tagged `release-<version>`; an installed Nod is notified when a newer release exists (RF-55) | private repository; releases by hand | Owner on 2026-10-16: the repo will become public and releases follow `release-*` | Decidido (2026-10-16) |
| Host sign-in | The admin creates a person and gets a short access code; the person redeems it in the Nod and sets a password; sign-in is email + password. Email sending deferred (`docs/epics/E01-connected-mode.md` §7) | magic link by email | Owner on 2026-10-16: "passar um código curto que o sistema iria pedir e depois cadastrar sua senha"; "desconsiderar o sistema de email agora" | Decidido (2026-10-16) |
| Password never reaches the host | The Nod derives `authKey` and `vaultKey` from the password; only `authKey` is sent; vault values encrypted with `vaultKey` before the keychain (`docs/epics/E01-connected-mode.md` §7) | send the password and hash it on the host | Owner on 2026-10-16: the password "abrir uma vault privada local que eu no servidor nao tenho acesso"; changes the plain-keychain detail of "Cofre"; owner approved gate #1 on 2026-10-16 | Decidido (2026-10-16) |
| Carna services | Deferred: future separate services beside the host, trusting its session | incorporate now | Owner on 2026-10-16: "deixar isso como algo futuro" | Decidido (2026-10-16) |
| Biometric gate | Biometrics gate unlock and every reveal, copy, accept and send of a credential; password where biometrics don't exist (Linux); `vaultKey` kept in the keychain for biometric unlock (`docs/epics/E01-connected-mode.md` §7, `docs/epics/E02-credential-sharing.md` §5) | password only for the vault | Owner on 2026-10-16: "biometrics internas pra tudo, mesmo que isso inclua só desbloquear localmente as senhas guardadas" | Decidido (2026-10-16) |
| Credential sharing | Send, assign (to a person or a role) and share tool credentials end to end: sealed to the receiver's X25519 key, signed with Ed25519, relayed by the host as ciphertext (`docs/epics/E02-credential-sharing.md`) | admin types it once; no sharing | Owner on 2026-10-16: "mandar senhas entre sí ou apontar senhas novas para membros… passando por biometria para conseguir sequer ver"; owner approved gate #1 on 2026-10-16 | Decidido (2026-10-16) |
| Guilds per install | One Nod is in one guild at a time; changing guild is removing the host and adding another (`docs/epics/E01-connected-mode.md` §4) | several guilds side by side | Owner on 2026-10-16: "no momento nao. se sair e voltar ele poderia entrar em outra" | Decidido (2026-10-16) |
| Sharing scope and holders | Each credential has a scope — role (default), blocked, org — and shows who holds it (`docs/epics/E02-credential-sharing.md` §1) | anyone to anyone | Owner on 2026-10-16: "só entre pessoas da mesma role… ou bloqueado ou publica pra org"; "é bom ver que consegue ver aquele password" | Decidido (2026-10-16) |
| Docked view and tabs | Docked mode **is the default**: tabs shown over the main window's center panel as frameless windows the Nod keeps on the slot, several tabs per tool, links clicked inside a tool adopted as tabs next to it; Windows mode stays as a setting (`docs/epics/E03-docked-tabs.md`) | iframes; tool windows only | Owner on 2026-10-16: center panel showing the open tab, detachable, several tabs per tool; "padrão é docked view". The docked mechanics remain a proposal until spikes S0–S4; iframes stay out (§7). Blocked by B05 | Decidido (2026-10-16): default and intent; mechanics Proposto |
| Detach without reload | Detaching or docking a tab keeps the same window and page (frame toggled, no `parent`); never a reload (`docs/epics/E03-docked-tabs.md` §3) | reopen as a framed window (page reloads) | Owner on 2026-10-16: "quero que deatachar nao perca o progresso" | Decidido (2026-10-16) |
| Quick links | Open any `http(s)` link in an ad-hoc tab (palette, `nod://open?url=`) and save any tab to the sidebar in one step, as a personal view or personal tool (`docs/epics/E03-docked-tabs.md` §5) | catalog-only navigation (§2) | Owner on 2026-10-16: "abrir link no bond e/ou salvar link novo na barra lateral mais rápido" | Decidido (2026-10-16) |
| Web Nod | Optional browser version served by the host behind `WEB_UI=true`: same accounts, tools open in new browser tabs, no autofill or vault; clients as a kind of person (`docs/epics/E04-web-nod.md`) | app only; iframe tabs on the web (§23 q11) | Owner on 2026-10-16: "hospedar junto do stack, opcionalmente, uma versão não headless… para clientes acessarem material nosso"; later phase | Proposto |
| Reveal countdown | A revealed credential stays visible a few seconds with a countdown indicator, then hides (`docs/epics/E02-credential-sharing.md` §5) | stay until closed; no grace | Owner on 2026-10-16: "visivel por alguns segundos com indicador de quanto tempo" | Decidido (2026-10-16) |
| Personal tools and favorites | A person adds personal tools and favorites org tools; both follow the person through the host (`docs/epics/E01-connected-mode.md` §6) | org catalog only | Owner on 2026-10-16: "um usuário pode adicionar suas proprias ferramentas… favoritar ferramentas da org" | Decidido (2026-10-16) |
| Connected mode | Optional host address per install; without it the Nod stays exactly as today (`docs/epics/E01-connected-mode.md`) | host mandatory; local only | Owner on 2026-10-16: offline "como eu quiser", or a server address to sync people and permissions; "sincronizar com uma central pra ser tipo um core mesmo" | Decidido (2026-10-16) |
| Identity of the tools | SSO into the tools is a later milestone (M4); the first phases keep the login cascade (`docs/epics/E01-connected-mode.md` §13) | ready OIDC provider from day one; Boruta inside an Elixir host | The owner wants a simple self-contained host first; SSO needs an OIDC provider, the costliest piece; owner approved gate #1 on 2026-10-16 | Decidido (2026-10-16) |
| Host address at runtime | Configurable at runtime: the person types the host address or opens an invite link; the host is the central core that people, roles, grants and catalog sync from (`docs/epics/E01-connected-mode.md` §2, §8) | address pinned by the seed per release ("env travada") | Owner on 2026-10-16: env travada was a simpler first version; adding a tool (e.g. Jitsi) in the admin must make it appear for everyone | Decidido (2026-10-16) |
| Host trust at enrollment | TLS + host key pinned at Add host; invite links carry the key fingerprint and must match; vault items bound to origin (`docs/epics/E01-connected-mode.md` §8) | no pinning | A typed address must not let a different server silently take over the catalog later; owner approved gate #1 on 2026-10-16 | Decidido (2026-10-16) |
| Product and repository name | The project and the repository are **Nod** (`CaioFaSoares/Nod`), renamed from `Bond` on 2026-10-16; the docs, the README and the repo name use Nod from that date (`docs/rename-nod.md`) | keep `Bond` | Owner on 2026-10-16: the repository is Nod, and from now on the docs name it Nod | Decidido (2026-10-16) |
| Internal rename to Nod | The identifier rename landed in **0.3.5 as a clean cutover**: app id `copland.nod`, `nod://` deep links, `nod.*` RPC methods, `NOD_*` environment variables, `/.well-known/nod`, `Nod-Signature`, `nod.db`, keychain keys under `nod.*`. No data migration and no compatibility aliases — an installed 0.3.0 starts fresh. The KDF/HKDF/seal protocol labels stay as they were (changing them would change every derived key). Hosts are redeployed with `NOD_*` env (`docs/rename-nod.md`) | migration plus compatibility aliases; keep the internal identifiers | Owner on 2026-10-16: "pode renomear, tem problema nao, limpa no 0.3.5" | Decidido (2026-10-16) |
| Custom icons | A release can wear a custom app icon without touching tracked files (`resources/icon.png` or `NOD_ICON`, RF-56), and the guild icon the admin uploads is chosen per person — Default or Guild (RF-57) | an icon baked into the release only; one org-wide icon for everybody | Owner on 2026-10-16: "quero poder fazer builds customizadas com ícones diferentes de forma mais simples ou trocar o ícone dele por um custom por guild e escolher" | Decidido (2026-10-16) |
| Presence ("Online now") | Online = a live host session seen in the last 6 minutes (the 5-min sync already touches `sessions.last_seen_at`; no heartbeat, no new traffic). Served by its own person route `GET /v1/presence`, **outside** the signed snapshot (presence would move the snapshot `version` every poll and kill the `304`). Visible to every member (`kind = member`), never to or about clients; shows name and "last seen", never device, OS or IP (RF-58) | admin-only column in People; a 1-min heartbeat; presence inside the snapshot | Owner on 2026-10-17: "quero ter algum canto para ver as pessoas online agora" | Proposto |
| Distribuição macOS | Ad-hoc com liberação manual documentada; Developer ID só como melhoria | comprar o certificado antes de F4 | Dono em 2026-10-15: "somos devs, não tem problema repassar isso pros outros" | Decidido (2026-10-15) |
| Extensões | Fora do v1: o Nod cadastra endereços, não hospeda código | registro/manifesto/actor como na Carna | Escopo: casca fina | Proposto |
| Extension system and knowledge base | First-party extensions, enabled on the host (every connected person with the grant sees them, nothing installed on their Nod) or in one Nod (local, offline); third-party code stays out. The first extension is a team knowledge base in tiptap with its own database on the host (`docs/epics/E05-extensions-kb.md`). Would lift §1 principle 6 and two §2 non-goals and supersede the row above | keep "no extensions"; third-party extensions with a sandbox; a KB tool registered as a plain address | Owner on 2026-10-17: "adicionar um sistema de extensoes… uma base de conhecimento em tiptap com base propria e compartilhada dentro da equipe… se estiver só no host, quem acessar consegue ver as extensoes"; later phase | Proposto |
| Duas identidades na mesma ferramenta | Fora: um app tem um perfil de cookies | um app por identidade | Não há isolamento por janela (`docs/tinyjs.md` §10) | Proposto |
| Fechar a janela principal | Com bandeja, esconde e mantém as janelas de ferramenta; "Quit Nod" encerra tudo; sem bandeja, fechar encerra | fechar sempre encerra | A janela principal é o centro, não a dona das janelas | Proposto |
| One key pair per person across machines | The first machine to activate publishes its private pair to the host as `bv1.` under `vaultKey` (same password + host salt → same `vaultKey` on every machine); every other machine downloads and opens it instead of generating its own. The host only stores ciphertext. A reset generates a new pair and replaces both halves | first publisher keeps it (second machine can't receive); per-device pairs (one sealed copy per device) | Owner on 2026-10-17, choosing "Keypair synced via host, sealed with vaultKey": SP06 §2 left the second machine open, and per-machine pairs kept replacing each other on the host | Decidido |
| Gate where biometrics exist | Reveal, copy, send, accept and assign always call `app.authenticate` on a machine whose runtime reports the `authenticate` capability; a typed password is the gate only where it doesn't (Linux) | password as fallback everywhere | Owner on 2026-10-17 (review finding M3, `docs/handovers/block2-review.md`): "Biometrics required where they exist" | Decidido |
| Gate in a dev run | A non-release (`tinyjs dev`) run also accepts the typed password, so the unattended smoke can pass the gate; a release build never does | a test-only RPC; no gate in the smoke | Needed by the connected smoke after the decision above; proposed by the orchestrator, not yet read by the owner | Proposto |
| Revoked member of an assigned role | A holder the owner (or an admin) revoked stops appearing in the admin's "missing a copy" list for that credential; giving it back takes an explicit direct assignment | the assignment wins and re-lists them | Owner on 2026-10-17 (review finding M5): "No — revocation suppresses it" | Decidido |
| Nod older than the host's `minAppVersion` | The Nod does not connect to the host: no sync, no push, no host write | keep working read-only from the cached snapshot (the #28 proposal) | Owner on 2026-10-17 on #28: "ele deve só não deixar tudo ser conectado" | Decidido |
| How a too-old Nod stays disconnected | Built in 0.4.0: only discovery and `GET /v1/meta/app` go out; join and sign-in are refused before any credential leaves; nothing from the cached snapshot is shown (the local catalog runs) while the host row and the cache stay on disk; a banner asks for the update | keep showing the cached guild catalog without syncing | The orchestrator's reading of the decision above (`docs/handovers/o1-o2-nod.md`, "Owner decision 2026-10-17"); hiding the cached catalog was not in the owner's words | Proposto |

## 23. Questões abertas e riscos

Questões:

1. Quais ferramentas já têm OIDC apontando para um provedor nosso, e qual provedor — informação para
   a fase do host (F5), **não** bloqueio do v1: a cascata de login (§11) resolve sem essa resposta.
2. O Discord aceita rodar em webview com UA trocado, ou cai no navegador externo?
3. Passkeys/WebAuthn funcionam dentro do webview do runtime nas três plataformas?
4. Existe certificado Developer ID Application no time? Não é bloqueio (o atrito foi aceito), mas
   decide se F4 notariza ou fica no ad-hoc.
5. Há estratégia de assinatura para Windows (o runtime não documenta nenhuma)?
6. **Medir por execução** o custo de PBKDF2 com 600 000 iterações e do AES-GCM no runtime, e o
   comportamento do `subtle` para X25519 (a leitura de fonte confirma que existem:
   `saghul/txiki.js:src/js/polyfills/crypto/{kdf,ed,x25519,aes}.js`).
   **Answered by measurement (2026-10-16):** one PBKDF2 at 600 000 iterations takes ~0.4 s in the
   Nod runtime (383–427 ms, median 390 ms; ~43 ms in Bun), and AES-256-GCM, X25519, Ed25519 and
   HKDF are all native in both runtimes, with per-operation costs in `docs/tinyjs.md` §5 (stories H3
   and S0).
7. Entregar as credenciais das ferramentas a uma pessoa **antes** de existir o host: usar o selo
   X25519 na chave pública da pessoa, digitação única pelo administrador, ou esperar o host?
   Proposal on 2026-10-16: the X25519 seal, relayed by the host — `docs/epics/E02-credential-sharing.md`.
8. Alguma ferramenta exige VPN ou allowlist de IP, o que muda a promessa de "abre e funciona"?
9. Uma pessoa pode precisar de duas identidades na mesma ferramenta (por exemplo, conta pessoal e
   conta de trabalho no Discord)? Se sim, o desenho exige um segundo app com outro `id`.
10. Quantos palcos quentes a máquina real aguenta sem pesar — o padrão 3 é palpite até a medição?
11. Hospedar a casca em `nod.example.com` e usar abas por iframe: **adiado para a próxima
    sprint** (2026-10-15). O recorte a fazer lá é custo (deixa de funcionar offline) contra o ganho
    (abas de verdade, quando hospedar algo além das regras virar atrativo).
    Revisited on 2026-10-16 with a different goal — a browser portal served by the host, for clients,
    without iframe tabs: `docs/epics/E04-web-nod.md`.
12. Quantas pessoas recebem a release, e o seed embutido pode ser lido por quem recebe? Hoje isso é
    aceito (é organização, não segredo), mas convém saber se cada release é por pessoa ou por grupo.
13. Extensions and the team knowledge base (2026-10-17): what "instalada pelo cliente" means, how
    the admin enables a host extension, KB permissions, real-time co-editing — `docs/epics/E05-extensions-kb.md` §12.

Riscos:

| Risco | Efeito | Mitigação |
| --- | --- | --- |
| Adaptador de login quebra quando a ferramenta muda o formulário | Pessoa cai no login manual | Fallback sempre visível, evento de falha, adaptador versionado por entrada |
| Ferramenta recusa webview | Ferramenta inutilizável dentro da casca | UA override; `onNavigate` → navegador do sistema, com evento |
| Senha local esquecida | Cofre perdido, credenciais a reemitir | Aviso claro no cadastro e na troca de senha; o administrador reemite as credenciais; o catálogo continua intacto |
| Instalação com atrito no macOS | Todo mundo precisa liberar o app na primeira execução | Aceito pelo dono em 2026-10-15; passo a passo no README de distribuição |
| Catálogo local sem assinatura | Quem tem a máquina edita o que vê | Aceito até o host; catálogo assinado na F5 |
| Cookie de domínio amplo (`Domain=.example.com`) | Sessão de uma ferramenta alcança outra | Política de cookie por origin nas ferramentas; revisar ao integrar cada uma |
| Palcos quentes estourando memória | Máquina pesada com muitos sistemas abertos | Limite padrão de 3, configuração visível, descarte do mais antigo, medição na F1 |
| Seed embutido lido por quem recebe a release | Endereços, papéis e concessões deixam de ser privados do dono | Aceito: o seed não tem segredo; o que é secreto é a senha local e o cofre. Release por grupo, não por pessoa, enquanto isso não incomodar |
| Public releases carry the seed | Anyone can read the addresses, roles, grants and invite hashes of the release seed | The seed holds no secret (RF-27); with a host, org data comes from the host and the seed can shrink |
| Release sem seed por engano | App abre vazio para todo mundo | O caminho listado em `resources` que falta falha o build (`docs/tinyjs.md` §1) |
| Runtime jovem (0.x) | Mudança de API entre versões | `minTinyjsVersion` no `tinyjs.json`; docs do runtime lidas antes de codar; TINYJS_VERSION fixado no CI |
| Janela ocluída é throttled | Trabalho de fundo na página para | Todo trabalho contínuo no backend |

## 24. Fontes

Caminhos `Carna/…` e `_research/…` são relativos a
`/Users/caio/_Eclaire/_Workspace/Projects/_Aleph/`.

- Runtime: `https://tinyjs.app/docs.html`, `https://tinyjs.app/changelog`, `README.md` e
  `template/types/tiny.d.ts` de `tarwin/tinyjsapp`; referências destiladas em
  `tarwin/tinyjsapp-examples:trolley/.claude/skills/tinyjs/references/*.md`. Resumo em
  `docs/tinyjs.md`.
- Carna: `Carna/docs/Documento canônico do projeto — plataforma de times e conhecimento.md`,
  `Carna/apps/api/lib/carna/accounts/*`, `Carna/apps/api/lib/carna_web/*`,
  `Carna/packages/client-core/src/*`; corte em `docs/downscale-carna.md`.
- Processo do dono: `_research/_Guia/{README,processo,convencoes}.md` e
  `_research/Frentes/carna/{FRENTE.md,issues/}`.
