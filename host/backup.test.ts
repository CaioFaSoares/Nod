// Backup, rotation and restore, against a temp data dir, a real `VACUUM INTO` copy and the real boot
// (host/context.md, SP07 §3–§4). Run with `bun test host/backup.test.ts`.

import { afterEach, describe, expect, test, vi } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  BACKUP_DIR,
  BackupError,
  keyCopyPath,
  listBackups,
  loadBackupSettings,
  runBackup,
  restoreBackup,
  startBackupTimer,
} from './backup';
import { DEFAULT_PORT, type HostConfig } from './config';
import {
  HOST_SECRET_FILE,
  KEY_FILE_MODE,
  SIGNING_KEY_FILE,
  hostSecretPath,
  signingKeyPath,
} from './keys';
import { DATABASE_FILE, bootHost } from './main';
import { openDatabase } from './migrations';
import { createRepo } from './repo';

const dirs: string[] = [];

/** A directory that lives only for the duration of the test; `tempDir()` keeps it empty. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nod-backup-'));
  dirs.push(dir);
  return dir;
}

function tempConfig(dataDir: string = tempDir()): HostConfig {
  return { dataDir, publicUrl: 'https://nod.example', port: DEFAULT_PORT, dev: false };
}

/** The ISO instant every dated assertion pins: `<2026-10-16T18:00:00.000Z>` → `host-…Z.db`. */
const ISO = '2026-10-16T18:00:00.000Z';

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('backup', () => {
  test('one pass writes a consistent copy of the database plus both key files with mode 0600', async () => {
    const config = tempConfig();
    const host = await bootHost(config);
    try {
      const repo = createRepo(host.db);
      repo.createPerson({ id: 'p-1', email: 'ana@example.com', name: 'Ana' }, ISO);

      const outcome = runBackup(host.db, config.dataDir, { keep: 3, now: new Date(ISO) });
      expect(outcome.file).toBe(join(config.dataDir, BACKUP_DIR, `host-${ISO}.db`));
      expect(outcome.files[0]).toBe(outcome.file);
      expect(outcome.files).toHaveLength(3);
      // Nothing to rotate on the first pass.
      expect(outcome.removed).toEqual([]);

      // The file is a database of its own, readable and consistent, with the rows of that moment.
      const copy = openDatabase(outcome.file);
      try {
        expect(copy.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(copy.query<{ email: string }, []>('SELECT email FROM people').all()).toEqual([
          { email: 'ana@example.com' },
        ]);
      } finally {
        copy.close();
      }

      // A snapshot, not an alias of the live file: a later write does not reach the copy.
      repo.createPerson({ id: 'p-2', email: 'bo@example.com', name: 'Bo' }, ISO);
      const older = openDatabase(outcome.file);
      try {
        expect(older.query<{ n: number }, []>('SELECT count(*) AS n FROM people').get()).toEqual({ n: 1 });
      } finally {
        older.close();
      }

      // Both key files travel beside it, byte for byte, and only their owner can read them (SP07 §4).
      const keyCopy = keyCopyPath(outcome.file, SIGNING_KEY_FILE);
      const secretCopy = keyCopyPath(outcome.file, HOST_SECRET_FILE);
      expect(existsSync(keyCopy)).toBe(true);
      expect(existsSync(secretCopy)).toBe(true);
      expect(fileMode(keyCopy)).toBe(KEY_FILE_MODE);
      expect(fileMode(secretCopy)).toBe(KEY_FILE_MODE);
      expect(readFileSync(keyCopy)).toEqual(readFileSync(signingKeyPath(config.dataDir)));
      expect(readFileSync(secretCopy)).toEqual(readFileSync(hostSecretPath(config.dataDir)));
    } finally {
      host.close();
    }
  });

  test('rotation keeps the newest N triples and removes the older ones whole', async () => {
    const config = tempConfig();
    const host = await bootHost(config);
    try {
      const hours = ['10', '11', '12', '13', '14'];
      const removed = hours.flatMap(
        (hour) =>
          runBackup(host.db, config.dataDir, {
            keep: 3,
            now: new Date(`2026-10-16T${hour}:00:00.000Z`),
          }).removed,
      );
      // Five passes, three kept: only the two oldest went away, with their key copies.
      expect(removed.map((file) => basename(file))).toEqual([
        'host-2026-10-16T10:00:00.000Z.db',
        'host-2026-10-16T11:00:00.000Z.db',
      ]);
      expect(listBackups(config.dataDir).map((file) => basename(file))).toEqual([
        'host-2026-10-16T14:00:00.000Z.db',
        'host-2026-10-16T13:00:00.000Z.db',
        'host-2026-10-16T12:00:00.000Z.db',
      ]);
      expect(readdirSync(join(config.dataDir, BACKUP_DIR)).sort()).toEqual([
        'host-2026-10-16T12:00:00.000Z.db',
        'host-2026-10-16T12:00:00.000Z.host-secret',
        'host-2026-10-16T12:00:00.000Z.signing-key.json',
        'host-2026-10-16T13:00:00.000Z.db',
        'host-2026-10-16T13:00:00.000Z.host-secret',
        'host-2026-10-16T13:00:00.000Z.signing-key.json',
        'host-2026-10-16T14:00:00.000Z.db',
        'host-2026-10-16T14:00:00.000Z.host-secret',
        'host-2026-10-16T14:00:00.000Z.signing-key.json',
      ]);
    } finally {
      host.close();
    }
  });

  test('the timer runs the same pass on every interval, and stop() ends it', async () => {
    const config = tempConfig();
    const host = await bootHost(config);
    try {
      // The interval is real time; the test drives it with fake timers instead of sleeping.
      vi.useFakeTimers();
      try {
        const timer = startBackupTimer(
          { db: host.db, dataDir: config.dataDir },
          { everyHours: 1, keep: 3 },
        );
        expect(listBackups(config.dataDir)).toEqual([]);
        vi.advanceTimersByTime(3_600_000);
        expect(listBackups(config.dataDir)).toHaveLength(1);
        vi.advanceTimersByTime(3_600_000);
        expect(listBackups(config.dataDir)).toHaveLength(2);
        // Two more ticks: rotation of SP07 §4 keeps three, driven by the same interval.
        vi.advanceTimersByTime(7_200_000);
        expect(listBackups(config.dataDir)).toHaveLength(3);
        timer.stop();
        vi.advanceTimersByTime(7_200_000);
        expect(listBackups(config.dataDir)).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      host.close();
    }
  });
});

describe('restore', () => {
  test('a backup restores into a fresh data dir and the boot keeps the same key and the same people', async () => {
    const source = tempConfig();
    const origin = await bootHost(source);
    const salt = Buffer.from('0123456789abcdef').toString('base64url');
    const authHash = '$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA';
    createRepo(origin.db).createPerson({ id: 'p-1', email: 'ana@example.com', name: 'Ana' }, ISO);
    createRepo(origin.db).activatePerson('p-1', { salt, authHash }, ISO);
    const backup = runBackup(origin.db, source.dataDir, { keep: 3, now: new Date(ISO) });
    const kid = origin.signingKey.kid;
    origin.close();

    // A fresh volume: an empty directory, not the serving one.
    const restored = tempDir();
    const outcome = restoreBackup(backup.file, restored, DATABASE_FILE);
    expect(outcome.files).toEqual([DATABASE_FILE, SIGNING_KEY_FILE, HOST_SECRET_FILE]);
    expect(readdirSync(restored).sort()).toEqual([DATABASE_FILE, HOST_SECRET_FILE, SIGNING_KEY_FILE].sort());
    expect(fileMode(signingKeyPath(restored))).toBe(KEY_FILE_MODE);
    expect(fileMode(hostSecretPath(restored))).toBe(KEY_FILE_MODE);

    const host = await bootHost(tempConfig(restored));
    try {
      // Same pair: a Nod that pinned the host before the restore still accepts it (SP04 §1).
      expect(host.signingKey.kid).toBe(kid);
      // Same rows: the person and the credentials to sign in with are the ones that were backed up.
      const repo = createRepo(host.db);
      expect(repo.listPeople().map((person) => person.email)).toEqual(['ana@example.com']);
      const auth = repo.personAuthByEmail('ana@example.com');
      expect(auth?.salt).toBe(salt);
      expect(auth?.person.activatedAt).toBe(ISO);
      // The boot read the restored key file instead of generating a new one.
      expect(readFileSync(signingKeyPath(restored))).toEqual(readFileSync(backup.files[1]));
    } finally {
      host.close();
    }
  });

  test('refuses a data dir that already holds anything', async () => {
    const source = tempConfig();
    const origin = await bootHost(source);
    const backup = runBackup(origin.db, source.dataDir, { now: new Date(ISO) });
    origin.close();

    const occupied = tempConfig();
    const inTheWay = join(occupied.dataDir, 'keep-me');
    writeFileSync(inTheWay, 'live data\n');
    expect(() => restoreBackup(backup.file, occupied.dataDir, DATABASE_FILE)).toThrow(BackupError);
    expect(() => restoreBackup(backup.file, occupied.dataDir, DATABASE_FILE)).toThrow('is not empty');
    expect(readFileSync(inTheWay, 'utf8')).toBe('live data\n');
    expect(existsSync(join(occupied.dataDir, DATABASE_FILE))).toBe(false);
  });

  test('refuses a backup without its key files, and a file that is not a database', async () => {
    const source = tempConfig();
    const origin = await bootHost(source);
    const backup = runBackup(origin.db, source.dataDir, { now: new Date(ISO) });
    origin.close();

    // A file that carries the key copies but is not a database: the integrity check stops it.
    const junk = tempDir();
    const notADatabase = join(junk, 'host-2026-10-16T18:00:00.000Z.db');
    writeFileSync(notADatabase, 'this is not a sqlite file\n');
    for (const name of [SIGNING_KEY_FILE, HOST_SECRET_FILE]) {
      writeFileSync(keyCopyPath(notADatabase, name), readFileSync(keyCopyPath(backup.file, name)));
    }
    const empty = tempDir();
    expect(() => restoreBackup(notADatabase, empty, DATABASE_FILE)).toThrow('integrity_check');
    expect(readdirSync(empty)).toEqual([]);

    // A target that is a file, not a directory, is refused before anything is written.
    const asFile = join(tempDir(), 'data');
    writeFileSync(asFile, 'not a directory\n');
    expect(() => restoreBackup(backup.file, asFile, DATABASE_FILE)).toThrow('is not a directory');

    // A database whose key files did not travel: a restore would leave every pinned Nod refusing.
    rmSync(keyCopyPath(backup.file, HOST_SECRET_FILE));
    const bare = tempDir();
    expect(() => restoreBackup(backup.file, bare, DATABASE_FILE)).toThrow('missing');
    expect(readdirSync(bare)).toEqual([]);
  });
});

describe('settings', () => {
  test('the defaults are SP07 §2 defaults and a fractional interval is allowed', () => {
    expect(loadBackupSettings({})).toEqual({ everyHours: 24, keep: 14 });
    expect(loadBackupSettings({ NOD_BACKUP_EVERY_HOURS: '6', NOD_BACKUP_KEEP: '7' })).toEqual({
      everyHours: 6,
      keep: 7,
    });
    expect(loadBackupSettings({ NOD_BACKUP_EVERY_HOURS: '0.01' }).everyHours).toBe(0.01);
  });

  test('refuses a cadence or a rotation that would not back anything up', () => {
    expect(() => loadBackupSettings({ NOD_BACKUP_EVERY_HOURS: '0' })).toThrow(
      'invalid NOD_BACKUP_EVERY_HOURS: 0',
    );
    expect(() => loadBackupSettings({ NOD_BACKUP_KEEP: '-1' })).toThrow('invalid NOD_BACKUP_KEEP: -1');
    expect(() => loadBackupSettings({ NOD_BACKUP_KEEP: '2.5' })).toThrow('invalid NOD_BACKUP_KEEP: 2.5');
  });
});
