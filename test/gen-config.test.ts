// Proves the observable behavior of `scripts/gen-config.ts` (v2 release config slice).
// Contract: docs/arquitetura.md §2 (origin gate) and §6 (build and dev); requirements:
// docs/canonico.md §19, RF-26, RF-27.
// Run with `bun test test/`.

import { describe, expect, test } from 'bun:test';
import { generateConfig } from '../scripts/gen-config';
import { validateSeed } from '../shared/catalog';
import type { Entry, Seed } from '../shared/types';

const BASE: Record<string, unknown> = {
  name: 'bond',
  title: 'Bond',
  id: 'studio.copland.bond',
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
    expect(config.name).toBe('bond');
    expect(config.id).toBe('studio.copland.bond');
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
      seed([], { update: { url: 'https://releases.example.com/bond' } }),
      'build',
    );

    expect(config.update).toEqual({ url: 'https://releases.example.com/bond', auto: 'daily' });
  });

  test('appId replaces the base id', () => {
    expect(generateConfig(BASE, null, 'dev', 'com.example.bond.smoke').id).toBe(
      'com.example.bond.smoke',
    );
    expect(generateConfig(BASE, null, 'dev').id).toBe('studio.copland.bond');
  });
});
