#!/usr/bin/env bun
// Writes the macOS `.iconset` the Electrobun build packs as the app icon: `build.mac.icons` names
// the folder and hutch turns it into the bundle's `.icns` with `iconutil` (a bare PNG is not a macOS
// icon key). Run by `eb:dev` / `eb:build` before the Electrobun CLI, the way
// `scripts/build-nod-native.ts` compiles the native helper.
//
// The source is the very PNG the tinyjs build wears: `iconForConfig` from `scripts/gen-config.ts`
// resolves it (`NOD_ICON`, else `resources/icon.png`, else `assets/icon.png`), stages a `NOD_ICON`
// file as `.nod-icon.png`, and refuses anything that is not a ≥1024×1024 PNG. Nothing is copied or
// re-derived here — one precedence, one check, two targets.
//
// With no icon at all no folder is written and the generated config names no icon key, so Electrobun
// keeps its own default (the same outcome as tinyjs with `icon: null`).
//
// Usage: bun scripts/eb-icon.ts
//
// sips is macOS-only; on another host this exits 0 with a warning, because Electrobun's macOS
// artifacts are built on macOS (the rule `build-nod-native.ts` keeps for swiftc).
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { iconForConfig } from './gen-config';
import { EB_ICON_ICONSET, ICONSET_IMAGES } from './gen-electrobun-config';

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`${command[0]} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Rebuilds `<rootDir>/<EB_ICON_ICONSET>` from `sourcePng` (project-relative) and returns the folder.
 * Every image is downscaled from the one source: the iconset holds exactly what `iconutil` asks for,
 * so a stale size can never survive from an earlier icon.
 */
export function buildIconset(rootDir: string, sourcePng: string): string {
  const iconset = join(rootDir, EB_ICON_ICONSET);
  const source = join(rootDir, sourcePng);
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const image of ICONSET_IMAGES) {
    run(['sips', '-z', `${image.size}`, `${image.size}`, source, '--out', join(iconset, image.file)]);
  }
  return iconset;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const iconset = join(root, EB_ICON_ICONSET);
  try {
    const icon = await iconForConfig(root);
    if (icon === null) {
      rmSync(iconset, { recursive: true, force: true });
      console.log('eb-icon: no app icon; Electrobun keeps its default (same as tinyjs)');
    } else if (process.platform !== 'darwin') {
      console.warn(`eb-icon: skipped (sips is macOS-only; host is ${process.platform})`);
    } else {
      buildIconset(root, icon);
      console.log(`eb-icon: ${EB_ICON_ICONSET} from ${icon}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
