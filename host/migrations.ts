// Ordered SQL migrations and the connection they run on (SP01 §4).
//
// `migrations[i]` is version `i + 1`; `meta.schema_version` holds the count already applied. A
// released migration is never edited — block 2 tables (SP01 §3) arrive as a new entry, not as a
// change to an existing one. H2 appends the block 1 tables (`people`, `sessions`, `access_codes`,
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
      throw new Error(`invalid ${SCHEMA_VERSION_KEY} in meta: ${versionRow.value}`);
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
