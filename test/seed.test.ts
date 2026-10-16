// `backend/seed.ts`: the private seed of the release (canonico §19, RF-26, RF-27;
// docs/arquitetura.md §4). The seed file is read through the injected `readFile` and the icons go
// to a fake store, so nothing here touches the app data directory or the real `tjs`.
import { describe, expect, test } from 'bun:test';

import { createRepo } from '../backend/repo';
import { applyBundledSeed, gateOrigins, importSeedFile, storedSeedVersion } from '../backend/seed';
import { memorySqlite } from './helpers/sqlite-bun';
import type { Icons } from '../backend/icons';
import type { Repo } from '../backend/repo';
import type { Entry, InviteSeed, Seed } from '../shared/types';

const RESOURCES = '/bundle';
const SEED_PATH = `${RESOURCES}/seed.json`;

/** A complete valid entry; a test overrides only the field it is about. */
function entry(id: string, title: string, url: string, icon: string | null = null): Entry {
  return { id, title, url, icon, order: 10, roles: [], views: [], auth: null, active: true };
}

function seed(version: number, entries: Entry[], invites: InviteSeed[] = []): Seed {
  return {
    version,
    generatedAt: '2026-10-15T00:00:00.000Z',
    roles: [],
    entries,
    invites,
    update: null,
  };
}

/** A bundle on disk: the paths it holds and their bytes; any other path does not exist. */
function bundle(files: Record<string, string | undefined>): (path: string) => Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return (path) => {
    const content = files[path];
    if (content === undefined) return Promise.reject(new Error(`no such file: ${path}`));
    return Promise.resolve(encoder.encode(content));
  };
}

interface FakeIcons {
  store: Icons;
  /** Base64 of every icon the seed wrote, in order. */
  saved: string[];
}

function fakeIcons(): FakeIcons {
  const saved: string[] = [];
  return {
    saved,
    store: {
      save(icon) {
        saved.push(icon.base64);
        return Promise.resolve(String(saved.length).padStart(64, '0'));
      },
      dataUri(hash) {
        return Promise.resolve(hash === '' ? null : `data:image/png;base64,${hash}`);
      },
    },
  };
}

function freshRepo(): Repo {
  const repo = createRepo(memorySqlite());
  repo.migrate();
  return repo;
}

describe('applyBundledSeed', () => {
  test('applies the bundled seed on the first boot and does nothing on the next one', async () => {
    const repo = freshRepo();
    const icons = fakeIcons();
    const readFile = bundle({
      [SEED_PATH]: JSON.stringify(
        seed(3, [entry('kanban', 'Kanban', 'https://kanban.copland.studio')]),
      ),
    });

    expect(await applyBundledSeed(repo, RESOURCES, icons.store, readFile)).toBe(3);
    expect(repo.listEntries().map((item) => item.id)).toEqual(['kanban']);
    expect(storedSeedVersion(repo)).toBe(3);
    // RF-12: the boot is auditable, once.
    expect(repo.listEvents({}).map((event) => event.type)).toEqual(['seed_applied']);

    expect(await applyBundledSeed(repo, RESOURCES, icons.store, readFile)).toBeNull();
    expect(repo.listEntries().map((item) => item.id)).toEqual(['kanban']);
    expect(repo.listEvents({})).toHaveLength(1);
  });

  test('a newer seed inserts only the missing ids and never overwrites what is there', async () => {
    const repo = freshRepo();
    const icons = fakeIcons();
    const kanban = entry('kanban', 'Kanban', 'https://kanban.copland.studio');

    await applyBundledSeed(
      repo,
      RESOURCES,
      icons.store,
      bundle({ [SEED_PATH]: JSON.stringify(seed(1, [kanban])) }),
    );
    const local = repo.entry('kanban');
    if (local === null) throw new Error('the seed did not insert kanban');
    repo.saveEntry({ ...local, title: 'Kanban (local)' });

    const next = seed(2, [kanban, entry('affine', 'Affine', 'https://affine.copland.studio')]);
    expect(
      await applyBundledSeed(
        repo,
        RESOURCES,
        icons.store,
        bundle({ [SEED_PATH]: JSON.stringify(next) }),
      ),
    ).toBe(2);

    // RF-27: the local edit survives the newer seed.
    expect(repo.entry('kanban')?.title).toBe('Kanban (local)');
    expect(repo.entry('affine')?.title).toBe('Affine');
    expect(repo.listEntries()).toHaveLength(2);
    expect(storedSeedVersion(repo)).toBe(2);
  });

  test('reads a relative icon from the bundle and ignores any path that escapes it', async () => {
    const repo = freshRepo();
    const icons = fakeIcons();

    await applyBundledSeed(
      repo,
      RESOURCES,
      icons.store,
      bundle({
        [SEED_PATH]: JSON.stringify(
          seed(1, [
            entry('kanban', 'Kanban', 'https://kanban.copland.studio', 'icons/kanban.png'),
            entry('mail', 'Mail', 'https://mail.copland.studio', '../secret.png'),
            entry('wiki', 'Wiki', 'https://wiki.copland.studio', '/etc/icon.png'),
            entry('drive', 'Drive', 'https://drive.copland.studio', 'c:/icon.png'),
            entry('notes', 'Notes', 'https://notes.copland.studio', 'icons/notes.txt'),
          ]),
        ),
        [`${RESOURCES}/icons/kanban.png`]: 'png-bytes',
        // These are the exact paths the seed would ask for; all of them exist, so the path check —
        // not a missing file — is what must refuse them.
        [`${RESOURCES}/../secret.png`]: 'png-bytes',
        [`${RESOURCES}//etc/icon.png`]: 'png-bytes',
        [`${RESOURCES}/c:/icon.png`]: 'png-bytes',
        [`${RESOURCES}/icons/notes.txt`]: 'png-bytes',
      }),
    );

    expect(icons.saved).toHaveLength(1);
    expect(repo.iconHash('kanban')).not.toBeNull();
    for (const id of ['mail', 'wiki', 'drive', 'notes']) expect(repo.iconHash(id)).toBeNull();
  });

  test('does nothing when the bundle carries no seed', async () => {
    const repo = freshRepo();
    const icons = fakeIcons();

    expect(await applyBundledSeed(repo, RESOURCES, icons.store, bundle({}))).toBeNull();
    expect(await applyBundledSeed(repo, null, icons.store, bundle({}))).toBeNull();
    expect(repo.listEntries()).toHaveLength(0);
    expect(storedSeedVersion(repo)).toBeNull();
  });
});

describe('importSeedFile', () => {
  test('overwrite updates an existing title, merge only inserts', async () => {
    const repo = freshRepo();
    const icons = fakeIcons();
    await applyBundledSeed(
      repo,
      RESOURCES,
      icons.store,
      bundle({
        [SEED_PATH]: JSON.stringify(
          seed(1, [entry('kanban', 'Kanban', 'https://kanban.copland.studio')]),
        ),
      }),
    );

    const renamed = JSON.stringify(
      seed(2, [entry('kanban', 'Kanban Board', 'https://kanban.copland.studio')]),
    );
    expect(await importSeedFile(repo, renamed, 'merge', icons.store)).toEqual({
      entries: 0,
      roles: 0,
      invites: 0,
    });
    expect(repo.entry('kanban')?.title).toBe('Kanban');

    const overwritten = await importSeedFile(repo, renamed, 'overwrite', icons.store);
    expect(overwritten.entries).toBe(1);
    expect(repo.entry('kanban')?.title).toBe('Kanban Board');
  });

  test('rejects a file that is not JSON', async () => {
    const repo = freshRepo();
    await expect(importSeedFile(repo, 'not json', 'merge', fakeIcons().store)).rejects.toThrow(
      'invalid seed: not JSON',
    );
  });
});

describe('gateOrigins', () => {
  test('returns the exact entry origins, in seed order and without repeats', () => {
    const origins = gateOrigins(
      seed(1, [
        entry('kanban', 'Kanban', 'https://kanban.copland.studio/boards?token=1'),
        entry('mail', 'Mail', 'https://mail.copland.studio'),
        entry('kanban-again', 'Kanban again', 'https://kanban.copland.studio/other#x'),
      ]),
    );

    expect(origins).toEqual(['https://kanban.copland.studio', 'https://mail.copland.studio']);
    expect(gateOrigins(null)).toEqual([]);
  });
});
