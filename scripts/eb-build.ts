#!/usr/bin/env bun
// `bun run eb:build` — the release build of every desktop target. Electrobun is the only runtime,
// so this one command replaces the old tinyjs `app:build`.
//
// The steps are the same on every host until the toolchain differs:
//   1. the macOS native helper (`swiftc`, AppKit) — skipped off macOS;
//   2. the macOS icon set (`sips`/`iconutil`) — skipped off macOS, where the PNG is embedded as is;
//   3. the page bundle (`tsc` + vite);
//   4. the generated `electrobun.config.ts`;
//   5. `electrobun build --env=stable` (hutch builds for the host OS/arch);
//   6. macOS only: the plist/tar repair + ad-hoc signature the updater requires.
//
// Windows and Linux builds need no signing step (the project ships unsigned, as before) and the
// generated config already carries their PNG icon. The release workflow runs this once per target.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const isMac = process.platform === 'darwin';

function bun(): string {
  return Bun.which('bun') ?? process.execPath;
}

/** The Electrobun CLI the project is installed with; `bun x` is the last resort. */
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
  const result = Bun.spawnSync(command, { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'], env: process.env });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode ?? 'unknown'}`);
  }
}

const steps: Array<{ label: string; command: string[] }> = [];
if (isMac) {
  steps.push({ label: 'native helper', command: [bun(), 'scripts/build-nod-native.ts'] });
  steps.push({ label: 'macOS icon set', command: [bun(), 'scripts/eb-icon.ts'] });
}
steps.push({ label: 'page bundle', command: [bun(), 'run', 'build'] });
steps.push({
  label: 'electrobun config',
  command: [bun(), 'scripts/gen-electrobun-config.ts', 'build'],
});
steps.push({ label: 'electrobun build', command: [...electrobun(), 'build', '--env=stable'] });
if (isMac) {
  steps.push({
    label: 'plist/tar verification',
    command: [bun(), 'scripts/eb-postbuild.ts', '--verify-only'],
  });
  steps.push({ label: 'ad-hoc signature', command: [bun(), 'scripts/eb-sign.ts'] });
}

for (const step of steps) {
  process.stdout.write(`\n▶ ${step.label}\n`);
  run(step.command, step.label);
}
process.stdout.write('\neb:build complete\n');
