#!/usr/bin/env bun
// `bun run eb:dev` — a development launch of the Electrobun app. Replaces the old tinyjs
// `app:dev`: vite serves the page, the generated dev config points the main window at it, and the
// Electrobun CLI runs the app with its own identifier (`copland.nod.eb-dev`), so a dev launch never
// touches a release installation's data, keychain items or URL scheme.
//
// `NOD_APP_ID` and `NOD_DEV_PORT` may be overridden. The dev server is a child of this process and
// is stopped when the app exits.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const isMac = process.platform === 'darwin';

const env = {
  ...process.env,
  NOD_APP_ID: (process.env.NOD_APP_ID ?? '').trim() || 'copland.nod.eb-dev',
  NOD_DEV_PORT: process.env.NOD_DEV_PORT ?? '5173',
};

if (env.NOD_APP_ID === 'copland.nod') {
  throw new Error('NOD_APP_ID must not be copland.nod in a dev run: use copland.nod.eb-dev');
}

function bun(): string {
  return Bun.which('bun') ?? process.execPath;
}

function electrobun(): string[] {
  const local = join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electrobun.cmd' : 'electrobun',
  );
  if (existsSync(local)) {
    return process.platform === 'win32' ? ['cmd.exe', '/c', local] : [local];
  }
  return [bun(), 'x', 'electrobun'];
}

function run(command: string[], label: string): void {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'], env });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode ?? 'unknown'}`);
  }
}

if (isMac) {
  run([bun(), 'scripts/build-nod-native.ts'], 'native helper');
  run([bun(), 'scripts/eb-icon.ts'], 'macOS icon set');
}
run([bun(), 'scripts/gen-electrobun-config.ts', 'dev'], 'electrobun config');

const vite = Bun.spawn([bun(), 'run', 'dev'], {
  cwd: ROOT,
  stdio: ['inherit', 'inherit', 'inherit'],
  env,
});

let stopped = false;
function stopVite(): void {
  if (stopped) return;
  stopped = true;
  try {
    vite.kill();
  } catch {
    // already gone
  }
}

process.on('SIGINT', () => {
  stopVite();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stopVite();
  process.exit(143);
});

try {
  const result = Bun.spawnSync([...electrobun(), 'dev', '--env=dev'], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
    env,
  });
  if (result.exitCode !== 0) {
    throw new Error(`electrobun dev failed with exit code ${result.exitCode ?? 'unknown'}`);
  }
  if (isMac) run([bun(), 'scripts/eb-postbuild.ts', '--verify-only'], 'plist/tar verification');
} finally {
  stopVite();
}
