// Pure geometry for the Electrobun window facade: no devkit, no I/O, no globals.
//
// The two coordinate systems the Nod cares about:
//   - the FRAME (what macOS positions and what `BrowserWindow.setPosition/getFrame` speak), whose
//     top-left is `TinyWinState.x/y`, and whose size is `TinyWinState.outer`;
//   - the PAGE box (what `win.open`'s `size`, `setSize` and `setMinSize` speak), which excludes the
//     titlebar — `TinyWinState.width/height`. Measured on Electrobun 2.0.4 (macOS): a framed window
//     created with 700×500 reads back 700×532, i.e. creation takes the CONTENT rect, but
//     `setSize`/`setFrame` take the FRAME rect. Hence `decoration` below: the delta the facade
//     carries per window (0 for a frameless window; the titlebar height otherwise).
//
// All functions are total: invalid input yields `null` instead of throwing, because they run on
// values that come from the backend and from the OS.

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Window decorations included minus the page box: `{width:0, height:<titlebar>}` on macOS. */
export interface Decoration {
  width: number;
  height: number;
}

/** The titlebar height measured on macOS 27 + Electrobun 2.0.4; replaced by a per-window reading. */
export const DEFAULT_TITLEBAR = 32;

export const NO_DECORATION: Decoration = Object.freeze({ width: 0, height: 0 });

/** A positive finite number, or null — window sizes and positions never accept anything else. */
function positive(value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

function finite(value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * `'WxH'` (the form `TinyOpenWindowOptions.size`/`minSize` use) → size.
 * Accepts surrounding spaces and a `×`, rejects zero, negatives, fractions and junk.
 * `null` means "the option is not a size"; the caller picks its default.
 */
export function parseSize(text: unknown): Size | null {
  if (typeof text !== 'string') return null;
  const match = /^\s*([0-9]{1,6})\s*[x×]\s*([0-9]{1,6})\s*$/.exec(text);
  if (match === null) return null;
  const width = positive(Number(match[1]));
  const height = positive(Number(match[2]));
  if (width === null || height === null) return null;
  return { width, height };
}

/** `{width, height}` → `'WxH'`, the inverse of `parseSize` (used by tests and messages). */
export function formatSize(size: Size): string {
  return `${Math.round(size.width)}x${Math.round(size.height)}`;
}

/** The page box of a frame: what `getState()` reports as `width`/`height`. */
export function pageBoxFromOuter(outer: Size, decoration: Decoration): Size {
  return {
    width: Math.max(1, Math.round(outer.width - decoration.width)),
    height: Math.max(1, Math.round(outer.height - decoration.height)),
  };
}

/** The frame size that makes the page box exactly `page` — what `setSize` sends to the devkit. */
export function outerBoxForPage(page: Size, decoration: Decoration): Size {
  return {
    width: Math.max(1, Math.round(page.width + decoration.width)),
    height: Math.max(1, Math.round(page.height + decoration.height)),
  };
}

/**
 * The decoration implied by a creation: the devkit's `frame` is the content rect, so the frame the
 * window reports back afterwards minus the size we asked for is exactly the chrome. Clamped to a
 * sane range: a window manager that already moved the window must not poison the delta.
 */
export function decorationFrom(outer: Size, page: Size): Decoration {
  const width = finite(outer.width - page.width) ?? 0;
  const height = finite(outer.height - page.height) ?? 0;
  return {
    width: width >= 0 && width <= 64 ? width : 0,
    height: height >= 0 && height <= 128 ? height : 0,
  };
}

/** The decoration a chrome state implies when no framed reading exists yet. */
export function decorationFor(framed: boolean, known: Decoration | null): Decoration {
  if (!framed) return NO_DECORATION;
  if (known !== null && known.height > 0) return known;
  return { width: 0, height: DEFAULT_TITLEBAR };
}

/**
 * The decoration of a window right after creation: the devkit's frame is the content rect, so the
 * reading is exact — unless a window manager already tiled the window between `createWindow` and the
 * read, in which case `decorationFrom` rejects it and the known titlebar is the safer answer.
 */
export function decorationAtCreation(
  frameless: boolean,
  outer: Size,
  requestedPage: Size,
): Decoration {
  if (frameless) return NO_DECORATION;
  const reading = decorationFrom(outer, requestedPage);
  return reading.height > 0 ? reading : decorationFor(true, null);
}

/** Overlap area of two rectangles in square px (0 when they do not touch). */
export function overlapArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * The display holding a frame: the largest overlap wins, ties go to `primary` (the first entry the
 * caller flagged primary, else the first), and a window on no display gets the primary one — the
 * same rule `backend/tool-windows.ts` applies to the screens it receives.
 */
export function screenForRect<T extends Rect & { primary?: boolean }>(
  screens: readonly T[],
  rect: Rect,
): T | null {
  if (screens.length === 0) return null;
  let primary = screens[0];
  for (const screen of screens) {
    if (screen.primary === true) {
      primary = screen;
      break;
    }
  }
  let best = primary;
  let bestArea = 0;
  for (const screen of screens) {
    const area = overlapArea(rect, screen);
    if (area > bestArea) {
      bestArea = area;
      best = screen;
    }
  }
  return best;
}

/** Keeps a size inside a usable area, never below 1 px. */
export function capSize(size: Size, area: Size, limit = 0.9): Size {
  const width = Math.max(1, Math.min(size.width, Math.floor(area.width * limit)));
  const height = Math.max(1, Math.min(size.height, Math.floor(area.height * limit)));
  return { width, height };
}

/**
 * Where a popup lands: a step off its opener (the same +28 px cascade the tool windows use), the
 * whole frame kept inside the opener's display's usable area when it fits.
 */
export function cascadeRect(
  opener: Rect | null,
  screen: Rect | null,
  size: Size,
  step = 28,
): Rect {
  const capped =
    screen === null ? size : capSize(size, { width: screen.width, height: screen.height });
  let x = (opener?.x ?? screen?.x ?? 0) + step;
  let y = (opener?.y ?? screen?.y ?? 0) + step;
  if (screen !== null) {
    const maxX = screen.x + Math.max(0, screen.width - capped.width);
    const maxY = screen.y + Math.max(0, screen.height - capped.height);
    x = Math.max(screen.x, Math.min(x, maxX));
    y = Math.max(screen.y, Math.min(y, maxY));
  }
  return { x: Math.round(x), y: Math.round(y), width: capped.width, height: capped.height };
}

// ---------------------------------------------------------------- docked tab views (in-window)

/**
 * The offset from a window's frame origin (screen coordinates) to the top-left of its page box:
 * half the side borders and the whole titlebar, the delta `backend/tool-windows.ts` `slotToScreen`
 * adds. Round-tripping `viewRectForScreen`/`screenRectForView` must land on the same screen point.
 */
export function pageOrigin(frame: Rect, page: Size): { x: number; y: number } {
  const dx = Math.max(0, Math.round(frame.width - page.width));
  const dy = Math.max(0, Math.round(frame.height - page.height));
  // Deliberately unrounded: an odd side border makes the page origin a half point, and rounding it
  // here would move every docked tab by a pixel relative to what the backend computed.
  return { x: frame.x + dx / 2, y: frame.y + dy };
}

/**
 * A screen rect — what the backend asks a docked tab for with `setPosition`/`setSize` (the slot's
 * screen rect, `slotToScreen`) — in the coordinate system `createWebview`/`resizeWebview` take for
 * a view inside the main window: top-left origin, relative to the window's content view.
 */
export function viewRectForScreen(frame: Rect, page: Size, rect: Rect): Rect {
  const origin = pageOrigin(frame, page);
  return {
    x: rect.x - origin.x,
    y: rect.y - origin.y,
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

/** The inverse of `viewRectForScreen`: where a docked view paints, in screen coordinates. */
export function screenRectForView(frame: Rect, page: Size, rect: Rect): Rect {
  const origin = pageOrigin(frame, page);
  return {
    x: Math.round(origin.x + rect.x),
    y: Math.round(origin.y + rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

/**
 * The rect a detached tab's view fills in its own window's content view: the page box, from the
 * content view's own origin.
 */
export function viewRectForContent(page: Size): Rect {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.round(page.width)),
    height: Math.max(1, Math.round(page.height)),
  };
}

/**
 * Whether two readings are the same top-frame document. Electrobun's navigation events fire for
 * subframes too and carry no frame flag (measured), so the facade accepts an event only when its URL
 * equals the view's own top URL; the fragment is ignored because a hash change is the same document.
 * Anything unparseable compares verbatim (two equal strings are still the same reading).
 */
export function sameFrameUrl(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search}`;
    } catch {
      return value;
    }
  };
  return normalize(a) === normalize(b);
}

/**
 * Min-size enforcement for a page box: the requested size raised to the floor, or null when the
 * floor is already satisfied (the common case — no window resize round-trip).
 */
export function clampToMinSize(page: Size, min: Size | null): Size | null {
  if (min === null) return null;
  const width = Math.max(page.width, min.width);
  const height = Math.max(page.height, min.height);
  if (width === page.width && height === page.height) return null;
  return { width, height };
}

/**
 * The navigation allow-list installed on every managed view AFTER creation (Electrobun 2.0.4
 * silently drops `navigationRules` given to `createWebview`; `BrowserView.setNavigationRules` is the
 * only path that reaches the native side). `^*` denies everything that no later rule allows, and the
 * last matching rule wins, so the order below is the policy: https everywhere, plain http only on
 * loopback (A20 of `backend/tool-windows.ts`), the app's own schemes, nothing else.
 */
export const NAVIGATION_ALLOW_RULES: readonly string[] = Object.freeze([
  '^*',
  'https://*',
  'http://127.0.0.1:*',
  'http://localhost:*',
  'http://[::1]:*',
  'views://*',
  'file://*',
  'about:*',
  'blob:*',
  'data:*',
]);

/** A deny rule for one exact URL, appended to a view's rules (best effort: `*` is not escapable). */
export function denyRuleFor(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  return `^${trimmed}`;
}
