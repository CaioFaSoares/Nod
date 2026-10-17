#!/usr/bin/env bun
// Boot of the host process (SP07 §1–§2, §4): environment → data dir → key files → database and
// migrations → Elysia app → backup timer. `bootHost` is the whole of it minus `listen` and the
// timer, so the tests run the same boot on a temp data dir; only the last lines of this file touch
// the process.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import type { AppMeta } from '../shared/host-api';
import { createApp } from './app';
import { loadBackupSettings, startBackupTimer, type BackupSettings } from './backup';
import { ConfigError, loadAppMeta, loadConfig, type HostConfig } from './config';
import { loadOrCreateHostSecret, loadOrCreateSigningKey, type SigningKey } from './keys';
import { applyMigrations, migrations, openDatabase } from './migrations';

export const DATABASE_FILE = 'host.db';

export type Host = {
  config: HostConfig;
  db: Database;
  /** The pair the snapshot signature and the pinned `kid` come from (SP01 §1, SP04 §2). */
  signingKey: SigningKey;
  /** Closes the connection: the signal handler here, the teardown of the tests. */
  close(): void;
};

/** Data dir, key files, database and migrations — everything before a request can be served. */
export async function bootHost(config: HostConfig): Promise<Host> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const signingKey = await loadOrCreateSigningKey(config.dataDir);
  loadOrCreateHostSecret(config.dataDir);
  const db = openDatabase(join(config.dataDir, DATABASE_FILE));
  applyMigrations(db);
  return { config, db, signingKey, close: () => db.close() };
}

async function start(): Promise<void> {
  let config: HostConfig;
  let appMeta: AppMeta;
  let backups: BackupSettings;
  try {
    config = loadConfig(process.env);
    // SP03 §3, O2: resolved here so a mistyped `NOD_MIN_APP_VERSION` or `NOD_UPDATE_URL` stops the
    // boot with one line, the way a bad PORT does, instead of failing a request later.
    appMeta = loadAppMeta(process.env);
    backups = loadBackupSettings(process.env);
  } catch (error) {
    // A bad environment is an operator mistake, not a crash: one line, no stack (repo style).
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  const host = await bootHost(config);
  const app = createApp({ config, db: host.db, appMeta });
  // No hostname hardcoded: inside the container the proxy reaches the process on every interface
  // (SP07 §2).
  app.listen({ port: config.port });
  // The scheduled pass of SP07 §4 lives with the serving process; `bun run backup-now` is the
  // same pass on demand (§3).
  const timer = startBackupTimer({ db: host.db, dataDir: config.dataDir }, backups);
  console.info(
    `nod host listening on :${config.port} (schema ${migrations.length}); ` +
      `backups every ${backups.everyHours} h, keeping ${backups.keep}`,
  );

  const shutdown = () => {
    timer.stop();
    host.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) await start();
