// Backup and restore (SP07 §4). One pass writes `host-<ISO>.db` with `VACUUM INTO` — a consistent
// copy of the live database, safe while the host is serving — copies the two key files beside it
// with mode 0600, and rotates the oldest. The destination is the data volume only; the copy off the
// VPS is deferred (owner, 2026-10-16, `docs/canonico.md` §14 "Host backup target").
//
// This module never opens a connection of its own: `VACUUM INTO` runs on the handle the boot owns,
// and the restored copy is checked through `openDatabase` of `migrations.ts`, the one module that
// loads `bun:sqlite` (host/repo.test.ts). Every query still belongs to `repo.ts` (host/context.md).
// Nothing here logs or returns key material.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ConfigError } from './config';
import { HOST_SECRET_FILE, KEY_FILE_MODE, SIGNING_KEY_FILE, hostSecretPath, signingKeyPath } from './keys';
import type { Host } from './main';
import { openDatabase } from './migrations';

/** Subdirectory of the data dir that holds every backup (SP07 §4: `/data/backups`). */
export const BACKUP_DIR = 'backups';
/** Every backup is `host-<ISO>.db`; sorting the names sorts them by age. */
export const BACKUP_PREFIX = 'host-';
export const BACKUP_SUFFIX = '.db';
export const DEFAULT_BACKUP_EVERY_HOURS = 24;
export const DEFAULT_BACKUP_KEEP = 14;

/** The cadence and the rotation of SP07 §2's two environment variables. */
export type BackupSettings = {
  everyHours: number;
  keep: number;
};

/** A backup that cannot be written, or a file that cannot be restored: the message names the path. */
export class BackupError extends Error {}

function positive(raw: string | undefined, name: string, fallback: number, integer: boolean): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new ConfigError(`invalid ${name}: ${raw}`);
  }
  return value;
}

/** `BOND_BACKUP_EVERY_HOURS` (default 24) and `BOND_BACKUP_KEEP` (default 14), as compose passes them. */
export function loadBackupSettings(env: Record<string, string | undefined>): BackupSettings {
  return {
    // Hours may be fractional: a deploy proof runs an interval of minutes, not days.
    everyHours: positive(env.BOND_BACKUP_EVERY_HOURS, 'BOND_BACKUP_EVERY_HOURS', DEFAULT_BACKUP_EVERY_HOURS, false),
    keep: positive(env.BOND_BACKUP_KEEP, 'BOND_BACKUP_KEEP', DEFAULT_BACKUP_KEEP, true),
  };
}

/**
 * Where one backup's copy of a key file lives: `<host-<ISO>>.signing-key.json`. The database keeps
 * the exact name SP07 §4 writes (`host-<ISO>.db`), and the key copies carry the same timestamp stem
 * so that every backup is one findable triple — the newest copy never overwrites an older one.
 */
export function keyCopyPath(dbFile: string, keyFile: string): string {
  const name = basename(dbFile);
  const stem = name.endsWith(BACKUP_SUFFIX) ? name.slice(0, -BACKUP_SUFFIX.length) : name;
  return join(dirname(dbFile), `${stem}.${keyFile}`);
}

export type BackupOutcome = {
  /** The file `VACUUM INTO` wrote (SP07 §4). */
  file: string;
  /** Every path this pass wrote, the copy first. */
  files: string[];
  /** The backups rotation removed, oldest first. */
  removed: string[];
};

/**
 * One pass of SP07 §4: a consistent copy of the open database, both key files beside it with mode
 * 0600, then rotation down to `keep`. `VACUUM INTO` reads through the live connection, so a host
 * that is serving is not stopped and not corrupted (one writer, SP01 §1).
 */
export function runBackup(
  db: Host['db'],
  dataDir: string,
  options: { keep?: number; now?: Date } = {},
): BackupOutcome {
  const keep = options.keep ?? DEFAULT_BACKUP_KEEP;
  const dir = join(dataDir, BACKUP_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const file = join(dir, `${BACKUP_PREFIX}${(options.now ?? new Date()).toISOString()}${BACKUP_SUFFIX}`);
  // VACUUM INTO refuses an existing file: a collision is an error, never a silent overwrite.
  db.run('VACUUM INTO ?', [file]);

  const files = [file];
  for (const [name, source] of [
    [SIGNING_KEY_FILE, signingKeyPath(dataDir)],
    [HOST_SECRET_FILE, hostSecretPath(dataDir)],
  ] as const) {
    const destination = keyCopyPath(file, name);
    copyFileSync(source, destination);
    chmodSync(destination, KEY_FILE_MODE);
    files.push(destination);
  }

  return { file, files, removed: rotate(dir, keep) };
}

/** Newest first by name: `<ISO>` is fixed width, so the order of the names is the order of the passes. */
export function listBackups(dataDir: string): string[] {
  const dir = join(dataDir, BACKUP_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

/** Keeps the newest `keep` backups, each removed with its two key copies. Answers the removed files. */
function rotate(dir: string, keep: number): string[] {
  const removed: string[] = [];
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .sort()
    .reverse();
  for (const name of files.slice(keep)) {
    const file = join(dir, name);
    for (const key of [SIGNING_KEY_FILE, HOST_SECRET_FILE]) {
      rmSync(keyCopyPath(file, key), { force: true });
    }
    rmSync(file, { force: true });
    removed.push(file);
  }
  return removed.reverse();
}

/**
 * `PRAGMA integrity_check` on the file a restore is about to serve (SP07 §3), through the one module
 * that opens connections. It opens read-write — the restored file is the live database from here on
 * — so it is never pointed at a backup that must stay untouched. False on any failure.
 */
function integrityCheck(file: string): boolean {
  let db: Host['db'] | undefined;
  try {
    db = openDatabase(file);
    const row = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get();
    return row?.integrity_check === 'ok';
  } catch {
    // Not a database, truncated, unreadable: all of it is "not restorable", none of it is a stack.
    return false;
  } finally {
    db?.close();
  }
}

export type RestoreOutcome = {
  /** The database file now in the data dir. */
  file: string;
  /** The three files written into a data dir that was empty. */
  files: string[];
};

/**
 * SP07 §3: check the backup, then swap it in. The target data dir must be empty — a restore never
 * overwrites a live volume, so a restore into an existing volume first moves it aside. The key
 * files travel with the database: without them every pinned Bond refuses the host (SP07 §4).
 */
export function restoreBackup(sourceFile: string, dataDir: string, dbFile: string): RestoreOutcome {
  if (!existsSync(sourceFile)) throw new BackupError(`backup file not found: ${sourceFile}`);
  const pairs = [SIGNING_KEY_FILE, HOST_SECRET_FILE].map((name) => ({
    from: keyCopyPath(sourceFile, name),
    to: join(dataDir, name),
    name,
  }));
  for (const pair of pairs) {
    if (!existsSync(pair.from)) {
      throw new BackupError(`backup is missing ${basename(pair.from)}: restore needs the key files (SP07 §4)`);
    }
  }

  if (existsSync(dataDir) && !statSync(dataDir).isDirectory()) {
    throw new BackupError(`${dataDir} is not a directory: BOND_DATA must be the data dir`);
  }
  const occupied = existsSync(dataDir) ? readdirSync(dataDir) : [];
  if (occupied.length > 0) {
    throw new BackupError(`${dataDir} is not empty (${occupied.length} entries): restore into a fresh data dir`);
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = join(dataDir, dbFile);
  // Copy through a scratch name: a half-written file never wears the name the boot opens.
  const scratch = join(dataDir, `${dbFile}.restore`);
  copyFileSync(sourceFile, scratch);
  renameSync(scratch, target);

  // SP07 §3's check runs on the copy: the backup is never opened, so a backup on a read-only mount
  // stays usable, and a rejection leaves the target dir as empty as it was found.
  if (!integrityCheck(target)) {
    for (const name of [`${dbFile}-wal`, `${dbFile}-shm`, dbFile]) {
      rmSync(join(dataDir, name), { force: true });
    }
    throw new BackupError(`${sourceFile} failed PRAGMA integrity_check: not a usable database`);
  }

  // The check opened the copy in WAL mode; a clean close checkpoints it. What it left behind carries
  // no pages — an empty WAL and the shared-memory index — so the restored dir is exactly the triple.
  const wal = join(dataDir, `${dbFile}-wal`);
  if (existsSync(wal) && statSync(wal).size === 0) rmSync(wal, { force: true });
  rmSync(join(dataDir, `${dbFile}-shm`), { force: true });

  for (const pair of pairs) {
    copyFileSync(pair.from, pair.to);
    chmodSync(pair.to, KEY_FILE_MODE);
  }
  return { file: target, files: [dbFile, ...pairs.map((pair) => pair.name)] };
}

export type BackupTimer = {
  stop(): void;
};

/**
 * The scheduled pass of SP07 §4, started by `main.ts`. A failed pass logs one line and the next
 * interval retries: a full disk must not take the guild down.
 */
export function startBackupTimer(
  host: { db: Host['db']; dataDir: string },
  settings: BackupSettings,
): BackupTimer {
  const everyMs = Math.round(settings.everyHours * 3_600_000);
  const timer = setInterval(() => {
    try {
      const outcome = runBackup(host.db, host.dataDir, { keep: settings.keep });
      console.info(`backup ${basename(outcome.file)} (kept ${settings.keep}, removed ${outcome.removed.length})`);
    } catch (error) {
      console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, everyMs);
  return { stop: () => clearInterval(timer) };
}
