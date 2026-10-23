// E06: the composed `TinyApp` covers every member `backend/` actually touches.
//
// The inventory (`docs/handovers/e06-tinyjs-surface.md`) missed `app.clipboard`: `vault.copy`
// (backend/main.ts:3535) writes the revealed secret to the native clipboard, and the first parity
// smoke found the facade without it. This test is the guard against the next omission: a static
// list of every member reached from `backend/` (grep of `app.*`, `required(runtime, …).*`,
// `runtime.*` and the hooks' `app` parameter), checked against the object `createApp` returns.
//
// Clipboard semantics are pinned too: the backend calls `write({ text })` and awaits it, so text is
// the path that must work over the devkit's `Utils.clipboardWriteText`.

import { describe, expect, test } from 'bun:test';
import {
  createApp,
  type AppDeps,
  type AppNative,
  type AppUpdate,
  type AppWindows,
  type RuntimeBindings,
  type TrayCreateSpec,
} from '../electrobun/bun/facade/app';
import type { TrayIconSpec } from '../electrobun/bun/facade/tray-icon';

/** Where each member is reached from in `backend/` (comments are the grep anchors). */
const BACKEND_USED_SURFACE: ReadonlyArray<{ path: string; kind: 'function' | 'object' }> = [
  // backend/main.ts:205 — paths().data/resources; hooks and boot read them once.
  { path: 'paths', kind: 'function' },
  // backend/main.ts:238 — info().version (O2 minAppVersion).
  { path: 'info', kind: 'function' },
  // backend/main.ts:226/227 — capabilities()/os(), host.ts:1721 system.info().arch.
  { path: 'system', kind: 'object' },
  { path: 'system.os', kind: 'function' },
  { path: 'system.capabilities', kind: 'function' },
  { path: 'system.info', kind: 'function' },
  // backend/main.ts:271 — guild icon / bundle icon ('' resets).
  { path: 'icon', kind: 'function' },
  // backend/main.ts:281 / 1350 / 3890 — preferences, dismissed update.
  { path: 'store', kind: 'object' },
  { path: 'store.get', kind: 'function' },
  { path: 'store.set', kind: 'function' },
  // backend/main.ts:286/3365 — sealed keychain items, legacy import, revoke.
  { path: 'secrets', kind: 'object' },
  { path: 'secrets.get', kind: 'function' },
  { path: 'secrets.set', kind: 'function' },
  { path: 'secrets.delete', kind: 'function' },
  // backend/main.ts:1176 — Touch ID / password gate.
  { path: 'authenticate', kind: 'function' },
  // backend/tool-windows.ts:504 etc — pushes to the page.
  { path: 'push', kind: 'function' },
  // backend/main.ts:3905 / onTray — quit.
  { path: 'quit', kind: 'function' },
  // backend/tool-windows.ts:438,446,637,694 + main.ts:445,449,3943 — window model.
  { path: 'win', kind: 'object' },
  { path: 'win.open', kind: 'function' },
  { path: 'win.getState', kind: 'function' },
  { path: 'win.windows', kind: 'function' },
  { path: 'win.setHideOnClose', kind: 'function' },
  { path: 'window', kind: 'function' },
  { path: 'screens', kind: 'function' },
  // backend/tool-windows.ts:1813/1823 — digits, ⌘K, tab keys.
  { path: 'hotkey', kind: 'object' },
  { path: 'hotkey.register', kind: 'function' },
  { path: 'hotkey.unregister', kind: 'function' },
  // backend/main.ts:815 — tray presence.
  { path: 'tray', kind: 'object' },
  { path: 'tray.set', kind: 'function' },
  // backend/main.ts:1372/3869 — update channel.
  { path: 'update', kind: 'object' },
  { path: 'update.check', kind: 'function' },
  { path: 'update.install', kind: 'function' },
  // backend/main.ts:3535 — vault.copy -> clipboard.write({ text }) (the inventory gap).
  { path: 'clipboard', kind: 'object' },
  { path: 'clipboard.read', kind: 'function' },
  { path: 'clipboard.write', kind: 'function' },
  { path: 'clipboard.changeCount', kind: 'function' },
  { path: 'clipboard.watch', kind: 'function' },
  { path: 'clipboard.unwatch', kind: 'function' },
];

interface Harness {
  app: TinyApp;
  clipboard: {
    text: string | null;
    image: Uint8Array | null;
    formats: string[];
    failWrite: boolean;
    writes: string[];
  };
  pushed: Array<{ event: string; data: unknown }>;
  hotkeys: string[];
  quitCount: () => number;
  trays: TrayCreateSpec[];
  renders: Array<{ spec: TrayIconSpec; dir: string }>;
  /** What `native.renderTrayIcon` answers; null parks the bundled `tray.png` fallback. */
  renderedIcon: { path: string | null };
}

async function harness(): Promise<Harness> {
  const clipboard = {
    text: null as string | null,
    image: null as Uint8Array | null,
    formats: [] as string[],
    failWrite: false,
    writes: [] as string[],
  };
  const pushed: Array<{ event: string; data: unknown }> = [];
  const hotkeys: string[] = [];
  const trays: TrayCreateSpec[] = [];
  const renders: Array<{ spec: TrayIconSpec; dir: string }> = [];
  const renderedIcon = { path: '/tmp/nod-test-cache/tray-rendered.png' as string | null };
  let quitCount = 0;
  let hotkeyHandler: (() => void) | null = null;

  const bindings: RuntimeBindings = {
    available: { tray: true, hotkey: true },
    tray: {
      create: (spec) => {
        trays.push(spec);
        return true;
      },
      bounds: async () => null,
      remove: () => undefined,
    },
    shortcuts: {
      register: (accelerator, handler) => {
        hotkeys.push(accelerator);
        hotkeyHandler = handler;
        return true;
      },
      unregister: () => undefined,
    },
    clipboard: {
      readText: () => clipboard.text,
      writeText: (text) => {
        if (clipboard.failWrite) throw new Error('clipboard unavailable');
        clipboard.text = text;
        clipboard.writes.push(text);
      },
      readImage: () => clipboard.image,
      writeImage: (png) => {
        clipboard.image = png;
      },
      clear: () => {
        clipboard.text = null;
        clipboard.image = null;
      },
      formats: () => clipboard.formats,
    },
    quit: () => {
      quitCount += 1;
    },
    onOpenUrl: () => undefined,
  };

  const handle = {
    open: () => undefined,
    close: () => undefined,
    eval: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    setPosition: () => undefined,
    setSize: () => undefined,
    setChrome: () => undefined,
    setMinSize: () => undefined,
  };
  const windows = {
    win: { ...handle, getState: async () => null, windows: async () => ['main'], setHideOnClose: () => undefined },
    window: () => handle,
    screens: async () => [],
  } as unknown as AppWindows;

  const native = {
    secrets: {
      get: async () => null,
      set: async () => true,
      delete: async () => true,
    },
    authenticate: async () => false,
    setIcon: () => true,
    renderTrayIcon: (spec, dir) => {
      renders.push({ spec, dir });
      return renderedIcon.path;
    },
    available: { secrets: true, authenticate: true, icon: true, dialogs: true },
  } as AppNative;

  const update = {
    check: async () => ({ available: false, current: '0.0.0', latest: null, notes: null }),
    install: async () => false,
  } as AppUpdate;

  const deps: AppDeps = {
    identifier: 'copland.nod.test',
    version: '0.0.0',
    runtime: 'electrobun test',
    os: 'macos',
    arch: 'arm64',
    resources: '/tmp/nod-test-resources',
    paths: {
      userData: '/tmp/nod-test-data',
      home: '/tmp',
      cache: '/tmp/nod-test-cache',
      logs: '/tmp/nod-test-logs',
      temp: '/tmp',
      downloads: '/tmp',
      desktop: '/tmp',
      documents: '/tmp',
    },
    send: (event, data) => {
      pushed.push({ event, data });
    },
    quit: () => {
      quitCount += 1;
    },
    hooks: {
      onTray: () => undefined,
      onHotkey: () => {
        hotkeyHandler?.();
      },
      onOpenUrl: () => undefined,
    },
    windows,
    native,
    update,
    bindings,
  };

  const app = await createApp(deps);
  return {
    app,
    clipboard,
    pushed,
    hotkeys,
    quitCount: () => quitCount,
    trays,
    renders,
    renderedIcon,
  };
}

function memberAt(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

describe('the facade covers every TinyApp member the backend touches', () => {
  test('each backend-used member exists with the right shape', async () => {
    const { app } = await harness();
    const missing: string[] = [];
    for (const { path, kind } of BACKEND_USED_SURFACE) {
      const value = memberAt(app, path);
      if (kind === 'function' ? typeof value !== 'function' : value === null || typeof value !== 'object') {
        missing.push(`${path} (${kind})`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the callable members answer without a runtime', async () => {
    const { app } = await harness();
    const paths = await app.paths();
    expect(paths.data).toBe('/tmp/nod-test-data');
    expect(paths.resources).toBe('/tmp/nod-test-resources');
    expect((await app.info()).version).toBe('0.0.0');
    expect(app.system.os()).toBe('macos');
    expect(await app.system.capabilities()).toMatchObject({
      authenticate: true,
      // 0.7.0: the system prompt stays available to the gate, the session unlock does not — the
      // Electrobun `bun` binary shares Bun's Developer ID (`docs/handovers/e07-migration.md` §5).
      biometricUnlock: false,
      icon: true,
    });
  });
});

describe('clipboard (vault.copy)', () => {
  test('write({ text }) lands on the native clipboard and answers true', async () => {
    const { app, clipboard } = await harness();
    expect(app.clipboard.write({ text: 'secret-value' })).toBe(true);
    expect(clipboard.writes).toEqual(['secret-value']);
    expect(clipboard.text).toBe('secret-value');
    expect(await app.clipboard.changeCount()).toBe(1);
  });

  test('read answers the TinyClipboardData shape', async () => {
    const { app, clipboard } = await harness();
    clipboard.text = 'copied';
    clipboard.formats = ['text'];
    const data = await app.clipboard.read();
    expect(data.kind).toBe('text');
    expect(data.text).toBe('copied');
    expect(data.html).toBeNull();
    expect(data.paths).toEqual([]);
    expect(data.concealed).toBe(false);
  });

  test('a failing native write answers false instead of throwing', async () => {
    const { app, clipboard } = await harness();
    clipboard.failWrite = true;
    expect(app.clipboard.write({ text: 'x' })).toBe(false);
  });

  test('watch/unwatch are the synchronous true the backend type declares', async () => {
    const { app } = await harness();
    expect(app.clipboard.watch(10)).toBe(true);
    expect(app.clipboard.unwatch()).toBe(true);
  });
});

describe('the rest of the wiring', () => {
  test('push goes to the single bridge callback', async () => {
    const { app, pushed } = await harness();
    app.push('tools', { active: 'a' });
    expect(pushed).toEqual([{ event: 'tools', data: { active: 'a' } }]);
  });

  test('hotkey.register maps shared/shortcuts combos and quit reaches the host', async () => {
    const { app, hotkeys, quitCount } = await harness();
    app.hotkey.register('palette', 'cmd+k');
    expect(hotkeys).toEqual(['Command+K']);
    app.quit();
    expect(quitCount()).toBe(1);
  });
});

describe('tray icons (A20, gap 22)', () => {
  test('an sf: spec is drawn by the native helper into the app cache', async () => {
    const { app, trays, renders } = await harness();
    app.tray.set({ title: 'Nod', icon: 'sf:rectangle.stack', menu: [{ id: 'open', label: 'Open Nod' }] });
    expect(renders).toEqual([
      { spec: { kind: 'sf', value: 'rectangle.stack' }, dir: '/tmp/nod-test-cache' },
    ]);
    expect(trays).toHaveLength(1);
    expect(trays[0]?.image).toBe('/tmp/nod-test-cache/tray-rendered.png');
  });

  test('an emoji: spec takes the same path, glyph intact', async () => {
    const { app, trays, renders } = await harness();
    app.tray.set({ title: 'Nod', icon: 'emoji:🔗', menu: [{ id: 'open', label: 'Open Nod' }] });
    expect(renders).toEqual([{ spec: { kind: 'emoji', value: '🔗' }, dir: '/tmp/nod-test-cache' }]);
    expect(trays[0]?.image).toBe('/tmp/nod-test-cache/tray-rendered.png');
  });

  test('without the native renderer the bundled tray.png stands in', async () => {
    const h = await harness();
    h.renderedIcon.path = null;
    h.app.tray.set({ title: 'Nod', icon: 'sf:rectangle.stack', menu: [] });
    expect(h.renders).toHaveLength(1);
    expect(h.trays[0]?.image).toBe('/tmp/nod-test-resources/tray.png');
  });

  test('a png path never reaches the renderer', async () => {
    const { app, trays, renders } = await harness();
    app.tray.set({ title: 'Nod', icon: '/tmp/icons/nod.png', menu: [] });
    expect(renders).toEqual([]);
    expect(trays[0]?.image).toBe('/tmp/icons/nod.png');
    app.tray.set({ title: 'Nod', icon: 'tray.png', menu: [] });
    expect(trays[1]?.image).toBe('/tmp/nod-test-resources/tray.png');
  });
});
