// In-memory SQLite for the tests (`bun test`), with the same surface as `backend/sqlite.ts`:
// `SqlDb`. Same delegation (`exec` → `Database.exec`; `all`/`run` → `prepare(sql)`), same PRAGMAs.
// `PRAGMA journal_mode = WAL` on `:memory:` does not throw in bun:sqlite — what is ignored is the
// mode.
import { Database } from 'bun:sqlite';
import type { SqlDb } from '../../shared/types';

export function memorySqlite(): SqlDb {
  const db = new Database(':memory:');
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
  };
}
