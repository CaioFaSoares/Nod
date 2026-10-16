# SP05 — Bond connected mode

The Bond side of E01 (and the Bond parts of E02's foundation). Today's modules are described in
`docs/arquitetura.md` §3–§5; this spec only lists what changes. Rules from `docs/arquitetura.md` §2
still hold: secrets only in the keychain, the page only calls `src/api.ts`, the backend gate in
`backend/main.ts`.

## 1. New and changed modules

| Module | Change |
| --- | --- |
| `shared/auth.ts` | `deriveKeys`, `PasswordHashV2`, access-code normalize/format (SP02 §1, §3, §6) |
| `shared/host-api.ts` (new) | Types of SP03/SP04: `Discovery`, `Snapshot`, request/response bodies |
| `shared/types.ts` | `Entry.scope/ownerId`, `View.id/scope/ownerId`, `HostState`, new `ApiContract` methods (§3) |
| `shared/host-merge.ts` (new) | Pure: snapshot → local rows; sidebar order (favorites, org, personal); outbox replay decisions |
| `backend/host-client.ts` (new) | `fetch` to the host; bearer from the keychain; discovery; signature check; error mapping |
| `backend/sync.ts` (new) | Timer, triggers, outbox flush, event push, snapshot apply, stale state, backoff (SP04 §3–§5) |
| `backend/repo.ts` | Migration to `user_version = 3` (§2) |
| `backend/session.ts` | V2 local verifier and its migration; keys kept in memory while unlocked; biometric item holds `vaultKey` (SP02 §6, §9) |
| `backend/vault.ts` | `origin` per item, fill only on that origin (B9); block 2: `bv1.` encryption (V1) |
| `backend/main.ts` | New RPC methods; admin methods routed to the host when connected (§3) |
| `src/settings.ts` | Settings → Hosts tab; admin tabs read/write through the same RPC (the backend decides local or host) |
| `src/app.ts` | Sidebar order; stale badge; favorites toggle; personal tool add |

## 2. Local schema, `user_version = 3` (block 1)

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
```

- **Connected catalog**: the backend reads org tools, roles and grants from `host.snapshot` (parsed
  once per change and kept in memory), not from the `tool`/`role` tables. Those tables keep the
  local-mode catalog, untouched while connected. Removing the host returns to them.
- **Personal tools** live in the snapshot plus the outbox overlay. In local mode they are `tool`
  rows with `scope = 'personal'`.
- The local `person` row for a connected account is created at activation with the host person id
  as its id. Keychain keys `bond.cred.<person>.<tool>` therefore stay stable across machines and
  sync (`docs/canonico.md` §11).

## 3. RPC additions (`ApiContract`)

| Method | Params | Result | Who |
| --- | --- | --- | --- |
| `host.state` | — | `HostState` (`none` / `connected` / `stale`, guild, address, fingerprint, lastSyncAt, lastError, pending outbox count) | unlocked |
| `host.discover` | `{ address }` | `{ guild, fingerprint }` | no session needed (first run) |
| `host.activate` | `{ address, fingerprint, email, code, password, name? }` | `SessionState` | no session needed; `name` only for a setup code |
| `host.signIn` | `{ address, fingerprint, email, password }` | `SessionState` | no session needed |
| `host.syncNow` | — | `HostState` | unlocked |
| `host.remove` | `{ keepPersonal: boolean }` | `HostState` | unlocked |
| `host.sessions` / `host.revokeSession` | `— / { id }` | `DeviceSession[] / true` | unlocked (block 2, O1) |
| `personal.saveTool` / `personal.removeTool` | `{ entry }` / `{ id }` | `Entry` / `true` | unlocked (block 2) |
| `personal.saveView` / `personal.removeView` | `{ view }` / `{ id }` | `View` / `true` | unlocked (block 2) |
| `favorites.set` | `{ ids }` | `true` | unlocked (block 2) |

- Existing admin methods (`catalog.save`, `roles.*`, `people.*`, `invites.issue`) keep their names.
  When connected, the backend sends them to SP03 admin routes.
- `invites.issue` becomes "create person + access code" (`POST /v1/admin/people`), or "reissue code"
  for an existing person.
- `host.activate` and `host.signIn` receive the password once, derive the keys in the backend, and
  never store or log the password. `TINYJS_DEBUG=1` prints page→backend calls with their params, so
  the warning in `AGENTS.md` now covers these two methods too; add them to its list.

## 4. Screens

- **Settings → Hosts**:
  - Without a host: an address field → discovery → guild name + fingerprint → email + access code
    (or password if already activated) → set password → done.
  - With a host: guild, address, fingerprint, last sync, pending writes, "Sync now",
    "Remove host" (with the keep-personal choice, default on).
- **First-run screen** gets a third path, "Join a guild", beside create account and invite.
- **Sidebar**: favorites first in their order, then org tools, then personal tools. A small "offline"
  badge while stale.
- **Admin tabs**, when connected:
  - People: email, name, roles; "New access code" shows the code once with a copy button.
  - Tools, Roles, Activity: same screens, host data.

## 5. Acceptance (block 1 smoke, B11)

On two machines, or two app ids on one machine (`BOND_APP_ID`, as `test/smoke/run.ts` already does):

1. Without a host, the existing smoke passes unchanged.
2. Admin: Add host with the setup code; publish local tools (B8a); create person P with role
   `team`; grant Jitsi to `team`.
3. P: Join a guild with P's access code; Jitsi appears; the vault fills only on its origin.
4. Admin revokes P → P's next sync shows signed out and the org tools disappear.
5. Network off on P: unlock works, tools show, "offline" badge; network on: events are sent and
   show on the host.
