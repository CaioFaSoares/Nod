// One command for every gate the Nod has (`package.json` "validate"):
//
//   bun run validate            # fast half: typecheck, unit tests, build
//   bun run validate --smoke    # + the real-surface smokes (Electrobun)
//
// Why: the checks lived in four package scripts and four smoke runners, and running them one by
// one (or forgetting one) cost more than the work. This script is only orchestration: every step
// is the same command a person would type, run in the same order, one summary at the end, non-zero
// exit if anything failed. Nothing here is a test of its own.
//
// `--smoke` opens real windows on the machine for ~4 minutes (the smokes drive the real app) and
// moves `resources/seed.json` aside (each runner restores it); the smoke half is skipped, with a
// line saying so, when the devkit is not installed (`.hutch/devkit/tsconfig.json`).
// The smokes run sequentially on purpose: they share loopback ports, the screen and the seed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface Step {
  name: string;
  cwd?: string;
  command: string[];
  /** shown instead of the command in the summary when it is long boilerplate */
  note?: string;
}

const ROOT = import.meta.dir + '/..';
const smokes = process.argv.includes('--smoke');
const devkit = existsSync(join(ROOT, '.hutch/devkit/tsconfig.json'));

const fast: Step[] = [
  { name: 'typecheck (src, backend, host, electrobun)', command: ['bun', 'run', 'typecheck'] },
  { name: 'unit tests (test/)', command: ['bun', 'test', 'test/'] },
  { name: 'unit tests (host/)', command: ['bun', 'test'], cwd: 'host' },
  { name: 'build (tsc + vite)', command: ['bun', 'run', 'build'] },
];

const smokeSuites = ['run', 'ui', 'connected', 'tabs'] as const;
const smoke: Step[] = [];
if (devkit) {
  for (const suite of smokeSuites) {
    smoke.push({
      name: `smoke ${suite} (electrobun)`,
      command: ['bun', `test/smoke/${suite}.ts`, '--force'],
      note: 'the real app under Electrobun',
    });
  }
}

const steps = smokes ? [...fast, ...smoke] : fast;

// A smoke cannot run beside another launch: `electrobun dev` waits on the project build lock and
// the runners share loopback ports. A launch left behind by an interrupted run (or a developer's
// own `eb:dev`/`app:dev`) used to surface as minutes of timeouts; here it stops the run at once.
if (smokes && process.platform !== 'win32') {
  const busy = spawnSync('pgrep', ['-fl', 'electrobun dev|hutch-engine|Nod-dev.app/Contents/MacOS'], {
    encoding: 'utf8',
  });
  const lines = (busy.stdout ?? '').split('\n').filter((line) => line.trim() !== '');
  if (lines.length > 0) {
    process.stderr.write(
      `another Nod dev launch is running; stop it before --smoke:\n${lines.map((line) => `  ${line}`).join('\n')}\n`,
    );
    process.exit(1);
  }
}
const results: Array<{ name: string; ok: boolean; ms: number }> = [];

process.stdout.write(`nod validate — ${steps.length} step(s)${smokes ? ', smokes included' : ''}\n\n`);

let failed = 0;
for (const step of steps) {
  const started = Date.now();
  process.stdout.write(`▶ ${step.name} …\n`);
  const run = spawnSync(step.command[0], step.command.slice(1), {
    cwd: step.cwd === undefined ? ROOT : join(ROOT, step.cwd),
    stdio: 'inherit',
    env: { ...process.env },
  });
  const ms = Date.now() - started;
  const ok = run.status === 0;
  results.push({ name: step.name, ok, ms });
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'ok ' : 'FAIL'}  ${step.name} (${(ms / 1000).toFixed(1)} s)\n\n`);
}

if (smokes && !devkit) {
  process.stdout.write('skip  the smokes: .hutch/devkit is not installed (bun run eb:dev installs it)\n\n');
}

process.stdout.write('summary\n');
for (const result of results) {
  process.stdout.write(`  ${result.ok ? 'ok ' : 'FAIL'}  ${result.name} — ${(result.ms / 1000).toFixed(1)} s\n`);
}
const total = results.reduce((sum, result) => sum + result.ms, 0);
process.stdout.write(`\n${results.length - failed}/${results.length} passed, ${(total / 1000).toFixed(1)} s total\n`);

process.exit(failed === 0 ? 0 : 1);
