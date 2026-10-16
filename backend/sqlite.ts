// SQLite of the runtime (txiki.js): `tjs:sqlite` is fully synchronous — never `await`.
// Contract: `docs/arquitetura.md` §4. The surface used is only `exec` and `prepare(sql).run/.all`.
//
// The module types come from `backend/tjs.d.ts` (`declare module 'tjs:sqlite'`: `Database` and
// `Statement`), declared from the real surface of the runtime.
import { Database } from 'tjs:sqlite';
import type { SqlDb } from '../shared/types';

// What the runtime guarantees: `run` returns void (use `INSERT ... RETURNING id` with `.all()` for
// the id of an insert), and there is no `get()` — a single row comes from `.all()[0]`.

/**
 * `SqlDb` plus the handle's `close`: the boot has to let go of the database before moving it aside
 * (`backend/main.ts`), and the tests do not need it (`test/helpers/sqlite-bun.ts`).
 */
export interface OpenDatabase extends SqlDb {
  close(): void;
}

/** Opens (or creates) the database at `path` with foreign keys on and in WAL. */
export function openSqlite(path: string): OpenDatabase {
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
    run(sql: string, params: unknown[] = []): void {
      db.prepare(sql).run(...params);
    },
    close(): void {
      db.close();
    },
  };
}
