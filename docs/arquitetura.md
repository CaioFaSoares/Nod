# Arquitetura do Bond — contrato de implementação (v2)

Contrato entre as fatias de implementação. O **porquê** está em `docs/canonico.md`; os fatos do
runtime, em `docs/tinyjs.md`; os tipos, em `shared/types.ts`. Aqui mora o **onde** e o **como**.
Mudar uma assinatura daqui é decisão do coordenador.

**v2 (2026-10-15), por decisão do dono:** (1) uma janela só para gerenciar e usar o Bond — o rail de
ícones, a tela inicial, a paleta e as configurações vivem na janela `main`; as ferramentas abrem em
janelas próprias a partir dela; (2) **todo o app em inglês** — interface, mensagens, identificadores,
nomes de método, tipos, testes e comentários. From 2026-10-16, project documents are written in
English too; the pt-BR ↔ identifier vocabulary is in `CONTEXT.md`.

Runtime: tinyjs `v0.57.2` (txiki.js `26.6.0`), template `vanilla-ts` com Vite e bun. API exata do
runtime: `backend/tiny.d.ts` (backend) e `src/tiny.d.ts` (página). Não invente API.

## 1. Pastas

```
tinyjs.base.json      versioned config; tinyjs.json is GENERATED (gitignored) by scripts/gen-config.ts
index.html            the single page (main window)
src/                  frontend: api.ts (typed client), ui.ts (DOM helpers), app.ts, palette.ts, settings.ts, style.css
shared/               pure logic — no tjs, no tiny, no DOM — tested with bun
backend/              txiki.js backend (tjs, app, sqlite, keychain, windows)
resources/            seed.example.json, tray.png (versioned); seed.json (private, gitignored)
scripts/gen-config.ts builds tinyjs.json from tinyjs.base.json + resources/seed.json
test/                 bun test: test/*.test.ts; test/helpers/; test/smoke/ (real surface)
```

Imports sem extensão. Arquivos removidos na v2 (cada fatia apaga os seus): `admin.html`,
`paleta.html`, `carregando.html`, `src/casca.ts`, `src/admin.ts`, `src/admin.css`, `src/paleta.ts`,
`src/carregando.ts`, `shared/catalogo.ts`, `shared/rail.ts`, `shared/cascata.ts`, `shared/sonda.ts`,
`shared/exportar-cofre.ts`, `backend/sessao.ts`, `backend/cofre.ts`, `backend/palcos.ts`,
`backend/adaptador.ts`, `backend/sonda-rede.ts`, `backend/icones.ts` e os testes correspondentes
(`test/catalogo.test.ts`, `rail`, `cascata`, `sonda`, `exportar-cofre`, `sessao`, `cofre`,
`adaptador`), `test/smoke/ferramentas.ts`, `test/smoke/rodar.ts`.

## 2. Regras para todo módulo

- **Segredo nunca em arquivo do app.** Senha local só como `PasswordHash` (PBKDF2). Credencial de
  ferramenta só no chaveiro (`SecretStore`). Nunca em `store`, log, evento, mensagem de erro ou console.
- **O frontend não tem sistema.** A página só chama `call()` de `src/api.ts` e, para escolher
  arquivo, `tiny.dialog.saveFile/openFile` (o caminho escolhido vai como parâmetro para o backend, que
  lê/escreve com `tjs`).
- **Guarda no backend (`backend/main.ts`).** Todo método de `ApiContract`, exceto `login.report`, só
  aceita `meta.window === 'main'`. `login.report` só aceita janelas de ferramenta (`toolOfWindow`
  não-nulo) e, quando `meta.origin` vem preenchido, só se for igual à origin da entrada daquela janela.
  Sem sessão só passam `session.state`, `session.createAccount`, `session.unlock`,
  `session.unlockBiometric`, `bond.info`, `bond.quit`. **Métodos de admin** (pessoa desbloqueada com
  `admin = true`): `catalog.get|probe|save|remove|exportToFile|importFromFile`,
  `roles.save|remove|grant`, `people.*`, `invites.issue`, `events.*`, `bond.installUpdate`. O resto
  exige sessão desbloqueada. Erro = `throw new Error('<English message>')`.
- **Gate de origin do runtime** (`scripts/gen-config.ts`): `file://*` e (só em dev)
  `http://127.0.0.1:<BOND_DEV_PORT ou 5173>` ganham `"all"`; cada origin exata de entrada do seed ganha
  `["login.report", "media.camera", "media.microphone"]` (canonico §8). The build fails when
  `tinyjs.base.json` lacks `permissions.camera`/`permissions.microphone`.
  Nunca `*` em chave de ferramenta (o gerador lança se aparecer), nunca `"all"` para ferramenta.
- **Eval só na origin da entrada e só no frame de cima**, conferido duas vezes: no backend antes de
  chamar `eval` (depois de qualquer `await`) e dentro do próprio script (`location.origin` igual à
  esperada e `window.top === window`, senão sai sem fazer nada).
- **Mensagens únicas de autenticação**: `'invalid credentials'` (e-mail ou senha); `'invalid invite'`
  (ausente, usado ou expirado).
- **URL em evento**: só `origin + pathname` (`auditUrl` em `shared/catalog.ts`) — query e fragmento
  podem levar token.
- **Datas** ISO 8601 UTC. **Ids**: entrada = slug `^[a-z0-9][a-z0-9-]{0,39}$`; o resto
  `crypto.randomUUID()`.
- **Capacidades**: o backend lê `capabilities()` uma vez no `init` (confira onde ela existe no
  `TinyApp` em `backend/tiny.d.ts`) e só usa bandeja, atalho global e biometria quando o valor não é
  `false`.

## 3. `shared/` — lógica pura (`bun test`)

### `shared/auth.ts`
```ts
export const PBKDF2_ITERATIONS = 600_000;
export function hashPassword(password: string, iterations?: number): Promise<PasswordHash>;
export function verifyPassword(password: string, h: PasswordHash): Promise<boolean>; // constant-time
export function validateNewPassword(password: string): string | null;              // 'password must be at least 8 characters'
export function generateInviteCode(): string;                                       // 32 random bytes, base64url, no padding
export function hashInviteCode(code: string): Promise<string>;                      // sha256, lowercase hex
export function inviteIsValid(i: { expiresAt: string; usedAt: string | null }, now: Date): boolean;
export function unlockWait(failures: number): number;                               // 0 up to 4; then 1000·2^(n−5), cap 15 min
```

### `shared/catalog.ts`
```ts
export function originOf(url: string): string;      // https only (http only loopback); host ^[a-z0-9.-]+$ or IPv6 loopback;
                                                    // rejects user:password@ ; throws 'invalid address' / 'address must be https'
export function auditUrl(url: string): string | null; // origin + pathname; null if invalid
export function slug(text: string): string;
export function validateEntry(e: unknown): Entry;    // defaults; views must share the entry origin ('view outside the tool origin')
export function validateSeed(s: unknown): Seed;      // rejects any KEY matching /password|secret|token|senha|segredo/i at any depth
                                                    // ('the seed must not contain secrets: <key>'); roles referenced must exist
                                                    // ('unknown role: <id>'); codeHash hex64; version integer ≥ 1
export function visibleEntries(entries: Entry[], person: { roles: Id[]; admin: boolean }): Entry[];
                                                    // active only; admin sees all; order asc, then title (localeCompare 'en')
export function planSeed(
  current: { entries: Id[]; roles: Id[]; invites: string[]; seedVersion: number | null },
  seed: Seed,
  mode: 'boot' | 'merge' | 'overwrite',
): { insertEntries: Entry[]; updateEntries: Entry[]; insertRoles: Role[]; updateRoles: Role[];
     insertInvites: InviteSeed[]; seedVersion: number } | null;
  // boot: null if seed.version <= seedVersion; inserts only (RF-27)
  // merge: always; inserts only; seedVersion = max(current, seed)
  // overwrite: always; inserts the new AND updates existing entries/roles (A12); seedVersion = max
export function exportSeed(d: { entries: Entry[]; roles: Role[]; invites: InviteSeed[];
  update: { url: string } | null; version: number }, now: Date): Seed;   // must pass validateSeed
```

### `shared/login-cascade.ts` — cascata de login (canonico §8, §11)
```ts
export interface CascadeState { origin: string; attempts: number; leftOrigin: boolean; result: LoginResult | null }
export type CascadeSignal =
  | { type: 'navigated'; url: string }     // policy/start of the main frame, including each redirect hop
  | { type: 'finished'; url: string }      // main-frame load finished (or a re-check timer)
  | { type: 'report'; state: ReportState };
export type CascadeAction =
  | { type: 'none' }
  | { type: 'inject'; fill: boolean }
  | { type: 'result'; result: LoginResult };
export function newCascade(origin: string): CascadeState;
export function stepCascade(s: CascadeState, signal: CascadeSignal,
  ctx: { hasCredential: boolean; noFill: boolean }): { state: CascadeState; action: CascadeAction };
```
Regras (fonte única; um teste por regra; nunca muta o estado recebido):
1. `result` definido → `none`.
2. `navigated`/`finished` com origin ≠ `origin` (URL inválida conta como diferente) → `leftOrigin = true`, `none`.
3. `navigated` na `origin` → `none`.
4. `finished` na `origin` → `inject` com `fill = hasCredential && !noFill && attempts === 0`; **se `fill`,
   `attempts += 1` na hora** (a tentativa conta quando é feita, não quando é relatada — sem relato,
   nunca há segundo preenchimento).
5. `report 'no-form'` → `provider` se `leftOrigin`; senão `filled` se `attempts > 0`; senão `session`.
6. `report 'filled'` → `none`.
7. `report 'form'` → `failed` se `attempts > 0`; senão `manual`.
8. `report 'error'` → `failed`.

### `shared/shortcuts.ts`
```ts
export function digits(ids: Id[]): Map<number, Id>;                              // 1..9 in the given order
export function combo(key: string, os: 'macos' | 'windows' | 'linux'): string; // 'cmd+<k>' on macOS, 'ctrl+<k>' elsewhere
```

### `shared/probe.ts` — cadastro assistido
```ts
export function analyzeHtml(html: string, finalUrl: string): { title: string | null; icons: string[]; hasLoginForm: boolean };
  // only the first 256 KiB; linear scan (indexOf), no backtracking regex over the whole document
  // icons: absolute URLs, preference: apple-touch-icon, <link rel~=icon> (png/svg first), og:image, /favicon.ico last
export function detectProvider(entryOrigin: string, finalUrl: string): string | null;
export function isIdentityPath(url: string): boolean;  // path matches /(oauth2?|oidc|openid|authorize|realms\/|\/sso\b|saml)/i
export function cleanTitle(title: string): string;     // cut at ' · ', ' | ', ' — ', ' – ', ' - '
export function iconType(url: string, contentType: string | null): RawIcon['type'] | null; // ico → null
```

### `shared/vault-export.ts` — export opcional (RF-28)
```ts
export function exportVault(items: VaultExportItem[], password: string, iterations?: number): Promise<string>;
  // base64 of JSON { v: 1, alg: 'PBKDF2-SHA256+AES-256-GCM', iter, salt, nonce, ct }; default PBKDF2_ITERATIONS
export function importVault(blob: string, password: string): Promise<VaultExportItem[]>;
  // iter must be within [1_000, 10_000_000]
  // any failure → 'wrong password or invalid file'
```
Limite de `iter` no import: `[1_000, 10_000_000]` (os testes usam 1 000; o teto impede travar o
backend com um arquivo forjado).

## 4. `backend/` — runtime

### `backend/sqlite.ts` — `export function openSqlite(path: string): SqlDb` (tjs:sqlite; `foreign_keys`, `WAL`).

### `backend/repo.ts` — `export function createRepo(db: SqlDb): Repo`
Schema (inglês): `person(id, email UNIQUE NOCASE, name, password_hash, password_salt,
password_iterations, created_at, revoked_at)`, `role(id, name, admin)`, `person_role`, `tool(id, title,
url, origin, icon_hash, sort_order, active, auth_json, probe_json)`, `tool_view(tool_id, idx, label,
url, mode)`, `tool_grant(role_id, tool_id)`, `vault_item(id, person_id, tool_id, label, username,
keychain_key, created_at, updated_at, UNIQUE(person_id, tool_id))`, `invite(id, code_hash UNIQUE,
roles_json, expires_at, used_at, created_by)`, `event(id AUTOINCREMENT, at, person_id, tool_id, type,
url, result, detail)`, `meta(key, value)`. `migrate()` idempotente.
```ts
migrate(): void
// people
countPeople(): number                         // INCLUDING revoked (first-account rule, P6)
countAdmins(): number                         // active people with an admin role
createPerson(p: { email; name; password: PasswordHash; roles: Id[] }): Person
createPersonWithInvite(p: { email; name; password: PasswordHash }, codeHash: string, now: Date): Person | null
                                              // one transaction: consume (UPDATE … WHERE used_at IS NULL AND expires_at > now)
                                              // then insert with the invite roles; null if not consumed (D7)
personByEmail(email): { person: Person; password: PasswordHash } | null   // ignores revoked
personById(id): Person | null                 // ignores revoked
listPeople(): Person[]                        // ignores revoked
setRoles(personId, roles): Person
changePassword(personId, password: PasswordHash): void
revokePerson(personId): void
// roles
listRoles(): Role[]; saveRole(r: Role): Role; removeRole(id): void   // 'the admin role cannot be removed'
ensureAdminRole(): Role                       // id 'admin', name 'Admin', admin true
// catalog
listEntries(): Entry[]                        // icon = null (icons come from iconHash)
entry(id): Entry | null
saveEntry(e: Entry, extras?: { iconHash?: string | null; probe?: Probe | null }): Entry  // upsert; rewrites views and grants;
                                              // iconHash/probe only change when the key is present in extras
removeEntry(id): void
grant(roleId, toolId, granted: boolean): void
iconHash(id): string | null
probe(id): Probe | null
// invites
saveInvite(i: { codeHash; roles; expiresAt; createdBy: Id | null }): Invite   // repeated hash → returns existing
activeInvite(codeHash, now): Invite | null
listInvites(): Invite[]
// vault index
listVault(personId): VaultItem[]
vaultItem(personId, toolId): VaultItem | null
vaultItemsByTool(toolId): VaultItem[]         // all people (to clean the keychain when a tool is removed)
saveVaultItem(i: { personId; toolId; label; username; keychainKey }): VaultItem
removeVaultItem(personId, toolId): void
removeVaultOf(personId): VaultItem[]
// events
addEvent(e: Omit<AuditEvent, 'id' | 'at'> & { at?: string }): AuditEvent
listEvents(f: EventFilter): AuditEvent[]      // newest first, default limit 500
eventsJsonl(): string                         // chronological, one JSON per line
loginResults(toolId, limit): LoginResult[]    // newest first, from 'login' events
// meta
meta(key): string | null; setMeta(key, value): void
```

### `backend/session.ts` — `export function createSession(deps): Session`
```ts
deps: { repo: Repo; keychain: SecretStore; store: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<boolean> };
        authenticate: (reason: string) => Promise<boolean>; biometricAvailable: boolean;
        iterations?: number; now?: () => Date }
state(): Promise<SessionState>
createAccount(p: { email; name; password; code? }): Promise<SessionState>
  // countPeople() === 0 and no open invite → admin; otherwise code required → createPersonWithInvite (null → 'invalid invite');
  // 'email already registered'; the new account is unlocked
unlock(p: { email; password }): Promise<SessionState>   // backoff in meta 'unlock_failures' / 'unlock_last_failure';
                                                       // same cost for unknown email; 'invalid credentials'; 'wait before trying again'
unlockBiometric(): Promise<SessionState>; enableBiometric(password): Promise<SessionState>
changePassword(current, next): Promise<void>
lock(): SessionState
current(): Person | null
refresh(): void                               // reloads the current person from the repo (roles changed — A23); locks if revoked
```
Biometria: `enableBiometric` grava `bond.bio.<person>` no chaveiro e `last_person` no `store`.

### `backend/vault.ts` — `export function createVault(deps: { repo; keychain; iterations? }): Vault`
```ts
key(personId, toolId): string                 // 'bond.cred.<person>.<tool>'
list(personId); save(personId, p: { toolId; username; secret; label? }): Promise<VaultItem>
  // tool must exist ('unknown tool'); keychain first, index only if the keychain accepted
  // ('the system keychain refused the credential')
read(personId, toolId): Promise<{ username; secret } | null>
remove(personId, toolId); removeAllOf(personId); removeAllForTool(toolId)   // keychain + index (A6)
export(personId, password): Promise<string>; import(personId, blob, password): Promise<number>
```

### `backend/tool-windows.ts` — janelas de ferramenta, cascata, atalhos (canonico §7)
```ts
export function createToolWindows(app: TinyApp, deps: {
  entries(): Entry[];                         // visible to the current person (empty when locked)
  icon(id: Id): string | null;
  credential(toolId: Id): Promise<{ username: string; secret: string } | null>;
  hasCredential(toolId: Id): boolean;      // synchronous, from the vault index (the cascade needs it before injecting)
  record(e: Omit<AuditEvent, 'id' | 'at'>): void;
  store: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<boolean> };
  os: 'macos' | 'windows' | 'linux';
  hotkeys: boolean;
}): ToolWindows
state(): ToolsState
open(id): Promise<ToolsState>                 // open window → show() (focus, no reload); otherwise opens it
openView(toolId, index): Promise<ToolsState>  // 'window' → its own window at the view URL; 'navigate' → if the tool window
                                              // is open, eval location.href; if cold, open it directly at the view URL (A8)
close(id): ToolsState                         // closes every window of the tool
reload(id): Promise<ToolsState>
closeAll(): void                              // tool windows + tracked popups (on lock — D1)
restore(): Promise<void>                      // reopens the persisted list ('open_tools' in store), only visible tools (RF-06)
reconcile(): void                             // closes windows of tools no longer visible (canonico §10)
onNavigate(ev: TinyNavEvent): 'deny' | 'external' | undefined
onReport(windowId: string, state: ReportState, origin: string | undefined): void
onPopup(info: TinyPopupEvent): 'window' | 'external' | 'deny' | undefined
onWindowClosed(id: string): void
onFocus(windowId: string, focused: boolean): void
onHotkey(id: string): void                    // 'digit-1'..'digit-9' → open; 'palette' → show main + push 'palette'
```
- Abrir: `app.win.open(toolWindowId(id), { page: url, title, size: 'WxH', x, y })` e logo depois
  `setPosition`/`setSize` no handle (o launcher não respeitou `x`/`size` do `win.open` — observado por
  execução na v1). Geometria padrão: 1280×800 limitada a 90% da área útil da tela da janela `main`,
  em cascata (+28 px) a partir do canto da `main`. Moldura nativa, janela independente.
- `loading` até o primeiro `finish`; `fail`/`crash` → `error`, evento `load_failed` com `auditUrl`.
- Cascata (`stepCascade`): `navigated` em `policy`/`start` de main frame (`isMainFrame !== false`);
  `finished` em `finish` de main frame (ignore `isMainFrame === false`); `report` em `onReport`.
  Ação `inject`: busca a credencial só quando `fill`; **depois do `await`, reconfira que a janela
  ainda existe e que a última URL vista tem a origin da entrada** antes do `eval`; o script recebe a
  origin esperada. Se injetou com `fill` e nenhum `finish` chegar em 4 s, alimente
  `{ type: 'finished', url: lastUrl }` (relogin por XHR, A7). Falha do `eval` → evento `login` com
  resultado `failed` (A10). Ação `result` → `login` no `ToolStatus` + evento `login`.
- Origins vistas fora da entrada durante a cascata (provedor) ficam guardadas por janela.
- Navegação (`onNavigate`, só janelas de ferramenta): `policy` com `http:` fora de loopback →
  `'deny'` + evento `navigation_blocked` (A20); `https:`/loopback → permitir; `mailto:`/`tel:` com
  `isMainFrame !== false` → `'external'` + evento `external_opened`; qualquer outro esquema → `'deny'`
  + evento `navigation_blocked` (D2).
- Popups (`onPopup`, `kind 'policy'`, opener = janela de ferramenta): só `http(s)`; `'window'` se a
  origin é a da entrada, uma origin de provedor já vista naquela janela, ou `isIdentityPath(url)`;
  senão `'external'` + evento `external_opened`; outros esquemas `'deny'`. `kind 'open'` com
  `action 'window'` → guarda `info.window` para fechar no bloqueio (D1).
- Persistência: a lista `{ toolId, view? }` das janelas abertas vai para `store` (`open_tools`) a
  cada abrir/fechar.
- Atalhos: `app.hotkey.register('digit-N', combo(String(N), os))` e `('palette', combo('k', os))` só
  com alguma janela do Bond focada e `deps.hotkeys`; `unregister` quando nenhuma está.

### `backend/login-adapter.ts`
`export function adapterScript(o: { fill: boolean; origin: string; username?: string; secret?: string }): string`
— IIFE: sai sem fazer nada se `location.origin !== origin` ou `window.top !== window`; espera até 3 s
(MutationObserver com teto) por um `input[type=password]` visível; nenhum → relata `'no-form'`; há e
`fill` → acha o usuário (mesmo `form`; `autocomplete|name|id` casando `user|email|login|username`;
senão o input de texto visível antes da senha), escreve pelo setter nativo + `input`/`change`, e
**só envia se a origin de `form.action` (ou do documento, sem action) for a da página** (P7) —
`requestSubmit()`, senão botão submit, senão `submit()` — e relata `'filled'`; há e não preenche →
`'form'`; exceção → `'error'`. Relato: `window.tiny && window.tiny.api.call('login.report', { state })`.
Valores só por `JSON.stringify`.

### `backend/probe-net.ts` — `export async function probe(url: string): Promise<Probe>`
`originOf`; `fetch` com redirect e **timeout de 10 s**; HTML até 2 MiB (e `analyzeHtml` só olha 256 KiB);
ícones só `http(s)`, ≤ 512 KiB. Falha → `"couldn't open the address: <reason>"`.

### `backend/seed.ts`
```ts
export async function applyBundledSeed(repo, resourcesDir: string | null, icons, readFile?: (p: string) => Promise<Uint8Array>): Promise<number | null>;
export async function importSeedFile(repo, json: string, mode: 'merge' | 'overwrite', icons): Promise<{ entries; roles; invites }>;
export function gateOrigins(seed: Seed | null): string[];
```
Ícone relativo do seed: só caminho sem `..`, sem absoluto, sem unidade. `readFile` injetável para teste.

### `backend/icons.ts` — `createIcons(dir)` → `{ save(i: RawIcon): Promise<string>; dataUri(hash): Promise<string | null> }`.

### `backend/main.ts`
- `init`: banco em `paths.data + '/bond.db'`; `migrate`; `ensureAdminRole`; seed do pacote (erro vira
  evento); `gateOrigins` do seed embutido; `capabilities()`; sessão, cofre, janelas; janela `main`
  com `setMinSize(760, 500)`; **bandeja** se a capacidade existe: `app.tray.set` com menu `open`
  ("Open Bond"), `lock` ("Lock"), separador, `quit` ("Quit Bond"), clique = `open`; ícone macOS
  `'sf:rectangle.stack'`, Windows `'emoji:🔗'`, Linux `paths.resources + '/tray.png'`; com bandeja,
  `setHideOnClose(true)` na `main`; sem bandeja, fechar a `main` encerra o app.
- `api`: todas as chaves de `ApiContract` com a guarda da §2. Desbloquear/criar conta → push `session`,
  `tools`, `restore()`. `session.lock` → `closeAll()`, push `session`. Mudança em catálogo, papéis,
  concessões ou pessoas → `session.refresh()`, `reconcile()`, push `catalog`, `tools`, `session`.
  `catalog.remove` → `vault.removeAllForTool` antes de apagar (A6). `people.revoke`: recusa a própria
  pessoa (`"you can't revoke yourself"`) e o último admin (`'the last admin cannot be revoked'`);
  sempre remove o índice do cofre da pessoa; apaga do chaveiro só com `deleteCredentials`; apaga
  `bond.bio.<id>` (A14). `bond.installUpdate` registra o evento **antes** de instalar (A13).
  `catalog.save` persiste `probe` quando vem. `catalog.get` devolve `usualLogin` = resultado mais
  frequente entre os 20 últimos `loginResults`.
- Hooks: `onNavigate`, `onWindowOpen`, `onDownload` (evento com `auditUrl`), `onWindowClosed`,
  `onWindowState` (foco), `onHotkey`, `onTray` (confira nomes e assinaturas no runtime).

## 5. `src/` — a página única

| Arquivo | Faz |
| --- | --- |
| `index.html` | `lang="en"`, título `Bond`, `<div id="app">`, `src/app.ts`, `src/style.css`. |
| `src/app.ts` | Boot e roteamento. Bloqueado: tela de entrada (criar a conta de admin / entrar / entrar com convite / Touch ID / espera). Desbloqueado: **sidebar** à esquerda (logo; um ícone por ferramenta com dígito e estado — aberta, carregando, falhou; no rodapé Settings e Lock) e **conteúdo**: Home (cartões das ferramentas: abrir/focar, vistas, fechar, estado e resultado de login) ou Settings (`src/settings.ts`). Teclado: ⌘/Ctrl+1..9 abre, ⌘/Ctrl+K paleta, ⌘/Ctrl+, Settings. Ouve `session`, `tools`, `catalog`, `palette`. |
| `src/palette.ts` | `export function openPalette(ctx): void` — overlay dentro da janela com busca (subsequência, sem acento) sobre ferramentas, vistas e ações (Home, cada aba de Settings, Lock, Quit); ↑/↓/Enter/Esc; foco preso enquanto aberta. |
| `src/settings.ts` | `export function mountSettings(root: HTMLElement, ctx: { session: SessionState; info: AppInfo; tab?: SettingsTab }): { setTab(tab: SettingsTab): void; update(session: SessionState): void; destroy(): void }`, com `export type SettingsTab = 'account' \| 'vault' \| 'tools' \| 'roles' \| 'people' \| 'activity' \| 'catalog'`. Todas as pessoas: Account (trocar senha, habilitar Touch ID, versão, atualização) e Vault (salvar/revelar 10 s/remover; export/import com `tiny.dialog`). Só admin: Tools (colar endereço → `catalog.probe` → formulário pré-preenchido; vistas, papéis, `noFill`; aviso quando a origin não está em `info.gateOrigins`; "usually signs in via …" de `catalog.get`), Roles (CRUD + concessões), People (papéis, revogar, emitir convite mostrando o código uma vez), Activity (lista + exportar JSONL), Catalog (exportar/importar seed com modo merge/overwrite). |
| `src/style.css` | Tema escuro sóbrio, monospace, contraste alto, `:focus-visible`. Classes usadas por `src/ui.ts`: `.button .button-primary .button-danger .button-ghost .field .field-label .field-hint .input .message .message-error .message-ok .message-info`. |
| `src/ui.ts` | Helpers de DOM (já escrito pelo coordenador; não editar). |

## 6. Build e dev

- `bun run app:dev` → `bun scripts/gen-config.ts dev && tinyjs dev`.
- `bun run app:build` → `bun scripts/gen-config.ts build && tinyjs build`.
- `scripts/gen-config.ts <dev|build>`: lê `tinyjs.base.json` e `resources/seed.json` (validado). Em
  `build`, seed ausente/inválido → sai 1 com `private seed missing: resources/seed.json (see resources/seed.example.json)`
  (RF-26); grava `"resources": ["seed.json", "tray.png", …ícones relativos]`. Gate da §2;
  `update` do seed → `{ url, auto: 'daily' }`; env `BOND_APP_ID` substitui `id`; env `BOND_DEV_PORT`
  (padrão 5173) muda a porta do Vite, o `devUrl` e a origin de dev — o smoke usa 5199 para conviver com
  um `app:dev` aberto.
- Gates: `bun test test/`, `bunx tsc -p tsconfig.json`, `bunx tsc -p backend/tsconfig.json`,
  `bun run app:build` com e sem seed, `bun test/smoke/run.ts`.
