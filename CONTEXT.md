# Nod

O vocabulário do produto. **Everything is in English from 2026-10-16** (owner decision; the app was
already English since 2026-10-15). The pt-BR terms below remain until this file is rewritten; each
term carries the identifier used in code and UI. A new term waits for the owner's reading.

## A janela e o que ela abre

**Nod** — `Nod`:
O produto: o app que roda na máquina da pessoa e reúne as ferramentas internas de um time.
_Evite_: wrapper, launcher, hub, portal

**Janela principal** — `main` (`MAIN_WINDOW`):
A única janela para gerenciar e usar o Nod: sidebar, Home, paleta, Settings e a tela de entrada.
_Evite_: casca, rail, painel de admin (como janela)

**Sidebar** — `sidebar`:
A coluna de ícones da janela principal, um por ferramenta permitida, com dígito e estado.
_Evite_: rail, dock, barra lateral de ícones como janela própria

**Ferramenta** — `tool`:
Um sistema web interno que o Nod abre — Affine, Kanban, webmail, Discord.
_Evite_: app, aplicativo, sistema, serviço

**Janela de ferramenta** — tool window (`toolWindowId`):
A janela própria em que uma ferramenta abre, a partir da janela principal.
_Evite_: palco, aba, painel, webview, iframe

**Endereço** — `url`:
A URL base de uma ferramenta, como `https://kanban.example.com`.
_Evite_: link, host, domínio

**Vista** — `View`:
Um endereço nomeado dentro de uma ferramenta (um board, uma pasta de e-mail), com modo `window` ou
`navigate`.
_Evite_: sub-aba, rota, página

**Entrada** — `Entry`:
O registro de uma ferramenta no catálogo: título, endereço, ícone, vistas, papéis.
_Evite_: card, item, atalho, favorito

**Categoria** — `category`:
O nome que a guilda dá a uma ferramenta do catálogo, para a sidebar e a Home agruparem por ele (RF-62);
vazio é "sem categoria", e uma ferramenta pessoal não tem.
_Evite_: tag, grupo, pasta, seção

**Catálogo** — `catalog`:
O conjunto de entradas, com versão própria. É dado, não código.
_Evite_: lista, menu, inventário

**Paleta** — `palette`:
A busca por teclado (`⌘K`) dentro da janela principal: ferramentas, vistas e ações.
_Evite_: omnibox, launcher, janela de busca

**Tela de entrada** — entry screen (`src/entry.ts`, `session.profiles`):
A tela bloqueada: o trilho de tiles — Offline, a guilda e `+` — onde a pessoa escolhe por onde entrar
e digita a senha (RF-60).
_Evite_: tela de login, launcher

**Tile** — tile:
Cada alvo do trilho da tela de entrada (Offline, a guilda, `+`), com ícone ou iniciais e estado.
_Evite_: botão, atalho

**Aba**:
Não existe no Nod. O que a pessoa chamaria de aba é uma **janela de ferramenta** ou uma **vista**.

## Pessoas e acesso

**Pessoa** — `Person`:
Quem usa o Nod numa máquina.
_Evite_: usuário, user, membro, funcionário

**Conta** — account:
As credenciais de uma pessoa no Nod (ou, no futuro, num host).
_Evite_: login (como substantivo), perfil, cadastro

**Convite** — `Invite` (`InviteSeed` no seed):
O código de uso único que o administrador emite para uma pessoa criar conta. Só o hash fica guardado.
_Evite_: senha temporária, token, link mágico

**Convite da guilda** — guild invite (`GuildInvite`, `guildInvites.*`):
O convite que o admin de uma guilda cria com papéis, limite de usos e validade; quem abre o link
`nod://join?…` cria a própria conta com os papéis do convite (RF-59).
_Evite_: link mágico, código de acesso

**Papel** — `Role`:
Um conjunto nomeado de ferramentas visíveis.
_Evite_: grupo, perfil, time (como sinônimo de papel)

**Concessão** — grant (`roles.grant`, tabela `tool_grant`):
A ligação entre um papel e uma ferramenta.
_Evite_: permissão, acesso

**Administrador** — admin (`Role.admin`, `Person.admin`):
A pessoa que edita catálogo, papéis e concessões, e emite convites.
_Evite_: root, dono, superusuário

**Guild owner** — owner (`AdminPerson.owner`, host `meta.owner_id`):
A pessoa que criou a guilda com o código de setup — a primeira conta de um host. Só ela renomeia
pessoas, edita e-mails e apaga pessoas da guilda; ninguém apaga o owner, nem ele próprio (RF-64).
_Evite_: dono, superusuário, root, primeiro admin

**Host**:
O servidor da empresa que, no futuro, guarda catálogo, contas, concessões e eventos. Hoje não existe.
_Evite_: servidor, backend, nuvem

**Seed** — `Seed`:
O arquivo privado com catálogo, papéis, concessões e hashes de convite iniciais. Fora do git, embutido
na release, aplicado no primeiro boot. Não contém segredo.
_Evite_: config, env, seed de banco

**Desbloqueio** — unlock (`session.unlock`):
Autenticar no Nod com a senha local, ou com biometria onde existe. Uma vez só por sessão.
_Evite_: login (quando se fala do app)

**Senha local** — password:
A senha da conta no próprio Nod. Sem recuperação.
_Evite_: master password, PIN

**Sessão offline** — offline session (`SessionState.mode === 'offline'`, `HostState.offlineSession`):
A sessão que só usa o catálogo local, sem sincronizar e sem chamar o host — o mesmo corte do O2
(RF-60).
_Evite_: modo local, desconectado (como sinônimo)

## Segredos e registro

**Chaveiro** — keychain (`SecretStore`, `app.secrets`):
O armazenamento de credenciais do sistema operacional — Keychain, Credential Manager, Secret Service.
Desde 0.5.1 (RF-63) guarda só o item de biometria `nod.bio.<pessoa>`; os demais segredos são valores
`bv1.` na tabela `secret` do `nod.db`, atrás do mesmo `SecretStore` (`backend/secret-store.ts`).

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
