#!/usr/bin/env bun
// Generates the per-platform icon files the Electrobun build reads:
//
//   - `.eb-icon-256.png` — Windows embeds an icon whose PNG must be square and at most 256 px;
//     Hutch's `icoFromPng` refuses anything larger (`PngTooLarge`). Linux uses the same PNG.
//   - `.eb-icon.iconset/` — macOS takes an `.iconset` folder (`build.mac.icons`) and Hutch turns it
//     into the bundle's `.icns` with `iconutil` (a bare PNG is not a macOS icon key).
//
// The source is the PNG the release wears: `iconForConfig` from `scripts/app-config.ts` resolves it
// (`NOD_ICON`, else `resources/icon.png`, else `assets/icon.png`), stages a `NOD_ICON` file as
// `.nod-icon.png`, and refuses anything smaller than 1024×1024.
//
// Run by `eb:dev` / `eb:build` on every host, before the Electrobun CLI. The 256 PNG is produced
// with the platform's own tool: `sips` on macOS, `System.Drawing` on Windows, ImageMagick/ffmpeg on
// Linux (the release workflow installs ImageMagick).
//
// Usage: bun scripts/eb-icon.ts

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WINDOWS_ICON, iconForConfig } from './app-config';
import { EB_ICON_ICONSET, ICONSET_IMAGES } from './gen-electrobun-config';

const WINDOWS_ICON_SIZE = 256;

function run(command: string[], label = command[0]): void {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${label} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`);
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

/** One PowerShell single-quoted literal; Windows paths never contain a quote in practice. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Downscales `sourcePng` to a square `size` PNG at `<rootDir>/<output>`. */
export function resizePng(
  rootDir: string,
  sourcePng: string,
  output: string,
  size = WINDOWS_ICON_SIZE,
): string {
  const source = join(rootDir, sourcePng);
  const target = join(rootDir, output);
  rmSync(target, { force: true });

  if (process.platform === 'darwin') {
    run(['sips', '-z', `${size}`, `${size}`, source, '--out', target], 'sips');
    return target;
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      `$src = [System.Drawing.Image]::FromFile(${psQuote(source)})`,
      `$dst = New-Object System.Drawing.Bitmap ${size},${size}`,
      '$g = [System.Drawing.Graphics]::FromImage($dst)',
      '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
      `$g.DrawImage($src, 0, 0, ${size}, ${size})`,
      `$dst.Save(${psQuote(target)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose()',
      '$dst.Dispose()',
      '$src.Dispose()',
    ].join('; ');
    run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      'PowerShell System.Drawing',
    );
    return target;
  }

  const convert = Bun.which('convert');
  if (convert !== null) {
    run([convert, source, '-resize', `${size}x${size}!`, target], 'ImageMagick convert');
    return target;
  }
  const magick = Bun.which('magick');
  if (magick !== null) {
    run([magick, source, '-resize', `${size}x${size}!`, target], 'ImageMagick magick');
    return target;
  }
  const ffmpeg = Bun.which('ffmpeg');
  if (ffmpeg !== null) {
    run(
      [ffmpeg, '-y', '-i', source, '-vf', `scale=${size}:${size}`, '-frames:v', '1', target],
      'ffmpeg',
    );
    return target;
  }
  throw new Error(
    `no PNG resizer for ${process.platform}: install ImageMagick (convert) or ffmpeg to build the ${size}px Windows icon`,
  );
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const iconset = join(root, EB_ICON_ICONSET);
  const windowsIcon = join(root, WINDOWS_ICON);
  try {
    const icon = await iconForConfig(root);
    if (icon === null) {
      rmSync(iconset, { recursive: true, force: true });
      rmSync(windowsIcon, { force: true });
      console.log('eb-icon: no app icon; Electrobun keeps its default');
    } else {
      resizePng(root, icon, WINDOWS_ICON);
      console.log(`eb-icon: ${WINDOWS_ICON} (${WINDOWS_ICON_SIZE}px) from ${icon}`);
      if (process.platform === 'darwin') {
        buildIconset(root, icon);
        console.log(`eb-icon: ${EB_ICON_ICONSET} from ${icon}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
