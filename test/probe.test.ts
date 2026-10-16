import { describe, expect, test } from 'bun:test';

import { analyzeHtml, cleanTitle, detectProvider, iconType, isIdentityPath } from '../shared/probe';

const BASE = 'https://kanban.x.com/boards';

describe('cleanTitle', () => {
  test('cuts at the first separator and trims', () => {
    expect(cleanTitle('Tool A · Test')).toBe('Tool A');
    expect(cleanTitle('Sprint | Test')).toBe('Sprint');
    expect(cleanTitle('Page — Test')).toBe('Page');
    expect(cleanTitle('Page – Test')).toBe('Page');
    expect(cleanTitle('Page - Test')).toBe('Page');
  });

  test('uses the separator that comes first, not the order of the list', () => {
    expect(cleanTitle('Tool A - Test · everything')).toBe('Tool A');
  });

  test('without a separator it returns the trimmed title', () => {
    expect(cleanTitle('Tool A')).toBe('Tool A');
    expect(cleanTitle('   Tool A   ')).toBe('Tool A');
  });

  test('when the cut leaves nothing, it returns the whole trimmed title', () => {
    expect(cleanTitle(' - Test')).toBe('- Test');
    expect(cleanTitle(' · Test')).toBe('· Test');
  });
});

describe('analyzeHtml', () => {
  test('reads title, icons in preference order and the password form', () => {
    const html = [
      '<html><head>',
      '<TITLE>Tool A · Test</TITLE>',
      "<link href='/a.png' rel='apple-touch-icon'>",
      '<link rel="icon" href="/f.svg" type="image/svg+xml">',
      '<meta property="og:image" content="https://cdn.x/og.png">',
      '</head><body><input type=password></body></html>',
    ].join('\n');

    expect(analyzeHtml(html, BASE)).toEqual({
      title: 'Tool A',
      icons: [
        'https://kanban.x.com/a.png',
        'https://kanban.x.com/f.svg',
        'https://cdn.x/og.png',
        'https://kanban.x.com/favicon.ico',
      ],
      hasLoginForm: true,
    });
  });

  test('an empty page: null title, only the default favicon, no form', () => {
    expect(analyzeHtml('<html><head></head></html>', BASE)).toEqual({
      title: null,
      icons: ['https://kanban.x.com/favicon.ico'],
      hasLoginForm: false,
    });
  });

  test('a blank title becomes null; the one of <title> is decoded', () => {
    expect(analyzeHtml('<title>   </title>', BASE).title).toBeNull();
    expect(analyzeHtml('<html>no title</html>', BASE).title).toBeNull();
    expect(analyzeHtml('<title>Tom &amp; Jerry &#39;x&#39; &lt;z&gt;</title>', BASE).title).toBe(
      "Tom & Jerry 'x' <z>",
    );
  });

  test('attributes in any order, with single or double quotes', () => {
    const html = "<link rel='icon' href='/i.png' type='image/png'>";
    expect(analyzeHtml(html, BASE).icons).toEqual([
      'https://kanban.x.com/i.png',
      'https://kanban.x.com/favicon.ico',
    ]);
  });

  test('an icon without type and without a known extension goes after the png/svg ones', () => {
    const html = [
      '<link rel="icon" href="/no-extension">',
      '<link rel="icon" href="/b.png">',
      '<link rel="shortcut icon" href="/c.svg">',
    ].join('');
    expect(analyzeHtml(html, BASE).icons).toEqual([
      'https://kanban.x.com/b.png',
      'https://kanban.x.com/c.svg',
      'https://kanban.x.com/no-extension',
      'https://kanban.x.com/favicon.ico',
    ]);
  });

  test('apple-touch-icon comes before everything and duplicates are dropped', () => {
    const html = [
      '<link rel="apple-touch-icon" href="/same.png">',
      '<link rel="icon" href="/same.png">',
      '<link rel="apple-touch-icon" href="/same.png">',
    ].join('');
    expect(analyzeHtml(html, BASE).icons).toEqual([
      'https://kanban.x.com/same.png',
      'https://kanban.x.com/favicon.ico',
    ]);
  });

  test('og:image only counts with the exact property and an invalid href is discarded', () => {
    const html = [
      '<meta property="og:image:width" content="https://cdn.x/wide.png">',
      '<meta property="og:image" content="https://cdn.x/og.png">',
      '<link rel="icon" href="http://[">',
    ].join('');
    expect(analyzeHtml(html, BASE).icons).toEqual([
      'https://cdn.x/og.png',
      'https://kanban.x.com/favicon.ico',
    ]);
  });

  test('detects <input type=password> with varied quoting, without confusing other types', () => {
    expect(analyzeHtml('<input type=password>', BASE).hasLoginForm).toBe(true);
    expect(analyzeHtml("<input type='password'>", BASE).hasLoginForm).toBe(true);
    expect(analyzeHtml('<input type="password">', BASE).hasLoginForm).toBe(true);
    expect(analyzeHtml('<INPUT TYPE="Password">', BASE).hasLoginForm).toBe(true);
    expect(analyzeHtml('<input type="text" name="mypassword">', BASE).hasLoginForm).toBe(false);
    expect(analyzeHtml('', BASE).hasLoginForm).toBe(false);
  });

  test('reads only the first 256 KiB', () => {
    const beyond = 'x'.repeat(262_144);
    const analysis = analyzeHtml(`${beyond}<title>Later</title><input type="password">`, BASE);
    expect(analysis).toEqual({
      title: null,
      icons: ['https://kanban.x.com/favicon.ico'],
      hasLoginForm: false,
    });
  });
});

// Review P1: the v1 regexes backtracked over the whole document, so `'<title>'.repeat(300_000)`
// hung the backend. The v2 scan is linear over a 256 KiB slice, so both inputs return at once.
describe('analyzeHtml — ReDoS guard', () => {
  test('a document that repeats `<title>` returns within 200 ms', () => {
    const start = performance.now();
    const analysis = analyzeHtml('<title>'.repeat(300_000), 'https://x.com/');
    const elapsed = performance.now() - start;

    expect(analysis).toEqual({
      title: null,
      icons: ['https://x.com/favicon.ico'],
      hasLoginForm: false,
    });
    expect(elapsed).toBeLessThan(200);
  });

  test('a document that repeats `<link ` returns within 200 ms', () => {
    const start = performance.now();
    const analysis = analyzeHtml('<link '.repeat(300_000), 'https://x.com/');
    const elapsed = performance.now() - start;

    expect(analysis).toEqual({
      title: null,
      icons: ['https://x.com/favicon.ico'],
      hasLoginForm: false,
    });
    expect(elapsed).toBeLessThan(200);
  });
});

describe('isIdentityPath', () => {
  test('recognizes identity provider paths', () => {
    expect(isIdentityPath('https://auth.x.com/realms/x/protocol/openid-connect/auth')).toBe(true);
    expect(isIdentityPath('https://auth.x.com/oauth/authorize')).toBe(true);
    expect(isIdentityPath('https://auth.x.com/oauth2/authorize')).toBe(true);
    expect(isIdentityPath('https://auth.x.com/sso/login')).toBe(true);
    expect(isIdentityPath('https://auth.x.com/saml/acs')).toBe(true);
  });

  test('a plain path is not an identity path', () => {
    expect(isIdentityPath('https://kanban.x.com/boards/1')).toBe(false);
    expect(isIdentityPath('https://kanban.x.com/boards')).toBe(false);
  });

  test('an invalid URL is not an identity path', () => {
    expect(isIdentityPath('not a url')).toBe(false);
  });
});

describe('detectProvider', () => {
  test('an origin other than the entry one is the provider', () => {
    expect(detectProvider('https://kanban.x.com', 'https://auth.x.com/realms/a')).toBe(
      'https://auth.x.com',
    );
  });

  test('same origin with a login flow path returns that origin', () => {
    expect(detectProvider('https://auth.x.com', 'https://auth.x.com/oauth/authorize')).toBe(
      'https://auth.x.com',
    );
    expect(detectProvider('https://auth.x.com', 'https://auth.x.com/realms/copland')).toBe(
      'https://auth.x.com',
    );
    expect(detectProvider('https://auth.x.com', 'https://auth.x.com/sso/login')).toBe(
      'https://auth.x.com',
    );
    expect(detectProvider('https://auth.x.com', 'https://auth.x.com/saml/acs')).toBe(
      'https://auth.x.com',
    );
  });

  test('same origin without a provider sign is nothing', () => {
    expect(detectProvider('https://kanban.x.com', 'https://kanban.x.com/boards')).toBeNull();
  });

  test('an invalid URL is not a provider', () => {
    expect(detectProvider('https://kanban.x.com', 'not a url')).toBeNull();
  });
});

describe('iconType', () => {
  test('ico is refused even with a missing or icon content type', () => {
    expect(iconType('https://x/a.ico', null)).toBeNull();
    expect(iconType('https://x/a', 'image/x-icon')).toBeNull();
  });

  test('the content type wins when it is recognized', () => {
    expect(iconType('https://x/a', 'image/png')).toBe('png');
    expect(iconType('https://x/a.png', 'image/webp')).toBe('webp');
    expect(iconType('https://x/a', 'image/svg+xml; charset=utf-8')).toBe('svg');
    expect(iconType('https://x/a', 'IMAGE/PNG')).toBe('png');
  });

  test('without a useful content type it decides by the path extension', () => {
    expect(iconType('https://x/a.SVG', null)).toBe('svg');
    expect(iconType('https://x/a.jpg', null)).toBe('jpeg');
    expect(iconType('https://x/a.jpeg', null)).toBe('jpeg');
    expect(iconType('https://x/a.webp', 'application/octet-stream')).toBe('webp');
    expect(iconType('https://x/a.png?x=1', 'text/html')).toBe('png');
  });

  test('an unknown content type is never taken from Object.prototype', () => {
    expect(iconType('https://x/a', 'constructor')).toBeNull();
    expect(iconType('https://x/a.constructor', null)).toBeNull();
    expect(iconType('https://x/a.toString', null)).toBeNull();
  });

  test('an unknown extension or a URL without extension is null', () => {
    expect(iconType('https://x/a.gif', null)).toBeNull();
    expect(iconType('https://x/a', 'application/octet-stream')).toBeNull();
    expect(iconType('https://x/no-dot/a', null)).toBeNull();
  });
});
