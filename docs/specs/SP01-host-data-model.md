# SP01 — Host data model

SQLite through `bun:sqlite`, one file `/data/host.db`, opened with `PRAGMA journal_mode = WAL`,
`PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = 5000`. Only `host/repo.ts` touches it
(`host/context.md`). Single replica, so one process owns the file (E01 §10).

## 1. Files beside the database

| File | Content | Created |
| --- | --- | --- |
| `/data/signing-key.json` | Ed25519 key pair as JWK `{ kid, publicJwk, privateJwk }`, mode 0600 | first boot, if missing |
| `/data/host-secret` | 32 random bytes, mode 0600 — the HMAC key for fake salts (SP02 §4) | first boot, if missing |
| `/data/backups/` | `host-<ISO date>.db` from `VACUUM INTO` (SP07 §4) | backup job |

`kid` = first 16 bytes of SHA-256 of the raw 32-byte public key, base64url.

## 2. Tables (block 1)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: schema_version; guild_icon_sha256 and guild_icon_bytes (the guild icon, SP03 §2);
--       guild_name and created_at are still unwritten (the discovery reads NOD_GUILD_NAME, h6)

CREATE TABLE people (
  id            TEXT PRIMARY KEY,                 -- uuid
  email         TEXT NOT NULL UNIQUE,             -- lowercased, trimmed
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'client' (E04)
  salt          TEXT,                             -- base64url 16 bytes; null until activated
  auth_hash     TEXT,                             -- Bun.password argon2id of authKey; null until activated
  created_at    TEXT NOT NULL,
  activated_at  TEXT,
  disabled_at   TEXT                              -- revoked person: no sign-in, no snapshot
);

CREATE TABLE roles (
  id     TEXT PRIMARY KEY,                        -- slug
  name   TEXT NOT NULL,
  admin  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE person_roles (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, role_id)
);

CREATE TABLE access_codes (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL,                      -- 'setup' | 'activate'
  person_id   TEXT REFERENCES people(id) ON DELETE CASCADE,  -- null for 'setup'
  code_hash   TEXT NOT NULL UNIQUE,               -- hex sha256 of the normalized code (SP02 §3)
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  revoked_at  TEXT                                -- replaced by a newer code
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,             -- hex sha256 of the bearer token
  device_name   TEXT NOT NULL,
  os            TEXT NOT NULL,                    -- 'macos' | 'windows' | 'linux'
  app_version   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                    -- last_seen_at + 14 days (sliding)
  revoked_at    TEXT
);

CREATE TABLE entries (
  id          TEXT PRIMARY KEY,                   -- slug; personal ids are 'p-' + 10 lowercase base32 chars
  scope       TEXT NOT NULL,                      -- 'org' | 'personal'
  owner_id    TEXT REFERENCES people(id) ON DELETE CASCADE,  -- set iff scope = 'personal'
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  icon        TEXT,                               -- data URI or null
  ord         INTEGER NOT NULL,
  auth        TEXT,                               -- JSON AuthOverride or null
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  CHECK ((scope = 'org' AND owner_id IS NULL) OR (scope = 'personal' AND owner_id IS NOT NULL))
);

CREATE TABLE views (
  id          TEXT PRIMARY KEY,                   -- uuid
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,                      -- 'org' | 'personal'
  owner_id    TEXT REFERENCES people(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  url         TEXT NOT NULL,
  mode        TEXT NOT NULL,                      -- 'window' | 'navigate'
  ord         INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK ((scope = 'org' AND owner_id IS NULL) OR (scope = 'personal' AND owner_id IS NOT NULL))
);

CREATE TABLE grants (
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  entry_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,  -- org entries only (checked in repo)
  PRIMARY KEY (role_id, entry_id)
);

CREATE TABLE favorites (
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (person_id, entry_id)
);

CREATE TABLE events (
  id           TEXT PRIMARY KEY,                  -- client-generated uuid: idempotency key
  person_id    TEXT NOT NULL REFERENCES people(id),
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  at           TEXT NOT NULL,                     -- client time
  kind         TEXT NOT NULL,
  tool_id      TEXT,
  url          TEXT,                              -- origin + pathname only (auditUrl)
  result       TEXT,
  detail       TEXT,
  received_at  TEXT NOT NULL
);
CREATE INDEX events_person_at ON events(person_id, at);
```

Rules the repo enforces (not expressible in SQL above):

- A grant references an `org` entry only.
- A personal view may hang under any entry its owner can see (an org entry granted to one of their
  roles, or their own personal entry). An org view only under an org entry.
- A favorite references an entry its person can see.
- Removing a role from a person deletes their favorites of entries they no longer see.
- At least one non-disabled person with an admin role must exist once the first admin is activated;
  the repo refuses the change that would leave none.

## 3. Tables (block 2)

```sql
CREATE TABLE person_keys (
  person_id        TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  x25519_public    TEXT NOT NULL,                 -- base64url raw 32 bytes
  ed25519_public   TEXT NOT NULL,                 -- base64url raw 32 bytes
  private_sealed   TEXT,                          -- migration 3: bv1. blob, opaque ciphertext (canonico §22)
  created_at       TEXT NOT NULL                  -- replaced on reset (new activation)
);

CREATE TABLE shares (
  id              TEXT PRIMARY KEY,
  credential_id   TEXT NOT NULL,                  -- uuid chosen by the credential's owner; groups holders
  from_id         TEXT NOT NULL REFERENCES people(id),
  to_id           TEXT NOT NULL REFERENCES people(id),
  tool_id         TEXT NOT NULL REFERENCES entries(id),
  scope           TEXT NOT NULL,                  -- 'role' | 'blocked' | 'org' (blocked never travels; kept for holders)
  kind            TEXT NOT NULL,                  -- 'send' | 'assign' | 'update'
  sealed          TEXT NOT NULL,                  -- SP06 §3, base64url
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,                  -- created_at + 14 days
  accepted_at     TEXT,
  declined_at     TEXT,
  purged_at       TEXT                            -- sealed set to '' after accept/decline/expiry
);
CREATE INDEX shares_to_open ON shares(to_id) WHERE accepted_at IS NULL AND declined_at IS NULL AND purged_at IS NULL;

CREATE TABLE credential_holders (
  credential_id  TEXT NOT NULL,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tool_id        TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  owner          INTEGER NOT NULL DEFAULT 0,      -- 1 for the credential's owner
  scope          TEXT NOT NULL,
  via_share_id   TEXT REFERENCES shares(id),
  since          TEXT NOT NULL,
  removed_at     TEXT,                            -- revoked from the share
  rotated_at     TEXT,                            -- owner's new-secret signal on the owner row (RF-48)
  PRIMARY KEY (credential_id, person_id)
);

CREATE TABLE assignments (                        -- admin assigned a credential to a role (E02 K8)
  credential_id  TEXT NOT NULL,
  role_id        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  tool_id        TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  assigned_by    TEXT NOT NULL REFERENCES people(id),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (credential_id, role_id)
);
```

The host never stores credential plaintext, `vaultKey`, private keys or passwords. `sealed` is
opaque ciphertext.

## 4. Migrations

`host/migrations.ts` exports an ordered array of SQL strings; `meta.schema_version` is the count
applied. On boot the repo applies the missing ones inside one transaction each. A migration never
edits an earlier one. The block 1 schema is migration 1; block 2 tables are migration 2;
`person_keys.private_sealed` (one key pair per person across machines, `docs/canonico.md` §22) is
migration 3; `credential_holders.rotated_at` (the owner's explicit rotation signal, RF-48) is
migration 4.

## 5. Acceptance

- A fresh `/data` boots, creates both key files with mode 0600, applies migrations, and reports
  `schema_version = 4` (block 1's migration 1, block 2's migration 2, `person_keys.private_sealed`
  as migration 3, and `credential_holders.rotated_at` as migration 4).
- Restarting the container keeps every row (volume at `/data`).
- Inserting a personal entry without `owner_id`, or a grant on a personal entry, fails.
