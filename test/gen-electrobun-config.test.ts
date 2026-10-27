// Proves the observable behavior of `scripts/gen-electrobun-config.ts` (E06 Electrobun target).
// Run with `bun test test/`.
//
// The pure core is tested here: identifiers, the media-permission refusal, the resource/copy lists
// and the generated module. I/O (reading `app.json`, `validateSeed`, writing the file) is
// the `import.meta.main` block and is exercised by `eb:dev` / `eb:build`, like `gen-electrobun-config.ts`.

import { describe, expect, test } from 'bun:test';
import {
  EB_BRIDGE_ENTRYPOINT,
  EB_ENTRYPOINT,
  EB_ICON_ICONSET,
  EB_IDENTIFIER,
  EB_NATIVE_LIBRARY,
  EB_NATIVE_TARGET,
  EB_POSTPACKAGE,
  ICONSET_IMAGES,
  RELEASE_IDENTIFIER,
  DEV_IDENTIFIER,
  USAGE_KEYS,
  appIdentifier,
  electrobunResources,
  generateElectrobunConfig,
  mediaPermissions,
  releaseBaseUrl,
  renderElectrobunConfig,
  usageGaps,
} from '../scripts/gen-electrobun-config';
import { plistGaps, tarPlistEntry } from '../scripts/eb-plist';
import { MIN_ICON_SIZE } from '../scripts/app-config';
import type { Entry, Seed } from '../shared/types';

const BASE: Record<string, unknown> = {
  name: 'nod',
  title: 'Nod',
  size: '1100x720',
  id: 'copland.nod',
  version: '0.6.0c',
  urlScheme: 'nod',
  frontend: { dist: 'dist', devUrl: 'http://127.0.0.1:5173' },
  permissions: { camera: 'why camera', microphone: 'why microphone' },
};

const SHIM = '/project/electrobun/bun/sqlite-shim.ts';

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

interface Shape {
  app: { name: string; identifier: string; version: string; urlSchemes: string[] };
  build: {
    mainProcess: string;
    bun: { entrypoint: string; alias: Record<string, string> };
    views: Record<string, { entrypoint: string; format: string }>;
    copy: Record<string, string>;
    mac: Record<string, unknown>;
    linux: Record<string, unknown>;
    win: Record<string, unknown>;
  };
  runtime: { exitOnLastWindowClosed: boolean };
  scripts: { postWrap: string; postPackage: string };
  release?: { baseUrl: string };
}

function asShape(config: Record<string, unknown>): Shape {
  return config as unknown as Shape;
}

describe('appIdentifier', () => {
  test('defaults to the device identifier outside a release build', () => {
    expect(appIdentifier(undefined)).toBe(DEV_IDENTIFIER);
    expect(appIdentifier('  ')).toBe(DEV_IDENTIFIER);
    expect(appIdentifier(undefined, 'build')).toBe(EB_IDENTIFIER);
    expect(EB_IDENTIFIER).toBe('copland.nod');
  });

  test('accepts an override (a smoke gets its own app data)', () => {
    expect(appIdentifier('copland.nod.eb-dev')).toBe('copland.nod.eb-dev');
  });

  test('refuses the release id in dev and accepts it in a release build', () => {
    expect(() => appIdentifier(RELEASE_IDENTIFIER)).toThrow(/must not be copland\.nod/);
    expect(() => appIdentifier(RELEASE_IDENTIFIER, 'dev')).toThrow(/must not be copland\.nod/);
    expect(appIdentifier(RELEASE_IDENTIFIER, 'build')).toBe(RELEASE_IDENTIFIER);
  });
});

describe('mediaPermissions', () => {
  test('answers both usage strings', () => {
    expect(mediaPermissions(BASE)).toEqual({
      camera: 'why camera',
      microphone: 'why microphone',
    });
  });

  test('refuses a blank or absent string', () => {
    expect(() =>
      mediaPermissions({ permissions: { camera: 'why', microphone: ' ' } }),
    ).toThrow(/permissions/);
    expect(() => mediaPermissions({})).toThrow(/permissions/);
  });
});

describe('electrobunResources', () => {
  test('build: seed, tray and relative entry icons, without repeats or `..`', () => {
    const resources = electrobunResources(
      seed([
        entry({ id: 'a', icon: 'icons/a.png' }),
        entry({ id: 'b', url: 'https://b.example.com', icon: 'icons/a.png' }),
        entry({ id: 'c', url: 'https://c.example.com', icon: '../outside.png' }),
        entry({ id: 'd', url: 'https://d.example.com', icon: 'data:image/png;base64,AA' }),
      ]),
      'build',
    );

    expect(resources).toEqual(['seed.json', 'tray.png', 'icons/a.png']);
  });

  test('build without a seed ships only the tray icon', () => {
    expect(electrobunResources(null, 'build')).toEqual(['tray.png']);
  });

  test('dev adds the build-mode stamp, which a release never ships', () => {
    expect(electrobunResources(null, 'dev')).toEqual(['tray.png', 'build-mode']);
    expect(electrobunResources(seed([entry()]), 'dev')).toEqual([
      'seed.json',
      'tray.png',
      'build-mode',
    ]);
  });
});

describe('releaseBaseUrl', () => {
  test('drops the tinyjs manifest file, keeps any other URL', () => {
    expect(releaseBaseUrl('https://dl.example.com/nod/manifest.json')).toBe(
      'https://dl.example.com/nod/',
    );
    expect(releaseBaseUrl('https://dl.example.com/nod/')).toBe('https://dl.example.com/nod/');
    expect(releaseBaseUrl('https://dl.example.com/eb')).toBe('https://dl.example.com/eb');
  });
});

describe('app icon (RF-56 parity with tinyjs)', () => {
  test('the iconset names every image iconutil requires, from the 16 up to the 1024 source', () => {
    const files = ICONSET_IMAGES.map((image) => image.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toEqual([
      'icon_16x16.png',
      'icon_16x16@2x.png',
      'icon_32x32.png',
      'icon_32x32@2x.png',
      'icon_128x128.png',
      'icon_128x128@2x.png',
      'icon_256x256.png',
      'icon_256x256@2x.png',
      'icon_512x512.png',
      'icon_512x512@2x.png',
    ]);
    // The generator points macOS at the folder these images go in, never at the PNG.
    expect(EB_ICON_ICONSET.endsWith('.iconset')).toBe(true);
    // The largest entry is exactly the icon size `assertIconPng` guarantees.
    expect(Math.max(...ICONSET_IMAGES.map((image) => image.size))).toBe(MIN_ICON_SIZE);
    expect(ICONSET_IMAGES[ICONSET_IMAGES.length - 1]).toEqual({
      file: 'icon_512x512@2x.png',
      size: 1024,
    });
  });

  test('no resolved icon leaves every icon key to Electrobun, like tinyjs with no icon', () => {
    for (const icon of [undefined, null]) {
      const config = asShape(
        generateElectrobunConfig(BASE, null, 'build', { sqliteShim: SHIM, icon }),
      );
      expect('icons' in config.build.mac).toBe(false);
      expect('icon' in config.build.win).toBe(false);
      expect('icon' in config.build.linux).toBe(false);
    }
  });

  test('the resolved PNG is the win/linux icon and macOS names the iconset written from it', () => {
    const privateIcon = asShape(
      generateElectrobunConfig(BASE, null, 'build', {
        sqliteShim: SHIM,
        icon: 'resources/icon.png',
      }),
    );
    expect(privateIcon.build.mac.icons).toBe(EB_ICON_ICONSET);
    expect(privateIcon.build.win.icon).toBe('resources/icon.png');
    expect(privateIcon.build.linux.icon).toBe('resources/icon.png');
    // The devkit's keys exactly: macOS has no `icon` (only the `.iconset`), win/linux have no `icons`.
    expect('icon' in privateIcon.build.mac).toBe(false);
    expect('icons' in privateIcon.build.win).toBe(false);
    expect('icons' in privateIcon.build.linux).toBe(false);
    // CEF stays off: a bundled Chromium would dwarf an icon change.
    expect(privateIcon.build.mac.bundleCEF).toBe(false);
    expect(privateIcon.build.win.bundleCEF).toBe(false);
    expect(privateIcon.build.linux.bundleCEF).toBe(false);

    // `NOD_ICON` resolves to the staged copy (`iconConfigPath('env')`), which is what the build names.
    const envIcon = asShape(
      generateElectrobunConfig(BASE, null, 'dev', { sqliteShim: SHIM, icon: '.nod-icon.png' }),
    );
    expect(envIcon.build.mac.icons).toBe(EB_ICON_ICONSET);
    expect(envIcon.build.win.icon).toBe('.nod-icon.png');
    expect(envIcon.build.linux.icon).toBe('.nod-icon.png');
  });

  test('the 256px Windows icon overrides the source PNG', () => {
    const config = asShape(
      generateElectrobunConfig(BASE, null, 'build', {
        sqliteShim: SHIM,
        icon: 'assets/icon.png',
        winIcon: '.eb-icon-256.png',
      }),
    );
    expect(config.build.win.icon).toBe('.eb-icon-256.png');
    expect(config.build.linux.icon).toBe('.eb-icon-256.png');
    expect(config.build.mac.icons).toBe(EB_ICON_ICONSET);
  });

  test('dev wears the same icon as build', () => {
    const dev = asShape(
      generateElectrobunConfig(BASE, null, 'dev', {
        sqliteShim: SHIM,
        icon: 'assets/icon.png',
      }),
    );
    expect(dev.build.mac.icons).toBe(EB_ICON_ICONSET);
    expect(dev.build.win.icon).toBe('assets/icon.png');
  });
});

describe('generateElectrobunConfig', () => {
  test('build: identity, URL scheme, version and the generated file shape', () => {
    const config = asShape(
      generateElectrobunConfig(BASE, null, 'build', { sqliteShim: SHIM }),
    );

    expect(config.app.name).toBe('Nod');
    expect(config.app.identifier).toBe('copland.nod');
    expect(config.app.version).toBe('0.6.0c');
    expect(config.app.urlSchemes).toEqual(['nod']);
    expect(config.build.mainProcess).toBe('bun');
    expect(config.build.bun.entrypoint).toBe(EB_ENTRYPOINT);
    expect(config.build.bun.alias).toEqual({ 'tjs:sqlite': SHIM });
    expect(config.build.views.bridge.entrypoint).toBe(EB_BRIDGE_ENTRYPOINT);
    expect(config.build.views.bridge.format).toBe('iife');
    expect(config.scripts.postWrap).toBe('scripts/eb-postwrap.ts');
    expect(config.scripts.postPackage).toBe(EB_POSTPACKAGE);
    expect(config.runtime.exitOnLastWindowClosed).toBe(false);
  });

  test('build: the vite dist is the main view, and resources follow the tinyjs list', () => {
    const config = asShape(
      generateElectrobunConfig(BASE, seed([entry()]), 'build', { sqliteShim: SHIM }),
    );

    expect(config.build.copy.dist).toBe('views/mainview');
    expect(config.build.copy['resources/seed.json']).toBe('resources/seed.json');
    expect(config.build.copy['resources/tray.png']).toBe('resources/tray.png');
    expect('resources/build-mode' in config.build.copy).toBe(false);
  });

  test('dev: no dist copy, but the stamp travels (the runtime reads it)', () => {
    const config = asShape(
      generateElectrobunConfig(BASE, null, 'dev', { sqliteShim: SHIM }),
    );

    expect('dist' in config.build.copy).toBe(false);
    expect(config.build.copy['resources/build-mode']).toBe('resources/build-mode');
  });

  test('build refuses to generate without the camera/microphone strings (same rule as gen-config)', () => {
    expect(() =>
      generateElectrobunConfig({ ...BASE, permissions: undefined }, null, 'build', {
        sqliteShim: SHIM,
      }),
    ).toThrow(/permissions/);
    // `dev` mirrors gen-config: the refusal is a build rule.
    expect(() =>
      generateElectrobunConfig({ ...BASE, permissions: undefined }, null, 'dev', {
        sqliteShim: SHIM,
      }),
    ).not.toThrow();
  });

  test('the native helper is staged only when it was built', () => {
    const without = asShape(
      generateElectrobunConfig(BASE, null, 'build', { sqliteShim: SHIM }),
    );
    expect(EB_NATIVE_LIBRARY in without.build.copy).toBe(false);

    const withHelper = asShape(
      generateElectrobunConfig(BASE, null, 'build', {
        sqliteShim: SHIM,
        nativeLibrary: true,
      }),
    );
    expect(withHelper.build.copy[EB_NATIVE_LIBRARY]).toBe(EB_NATIVE_TARGET);
  });

  test('the seed update URL becomes the release base URL; no seed leaves it out', () => {
    const withUpdate = asShape(
      generateElectrobunConfig(
        BASE,
        seed([entry()], { update: { url: 'https://dl.example.com/nod/manifest.json' } }),
        'build',
        { sqliteShim: SHIM },
      ),
    );
    expect(withUpdate.release).toEqual({
      baseUrl: 'https://dl.example.com/nod/',
      generatePatch: false,
    });

    const without = asShape(
      generateElectrobunConfig(BASE, null, 'build', { sqliteShim: SHIM }),
    );
    expect(without.release).toBeUndefined();
  });

  test('NOD_APP_ID overrides the identifier in the generated config', () => {
    const config = asShape(
      generateElectrobunConfig(BASE, null, 'dev', {
        sqliteShim: SHIM,
        appId: 'copland.nod.eb-dev',
      }),
    );
    expect(config.app.identifier).toBe('copland.nod.eb-dev');
  });

  test('render: deterministic module with the config literal', () => {
    const config = generateElectrobunConfig(BASE, null, 'build', { sqliteShim: SHIM });
    const source = renderElectrobunConfig(config);

    expect(source).toBe(renderElectrobunConfig(config));
    expect(source).toContain('import type { ElectrobunConfig } from "electrobun";');
    expect(source).toContain('satisfies ElectrobunConfig');
    expect(source).toContain('"identifier": "copland.nod"');
    expect(source).toContain('"urlSchemes": [\n      "nod"\n    ]');
  });
});

describe('usage descriptions in the plist (E06 §13)', () => {
  const CAMERA = 'why camera';
  const MICROPHONE = 'why microphone';
  const expected = { camera: CAMERA, microphone: MICROPHONE } as const;

  test('usageGaps is empty only when both sentences match exactly', () => {
    expect(
      usageGaps(
        { [USAGE_KEYS.camera]: CAMERA, [USAGE_KEYS.microphone]: MICROPHONE },
        expected,
      ),
    ).toEqual([]);
  });

  test('usageGaps names every absent or stale key', () => {
    expect(usageGaps({}, expected)).toEqual([
      USAGE_KEYS.camera,
      USAGE_KEYS.microphone,
    ]);
    expect(
      usageGaps(
        { [USAGE_KEYS.camera]: CAMERA, [USAGE_KEYS.microphone]: 'stale' },
        expected,
      ),
    ).toEqual([USAGE_KEYS.microphone]);
    expect(
      usageGaps(
        { [USAGE_KEYS.camera]: `${CAMERA}\n`, [USAGE_KEYS.microphone]: null },
        expected,
      ),
    ).toEqual([USAGE_KEYS.camera, USAGE_KEYS.microphone]);
  });

  test('plistGaps accepts what plutil emits as JSON and rejects non-strings', () => {
    expect(
      plistGaps(
        {
          CFBundleIdentifier: 'copland.nod.eb-dev',
          [USAGE_KEYS.camera]: CAMERA,
          [USAGE_KEYS.microphone]: MICROPHONE,
        },
        expected,
      ),
    ).toEqual([]);
    expect(
      plistGaps({ [USAGE_KEYS.camera]: 1, [USAGE_KEYS.microphone]: MICROPHONE }, expected),
    ).toEqual([USAGE_KEYS.camera]);
    expect(plistGaps({ CFBundleIdentifier: 'x' }, expected)).toEqual([
      USAGE_KEYS.camera,
      USAGE_KEYS.microphone,
    ]);
  });

  test('tarPlistEntry finds the one app plist a hutch payload tar carries', () => {
    expect(
      tarPlistEntry([
        'Nod.app/',
        'Nod.app/Contents/',
        'Nod.app/Contents/Info.plist',
        'Nod.app/Contents/MacOS/bun',
      ]),
    ).toBe('Nod.app/Contents/Info.plist');
    expect(tarPlistEntry(['./Nod.app/Contents/Info.plist'])).toBe('Nod.app/Contents/Info.plist');
    // No app plist (a delta patch) and more than one app (never one of ours) are both `null`.
    expect(tarPlistEntry(['patch/', 'patch/old', 'patch/new'])).toBeNull();
    expect(
      tarPlistEntry(['A.app/Contents/Info.plist', 'B.app/Contents/Info.plist']),
    ).toBeNull();
    expect(tarPlistEntry(['Nod.app/Contents/Info.plist.bak'])).toBeNull();
  });
});
