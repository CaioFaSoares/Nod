// The style toggle's pure half (shared/appearance.ts): what `store.json` may hold, and what any
// stored value — an old one, a hand-edited one, another program's — reads as. Run with `bun test`.
import { describe, expect, test } from 'bun:test';
import {
  COLOR_SLOTS,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  normalizeHexColor,
  SKIN_IDS,
  THEME_MODES,
} from '../shared/appearance';

describe('style toggle: stored appearance', () => {
  test('an absent value reads as the default look', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance('sober')).toEqual(DEFAULT_APPEARANCE);
  });

  test('every valid word survives a round trip', () => {
    for (const skin of SKIN_IDS) {
      for (const theme of THEME_MODES) {
        const read = normalizeAppearance({ skin, theme, colors: { light: { accent: '#007f45' }, dark: {} } });
        expect(read.skin).toBe(skin);
        expect(read.theme).toBe(theme);
        expect(read.colors.light).toEqual({ accent: '#007f45' });
        expect(read.colors.dark).toEqual({});
      }
    }
  });

  test('unknown words fall back one field at a time', () => {
    const read = normalizeAppearance({ skin: 'neon', theme: 'sepia', colors: { light: {}, dark: {} } });
    expect(read.skin).toBe(DEFAULT_APPEARANCE.skin);
    expect(read.theme).toBe(DEFAULT_APPEARANCE.theme);
  });

  test('only known slots and hex colours are stored', () => {
    const read = normalizeAppearance({
      colors: {
        light: { accent: '#ABC', warning: 'red', nope: '#000000', error: 'url(x)' },
        dark: { info: '#00dc82', success: 42 },
      },
    });
    expect(read.colors.light).toEqual({ accent: '#aabbcc' });
    expect(read.colors.dark).toEqual({ info: '#00dc82' });
  });

  test('a missing half of the colours reads as no custom colours', () => {
    expect(normalizeAppearance({ skin: 'sober' }).colors).toEqual({ light: {}, dark: {} });
    expect(normalizeAppearance({ colors: 'both' }).colors).toEqual({ light: {}, dark: {} });
  });

  test('the answer is a fresh object the caller may keep', () => {
    const source = { skin: 'sober', theme: 'dark', colors: { light: {}, dark: {} } };
    const first = normalizeAppearance(source);
    first.skin = 'atrius';
    expect(normalizeAppearance(source).skin).toBe('sober');
    expect(DEFAULT_APPEARANCE.colors.light).toEqual({});
  });

  test('the slot list is the five the screen may offer', () => {
    expect([...COLOR_SLOTS]).toEqual(['accent', 'info', 'warning', 'success', 'error']);
  });
});

describe('style toggle: colours', () => {
  test('a hex colour is answered lowercase and long', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('  #00DC82 ')).toBe('#00dc82');
  });

  test('anything that is not a hex colour is refused', () => {
    const refused: unknown[] = ['red', 'rgb(0,0,0)', 'oklch(50% 0.1 20)', 'url(#x)', '#12345', '#1234567', '', ' ', 7, null, undefined];
    for (const value of refused) expect(normalizeHexColor(value)).toBeNull();
  });
});
