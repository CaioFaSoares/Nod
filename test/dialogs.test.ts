// The cross-platform save/open rules: a name the backend proposes can never leave the directory the
// person chose, and a save never overwrites an existing file silently. The dialog binding is faked,
// so this runs without a devkit or a display.

import { describe, expect, test } from 'bun:test';
import {
  allowedTypes,
  createPlatformDialogs,
  safeSaveName,
  uniquePath,
} from '../electrobun/bun/facade/dialogs';

describe('allowedTypes', () => {
  test('drops dots, blanks and duplicates and keeps order', () => {
    expect(allowedTypes(['.json', ' jsonl ', '', 'json', 'nodvault'])).toBe('json,jsonl,nodvault');
  });

  test('an empty or absent list is the wildcard', () => {
    expect(allowedTypes([])).toBe('*');
    expect(allowedTypes(undefined)).toBe('*');
  });
});

describe('safeSaveName', () => {
  test('keeps a plain name and adds the first extension when there is none', () => {
    expect(safeSaveName('report', ['json', 'jsonl'])).toBe('report.json');
    expect(safeSaveName('report.txt', ['json'])).toBe('report.txt');
  });

  test('strips a path, control characters and leading dots', () => {
    expect(safeSaveName('../../etc/passwd', ['txt'])).toBe('passwd.txt');
    expect(safeSaveName('.hidden', ['json'])).toBe('hidden.json');
    expect(safeSaveName('a\u0000b.txt', [])).toBe('ab.txt');
  });

  test('falls back to export when nothing usable is left', () => {
    expect(safeSaveName('   ', ['json'])).toBe('export.json');
    expect(safeSaveName(undefined, [])).toBe('export');
  });
});

describe('uniquePath', () => {
  test('uses the name when free and numbers it when taken', () => {
    const taken = new Set(['/tmp/report.txt', '/tmp/report (2).txt']);
    expect(uniquePath('/tmp', 'report.txt', (path) => taken.has(path))).toBe('/tmp/report (3).txt');
    expect(uniquePath('/tmp', 'other.txt', (path) => taken.has(path))).toBe('/tmp/other.txt');
  });
});

describe('createPlatformDialogs', () => {
  test('openFile asks for one file with the allowed list', async () => {
    let seen: unknown = null;
    const dialogs = createPlatformDialogs({
      async openFileDialog(options) {
        seen = options;
        return ['/tmp/a.json'];
      },
    });
    expect(await dialogs.openFile({ types: ['.json'] })).toBe('/tmp/a.json');
    expect(seen).toMatchObject({
      allowedFileTypes: 'json',
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: false,
    });
  });

  test('saveFile asks for a directory and returns a file path inside it', async () => {
    const dialogs = createPlatformDialogs({
      async openFileDialog() {
        return ['/tmp'];
      },
    });
    expect(await dialogs.saveFile({ name: 'seed.json' })).toBe('/tmp/seed.json');
  });

  test('a cancelled dialog answers null', async () => {
    const dialogs = createPlatformDialogs({ async openFileDialog() { return []; } });
    expect(await dialogs.openFile()).toBeNull();
    expect(await dialogs.saveFile({ name: 'x' })).toBeNull();
  });
});
