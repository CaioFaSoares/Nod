// Ordered SQL migrations and the connection they run on (SP01 §4).
//
// `migrations[i]` is version `i + 1`; `meta.schema_version` holds the count already applied. A
// released migration is never edited — block 2 tables (SP01 §3) arrive as a new entry, not as a
// change to an existing one. H2 appends the block 1 tables (`people`, `sessions`, `access_codes`,
// `roles`, `person_roles`, `entries`, `views`, `grants`, `favorites`, `events`) to migration 1 while
// block 1 is unreleased, so a fresh `/data` still reports `schema_version = 1` (SP01 §5).

import { Database } from 'bun:sqlite';

export const migrations: readonly string[] = [
  // 1 — block 1: the meta keys `schema_version`, `guild_name` and `created_at` live here (SP01 §2).
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
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
