// Re-signs the packaged Electrobun bundle ad hoc after `scripts/eb-postbuild.ts` patched its
// `Info.plist`. hutch signs the wrapper before `postWrap`/`postPackage` run, so the patch leaves a
// bundle whose signature no longer covers its own plist: `codesign --verify --strict --deep` fails
// with `code has no resources but signature indicates they must be present`, and the tinyjs updater
// refuses such an artifact (`~/.tinyjs/runtime/update.js` installUpdate).
//
// This is the last step of `eb:build`. It signs every `build/stable-macos-*/Nod.app` in place with
// the ad-hoc identity the rest of the release uses (`-`), then verifies it with the exact flags the
// updater runs. A verification failure exits nonzero, so a release job stops instead of publishing
// an artifact no tinyjs installation can install.
//
// Usage: `bun scripts/eb-sign.ts` (from the repository root, after `electrobun build`).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const buildDir = join(root, 'build');

function run(argv: string[]): { ok: boolean; detail: string } {
  const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
  const detail = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  return { ok: result.exitCode === 0, detail };
}

let entries: string[] = [];
try {
  entries = readdirSync(buildDir);
} catch {
  console.error('eb-sign: build/ does not exist — run `eb:build` (or `electrobun build`) first');
  process.exit(1);
}

const bundles = entries
  .filter((name) => name.startsWith('stable-macos-'))
  .map((name) => join(buildDir, name, 'Nod.app'))
  .filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });

if (bundles.length === 0) {
  console.error('eb-sign: no build/stable-macos-*/Nod.app to sign');
  process.exit(1);
}

for (const bundle of bundles) {
  const signed = run(['codesign', '--force', '--deep', '--sign', '-', bundle]);
  if (!signed.ok) {
    console.error(`eb-sign: codesign failed on ${bundle}\n${signed.detail}`);
    process.exit(1);
  }
  const verified = run(['codesign', '--verify', '--strict', '--deep', bundle]);
  if (!verified.ok) {
    console.error(`eb-sign: ${bundle} still fails codesign --verify --strict --deep\n${verified.detail}`);
    process.exit(1);
  }
  console.log(`eb-sign: ${bundle} ad-hoc signed and verified`);
}
