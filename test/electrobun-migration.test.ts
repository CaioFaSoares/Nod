// E07: the Electrobun target resolves the tinyjs data directory, so an installation updated from
// tinyjs keeps its account, preferences and icons. Pure decisions only; the filesystem probe is
// injected.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledIdentifier,
  resolveDataDir,
  tinyjsDataDir,
} from '../electrobun/bun/facade/data-dir';

const HOME = '/Users/test';

describe('tinyjsDataDir', () => {
  test('mirrors the tinyjs runtime per platform', () => {
    expect(tinyjsDataDir('copland.nod', 'darwin', HOME, {})).toBe(
      '/Users/test/Library/Application Support/copland.nod',
    );
    expect(tinyjsDataDir('copland.nod', 'win32', 'C:\\Users\\test', {})).toBe(
      'C:\\Users\\test/AppData/Roaming/copland.nod',
    );
    expect(tinyjsDataDir('copland.nod', 'win32', 'C:\\Users\\test', { APPDATA: 'D:\\data' })).toBe(
      'D:\\data/copland.nod',
    );
    expect(tinyjsDataDir('copland.nod', 'linux', '/home/test', {})).toBe(
      '/home/test/.local/share/copland.nod',
    );
    expect(
      tinyjsDataDir('copland.nod', 'linux', '/home/test', { XDG_DATA_HOME: '/data' }),
    ).toBe('/data/copland.nod');
  });

  test('uses the identifier verbatim, as the runtime does', () => {
    expect(tinyjsDataDir('copland.nod.mig', 'darwin', HOME, {})).toBe(
      '/Users/test/Library/Application Support/copland.nod.mig',
    );
  });
});

describe('resolveDataDir', () => {
  const base = {
    identifier: 'copland.nod',
    electrobunUserData: '/Users/test/Library/Application Support/copland.nod/stable',
    platform: 'darwin' as NodeJS.Platform,
    home: HOME,
    env: {},
  };

  test('the tinyjs directory wins when it holds data', () => {
    const choice = resolveDataDir({
      ...base,
      probe: (dir) => dir === '/Users/test/Library/Application Support/copland.nod',
    });
    expect(choice).toEqual({
      dir: '/Users/test/Library/Application Support/copland.nod',
      source: 'tinyjs',
    });
  });

  test('an Electrobun-only directory is kept when the tinyjs one is empty', () => {
    const choice = resolveDataDir({ ...base, probe: (dir) => dir === base.electrobunUserData });
    expect(choice).toEqual({ dir: base.electrobunUserData, source: 'electrobun' });
  });

  test('a fresh install lands in the tinyjs layout, so a later tinyjs update can read it', () => {
    expect(resolveDataDir({ ...base, probe: () => false })).toEqual({
      dir: '/Users/test/Library/Application Support/copland.nod',
      source: 'tinyjs',
    });
  });

  test('both directories with data: the tinyjs one is the installation being updated', () => {
    const choice = resolveDataDir({ ...base, probe: () => true });
    expect(choice.source).toBe('tinyjs');
  });
});

describe('bundledIdentifier', () => {
  test('reads the identifier hutch wrote beside the executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'nod-eb-id-'));
    try {
      const resources = join(root, 'Resources');
      mkdirSync(resources);
      writeFileSync(
        join(resources, 'version.json'),
        JSON.stringify({ identifier: 'copland.nod', channel: 'stable' }),
      );
      expect(bundledIdentifier(join(root, 'MacOS', 'bun'), 'fallback')).toBe('copland.nod');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back when there is no bundle metadata (a dev run)', () => {
    expect(bundledIdentifier('/tmp/nope/MacOS/bun', 'copland.nod.eb-dev')).toBe(
      'copland.nod.eb-dev',
    );
  });
});
