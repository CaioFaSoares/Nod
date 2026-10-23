// `app.store` for the Electrobun target: one JSON object in the app's data dir, written atomically.
//
// Parity with tinyjs's `store.json` (A7–A9, A18): a single JSON object, `get` answers `null` for an
// absent key, `set` resolves `false` when the write failed (never throws), `delete` removes a key.
// Preferences only — the backend never stores a secret here (`AGENTS.md`).
//
// Atomic write: the whole document is serialized into `<dir>/.store.json.<pid>.<n>.tmp` and renamed
// over `store.json`, so a crash mid-write leaves the previous file intact. Writes are serialized so
// two concurrent `set`s cannot interleave their temp files.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export interface Store {
  get(key: string): Promise<any | null>;
  set(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  all(): Promise<Record<string, any>>;
}

type StoreValue = Record<string, unknown>;

function parse(text: string): StoreValue {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as StoreValue;
    }
  } catch {
    // A corrupt file is treated as empty: preferences, not data.
  }
  return {};
}

/** `a/b/store.json` -> `a/b`; the file API has no dirname. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '.' : path.slice(0, cut);
}

/**
 * @param path absolute path of `store.json` under the app's data dir
 *   (`Utils.paths.userData` on Electrobun).
 */
export function createStore(path: string): Store {
  let loaded: Promise<StoreValue> | null = null;
  let data: StoreValue = {};
  let writes: Promise<unknown> = Promise.resolve();
  let counter = 0;

  async function load(): Promise<StoreValue> {
    try {
      data = parse(await readFile(path, 'utf8'));
    } catch {
      data = {};
    }
    return data;
  }

  function ensureLoaded(): Promise<StoreValue> {
    if (loaded === null) loaded = load();
    return loaded;
  }

  async function flush(snapshot: StoreValue): Promise<boolean> {
    const tmp = `${path}.${process.pid}.${counter++}.tmp`;
    try {
      await mkdir(directoryOf(path), { recursive: true });
      await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
      await rename(tmp, path);
      return true;
    } catch {
      try {
        await unlink(tmp);
      } catch {
        // The temp file may not exist; the failure that matters is the write/rename one.
      }
      return false;
    }
  }

  /** Run one mutation after every earlier one; revert in memory when the disk write fails. */
  function mutate(change: (snapshot: StoreValue) => boolean): Promise<boolean> {
    const run = writes.then(async () => {
      const current = await ensureLoaded();
      const before = { ...current };
      if (!change(current)) return true;
      const ok = await flush(current);
      if (!ok) data = before;
      return ok;
    });
    writes = run.catch(() => undefined);
    return run;
  }

  return {
    async get(key) {
      const current = await ensureLoaded();
      const value = current[key];
      return value === undefined ? null : value;
    },
    set(key, value) {
      // JSON decides what is storable: an undefined/function value is not a preference.
      let encoded: string;
      try {
        const probe = JSON.stringify({ [key]: value });
        if (probe === undefined) return Promise.resolve(false);
        encoded = probe;
      } catch {
        return Promise.resolve(false);
      }
      const next = JSON.parse(encoded) as StoreValue;
      if (!(key in next)) return Promise.resolve(false);
      return mutate((snapshot) => {
        snapshot[key] = next[key];
        return true;
      });
    },
    delete(key) {
      return mutate((snapshot) => {
        if (!(key in snapshot)) return false;
        delete snapshot[key];
        return true;
      });
    },
    async all() {
      const current = await ensureLoaded();
      return { ...current };
    },
  };
}
