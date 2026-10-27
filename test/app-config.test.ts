// Proves the observable behavior of `scripts/app-config.ts` — the app icon resolution shared by
// every build (RF-56). Run with `bun test test/`.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ICON,
  PRIVATE_ICON,
  STAGED_ICON,
  assertIconPng,
  iconConfigPath,
  iconSource,
} from '../scripts/app-config';

describe('app icon (RF-56)', () => {
  test('precedence: NOD_ICON, then resources/icon.png, then assets/icon.png', () => {
    expect(iconSource('/tmp/other.png', true, true)).toBe('env');
    expect(iconSource('', true, true)).toBe('private');
    expect(iconSource('', false, true)).toBe('default');
    expect(iconSource('', false, false)).toBe('none');
  });

  test('the config names the source file, and the staged copy for NOD_ICON', () => {
    expect(iconConfigPath('env')).toBe(STAGED_ICON);
    expect(iconConfigPath('private')).toBe(PRIVATE_ICON);
    expect(iconConfigPath('default')).toBe(DEFAULT_ICON);
    expect(iconConfigPath('none')).toBeNull();
  });

  test('the tracked default passes the icon check', async () => {
    const bytes = new Uint8Array(
      await Bun.file(new URL('../assets/icon.png', import.meta.url)).arrayBuffer(),
    );

    expect(() => assertIconPng(bytes, DEFAULT_ICON)).not.toThrow();
  });

  test('a PNG smaller than the icon size is refused, naming the size', async () => {
    const bytes = new Uint8Array(
      await Bun.file(new URL('../resources/tray.png', import.meta.url)).arrayBuffer(),
    );

    expect(() => assertIconPng(bytes, 'resources/tray.png')).toThrow('32x32');
    expect(() => assertIconPng(bytes, 'resources/tray.png')).toThrow('1024x1024');
  });

  test('a file that is not a PNG is refused, whole or truncated', async () => {
    const bytes = new Uint8Array(
      await Bun.file(new URL('../app.json', import.meta.url)).arrayBuffer(),
    );

    expect(() => assertIconPng(bytes, 'app.json')).toThrow('is not a PNG');
    expect(() => assertIconPng(new Uint8Array(0), 'empty.png')).toThrow('is not a PNG');
    expect(() => assertIconPng(bytes.subarray(0, 8), 'truncated.png')).toThrow('is not a PNG');
    // Right signature, wrong first chunk: a PNG file with a GIF header inside.
    const notIhdr = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x47, 0x49, 0x46, 0x38, 0, 0, 4,
      0, 0, 0, 4, 0,
    ]);
    expect(() => assertIconPng(notIhdr, 'not-ihdr.png')).toThrow('is not a PNG');
  });
});
