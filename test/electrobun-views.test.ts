// E06 (owner decision 2026-10-22 §22): the pure half of a docked tab — the screen rect the backend
// speaks (`backend/tool-windows.ts` `setPosition`/`setSize` on the slot) ↔ the rect a native view
// takes inside the main window's content view, and the two wire ops the Swift side parses to move
// that view between windows. No devkit, no dylib, no macOS.
import { describe, expect, test } from 'bun:test';
import {
  pageOrigin,
  sameFrameUrl,
  screenRectForView,
  viewRectForContent,
  viewRectForScreen,
} from '../electrobun/bun/facade/geometry';
import {
  decodeNativeResponse,
  encodeNativeRequest,
  type NativeWireRequest,
} from '../electrobun/bun/facade/native';

/** The main window as the facade tracks it: page box 1102×1271 under a 32 px titlebar. */
const MAIN_FRAME = { x: 2326, y: -1350, width: 1102, height: 1303 };
const MAIN_PAGE = { width: 1102, height: 1271 };

/** What `slotToScreen` produces for a slot at page (74, 86) sized 900×700 (the e03 formula). */
const SLOT = { x: 2400, y: -1232, width: 900, height: 700 };

describe('a docked tab on the slot', () => {
  test('the screen rect lands where the page reports the slot', () => {
    // Page origin = (2326, -1318); the slot at page (74, 86) is the screen point (2400, -1232).
    expect(pageOrigin(MAIN_FRAME, MAIN_PAGE)).toEqual({ x: 2326, y: -1318 });
    expect(viewRectForScreen(MAIN_FRAME, MAIN_PAGE, SLOT)).toEqual({
      x: 74,
      y: 86,
      width: 900,
      height: 700,
    });
  });

  test('a second placement after main moved re-derives from the same screen rect', () => {
    const moved = { x: 100, y: 60, width: 1102, height: 1303 };
    const view = viewRectForScreen(moved, MAIN_PAGE, SLOT);
    expect(view).toEqual({ x: 2300, y: -1324, width: 900, height: 700 });
    // The backend only re-places when the slot's screen rect changed, so this is the poll's answer
    // after the window manager moved main: the tab stays glued to the slot, not to the window.
    expect(screenRectForView(moved, MAIN_PAGE, view)).toEqual(SLOT);
  });

  test('the size is the slot page box, never the window frame', () => {
    const view = viewRectForScreen(MAIN_FRAME, MAIN_PAGE, { ...SLOT, width: 640, height: 480 });
    expect({ width: view.width, height: view.height }).toEqual({ width: 640, height: 480 });
  });
});

describe('detach and dock', () => {
  test('detached, the same view fills its window content view', () => {
    const page = { width: 900, height: 700 };
    expect(viewRectForContent(page)).toEqual({ x: 0, y: 0, width: 900, height: 700 });
  });

  test('docking back is the first mapping again — one view, two homes', () => {
    const docked = viewRectForScreen(MAIN_FRAME, MAIN_PAGE, SLOT);
    const detached = viewRectForContent(SLOT);
    // Different rects, same object: nothing about the page box changed across the move.
    expect({ width: docked.width, height: docked.height }).toEqual({
      width: detached.width,
      height: detached.height,
    });
    expect(screenRectForView(MAIN_FRAME, MAIN_PAGE, docked)).toEqual(SLOT);
  });

  test('a zero-sized slot still yields a frame the core accepts', () => {
    expect(viewRectForContent({ width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe('the native wire for a moved view', () => {
  test('views.list asks the AppKit tree for one window', () => {
    const request: NativeWireRequest = { id: 'v-1', op: 'views.list', target: '530984257408' };
    expect(JSON.parse(encodeNativeRequest(request))).toEqual({
      id: 'v-1',
      op: 'views.list',
      target: '530984257408',
    });
  });

  test('view.attach carries the validated pointer, the target window and a top-left rect', () => {
    const request: NativeWireRequest = {
      id: 'v-2',
      op: 'view.attach',
      view: '530984574464',
      target: '530984257408',
      x: 74,
      y: 86,
      width: 900,
      height: 700,
      autoresize: true,
    };
    const wire = JSON.parse(encodeNativeRequest(request));
    expect(wire).toMatchObject({
      op: 'view.attach',
      view: '530984574464',
      target: '530984257408',
      x: 74,
      y: 86,
      width: 900,
      height: 700,
      autoresize: true,
    });
  });

  test('a list answer is decoded as a result, not as a failure', () => {
    const response = decodeNativeResponse(
      JSON.stringify({
        id: 'v-1',
        ok: true,
        result: [{ ptr: '530984574464', class: 'NSKVONotifying_WKWebView', hidden: false }],
      }),
      'v-1',
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('unreachable');
    expect(Array.isArray(response.result)).toBe(true);
  });

  test('a refused move is a result of false, so the facade can keep the tab docked', () => {
    const response = decodeNativeResponse(
      JSON.stringify({ id: 'v-2', ok: true, result: false }),
      'v-2',
    );
    expect(response).toEqual({ id: 'v-2', ok: true, result: false });
  });
});

describe('top-frame reading (the events do not say which frame they are)', () => {
  // Measured: a claude.ai page in a docked view reported its hCaptcha iframe as a commit/navigate,
  // which put `newassets.hcaptcha.com` in the tab's URL and title. The facade now accepts a reading
  // only when it is the view's own top URL; this is the comparison it uses.
  const CLAUDE = 'https://claude.ai/login';
  const HCAPTCHA =
    'https://newassets.hcaptcha.com/captcha/v1/6fec84af30d156778671fc38c8901981eca61094/static/hcaptcha.html';

  test('the same document compares equal, fragment included or not', () => {
    expect(sameFrameUrl(CLAUDE, CLAUDE)).toBe(true);
    expect(sameFrameUrl(`${CLAUDE}#form`, CLAUDE)).toBe(true);
    expect(sameFrameUrl('http://127.0.0.1:5000/tab', 'http://127.0.0.1:5000/tab')).toBe(true);
  });

  test('a subframe of the page is a different reading', () => {
    expect(sameFrameUrl(HCAPTCHA, CLAUDE)).toBe(false);
    expect(sameFrameUrl('http://127.0.0.1:5000/frame', 'http://127.0.0.1:5000/tab')).toBe(false);
  });

  test('another origin, path or query is a different reading', () => {
    expect(sameFrameUrl('https://claude.ai/login', 'https://claude.ai/new')).toBe(false);
    expect(sameFrameUrl('https://claude.ai/login?next=1', CLAUDE)).toBe(false);
    expect(sameFrameUrl('https://claude.ai.evil.test/login', CLAUDE)).toBe(false);
    expect(sameFrameUrl('http://claude.ai/login', CLAUDE)).toBe(false);
  });

  test('unreadable values compare verbatim, never guessed', () => {
    expect(sameFrameUrl('', '')).toBe(true);
    expect(sameFrameUrl('about:blank', 'about:blank')).toBe(true);
    expect(sameFrameUrl('', CLAUDE)).toBe(false);
  });
});
