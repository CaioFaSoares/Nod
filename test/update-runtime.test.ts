// `facade/update-runtime.ts`: the Windows/Linux branch of `app.update`. A fake Updater and a fake
// manifest response pin the contract the backend consumes: `check()` is read-only, `install()`
// downloads/prepares/applies, and every refusal names its reason without throwing.

import { describe, expect, test } from 'bun:test';
import {
  createRuntimeUpdate,
  type RuntimeUpdater,
} from '../electrobun/bun/facade/update-runtime';

function updater(over: Partial<RuntimeUpdater> = {}): RuntimeUpdater {
  return {
    async checkForUpdate() {
      return { version: '0.9.0', updateAvailable: true };
    },
    async downloadUpdate() {},
    updateInfo() {
      return { updateReady: true, error: '' };
    },
    async applyUpdate() {},
    ...over,
  };
}

const MANIFEST = JSON.stringify({ version: '0.9.0', notes: 'Nod 0.9.0 adds things.' });

function fetchOk(body = MANIFEST): (url: string) => Promise<Response> {
  return async () => new Response(body, { status: 200 });
}

describe('createRuntimeUpdate', () => {
  test('check reads the channel and the notes without applying anything', async () => {
    const update = createRuntimeUpdate({
      updateUrl: 'https://example.test/manifest.json',
      version: '0.8.0',
      updater: updater(),
      fetch: fetchOk(),
    });
    expect(await update.check()).toEqual({
      available: true,
      current: '0.8.0',
      latest: '0.9.0',
      notes: 'Nod 0.9.0 adds things.',
    });
  });

  test('no channel means no offer', async () => {
    const update = createRuntimeUpdate({
      updateUrl: null,
      version: '0.8.0',
      updater: updater(),
      fetch: fetchOk(),
    });
    expect((await update.check()).available).toBe(false);
    expect(await update.install()).toBe(false);
    expect(update.refusal()).toBe('this release has no update channel');
  });

  test('install downloads, applies and answers true', async () => {
    const calls: string[] = [];
    const update = createRuntimeUpdate({
      updateUrl: 'https://example.test/manifest.json',
      version: '0.8.0',
      updater: updater({
        async downloadUpdate() {
          calls.push('download');
        },
        async applyUpdate() {
          calls.push('apply');
        },
      }),
      fetch: fetchOk(),
    });
    expect(await update.install()).toBe(true);
    expect(calls).toEqual(['download', 'apply']);
    expect(update.refusal()).toBeNull();
  });

  test('a prepared download that is not ready is a refusal with the runtime error', async () => {
    const update = createRuntimeUpdate({
      updateUrl: 'https://example.test/manifest.json',
      version: '0.8.0',
      updater: updater({
        updateInfo() {
          return { updateReady: false, error: 'disk full' };
        },
      }),
      fetch: fetchOk(),
    });
    expect(await update.install()).toBe(false);
    expect(update.refusal()).toBe('disk full');
  });

  test('a broken manifest still offers the update, without notes', async () => {
    const update = createRuntimeUpdate({
      updateUrl: 'https://example.test/manifest.json',
      version: '0.8.0',
      updater: updater(),
      fetch: fetchOk('not json'),
    });
    expect(await update.check()).toEqual({
      available: true,
      current: '0.8.0',
      latest: '0.9.0',
      notes: null,
    });
  });
});
