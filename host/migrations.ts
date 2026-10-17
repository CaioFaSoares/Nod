// Ordered SQL migrations and the connection they run on (SP01 §4).
//
// `migrations[i]` is version `i + 1`; `meta.schema_version` holds the count already applied. A
// released migration is never edited — block 2 tables (SP01 §3) arrived as entry 2, and the
// `person_keys.private_sealed` column of the one-pair-per-person rule (`docs/canonico.md` §22) as
// entry 3, the `credential_holders.rotated_at` column of the explicit rotation signal (RF-48) as
// entry 4, the `guild_invites` table of RF-59 as entry 5, and the `entries.category` column of
// RF-62's tool categories as entry 6. H2 appends the block 1 tables
// (`people`, `sessions`, `access_codes`,
// `roles`, `person_roles`, `entries`, `views`, `grants`, `favorites`, `events`) to migration 1 while
// block 1 is unreleased, so a fresh `/data` still reports `schema_version = 1` (SP01 §5).

import { Database } from 'bun:sqlite';

export const migrations: readonly string[] = [
  // 1 — block 1: every table of SP01 §2. The meta keys `schema_version`, `guild_name` and
  // `created_at` live in `meta`. Block 1 is unreleased, so H2 appends the rest of its tables here
  // instead of opening entry 2: a fresh `/data` reports `schema_version = 1` (SP01 §4–§5). Block 2
  // tables (SP01 §3) become entry 2.
  `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: schema_version, guild_name, created_at

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
`,

  // 2 — block 2: every table of SP01 §3, the credential sharing of E02. `sealed` is opaque
  // ciphertext (SP06 §3) and is cleared after accept, decline or expiry (14 days); the host never
  // holds a credential's plaintext, a private key or `vaultKey`.
  `
CREATE TABLE person_keys (
  person_id        TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  x25519_public    TEXT NOT NULL,                 -- base64url raw 32 bytes
  ed25519_public   TEXT NOT NULL,                 -- base64url raw 32 bytes
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
`,

  // 3 — one key pair per person across machines (`docs/canonico.md` §22, SP06 §2). The first machine
  // to activate seals its private halves under its `vaultKey` as a `bv1.` value and publishes it
  // beside the public keys, so every other machine of that person adopts the pair instead of
  // generating a competing one. The column is opaque ciphertext like `shares.sealed`: the host
  // stores it and hands it back to its owner, and it never opens it. Nullable on purpose — a row
  // written before this migration carries public keys only, and the owner's next unlock uploads the
  // blob. A reset replaces the value together with the two public keys.
  `
ALTER TABLE person_keys ADD COLUMN private_sealed TEXT;
`,

  // 4 — RF-48 (`docs/handovers/k10-smoke.md` finding 1): the explicit rotation signal. Revoking the
  // last non-owner holder leaves the owner nobody to fan an `update` share out to, so their save
  // cannot clear the credential's `rotationPending` through a share. The owner row records the
  // instant they saved a new secret (`POST /v1/credentials/:id/rotated`), and `rotationPending`
  // reads it beside the latest `update` share. Nullable: a credential nobody rotated never sets it,
  // and the column is opaque bookkeeping — no value of a body is stored here.
  `
ALTER TABLE credential_holders ADD COLUMN rotated_at TEXT;
`,

  // 5 — guild invites (0.4.5, RF-59; SP01 §2). One row per invite an admin created: the roles it
  // grants (JSON array of their ids), how many times it may be redeemed (`max_uses` null = no
  // limit) and until when (`expires_at` null = never). `code_hash` is the hex SHA-256 of the
  // normalized code, exactly like `access_codes.code_hash` (SP02 §3) — the code itself is shown
  // once and stored nowhere. `uses` counts the redemptions that succeeded; a failed one (a taken
  // email, a revoked or expired invite) leaves it alone. `created_by` is the admin person, kept
  // without a foreign key: the invite outlives a person row the host never deletes.
  `
CREATE TABLE guild_invites (
  id          TEXT PRIMARY KEY,                   -- uuid
  code_hash   TEXT NOT NULL UNIQUE,               -- hex sha256 of the normalized code (SP02 §3)
  roles       TEXT NOT NULL,                      -- JSON array of role ids
  max_uses    INTEGER,                            -- null: no limit
  uses        INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,                      -- the admin person id
  created_at  TEXT NOT NULL,
  expires_at  TEXT,                               -- null: never expires
  revoked_at  TEXT
);
`,

  // 6 — the display category of an org tool (0.4.5, RF-62). `NULL` is "the guild filed it nowhere",
  // which is what every row written before this column is, and what a personal entry always stays:
  // the personal routes do not declare the field, so their writes leave it alone (`host/repo.ts`).
  // The name itself is bounded by the admin route's schema and by `shared/catalog.ts`'s validator.
  `
ALTER TABLE entries ADD COLUMN category TEXT;
`,
];

export const SCHEMA_VERSION_KEY = 'schema_version';

/** The one connection of the process: one file, one writer (SP01 §1). */
export function openDatabase(file: string): Database {
  const db = new Database(file, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Applies every missing migration, each in its own transaction together with its
 * `schema_version` bump, and returns the version the database ended on (SP01 §4).
 */
export function applyMigrations(db: Database): number {
  // A fresh file has no `meta` yet (migration 1 creates it); only a migrated one carries a version.
  const hasMeta = db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get();
  let applied = 0;
  if (hasMeta) {
    const versionRow = db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(SCHEMA_VERSION_KEY);
    applied = versionRow ? Number(versionRow.value) : 0;
    if (!Number.isInteger(applied) || applied < 0) {
      throw new Error(`invalid ${SCHEMA_VERSION_KEY} in meta: ${versionRow?.value}`);
    }
    if (applied > migrations.length) {
      throw new Error(
        `${SCHEMA_VERSION_KEY} ${applied} is newer than this build (${migrations.length})`,
      );
    }
  }

  for (let version = applied + 1; version <= migrations.length; version++) {
    const sql = migrations[version - 1];
    db.transaction(() => {
      db.exec(sql);
      db.query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(SCHEMA_VERSION_KEY, String(version));
    })();
  }
  return migrations.length;
}
