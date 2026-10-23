// `tjs:sqlite` for the Electrobun/Bun target, over `bun:sqlite`. The generated config maps
// `tjs:sqlite` to this module for the main-process bundle, so `backend/sqlite.ts` imports the same
// specifier it does under txiki.js and stays unchanged.
//
// The semantics `backend/sqlite.ts` relies on (documented there): fully synchronous, `exec` for
// pragmas and statements, `prepare(sql).run(...params)` returning void and `.all(...params)` for
// rows (including `INSERT ... RETURNING`). `bun:sqlite` has the same shape; this wrapper erases the
// return value of `run` and narrows `all` to plain rows.

import { Database as BunDatabase, type Statement as BunStatement } from 'bun:sqlite';

export class Statement {
  readonly #statement: BunStatement;

  constructor(statement: BunStatement) {
    this.#statement = statement;
  }

  run(...params: unknown[]): void {
    this.#statement.run(...(params as never[]));
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.#statement.all(...(params as never[])) as Record<string, unknown>[];
  }

  finalize(): void {
    this.#statement.finalize();
  }
}

export class Database {
  readonly #database: BunDatabase;

  constructor(path: string) {
    this.#database = new BunDatabase(path);
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare(sql: string): Statement {
    return new Statement(this.#database.prepare(sql));
  }

  close(): void {
    this.#database.close();
  }
}
