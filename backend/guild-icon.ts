// The guild icon of a connected Nod (SP05 §6, SP04 §2): the PNG the guild's admin uploaded, kept in
// `<app data dir>/guild-icon.png` and shown as the app icon of this machine when the person chose it.
//
// The snapshot signs only the icon's SHA-256 (SP04 §2), so the bytes are fetched separately and
// trusted only when they hash to the signed value: a host that answers other bytes — a tampered
// icon, or a snapshot from another guild — changes no icon here, and nothing is written.
//
// The runtime arrives as parameters — the connection, `app.icon`, the file calls and `store` — so
// `bun test` drives the whole module (`test/guild-icon.test.ts`) with no host, no keychain and no
// disk. Nothing here imports `tjs`, `tiny` or `bun:*`, and nothing here reads or writes a row.
// `backend/main.ts` owns the wiring: `sync()` after every applied snapshot and after an unlock,
// `reset()` when the host is removed, and the four RPC methods of SP05 §6.
//
// Nothing of this file is a secret: an icon is a public image and the choice is one word of
// `store.json` (`AGENTS.md` allows preferences there, and this one names no address and no token).

import { sha256Hex } from '../shared/encoding';
import { HOST_ROUTES } from '../shared/host-api';
import { bytesToBase64 } from './icons';
import type { AppIconChoice, AppIconState } from '../shared/types';

/** The one file this module owns, under the app's data dir (`app.paths().data`). */
export const GUILD_ICON_FILE = 'guild-icon.png';

/**
 * `store` key of the choice, `appIcon` in `store.json` (SP05 §6): `'default' | 'guild'`, and
 * anything else — absent, another word, an old value — reads as `default`.
 */
export const APP_ICON_KEY = 'appIcon';

/** What the module needs of the pinned connection: the one route of SP03 §2 that answers bytes. */
export interface IconConnection {
  getBytes(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

/** Everything `createGuildIcon` needs from its runtime; all of it injected (see the header). */
export interface GuildIconDeps {
  /** Absolute path of `GUILD_ICON_FILE` under the app's data dir. */
  path: string;
  /** The pinned connection, or `null`: with no `host` row nothing is ever requested (RF-30). */
  connection: () => IconConnection | null;
  /** `app.icon`: the png path, or `''` for the bundle icon. The runtime sends it and forgets it. */
  icon: (path: string) => void;
  /**
   * `capabilities().icon !== false`, the gate the rest of the backend uses for a runtime feature
   * (`docs/tinyjs.md` §6). Linux has no protocol to carry an app icon on a Wayland session, so the
   * machine says so and this module never calls `icon` there.
   */
  iconSupported: boolean;
  /** `tjs.readFile`/`writeFile`/`remove`, injected. */
  files: {
    /**
     * The whole file. `tjs.readFile` answers a loosely typed view and `sha256Hex` needs a
     * `Uint8Array<ArrayBuffer>`, so `backend/main.ts` hands over one copy of the bytes.
     */
    read: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
    write: (path: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
    /** Rejects when the file is not there; that is the one failure this module tolerates. */
    remove: (path: string) => Promise<void>;
  };
  /** `app.store`: the preference of SP05 §6, and never a secret. */
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<boolean>;
  };
}

/** The module, as `backend/main.ts` and the RPC methods use it. */
export interface GuildIcon {
  /**
   * Called after every applied snapshot, with the `guildIcon` of the body that was applied
   * (SP04 §2), and once after an unlock for the cached body. It fetches only when the hash moved
   * away from the bytes on disk, and a `null` deletes the file.
   */
  sync(hash: string | null): Promise<void>;
  /** SP05 §6 `nod.appIcon`: the choice, and whether a verified guild icon is available right now. */
  state(): Promise<AppIconState>;
  /**
   * 0.4.5 (RF-60): the guild icon this machine holds, as the `data:image/png;base64,…` the entry
   * screen's tile draws — the bytes on disk, and only when they are the ones `hash` signs (the
   * `guildIcon` of the cached snapshot, SP04 §2). It reads the file and nothing else: no snapshot,
   * no state and no call of the host's, so the locked screen can draw the tile before any unlock.
   * `null` when the guild has no icon, when the file is gone, or while it is not that body's icon.
   */
  dataUri(hash: string | null): Promise<string | null>;
  /** SP05 §6 `nod.setAppIcon`: stores the choice and applies it to the app icon. */
  setChoice(choice: AppIconChoice): Promise<AppIconState>;
  /** The host was removed: the file goes and the bundle icon comes back. */
  reset(): Promise<void>;
}

export function createGuildIcon(deps: GuildIconDeps): GuildIcon {
  /** The choice, read from `store` once and kept: every apply and both RPCs read this. */
  let choice: AppIconChoice | null = null;
  /** The `guildIcon` of the last body seen, `null` while the guild has none (SP04 §2). */
  let signed: string | null = null;
  /** SHA-256 of the bytes on disk, or `null` when there is no readable file. */
  let cached: string | null = null;
  /** Whether the file was read; the icon changes only when the snapshot says so, so it is read once. */
  let read = false;
  /** What `app.icon` currently carries. A fresh process starts on the bundle icon (SP05 §6). */
  let applied: AppIconChoice = 'default';
  /** The `sync` in flight, so two callers with the same hash fetch the bytes once. */
  let running: Promise<void> = Promise.resolve();

  /** SP04 §2: the bytes on disk are the icon of the guild only when they hash to the signed value. */
  function available(): boolean {
    return signed !== null && cached === signed;
  }

  /** The stored choice; every word but `guild` is `default`. */
  async function currentChoice(): Promise<AppIconChoice> {
    if (choice === null) {
      const stored = await deps.store.get(APP_ICON_KEY);
      choice = stored === 'guild' ? 'guild' : 'default';
    }
    return choice;
  }

  /** SHA-256 of the file, read at most once per process; `null` when it is not there. */
  async function diskHash(): Promise<string | null> {
    if (!read) {
      read = true;
      try {
        cached = await sha256Hex(await deps.files.read(deps.path));
      } catch {
        cached = null; // no icon from an earlier run, or one that cannot be read: no icon
      }
    }
    return cached;
  }

  /** Removes the file, tolerating one that is not there. */
  async function dropFile(): Promise<void> {
    try {
      await deps.files.remove(deps.path);
    } catch {
      // Already gone: there was no icon to delete.
    }
  }

  /**
   * The app icon of this machine, from the choice plus what is on disk: the one place `app.icon` is
   * called, and a no-op when the answer did not move — a sync that changed nothing never touches the
   * app icon, and a `default` choice on a machine already showing the bundle icon never sends `''`.
   */
  async function apply(): Promise<void> {
    const wanted: AppIconChoice = (await currentChoice()) === 'guild' && available() ? 'guild' : 'default';
    if (wanted === applied) return;
    if (deps.iconSupported) deps.icon(wanted === 'guild' ? deps.path : '');
    applied = wanted;
  }

  /**
   * SP04 §2, after a snapshot is applied: a hash other than the cached one fetches the bytes, and a
   * `null` deletes the file. Every refusal below leaves the bytes on disk exactly as they were and
   * the app icon on whatever they verify against — the bundle icon, while they do not match this
   * body — and the next sync tries again.
   */
  async function run(hash: string | null): Promise<void> {
    signed = hash;
    const onDisk = await diskHash();

    if (hash === null) {
      // SP04 §2: `null` deletes the cached file. Not only `reset` may see it — a guild can lose its
      // icon, or a person can join another one — so the deletion lives on this path.
      if (onDisk !== null) {
        await dropFile();
        cached = null;
      }
      await apply();
      return;
    }

    // The bytes on disk are already this hash: nothing to fetch. This is what every ordinary sync
    // and every unlock of a Nod that holds the icon costs (the acceptance's "only when it changes").
    if (onDisk === hash) return await apply();

    const connection = deps.connection();
    // RF-30: no `host` row, no call. A file left by a host removed by hand stays where it is; it is
    // not this snapshot's icon, so `available()` keeps refusing it and the icon is the bundle one.
    if (connection === null) return await apply();

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await connection.getBytes(HOST_ROUTES.guildIcon);
    } catch {
      // Offline, a `5xx`, a `404`, a body that did not arrive: not what a sync is about. The file
      // stays where it is; it is not this snapshot's icon, so `apply()` keeps the machine on the
      // bundle icon until a fetch verifies the bytes.
      return await apply();
    }

    if ((await sha256Hex(bytes)) !== hash) {
      // SP04 §2/§6: bytes that do not hash to the signed value are refused, and nothing is written.
      return await apply();
    }

    await deps.files.write(deps.path, bytes);
    cached = hash;
    await apply();
  }

  async function state(): Promise<AppIconState> {
    await diskHash();
    return { choice: await currentChoice(), guildIconAvailable: available() };
  }

  /**
   * RF-60: the icon of the cached body, as a data URI. `available()` is the same rule a sync
   * applies (`signed === cached`), read straight from the hash the caller passes, so the tile of the
   * entry screen shows the icon on a fresh process — before any unlock has run a `sync`.
   */
  async function dataUri(hash: string | null): Promise<string | null> {
    if (hash === null) return null;
    if ((await diskHash()) !== hash) return null;
    try {
      return `data:image/png;base64,${bytesToBase64(await deps.files.read(deps.path))}`;
    } catch {
      return null; // the digest matched a file that went away between the two reads
    }
  }

  return {
    sync(hash: string | null): Promise<void> {
      // The calls are chained instead of racing: the unlock's own `sync` and the first run of the
      // loop arrive with the same hash, and the second one finds the bytes already in place. A
      // failure belongs to its caller and not to the next call.
      const work = running.then(() => run(hash));
      running = work.catch(() => undefined);
      return work;
    },

    state,

    dataUri,

    async setChoice(wanted: AppIconChoice): Promise<AppIconState> {
      // SP05 §6: the Guild option exists only while the guild has an icon to show, and the screen
      // disables it otherwise — a caller that asks anyway is told why.
      if (wanted === 'guild' && !available()) throw new Error('the guild has no icon to show');
      if (!(await deps.store.set(APP_ICON_KEY, wanted))) {
        throw new Error('Nod could not save the app icon choice');
      }
      choice = wanted;
      await apply();
      return await state();
    },

    async reset(): Promise<void> {
      // SP05 §6 / `host.remove`: the guild's icon leaves this machine with the guild. The choice
      // stays — it is a preference, and the next guild with an icon gets it without being asked.
      signed = null;
      read = true;
      cached = null;
      await dropFile();
      await apply();
    },
  };
}
