// Tray icon specs, kept free of the native bridge so `facade/app.ts` (and the facade test) never
// loads `bun:ffi` just to translate an icon string. The renderer is `facade/native.ts`
// `renderTrayIcon` -> `electrobun/native/NodNative.swift` `renderTrayIcon`.
//
// Parity rows: A20, gap 22 (`docs/handovers/e06-parity-matrix.md`).

/**
 * A tray icon spec the native side can draw: `sf:<name>` is an SF Symbol, `emoji:<glyph>` an
 * attributed string drawn into the same 18 pt canvas. Any other icon is a png path and returns
 * null, so the caller keeps using the path as given.
 */
export type TrayIconSpec =
  | { kind: 'sf'; value: string }
  | { kind: 'emoji'; value: string };

export function parseTrayIconSpec(icon: string): TrayIconSpec | null {
  if (icon.startsWith('sf:')) {
    const value = icon.slice('sf:'.length).trim();
    return value === '' ? null : { kind: 'sf', value };
  }
  if (icon.startsWith('emoji:')) {
    const value = icon.slice('emoji:'.length);
    return value.trim() === '' ? null : { kind: 'emoji', value };
  }
  return null;
}
