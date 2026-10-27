#!/usr/bin/env bun
// `bun run typecheck` — the app's typechecks, plus the Electrobun project when the devkit exists.
//
// The devkit is projected by `eb:dev`/`eb:build`; a machine that never built cannot typecheck the
// runtime layer. CI must have built first: there the missing devkit is an error, not a skip (the
// release workflow runs `eb:build` before this). A Bun script, not a shell `if`, so Windows works.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const bun = Bun.which('bun') ?? process.execPath;

function run(args: string[], label: string): boolean {
  const result = Bun.spawnSync([bun, ...args], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env,
  });
  if (result.exitCode !== 0) {
    console.error(`typecheck: ${label} failed with exit code ${result.exitCode ?? 'unknown'}`);
    return false;
  }
  return true;
}

if (!run(['run', 'typecheck:app'], 'app')) process.exit(1);

const devkit = join(ROOT, '.hutch', 'devkit', 'tsconfig.json');
if (!existsSync(devkit)) {
  if ((process.env.CI ?? '') !== '') {
    console.error(
      'typecheck: .hutch/devkit/tsconfig.json is missing: in CI the Electrobun devkit must be ' +
        'projected before typechecking — run bun run eb:build in this job, then typecheck',
    );
    process.exit(1);
  }
  console.log(
    'skip electrobun typecheck: .hutch/devkit/tsconfig.json is missing (bun run eb:build projects it)',
  );
  process.exit(0);
}

const result = Bun.spawnSync(
  [bun, 'x', 'tsc', '-p', join(ROOT, 'electrobun', 'tsconfig.json'), '--noEmit'],
  { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'], env: process.env },
);
process.exit(result.exitCode ?? 1);
