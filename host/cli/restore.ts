#!/usr/bin/env bun
// `bun run restore <file>` (SP07 §3): check a backup, then swap it in. The target data dir must be
// empty — a fresh volume, or one that was moved aside first — so a restore never overwrites data
// that is still live. Stop the service, restore, start it again.
//
//   NOD_DATA=/data NOD_PUBLIC_URL=https://… bun run restore /data/backups/host-<ISO>.db

import { basename } from 'node:path';

import { BackupError, restoreBackup } from '../backup';
import { ConfigError, loadConfig } from '../config';
import { DATABASE_FILE } from '../main';

const file = process.argv[2];
if (!file) {
  console.error('usage: bun run restore <backup-file>   (NOD_DATA points at the fresh data dir)');
  process.exit(1);
}

try {
  const config = loadConfig(process.env);
  const outcome = restoreBackup(file, config.dataDir, DATABASE_FILE);
  console.info(`restored ${basename(file)} into ${config.dataDir}: ${outcome.files.join(', ')}`);
  console.info('start the host again: the restored files are the whole state');
} catch (error) {
  if (!(error instanceof BackupError) && !(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
