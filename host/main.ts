#!/usr/bin/env bun
// Boot of the host process (SP07 §1–§2): environment → data dir → key files → database and
// migrations → Elysia app. `bootHost` is the whole of it minus `listen`, so the tests run the same
// boot on a temp data dir; only the last lines of this file touch the process.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import { createApp } from './app';
import { ConfigError, loadConfig, type HostConfig } from './config';
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
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // A bad environment is an operator mistake, not a crash: one line, no stack (repo style).
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  const host = await bootHost(config);
  const app = createApp({ config, db: host.db });
  // No hostname hardcoded: inside the container the proxy reaches the process on every interface
  // (SP07 §2).
  app.listen({ port: config.port });
  console.info(`bond host listening on :${config.port} (schema ${migrations.length})`);

  const shutdown = () => {
    host.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) await start();
