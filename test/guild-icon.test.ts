// The guild icon (`backend/guild-icon.ts`) with every runtime call injected: the acceptance of
// SP05 §6 — the bytes are fetched only when the signed hash moves away from the file on disk, bytes
// that do not hash to that value are refused and nothing is written, `guildIcon: null` deletes the
// file, and the app icon follows the choice (`app.icon(path)` for the guild's, `app.icon('')` for
// the bundle's). No host, no keychain, no disk and no runtime are involved: the module's whole
// surface is the four dependencies of its `GuildIconDeps`.
import { describe, expect, test } from 'bun:test';
import { APP_ICON_KEY, GUILD_ICON_FILE, createGuildIcon } from '../backend/guild-icon';
import type { GuildIcon } from '../backend/guild-icon';
import { sha256Hex } from '../shared/encoding';
import { HOST_ROUTES } from '../shared/host-api';
import type { AppIconChoice } from '../shared/types';

/** A PNG of `size` bytes: the signature, then `fill` (the module checks a digest, never an image). */
function png(size: number, fill = 7): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.fill(fill, 8);
  return bytes;
}

interface Harness {
  guild: GuildIcon;
  /** The paths the fake connection was asked for, in order (SP03 §2's route only). */
  requests: string[];
  /** What `app.icon` was called with, in order: the png path, or `''` for the bundle icon. */
  icons: string[];
  /** The bytes on disk right now, or `null`. */
  file(): Uint8Array<ArrayBuffer> | null;
  /** What the preference holds right now. */
  stored(): unknown;
  /** What the next `GET /v1/guild/icon` answers. */
  serve(bytes: Uint8Array<ArrayBuffer>): void;
  /** The next request fails: offline, or a `404` for a guild that has no icon. */
  failNext(): void;
}

function harness(options: {
  /** `connectionOf()` answers null: this Nod has no `host` row (RF-30). */
  connected?: boolean;
  /** The preference a previous run left in `store.json`, `null` for none. */
  choice?: AppIconChoice | null;
  /** The `guild-icon.png` a previous run left on disk. */
  file?: Uint8Array<ArrayBuffer>;
  /** `capabilities().icon === false`: Linux on Wayland (SP05 §6). */
  iconSupported?: boolean;
} = {}): Harness {
  let connected = options.connected ?? true;
  let served: Uint8Array<ArrayBuffer> | null = null;
  let failing = false;
  const requests: string[] = [];
  const icons: string[] = [];
  const path = `/data/${GUILD_ICON_FILE}`;
  const disk: { bytes: Uint8Array<ArrayBuffer> | null } = { bytes: options.file ?? null };
  let stored: unknown = options.choice ?? null;

  /** Every file call of the module must name the one file it owns. */
  function at(filePath: string, what: string): void {
    if (filePath !== path) throw new Error(`unexpected ${what}: ${filePath}`);
  }

  const guild = createGuildIcon({
    path,
    connection: () =>
      connected
        ? {
            async getBytes(route: string): Promise<Uint8Array<ArrayBuffer>> {
              requests.push(route);
              if (failing) throw new Error('the host refused');
              if (served === null) throw new Error('no icon');
              return served;
            },
          }
        : null,
    icon: (pngPath) => {
      icons.push(pngPath);
    },
    iconSupported: options.iconSupported ?? true,
    files: {
      read: async (filePath) => {
        at(filePath, 'read');
        if (disk.bytes === null) throw new Error('ENOENT');
        return disk.bytes;
      },
      write: async (filePath, bytes) => {
        at(filePath, 'write');
        disk.bytes = bytes;
      },
      remove: async (filePath) => {
        at(filePath, 'remove');
        if (disk.bytes === null) throw new Error('ENOENT');
        disk.bytes = null;
      },
    },
    store: {
      get: async () => stored,
      set: async (_key, value) => {
        stored = value;
        return true;
      },
    },
  });

  return {
    guild,
    requests,
    icons,
    file: () => disk.bytes,
    stored: () => stored,
    serve: (bytes) => {
      served = bytes;
      failing = false;
    },
    failNext: () => {
      failing = true;
    },
  };
}

describe('guild icon', () => {
  test('fetches the bytes of a hash it does not hold, and only that hash', async () => {
    const h = harness({ choice: 'guild' });
    const first = png(32, 1);
    h.serve(first);

    await h.guild.sync(await sha256Hex(first));
    expect(h.requests).toEqual([HOST_ROUTES.guildIcon]);
    expect(h.file()).toEqual(first);
    // The choice was already `guild`, so the icon of this machine becomes the guild's PNG.
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`]);
    expect(await h.guild.state()).toEqual({ choice: 'guild', guildIconAvailable: true });

    // The same body again: the hash did not move, so nothing is requested and no icon is re-sent.
    await h.guild.sync(await sha256Hex(first));
    expect(h.requests.length).toBe(1);
    expect(h.icons.length).toBe(1);

    // A body whose hash moved is fetched, and the file it leaves is the new one.
    const second = png(48, 2);
    h.serve(second);
    await h.guild.sync(await sha256Hex(second));
    expect(h.requests.length).toBe(2);
    expect(h.file()).toEqual(second);
  });

  test('keeps the icon it already holds across a restart without a request', async () => {
    const bytes = png(64, 3);
    // What a second run of the app finds: the file from the last one, the preference, and a
    // snapshot naming the same icon.
    const h = harness({ choice: 'guild', file: bytes });

    await h.guild.sync(await sha256Hex(bytes));
    expect(h.requests).toEqual([]);
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`]);
  });

  test('refuses bytes that do not hash to the signed value, and writes nothing', async () => {
    const wanted = png(32, 4);
    const tampered = png(32, 5);
    const h = harness({ choice: 'guild' });
    h.serve(tampered);

    await h.guild.sync(await sha256Hex(wanted));
    expect(h.requests).toEqual([HOST_ROUTES.guildIcon]);
    expect(h.file()).toBeNull();
    // Nothing verified is on disk, so the machine keeps the bundle icon.
    expect(h.icons).toEqual([]);
    expect(await h.guild.state()).toEqual({ choice: 'guild', guildIconAvailable: false });
  });

  test('a refusal leaves the last verified file in place and the icon on the bundle one', async () => {
    const first = png(32, 6);
    const h = harness({ choice: 'guild', file: first });
    await h.guild.sync(await sha256Hex(first));
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`]);

    // The guild swapped its icon and the fetch answers bytes of another digest: refused.
    h.serve(png(32, 9));
    await h.guild.sync(await sha256Hex(png(32, 8)));
    expect(h.file()).toEqual(first);
    // The file is not the icon the snapshot signed, so it is not shown: the bundle icon is back.
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`, '']);
    expect(await h.guild.state()).toEqual({ choice: 'guild', guildIconAvailable: false });
  });

  test('an unreachable host writes nothing and the next sync tries again', async () => {
    const bytes = png(24, 7);
    const h = harness({ choice: 'guild' });
    h.failNext();

    await h.guild.sync(await sha256Hex(bytes));
    expect(h.requests).toEqual([HOST_ROUTES.guildIcon]);
    expect(h.file()).toBeNull();

    // Offline is not a refusal of the icon: once the host answers, the bytes land.
    h.serve(bytes);
    await h.guild.sync(await sha256Hex(bytes));
    expect(h.requests.length).toBe(2);
    expect(h.file()).toEqual(bytes);
  });

  test('null deletes the file and puts the bundle icon back', async () => {
    const bytes = png(40, 8);
    const h = harness({ choice: 'guild', file: bytes });
    await h.guild.sync(await sha256Hex(bytes));
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`]);

    await h.guild.sync(null);
    expect(h.file()).toBeNull();
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`, '']);
    expect(await h.guild.state()).toEqual({ choice: 'guild', guildIconAvailable: false });
  });

  test('a null with nothing on disk is not a second reset', async () => {
    const h = harness();
    await h.guild.sync(null);
    expect(h.icons).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  test('no host row: no request at all, whatever the snapshot names', async () => {
    const bytes = png(32, 10);
    const h = harness({ connected: false, choice: 'guild' });

    await h.guild.sync(await sha256Hex(bytes));
    expect(h.requests).toEqual([]);
    expect(h.file()).toBeNull();
    expect(h.icons).toEqual([]);
    expect(await h.guild.state()).toEqual({ choice: 'guild', guildIconAvailable: false });
  });

  test("choosing 'guild' applies the png path, 'default' applies the bundle icon", async () => {
    const bytes = png(32, 11);
    const h = harness({ file: bytes });
    await h.guild.sync(await sha256Hex(bytes));

    expect(await h.guild.setChoice('guild')).toEqual({ choice: 'guild', guildIconAvailable: true });
    expect(h.stored()).toBe('guild');
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`]);

    expect(await h.guild.setChoice('default')).toEqual({ choice: 'default', guildIconAvailable: true });
    expect(h.stored()).toBe('default');
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`, '']);
    // The bytes stay: the choice is about which icon is shown, not about the file (SP05 §6).
    expect(h.file()).toEqual(bytes);
  });

  test("choosing 'guild' is refused while no verified icon is on disk", async () => {
    const h = harness();
    await expect(h.guild.setChoice('guild')).rejects.toThrow();
    expect(h.stored()).toBeNull();
    expect(h.icons).toEqual([]);
  });

  test('a host removed resets the file and the icon, and keeps the preference', async () => {
    const bytes = png(32, 12);
    const h = harness({ choice: 'guild', file: bytes });
    await h.guild.sync(await sha256Hex(bytes));

    await h.guild.reset();
    expect(h.file()).toBeNull();
    expect(h.icons).toEqual([`/data/${GUILD_ICON_FILE}`, '']);
    expect(h.stored()).toBe('guild');
    expect(await h.guild.state()).toEqual({ choice: 'guild', guildIconAvailable: false });
  });

  test('a machine whose system refuses an app icon is never asked for one', async () => {
    const bytes = png(32, 13);
    const h = harness({ choice: 'guild', iconSupported: false });
    h.serve(bytes);

    await h.guild.sync(await sha256Hex(bytes));
    // The file is kept all the same — a session that can show it gets it — and nothing is sent.
    expect(h.file()).toEqual(bytes);
    expect(h.icons).toEqual([]);
  });
});

describe('the stored preference', () => {
  test('is the key SP05 §6 names, and only `guild` is read out of it', async () => {
    expect(APP_ICON_KEY).toBe('appIcon');

    const guild = harness({ choice: 'guild' });
    expect(await guild.guild.state()).toEqual({ choice: 'guild', guildIconAvailable: false });

    const none = harness({ choice: null });
    expect(await none.guild.state()).toEqual({ choice: 'default', guildIconAvailable: false });
    // Reading the state writes nothing: a machine that never chose keeps `store.json` untouched.
    expect(none.stored()).toBeNull();

    const stranger = harness({ choice: 'guild-icon' as AppIconChoice });
    expect(await stranger.guild.state()).toEqual({ choice: 'default', guildIconAvailable: false });
  });
});
