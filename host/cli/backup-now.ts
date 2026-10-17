#!/usr/bin/env bun
// `bun run backup-now` (SP07 §3): one §4 pass against the data dir, then exit. It runs beside a
// serving host — the pass reads through its own connection and never stops the service.
//
//   NOD_DATA=/data NOD_PUBLIC_URL=https://… bun run backup-now

import { bootHost } from '../main';
import { loadBackupSettings, runBackup, type BackupSettings } from '../backup';
import { ConfigError, loadConfig, type HostConfig } from '../config';

let config: HostConfig;
let settings: BackupSettings;
try {
  config = loadConfig(process.env);
  settings = loadBackupSettings(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const host = await bootHost(config);
try {
  const outcome = runBackup(host.db, config.dataDir, { keep: settings.keep });
  console.info(`backup ${outcome.file} (kept ${settings.keep}, removed ${outcome.removed.length})`);
} finally {
  host.close();
}
