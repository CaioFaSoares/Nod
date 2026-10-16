// Tipos mínimos do global `tjs` do txiki.js — só o que o backend do Bond usa.
// Assinaturas conforme a documentação do tinyjs (docs/tinyjs.md §1) e txikijs.org.
declare const tjs: {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  makeDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readonly env: Record<string, string | undefined>;
  /** verified by execution (txiki.js 26.6.0): moves a file; rejects with code ENOENT when missing */
  rename(from: string, to: string): Promise<void>;
  /** verified by execution: resolves file info (isFile, size, …); rejects with code ENOENT when missing */
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
};

// `tjs:sqlite` — totalmente síncrono. Métodos verificados por execução no txiki.js 26.6.0:
// Database{close, exec, prepare, inTransaction, transaction, loadExtension}.
declare module 'tjs:sqlite' {
  export interface Statement {
    run(...params: unknown[]): void;
    all(...params: unknown[]): Record<string, unknown>[];
    finalize(): void;
  }
  export class Database {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
