# SP05 — Nod connected mode

The Nod side of E01 (and the Nod parts of E02's foundation). Today's modules are described in
`docs/arquitetura.md` §3–§5; this spec only lists what changes. Rules from `docs/arquitetura.md` §2
still hold: secrets only in the keychain, the page only calls `src/api.ts`, the backend gate in
`backend/main.ts`.

## 1. New and changed modules

| Module | Change |
| --- | --- |
| `shared/auth.ts` | `deriveKeys`, `PasswordHashV2` (SP02 §1, §6) |
| `shared/host-api.ts` (new) | Types of SP03/SP04: `Discovery`, `Snapshot`, request/response bodies; **and** the code helpers — `CODE_ALPHABET`, `CODE_BYTES`, `CODE_LENGTH`, `generateCode`, `formatCode`, `normalizeCode`, `validateCode`, `normalizeEmail` (SP02 §3). They landed here, not in `shared/auth.ts` (c1); `shared/auth.ts` keeps the derivation. |
| `shared/types.ts` | `Entry.scope/ownerId`, `View.id/scope/ownerId`, `HostState`, `AppIconChoice`/`AppIconState`, `Person.owner` (RF-64), `VaultItem.isDefault` and the per-row `keychainKey` (RF-65), new `ApiContract` methods (§3) |
| `shared/host-merge.ts` (new) | Pure: snapshot → local rows (RF-62's `Entry.category`); sidebar order (favorites, org grouped by category, personal); outbox replay decisions; `leftoverLocalTools` (RF-40) |
| `shared/seal.ts` (new) | The E02 seal: X25519 + HKDF (over HMAC) + AES-256-GCM, Ed25519 sign/verify, `personFingerprint` (SP06 §1–§3) |
| `shared/version.ts` (new) | `compareVersions`: the semver comparison of the O2 gate (SP04 §1) |
| `shared/vault-crypto.ts` (new) | The `bv1.` envelope (AES-256-GCM, AAD = keychain key) for a vault value and for a key blob (SP02 §8) |
| `backend/host-client.ts` (new) | `fetch` to the host; bearer from the keychain; discovery; signature check; error mapping; `getBytes`, the one route whose answer is bytes (§6) |
| `backend/sync.ts` (new) | Timer, triggers, outbox flush, event push, snapshot apply, stale state, backoff (SP04 §3–§5) |
| `backend/repo.ts` | Migrations to `user_version = 6` (§2): the block 1 schema, then `peer_keys` (K1–K2), `vault_item.credential_id`/`scope` (K4/K6) and `tool.category` (RF-62); 0.5.5 (RF-65) drops `UNIQUE (person_id, tool_id)` in a `rebuildVaultItem` pass, adds `vault_item.is_default` and the partial unique index on `credential_id` |
| `backend/session.ts` | V2 local verifier and its migration; keys kept in memory while unlocked; biometric item holds `vaultKey` (SP02 §6, §9) |
| `backend/vault.ts` | `origin` per item, fill only on that origin (B9); block 2: `bv1.` encryption (V1); `credentialId`/`scope` on an accepted share (K4/K6); the `afterSave` call-out (K9); 0.5.5 (RF-65): `save`/`read`/`remove` by `itemId`, a per-row `keychainKey`, and `readDefault(personId, toolId)` for the fill |
| `backend/keys.ts` (new) | The E02 key pairs (K1) and the pin table (K2): generation at activation/reset, the private halves sealed under `nod.keys.<person>` (and a `privateSealed` blob accepted from the host, canonico §22), the public halves in `meta`, `PUT /v1/keys` / `GET /v1/keys/private`, `observe`/`peers`/`peerKeyFor`/`confirm`, `reSeal` on a password change |
| `backend/shares.ts` (new) | SP06 §3–§5: `recipients`, `send`, `inbox`, `accept`, `decline`, `setScope`, `decorate`; K9's `update`/`retryPending`/`applyUpdates`/`removeHolder`; K8's `assign`/`missing`/`sealMissing`/`refreshAssignments` |
| `backend/personal.ts` (new) | The person's own tools, views and favorites: a write queues one `host_outbox` row while connected and hits the local tables otherwise; `p-…` ids; `adoptLocalTool` (RF-40) |
| `backend/guild-icon.ts` (new) | The guild's PNG on this machine and the app-icon choice: fetch on a moved hash, verify the digest, cache in `<data>/guild-icon.png`, apply through `app.icon` (§6) |
| `backend/main.ts` | New RPC methods; admin methods routed to the host when connected (§3); the guild icon of every applied snapshot and of the host's removal (§6) |
| `src/settings.ts` | Settings → Hosts tab; admin tabs read/write through the same RPC (the backend decides local or host); the App icon select and the admin's Guild icon card (§6) |
| `src/app.ts` | Sidebar order; stale badge; favorites toggle; personal tool add |

## 2. Local schema, `user_version = 6`

```sql
CREATE TABLE host (
  id            INTEGER PRIMARY KEY CHECK (id = 1),     -- one guild at a time (decided 2026-10-16)
  address       TEXT NOT NULL,
  guild         TEXT NOT NULL,
  kid           TEXT NOT NULL,
  public_key    TEXT NOT NULL,                          -- pinned Ed25519, base64url
  person_id     TEXT NOT NULL,                          -- host person id
  salt          TEXT NOT NULL,                          -- host salt, for offline unlock (SP02 §6)
  snapshot      TEXT,                                   -- last verified body, verbatim
  version       TEXT,
  issued_at     TEXT,
  last_sync_at  TEXT,
  last_error    TEXT,
  added_at      TEXT NOT NULL
);
CREATE TABLE host_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method      TEXT NOT NULL,                            -- 'PUT' | 'DELETE'
  path        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
ALTER TABLE event ADD COLUMN client_id TEXT;            -- uuid, filled on insert from now on
ALTER TABLE event ADD COLUMN sent_at TEXT;
ALTER TABLE vault_item ADD COLUMN origin TEXT;          -- backfilled from tool.origin
ALTER TABLE person ADD COLUMN password_check TEXT;      -- PasswordHashV2.check; old columns kept for migration
ALTER TABLE person ADD COLUMN password_algorithm TEXT NOT NULL DEFAULT 'PBKDF2-SHA256';
ALTER TABLE tool ADD COLUMN scope TEXT NOT NULL DEFAULT 'org';
ALTER TABLE tool ADD COLUMN owner_id TEXT;
ALTER TABLE tool ADD COLUMN category TEXT;              -- RF-62: display category of a local org tool
CREATE TABLE IF NOT EXISTS peer_keys (          -- migration 4 (K1–K2, SP06 §2)
  person_id           TEXT PRIMARY KEY,
  x25519              TEXT NOT NULL,            -- the pinned pair of this colleague
  ed25519             TEXT NOT NULL,
  fingerprint         TEXT NOT NULL,
  first_seen          TEXT NOT NULL,
  confirmed_at        TEXT,
  pending_x25519      TEXT,                     -- the pair that differs while the peer is `changed`
  pending_ed25519     TEXT,
  pending_fingerprint TEXT,
  pending_since       TEXT
);
ALTER TABLE vault_item ADD COLUMN credential_id TEXT;                        -- migration 5 (K4/K6)
ALTER TABLE vault_item ADD COLUMN scope TEXT NOT NULL DEFAULT 'role';
ALTER TABLE vault_item ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;     -- 0.5.5 (RF-65); existing rows stay 1
CREATE UNIQUE INDEX IF NOT EXISTS vault_item_credential                      -- 0.5.5 (RF-65): one local copy per shared credential
  ON vault_item (person_id, credential_id) WHERE credential_id IS NOT NULL;
```

- **The sign-out state is the marker in `host.last_error`** — `SIGNED_OUT_ERROR` = "signed out —
  sign in again" (`backend/sync.ts`). The `host` table has no sign-out column, and the fact has to
  survive a restart and guard the `ETag`: after a `401` the cached body is no longer what the host
  signed, so offering its `version` as `If-None-Match` would earn a `304` that keeps the org half
  emptied. The marker is sticky until a sync succeeds; while set, the request goes out without
  `If-None-Match` and Settings → Hosts shows it verbatim (b4).
- **`vault_item` carries `origin` and does not require a local `tool` row.** `tool_id` stays
  `TEXT NOT NULL` with its FK to `person`, but the FK to `tool(id)` is gone and 0.5.5 (RF-65) also
  drops `UNIQUE(person_id, tool_id)` — constraints written twice, like the added columns, with a
  rebuild instead of an `ALTER`: `migrate()` rebuilds an existing table (`rebuildVaultItem`, the
  SQLite 12-step recipe) when `PRAGMA foreign_key_list(vault_item)` still names `tool` or a
  `UNIQUE(person_id, tool_id)` index is present, so the guard is the constraint, not `user_version`
  (`migrate()` brings any known version to 5, `SCHEMA_VERSION`). Removing a local tool
  still deletes its vault rows only through
  `removeEntry`'s explicit `DELETE FROM vault_item WHERE tool_id = ?`. `vault.save` reads the entry —
  and its `origin` — from the effective catalog while connected (`main.ts` builds it over
  `{ ...database, entry: catalogEntryOf }`), and the `login.report` origin guard reads the same
  catalog, so a host-only tool's window can report its fill (B5, host-only-tool story).
- **Several credentials per tool (0.5.5, RF-65).** Without the `UNIQUE(person_id, tool_id)` a person
  keeps as many `vault_item` rows per tool as they want, each addressed by its `id`; `is_default = 1`
  marks the one the fill uses, and the partial unique index on `(person_id, credential_id)` keeps at
  most one local copy per shared credential. The `keychain_key` is per row — `nod.cred.<person>.<tool>`
  for a row made before 0.5.5, `nod.cred.<person>.<tool>.<id>` after — because the sealed value's AAD
  is that key, so the row (not the tool) is the handle and an existing value can be kept while the
  person adds another credential of the same tool (RF-63). The default rule — first item of a tool
  becomes the default, `vault.remove` of the default promotes the oldest remaining — lives in
  `backend/repo.ts`/`backend/vault.ts`; what an accepted share does to it is SP06 §4.
- **Connected catalog**: the backend reads org tools, roles and grants from `host.snapshot` (parsed
  once per change and kept in memory), not from the `tool`/`role` tables. Those tables keep the
  local-mode catalog, untouched while connected. Removing the host returns to them.
- **Personal tools** live in the snapshot plus the outbox overlay. In local mode they are `tool`
  rows with `scope = 'personal'`.
- The local `person` row for a connected account is created at activation with the host person id
  as its id, so the pre-0.5.5 keychain key `nod.cred.<person>.<tool>` stays stable across machines
  and sync; a 0.5.5 credential appends its own `id` to that key and carries the result on its row
  (`docs/canonico.md` §11).

## 3. RPC additions (`ApiContract`)

| Method | Params | Result | Who |
| --- | --- | --- | --- |
| `host.state` | — | `HostState` (`none` / `connected` / `stale`, guild, address, fingerprint, lastSyncAt, lastError, pending outbox count, `updateRequired`, `minAppVersion`) | unlocked |
| `host.discover` | `{ address }` | `{ guild, fingerprint }` | no session needed (first run) |
| `host.activate` | `{ address, fingerprint, email, code, password, name? }` | `SessionState` | no session needed; `name` only for a setup code |
| `host.signIn` | `{ address, fingerprint, email, password }` | `SessionState` | no session needed |
| `host.syncNow` | — | `HostState` | unlocked |
| `host.remove` | `{ keepPersonal: boolean }` | `HostState` | unlocked |
| `host.bootstrap` | — | `{ created: number; refused: boolean }` | unlocked, admin (B8a); publishes the local org tools to an empty host; the host's `409` is `{ created: 0, refused: true }` |
| `events.syncStatus` | — | counts of sent and pending events | unlocked (B10); the two numbers Settings → Activity shows |
| `nod.appIcon` / `nod.setAppIcon` | `— / { choice }` | `AppIconState` | unlocked; every person picks the icon of this machine (§6) |
| `host.setGuildIcon` / `host.clearGuildIcon` | `{ png }` / `—` | `{ sha256 }` / `true` | unlocked, admin, connected; the guild's icon (§6, SP03 §2) |
| `host.sessions` / `host.revokeSession` | `— / { id }` | `DeviceSession[] / true` | unlocked (block 2, O1) |
| `personal.saveTool` / `personal.removeTool` | `{ entry }` / `{ id }` | `Entry` / `true` | unlocked (block 2) |
| `personal.saveView` / `personal.removeView` | `{ view }` / `{ id }` | `View` / `true` | unlocked (block 2) |
| `favorites.list` / `favorites.set` | `— / { ids }` | `Id[]` / `true` | unlocked (block 2); the read is B7's addition beside the write |
| `session.disableBiometric` | — | `SessionState` | unlocked (V1); the delete path of SP02 §9 |
| `people.sessions` / `people.revokeSession` | `{ personId }` / `{ id }` | `DeviceSession[] / true` | unlocked, admin (O1); the admin's side of the session list |
| `people.update` / `people.delete` | `{ personId, name?, email? }` / `{ personId }` | `Person` / `true` | unlocked, admin, connected (RF-64, 0.5.3); like `people.setRoles`, both refuse in local mode (`Nod is not connected to a host`) and while this Nod is older than the guild's `minAppVersion`; `update` sends `PATCH /v1/admin/people/:id` and `delete` sends `DELETE` there (SP03 §2), the host owning the owner-only `403 owner only`, the `409 email taken` and the `403 the owner cannot be deleted`; both first read `GET /v1/admin/people` (`ownerGate`, `backend/host-admin.ts`) and refuse before any write or local `person_updated`/`person_deleted` event — `HOST_TOO_OLD_PEOPLE` when no row carries a boolean `owner` (a host older than 0.5.3, whose events route would reject that kind), `only the guild owner can do this` when the caller is not the owner's row, and, for `delete`, `the owner cannot be deleted` when the owner is the target |
| `host.localLeftovers` / `host.adoptLocalAsPersonal` | `— / { ids }` | `Entry[] / { created: number }` | unlocked (B8b, RF-40); the leftover offer on Add host and the adoption |
| `keys.mine` / `peers.list` / `peers.confirm` | `— / — / { personId }` | `MineKeys` (`{ fingerprint: string \| null, status: 'ok' \| 'pending' \| 'unavailable', message: string \| null }`) / `PeerKey[]` / `true` | unlocked (K1–K2); the fingerprint card and the pin table, `confirm` promoting a `changed` peer |
| `vault.copy` / `vault.setScope` | `{ itemId, password? }` / `{ itemId, scope }` | `true` / `VaultItem` | unlocked (K4–K7); `copy` behind the K5 gate, `setScope` the owner's sharing scope; the one chosen credential, addressed by `itemId` (RF-65) |
| `vault.save` / `vault.reveal` / `vault.remove` / `vault.setDefault` | `{ itemId?, toolId, username, secret, label?, credentialId?, scope? }` / `{ itemId, password? }` / `{ itemId }` / `{ itemId }` | `VaultItem` / `{ username, secret }` / `true` / `VaultItem` | unlocked (RF-65); `save` without `itemId` adds a credential and with one replaces that credential (`toolId` must match, else `invalid credential`); `reveal` behind the K5 gate; `setDefault` moves the tool's `isDefault`; an unknown or foreign `itemId` is `unknown credential` |
| `shares.recipients` / `shares.send` | `{ itemId }` / `{ itemId, to, password? }` | `ShareRecipient[]` / `{ sent: number }` | unlocked (K4, K6); `send` behind the gate; both act on the chosen credential (RF-65) |
| `shares.inbox` / `shares.accept` / `shares.decline` / `shares.removeHolder` | `— / { id, password? } / { id } / { itemId, personId }` | `InboxShare[]` / `VaultItem` / `true` / `VaultItem` | unlocked (K4, K9); `accept` behind the gate (an `update` of a held credential skips it); `removeHolder` revokes a holder of the chosen credential (RF-65) | 
| `assignments.set` / `assignments.missing` / `assignments.sealMissing` | `{ itemId, roleId?, personId?, assigned, password? }` / `—` / `{ password? }` | `{ … }` / `MissingCopyView[]` / `{ sent, skipped }` | unlocked, admin (K8); the two writes behind the gate; assignment acts on the chosen credential (RF-65) |

0.5.0 (RF-59/60/61) — the entry screen, the guild invites and the optional seed:

| Method | Params | Result | Who |
| --- | --- | --- | --- |
| `session.profiles` | — | `EntryProfiles`: the `offline` profile (`hasAccount`, `requiresInvite`, `email`, `seedImportable`), the guild tile(s) (`id` = the pinned address, `guild`, `address`, `icon` as a data URI or `null`, the account's `email`/`name`, `status`, `updateRequired`), `last` and `biometric` | **no session needed**; every field is this machine's own (the people table, the `host` row, the cached body's icon digest) — no call leaves it |
| `session.unlock` / `session.unlockBiometric` | `{ email, password, target? }` / `{ target? }` | `SessionState` (`mode: 'offline' \| 'guild'`) | no session needed; `target` absent means the Offline tile. A `guild` target opens only while this Nod holds that `host` row and only for the person of it — anything else is the same `invalid credentials` a wrong password gets (no oracle). The tile is stored as `last_entry` in `store.json` (a preference, never a secret) |
| `session.importSeed` | `{ path }` | `SessionState` | **no session needed** (RF-61); refuses with `this Nod already has an account — the seed is only imported at setup` while any person exists. The file is applied in boot mode (`backend/seed.ts`), records `catalog_imported` with `result: 'seed'`, and never widens the runtime origin gate — that is the embedded seed's alone |
| `host.activate` | `{ address, fingerprint, email, code, password, name?, adoptLocal? }` | `JoinResult` | no session needed; `codeKindOf(code)` decides the route: `setup` → `/v1/auth/setup` and `invite` → `/v1/auth/join` (both require `name`), `access` → `/v1/auth/activate`. A successful join enters in `guild` mode and stores `last_entry` = that guild |
| `host.invitePreview` | `{ address, fingerprint, code }` | `InviteView` (guild, address, fingerprint, role **names**, `expiresAt`, `usesLeft`, icon as a data URI) | **no session needed** (RF-59); the discovery is the join's own (SP04 §1.3 fingerprint refusal, O2 minimum), then `POST /v1/auth/invite`. The host's `404` is `invalid invite` |
| `guildInvites.list` | — | `GuildInvite[]` (newest first, revoked included) | unlocked, **admin**, connected; in `HOST_READS` |
| `guildInvites.create` | `{ roles, maxUses, expiresInMinutes }` | `{ invite, code, link }` — `link` = `joinLink({ address, fingerprint, code })` from the `host` row | unlocked, **admin**, connected; in `HOST_WRITES`. The code is in the answer once and never in an event or a log |
| `guildInvites.revoke` | `{ id }` | `true` | unlocked, **admin**, connected; in `HOST_WRITES`; a person who already joined keeps their account |
| `invites.issue` (changed) | `{ roles, days?, personId? }` | `{ code, expiresAt }` | `email`/`name` are **gone** (0.5.0): while connected, `personId` reissues one existing person's access code (`POST /v1/admin/people/:id/code`); a person who does not exist yet joins through a guild invite. `POST /v1/admin/people` is no longer called (and no longer served) |
- `vault.reveal` and `vault.copy` gain the K5 gate: biometrics where the machine has them, the
  person's `password` otherwise (SP02 §9); without either the call fails and nothing is shown or
  copied. The same `password?` is on `shares.send`, `shares.accept` and the two assignment writes.
- **O2, while this Nod is older than the guild's `minAppVersion` (owner decision 2026-10-17)**: the
  guild is disconnected, so `host.state` carries `updateRequired: true` (the status stays the one the
  host answered, and Settings → Hosts shows the guild with the reason), `host.activate` and
  `host.signIn` refuse over the discovery's `minAppVersion` before any credential, every other RPC
  that would reach the host is refused with `update required — this guild needs a newer Nod` — the
  writes of the table above (with `host.revokeSession`, which the disconnected guild no longer keeps
  open as a security action) and the two reads only the host can answer, `host.sessions` and
  `people.sessions` — and the
  RPCs whose answer is the cached snapshot (`shares.inbox`, `shares.recipients`, `holders.list`,
  `assignments.missing`, `peers.list`, `host.localLeftovers`) answer empty — `keys.mine` is not one
  of them: it reports this machine's own pair and never reaches the host. The whole catalog layer
  runs on the local tables (`shared/catalog.ts`'s `catalogMode`): `catalog.list`, the sidebar, Home,
  the palette, the roles/people screens and the vault list (no holders, no `rotationPending`) are
  local, as if no host existed. The `host` row, the bearer and the cached body stay on disk.
- **0.5.0 (RF-60), the offline session is the same disconnect**: a session unlocked through the
  Offline tile carries `mode: 'offline'`, and the guild is as disconnected for it as it is for O2 —
  one predicate (`backend/main.ts`'s `disconnectedSession`) reads both, so `catalogMode`,
  `guildConnection()`, `snapshotBody()` and the two gate tables behave identically. `HostState` gains
  `offlineSession: true` for the sidebar's "not syncing" banner, and the RPC that would reach the host
  is refused with `offline session — lock and enter the guild to use it` (`OFFLINE_SESSION_ERROR`,
  `backend/session.ts`) instead of the O2 sentence — so the screen can say which of the two it is.
  `afterUnlock` reaches no host in this mode: no key pair is published and the sync loop is not
  started. `host.activate` (any code kind), `host.signIn` and a `guild` unlock enter in `mode:
  'guild'` and behave exactly as before.

- Existing admin methods (`catalog.save`, `roles.*`, `people.*`, `invites.issue`) keep their names.
  When connected, the backend sends them to SP03 admin routes.
- `invites.issue` is "an invite code for a new local account" (local mode) or "reissue the access
  code of an existing person" (`POST /v1/admin/people/:id/code`, `personId`); `days` stays local-only,
  since the host fixes 72 h (B6). 0.5.0 (RF-59) removed its `email` + `name` (the create-person path):
  a person who does not exist yet joins through a **guild invite** (`guildInvites.create`), which
  carries their roles — the host no longer serves `POST /v1/admin/people`.
- `host.activate` and `host.signIn` receive the password once, derive the keys in the backend, and
  never store or log the password. `TINYJS_DEBUG=1` prints page→backend calls with their params, so
  the warning in `AGENTS.md` now covers these two methods too; add them to its list.

## 4. Screens

- **Settings → Hosts**:
  - Without a host: an address field → discovery → guild name + fingerprint → email + access code
    (or password if already activated) → set password → done.
  - With a host: guild, address, fingerprint, last sync, pending writes, "Sync now",
    "Remove host" (with the keep-personal choice, default on).
  - Admin of a connected guild: a "Guild icon" card with the picked PNG's preview, "Upload" and
    "Remove" (§6).
- **First-run screen** gets a third path, "Join a guild", beside create account and invite.
- **Sidebar**: favorites first in their order, then org tools, then personal tools. A small "offline"
  badge while stale. RF-62: the org tools read grouped by category — a thin divider with the category
  name in small caps opens each group, the groups stand where their smallest `order` puts them and the
  unfiled ones last; ⌘1…⌘9 follow that visual order.
- **Home** (RF-62): the same order, one section per category with an `h2` and "Other tools" for the
  unfiled org tools; with no category in the catalog it stays the single grid it always was.
- **Admin tabs**, when connected:
  - People: email, name, roles; an **Owner** badge marks the guild owner's row, and the guild owner gets **Edit** (rename, change email) and **Delete** on every other row — the owner's own row offers neither, and another admin sees no Edit or Delete at all (RF-64, `people.update`/`people.delete`). "New access code" shows the code once with a copy button.
  - Invites: the guild-invite card (create, list, revoke, RF-59). Against a host that predates 0.5.0 the card shows the old-host message (`HOST_TOO_OLD`, "this host does not serve invites yet — redeploy the host") as a note on the card instead of blanking the page (`backend/host-admin.ts`, `src/settings.ts`).
  - Tools, Roles, Activity: same screens, host data; Tools groups the org tools by category like Home (RF-62).
- **Settings → Vault** (block 2): the sharing inbox with Accept/Decline, the scope select (owner
  only, Send hidden for `blocked`), Reveal behind the gate with a 10 s countdown, Copy (the secret
  never reaches the page), Send with the recipient list, and the holders of a credential with a
  `Remove` for a live holder (owner or admin) and the `rotation pending` chip. An admin gets the
  `Assign` dialog per credential, the "Members missing a copy" list, and a "Credential holders" card
  that lists every guild credential's holders — the ones the admin does not hold included (M7).
- **Settings → Account**: an "App icon" card — Default or Guild icon, the second offered only while
  the guild has one (§6) — and, only with a host, the device sessions list with Revoke (O1), the
  person's key fingerprint (K1) and the colleagues list with a `key changed — confirm` warning and its
  Confirm (K2).

## 5. Acceptance (block 1 smoke, B11)

On two machines, or two app ids on one machine (`NOD_APP_ID`, as `test/smoke/run.ts` already does):

1. Without a host, the existing smoke passes unchanged.
2. Admin: Add host with the setup code; publish local tools (B8a); create person P with role
   `team`; grant Jitsi to `team`.
3. P: Join a guild with P's access code; Jitsi appears; the vault fills only on its origin. The two
   app ids get different temporary seeds (P's release names the tool with another entry id), so the
   granted host entry has **no local `tool` row** on P's machine — the smoke reads P's SQLite and
   proves a host-only tool holds a credential and fills on its origin (SP05 §2; `backend/vault.ts`,
   `test/smoke/connected.ts`).
4. Admin revokes P → P's next sync shows signed out and the org tools disappear.
5. Network off on P: unlock works, tools show, "offline" badge; network on: events are sent and
   show on the host.

## 6. Guild icon and the app icon

The admin uploads the guild's icon inside the Nod; every member's Nod may then show it as the app
icon. The routes are SP03 §2's (`PUT`/`DELETE /v1/admin/guild/icon`, `GET /v1/guild/icon`) and the
signed field is SP04 §2's `Snapshot.guildIcon` — only the **digest** is signed, the bytes travel on
their own route.

- **`backend/guild-icon.ts`** (new) owns `<app data dir>/guild-icon.png` and the preference, with the
  connection, `app.icon`, `tjs`'s file calls and `store` injected. After every state the sync
  publishes, and once after an unlock, `backend/main.ts` hands it the `guildIcon` of the body in the
  `host` row:
  - the hash equals the one the file on disk hashes to → nothing is requested;
  - the hash moved → one `GET /v1/guild/icon` (raw bytes, the bearer of every other call, through
    `HostConnection.getBytes`), and the bytes are written **only** when their SHA-256 is exactly the
    signed value; other bytes are refused and nothing is written;
  - `guildIcon: null`, or a fetch that failed, leaves no icon applied: the file is deleted on `null`,
    and a digest that does not match what is on disk is never shown;
  - no `host` row → no request at all (RF-30).
- **The choice** is `appIcon` in `store.json`: `'default' | 'guild'`, and anything else reads as
  `default`. It is applied through the runtime's `app.icon(path)` — `''` resets to the bundle icon —
  only when `capabilities().icon !== false` (Linux has no protocol for it on a Wayland session;
  `docs/tinyjs.md` §6). A restart starts from the bundle icon, so the cached snapshot's icon is
  re-applied on the unlock; `host.remove` deletes the file and puts the bundle icon back, and the
  preference stays (it is a preference, not a fact about one guild).
- **The two reads and the two writes** are §3's `nod.appIcon`, `nod.setAppIcon`,
  `host.setGuildIcon` and `host.clearGuildIcon`. `nod.setAppIcon` refuses `guild` while no verified
  icon is on disk, so the screen can only offer what the machine has.
- **Screens**: Settings → Account gains **App icon** — a select of Default / Guild icon, the Guild
  option **disabled with a hint** while the guild has none. Settings → Hosts gains, for the admin,
  **Guild icon**: the PNG is picked with `<input type=file accept="image/png">`, read as base64url
  for the upload and previewed as a data URI, with **Upload** and **Remove**. The stored icon's
  **bytes never reach the page** — only the digest travels — so a preview exists for the file picked
  in the session and not for one uploaded by an earlier run.
- **The size ceiling is the encoded one.** SP03 §1's body limit for the icon route is 512 KB of
  body, and the base64url body is larger than the bytes: the usable PNG is at most 384 KiB
  (393 216 bytes). The page and `backend/main.ts` check that number before the call; the constant has
  no shared home yet (finding in `docs/handovers/i2b-guild-icon-app.md`).
- **Nothing here is a secret**: an icon is a public image, the preference is one word, and no
  message of the module carries a token or a host body.
