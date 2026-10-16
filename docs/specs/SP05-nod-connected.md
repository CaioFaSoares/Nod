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

- **The sign-out state is the marker in `host.last_error`** — `SIGNED_OUT_ERROR` = "signed out —
  sign in again" (`backend/sync.ts`). The `host` table has no sign-out column, and the fact has to
  survive a restart and guard the `ETag`: after a `401` the cached body is no longer what the host
  signed, so offering its `version` as `If-None-Match` would earn a `304` that keeps the org half
  emptied. The marker is sticky until a sync succeeds; while set, the request goes out without
  `If-None-Match` and Settings → Hosts shows it verbatim (b4).
- **`vault_item` carries `origin` and does not require a local `tool` row.** `tool_id` stays
  `TEXT NOT NULL` with its FK to `person` and the `UNIQUE(person_id, tool_id)`, but the FK to
  `tool(id)` is gone — a constraint written twice, like the added columns, with a rebuild instead of
  an `ALTER`: `migrate()` rebuilds an existing table (`rebuildVaultItem`, the SQLite 12-step recipe)
  when `PRAGMA foreign_key_list(vault_item)` still names `tool`, so the guard is the constraint, not
  `user_version`, which stays **3**. Removing a local tool still deletes its vault rows only through
  `removeEntry`'s explicit `DELETE FROM vault_item WHERE tool_id = ?`. `vault.save` reads the entry —
  and its `origin` — from the effective catalog while connected (`main.ts` builds it over
  `{ ...database, entry: catalogEntryOf }`), and the `login.report` origin guard reads the same
  catalog, so a host-only tool's window can report its fill (B5, host-only-tool story).
- **Connected catalog**: the backend reads org tools, roles and grants from `host.snapshot` (parsed
  once per change and kept in memory), not from the `tool`/`role` tables. Those tables keep the
  local-mode catalog, untouched while connected. Removing the host returns to them.
- **Personal tools** live in the snapshot plus the outbox overlay. In local mode they are `tool`
  rows with `scope = 'personal'`.
- The local `person` row for a connected account is created at activation with the host person id
  as its id. Keychain keys `nod.cred.<person>.<tool>` therefore stay stable across machines and
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
| `host.bootstrap` | — | `{ created: number; refused: boolean }` | unlocked, admin (B8a); publishes the local org tools to an empty host; the host's `409` is `{ created: 0, refused: true }` |
| `events.syncStatus` | — | counts of sent and pending events | unlocked (B10); the two numbers Settings → Activity shows |
| `host.sessions` / `host.revokeSession` | `— / { id }` | `DeviceSession[] / true` | unlocked (block 2, O1) |
| `personal.saveTool` / `personal.removeTool` | `{ entry }` / `{ id }` | `Entry` / `true` | unlocked (block 2) |
| `personal.saveView` / `personal.removeView` | `{ view }` / `{ id }` | `View` / `true` | unlocked (block 2) |
| `favorites.set` | `{ ids }` | `true` | unlocked (block 2) |

- Existing admin methods (`catalog.save`, `roles.*`, `people.*`, `invites.issue`) keep their names.
  When connected, the backend sends them to SP03 admin routes.
- `invites.issue` becomes "create person + access code" (`POST /v1/admin/people`), or "reissue code"
  for an existing person. It keeps its `{ code, expiresAt }` answer and gains optional `email` +
  `name` (create) or `personId` (reissue); `days` stays local-only, since the host fixes 72 h (B6).
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
