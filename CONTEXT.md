# Bond

O vocabulário do produto. Os documentos de projeto são em português; **o app é todo em inglês**
(decisão do dono, 2026-10-15), então cada termo traz o identificador usado no código e na
interface. Um termo novo espera leitura do dono antes de virar canônico.

## A janela e o que ela abre

**Bond** — `Bond`:
O produto: o app que roda na máquina da pessoa e reúne as ferramentas internas da Copland.
_Evite_: wrapper, launcher, hub, portal

**Janela principal** — `main` (`MAIN_WINDOW`):
A única janela para gerenciar e usar o Bond: sidebar, Home, paleta, Settings e a tela de entrada.
_Evite_: casca, rail, painel de admin (como janela)

**Sidebar** — `sidebar`:
A coluna de ícones da janela principal, um por ferramenta permitida, com dígito e estado.
_Evite_: rail, dock, barra lateral de ícones como janela própria

**Ferramenta** — `tool`:
Um sistema web interno que o Bond abre — Affine, Kanban, webmail, Discord.
_Evite_: app, aplicativo, sistema, serviço

**Janela de ferramenta** — tool window (`toolWindowId`):
A janela própria em que uma ferramenta abre, a partir da janela principal.
_Evite_: palco, aba, painel, webview, iframe

**Endereço** — `url`:
A URL base de uma ferramenta, como `https://kanban.copland.studio`.
_Evite_: link, host, domínio

**Vista** — `View`:
Um endereço nomeado dentro de uma ferramenta (um board, uma pasta de e-mail), com modo `window` ou
`navigate`.
_Evite_: sub-aba, rota, página

**Entrada** — `Entry`:
O registro de uma ferramenta no catálogo: título, endereço, ícone, vistas, papéis.
_Evite_: card, item, atalho, favorito

**Catálogo** — `catalog`:
O conjunto de entradas, com versão própria. É dado, não código.
_Evite_: lista, menu, inventário

**Paleta** — `palette`:
A busca por teclado (`⌘K`) dentro da janela principal: ferramentas, vistas e ações.
_Evite_: omnibox, launcher, janela de busca

**Aba**:
Não existe no Bond. O que a pessoa chamaria de aba é uma **janela de ferramenta** ou uma **vista**.

## Pessoas e acesso

**Pessoa** — `Person`:
Quem usa o Bond numa máquina.
_Evite_: usuário, user, membro, funcionário

**Conta** — account:
As credenciais de uma pessoa no Bond (ou, no futuro, num host).
_Evite_: login (como substantivo), perfil, cadastro

**Convite** — `Invite` (`InviteSeed` no seed):
O código de uso único que o administrador emite para uma pessoa criar conta. Só o hash fica guardado.
_Evite_: senha temporária, token, link mágico

**Papel** — `Role`:
Um conjunto nomeado de ferramentas visíveis.
_Evite_: grupo, perfil, time (como sinônimo de papel)

**Concessão** — grant (`roles.grant`, tabela `tool_grant`):
A ligação entre um papel e uma ferramenta.
_Evite_: permissão, acesso

**Administrador** — admin (`Role.admin`, `Person.admin`):
A pessoa que edita catálogo, papéis e concessões, e emite convites.
_Evite_: root, dono, superusuário

**Host**:
O servidor da empresa que, no futuro, guarda catálogo, contas, concessões e eventos. Hoje não existe.
_Evite_: servidor, backend, nuvem

**Seed** — `Seed`:
O arquivo privado com catálogo, papéis, concessões e hashes de convite iniciais. Fora do git, embutido
na release, aplicado no primeiro boot. Não contém segredo.
_Evite_: config, env, seed de banco

**Desbloqueio** — unlock (`session.unlock`):
Autenticar no Bond com a senha local, ou com biometria onde existe. Uma vez só por sessão.
_Evite_: login (quando se fala do app)

**Senha local** — password:
A senha da conta no próprio Bond. Sem recuperação.
_Evite_: master password, PIN

## Segredos e registro

**Chaveiro** — keychain (`SecretStore`, `app.secrets`):
O armazenamento de credenciais do sistema operacional — Keychain, Credential Manager, Secret Service.

**Cofre** — vault (`VaultItem`):
As credenciais das ferramentas de uma pessoa, guardadas no chaveiro; o banco guarda só o índice.
_Evite_: arquivo de senhas, cofre cifrado

**Export do cofre** — vault export (`vault.exportToFile`):
Arquivo opcional, cifrado pela senha local, só para levar credenciais a outra máquina antes do host.

**Cascata de login** — login cascade (`shared/login-cascade.ts`):
A forma padrão de entrar numa ferramenta: sessão existente → formulário preenchido → fluxo do
provedor do próprio site → tela de login com a credencial à mão. Não se configura.
_Evite_: modo de auth, estratégia

**Adaptador de login** — login adapter (`backend/login-adapter.ts`):
O script que preenche o formulário de entrada do site, só na origin da ferramenta.
_Evite_: shim, auto-login (em texto corrido)

**Sonda** — probe (`catalog.probe`):
A leitura que o cadastro assistido faz da página: título, ícone, formulário de login, provedor.
_Evite_: detecção, scan

**Evento** — `AuditEvent`:
Um registro de auditoria local, append-only.
_Evite_: log, trace, span
