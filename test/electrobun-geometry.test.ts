// E06: the pure geometry the Electrobun window facade runs on (`electrobun/bun/facade/geometry.ts`).
//
// The numbers here are the measured ones (Electrobun 2.0.4, macOS 27): a window created with
// 700×500 reads back 700×532, and `setSize(600,400)` yields a page of 600×368. `setSize` is the
// Nod's page box, `getFrame` is the outer frame, and the delta between them is the titlebar the
// facade carries per window. A tiled/resized window (the owner's machine runs a tiling window
// manager) must not poison that delta.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TITLEBAR,
  NAVIGATION_ALLOW_RULES,
  NO_DECORATION,
  cascadeRect,
  capSize,
  clampToMinSize,
  decorationAtCreation,
  decorationFor,
  decorationFrom,
  denyRuleFor,
  formatSize,
  outerBoxForPage,
  overlapArea,
  pageBoxFromOuter,
  pageBoxFromOuter,
  pageOrigin,
  parseSize,
  screenForRect,
  screenRectForView,
  viewRectForContent,
  viewRectForScreen,
} from '../electrobun/bun/facade/geometry';

describe('parseSize', () => {
  test('reads the tinyjs "WxH" form', () => {
    expect(parseSize('760x500')).toEqual({ width: 760, height: 500 });
    expect(parseSize(' 1100 x 720 ')).toEqual({ width: 1100, height: 720 });
    expect(parseSize('420×300')).toEqual({ width: 420, height: 300 });
  });

  test('refuses anything that is not a positive integer pair', () => {
    for (const value of ['', '760', '760x', 'x500', '0x500', '760x0', '-1x500', '7.5x500', 'a x b']) {
      expect(parseSize(value)).toBeNull();
    }
    expect(parseSize(undefined)).toBeNull();
    expect(parseSize(760)).toBeNull();
  });

  test('round-trips through formatSize', () => {
    const size = parseSize('1280x800');
    expect(size === null ? null : formatSize(size)).toBe('1280x800');
  });
});

describe('page box <> frame', () => {
  test('a framed window keeps the page box across setSize', () => {
    const decoration = { width: 0, height: 32 };
    const page = { width: 600, height: 400 };
    const outer = outerBoxForPage(page, decoration);
    expect(outer).toEqual({ width: 600, height: 432 });
    // What the runtime measures back after applying the frame.
    expect(pageBoxFromOuter(outer, decoration)).toEqual(page);
  });

  test('a frameless window has outer === page', () => {
    expect(outerBoxForPage({ width: 600, height: 400 }, NO_DECORATION)).toEqual({
      width: 600,
      height: 400,
    });
  });

  test('never reports a zero-sized page', () => {
    expect(pageBoxFromOuter({ width: 10, height: 10 }, { width: 0, height: 32 })).toEqual({
      width: 10,
      height: 1,
    });
  });

  test('rounds fractional frames instead of leaking decimals', () => {
    expect(pageBoxFromOuter({ width: 600.4, height: 432.6 }, { width: 0, height: 32 })).toEqual({
      width: 600,
      height: 401,
    });
  });
});

describe('decoration', () => {
  test('creation takes the content rect, so frame - requested is the titlebar', () => {
    expect(decorationFrom({ width: 700, height: 532 }, { width: 700, height: 500 })).toEqual({
      width: 0,
      height: 32,
    });
  });

  test('a frameless creation implies no decoration', () => {
    expect(decorationAtCreation(true, { width: 420, height: 300 }, { width: 420, height: 300 })).toEqual(
      NO_DECORATION,
    );
  });

  test('a window tiled between create and read falls back to the known titlebar', () => {
    // The owner's tiling window manager resized every new window to 1235×1312.
    expect(
      decorationAtCreation(false, { width: 1235, height: 1312 }, { width: 700, height: 500 }),
    ).toEqual({ width: 0, height: DEFAULT_TITLEBAR });
  });

  test('a real reading wins over the constant', () => {
    expect(decorationFor(true, { width: 0, height: 28 })).toEqual({ width: 0, height: 28 });
    expect(decorationFor(true, null)).toEqual({ width: 0, height: DEFAULT_TITLEBAR });
    expect(decorationFor(false, { width: 0, height: 28 })).toEqual(NO_DECORATION);
  });
});

describe('screens', () => {
  const screens = [
    { x: 0, y: 0, width: 2294, height: 1490, primary: true, scale: 1 },
    { x: 2294, y: -1440, width: 2560, height: 1440, primary: false, scale: 1 },
    { x: -1080, y: 1490, width: 1080, height: 810, primary: false, scale: 2 },
  ];

  test('picks the display with the largest overlap', () => {
    expect(screenForRect(screens, { x: 3000, y: -1000, width: 500, height: 400 })?.x).toBe(2294);
    expect(screenForRect(screens, { x: -500, y: 1600, width: 300, height: 200 })?.scale).toBe(2);
  });

  test('ties and off-screen windows go to the primary display', () => {
    expect(screenForRect(screens, { x: 2294, y: 0, width: 10, height: 10 })?.x).toBe(0);
    expect(screenForRect(screens, { x: 9000, y: 9000, width: 100, height: 100 })?.x).toBe(0);
  });

  test('no displays means no answer, and overlap never goes negative', () => {
    expect(screenForRect([], { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toBe(0);
    expect(overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(25);
  });
});

describe('popup placement', () => {
  const screen = { x: 0, y: 49, width: 2294, height: 1382 };

  test('cascades 28 px off the opener, capped to 90% of the usable area', () => {
    const rect = cascadeRect({ x: 200, y: 120, width: 700, height: 500 }, screen, {
      width: 1280,
      height: 900,
    });
    expect(rect).toEqual({ x: 228, y: 148, width: 1280, height: 900 });
  });

  test('keeps the popup inside the display when the opener sits at an edge', () => {
    const rect = cascadeRect({ x: 2250, y: 1400, width: 40, height: 30 }, screen, {
      width: 900,
      height: 700,
    });
    expect(rect.x).toBe(2294 - 900);
    expect(rect.y).toBe(49 + 1382 - 700);
  });

  test('without a screen it still places relative to the opener', () => {
    expect(cascadeRect({ x: 100, y: 100, width: 10, height: 10 }, null, { width: 300, height: 200 })).toEqual({
      x: 128,
      y: 128,
      width: 300,
      height: 200,
    });
  });

  test('capSize never returns a zero dimension', () => {
    expect(capSize({ width: 4000, height: 4000 }, { width: 100, height: 100 })).toEqual({
      width: 90,
      height: 90,
    });
    expect(capSize({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({
      width: 1,
      height: 1,
    });
  });
});

describe('min size', () => {
  test('only answers when the floor is violated', () => {
    expect(clampToMinSize({ width: 900, height: 700 }, { width: 760, height: 500 })).toBeNull();
    expect(clampToMinSize({ width: 500, height: 700 }, { width: 760, height: 500 })).toEqual({
      width: 760,
      height: 700,
    });
    expect(clampToMinSize({ width: 500, height: 300 }, null)).toBeNull();
  });
});

describe('navigation rules', () => {
  test('deny-all comes first so the last matching allow rule wins', () => {
    expect(NAVIGATION_ALLOW_RULES[0]).toBe('^*');
    expect(NAVIGATION_ALLOW_RULES).toContain('https://*');
    expect(NAVIGATION_ALLOW_RULES).toContain('http://127.0.0.1:*');
    expect(NAVIGATION_ALLOW_RULES).toContain('views://*');
    // Plain http outside loopback is never allowed (A20).
    expect(NAVIGATION_ALLOW_RULES).not.toContain('http://*');
  });

  test('a denied URL becomes one block rule, and junk yields none', () => {
    expect(denyRuleFor('https://example.com/x')).toBe('^https://example.com/x');
    expect(denyRuleFor('   ')).toBeNull();
    expect(denyRuleFor('')).toBeNull();
  });
});

describe('docked tab rects (a view inside the main window)', () => {
  // The slot the page reports is converted by `backend/tool-windows.ts` `slotToScreen`:
  // `x = fx + dx/2 + pageX`, `y = fy + dy + pageY`, where dx/dy = outer - page. A docked tab's
  // `setPosition`/`setSize` carry that screen rect back, so the inverse must land exactly.
  const frame = { x: 2326, y: -1350, width: 1102, height: 1303 };
  const page = { width: 1102, height: 1271 };

  test('the page origin is half the side borders and the whole titlebar', () => {
    expect(pageOrigin(frame, page)).toEqual({ x: 2326, y: -1350 + 32 });
  });

  test('a screen rect becomes a content-view rect and back', () => {
    const slot = { x: 2400, y: -1200, width: 900, height: 700 };
    const view = viewRectForScreen(frame, page, slot);
    expect(view).toEqual({ x: 74, y: 118, width: 900, height: 700 });
    expect(screenRectForView(frame, page, view)).toEqual(slot);
  });

  test('a tiling window manager moving main keeps the round trip', () => {
    const moved = { x: 0, y: 25, width: 1102, height: 1303 };
    const slot = { x: 120, y: 90, width: 800, height: 600 };
    const view = viewRectForScreen(moved, page, slot);
    expect(screenRectForView(moved, page, view)).toEqual(slot);
  });

  test('fractional side borders round once, on the way in', () => {
    const bordered = { x: 10, y: 20, width: 1001, height: 703 };
    const inner = { width: 1000, height: 671 };
    const view = viewRectForScreen(bordered, inner, { x: 10, y: 52, width: 400, height: 300 });
    // The page origin is x = 10.5: the view rect keeps the half point instead of rounding it, so the
    // screen rect the backend asked for comes back exactly.
    expect(view).toEqual({ x: -0.5, y: 0, width: 400, height: 300 });
    expect(screenRectForView(bordered, inner, view)).toEqual({
      x: 10,
      y: 52,
      width: 400,
      height: 300,
    });
  });

  test('invalid sizes clamp to one pixel instead of disappearing', () => {
    expect(viewRectForScreen(frame, page, { x: 2326, y: -1318, width: 0, height: -4 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  test('a detached tab fills the content view from its origin', () => {
    expect(viewRectForContent({ width: 720, height: 520 })).toEqual({
      x: 0,
      y: 0,
      width: 720,
      height: 520,
    });
  });

  test('the page box of main is what the view rect is relative to', () => {
    const outer = { width: 1180, height: 832 };
    const outerPage = pageBoxFromOuter(outer, { width: 0, height: 32 });
    expect(pageOrigin({ x: 80, y: 80, ...outer }, outerPage)).toEqual({ x: 80, y: 112 });
  });
});
