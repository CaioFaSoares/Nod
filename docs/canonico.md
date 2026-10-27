# Nod — documento canônico

Out 15, 2026 · @Caio

Base de requisitos da casca de ferramentas internas de um time. Este documento é a fonte única do
escopo, dos requisitos e das decisões propostas. Fatos do runtime ficam em `docs/electrobun.md`;
o corte da Carna fica em `docs/downscale-carna.md`. Nada aqui repete esses dois.

Toda afirmação sobre o que existe carrega caminho ou URL, e toda afirmação sobre o que funciona diz
como foi obtida. Nada aqui foi obtido por execução: é `leitura` de documentação e de código.

**0.8.0 (2026-10-27):** Electrobun é o único runtime. Onde este documento cita `docs/tinyjs.md`, o
fato equivalente está em `docs/electrobun.md`; o arquivo tinyjs fica como história da migração.

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
5. **Um fato, uma casa.** O que é do runtime mora em `docs/electrobun.md`; o que é da Carna mora em
   `docs/downscale-carna.md`.
6. **Sem código de terceiros dentro.** O Nod não tem sistema de extensões: ele cadastra endereços.
7. **Escopo fino.** Nada entra no v1 sem uma linha de requisito aqui. O que não está na lista é
   próxima sprint — hoje isso inclui hospedar a casca em `nod.example.com` e enquadrar sites que
   recusam framing.

## 2. Escopo

Dentro:

- Casca multiplataforma (macOS 15+, Windows 10/11, Linux glibc 2.35+) que roda como app de desktop.
- Catálogo cadastrado pelo administrador: título, endereço, ícone, vistas, papéis.
- Navegação por paleta e por janelas de ferramenta, com sessão de login preservada por ferramenta.
- Identidade local: conta por pessoa, criada por convite, com papéis.
- Cofre de credenciais por pessoa — **várias por ferramenta**, cada uma endereçada pelo próprio id
  (RF-65) —, no chaveiro do sistema, com preenchimento automático do login onde houver adaptador.
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
  (`docs/electrobun.md` §5).

Adiado para a próxima sprint, por decisão do dono (2026-10-15): mapear `nod.example.com` e as
abas por iframe. Só volta quando hospedar algo além das regras do sistema virar atrativo — e aí
deixa de ser casca fina (§23, questão 11). **Reopened on 2026-10-19 (RF-69) and closed again on
2026-10-22** (§22 "Seamless tabs: always inside, detach on demand"): the embedded-tab kind and its
login-block workaround were removed, so hosting the shell on its own origin — to frame sites that
refuse framing — stays deferred.

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

`docs/electrobun.md` é a casa dos fatos. As quatro consequências que moldam este documento:

1. **Não há abas nativas e não há como compor sites de terceiros numa página.** O modelo é
   multi-janela; `win.open` abre `page` como URL `http(s)` ou página local (`docs/electrobun.md` §5).
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
from inside a tool opening as tabs next to it. **Built in 0.6.0** (2026-10-19): the docked model —
tabs, the tab strip, detach and dock, ad-hoc tabs and restore — follows the design in
`docs/epics/E03-docked-tabs.md`. The table below describes the **Windows** mode, which since
2026-10-22 survives only as the runtime's fallback where windows cannot be positioned (Wayland):
there is no Docked/Windows setting any more (§22 "Seamless tabs: always inside, detach on demand").

| Peça | O que é |
| --- | --- |
| **Janela principal** (`main`) | A única janela do Nod para gerenciar e usar: moldura nativa, redimensionável. À esquerda, a **sidebar** com um ícone por ferramenta permitida (dígito, estado: aberta, carregando, falhou) e, no rodapé, Settings e Lock. À direita, o conteúdo: **Home** (cartões das ferramentas, com abrir, vistas, fechar e o resultado de login) ou **Settings** (conta, cofre e, para o admin, ferramentas, papéis, pessoas, auditoria, catálogo). A tela de entrada (criar conta, entrar, convite, Touch ID) também vive nela. |
| **Paleta** (`⌘K`) | Overlay dentro da janela principal: busca ferramentas, vistas e ações (Home, cada aba de Settings, Lock, Quit). |
| **Janela de ferramenta** | Cada ferramenta abre numa janela própria, com moldura nativa, independente, aberta a partir da janela principal. Clicar de novo numa ferramenta já aberta só a traz para a frente — sem recarregar. |

Regras:

- **Iframe, não (2026-10-22)**: the embedded-tab kind (RF-69, RF-70) is removed; no third-party site
  is framed inside the page. A tool always opens as a tab in the Nod window and detaches into its own
  window on demand, so there is no per-tool "Show inside Nod" choice and no framing headers to reason
  about (§22 "Seamless tabs: always inside, detach on demand"). Hosting the shell to frame sites that
  refuse framing stays out of scope (§2).
- **Vista** é um endereço nomeado dentro de uma ferramenta, com modo `window` (janela própria — o caso
  de boards) ou `navigate` (navega a janela já aberta da ferramenta — o caso de pastas de e-mail; se
  ela não estiver aberta, abre direto no endereço da vista).
- **Estado de carregamento e falha** aparecem na sidebar e no cartão da ferramenta na Home, com
  "try again"; nenhuma janela extra de carregamento.
- **Tabs**: a tool can have several tabs (`⌘T` opens one); switching hides the current tab and shows
  the next, so it never reloads and the page keeps its state.
- **Detach and dock**: `⌘⇧D` takes a tab out into its own framed window and brings it back onto the
  panel, always the same window and the same page — no reload.
- **Ad-hoc tabs**: an address outside the catalog, or a link clicked inside a tool, opens as a tab
  next to its source; it is not saved, not restored, and gets no backend method and no autofill
  (RF-66…RF-68).
- **Atalhos**: `⌘1`…`⌘9` abrem/trazem a ferramenta do dígito, `⌘K` abre a paleta, `⌘,` Settings. Na
  janela principal funcionam pela própria página; nas janelas de ferramenta, o teclado é do site, então
  os mesmos atalhos são registrados como **globais** (`tiny.hotkey.register`) **só enquanto alguma
  janela do Nod está focada** — registrados o tempo todo, roubariam `⌘1` e `⌘K` de outros apps. Se o
  sistema pedir permissão de acessibilidade, isso entra no passo de instalação — a confirmar por
  execução.
- **Keyboard**: ⌘T new tab, ⌘W close tab, ⌃Tab next tab, ⌘⇧D detach/dock, ⌘L open link, ⌘D save tab
  to sidebar.
- **Restauração**: as janelas de ferramenta abertas são lembradas e reabertas no próximo desbloqueio,
  só as que a pessoa ainda pode ver.
- **Fechar a janela principal** a esconde quando há bandeja (`Open Nod`, `Lock`, `Quit Nod`); as
  janelas de ferramenta continuam abertas. Sem bandeja (Linux sem AppIndicator), fechar encerra o app.
- **Windows e Linux (0.8.0)**: o runtime não re-parenta uma view viva entre janelas, então não há
  abas encaixadas nessas plataformas. O backend lê `canDock: false` em `win.getState()` e usa o
  **modo janelas** (uma janela emoldurada por ferramenta, sem recarregar ao reabrir); a faixa de abas
  fica vazia. macOS mantém o modo encaixado. Ver `docs/electrobun.md` §5.
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
  build refuses an `app.json` without them (`scripts/gen-electrobun-config.ts`).
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
- **`popups` e `downloads` são chaves do app, não da entrada** (`docs/electrobun.md` §5): o padrão vive
  no `app.json` e o refino por ferramenta acontece nos hooks do backend — `onWindowOpen` decide
  por origin entre `window`, `external` e `deny`, e `onDownload` registra o que aconteceu. Isso
  importa para o webmail (anexo e "abrir em nova janela") e para o Discord (OAuth).
- **Ícones** ficam no diretório de dados do app, com hash no nome; a página da casca recebe o ícone
  por RPC (data URI), para não depender de `readAccess`. No cadastro, o backend busca
  `apple-touch-icon`, os `<link rel=icon>` ou `og:image` da própria página (o backend não tem CORS —
  `docs/electrobun.md` §5) ou aceita um arquivo enviado pelo administrador. ICO fica de fora: não há
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
  sempre devolve `false`** — `docs/electrobun.md` §7 —, então lá o caminho é sempre a senha).
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
  sistema operacional protege (`docs/electrobun.md` §4).
- O banco local guarda só o índice: ferramenta, rótulo, usuário, chave no chaveiro, datas. Nunca o
  valor.
- **Autenticar e pronto**: a pessoa digita a senha local uma vez (ou usa biometria onde existe) e a
  sessão está aberta — a casca lê as credenciais do chaveiro e preenche os logins. Não há segundo
  portão, nem cofre separado para desbloquear, nem frase extra.
- O valor é **somente string** e o chaveiro do Windows recusa acima de 2560 bytes UTF-8
  (`tarwin/tinyjsapp-examples:trolley/.claude/skills/tinyjs/references/api.md` §"Store / secrets /
  sqlite"). Remover a credencial apaga o item do chaveiro e a linha do índice.
- **0.5.1 (RF-63, §22 "One keychain access", Proposto)**: the keychain keeps only the biometric
  item `nod.bio.<pessoa>` (the `vaultKey`); each `nod.cred.*` value is the same `bv1.` envelope
  under that `vaultKey`, kept in the `secret` table of `nod.db` under the same key. Outside the
  biometric item the Nod never reads, writes or deletes a keychain item in normal use; values an
  older Nod left there are copied once, read-only, after the first unlock, and the old items stay.
- **0.7.0/0.8.0 (Electrobun)**: biometric unlock is off (`biometricUnlock: false`, §22 "No Touch ID
  unlock on Electrobun"), so the `vaultKey` lives only in memory after the password unlock and the
  app never touches the system keychain. Windows/Linux have no keychain helper; the sealed values in
  `nod.db` are the vault there too.
- **Limite honesto do chaveiro**: no macOS a ACL é por binário que gravou — um segredo salvo sob
  `eb:dev` faz o app construído pedir permissão uma vez, e reassinar o app pede de novo
  (`docs/electrobun.md` §4). Qualquer processo rodando como o mesmo usuário consegue ler o item; o que a
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
  (`"inject"`, roda em qualquer origin) e `app.window(id).eval` em runtime (`docs/electrobun.md` §5).
  O adaptador é código nosso, versionado, mínimo, e **nunca** avalia dado vindo da página. O
  adaptador genérico procura os campos de login; o `auth_override` da entrada troca o genérico por um
  específico quando a ferramenta foge do padrão — e nenhum dos dois é obrigatório para cadastrar.
- **A casca aprende, o administrador não decide**: o resultado de cada passo (logado pela sessão,
  preenchido pelo adaptador, resolvido pelo provedor, ou manual) vira um **evento** (§13) e é o que a
  tela da entrada mostra como "como esta ferramenta costuma entrar".
- **Entregar credenciais a alguém antes de existir o host**: selo para a chave pública X25519 da
  pessoa (WebCrypto do runtime) ou digitação única
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
| RF-26 | (O núcleo "build exige o seed" foi superseded por RF-61, 2026-10-17. Antes: o build da release exige o seed privado e a release abre já com catálogo, papéis e concessões.) | — |
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
| RF-49 | In docked mode, the open tab fills the center panel and follows the main window's size and position. Docked mode is offered only where the runtime can position windows (`canPosition !== false`, i.e. not Wayland). | Resize and move `main`: the tab stays on the panel without a visible gap at rest. |
| RF-50 | A tool can have several tabs; switching tabs never reloads. | Two Claude tabs, a draft typed in one; switch away and back: the draft is still there. |
| RF-51 | A tab detaches into its own window and docks back without reloading. | Type a draft in a Claude tab, detach, move it to another screen, dock it back: the draft is still there and the page never reloaded. |
| RF-52 | (Superseded by §22 "Seamless tabs: always inside, detach on demand", 2026-10-22. What remains of it: Windows mode — one framed window per tool — survives only as the runtime's fallback where windows cannot be positioned (Wayland); there is no Docked/Windows setting any more.) | — |
| RF-53 | Each credential has a sharing scope — role, blocked or org — enforced on send and re-send. | A "role" credential can't be sent to someone with no common role; a "blocked" one offers no send at all. |
| RF-54 | Each credential shows its holders. | After Alice sends Figma to Bob, both see "Alice, Bob" with date and scope. |
| RF-55 | The Nod notices on its own when a newer release exists and tells the person, without them opening Settings. | With a release `release-X.Y.Z` newer than the installed version published, the Nod shows a new-version notice within one launch or one day; with none, no notice. |
| RF-56 | A build can carry a custom app icon without editing tracked files. | With `resources/icon.png` or `NOD_ICON` set, the built app shows that icon; without it, the default; `git status` stays clean. |
| RF-57 | An admin sets a guild icon; each person chooses Default or Guild icon for their app. | Admin uploads a PNG; after sync a member's Settings offers Guild icon and choosing it changes the Dock/taskbar icon; a tampered icon (hash not matching the signed snapshot) is refused. |
| RF-58 | A connected Nod shows who in the guild is online now. | With two people connected, each sees the other under "Online now" within one sync (≤ 6 min); a person who locked or quit drops off within 6 min; a revoked or disabled person never appears; local mode shows nothing. |
| RF-59 | Guild invites. An admin creates an invite with roles, a max-use count (or unlimited) and an expiry (or never); the host answers a `nod://join?host=…&fp=…&code=…` link plus a code shown once, and the admin lists and revokes invites. Whoever opens the link sees the guild (name, icon, roles, fingerprint, uses left, expiry) and creates the account they choose (name, email, password); the host creates the person with the invite's roles and spends one use (`shared/host-api.ts`, `docs/specs/SP03-host-api.md`). | A used-up, expired or revoked invite answers `invalid invite`; an invite with roles `[team]` creates a person who sees exactly the `team` tools; redeeming with an email already held does not spend a use. |
| RF-60 | Entry screen. The locked screen is a Discord-like rail of tiles — Offline (this machine's profile), the guild (its icon or initials) and `+` (join a guild / set one up) — and choosing a tile then giving the password enters that way. `offline` runs the local catalog with no sync and no host call (the same disconnect as RF-30/O2); `guild` connects as today. The last used tile is preselected (`shared/types.ts` `EntryProfiles`). | With no host the rail shows Offline and `+`; with a host the guild tile appears and the last used tile is preselected; entering Offline shows the local catalog and makes no host request. |
| RF-61 | The seed is an optional import. `bun run eb:build` no longer requires `resources/seed.json`, and a release without one starts empty; the first-run Offline tile offers "Import a seed file" (`session.importSeed`) only while no account exists. Embedded-seed releases keep working as before — gate origins, camera/mic and the update URL still come only from an embedded seed (`docs/canonico.md` §19). | A build without the seed produces a valid config with no `seed.json` in `resources`; a fresh install offers the import while it has no account and hides it after one exists. |
| RF-62 | Tool categories. A guild admin gives each org tool a display category — a free name of 1 to 40 characters, trimmed, control characters refused, empty meaning none — and the Nod shows the org tools grouped by category: a labelled divider per group in the sidebar, one section per category in Home with "Other tools" for the unfiled ones, and the same grouping in Settings → Tools, with the personal tools and favorites as they were. The category travels in the snapshot, in the seed and in the host's admin routes (`shared/types.ts` `Entry.category`, `shared/catalog.ts` `groupByCategory`, `entries.category`). | The sidebar draws one labelled divider per category and Home one section per category, the unfiled org tools read last as "Other tools", and ⌘1…⌘9 follow that visual order; a catalog with no category looks exactly as it did before, and the admin sets a category in Settings → Tools with the names already in use offered as suggestions. |
| RF-63 | One fingerprint, one keychain access (built in 0.5.1; the storage it rests on is the Proposto row "One keychain access (0.5.1)" in §22, waiting for the owner's reading). The system keychain holds one item per person — `nod.bio.<person>`, the `vaultKey` biometrics unlocks (SP02 §9) — and nothing else of the Nod: the credentials, the E02 pair and the guild bearer are `bv1.` values under that `vaultKey` in the local `secret` table (`backend/secret-store.ts`). The entry screen and the password unlock never read the keychain (`biometric_people` in `store.json` answers whether the biometric button shows); a biometric unlock reads the item once, after `app.authenticate`; no other read, write or delete reaches the keychain. Items an older Nod left in the keychain are copied to the table once, read-only, after the first unlock (marked done in `meta`), and are never touched again. The fingerprint then covers the gated actions for 15 idle minutes (§22 "Gate once per session, with a timeout"). | On macOS with biometrics enabled, opening the app, unlocking with Touch ID, joining or signing in to a guild and opening tools that fill credentials asks for the fingerprint once and nothing else; the only keychain prompt left is, after a new unsigned build, the one for the biometric item; after the first unlock on 0.5.1 no other keychain item of the Nod is read again. |
| RF-64 | Guild owner. The person the setup code created is the guild **owner** (host `meta.owner_id`, migration 7; `AdminPerson.owner` in `shared/host-api.ts`); only the owner renames a person or edits their email, and only the owner deletes people, never the owner (including themselves); roles and disable stay admin-level, but the owner never loses their admin role nor gets disabled — `roles` without an admin role and `disabled: true` aimed at the owner are `403 the owner keeps an admin role` / `403 the owner cannot be disabled` whoever asks, the owner included, and the same protects the owner's only admin role from a role demotion or delete — and a delete is a hard delete of the person with everything cascading, their events and shares included (`docs/specs/SP03-host-api.md`, `docs/specs/SP01-host-data-model.md`). An invite call to a host that predates 0.5.0 stops being reported as a missing role and says the host must be redeployed (`HOST_TOO_OLD`, `backend/host-admin.ts`). | The owner renames a person and edits their email and both reach the next sync; another admin renaming answers `403 owner only` or editing to an email already held answers `409 email taken`; nobody deletes the owner (`403 the owner cannot be deleted`) and a delete that would leave the guild with no admin answers the existing `409`; a write that would leave the owner without an admin role or disable them answers `403` whoever asks, the owner included; inviting on a pre-0.5.0 host says the host must be redeployed, never "the guild has no such role". |
| RF-65 | Several credentials per tool. A person's vault holds as many credentials of one tool as they want, each addressed by its own `VaultItem.id`; sharing (`shares.send`), assignment (`assignments.set`, to a role or a person), scope, holders and revocation act on the one credential the person picks, never on "the tool's credential"; exactly one is the tool's **default** (`VaultItem.isDefault`), which the login cascade fills (`shared/types.ts` `VaultItem`, `backend/repo.ts`, `backend/vault.ts`; `docs/specs/SP05-nod-connected.md` §2–§3). | With two credentials of one tool in the vault, sending the second leaves the first untouched and only its own holders list grows; the tool window fills the default; a `vault.save` without `itemId` adds a credential and with an `itemId` whose tool differs answers `invalid credential`; removing the default promotes the oldest remaining credential; a `vault.*`/`shares.*`/`assignments.set` call with an unknown or foreign `itemId` answers `unknown credential`. |
| RF-66 | Any `http(s)` link opens in the Nod: links clicked inside a tool open as a tab next to it; the palette and `nod://open?url=` open one by hand. | A documentation link on a Kanban card opens as a tab right after the Kanban tab; pasting a URL in "Open link" or calling `nod://open` does the same. |
| RF-67 | Any tab is saved to the sidebar in one step: a personal view when its origin is already a tool, otherwise a personal tool with probed title and icon. | Save a Claude chat URL: it appears under Claude; save a new site: it appears as a new icon with its title and icon, no typing. |
| RF-68 | An ad-hoc tab gets no backend methods and no autofill. | Calling `tiny.api.call` from an ad-hoc origin is refused; no credential is filled there. |
| RF-69 | (Superseded by §22 "Seamless tabs: always inside, detach on demand", 2026-10-22.) | — |
| RF-70 | (Superseded by §22 "Seamless tabs: always inside, detach on demand", 2026-10-22.) | — |

## 15. Requisitos não funcionais

| ID | Requisito |
| --- | --- |
| RNF-01 | Multiplataforma: macOS 15+, Windows 10/11 com WebView2, Linux glibc 2.35+ com `webkit2gtk-4.1`. Nenhuma função pode quebrar fora do macOS: testar `capabilities().x !== false` antes de usar (`docs/electrobun.md` §5). |
| RNF-02 | Pegada: binário na casa dos 6 MB, app ocioso abaixo de 100 MB, casca utilizável em menos de 1 s, janela de ferramenta sem flash de chrome errado (chrome declarado no `win.open`). |
| RNF-03 | Offline: catálogo, papéis, concessões, cofre, auditoria, admin e restauração de janelas funcionam sem rede. |
| RNF-04 | Segurança: gate `api.origins` por origin exata, nunca `"all"` nem `"wrapper"` para terceiros; segredo só no chaveiro (0.5.1, RF-63, Proposto: os valores ficam em `nod.db` selados com o `vaultKey`, que é derivado da senha local; o chaveiro guarda o `vaultKey` só quando a biometria está ligada); HTTPS obrigatório fora de loopback; adaptador de login é código nosso e mínimo; sem telemetria externa. |
| RNF-05 | Privacidade: nenhum dado sai da máquina sem ação explícita; eventos ficam locais até existir host. |
| RNF-06 | Manutenção: TypeScript estrito; um fato em uma casa; nenhuma dependência que exija rede para compilar. |
| RNF-07 | Teclado: toda ação alcançável por teclado, com a paleta como caminho principal; atalhos globais opcionais. |
| RNF-08 | Language: the app is entirely in English — interface, messages, identifiers, API, tests (owner, 2026-10-15). From 2026-10-16, project documents are written in English too (owner: "é pra tudo ser em ingles a partir de agora"); existing pt-BR text stays until it is rewritten. |
| RNF-09 | Trazer para a frente uma ferramenta já aberta é perceptível como instantâneo: menos de 150 ms entre o clique e a janela à frente; nunca recarrega a página. |
| RNF-10 | Criptografia: a senha local é hash PBKDF2-HMAC-SHA256 (salt de 16 bytes, parâmetros versionados); os valores do cofre são `bv1.` AES-256-GCM sob o `vaultKey` (SP02 §8); o export opcional usa a mesma cifra, com nonce por gravação. No Electrobun o `vaultKey` vive só em memória e o chaveiro não é tocado (biometria desligada); senha e chave derivada nunca tocam o disco nem entram em evento, log ou `store.json`. |
| RNF-11 | (Retirado na v2 junto com o RF-22.) |

## 16. Modelo de dados local

SQLite no backend (`tjs:sqlite`, síncrono), no diretório de dados do app: pessoas e papéis, catálogo
(ferramentas, vistas, concessões, última sonda), convites (só hash), índice do cofre, eventos e meta.
O schema exato, com os nomes em inglês do código, mora em `docs/arquitetura.md` §4
(`backend/repo.ts`). Segredo só no chaveiro do sistema (§11); nenhum arquivo do app guarda valor de
credencial em claro — desde 0.5.1 (RF-63, Proposto) a tabela `secret` guarda os valores `bv1.` selados
com o `vaultKey`, derivado da senha local (SP02 §1); o chaveiro o guarda só com a biometria ligada. O
`store.json` guarda só preferências e a lista de janelas abertas para restauração (e, desde 0.5.1,
`biometric_people`: quem tem biometria ligada, nunca a chave).

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
  `(await app.paths()).resources` (`docs/electrobun.md` §4), então a release carrega as regras sem
  servidor e sem rede. O `electrobun.config.ts` também é gerado (`scripts/gen-electrobun-config.ts`,
  gitignored), porque a origem e o canal de atualização saem do seed e não podem vazar para o git.
- **Build sem seed falha de propósito** — **superseded pela "Seed as optional import" (0.5.0,
  RF-61)**: desde 0.5.0 `bun run eb:build` não exige mais `resources/seed.json`, uma release sem
  ele abre vazia e o tile Offline do primeiro uso oferece "Import a seed file" (`session.importSeed`)
  enquanto não houver conta. O gate de origins, camera/mic e a URL de atualização continuam vindo só
  de um seed embutido — a decisão e as citações do dono estão em §22, e o passo a passo em
  `docs/distribuicao.md` §1–§2.
- **Dev roda sem seed**: abre vazia, com aviso, para quem está desenvolvendo; desde 0.5.0 a release
  também pode rodar sem seed (RF-61).
- **Primeiro boot aplica o seed** e depois o que vale é o banco local: a pessoa edita, o
  administrador importa um seed novo (RF-13) ou, mais adiante, o host manda o catálogo (RF-18).
- **O seed não carrega segredo de ninguém**: nem senha de pessoa, nem credencial de ferramenta. Ele
  traz endereços, ícones, papéis e concessões — organização, não credencial. O que é secreto continua
  no cofre, cifrado pela senha local (§11).
- **Env travada**: a release fixa a versão do Electrobun/Hutch (`package.json`) e o `id` do app; não existe endpoint configurável
  em runtime que redirecione catálogo ou atualização. Isso é o que o dono chamou de "envs travadas".
  **Superseded for the catalog on 2026-10-16** (owner: "env travada era algo como uma versão mais
  simples inicial"): the host address is configurable at runtime and the host is the central core
  (`docs/epics/E01-connected-mode.md` §2, §8). The Electrobun/Hutch version and the app `id` stay fixed per release.

**Depois do seed, a página de build normal:**

- `bun run eb:build` por sistema (Electrobun 2.0.5 / Hutch 0.28.2); a release job publica o zip do
  `.app` macOS + `manifest.json` (sha256) e, no Windows/Linux, o instalador e o
  `stable-<os>-<arch>-update.json`/`.tar.zst` do runtime. O app atualiza pelo `manifest.json` no macOS
  e pelo `Updater` do Electrobun no Windows/Linux (`docs/electrobun.md` §6,
  `docs/distribuicao.md` §8). É o passo seguinte do que o dono descreveu: hoje ele manda a release na
  mão, amanhã a release se valida online e se atualiza sozinha (F5).
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
| Site de terceiro (ou um subdomínio comprometido) chamando o backend da casca | Gate de origin observado pela view: `main` tem a API toda só na origin do app, uma ferramenta só alcança `login.report`, e o backend confere de novo a origin da entrada (`docs/electrobun.md` §5). |
| Segredo guardado em arquivo do app | Nenhum em claro: desde 0.5.1 (RF-63, Proposto) o banco local guarda só valores `bv1.` selados com o `vaultKey` (AES-256-GCM, AAD = a chave do item) e o índice; o `vaultKey` é derivado da senha local e vive só em memória; o `store.json` nada secreto. Valor nunca entra em evento ou em log (`docs/electrobun.md` §4). |
| Alguém na máquina sem a senha | A casca não abre, não lista catálogo, não injeta login; erro único e espera crescente depois de tentativas; no Electrobun não há biometria, então o portão é só a senha (falha fechado, `docs/electrobun.md` §5). |
| Credencial lida por outro processo do mesmo usuário | O cofre é selado no `nod.db`; o que a senha local protege é o uso das credenciais pela casca, não o arquivo contra a própria conta do sistema. O export opcional (RF-28) fica cifrado sem a senha (`docs/electrobun.md` §4). |
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
| 0.5.0 — Discord-like entry and invites (2026-10-17) | The entry screen becomes a Discord-like rail of Offline/guild/`+` tiles; guild invites with roles, uses and expiry, redeemed by whoever opens the link with the account they choose; the seed turns into an optional import at setup — RF-59 to RF-61. | RF-59 to RF-61 on the real surface (`docs/canonico.md` §14); a seedless build produces a valid config. |
| 0.5.1 — One keychain access (2026-10-17) | Every secret but the biometric item leaves the system keychain for the `secret` table of `nod.db`, sealed under `vaultKey`; the entry screen stops reading the keychain — RF-63. | RF-63 on the real surface; `bun test test/` (`test/secret-store.test.ts` and the RF-63 tests of `test/session.test.ts`). |
| 0.5.2 — No keychain outside Touch ID (2026-10-17) | 0.5.1 still reached the keychain on a table miss and deleted old items on writes, and each call was a password prompt on a new build; 0.5.2 never touches the keychain outside the biometric item (a one-time, read-only import replaces both), and one confirmed gate covers reveal/copy/send/accept for 15 idle minutes — RF-63, §22 "Gate once per session, with a timeout". | `bun test test/ host/` (983) and `bun test/smoke/connected.ts --force` (111 steps). |
| 0.5.3 — Guild owner manages people (2026-10-18) | The person the setup code created is the guild owner: only they rename people, edit emails and delete them (a hard delete that takes the person's events and shares with them), while roles and disable stay admin-level; and an invite call to a host that predates 0.5.0 stops being reported as a missing role and says the host must be redeployed — RF-64. | `bun test test/ host/` (998), `bun test/smoke/connected.ts --force` (111 steps) and `bun test/smoke/ui.ts --force` (the three `RF-64` checks of `admin-final`; the driver now shows its window, `docs/tinyjs.md` §3). |
| 0.5.5 — Several credentials per tool, categories that show (2026-10-18) | A person's vault holds several credentials per tool, each addressed by its own `VaultItem.id`; sharing, assignment, scope, holders and revocation act on one chosen credential, and one default per tool fills the login — RF-65. Plus the RF-62 fix: a category set while connected never reached the host because `backend/host-admin.ts` `orgTool()` omitted `category`; now it carries it, so a saved category comes back on the next sync and Settings → Tools groups the org tools by category like Home. | `bun test test/ host/`, `bun test/smoke/connected.ts --force` and `bun test/smoke/ui.ts --force`. |
| 0.5.5a — Status as a toast, hotfix versions (2026-10-18) | Settings' status line ("… granted to …", "Saved …", errors) is a toast fixed at the bottom of the window, out of the layout, so a message never moves the buttons under it; it closes on a click or after 4 s (8 s for an error). Versions gain hotfix letters after the patch (`0.5.5a`): the release workflows accept them and the Nod offers a hotfix itself, because the runtime's update check reads only three numbers (`docs/distribuicao.md` §8). | `bun test test/ host/` (`test/version.test.ts`) and `bun test/smoke/ui.ts --force`. |
| 0.5.6 — Reaches the 0.5.5 installs (2026-10-19) | 0.5.5 never offered 0.5.5a: its runtime's update check reads only three numbers and the letter-aware check started in 0.5.5a itself. The same build goes out as 0.5.6, which every install on 0.5.5 or 0.5.5a sees and installs on its own (`docs/distribuicao.md` §8). | Published manifest `version` = `0.5.6`; `bun test test/ host/`. |
| 0.6.0 — Docked tabs and quick links (2026-10-19) | Docked mode is the default on macOS (`docs/canonico.md` §22 "Docked mode per OS"): the open tab lies frameless on the main window's center panel, several tabs per tool, and switching tabs never reloads; a tab detaches into its own window and docks back with the same page (RF-49…RF-52). The strip draws the tabs and ⌘T/⌘W/⌃Tab/⌘⇧D/⌘L/⌘D act on them; links clicked inside a tool open as ad-hoc tabs next to it, and the palette or `nod://open?url=` opens one by hand; any tab is saved to the sidebar in one step (RF-66…RF-68). Tabs, their order, addresses and docked/detached state are restored. Windows and Linux keep Windows as their default until their spikes run, and Wayland is not offered. | `bun test test/ host/`, `bun run typecheck`; real-surface smoke `bun test/smoke/tabs.ts` on macOS only, unlocked screen with OmniWM active: 6 of 8 runs passed all 17 steps (`docs/handovers/e03-smoke.md` §3). Windows and Linux not run. |
| 0.6.0a — Embedded tabs (2026-10-19) | On macOS, in docked mode, a tool whose address may be framed opens as an embedded tab — an iframe inside the main window, no OS window, so a tiling window manager cannot move it — chosen per tool and per machine ("Show inside Nod" / "Open as window"); refused with the header as the reason when the site forbids framing; never detached, no autofill (RF-69, `docs/epics/E03-docked-tabs.md` §8). A Windows→Docked switch with every tab detached now lands on the strip. | `bun test test/ host/`, `bun run typecheck`; real-surface smoke `bun test/smoke/tabs.ts` on macOS (`docs/handovers/e03-smoke.md` §6: the RF-69 steps passed; window-geometry steps blocked by the tiling WM). A framed login sticks only in a release build. |
| 0.6.0b — Open tabs button, sign-in copy for embedded tabs (2026-10-19) | In docked mode a button under the guild mark shows the tab strip from anywhere, with the count of open tabs (disabled with none, absent in Windows mode). An embedded tab whose tool has a saved credential cannot be filled (no script reaches an iframe, `docs/handovers/e03-iframe-spike.md`): "Show inside Nod" warns about it, and the tab's "Sign in" copies the username and, behind the gate, the password to paste. | `bun test test/ host/`, `bun run typecheck`; real-surface smoke `bun test/smoke/tabs.ts` (`docs/handovers/e03-smoke.md` §7). |
| 0.6.0c — Login-blocked tools stay windows (2026-10-19) | A tool whose login cannot survive an iframe is never embedded on this machine: `tabs.checkEmbed` flags a `SameSite=Strict`/`Lax` cookie from the entry response or from the page's own script, "Show inside Nod" is refused with that reason, and the embedded tab's "Login won't stay? Open as window" reports it through `tabs.reportLoginFails`; a flagged tool's embedded tabs become window tabs in place, where the login is filled (RF-70, `docs/epics/E03-docked-tabs.md` §8). | `bun test test/ host/`, `bun run typecheck`; real-surface smoke `bun test/smoke/tabs.ts` (`docs/handovers/e03-smoke.md` §8). |
| 0.7.0 — Electrobun on Apple silicon, seamless tabs (2026-10-23) | Apple silicon Macs run on Electrobun: every tool is a tab inside the window — a native view, Claude included, autofill working — detachable into its own window and back without reload; no Window mode setting, no iframe kind (§22 "Seamless tabs…"). Intel Macs, Windows and Linux run the same code on tinyjs (frameless windows over the panel): Electrobun 2.0.4 publishes no `darwin-x64` build. An Apple silicon Mac on 0.6.0c updates on its own through one `manifest.json` (`docs/distribuicao.md` §8): account, vault, preferences and guild icon come along; tool sessions do not (each tool signs in again once), and on Electrobun the vault unlocks by password only (§22 "No Touch ID unlock on Electrobun"). | `bun run validate --smoke` (typecheck, unit tests, build, the four real-surface smokes on both runtimes); migration measured end to end on a throwaway identifier (`docs/handovers/e07-migration.md`); parity record `docs/handovers/e06-parity-matrix.md`. Windows and Linux Electrobun not run. |
| 0.7.0a — Clicks reach the window with a tab open (2026-10-27) | On Electrobun, a tab hidden behind Home, Settings, a dialog or another tab, or detached into its own window, no longer takes the clicks of the controls under the slot: Electrobun 2.0.4's `ContainerView` moved the page's own webview off-screen whenever the mouse crossed such a tab. `NodNative` makes every webview answer `shouldSuppressMirrorMode` with true, a hidden tab lets the mouse through (`webviewSetPassthrough`), and a new docked view is placed through `resizeWebview` at creation (`docs/handovers/e06-parity-smoke.md` §8). | `bun run validate --smoke` (12/12); the tabs smoke now clicks with the real mouse (`test/smoke/click.swift`): without the fix "Bring to front" on Home over a hidden tab never received the click, with it 19/19 on Electrobun (§8 there). |
| 0.7.0b — Nod opens after the brew install (2026-10-27) | A Mac whose `nod.bio.<person>` item an older tinyjs build wrote no longer quits at every launch: the keychain refuses the 0.7.0 sweep's deletion ("Invalid attempt to change the owner of this item"), and that refusal ended the backend's `init`. The item now stays where it is (never read), its flag is cleared, and the boot goes on (`backend/session.ts` `purgeBiometricItems`, `docs/handovers/e07-migration.md` §7). | `bun run validate` (4/4) with a test that fails without the fix; the 0.7.0a bundle installed by brew reproduced the quit (`backend init failed … keychain delete`); the 0.7.0b release zip, unpacked like brew does, opened its window on the first launch (self-extraction) and on the second. |
| 0.7.0c — Close all tabs (2026-10-27) | The strip opens with a "close all" button (×) before the first tab, and the palette offers "Close all tabs": every tab goes, docked or detached, the panel goes back to Home, and none reopens at the next unlock (`tabs.closeAll`, `backend/tool-windows.ts` `closeAllTabs`). Owner on 2026-10-27: "quero aqui ter um botao de fechar tudo". | `bun run validate --smoke`; the tabs smoke clicks the button with the real mouse with a docked and a detached tab open (`docs/handovers/e06-parity-smoke.md` §8). |
| Próxima sprint (fora das fases) | Mapear `nod.example.com` e as abas por iframe, e decidir se hospedar algo além das regras passou a ser atrativo. | Um recorte escrito com o custo (casca deixa de funcionar offline) e o ganho. |

## 22. Registro de decisões

Status: `Proposto` espera leitura do dono; `Aberto` espera pesquisa; só o dono vira uma decisão em
`Decidido`.

| Área | Decisão | Alternativas | Motivo | Status |
| --- | --- | --- | --- | --- |
| Runtime | TypeScript sobre Electrobun (Bun + webview nativa) | Electron; Tauri; tinyjs | Pedido do dono; multiplataforma (macOS/Windows/Linux); sem servidor HTTP. **Superada em 0.8.0: Electrobun é o único runtime** (§22 "One runtime: Electrobun") | Superada (2026-10-27) |
| Janela única de gerenciar/usar | Uma janela principal com sidebar, Home, paleta e Settings; cada ferramenta em janela própria aberta a partir dela | rail ancorado + palcos encostados; janelas separadas para admin, paleta e carregando | Dono em 2026-10-15: "tudo em uma janela só para o lado de gerenciar/usar, aí abrimos as janelas a partir daí" | Decidido (2026-10-15) |
| Idioma do app | Todo o app em inglês: interface, mensagens, identificadores, API, tipos, testes; docs de projeto em pt-BR | só a interface em inglês | Dono em 2026-10-15: "tudo deve estar em inglês" (escopo escolhido: o app inteiro) | Decidido (2026-10-15); docs part superseded by "Project docs language" |
| Project docs language | Everything written from 2026-10-16 on is in English, project documents included; existing pt-BR text is not translated in bulk | keep project docs in pt-BR | Owner on 2026-10-16: "é pra tudo ser em ingles a partir de agora" | Decidido (2026-10-16) |
| Troca de sistema | Clicar ou `⌘N` traz a janela da ferramenta para a frente; abre se não estiver aberta | — | Pedido do dono (troca rápida), mantido na v2 sem palcos | Decidido (2026-10-15) |
| Moldura integrada | Superada pela "Janela única de gerenciar/usar" (2026-10-15) | — | — | Superada |
| Palco pré-aquecido | Superado pela janela única (RF-22 retirado) | — | — | Superada |
| Aba nativa | Não existe: agrupar janelas é do SO | tabbing do SO | O runtime não tem tabbing (`docs/tinyjs.md` §3) | Proposto |
| Abas de verdade numa janela | **Adiado para a próxima sprint** (2026-10-15): exigiria hospedar a casca num origin do mesmo site e iframar as ferramentas | manter o rail com palcos | Decisão do dono: mapear quando hospedar algo além das regras ficar atrativo; hoje custaria o funcionamento offline. RF-69 (0.6.0a) entregou a aba em iframe para as ferramentas que podem ser enquadradas, removida em 2026-10-22 (§22 "Seamless tabs: always inside, detach on demand"); hospedar a casca, para as que recusam, continua adiado | Adiado |
| Release privada com seed travado | O dono monta a release com os JSONs de regras embutidos, fora do git, e distribui na mão | catálogo no repo; catálogo só importado à mão | Decisão do dono em 2026-10-15: "releases com envs travadas de jsons que eu ignoro" | Decidido (2026-10-15) |
| Seed embutido em `resources/` | Arquivo privado listado em `resources`, empacotado pela release; build sem ele falha | importar o seed à mão na primeira execução | O runtime já empacota `resources/` e falha o build quando o caminho falta (`docs/tinyjs.md` §1) | Superada (por "Seed as optional import") |
| Validação online e auto-update | Depois do seed: release validada online e se atualizando sozinha | continuar mandando release na mão | Próximo passo declarado pelo dono; é o que a F5 entrega | Proposto |
| Rail injetado na página | Superado: não há rail em janela de ferramenta | — | — | Superada |
| Catálogo | Dado local versionado, editado na casca | catálogo no código | Cadastrar ferramenta não pode exigir recompilar | Proposto |
| Ícones | PNG/SVG no diretório de dados, buscados no cadastro pelo backend ou enviados pelo admin | ICO embutido no build | Sem decodificador de imagem no runtime para ICO | Proposto |
| Senha local | Senha própria da conta na casca, com PBKDF2-HMAC-SHA256 salgado; biometria como atalho | sessão do SO sem senha | Pedido do dono em 2026-10-15; PBKDF2 é nativo no runtime (`saghul/txiki.js:src/js/polyfills/crypto/kdf.js`) | Decidido (2026-10-15) |
| Cofre | Chaveiro do sistema operacional (`app.secrets`) por pessoa e ferramenta; índice no banco local. 0.5.1 proposes moving the values to `nod.db` — see "One keychain access (0.5.1)" below | arquivo cifrado próprio; `store.json` | Dono em 2026-10-15: "a forma mais padrão possível de guardar uma senha de um serviço. autenticar e pronto" | Decidido (2026-10-15) |
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
| Password never reaches the host | The Nod derives `authKey` and `vaultKey` from the password; only `authKey` is sent; vault values encrypted with `vaultKey` before the keychain (`docs/epics/E01-connected-mode.md` §7); where they are stored from 0.5.1 is "One keychain access (0.5.1)" below | send the password and hash it on the host | Owner on 2026-10-16: the password "abrir uma vault privada local que eu no servidor nao tenho acesso"; changes the plain-keychain detail of "Cofre"; owner approved gate #1 on 2026-10-16 | Decidido (2026-10-16) |
| Carna services | Deferred: future separate services beside the host, trusting its session | incorporate now | Owner on 2026-10-16: "deixar isso como algo futuro" | Decidido (2026-10-16) |
| Biometric gate | Biometrics gate unlock and every reveal, copy, accept and send of a credential; password where biometrics don't exist (Linux); `vaultKey` kept in the keychain for biometric unlock (`docs/epics/E01-connected-mode.md` §7, `docs/epics/E02-credential-sharing.md` §5) | password only for the vault | Owner on 2026-10-16: "biometrics internas pra tudo, mesmo que isso inclua só desbloquear localmente as senhas guardadas" | Decidido (2026-10-16) |
| Credential sharing | Send, assign (to a person or a role) and share tool credentials end to end: sealed to the receiver's X25519 key, signed with Ed25519, relayed by the host as ciphertext (`docs/epics/E02-credential-sharing.md`) | admin types it once; no sharing | Owner on 2026-10-16: "mandar senhas entre sí ou apontar senhas novas para membros… passando por biometria para conseguir sequer ver"; owner approved gate #1 on 2026-10-16 | Decidido (2026-10-16) |
| Guilds per install | One Nod is in one guild at a time; changing guild is removing the host and adding another (`docs/epics/E01-connected-mode.md` §4). 0.5.0 prepares several guilds: `EntryTarget`/`GuildProfile` carry a guild id (`shared/types.ts`) | several guilds side by side | Owner on 2026-10-16: "no momento nao. se sair e voltar ele poderia entrar em outra"; owner on 2026-10-17: "no futuro um offline pode acessar varias guilds, hoje vamos só preparar o terreno pra isso" | Decidido (2026-10-16) |
| Sharing scope and holders | Each credential has a scope — role (default), blocked, org — and shows who holds it (`docs/epics/E02-credential-sharing.md` §1) | anyone to anyone | Owner on 2026-10-16: "só entre pessoas da mesma role… ou bloqueado ou publica pra org"; "é bom ver que consegue ver aquele password" | Decidido (2026-10-16) |
| Docked view and tabs | Docked mode **is the default**: tabs shown over the main window's center panel as frameless windows the Nod keeps on the slot, several tabs per tool, links clicked inside a tool adopted as tabs next to it; Windows mode stays as a setting (`docs/epics/E03-docked-tabs.md`) | iframes; tool windows only | Owner on 2026-10-16: center panel showing the open tab, detachable, several tabs per tool; "padrão é docked view". The docked mechanics remain a proposal until spikes S0–S4; iframes stay out at the time (§7) — RF-69 reopens them for frameable tools in 0.6.0a. Blocked by B05 | Decidido (2026-10-16): default and intent; mechanics built in 0.6.0, pending the owner's reading. Superada (2026-10-22) quanto ao ajuste de Windows mode: não há mais escolha de modo (§22 "Seamless tabs: always inside, detach on demand") |
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
| Gate where biometrics exist | Reveal, copy, send, accept and assign always call `app.authenticate` on a machine whose runtime reports the `authenticate` capability; a typed password is the gate only where it doesn't (Linux). Since 0.5.1 one confirmation covers the next ones for 15 idle minutes — "Gate once per session, with a timeout" below | password as fallback everywhere | Owner on 2026-10-17 (review finding M3, `docs/handovers/block2-review.md`): "Biometrics required where they exist" | Decidido |
| Gate in a dev run | A non-release (`tinyjs dev`) run also accepts the typed password, so the unattended smoke can pass the gate; a release build never does | a test-only RPC; no gate in the smoke | Needed by the connected smoke after the decision above; proposed by the orchestrator, not yet read by the owner | Proposto |
| Gate fallback when the system prompt fails | Built for 0.5.0: when `app.authenticate` does not confirm (no biometrics enrolled — Windows without Hello reports the capability and answers `false` every time — or a cancel), the Nod offers the typed password for that action and accepts it for the rest of the unlocked session; lock and unlock bring the system prompt back first (SP02 §9) | keep the prompt as the only factor (a person without enrolled biometrics can never accept, reveal, copy or send); probe enrollment up front (the runtime exposes no such call) | Owner on 2026-10-17: "um usuario sem biometria nao consegue aceitar uma senha vinda de outro usuário". This relaxes the "gate where biometrics exist" row above and needs the owner's reading | Proposto |
| Revoked member of an assigned role | A holder the owner (or an admin) revoked stops appearing in the admin's "missing a copy" list for that credential; giving it back takes an explicit direct assignment | the assignment wins and re-lists them | Owner on 2026-10-17 (review finding M5): "No — revocation suppresses it" | Decidido |
| Nod older than the host's `minAppVersion` | The Nod does not connect to the host: no sync, no push, no host write | keep working read-only from the cached snapshot (the #28 proposal) | Owner on 2026-10-17 on #28: "ele deve só não deixar tudo ser conectado" | Decidido |
| How a too-old Nod stays disconnected | Built in 0.4.0: only discovery and `GET /v1/meta/app` go out; join and sign-in are refused before any credential leaves; nothing from the cached snapshot is shown (the local catalog runs) while the host row and the cache stay on disk; a banner asks for the update | keep showing the cached guild catalog without syncing | The orchestrator's reading of the decision above (`docs/handovers/o1-o2-nod.md`, "Owner decision 2026-10-17"); hiding the cached catalog was not in the owner's words | Proposto |
| Guild invites | An admin creates an invite with roles, a max-use count (or unlimited) and an expiry (or never), gets a `nod://join?…` link plus a code shown once, and lists and revokes invites; whoever opens the link sees the guild and creates the account they choose, with the invite's roles — and an invite **never grants an admin role**, because the code is pasted into chats: a role carrying `admin = 1` is refused at creation (`400 an invite cannot grant an admin role`) and re-checked when the link is redeemed, so a role promoted to admin after the invite was made makes it `invalid invite` with no use spent (`shared/host-api.ts`, `shared/join-link.ts`, `docs/specs/SP03-host-api.md`, `docs/specs/SP02-auth-and-keys.md` §3) | email-bound access code per person (`POST /v1/admin/people`); magic link | Owner on 2026-10-17: "sendo gerado um com código e enviado para a pessoa para entrar no servidor com as permissoes e cargos corretos por exemplo a partir da conta que a pessoa decidir usar pra criar"; the invite is a "Link with roles, uses and expiry". The no-admin rule is the orchestrator's reading of the same fork (a bearer link must not mint admins); promoting a person stays `PATCH /v1/admin/people/:id` | Decidido (2026-10-17) |
| Entry screen with Offline and guild tiles | The locked screen is a Discord-like rail of tiles — Offline, the guild, and `+` (join a guild / set one up); choosing a tile then giving the password enters that way (`shared/types.ts` `EntryProfiles`, `shared/types.ts` `EntryTarget`) | the single unlock form with a mode toggle | Owner on 2026-10-17: "selecionar se quer entrar como offline ou host na tela inicial, depois de dar uma senha para dar login com os icones das guilds" | Decidido (2026-10-17) |
| Seed as optional import | The seed is an optional import at setup: `bun run eb:build` no longer requires `resources/seed.json`, a release without one starts empty, and the first-run Offline tile offers "Import a seed file" (`session.importSeed`) while no account exists (`shared/types.ts` `session.importSeed`; `docs/canonico.md` §19). Supersedes "Seed embutido em `resources/`" and the §19 build-fails rule | keep the seed mandatory in every release | Owner on 2026-10-17: "podemos manter o sistema de entrar como seed mais como um import possivel ao configurar o sistema"; the fork answer "Optional import at setup" | Decidido (2026-10-17) |
| Invite link details | The invite code is 15 random bytes shown as 24 Crockford base32 characters (`XXXX-…` ×6); `maxUses` 1..1000 or unlimited; expiry 1 minute..30 days or never; no admin role — a role with `admin = 1` is refused at creation and re-checked at the join (the rule is in "Guild invites"); `POST /v1/auth/invite` shows the guild icon to whoever holds the link, before any account is typed (`shared/host-api.ts`) | shorter code; hide the icon from non-members; a lower expiry cap | Design chosen for 0.5.0; the owner stated roles, uses and expiry but not these numbers | Proposto |
| Offline session | Entering Offline reuses the O2 disconnect: the local catalog with no sync and no host call, host reads/writes refused (`OFFLINE_SESSION_ERROR`); one predicate `disconnected() = requiresUpdate() or mode === 'offline'` (`backend/session.ts`) | a separate offline code path | Owner asked for an offline entry; the equivalence to the built O2 disconnect is the orchestrator's reading | Proposto |
| New person by email-bound code | The admin created a person with an access code bound to that email (`POST /v1/admin/people`); superseded by "Guild invites" (0.5.0, RF-59) | — | Anyone who holds the invite link now creates the account they choose; the reissue route for an existing person (`POST /v1/admin/people/:id/code`) stays | Superada |
| Tool categories | A guild admin gives each org tool a category, and the Nod separates the catalog by it in the display (`shared/catalog.ts` `groupByCategory`, `Entry.category` in `shared/types.ts`, `entries.category` on the host and `tool.category` in the Nod) | one flat catalog; free tags per tool instead of a single category name | Owner on 2026-10-17: "para a 0.4.5 ainda, quero que crie um sistema de categorias que a guild pode dar para suas tools e separar isso na visualização". The owner stated the guild assigns categories and the view separates them; the details below are the orchestrator's reading (Proposto): a free name of 1..40 characters, trimmed, empty meaning none; a group stands where its smallest tool `order` puts it, ties by category name; the unfiled group reads last; only an org tool carries a category (a personal tool keeps none, and the host ignores one on a personal write); the favorites are not split | Decidido (2026-10-17); os detalhes seguem Proposto |
| Release branch on merge | Merging a pull request from `dev` into `main` creates `release-<version>` at the merge commit and dispatches `release.yml` on it (`.github/workflows/release-branch.yml`); an existing branch of that version stops the job, so a forgotten version bump never republishes silently; the release text is the body of the `Release <version>:` commit (`docs/distribuicao.md` §8) | push `release-*` by hand; a release on every push to `main` | Owner on 2026-10-17: "quando uma branch seja deployed da dev pra main, seja automaticamente criada uma branch release-*". Stopping on an existing branch and taking the notes from the release commit are the orchestrator's reading | Decidido (2026-10-17); details Proposto |
| Version of the Discord-like release | The entry screen, guild invites, optional seed, categories and the gate fallback ship as **0.5.0**, not 0.4.5 — 0.4.5 was never published, so every "0.4.5" in docs and code comments became "0.5.0" (owner quotes stay verbatim) | publish 0.4.5, then 0.5.0 with the release automation | Owner on 2026-10-17: "pode ja dar redeploy para isso ser a 0.5.0" | Decidido (2026-10-17) |
| Entry screen title | The entry screen carries "nod" as a figlet-style ASCII title in the page's monospace (`src/entry.ts` `NOD_BANNER`), and the README opens with it | an image logo; no title | Owner on 2026-10-17: "adicione um titulo na pagina com uma fonte monospace tipo aquelas ascii font escrita nod, simples" | Decidido (2026-10-17) |
| One keychain access (0.5.1) | The system keychain keeps only the biometric item (`nod.bio.<person>` = `vaultKey`); credentials, the E02 pair and the guild bearer — the first two already `bv1.` under `vaultKey`, the bearer sealed so from now on — live in the `secret` table of `nod.db`; whether a person has biometrics is a `store.json` flag, so the entry screen never touches the keychain (RF-63, `backend/secret-store.ts`). Reverses the "per person and tool in the keychain" half of "Cofre", the "limite honesto do chaveiro" paragraph of §11 and SP02 §5's bearer-in-keychain; the index-in-the-database half stands. **Tradeoff for the owner:** the values lose the OS keychain's per-app ACL as a second layer — AES-256-GCM under the PBKDF2-derived `vaultKey` is the only barrier, so a copy of `nod.db` is open to an offline password guess (the same guess the `person` row's verifier already allows, so no new target, but one layer fewer); for a person without biometrics nothing of the Nod is in the keychain at all | keep one keychain item per secret and have each person "Always Allow" every item after every build; one keychain item holding the whole vault (the Windows 2560-byte limit, §11); a stable signing identity (`signIdentity`/`TINYJS_SIGN_IDENTITY`, `~/.tinyjs/skill/references/release.md`) so one "Always Allow" survives updates — the root-cause fix for the re-prompt, a distribution change not built here (`leitura` only: a non-ad-hoc identity turns on the hardened runtime and needs a real build test) | Owner on 2026-10-17: "o nod pede o acesso ao keychain repetidamente. quero acessar tudo que preciso de uma vez só pedindo e autenticando com a digital". macOS ties each item's ACL to the binary that wrote it and the ad-hoc build changes it (`docs/tinyjs.md` §5), so every item prompts again; the quote asks for the outcome, the table instead of the keychain is the orchestrator's reading | Proposto |
| Gate once per session, with a timeout | A confirmed gate — the Touch ID unlock, or a gated action that passed (fingerprint, or the password where it is the factor) — covers the same person's next reveal, copy, send, accept and assign until 15 minutes pass without one; each covered action restarts the clock, and a lock forgets it (`backend/main.ts` `GATE_WINDOW_MS`, `gateStillOpen`) | ask on every action (the rule above); once per session with no timeout | Owner on 2026-10-17: "quando possivel quero que peça sempre só dedo e peça sempre no máximo uma vez", choosing "Once per session, with a timeout". The 15 minutes and the idle (not absolute) clock are the orchestrator's reading | Decidido (2026-10-17); 15 min idle Proposto |
| Guild owner | The person the setup code created is the guild **owner**, recorded as `meta.owner_id` (host migration 7, backfilled with the earliest-created person); only the owner renames people and edits their email, and only the owner deletes people (RF-64, `docs/specs/SP03-host-api.md`, `docs/specs/SP01-host-data-model.md`) | the first admin of a guild is just another admin; a separate owner role in the roles table | Owner on 2026-10-18: "a pessoa que entrou no servidor usando o código de setup tem controle sob isso" | Decidido (2026-10-18) |
| Deleting a person is a hard delete | Deleting a person removes the row and everything cascading in one transaction: their events (`events.person_id`, `events.session_id`) and their shares (`shares.from_id`/`to_id`) are deleted, holder rows' `via_share_id` to a deleted share is set NULL, and `credential_assignments.assigned_by` is reassigned to the deleting owner; a `person_deleted` event stays, written by the owner and naming the deleted person's name and email — no secret (`docs/specs/SP03-host-api.md`) | soft-delete/disable only (keep the row, hidden) | The orchestrator's reading of the owner's request to delete people; keeping the row would leave their events and shares alive | Proposto |
| Owner-only rename and email | Only the owner renames a person or edits their email (lowercased and trimmed; an email another person holds answers `409 email taken`); assigning roles and disabling a person stay admin-level as today (RF-64, `docs/specs/SP03-host-api.md`) | the owner also owns roles and disable; any admin may rename and edit emails | The orchestrator's reading of the owner's request — control over the people already on the server | Proposto |
| The owner keeps admin | A write that would leave the owner without an admin role or disable them is refused — `403 the owner keeps an admin role` / `403 the owner cannot be disabled` — whoever asks, the owner included; it covers `PATCH /v1/admin/people/:id` (`roles`, `disabled`) and a role demotion or delete that takes the owner's only admin role (RF-64, `docs/specs/SP03-host-api.md`) | the owner also owns roles and disable; any admin may demote or disable the owner | The owner must not lose control through another admin, and self-demotion should not be a way around it | Proposto |
| Several credentials per tool | A person's vault holds several credentials of one tool, each addressed by its own `VaultItem.id`; share, assign, scope, holders and revocation act on one chosen credential, and the login cascade fills the tool's default one (RF-65, `shared/types.ts` `VaultItem`, `backend/repo.ts`, `backend/vault.ts`) | one credential per (person, tool), the tool being the handle | Owner on 2026-10-18: "quero ter mais de uma credencial por ferramenta, e poder liberar credenciais especificas para ferramentas especificas como eu quiser" | Decidido (2026-10-18) |
| Version of the several-credentials release | Several credentials per tool (RF-65) and the category fix (RF-62) ship as **0.5.5**, not 0.5.4 — 0.5.4 was never published, so every "0.5.4" in docs and code comments became "0.5.5" (owner quotes stay verbatim) | publish 0.5.4, then 0.5.5 | Owner on 2026-10-18: "para fechar isso montar tudo + pr pra 0.5.5" | Decidido (2026-10-18) |
| Status as a toast | Settings' status messages are a toast over the page, never a line inside the layout; it closes on a click or after 4 s (8 s for an error) — the timings are the orchestrator's reading | the inline line above the tab content (moved every button down while shown) | Owner on 2026-10-18: "quero que isso sejam sempre um toast para que nunca mude a configuracoes dos botoes se movendo" | Decidido (2026-10-18) |
| Hotfix versions | A hotfix is `X.Y.Z` plus lowercase letters right after the patch — `0.5.5a`, `0.5.5b` — ordered after `X.Y.Z` and before `X.Y.Z+1`; the release workflows accept it and the Nod's update offer reads it (`shared/version.ts`, `docs/distribuicao.md` §8) | a semver pre-release or build suffix; a plain patch bump | Owner on 2026-10-18: "quero que atualize primeiro as actions para ver as letras como hotfix e sempre depois do numero como em 0.5.5a mesmo" | Decidido (2026-10-18) |
| Version that reaches the 0.5.5 installs | The fix that should have reached 0.5.5 as 0.5.5b ships as **0.5.6**: a build older than 0.5.5a reads only `X.Y.Z` (the runtime's `parseVer`) and can never see a letter, so a hotfix letter only reaches 0.5.5a and later | 0.5.5b with a manifest declaring a higher number (the hotfix then has to ignore its own manifest, and the next real 0.5.6 loses its number); 0.5.5b plus a one-time manual install on 0.5.5 | Owner on 2026-10-19: "a versao 0.5.5 nao encontra a versao 0.5.5a quando tenta atualizar, coloque para isso ser detectado na 0.5.5b", then chose "Publish as 0.5.6" | Decidido (2026-10-19) |
| One default credential fills the login | Whenever a tool holds items, exactly one of them is its default (`VaultItem.isDefault`) and the cascade fills that one; the first item of a tool becomes the default, and removing the default promotes the oldest remaining one | a picker in the tool window choosing which credential to fill | The orchestrator's reading of RF-65 — the fill needs a single credential per tool, and the person keeps one marked | Proposto |
| Releasing a credential = sharing/assigning that one credential | "Releasing a credential to a tool" means sharing or assigning that one credential, not attaching one credential to several tools (RF-65, `docs/epics/E02-credential-sharing.md`) | one credential attached to several tools — not done: the host pins a credential to a single tool (SP06) | The orchestrator's reading of RF-65 — the host side is already keyed by `credential_id`, one credential per tool | Proposto |
| E03 requirements approved (0.6.0) | RF-49…RF-52, RF-66…RF-68 enter §14 (`docs/epics/E03-docked-tabs.md` §6) | — | Owner on 2026-10-19: "orchestrate e implemente a e03 na versao 0.6.0" | Decidido (2026-10-19) |
| Docked mode per OS | Docked is the default on macOS, where the spikes (`docs/handovers/e03-spikes.md`) and the real-surface smoke (`docs/handovers/e03-smoke.md`) ran by execução on 2026-10-19; on Windows and Linux the setting offers Docked but the default stays Windows until S1–S4 run there; on Wayland Docked is not offered | Docked the default everywhere, as "Docked view and tabs" decides | That row is the owner's "padrão é docked view"; nothing has been run on Windows or Linux, so this departs from it there until the owner reads it | Superada (2026-10-22) |
| Views in docked mode | `window`-mode views open as a new tab; `navigate`-mode views navigate the tool's current tab (E03 §7 q3) | — | — | Proposto |
| Identity popups stay floating | In docked mode a popup whose URL is a known identity path (`shared/probe.ts` `isIdentityPath`) stays a floating popup window as today; any other `http(s)` popup from a tool becomes an ad-hoc tab next to its source | — | — | Proposto |
| Embedded tabs (iframe) | In docked mode a tool whose address may be framed opens as an **embedded tab** — an `<iframe>` inside the main window instead of a window — per tool and per machine (`embedded_tools` in `store.json`, RF-69, `docs/epics/E03-docked-tabs.md` §8); an embedded tab is never detached, gets no autofill and no injected script, and keeps its page across tab switches and visits to Home or Settings | the OmniWM float rule only (keep the OS windows); change the runtime (Electron/Tauri); wait for an embedded webview in tinyjs | Owner on 2026-10-19: "eu gostaria que a janela nao fosse uma janela a nivel de sistema, e sim encaixasse como uma aba de verdade dentro do Nod"; chose "Iframe for your own tools" and "Build it + rewrite cookies on your proxy" | Superada (2026-10-22) |
| Embedded tab preference per machine | Which tools open as embedded tabs is a setting of this machine (`embedded_tools` in `store.json`, no secret, `ToolsState.embedded`); it is not a catalog field and does not travel with the tool to other machines | a field on the catalog entry, synced from the host | The orchestrator's reading of RF-69: whether a tool may be framed, and whether its login survives the frame, depends on this machine's engine and cookies | Superada (2026-10-22) |
| Version of the embedded-tabs release | RF-69 ships as **0.6.0a**, not 0.6.1 — every "0.6.1" in docs and comments became "0.6.0a"; Nod 0.6.0 offers the letter itself (`shared/version.ts`) | publish 0.6.1 | Owner on 2026-10-19: "com o que ja colocamos de atualizacoes desde 0.6.0 monte o pr para a 0.6.0a" | Decidido (2026-10-19) |
| Saved login for an embedded tab | An embedded tab never gets autofill; when the person holds a credential for its tool, "Show inside Nod" warns and the tab offers "Copy username" / "Copy password" (gated `vault.copy`) | a credential forces the tool back to a window tab, where autofill works | Owner on 2026-10-19 asked to resolve "ao tentar entrar com uma credencial que tava em window na tab, ela nao eh carregada" and chose "Warn and offer copy". Planka still cannot keep a login inside an iframe: its client sets the token cookie with `sameSite: 'strict'` (E03 §8) | Superada (2026-10-22) |
| Login-blocked tools stay windows | A tool whose login cannot survive an iframe is never embedded on this machine: `tabs.checkEmbed` flags a `SameSite=Strict`/`Lax` cookie set by the entry response or saved by the page's own script, "Show inside Nod" is refused with that reason, and the embedded tab offers "Login won't stay? Open as window", which reports the tool and turns its embedded tabs into window tabs in place, where the login is filled; the block is remembered in `embed_blocked` (`ToolsState.embedBlocked`, RF-70, `docs/epics/E03-docked-tabs.md` §8) | keep it embedded and let the person sign in again each time; ship the tool without a warning; hide "Show inside Nod" for a blocked tool instead of refusing it with the reason | Owner on 2026-10-19: "quero que sempre que esse tipo de problema aconteça, quando tento visualizar na dock, ele ja bloqueia e pede pra abrir a aba separada para isso ser corrigido"; chose "Planka as window, with a warning" | Superada (2026-10-22) |
| Login-blocked detection | The check that decides "never embedded" reads the entry response's `Set-Cookie` headers for `SameSite=Strict`/`Lax` and, failing that, scans the same-origin scripts the entry HTML loads — `<script src>` and `<link rel=modulepreload href>` on the entry origin only, at most 8 scripts, each up to 12 MB, within a 10 s budget — for a JavaScript cookie write carrying `strict`/`lax` (`shared/tabs.ts` `loginCookieRisk`); a network failure while scanning does not block, and a hit is stored as the reason | report only, from the embedded tab's "Login won't stay? Open as window"; probe the tool's login flow by executing it; block on any script that mentions cookies | The owner asked for the block; the script-scan limits (same-origin only, 8 scripts, 12 MB each, 10 s) are the orchestrator's reading of how far to look, and a false positive only costs the iframe | Superada (2026-10-22) |
| Electrobun parity build | Build a second runtime target of the Nod on **Electrobun** that does everything the tinyjs build does (`docs/epics/E06-embedded-webview.md` §12–§13), kept beside the tinyjs build until parity is proven by the same surface checks | keep only tinyjs and fork it for an embedded view; wait for upstream | Owner on 2026-10-22: "acredito que agora essa talvez seja uma boa escolha para evitar problemas no futuro, entao teria que acabar entrando agora mesmo sendo o e06, e ja evitamos mais retrabalho la na frente", then "orchestrate the development for a full parity in electronbun" | Decidido (2026-10-22) |
| Electrobun replaces tinyjs as the shipped runtime | **0.7.0 ships the Electrobun build on Apple silicon Macs and the tinyjs build of the same code on Intel Macs, Windows and Linux** (Electrobun 2.0.4 publishes no `darwin-x64` build; no Electrobun run on Windows/Linux yet). One `manifest.json` serves every install: its `mac.arm64` entry is a zip of the Electrobun `Nod.app`, so an Apple silicon Mac on tinyjs 0.6.0c updates into Electrobun through the tinyjs runtime's own updater (sha256 + `codesign --verify`), and Electrobun installs read the same file (`docs/distribuicao.md` §8). The tinyjs target stays in the repo for the rest. Removing it, and moving RNF-02's size target to the measured Electrobun numbers, wait for Electrobun on those systems | keep tinyjs everywhere; macOS-only 0.7.0 with Windows/Linux left on 0.6.0c | Owner on 2026-10-23: "quero que atualize as actions do github e se prepare para lançar essa versao em electrobun como versao 0.7.0", then chose "tinyjs build of 0.7.0" for Windows/Linux; Intel Macs follow the same rule after the first release run showed Electrobun has no Intel build | Decidido (2026-10-23) for the 0.7.0 split; removing tinyjs Proposto |
| Seamless tabs: always inside, detach on demand | Every tool opens as a tab inside the Nod window; the person can detach any tab into its own window and dock it back. No Window mode setting (Docked/Windows) and no per-tool "Show inside Nod"/"Open as window" choice: the iframe-embedded kind (RF-69, RF-70) and its password-copy workaround (§22 "Saved login for an embedded tab") are removed. Windows mode remains only as the runtime's own fallback where windows cannot be positioned (Wayland). On Electrobun the in-window tab is a native view (Claude included, autofill working); on tinyjs it stays the frameless window over the panel. Supersedes RF-52's setting, RF-69, RF-70 and the rows "Embedded tabs (iframe)", "Embedded tab preference per machine", "Saved login for an embedded tab", "Login-blocked tools stay windows", "Login-blocked detection" | keep the setting and the iframe kind | Owner on 2026-10-22 after testing the Electrobun build: "quero que a gente limite esse funcionamento de dar deatach ou nao. ao inves de ter a opcao falando da senha, seja tudo só dentro da interface + poder deatach. quero inclusive tirar dos settings a parte de selecionar se uma tool é window ou dock e só ter isso de forma seamless" | Decidido (2026-10-22) |
| No Touch ID unlock on Electrobun (0.7.0) | On the Electrobun build the vault key is never stored in the keychain: unlock is by password only, the biometric button is not offered, and a Mac that migrated from 0.6.0c has its `nod.bio.<person>` item deleted at first boot. The gate keeps the system prompt (`app.authenticate`, no keychain). tinyjs builds keep biometric unlock | keep the item (any Electrobun app on the machine reads it without a prompt, because the item trusts Bun's Developer ID); hold 0.7.0 until the Nod has its own Developer ID | Measured in `docs/handovers/e07-migration.md` §5; owner on 2026-10-23 chose "Ship without Touch ID". The way back is §23's risk row: sign the Nod with its own Developer ID | Decidido (2026-10-23) |
| Tool sessions after the 0.7.0 update | The update does not import tinyjs's cookie store: each tool asks for sign-in once after the update (the vault fills it where a credential is saved) | import `~/Library/HTTPStorages/<id>.binarycookies` into the Electrobun store at first boot | Owner on 2026-10-23 chose "Accept: sign in again once" | Decidido (2026-10-23) |
| Homebrew install | macOS installs through a Homebrew cask kept in this repository (`Casks/nod.rb`, the repo is the tap): pinned version and sha256 per architecture from the release manifest, rewritten on `main` by `release.yml` after each release; the cask clears the quarantine flag after installing (`docs/distribuicao.md` §3.1) | a separate `homebrew-nod` tap repo (needs a cross-repo token); `version :latest` with no checksum | Owner on 2026-10-27: "configure para o nod uma forma de baixar ele pelo brew no macos", then chose "Inside the Nod repo" and "Pinned version + sha256, updated per release" | Decidido (2026-10-27) |
| One runtime: Electrobun (0.8.0) | **Electrobun 2.0.5 is the only desktop runtime; tinyjs is removed.** Every release builds macOS arm64/x86_64, Linux x86_64/arm64 and Windows x64/arm64 with Electrobun (`docs/electrobun.md` §2, `docs/distribuicao.md` §8). macOS keeps docked tabs; Windows/Linux report `canDock: false` and use the windows mode (no view re-parent in 2.0.5). macOS updates from `manifest.json` (sha256 + `codesign`), Windows/Linux through the runtime `Updater`. A Windows/Linux installation on 0.7.0c installs 0.8.0 once; macOS migrates itself. | keep tinyjs for Intel Macs/Windows/Linux; wait for Electrobun 2.0.4 | Owner on 2026-10-27: "electrobun agora é o unico runtime do projeto deprecando tinyjs"; Electrobun 2.0.5 adds `macos-x64`, which removes the 0.7.0 blocker | Decidido (2026-10-27) |

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
   HKDF are all native in the runtime, with per-operation costs in `docs/electrobun.md` §4 (stories H3
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
| Release que devia trazer seed sai sem ele | App abre vazio para quem recebe | Desde 0.5.0 a release sem seed é válida (RF-61): o tile Offline do primeiro uso oferece "Import a seed file", e o gate/camera/update só existem com seed embutido (`docs/canonico.md` §19) |
| Runtime jovem (0.x) | Mudança de API entre versões | versão do Electrobun/Hutch fixada em `package.json`; docs do runtime lidas antes de codar |
| Keychain identity on Electrobun | Every Electrobun app shares the Developer ID of Bun's `bun` binary, so a keychain item the Nod writes is readable by any other Electrobun app without a prompt (`docs/handovers/e07-migration.md` §5) | 0.7.0 stores no vault key in the keychain on macOS (§22). Durable fix: sign the Nod — the outer bundle and the embedded `bun` — with the team's own Developer ID (Electrobun `build.mac.codesign`/`notarize`), so the item trusts only the Nod's team; then Touch ID unlock can return, optionally with an access-controlled item (`.biometryCurrentSet`) in the data-protection keychain |
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
