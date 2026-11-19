// The style toggle's page half (decision register, 2026-11-19): the one place that turns an
// AppearanceState into the window's look. It writes on <html> — data-skin and data-theme select the
// token block of style.css, and a custom colour becomes an inline CSS variable that overrides the
// block — so every screen wears it, the locked entry screen included, with no re-render of its own.
// The page never stores anything: the state comes from `nod.info` at boot (src/app.ts applies it)
// and `nod.setAppearance` after a change (src/settings.ts applies the answer).

import type { AppearanceState, ColorSlot, SkinId, ThemeName } from '../shared/types';

/** What the window wears before the boot's answer arrives; `applyAppearance` replaces it. */
let current: AppearanceState = { skin: 'atrius', theme: 'auto', colors: { light: {}, dark: {} } };

/** The theme on screen right now — `auto` resolved against the system's own appearance. */
let themeName: ThemeName = 'dark';

/** The system's answer for `auto`, watched so a change of the OS re-dresses the window. */
let darkQuery: MediaQueryList | null = null;

/**
 * The internal token each slot retunes, per skin (style.css owns the values themselves, and its
 * derived tokens read these through `var(...)`, so one override moves everything that follows it):
 * Atrius' accent is its `brand` — authority and failure are one colour there; Sober's accent is
 * the `primary` green of the solid button, the focus ring, the open tool and the current item's
 * bar, and Sober's success wears the same green by its own rule, so no separate success colour is
 * offered there.
 */
const SLOT_TOKENS: Record<SkinId, Partial<Record<ColorSlot, string[]>>> = {
  atrius: {
    accent: ['--brand'],
    info: ['--state-run'],
    warning: ['--state-wait'],
    success: ['--state-ok'],
    error: ['--state-error'],
  },
  sober: {
    accent: ['--solid-bg'],
    info: ['--state-run'],
    warning: ['--state-wait'],
    error: ['--brand', '--state-error'],
  },
};

/** Which slots the Colors card offers, in order: the skin's own list, never the union. */
const OFFERED_SLOTS: Record<SkinId, ColorSlot[]> = {
  atrius: ['accent', 'info', 'warning', 'success', 'error'],
  sober: ['accent', 'info', 'warning', 'error'],
};

/** English words of each slot, shared by both skins (the hints below tell them apart). */
const SLOT_LABELS: Record<ColorSlot, string> = {
  accent: 'Accent',
  info: 'Info',
  warning: 'Caution',
  success: 'Success',
  error: 'Failure',
};

/** What the slot means in the skin on screen. */
const SLOT_HINTS: Record<SkinId, Partial<Record<ColorSlot, string>>> = {
  atrius: {
    accent: 'Atrius wears one colour for authority and failure: danger buttons, error rules and the failed state all follow it.',
    info: 'Running and loading states, and plain notices.',
    warning: 'What waits for you: a manual sign-in, a personal tool, offline.',
    success: 'Signed in, saved, connected.',
    error: 'Atrius fails in its accent; a colour here splits the two apart.',
  },
  sober: {
    accent: "Sober's one green: the solid button, the focus ring, the open tool and the current item's bar. Success wears it too.",
    info: 'Loading and queued states, and plain notices.',
    warning: 'What waits for you: a manual sign-in, a personal tool, offline.',
    error: 'Failures, and the acts that remove or revoke.',
  },
};

/** The slots a skin offers, with their words — what the Colors card draws. */
export function offeredColorSlots(skin: SkinId): ReadonlyArray<{ slot: ColorSlot; label: string; hint: string }> {
  return OFFERED_SLOTS[skin].map((slot) => ({
    slot,
    label: SLOT_LABELS[slot],
    hint: SLOT_HINTS[skin][slot] ?? '',
  }));
}

/** The theme on screen right now: the Colours card edits this one's colours. */
export function resolvedTheme(): ThemeName {
  return themeName;
}

/** The CSS custom property that carries a slot in the skin on screen (the first one owns it). */
function slotProperty(skin: SkinId, slot: ColorSlot): string | null {
  return SLOT_TOKENS[skin][slot]?.[0] ?? null;
}

/**
 * `#rrggbb` of any CSS colour the skin may carry (`oklch(...)`, `rgb(...)`, a hex): the colour
 * input only takes hex. `null` when the browser cannot resolve the value.
 */
function cssColorToHex(value: string): string | null {
  if (value.trim() === '') return null;
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.hidden = true;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(resolved);
  if (match === null) return null;
  const hex = match
    .slice(1, 4)
    .map((part) => Math.round(Number(part)).toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

/**
 * The colour a slot is wearing right now, as `#rrggbb` for the picker: the custom value in force,
 * or the skin's own — and `var(...)` in the token itself (Atrius' `--state-error` is its `--brand`
 * until a colour splits them) resolves through the same cascade the window uses, because the probe
 * reads the property on the document instead of its raw text.
 */
export function colorOfSlot(slot: ColorSlot): string {
  const property = slotProperty(current.skin, slot);
  if (property === null) return '#000000';
  const resolved = cssColorToHex(`var(${property})`);
  return resolved ?? '#000000';
}

/**
 * Dresses the window: skin and theme on <html>, then the custom colours of the theme on screen
 * as inline tokens — inline wins over any block of style.css, and every token the previous state
 * may have set is cleared first, so a Reset really returns to the skin's own value. While the mode
 * is `auto`, the system's appearance is watched: a change that really moves the theme re-dresses
 * the window and says so on `nod:appearance` (the Settings card draws the theme on screen).
 */
export function applyAppearance(next: AppearanceState): void {
  current = next;
  if (darkQuery === null && typeof window.matchMedia === 'function') {
    darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    darkQuery.addEventListener('change', () => {
      if (current.theme !== 'auto') return;
      const resolved = darkQuery?.matches === true ? 'dark' : 'light';
      if (resolved === themeName) return;
      applyAppearance(current);
      window.dispatchEvent(new Event('nod:appearance'));
    });
  }
  themeName = current.theme === 'auto' ? (darkQuery !== null && darkQuery.matches ? 'dark' : 'light') : current.theme;
  const root = document.documentElement;
  root.dataset.skin = current.skin;
  root.dataset.theme = themeName;
  for (const tokens of Object.values(SLOT_TOKENS)) {
    for (const names of Object.values(tokens)) for (const name of names ?? []) root.style.removeProperty(name);
  }
  const colors = current.colors[themeName];
  for (const [slot, value] of Object.entries(colors)) {
    const names = SLOT_TOKENS[current.skin][slot as ColorSlot];
    for (const name of names ?? []) root.style.setProperty(name, value);
  }
}
