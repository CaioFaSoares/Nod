// `tjs` for the Electrobun/Bun target: the global the Nod's backend uses (`backend/tjs.d.ts`),
// implemented on Bun's own file APIs. The backend is unchanged; only the process running it changes.
//
// Error shapes matter: `backend/main.ts` tells a missing file by `error.code === 'ENOENT'` on
// `tjs.stat`, and `backend/seed.ts` / `backend/icons.ts` rely on `readFile` rejecting the same way.
// Bun's `node:fs/promises` raises exactly those errors, so they pass through untouched.
//
// `remove` is not declared in `backend/tjs.d.ts` but `backend/main.ts` calls it through a cast; the
// shim provides it (txiki.js has it too).

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

export interface TjsShim {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  makeDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  remove(path: string): Promise<void>;
  env: Record<string, string | undefined>;
}

/** Installs the global `tjs` once; a no-op when the runtime already provides one. */
export function installTjs(): void {
  const target = globalThis as typeof globalThis & { tjs?: TjsShim };
  if (target.tjs !== undefined) return;
  target.tjs = {
    readFile: async (path) => new Uint8Array(await readFile(path)),
    writeFile: (path, data) => writeFile(path, data),
    makeDir: async (path, options) => {
      await mkdir(path, { recursive: options?.recursive === true });
    },
    rename,
    stat: async (path) => {
      const info = await stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
    },
    remove: async (path) => {
      await rm(path, { force: false });
    },
    env: process.env,
  };
}
