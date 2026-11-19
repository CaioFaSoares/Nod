// Pure half of the style toggle (decision register, 2026-11-19): the words a stored appearance
// may carry, their defaults, and the one reader that turns anything into a valid AppearanceState.
// The backend stores what the page sends, so this module is the gate: nothing invalid ever reaches
// `store.json`, and an old or hand-edited value reads as the default instead of breaking the boot.
// Nothing here imports `tjs`, `tiny` or the DOM; `bun test` drives it (test/appearance.test.ts).

import type { AppearanceColors, AppearanceState, ColorSlot, SkinId, ThemeMode, ThemeName } from './types';

/** `store.json` key of the whole appearance (a preference, never a secret). */
export const APPEARANCE_KEY = 'appearance';

/** The skins the window may wear, in the Settings order. */
export const SKIN_IDS: ReadonlyArray<SkinId> = ['atrius', 'sober'];

/** The palette modes, in the Settings order. */
export const THEME_MODES: ReadonlyArray<ThemeMode> = ['auto', 'light', 'dark'];

/** The two palettes a skin draws. */
export const THEME_NAMES: ReadonlyArray<ThemeName> = ['light', 'dark'];

/** Every colour slot, in the Settings order; which ones a skin offers is the page's own list. */
export const COLOR_SLOTS: ReadonlyArray<ColorSlot> = ['accent', 'info', 'warning', 'success', 'error'];

/** What the window wears until the person chooses: the Atrius skin, following the system. */
export const DEFAULT_APPEARANCE: AppearanceState = {
  skin: 'atrius',
  theme: 'auto',
  colors: { light: {}, dark: {} },
};

/**
 * A colour a person may pick, as `#rgb` or `#rrggbb`, answered lowercase as `#rrggbb`; `null` when
 * the value is not one (anything longer than a hex colour is refused, so no gradient, url() or
 * var() ever reaches a token).
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  return null;
}

/** The colours of one palette with only the valid slots kept, always a fresh object. */
function normalizeColors(raw: unknown): AppearanceColors {
  const colors: AppearanceColors = {};
  if (typeof raw !== 'object' || raw === null) return colors;
  const source = raw as Record<string, unknown>;
  for (const slot of COLOR_SLOTS) {
    const value = normalizeHexColor(source[slot]);
    if (value !== null) colors[slot] = value;
  }
  return colors;
}

/**
 * Anything into a valid appearance: unknown words, a missing half or a colour the format refuses
 * all read as the default, and the answer is always a fresh object the caller may keep.
 */
export function normalizeAppearance(raw: unknown): AppearanceState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_APPEARANCE, colors: { light: {}, dark: {} } };
  const source = raw as Record<string, unknown>;
  const skin: SkinId = SKIN_IDS.includes(source.skin as SkinId) ? (source.skin as SkinId) : DEFAULT_APPEARANCE.skin;
  const theme: ThemeMode = THEME_MODES.includes(source.theme as ThemeMode)
    ? (source.theme as ThemeMode)
    : DEFAULT_APPEARANCE.theme;
  const rawColors = typeof source.colors === 'object' && source.colors !== null ? source.colors : {};
  const palettes = rawColors as Record<string, unknown>;
  return {
    skin,
    theme,
    colors: { light: normalizeColors(palettes.light), dark: normalizeColors(palettes.dark) },
  };
}
