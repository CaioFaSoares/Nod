// Proves the observable behavior of `scripts/gen-config.ts` (v2 release config slice).
// Contract: docs/arquitetura.md §2 (origin gate) and §6 (build and dev); requirements:
// docs/canonico.md §19, RF-26, RF-27, RF-56.
// Run with `bun test test/`.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ICON,
  PRIVATE_ICON,
  STAGED_ICON,
  assertIconPng,
  generateConfig,
  iconConfigPath,
  iconSource,
} from '../scripts/gen-config';
import { validateSeed } from '../shared/catalog';
import type { Entry, Seed } from '../shared/types';

const BASE: Record<string, unknown> = {
  name: 'nod',
  title: 'Nod',
  id: 'copland.nod',
  version: '0.1.0',
  frontend: { dist: 'dist', devUrl: 'http://127.0.0.1:5173' },
  permissions: { camera: 'why camera', microphone: 'why microphone' },
};

const TOOL = ['login.report', 'media.camera', 'media.microphone'];

async function exampleSeed(): Promise<Seed> {
  const url = new URL('../resources/seed.example.json', import.meta.url);
  return validateSeed(JSON.parse(await Bun.file(url).text()));
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'kanban',
    title: 'Kanban',
    url: 'https://kanban.example.com',
    icon: null,
    order: 10,
    roles: ['team'],
    views: [],
    auth: null,
    active: true,
    ...over,
  };
}

function seed(entries: Entry[], over: Partial<Seed> = {}): Seed {
  return {
    version: 1,
    generatedAt: '2026-10-15T00:00:00.000Z',
    roles: [],
    entries,
    invites: [],
    update: null,
    ...over,
  };
}

function hasOrigins(v: unknown): v is { origins: Record<string, unknown> } {
  return (
    v !== null &&
    typeof v === 'object' &&
    'origins' in v &&
    v.origins !== null &&
    typeof v.origins === 'object'
  );
}

function origins(config: Record<string, unknown>): Record<string, unknown> {
  if (!hasOrigins(config.api)) throw new Error('config has no api.origins');
  return config.api.origins;
}

describe('generateConfig', () => {
  test('build: exact gate per entry origin, no dev origin', async () => {
    const config = generateConfig(BASE, await exampleSeed(), 'build');
    const o = origins(config);

    expect(o['file://*']).toBe('all');
    expect(o['https://kanban.example.com']).toEqual(TOOL);
    expect(o['https://docs.example.com']).toEqual(TOOL);
    expect(Object.keys(o).sort()).toEqual([
      'file://*',
      'https://docs.example.com',
      'https://kanban.example.com',
    ]);
    expect('http://127.0.0.1:5173' in o).toBe(false);
  });

  test('build: bundles the seed and the tray icon, keeping the other base keys', async () => {
    const config = generateConfig(BASE, await exampleSeed(), 'build');

    expect(config.resources).toEqual(['seed.json', 'tray.png']);
    expect(config.name).toBe('nod');
    expect(config.id).toBe('copland.nod');
    expect(config.frontend).toEqual(BASE.frontend);
    expect(config.update).toBeUndefined();
  });

  test('build: relative icons join resources, without `..` or repetition', () => {
    const config = generateConfig(
      BASE,
      seed([
        entry({ id: 'a', icon: 'icons/a.png' }),
        entry({ id: 'b', url: 'https://b.example.com', icon: 'icons/a.png' }),
        entry({ id: 'c', url: 'https://c.example.com', icon: '../outside.png' }),
        entry({ id: 'd', url: 'https://d.example.com', icon: 'data:image/png;base64,AA' }),
      ]),
      'build',
    );

    expect(config.resources).toEqual(['seed.json', 'tray.png', 'icons/a.png']);
  });

  test('build without a seed fails with the RF-26 message', () => {
    expect(() => generateConfig(BASE, null, 'build')).toThrow(
      'private seed missing: resources/seed.json (see resources/seed.example.json)',
    );
  });

  test('build without camera and microphone usage strings fails (macOS kills the app)', async () => {
    const s = await exampleSeed();
    const { permissions: _, ...bare } = BASE;
    expect(() => generateConfig(bare, s, 'build')).toThrow('permissions');
    expect(() => generateConfig({ ...BASE, permissions: { camera: 'x' } }, s, 'build')).toThrow(
      'permissions',
    );
    expect(() => generateConfig({ ...BASE, permissions: { camera: ' ', microphone: 'x' } }, s, 'build')).toThrow(
      'permissions',
    );
    expect(generateConfig(BASE, s, 'build').permissions).toEqual(BASE.permissions);
  });

  test('the real tinyjs.base.json builds with camera and microphone usage strings', async () => {
    const base = JSON.parse(await Bun.file(new URL('../tinyjs.base.json', import.meta.url)).text());
    const config = generateConfig(base, await exampleSeed(), 'build');
    expect(config.permissions).toEqual({ camera: expect.any(String), microphone: expect.any(String) });
  });

  test('dev without a seed releases only the app pages', () => {
    const config = generateConfig(BASE, null, 'dev');

    expect(origins(config)).toEqual({ 'file://*': 'all', 'http://127.0.0.1:5173': 'all' });
    expect(config.resources).toBeUndefined();
  });

  test('dev with a seed adds the entry gate to the page gate', async () => {
    const o = origins(generateConfig(BASE, await exampleSeed(), 'dev'));

    expect(o['http://127.0.0.1:5173']).toBe('all');
    expect(o['https://kanban.example.com']).toEqual(TOOL);
  });

  test('dev on another port moves the page gate and the dev url together', () => {
    const config = generateConfig(BASE, null, 'dev', undefined, 5199);
    const o = origins(config);

    expect(o['http://127.0.0.1:5199']).toBe('all');
    expect('http://127.0.0.1:5173' in o).toBe(false);
    expect(Object.keys(o).sort()).toEqual(['file://*', 'http://127.0.0.1:5199']);
    expect(config.frontend).toEqual({ dist: 'dist', devUrl: 'http://127.0.0.1:5199' });
  });

  test('two entries on the same origin share one key', () => {
    const config = generateConfig(
      BASE,
      seed([
        entry({ id: 'a', url: 'https://x.example.com' }),
        entry({ id: 'b', url: 'https://x.example.com/v2' }),
      ]),
      'build',
    );

    expect(origins(config)['https://x.example.com']).toEqual(TOOL);
    expect(Object.keys(origins(config)).sort()).toEqual(['file://*', 'https://x.example.com']);
  });

  test('a wildcard origin never becomes a tool key (D4)', () => {
    // Built by hand: `validateSeed` never lets a wildcard through, so the seed object here bypasses
    // it. Either the address check or the generator's own guard must refuse the gate.
    const wildcard = seed([entry({ url: 'https://*.example.com' })]);

    expect(() => generateConfig(BASE, wildcard, 'build')).toThrow();
  });

  test('seed update turns on the daily update', () => {
    const config = generateConfig(
      BASE,
      seed([], { update: { url: 'https://releases.example.com/nod' } }),
      'build',
    );

    expect(config.update).toEqual({ url: 'https://releases.example.com/nod', auto: 'daily' });
  });

  test('appId replaces the base id', () => {
    expect(generateConfig(BASE, null, 'dev', 'com.example.nod.smoke').id).toBe(
      'com.example.nod.smoke',
    );
    expect(generateConfig(BASE, null, 'dev').id).toBe('copland.nod');
  });
});

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

  test('generateConfig carries the icon; without one the key stays out', async () => {
    const built = generateConfig(
      BASE,
      await exampleSeed(),
      'build',
      undefined,
      undefined,
      PRIVATE_ICON,
    );
    expect(built.icon).toBe(PRIVATE_ICON);
    expect(generateConfig(BASE, null, 'dev', undefined, undefined, STAGED_ICON).icon).toBe(
      STAGED_ICON,
    );
    // tinyjs' own resolution is left alone: `assets/icon.png` defaults to `icon.png` at the root.
    expect(generateConfig(BASE, null, 'dev').icon).toBeUndefined();
    expect(generateConfig(BASE, await exampleSeed(), 'build').icon).toBeUndefined();
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
      await Bun.file(new URL('../tinyjs.base.json', import.meta.url)).arrayBuffer(),
    );

    expect(() => assertIconPng(bytes, 'tinyjs.base.json')).toThrow('is not a PNG');
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
