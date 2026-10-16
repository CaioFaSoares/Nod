import { describe, expect, test } from 'bun:test';

import { combo, digits } from '../shared/shortcuts';

describe('digits', () => {
  test('maps 1..9 onto the ids in the given order', () => {
    expect([...digits(['kanban', 'affine', 'mail'])]).toEqual([
      [1, 'kanban'],
      [2, 'affine'],
      [3, 'mail'],
    ]);
  });

  test('ignores the tenth id onward', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `tool-${i + 1}`);
    const map = digits(ids);
    expect(map.size).toBe(9);
    expect([...map.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(map.get(1)).toBe('tool-1');
    expect(map.get(9)).toBe('tool-9');
    expect(map.get(10)).toBeUndefined();
  });

  test('a single id takes digit 1 and nothing else', () => {
    expect([...digits(['kanban'])]).toEqual([[1, 'kanban']]);
  });

  test('without ids there is no digit', () => {
    expect(digits([]).size).toBe(0);
  });
});

describe('combo', () => {
  test('cmd on macOS', () => {
    expect(combo('1', 'macos')).toBe('cmd+1');
    expect(combo('k', 'macos')).toBe('cmd+k');
  });

  test('ctrl on windows and linux', () => {
    expect(combo('K', 'linux')).toBe('ctrl+k');
    expect(combo('K', 'windows')).toBe('ctrl+k');
    expect(combo('1', 'windows')).toBe('ctrl+1');
  });

  test('lowercases the key, digits and letters alike', () => {
    expect(combo('9', 'macos')).toBe('cmd+9');
    expect(combo('PALETTE', 'linux')).toBe('ctrl+palette');
  });
});
