# Arquitetura do Nod — contrato de implementação (v2)

Contrato entre as fatias de implementação. O **porquê** está em `docs/canonico.md`; os fatos do
runtime, em `docs/tinyjs.md`; os tipos, em `shared/types.ts`. Aqui mora o **onde** e o **como**.
Mudar uma assinatura daqui é decisão do coordenador.

**v2 (2026-10-15), por decisão do dono:** (1) uma janela só para gerenciar e usar o Nod — o rail de
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
backend/              txiki.js backend (tjs, app, sqlite, keychain, windows, host client, sync)
host/                 the guild server (Bun + Elysia 2 beta): main.ts, app.ts, config.ts, repo.ts,
                      migrations.ts, auth.ts, snapshot.ts, keys.ts, backup.ts, routes/, cli/,
                      Dockerfile, compose.yaml — see host/context.md and docs/specs/SP07
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
  `session.unlockBiometric`, `nod.info`, `nod.quit`. **Métodos de admin** (pessoa desbloqueada com
  `admin = true`): `catalog.get|probe|save|remove|exportToFile|importFromFile`,
  `roles.save|remove|grant`, `people.*`, `invites.issue`, `events.*`, `nod.installUpdate`. O resto
  exige sessão desbloqueada. Erro = `throw new Error('<English message>')`.
- **Gate de origin do runtime** (`scripts/gen-config.ts`): `file://*` e (só em dev)
  `http://127.0.0.1:<NOD_DEV_PORT ou 5173>` ganham `"all"`; cada origin exata de entrada do seed ganha
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
export interface DerivedKeys { authKey: Uint8Array; vaultKey: Uint8Array; localKey: Uint8Array }
export function deriveKeys(password: string, salt: Uint8Array, iterations: number): Promise<DerivedKeys>;
                                                    // SP02 §1: PBKDF2-HMAC-SHA256(NFC password, salt, iterations) → master, then one
                                                    // HMAC-SHA256 per label (bond/auth/v1, bond/vault/v1, bond/local/v1). Raw 32 bytes
                                                    // on purpose: the caller encodes — base64url(authKey) on the wire, SHA-256(localKey)
                                                    // in PasswordHashV2.check. Only crypto.subtle; vectors in test/auth.test.ts,
                                                    // derived again in txiki.js by the smoke (H3)
export function hashPassword(password: string, iterations?: number): Promise<PasswordHash>;
export function verifyPassword(password: string, h: PasswordHash): Promise<boolean>; // constant-time
export function validateNewPassword(password: string): string | null;              // 'password must be at least 8 characters'
export function generateInviteCode(): string;                                       // 32 random bytes, base64url, no padding
export function hashInviteCode(code: string): Promise<string>;                      // sha256, lowercase hex
export function inviteIsValid(i: { expiresAt: string; usedAt: string | null }, now: Date): boolean;
export function unlockWait(failures: number): number;                               // 0 up to 4; then 1000·2^(n−5), cap 15 min
```

### `shared/encoding.ts` — bytes on the wire (`docs/specs/README.md`)
```ts
export function toBase64url(bytes: Uint8Array): string;                             // no padding, canonical
export function fromBase64url(text: string): Uint8Array;                            // throws 'invalid base64url' on a char outside
                                                    // the alphabet, padding, length % 4 === 1 or trailing bits that are not zero.
                                                    // Decoding is hand-written: atob and txiki.js disagree on non-canonical input
export function toHex(bytes: Uint8Array): string;                                   // lowercase, two digits per byte
export function fromHex(text: string): Uint8Array;                                  // throws 'invalid hex' on an odd length or a bad char
export async function sha256Hex(data: Uint8Array | string): Promise<string>;        // crypto.subtle, lowercase hex; the one hash of
                                                    // the code hashes, token hashes, the snapshot version and the host `kid` (H4, H6)
```

### `shared/host-api.ts` — the host API contract (`docs/specs/SP03-host-api.md` §2, §4)
Every route body and response of SP03 §2–§3 (block 1 and block 2), shared by the host and the Nod,
plus `Discovery`, the signed `Snapshot` of SP04 §1–§2 (block 2's `people`, `incomingShares`,
`holders`, `rotationPending` included, all optional), `AppMeta` of O2 and the event batch of §5. The
block 2 sharing types (`PublicKeys`, `OwnKeys`, `ShareRequest`/`ShareResponse`/`ShareItem`,
`IncomingShare`, `Holder`, `AssignmentRequest`, `MissingCopy`, `SnapshotPerson`, `ShareScope`/
`ShareKind`) live here too. The host's SQL rows (`host/repo.ts`) carry these field names on purpose,
so a snapshot can hand a row over without a rename.
```ts
export const HOST_ROUTES = { health, discovery, authSalt, authActivate, authSetup, authLogin,
  authLogout, authPassword, state, sessions, session, personalTool, personalView, favorites, events,
  adminPeople, adminPerson, adminPersonCode, adminPersonSessions, adminSession, adminRole,
  adminGrants, adminTool, adminToolPromote, adminBootstrap, adminEvents, appMeta,
  keys, keysPrivate, shares, shareAccept, shareDecline, holders, holder,
  adminAssignments, adminAssignmentsMissing };                                      // paths of SP03 §2–§3 (block 2
                                                    // appended); ':id' is the segment the caller fills
export interface ErrorResponse { error: string }                                    // the only field of a failure (SP03 §1)
// auth: SaltRequest/SaltResponse, ActivateRequest, SetupRequest (+ name), LoginRequest, TokenResponse,
// PasswordChangeRequest; Device, DeviceSession, DeviceOs
// people: AdminPerson, PersonCreateRequest/Response, PersonUpdateRequest, CodeResponse, PersonKind
// admin: RoleRequest, GrantRequest, OrgTool (= Entry + views), PromoteRequest,
//        BootstrapRequest, BootstrapResponse
// person: PersonalTool (Entry + updatedAt), PersonalView (View + id/entryId/updatedAt), DeleteRequest,
//        FavoritesRequest
// block 2 sharing: PublicKeys, OwnKeys, SnapshotPerson, ShareScope, ShareKind, ShareItem,
//        ShareRequest, ShareResponse, IncomingShare, Holder, AssignmentRequest, MissingCopy
// discovery and snapshot: Discovery, AppMeta, SignInMethod, Snapshot, SnapshotEnvelope,
//        SnapshotSignature, SNAPSHOT_ETAG_HEADER ('ETag'), SNAPSHOT_SIGNATURE_HEADER ('Nod-Signature')
// events: ClientEvent, EventsRequest, EventsResponse, HostEvent, AdminEventsQuery
export type CodeKind = 'access' | 'setup';                                          // 'access' is purpose 'activate' of SP01 §2
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';                    // Crockford base32 (SP02 §3)
export const CODE_BYTES: Readonly<Record<CodeKind, number>>;                        // 5 and 10 bytes → 8 and 16 chars
export const CODE_LENGTH: Readonly<Record<CodeKind, number>>;
export function generateCode(kind: CodeKind): string;                               // crypto.getRandomValues → 'XXXX-XXXX' (SP02 §3)
export function formatCode(code: string): string;                                   // groups a normalized code in fours
export function normalizeCode(code: string): string | null;                         // uppercase, no spaces or hyphens,
                                                    // O→0, I→1, L→1; null on any other character (SP02 §3)
export function validateCode(code: string, kind: CodeKind): boolean;                // normalizeCode + that kind's length
export function normalizeEmail(email: string): string;                              // trim + lowercase, the form SP01 §2
                                                    // stores and every lookup matches
```

### `shared/host-merge.ts` — snapshot → local view (`docs/specs/SP04-sync.md` §3–§5, B5/B10)
```ts
export const ORG_CACHE_DAYS = 14; export const ORG_CACHE_MS: number;
export function orgToolsUsable(lastSyncAt: string | null, now: number): boolean;  // half-open [lastSyncAt, +14 days];
                                                    // null or unreadable date → false (fail closed)
export class SnapshotShapeError extends Error;      // a body that is not SP04 §2's document
export interface SnapshotRows { me; roles; orgTools; personalTools; personalViews; favorites }
export function parseSnapshot(value: unknown): SnapshotRows;                         // the shape check of the verified body
export function clearOrgData(raw: string): string | null;                           // 401: drop the org half, keep me +
                                                    // personal + favorites; null when the body was not a snapshot
export function sidebarOrder(rows: { orgTools: Entry[]; personalTools: Entry[]; favorites: Id[] }): Entry[];
                                                    // favorites, org, personal; an id resolving to nothing is skipped
export type OutboxVerdict = 'drop' | 'rejected' | 'retry';
export function outboxVerdict(status: number | null): OutboxVerdict;                // 409 drop; other 4xx rejected;
                                                    // 401/429/network/5xx retry (SP04 §4)
```

### `shared/seal.ts` — credential sharing (`docs/specs/SP06-credential-sharing.md` §1–§3)
```ts
export const SEAL_VERSION = 1;                                                      // first byte of the body and payload `v`
export const SEAL_PUBLIC_LENGTH = 32; export const SEAL_NONCE_LENGTH = 12;
export const SEAL_SIGNATURE_LENGTH = 64;
export type SealScope = 'role' | 'org'; export type SealKind = 'send' | 'assign' | 'update';
export interface SealPayload { v; credentialId; toolId; toolOrigin; label; username; secret; scope; from; to; kind; issuedAt }
export interface SealKeyPair { publicKey: Uint8Array; privateKey: Uint8Array }      // raw 32-byte public, PKCS#8 private (SP06 §2)
export interface SealOptions { ephemeral?: SealKeyPair; nonce?: Uint8Array }        // vectors only: pins seal byte for byte
export interface OpenOptions { recipientPrivateKey: Uint8Array; recipientPublicKey: Uint8Array;
  senderPublicKey: Uint8Array; credentialId: string; to: string }                  // the sender's key is the pinned one
export function generateX25519KeyPair(): Promise<SealKeyPair>;
export function generateEd25519KeyPair(): Promise<SealKeyPair>;
export function importX25519PublicKey(raw: Uint8Array): Promise<CryptoKey>;         // and the other three import* of SP06 §2–§3
export function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
export async function seal(payload: SealPayload, recipientPublicKey: Uint8Array, senderPrivateKey: Uint8Array,
  options?: SealOptions): Promise<string>;                                          // base64url(0x01 || eph.public || nonce ||
                                                    // ct || sig); HKDF-SHA256 hand-rolled over HMAC as SP06 §1 asks (S0)
export async function open(sealed: string, options: OpenOptions): Promise<SealPayload | null>;   // null on every refusal: bad
                                                    // base64url, bad body, bad signature, wrong key, wrong AAD. Only X25519,
                                                    // Ed25519, AES-256-GCM and HMAC-SHA256 from crypto.subtle (S0)
```

### `shared/version.ts` — the O2 gate (`docs/specs/SP04-sync.md` §1, SP03 §3, O2)
```ts
export function compareVersions(left: string, right: string): number;   // semver 2.0.0 §11 on three numeric
                                                    // components (1–2 padded) and an optional pre-release; build metadata
                                                    // ignored, a leading `v` accepted; `0` for a text that is not a version
                                                    // ("no opinion", so an unreadable `minAppVersion` never stops the sync)
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

### `shared/tabs.ts` — abas, links e o slot (E03, canonico §14)
```ts
export const LINK_WINDOW_PREFIX = 'link_';
export function tabWindowId(toolId: Id, n: number): string;        // tool_<entry>_t<n>, n >= 2
export function nextTabNumber(toolId: Id, liveIds: Iterable<string>): number;
export function linkWindowId(n: number): string;                   // link_<n>
export function nextLinkNumber(liveIds: Iterable<string>): number;
export function insertAfter(order: string[], afterId: string | null, id: string): string[];
export function neighbourAfterClose(order: string[], closedId: string): string | null;
export function stepTab(order: string[], current: string | null, step: 1 | -1): string | null;
export function parseLinkUrl(raw: string): string | null;          // http(s) only, trimmed, no userinfo, ≤ 2048 chars
export function parseOpenLink(url: string): string | null;         // nod://open?url=<encoded>
export function slotToScreen(main: { x; y; width; height; outer: { width; height } }, rect: SlotRect): SlotRect;
export function rectEquals(a: SlotRect | null, b: SlotRect | null): boolean;
export interface PersistedTab { toolId: Id; view?: number; url?: string; detached?: true; active?: true }
export function parsePersistedTabs(raw: unknown): PersistedTab[];
export function saveTarget(url: string, entries: Array<{ id: Id; url: string }>): { kind: 'view'; entryId: Id } | { kind: 'tool' } | null;
```
Puro: decide ids de janela, a ordem da faixa, que links são aceitos, o retângulo de tela do slot e o
alvo do "salvar". A lista viva de abas e as chamadas de geometria são do backend
(`docs/arquitetura.md` §4); assim a página, o backend e os testes não discordam de nenhum deles
(requisitos e epic: `docs/epics/E03-docked-tabs.md`).

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
keychain_key, created_at, updated_at, origin, UNIQUE(person_id, tool_id))`, `invite(id, code_hash UNIQUE,
roles_json, expires_at, used_at, created_by)`, `event(id AUTOINCREMENT, at, person_id, tool_id, type,
url, result, detail)`, `meta(key, value)`. `migrate()` idempotente.
```ts
migrate(): void                               // idempotent; also adds SP05 §2's columns by presence —
                                              // `vault_item.origin` (B9), backfilled from `tool.origin` —
                                              // and rebuilds `vault_item` without the FK to `tool` when
                                              // `PRAGMA foreign_key_list(vault_item)` still names it
                                              // (`rebuildVaultItem`, the SQLite 12-step recipe; `user_version`
                                              // is `SCHEMA_VERSION` = 5, the guard is the constraint)
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
vaultOrigin(personId, toolId): string | null  // the origin the credential was saved for; null without an
                                              // item, or with one that has none on record (B9, RF-38)
saveVaultItem(i: { personId; toolId; label; username; keychainKey; origin }): VaultItem
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
disableBiometric(): Promise<SessionState>              // SP02 §9's delete path (V1)
vaultKey(): Uint8Array | null                          // the key of the unlocked session (V1); null while locked
onActivated(cb: (event: { personId: Id; reset: boolean }) => void | Promise<void>): void   // the activation
                                                       // and reset hook (V1, K1); subscribers must be idempotent
adoptConnectedAccount(p: { … }): Promise<SessionState>   // after the host answered: writes the local person row for the
                                                       // host id and unlocks; wipes the vault first when the salt changed (B2/B3)
keys(): { authKey; vaultKey } | null                   // the keys kept in memory while unlocked; null when locked
deriveFor(password, salt, iterations): Promise<DerivedKeys>   // one derivation, reused by unlock/adopt/change
changePassword(current, next, host?): Promise<void>    // connected: also updates the cached host salt (saveHostSalt, B3)
wipeVault(personId: Id): Promise<void>                 // SP02 §7 reset: removes every nod.cred.* item through the index
lock(): SessionState
current(): Person | null
refresh(): void                               // reloads the current person from the repo (roles changed — A23); locks if revoked
```
Biometria: `enableBiometric` grava `nod.bio.<person>` no chaveiro e `last_person` no `store`.

### `backend/vault.ts` — `export function createVault(deps: { repo; keychain; iterations? }): Vault`
```ts
key(personId, toolId): string                 // 'nod.cred.<person>.<tool>'
list(personId); save(personId, p: { toolId; username; secret; label? }): Promise<VaultItem>
  // tool must exist ('unknown tool'); keychain first, index only if the keychain accepted
  // ('the system keychain refused the credential'); records `originOf(entry.url)` with the item, the
  // origin the fill is bound to (B9, RF-38). The entry is read from the effective catalog while
  // connected (main.ts), so a host-only tool — no local `tool` row — can hold a credential.
read(personId, toolId): Promise<{ username; secret } | null>
remove(personId, toolId); removeAllOf(personId); removeAllForTool(toolId)   // keychain + index (A6)
export(personId, password): Promise<string>; import(personId, blob, password): Promise<number>
```

### `backend/keys.ts` — the E02 key pairs and the pin table (`docs/specs/SP06-credential-sharing.md` §2, K1–K2)
```ts
export interface Keys {
  ensure(connection: HostConnection | null, options?: { regenerate?: boolean }): Promise<KeyStatus>
  reSeal(previousVaultKey: Uint8Array, connection: HostConnection | null): Promise<KeyStatus>
  mine(): Promise<MineKeys>                   // { fingerprint, status: 'ok'|'pending'|'unavailable', message } — the
                                              // card's read; no key material ever leaves
  ownPrivate(): Promise<{ x25519; ed25519; x25519Public; ed25519Public } | null>   // the sender's/sealer's read (K4)
  observe(connection): Promise<boolean>; peers(): Promise<PeerKey[]>;
  peerKeyFor(personId: Id): Promise<{ x25519; ed25519; fingerprint; status } | null>   // the only seam a sender may read
  confirm(personId: Id): Promise<true>
}
export function createKeys(deps): Keys;
```
The private halves exist only inside the `bv1.` value of `nod.keys.<person>` (AAD = the same keychain
key) and the memory of an unlock; the public halves are `meta.keys.public.<person>`. One pair per
person across machines (canonico §22): the first machine publishes a second `bv1.` blob as
`PUT /v1/keys`'s `privateSealed`, and the others open it with `GET /v1/keys/private` instead of
generating a competitor; `reSeal` follows a password change. `observe` runs on each applied snapshot.

### `backend/shares.ts` — the share flows (`docs/specs/SP06-credential-sharing.md` §3–§5, K4–K9)
```ts
export interface Shares {
  recipients(toolId: Id): Promise<ShareRecipient[]>
  send(toolId: Id, to: Id[], gate): Promise<{ sent: number }>          // gate → read → scope → seal per pinned key → POST
  inbox(): Promise<InboxShare[]>; accept(id: Id, gate): Promise<VaultItem>; decline(id: Id): Promise<true>
  setScope(toolId: Id, scope: ShareScope): Promise<VaultItem>
  update(toolId: Id): Promise<void>                                     // K9: the owner's save re-seals to live holders
  retryPending(); applyUpdates()                                        // K9: per sync / per applied snapshot
  removeHolder(toolId: Id, personId: Id): Promise<VaultItem>
  assign(input, gate); missing(): Promise<MissingCopyView[]>; sealMissing(gate): Promise<{ sent; skipped }>
  refreshAssignments(connection); missingCount(): number                // K8: the sync read and `HostState.missingCopies`
  decorate(personId, items): Promise<VaultItem[]>                       // holders + rotationPending on the vault list
}
export function createShares(deps): Shares;
```
The scope is decided twice — here against the verified snapshot (`scopeDecision`) and by the host on
its own rows — and a sealed payload never carries a scope wider than the credential's.

### `backend/personal.ts` — the person's own tools, views and favorites (`docs/specs/SP05-nod-connected.md` §2–§4, B7/B8b)
```ts
export interface Personal {
  generatePersonalToolId(): Id                // `p-` + ten Crockford chars (SP02 §3)
  saveTool(draft); removeTool(id); saveView(draft); removeView(id)
  setFavorites(ids); localFavorites(personId); localCatalog(personId)
  adoptSnapshot(body, personId, keep: boolean, ops?): void              // host.remove keeps or drops the personal half
  adoptLocalTool(local, icon): Promise<Entry>                           // RF-40: a leftover becomes a personal tool
  ownedTool(id, personId)                     // a local `personal` row is recognised while connected
}
export function createPersonal(deps): Personal;
```
While a `host` row exists a write appends one `host_outbox` row (SP04 §4) and re-derives the
catalog; without one it writes the local `tool`/`meta` tables.

### `backend/tool-windows.ts` — abas, janelas de ferramenta, cascata, atalhos (canonico §7, §14; E03)
```ts
export function createToolWindows(app: TinyApp, deps: {
  entries(): Entry[];                         // visible to the current person (empty when locked)
  icon(id: Id): string | null;
  credential(toolId: Id): Promise<{ username: string; secret: string } | null>;
  vaultOrigin(toolId: Id): string | null;  // the origin the credential was saved for (B9, RF-38);
                                           // synchronous, the cascade needs the answer before injecting
  record(e: Omit<AuditEvent, 'id' | 'at'>): void;
  store: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<boolean> };
  os: 'macos' | 'windows' | 'linux';
  hotkeys: boolean;
  saveTab(id: string): Promise<SaveTabResult>;  // E03: what ⌘D does — `backend/main.ts` `tabs.save`
}): ToolWindows
state(): ToolsState
open(id): Promise<ToolsState>                 // open window → show() (focus, no reload); otherwise opens it
openView(toolId, index): Promise<ToolsState>  // 'window' → its own tab at the view URL; 'navigate' → the tool's tab (A8)
close(id): ToolsState                         // closes every tab of the tool
reload(id): Promise<ToolsState>
closeAll(): void                              // tool tabs + tracked popups (on lock — D1)
restore(): Promise<void>                      // reopens `open_tools` in order, docked/detached as saved (RF-49/T6)
reconcile(): void                             // closes windows of tools no longer visible (canonico §10)
onNavigate(ev: TinyNavEvent): 'deny' | 'external' | undefined
onReport(windowId: string, state: ReportState, origin: string | undefined): void
onPopup(info: TinyPopupEvent): 'window' | 'external' | 'deny' | undefined
onWindowClosed(id: string): void
onWindowState(ev: TinyWindowStateEvent): void // focus, minimize and visibility of the main window and ours
onHotkey(id: string): void                    // 'digit-1'..'digit-9' → open; 'palette' → show main + push 'palette'
newTab(toolId): Promise<ToolsState>           // 'tabs.new' (⌘T): one more tab of the tool
activate(id): ToolsState                      // 'tabs.activate': a docked tab takes the slot, a detached one comes forward
closeTab(id): ToolsState                      // 'tabs.close' (⌘W)
closeAllTabs(): ToolsState                    // 'tabs.closeAll' (0.7.0c): every tab, docked or detached; open_tools emptied
next(step: 1 | -1): ToolsState                // 'tabs.next' (⌃Tab/⌃⇧Tab), wrapping
detach(id) / dock(id): ToolsState             // 'tabs.detach'/'tabs.dock' (⌘⇧D) — same window, no reload (RF-51)
setSlot(rect: SlotRect | null): true          // 'tabs.slot' (RF-49): the center panel as the page sees it
openLink(url): Promise<ToolsState>            // 'tabs.openLink' (RF-66)
tabForSave(id) / adoptSavedTab(id, toolId)    // 'tabs.save' (RF-67)
```
- **Toda janela de ferramenta é uma aba (E03).** O id da primeira aba de uma ferramenta continua o do
  dia um — `tool_<entry>`, ou `tool_<entry>_<viewIndex>` numa vista `window` —, cada aba seguinte é
  `tool_<entry>_t<n>`, e uma aba ad-hoc é `link_<n>` ou o id do popup adotado (`popup<N>`).
  `toolOfWindow` divide no `_`, então responde a mesma ferramenta para toda aba. Uma aba ad-hoc
  (`toolId: null`) nunca é persistida, nunca conta para uma ferramenta, nunca entra na cascata, nunca
  recebe `eval` e não tem método de backend nenhum (o gate de `api.origins` recusa a origin não
  listada — RF-66, RF-68).
- **Modo derivado do runtime (2026-10-22; `backend/tool-windows.ts` `effectiveMode`).** Não há ajuste
  Docked/Windows: onde o runtime posiciona janelas (`canPosition !== false`) toda ferramenta abre como
  aba sobre o slot — **docked**, o padrão —, e só onde ele não posiciona (Wayland) o Nod cai em
  **windows**, o comportamento do dia um — uma janela com moldura por ferramenta, abrir uma aberta só
  foca, nada recarrega (RF-19). Em docked a aba ativa fica **sem moldura** sobre o slot que a página
  reporta, seguindo a `main` e escondendo com ela; só a aba ativa aparece e as outras mantêm a página
  viva, escondidas (RF-50). (§22 "Seamless tabs: always inside, detach on demand".)
- **Slot (RF-49).** A página manda `tabs.slot` com o retângulo do painel central em CSS px;
  `shared/tabs.ts` `slotToScreen` converte para coordenadas de tela e o backend põe ali a aba ativa,
  pulando a reposição quando nada mudou (`rectEquals`). O runtime não reporta movimento da `main`
  (`onState` cobre só fullscreen/maximize/minimize/foco — `backend/tiny.d.ts`), então, enquanto há
  uma aba docked mostrada e a `main` está visível e não minimizada (com foco ou sem: um tiling WM, uma
  troca de Space ou monitor a movem sem foco), um poll de 50 ms (`MOVE_POLL_MS`) lê `getState()` e
  reposiciona (lag ≈ um intervalo, medido em `docs/handovers/e03-spikes.md` §4). Ao ganhar foco, a aba docked sobe de
  novo com `show({ activate: false })` para não ficar atrás da `main`. Wayland (`canPosition: false`)
  não tem slot: cai no modo windows.
- **Troca e desencaixe (RF-50, RF-51).** Trocar de aba é `hide({ app: false })` na atual e `show` na
  próxima — a página escondida fica viva, nada recarrega (mesmo mecanismo de RNF-09). `detach`/`dock`
  são `setChrome({ frame: true|false })` na **mesma** janela: rascunho, scroll e estado da página
  sobrevivem (`docs/handovers/e03-spikes.md` §3).
- **Popups (E03 §5).** Em docked, um popup `http(s)` que uma aba abriu é adotado como aba ad-hoc logo
  depois dela (o evento `open` não traz o `opener`, então a resposta `policy` o memoriza) e perde a
  moldura; um caminho de identidade conhecido (`isIdentityPath`) continua popup flutuante. No
  fallback windows a resposta `policy` vale `'window'` se a origin é a da entrada, uma origin de
  provedor já vista naquela janela, ou `isIdentityPath(url)`; senão `'external'` + evento
  `external_opened`; outros esquemas `'deny'`. `kind 'open'` com `action 'window'` também guarda a
  janela para fechar no bloqueio (D1).
- **Atalhos.** `digit-1`..`digit-9` abrem e `palette` sobe a `main` (`push 'palette'`). Em docked o
  backend registra também, globalmente e só com alguma janela do Nod focada: `tab-new` (⌘T),
  `tab-close` (⌘W), `tab-next`/`tab-prev` (⌃Tab/⌃⇧Tab), `tab-detach`/`tab-dock` (⌘⇧D), `open-link`
  (⌘L, `push 'openLink'` — a página abre o diálogo) e `tab-save` (⌘D); `unregister` quando nenhuma
  está.
- **Persistência.** `open_tools` guarda cada aba com `{ toolId, view, url, detached, active }` (abas
  ad-hoc fora); `restore()` reabre na ordem e no estado salvos. Não há chave de modo no `store`: o
  modo vem do runtime (`canPosition`, §4 acima).
- Fill gate (B9, RF-38): a cascata context reads
  `hasCredential = vaultOrigin(toolId) !== null && vaultOrigin(toolId) === window.origin`, where
  `window.origin` is the canonical origin of the entry address the window opened at. A tool whose
  address moved — a local edit or a host snapshot rewriting the entry — reads as one with no
  credential: `fill: false`, no attempt counted, no keychain read. The credential belongs to the
  origin, not to the page: another path on the same origin still fills.
- Abrir: em **windows** a janela nasce com moldura e a geometria padrão — 1280×800 limitada a 90% da
  área útil da tela da `main`, em cascata (+28 px) a partir do canto dela —, aplicada por
  `app.win.open(id, { page, title, size, x, y })` e, no mesmo tick, `setPosition`/`setSize` no handle.
  O retângulo pedido é entregue; o que embaralhava os frames dos tools era o gerenciador de janelas
  em mosaico do macOS (B05, `docs/handovers/e03-spikes.md` §1, §8.9). Em **docked** a aba nasce sem
  moldura, já no slot reportado (`chrome: { frame: false }` + `setPosition`/`setSize` no mesmo tick).
- `loading` até o primeiro `finish`; `fail`/`crash` → `error`, evento `load_failed` com `auditUrl`.
- Cascata (`stepCascade`): `navigated` em `policy`/`start` de main frame (`isMainFrame !== false`);
  `finished` em `finish` de main frame (ignore `isMainFrame === false`); `report` em `onReport`.
  Ação `inject`: busca a credencial só quando `fill`; **depois do `await`, reconfira que a janela
  ainda existe e que a última URL vista tem a origin da entrada** antes do `eval`; o script recebe a
  origin esperada. Se injetou com `fill` e nenhum `finish` chegar em 4 s, alimente
  `{ type: 'finished', url: lastUrl }` (relogin por XHR, A7). Falha do `eval` → evento `login` com
  resultado `failed` (A10). Ação `result` → `login` no `ToolStatus` + evento `login`.
- Origins vistas fora da entrada durante a cascata (provedor) ficam guardadas por janela.
- Navegação (`onNavigate`, só abas de ferramenta): `policy` com `http:` fora de loopback →
  `'deny'` + evento `navigation_blocked` (A20); `https:`/loopback → permitir; `mailto:`/`tel:` com
  `isMainFrame !== false` → `'external'` + evento `external_opened`; qualquer outro esquema → `'deny'`
  + evento `navigation_blocked` (D2).

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

### `backend/guild-icon.ts` — the guild's PNG on this machine (`docs/specs/SP05-nod-connected.md` §6)
```ts
export const GUILD_ICON_FILE = 'guild-icon.png'; export const APP_ICON_KEY = 'appIcon';
export interface GuildIcon { sync(hash: string | null): Promise<void>; state(): Promise<AppIconState>;
  setChoice(choice: AppIconChoice): Promise<AppIconState>; reset(): Promise<void> }
export function createGuildIcon(deps): GuildIcon;
```
`sync` fetches `GET /v1/guild/icon` only when the signed digest moved and writes the bytes only when
their SHA-256 equals it; `null` deletes the file. The choice is `appIcon` in `store`, applied through
`app.icon` only when `capabilities().icon !== false`.

### `backend/host-client.ts` — the host connection (`docs/specs/SP04-sync.md` §1–§2, B1)
```ts
export const REQUEST_TIMEOUT_MS = 10_000;               // the same ceiling as probe-net
export const HOST_KEY_CHANGED = 'host key changed — remove and add the host again';
export const HOST_KEY_MISMATCH = 'host key does not match the invite';
export type HostFailure = 'offline' | 'signed-out' | 'rate-limited' | 'refused' | 'server' | 'key-changed'
  | 'key-mismatch' | 'signature' | 'stale' | 'invalid' | 'keychain';
export class HostError extends Error;                   // carries HostFailure + optional status
export interface PinnedHost { address: string; kid: string; publicKey: string; personId: Id }
export interface DiscoveryExpectation { fingerprint?: string | null; pinned?: { kid: string; ed25519Public: string } }
export interface HostDiscovery { address: string; fingerprint: string; pin: { kid: string; ed25519Public: string };
  document: Discovery }
export type SnapshotResult = { notModified: true } | { notModified: false; snapshot: Snapshot; raw: string };
export interface HostConnection {
  readonly host: PinnedHost;
  tokenKey(): string; saveToken(token: string): Promise<void>; forgetToken(): Promise<void>;
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  getBytes(path: string): Promise<Uint8Array<ArrayBuffer>>;                          // the one bytes route (guild icon)
  snapshot(options?: { version?: string | null; notOlderThan?: string | null }): Promise<SnapshotResult>;
  sessions(): Promise<DeviceSession[]>; revokeSession(id: Id): Promise<true>;        // O1
  presence(): Promise<PresenceEntry[]>;                                             // RF-58
  putKeys(keys: PublicKeys): Promise<void>; getOwnKeys(): Promise<OwnKeys | null>;   // K1, canonico §22
  sendShares(request: ShareRequest): Promise<ShareResponse>;                         // K4/K9
  acceptShare(id: Id): Promise<true>; declineShare(id: Id): Promise<true>;
  removeHolder(credentialId: Id, personId: Id): Promise<true>;                       // K9
  putAssignment(request: AssignmentRequest): Promise<true>; missingCopies(): Promise<MissingCopy[]>;  // K8
  appMeta(): Promise<AppMeta>;                                                      // O2, no bearer
}
export interface HostClient {
  discover(address: string, expect?: DiscoveryExpectation): Promise<HostDiscovery>;   // SP04 §1 steps 1–4, writes nothing
  connect(host: PinnedHost): HostConnection;                                           // with a pinned host (RF-30)
}
export async function fingerprintOf(rawPublicKey: Uint8Array): Promise<string>;        // SP04 §1.1; a copy of
                                                    // `shared/host-api.ts`'s private encoder until it moves there
export function hostTokenKey(kid: string, personId: Id): string;                       // 'nod.host.<kid>.<personId>'
export function createHostClient(deps: { fetch; keychain }): HostClient;
```
The bearer is read from and written to the keychain only (SP02 §5); the client never logs or reads a
failing body (its messages are its own constants, B1).

### `backend/sync.ts` — the sync loop (`docs/specs/SP04-sync.md` §3–§5, B4/B10)
```ts
export const SYNC_INTERVAL_MS = 5 * 60_000; export const AFTER_WRITE_MS = 1_000;
export const BACKOFF_MS = [30_000, 60_000, 120_000, SYNC_INTERVAL_MS];
export const EVENTS_PER_BATCH = 500;
export const SIGNED_OUT_ERROR = 'signed out — sign in again';   // the marker it leaves in host.last_error (b4)
export interface SyncDeps { repo; connection(); now(); appVersion(); onState; onSignedOut;
  setInterval; clearInterval; refreshAssignments?; missingCopies? }              // O2's `appVersion`; K8's two reads
export interface Sync { start(); stop(); syncNow(): Promise<HostState>; state(): HostState; afterWrite();
  observeMinVersion(version: string): void }                                     // O2: the minimum a host just told
export function createSync(deps: SyncDeps): Sync;
```
Order per run: read `GET /v1/meta/app` first and, while this Nod is older than the host's
`minAppVersion`, push nothing (O2, SP04 §3); otherwise flush the outbox, push events
(`backend/sync.ts`'s `pushEvents`, up to 500 per batch, repeated until a batch confirms nothing),
then `GET /v1/state`. A `401` writes `SIGNED_OUT_ERROR`,
`clearOrgData` empties the org half and asks for sign-in; a changed key stops the loop as `stale`; any
other failure goes `stale` with the backoff. `HostState`'s status derives from the row
(`none` / `signed-out` / `stale` / `connected`).

### `backend/connected-catalog.ts` — the effective catalog (`SP05 §2`, B5)
```ts
export interface HostSnapshotRow { snapshot: string | null; version: string | null; lastSyncAt: string | null; personId: Id }
export interface EffectiveCatalog { version; orgUsable; me; roles; entries }
export interface ConnectedCatalog {
  refresh(record: HostSnapshotRow | null): boolean;   // re-derives from the row; answers "the page's view changed"
  current(): EffectiveCatalog | null; entries(): Entry[]; roles(): Role[];
}
export function createConnectedCatalog(deps: { now: () => number }): ConnectedCatalog;
```
The body is parsed when its bytes changed (not the `version`: a `401` rewrites the body under the
same version). The org half goes through `visibleEntries` and is shown only while `orgToolsUsable`;
a body naming someone else is refused; no readable body yields an empty catalog, never the local
tables.

### `backend/host-admin.ts` — admin writes to the host (`SP05 §3`, B6/B8a)
```ts
export const BOOTSTRAP_CLOSED = 'the guild already has org tools';
export interface HostAdmin {
  saveTool(tool: Entry): Promise<OrgTool>; removeTool(id: Id): Promise<true>;
  saveRole(role: Role): Promise<Role>; removeRole(id: Id): Promise<true>;
  grant(roleId: Id, entryId: Id, granted: boolean): Promise<true>;
  listPeople(): Promise<Person[]>; setRoles(personId, roles): Promise<Person>; disable(personId): Promise<Person>;
  createPerson(input): Promise<PersonCreateResponse>; issueCode(personId: Id): Promise<CodeResponse>;
  listEvents(filter): Promise<AuditEvent[]>;
  bootstrap(tools: Entry[], roles: Role[]): Promise<{ created: number; refused: boolean }>;
}
export function hostAdminFor(connection: HostConnection | null): HostAdmin | null;   // null → the local path (RF-30)
export function orgViewsOf(views: View[]): View[];                                   // strips a person's personal views
export function createHostAdmin(connection: HostConnection): HostAdmin;
```
`host.bootstrap` answers the host's `409` as `{ created: 0, refused: true }` instead of throwing
(B8a); every user-facing host-error sentence is written here, never read from a host body (B6).

### `backend/main.ts`
- `init`: banco em `paths.data + '/nod.db'`; `migrate`; `ensureAdminRole`; seed do pacote (erro vira
  evento); `gateOrigins` do seed embutido; `capabilities()`; sessão, cofre, janelas; janela `main`
  com `setMinSize(760, 500)`; **bandeja** se a capacidade existe: `app.tray.set` com menu `open`
  ("Open Nod"), `lock` ("Lock"), separador, `quit` ("Quit Nod"), clique = `open`; ícone macOS
  `'sf:rectangle.stack'`, Windows `'emoji:🔗'`, Linux `paths.resources + '/tray.png'`; com bandeja,
  `setHideOnClose(true)` na `main`; sem bandeja, fechar a `main` encerra o app.
- `api`: todas as chaves de `ApiContract` com a guarda da §2. Desbloquear/criar conta → push `session`,
  `tools`, `restore()`. `session.lock` → `closeAll()`, push `session`. Mudança em catálogo, papéis,
  concessões ou pessoas → `session.refresh()`, `reconcile()`, push `catalog`, `tools`, `session`.
  `catalog.remove` → `vault.removeAllForTool` antes de apagar (A6). `people.revoke`: recusa a própria
  pessoa (`"you can't revoke yourself"`) e o último admin (`'the last admin cannot be revoked'`);
  sempre remove o índice do cofre da pessoa; apaga do chaveiro só com `deleteCredentials`; apaga
  `nod.bio.<id>` (A14). `nod.installUpdate` registra o evento **antes** de instalar (A13).
  `catalog.save` persiste `probe` quando vem. `catalog.get` devolve `usualLogin` = resultado mais
  frequente entre os 20 últimos `loginResults`.
- **Connected mode** (SP05 §3): the RPC methods `host.state|discover|activate|signIn|syncNow|remove|bootstrap`
  and `events.syncStatus` land here (block 1); `host.activate`/`host.signIn` derive the keys in the
  backend and never store or log the password. A `host` row starts the sync loop on unlock and stops
  it on lock or `host.remove`; admin methods route to `backend/host-admin.ts` when connected and to
  the repo otherwise; `afterWrite()` follows every admin write. The vault is built over the effective
  catalog (`{ ...database, entry: catalogEntryOf }`), so a credential's recorded origin is the host
  entry's url (B5), and the `login.report` origin guard reads the same catalog. The admin-catalog
  read `catalog.get` also reads the effective catalog. Block 2 adds `host.localLeftovers`/
  `host.adoptLocalAsPersonal` (B8b), `host.sessions`/`host.revokeSession` and `people.sessions`/
  `people.revokeSession` (O1), `personal.*`/`favorites.*` (B7), `session.disableBiometric` (V1),
  `keys.mine`/`peers.list`/`peers.confirm` (K1–K2), the K5 gate over `vault.reveal`/`vault.copy`/
  `shares.*`/`assignments.*` (K4–K8), the vault's `afterSave` call-out (K9), the O2 write gate
  (`HOST_WRITES`) and `events.syncStatus`.
- Hooks: `onNavigate`, `onWindowOpen`, `onDownload` (evento com `auditUrl`), `onWindowClosed`,
  `onWindowState` (foco), `onHotkey`, `onTray` (confira nomes e assinaturas no runtime).

## 5. `src/` — a página única

| Arquivo | Faz |
| --- | --- |
| `index.html` | `lang="en"`, título `Nod`, `<div id="app">`, `src/app.ts`, `src/style.css`. |
| `src/app.ts` | Boot e roteamento. Bloqueado: tela de entrada (criar a conta de admin / entrar / entrar com convite / Touch ID / espera). Desbloqueado: **sidebar** à esquerda (logo; um ícone por ferramenta com dígito e estado — aberta, carregando, falhou; no rodapé Settings e Lock) e **conteúdo**: Home (cartões das ferramentas: abrir/focar, vistas, fechar, estado e resultado de login) ou Settings (`src/settings.ts`). Teclado: ⌘/Ctrl+1..9 abre, ⌘/Ctrl+K paleta, ⌘/Ctrl+, Settings. Ouve `session`, `tools`, `catalog`, `palette`, and the connected events `host`, `join` (a `nod://join` invite) and `update` (the new-version notice). A `host` push drives the "offline" badge and the signed-out notice; a "Join a guild" path lives on the blocked screen beside create-account and invite. |
| `src/palette.ts` | `export function openPalette(ctx): void` — overlay dentro da janela com busca (subsequência, sem acento) sobre ferramentas, vistas e ações (Home, cada aba de Settings, Lock, Quit); ↑/↓/Enter/Esc; foco preso enquanto aberta. |
| `src/tabs.ts` | E03: a visão de abas do painel central — a faixa das abas abertas, a barra que age na ativa e o slot onde o backend deita a aba docked. `tabsApi(deps)` é a metade da página dos métodos `tabs.*` (uma definição por ação, compartilhada pela faixa, pela paleta e pelo teclado); `mountTabs(root, ctx)` monta a visão e devolve `{ update, destroy }`; `reportSlot(rect)` manda o retângulo do slot ao backend; `activeTab(state)` é a aba docked que a faixa, a barra e a paleta miram. `src/app.ts` a monta só quando o runtime permite posicionar janelas — não há modo escolhido (§22 "Seamless tabs: always inside, detach on demand"). |
| `src/settings.ts` | `export function mountSettings(root: HTMLElement, ctx: { session: SessionState; info: AppInfo; tab?: SettingsTab }): { setTab(tab: SettingsTab): void; update(session: SessionState): void; destroy(): void }`, com `export type SettingsTab = 'account' \| 'hosts' \| 'vault' \| 'tools' \| 'roles' \| 'people' \| 'activity' \| 'catalog'`. Todas as pessoas: Account (trocar senha, habilitar/desabilitar biometria, versão, atualização; e, com host, os dispositivos com Revoke de O1, a impressão digital da chave própria de K1 e os colegas com o aviso `key changed` de K2) e Vault (salvar/revelar 10 s/remover; export/import com `tiny.dialog`; e o compartilhamento de K4–K9: inbox, escopo, Send, holders com Remove e o chip `rotation pending`). **Hosts** (todos, SP05 §4): without a host, address → `host.discover` → guild + fingerprint → email + code (or password) → set password; with a host, guild, address, fingerprint, last sync, pending writes, "Sync now", "Remove host" (keep-personal), and a "Keep your local tools" step after a join (B8b). Só admin: Tools (colar endereço → `catalog.probe` → formulário pré-preenchido; vistas, papéis, `noFill`; aviso quando a origin não está em `info.gateOrigins`; "usually signs in via …" de `catalog.get`), Roles (CRUD + concessões), People (papéis, revogar, emitir convite mostrando o código uma vez), Activity (lista + exportar JSONL; sent vs pending from `events.syncStatus` while a host exists), Catalog (exportar/importar seed com modo merge/overwrite). Só admin, conectado: the four admin tabs read/write the host through the same RPC and a "publish local tools" card calls `host.bootstrap` once. |
| `src/style.css` | Tema escuro sóbrio, monospace, contraste alto, `:focus-visible`. Classes usadas por `src/ui.ts`: `.button .button-primary .button-danger .button-ghost .field .field-label .field-hint .input .message .message-error .message-ok .message-info`. |
| `src/ui.ts` | Helpers de DOM (já escrito pelo coordenador; não editar). |

## 6. Build e dev

- `bun run app:dev` → `bun scripts/gen-config.ts dev && tinyjs dev`.
- `bun run app:build` → `bun scripts/gen-config.ts build && tinyjs build`.
- `scripts/gen-config.ts <dev|build>`: lê `tinyjs.base.json` e `resources/seed.json` (validado). Em
  `build`, seed ausente/inválido → sai 1 com `private seed missing: resources/seed.json (see resources/seed.example.json)`
  (RF-26); grava `"resources": ["seed.json", "tray.png", …ícones relativos]`. Gate da §2;
  `update` do seed → `{ url, auto: 'daily' }`; env `NOD_APP_ID` substitui `id`; env `NOD_DEV_PORT`
  (padrão 5173) muda a porta do Vite, o `devUrl` e a origin de dev — o smoke usa 5199 para conviver com
  um `app:dev` aberto.
  Both modes also write `resources/build-mode` (`dev`/`build`, gitignored) — SP02 §9: the stamp
  `backend/main.ts` reads at start-up to tell a dev run from a release. It is **not** in the
  `"resources"` list above, so a release stages no stamp and answers `false`.
- Gates: `bun test test/`, `bunx tsc -p tsconfig.json`, `bunx tsc -p backend/tsconfig.json`,
  `bun run app:build` com e sem seed, `bun test/smoke/run.ts`.

## 7. Second runtime target — Electrobun (E06)

Decided 2026-10-22 (`docs/canonico.md` §22 "Electrobun parity build"): the same Nod also runs on
**Electrobun 2.0.4** (Bun main process + system webview, devkit projected into `.hutch/` by the
`electrobun` CLI). `backend/`, `shared/` and `src/` are **unchanged by the target**; it is a runtime layer
in `electrobun/` plus its build scripts (`gen-electrobun-config.ts`, `build-nod-native.ts`, `eb-icon.ts`,
`eb-postwrap.ts`, `eb-postbuild.ts`, `eb-plist.ts`, `eb-publish.ts`).

| Piece | Where | Contract |
|---|---|---|
| Entry | `electrobun/bun/index.ts` | `installTjs()`, main preload, RPC (`electrobun/shared-rpc.ts`), gate, downloads, update, native, then `createApp(...)` and `backend.init(app)` |
| `TinyApp` / window facade | `electrobun/bun/facade/app.ts`, `windows.ts` | Implements the members `backend/main.ts`/`tool-windows.ts` actually call (inventory A–E); `win.open` keeps the page-box contract, docked tabs are native `BrowserView`s over the main window, `setChrome({frame})` detaches/docks without reload |
| Gate, per view | `electrobun/bun/facade/gate-core.ts` + `gate.ts` | Electrobun's RPC handler receives no sender/origin, so the Nod owns the gate: one registry `viewId → { windowId, kind, committedOrigin }`, fed by `did-commit-navigation` and checked on every call. `main` = all methods only while the committed origin is the app's (`views://mainview` or the dev URL); `tool` = `login.report` only; `popup`/`link`/`embed` = none. Every non-main view is `sandbox: true`, so it has no RPC and only `host-message` (downloads, tool calls). Refusals use the byte-identical tinyjs sentence |
| Page bridge | `electrobun/view/bridge.ts`, `electrobun/view/tool-bridge.ts` | Same `window.tiny` surface `src/` already uses; the tool bridge bakes `tiny.win.id` and settles each call through `executeJavascript` |
| `tjs` / sqlite | `electrobun/bun/tjs-shim.ts`, `sqlite-shim.ts` | `tjs` over Bun file APIs; `tjs:sqlite` over `bun:sqlite` (`build.bun.alias` in the generated config) |
| Native dylib | `electrobun/native/NodNative.swift` → `libNodNative.dylib`, `scripts/build-nod-native.ts`, `electrobun/bun/facade/native.ts` | In-process `bun:ffi`: Keychain, LocalAuthentication (begin/poll/cancel), app icon, save/open panels, `setWindowFrame`, `setContentMinSize`. A second binding in the same file reaches the core's view primitives (`resizeWebview`, `webviewSetHidden`, `listViews`, live top URL), which is what the docked tab and the re-parent use. AppKit work hops to the main queue; absent dylib or non-macOS degrades to `available: false` |
| Update channel | `electrobun/bun/facade/update.ts`, `scripts/eb-publish.ts` | The release `manifest.json` itself (the seed's `update.url`, the tinyjs format every Nod reads): the facade takes `version`, `notes` and `mac.<arch> = { url, sha256 }` — a `ditto` zip of the Electrobun `Nod.app` — downloads, verifies the digest, matches the bundle identity/version, stages it and runs a swap helper with an `updates/rollback/` copy. `scripts/eb-publish.ts` produces that zip + half; `release.yml` merges it with the Windows/Linux tinyjs halves. Electrobun has no signature, so the sha256 is the integrity check, and the release fails unless `codesign --verify --strict --deep` accepts the bundle |
| Config | `scripts/gen-electrobun-config.ts` (gitignored `electrobun.config.ts`) | From `tinyjs.base.json` + `resources/seed.json`: identifier (`NOD_APP_ID`, default `copland.nod.eb`, `copland.nod` refused), `views/mainview` page, `views/bridge` preload, `resources/`, native library, URL scheme, media usage strings (`scripts/eb-postwrap.ts` into the wrapper, `scripts/eb-postbuild.ts` as `scripts.postPackage`/`eb:verify` repairing and asserting the packed payload tar), app icon (RF-56): the same `iconForConfig` tinyjs uses, named as `build.mac.icons` (`.eb-icon.iconset` from `scripts/eb-icon.ts`, converted by hutch's `iconutil`), `build.win.icon` and `build.linux.icon` (the PNG) |

Commands: `bun run eb:dev` / `bun run eb:build` (§6 covers the tinyjs commands). The tinyjs target
remains the default and the release pipeline's runtime until §22's "Electrobun replaces tinyjs"
row stops being `Proposto`. Parity evidence: `docs/handovers/e06-parity-matrix.md`; costs and
solved problems: `docs/epics/E06-embedded-webview.md` §13.
