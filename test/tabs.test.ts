// Proves the visible behavior of `shared/tabs.ts` (slice acceptance, E03).
// Run with `bun test test/`.
//
// Only behavior and its boundaries are pinned here: which id a new tab gets, where a link lands in
// the strip, which tab survives a close, which URLs may become tabs, the slot→screen formula
// (`docs/handovers/e03-spikes.md` §3), the `open_tools` reader and the save-by-origin rule. The
// backend's live calls and the page's rendering are not this module's business.

import { describe, expect, test } from 'bun:test';
import {
  EMBED_WINDOW_PREFIX,
  LINK_WINDOW_PREFIX,
  defaultMode,
  embedWindowId,
  frameability,
  insertAfter,
  linkWindowId,
  neighbourAfterClose,
  nextEmbedNumber,
  nextLinkNumber,
  nextTabNumber,
  parseLinkUrl,
  parseOpenLink,
  parsePersistedTabs,
  rectEquals,
  saveTarget,
  slotToScreen,
  stepTab,
  tabWindowId,
} from '../shared/tabs';
import type { SlotRect } from '../shared/types';

describe('tab window ids', () => {
  test('a further tab of a tool is tool_<id>_t<n>, n from 2', () => {
    expect(tabWindowId('claude', 2)).toBe('tool_claude_t2');
    expect(tabWindowId('kanban', 5)).toBe('tool_kanban_t5');
  });

  test('the ad-hoc prefix is link_ and its ids count from 1', () => {
    expect(LINK_WINDOW_PREFIX).toBe('link_');
    expect(linkWindowId(1)).toBe('link_1');
    expect(linkWindowId(7)).toBe('link_7');
  });

  test('nextTabNumber is the first n >= 2 still free', () => {
    // The tool's own window and a `window` view (`tool_claude_1`) never collide with `_t<n>`.
    expect(nextTabNumber('claude', ['tool_claude', 'tool_claude_1'])).toBe(2);
    expect(nextTabNumber('claude', ['tool_claude', 'tool_claude_t2', 'tool_claude_t3'])).toBe(4);
    // A gap is reused: the runtime never reuses a popup id while it lives, the Nod does reuse a
    // closed tab's number.
    expect(nextTabNumber('claude', ['tool_claude_t2', 'tool_claude_t4'])).toBe(3);
    // Another tool's tabs do not count.
    expect(nextTabNumber('claude', ['tool_kanban_t2', 'tool_kanban_t3'])).toBe(2);
    expect(nextTabNumber('claude', [])).toBe(2);
  });

  test('nextLinkNumber is the first n >= 1 still free', () => {
    expect(nextLinkNumber([])).toBe(1);
    expect(nextLinkNumber(['link_1', 'link_2'])).toBe(3);
    expect(nextLinkNumber(['link_1', 'link_3'])).toBe(2);
    expect(nextLinkNumber(['tool_claude_t2'])).toBe(1);
  });
});

describe('embedded tab ids (RF-69)', () => {
  test('the first embedded tab is embed_<tool>, every further one _t<n> from 2', () => {
    expect(EMBED_WINDOW_PREFIX).toBe('embed_');
    expect(embedWindowId('claude')).toBe('embed_claude');
    expect(embedWindowId('claude', 1)).toBe('embed_claude');
    expect(embedWindowId('claude', 2)).toBe('embed_claude_t2');
    expect(embedWindowId('kanban', 5)).toBe('embed_kanban_t5');
  });

  test('nextEmbedNumber is the first n >= 2 still free', () => {
    expect(nextEmbedNumber('claude', [])).toBe(2);
    expect(nextEmbedNumber('claude', ['embed_claude'])).toBe(2);
    expect(nextEmbedNumber('claude', ['embed_claude', 'embed_claude_t2'])).toBe(3);
    expect(nextEmbedNumber('claude', ['embed_claude_t2', 'embed_claude_t4'])).toBe(3);
    expect(nextEmbedNumber('claude', ['tool_claude_t2'])).toBe(2);
  });
});

describe('frameability', () => {
  test('no restrictive header means the address may be framed', () => {
    expect(frameability({})).toEqual({ frameable: true, reason: null });
    expect(frameability({ 'content-type': 'text/html' })).toEqual({ frameable: true, reason: null });
  });

  test('X-Frame-Options refuses the frame whatever its value', () => {
    expect(frameability({ 'X-Frame-Options': 'DENY' })).toEqual({
      frameable: false,
      reason: 'X-Frame-Options: DENY',
    });
    expect(frameability({ 'x-frame-options': 'SAMEORIGIN' })).toEqual({
      frameable: false,
      reason: 'X-Frame-Options: SAMEORIGIN',
    });
    expect(frameability({ 'X-FRAME-OPTIONS': 'ALLOW-FROM https://a.example' })).toEqual({
      frameable: false,
      reason: 'X-Frame-Options: ALLOW-FROM https://a.example',
    });
  });

  test('a CSP frame-ancestors other than exactly * refuses the frame', () => {
    expect(frameability({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" })).toEqual({
      frameable: false,
      reason: "frame-ancestors 'self'",
    });
    expect(frameability({ 'Content-Security-Policy': 'frame-ancestors https://app.example' })).toEqual({
      frameable: false,
      reason: 'frame-ancestors https://app.example',
    });
    expect(frameability({ 'content-security-policy': 'frame-ancestors' })).toEqual({
      frameable: false,
      reason: 'frame-ancestors',
    });
  });

  test('frame-ancestors * is the one accepted value', () => {
    expect(frameability({ 'content-security-policy': 'frame-ancestors *' })).toEqual({
      frameable: true,
      reason: null,
    });
    expect(
      frameability({ 'content-security-policy': "script-src 'self'; frame-ancestors *; object-src 'none'" }),
    ).toEqual({ frameable: true, reason: null });
  });

  test('multiple CSP headers are all enforced', () => {
    expect(
      frameability({
        'content-security-policy': 'frame-ancestors *, default-src \'self\', frame-ancestors https://a.example',
      }),
    ).toEqual({ frameable: false, reason: 'frame-ancestors https://a.example' });
  });
});

describe('strip order', () => {
  test('insertAfter puts the new id right after its opener', () => {
    expect(insertAfter(['a', 'b', 'c'], 'b', 'x')).toEqual(['a', 'b', 'x', 'c']);
  });

  test('insertAfter appends when there is no opener or the opener is gone', () => {
    expect(insertAfter(['a', 'b'], null, 'x')).toEqual(['a', 'b', 'x']);
    expect(insertAfter(['a', 'b'], 'z', 'x')).toEqual(['a', 'b', 'x']);
    expect(insertAfter([], null, 'x')).toEqual(['x']);
  });

  test('insertAfter does not mutate the order it is given', () => {
    const order = ['a', 'b'];
    insertAfter(order, 'a', 'x');
    expect(order).toEqual(['a', 'b']);
  });

  test('neighbourAfterClose prefers the right, then the left', () => {
    expect(neighbourAfterClose(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbourAfterClose(['a', 'b', 'c'], 'a')).toBe('b');
    expect(neighbourAfterClose(['a', 'b', 'c'], 'c')).toBe('b');
  });

  test('neighbourAfterClose has none for the only tab or an unknown id', () => {
    expect(neighbourAfterClose(['a'], 'a')).toBeNull();
    expect(neighbourAfterClose(['a', 'b'], 'z')).toBeNull();
    expect(neighbourAfterClose([], 'a')).toBeNull();
  });

  test('stepTab walks and wraps both ways', () => {
    const order = ['a', 'b', 'c'];
    expect(stepTab(order, 'b', 1)).toBe('c');
    expect(stepTab(order, 'b', -1)).toBe('a');
    expect(stepTab(order, 'c', 1)).toBe('a');
    expect(stepTab(order, 'a', -1)).toBe('c');
  });

  test('stepTab with no current tab starts at an end, by direction', () => {
    const order = ['a', 'b', 'c'];
    expect(stepTab(order, null, 1)).toBe('a');
    expect(stepTab(order, null, -1)).toBe('c');
    // An id no longer in the strip behaves like no current tab.
    expect(stepTab(order, 'z', 1)).toBe('a');
    expect(stepTab(order, 'z', -1)).toBe('c');
  });

  test('stepTab has none for an empty strip', () => {
    expect(stepTab([], null, 1)).toBeNull();
    expect(stepTab([], null, -1)).toBeNull();
  });
});

describe('parseLinkUrl', () => {
  test('a bare host is read as https', () => {
    expect(parseLinkUrl('example.com/x')).toBe('https://example.com/x');
    expect(parseLinkUrl('  example.com  ')).toBe('https://example.com/');
  });

  test('an http(s) URL is returned as its href', () => {
    expect(parseLinkUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1');
    expect(parseLinkUrl('http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/a');
  });

  test('empty and whitespace answer null', () => {
    expect(parseLinkUrl('')).toBeNull();
    expect(parseLinkUrl('   ')).toBeNull();
  });

  test('every non-web scheme is refused', () => {
    expect(parseLinkUrl('javascript:alert(1)')).toBeNull();
    expect(parseLinkUrl('file:///etc/passwd')).toBeNull();
    expect(parseLinkUrl('data:text/html,hi')).toBeNull();
    expect(parseLinkUrl('mailto:a@b.com')).toBeNull();
    expect(parseLinkUrl('ftp://example.com/x')).toBeNull();
  });

  test('an http(s) URL with no host is refused', () => {
    expect(parseLinkUrl('https://')).toBeNull();
    expect(parseLinkUrl('http:')).toBeNull();
  });

  test('an address that carries credentials is refused', () => {
    // It would be written to `store.json`, audited and shown in the sidebar: a password in it is a
    // secret on disk and in a list.
    expect(parseLinkUrl('https://ana:s3cret@kanban.example/app')).toBeNull();
    expect(parseLinkUrl('https://ana@kanban.example/app')).toBeNull();
    expect(parseLinkUrl('https://:s3cret@kanban.example/app')).toBeNull();
    // The host alone, the only part that is safe to show, still opens.
    expect(parseLinkUrl('https://kanban.example/app')).toBe('https://kanban.example/app');
  });

  test('an address past 2048 characters is refused', () => {
    const long = (path: number): string => `https://kanban.example/${'a'.repeat(path)}`;
    expect(parseLinkUrl(long(2025))?.length).toBe(2048); // the boundary itself still opens
    expect(parseLinkUrl(long(2026))).toBeNull();
  });
});

describe('parseOpenLink', () => {
  const link = (url: string) => `nod://open?url=${encodeURIComponent(url)}`;

  test('reads the carried url back through parseLinkUrl', () => {
    expect(parseOpenLink(link('https://example.com/x'))).toBe('https://example.com/x');
    // A bare host inside the deep link gets the same https treatment.
    expect(parseOpenLink(link('example.com/x'))).toBe('https://example.com/x');
  });

  test('the scheme is case-insensitive', () => {
    expect(parseOpenLink('NOD://open?url=https%3A%2F%2Fexample.com%2Fx')).toBe('https://example.com/x');
  });

  test('another action answers null', () => {
    expect(parseOpenLink('nod://join?host=a&fp=b')).toBeNull();
    expect(parseOpenLink('nod://save?url=https%3A%2F%2Fexample.com')).toBeNull();
  });

  test('a missing or unacceptable url answers null', () => {
    expect(parseOpenLink('nod://open')).toBeNull();
    expect(parseOpenLink('nod://open?url=')).toBeNull();
    expect(parseOpenLink(`nod://open?url=${encodeURIComponent('javascript:alert(1)')}`)).toBeNull();
  });

  test('any other scheme or a plain url answers null', () => {
    expect(parseOpenLink('https://example.com')).toBeNull();
    expect(parseOpenLink('nod:open?url=https%3A%2F%2Fexample.com')).toBe('https://example.com/');
  });
});

describe('slotToScreen', () => {
  test('a macOS main window shifts by its title bar and half its side borders', () => {
    // Measured shape (`docs/handovers/e03-spikes.md` §3): outer 1100x752, page 1100x720, slot at
    // (40,60) 500x340.
    expect(
      slotToScreen(
        { x: 597, y: 207, width: 1100, height: 720, outer: { width: 1100, height: 752 } },
        { x: 40, y: 60, width: 500, height: 340 },
      ),
    ).toEqual({ x: 637, y: 299, width: 500, height: 340 });
  });

  test('the title bar contributes its whole height (outer 900x632, page 900x600)', () => {
    expect(
      slotToScreen(
        { x: 0, y: 0, width: 900, height: 600, outer: { width: 900, height: 632 } },
        { x: 0, y: 0, width: 900, height: 600 },
      ),
    ).toEqual({ x: 0, y: 32, width: 900, height: 600 });
  });

  test('an odd border width rounds to whole points', () => {
    // dx = 1 → half a point, rounded to the nearest integer.
    expect(
      slotToScreen(
        { x: 10, y: 10, width: 900, height: 600, outer: { width: 901, height: 601 } },
        { x: 14, y: 5, width: 100, height: 50 },
      ),
    ).toEqual({ x: 25, y: 16, width: 100, height: 50 });
  });
});

describe('rectEquals', () => {
  const rect: SlotRect = { x: 1, y: 2, width: 3, height: 4 };

  test('same fields are equal', () => {
    expect(rectEquals(rect, { ...rect })).toBe(true);
    expect(rectEquals(null, null)).toBe(true);
  });

  test('a changed field is not equal', () => {
    expect(rectEquals(rect, { ...rect, x: 9 })).toBe(false);
    expect(rectEquals(rect, { ...rect, height: 5 })).toBe(false);
  });

  test('a rect and no rect are not equal', () => {
    expect(rectEquals(rect, null)).toBe(false);
    expect(rectEquals(null, rect)).toBe(false);
  });
});

describe('parsePersistedTabs', () => {
  test('anything but an array answers []', () => {
    expect(parsePersistedTabs(undefined)).toEqual([]);
    expect(parsePersistedTabs(null)).toEqual([]);
    expect(parsePersistedTabs({ toolId: 'kanban' })).toEqual([]);
    expect(parsePersistedTabs('kanban')).toEqual([]);
  });

  test('the old {toolId, view?} format still reads', () => {
    expect(parsePersistedTabs([{ toolId: 'kanban' }, { toolId: 'mail', view: 1 }])).toEqual([
      { toolId: 'kanban' },
      { toolId: 'mail', view: 1 },
    ]);
  });

  test('a malformed item is dropped', () => {
    expect(
      parsePersistedTabs([
        null,
        42,
        [],
        { toolId: '' },
        { toolId: 5 },
        { toolId: 'x', view: -1 },
        { toolId: 'x', view: 1.5 },
        { toolId: 'x', view: '1' },
        { toolId: 'ok' },
      ]),
    ).toEqual([{ toolId: 'ok' }]);
  });

  test('a url is kept only when it is one the Nod may open', () => {
    expect(
      parsePersistedTabs([
        { toolId: 'a', url: 'https://a.example/p' },
        { toolId: 'b', url: 'javascript:alert(1)' },
        { toolId: 'c', url: '' },
        { toolId: 'd', url: 7 },
      ]),
    ).toEqual([{ toolId: 'a', url: 'https://a.example/p' }, { toolId: 'b' }, { toolId: 'c' }, { toolId: 'd' }]);
  });

  test('detached is kept only when exactly true', () => {
    expect(
      parsePersistedTabs([
        { toolId: 'a', detached: true },
        { toolId: 'b', detached: false },
        { toolId: 'c', detached: 'yes' },
      ]),
    ).toEqual([{ toolId: 'a', detached: true }, { toolId: 'b' }, { toolId: 'c' }]);
  });

  test('only the first active item stays active', () => {
    expect(
      parsePersistedTabs([
        { toolId: 'a' },
        { toolId: 'b', active: true },
        { toolId: 'c', active: true },
        { toolId: 'd', active: false },
      ]),
    ).toEqual([{ toolId: 'a' }, { toolId: 'b', active: true }, { toolId: 'c' }, { toolId: 'd' }]);
  });
});

describe('saveTarget', () => {
  const entries = [
    { id: 'claude', url: 'https://claude.example' },
    { id: 'kanban', url: 'https://kanban.example' },
  ];

  test('the same origin as a visible tool becomes a view of it', () => {
    expect(saveTarget('https://kanban.example/board?x=1', entries)).toEqual({ kind: 'view', entryId: 'kanban' });
    expect(saveTarget('https://claude.example/chat/1', entries)).toEqual({ kind: 'view', entryId: 'claude' });
  });

  test('the first matching entry wins', () => {
    expect(
      saveTarget('https://kanban.example/board', [
        { id: 'kanban-a', url: 'https://kanban.example/a' },
        { id: 'kanban-b', url: 'https://kanban.example/b' },
      ]),
    ).toEqual({ kind: 'view', entryId: 'kanban-a' });
  });

  test('another origin becomes a new tool', () => {
    expect(saveTarget('https://other.example/p', entries)).toEqual({ kind: 'tool' });
    expect(saveTarget('https://other.example/p', [])).toEqual({ kind: 'tool' });
  });

  test('a url that is not http(s) is not saved', () => {
    expect(saveTarget('file:///x', entries)).toBeNull();
    expect(saveTarget('mailto:a@b.com', entries)).toBeNull();
    expect(saveTarget('', entries)).toBeNull();
    expect(saveTarget('not a url', entries)).toBeNull();
  });

  test('an entry with an unusable url never blocks the others', () => {
    expect(
      saveTarget('https://kanban.example/board', [
        { id: 'broken', url: 'not a url' },
        { id: 'kanban', url: 'https://kanban.example' },
      ]),
    ).toEqual({ kind: 'view', entryId: 'kanban' });
  });
});

describe('defaultMode', () => {
  test('docked on macOS, windows elsewhere', () => {
    expect(defaultMode('macos')).toBe('docked');
    expect(defaultMode('windows')).toBe('windows');
    expect(defaultMode('linux')).toBe('windows');
  });
});
