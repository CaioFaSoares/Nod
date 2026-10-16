// Assisted registration probe (canonico §8, RF-29; docs/arquitetura.md §3).
// Pure logic: it reads a string, with no DOM, no `tiny` and no `tjs`. Fetching the page is
// `backend/probe-net.ts`'s job; here we only read what came back.
//
// Security fix (review P1): the v1 regexes (`[\s\S]*?` with no closing match, `[^>]*` with no `>`)
// backtracked over the whole document, so a page that repeats `<title>` hung the backend. Here the
// document is cut at 256 KiB and every scan is a forward walk: `indexOf` for the next `<`, `indexOf`
// for the next `>`, and the attributes are read inside one tag with a bounded loop. Tags are visited
// left to right and each closed tag moves the cursor past its `>`, so no region is scanned twice.

import type { RawIcon } from './types';

/** Only the first 256 KiB of the page is read (docs/arquitetura.md §3). */
const MAX_HTML_SCAN = 262_144;

/** A name longer than this cannot be one of the tags we look for. */
const MAX_TAG_NAME = 16;

/** The v1 regex asked for this exact closing tag; `<title >` was not a match there either. */
const TITLE_CLOSE = '</title>';

const TITLE_SEPARATORS = [' · ', ' | ', ' — ', ' – ', ' - '];

// `&amp;` last so that `&amp;lt;` does not decode twice into `<`.
const ENTITIES: Array<[RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

const IDENTITY_PATH = /(oauth2?|oidc|openid|authorize|realms\/|\/sso\b|saml)/i;

/** Whitespace as HTML understands it. */
function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

// Word character for the `\b` of the v1 regexes (`\bicon\b`, `\btype`); the caller already lowercases.
const WORD_CHAR = /[a-z0-9_]/;
// Character of an HTML name: letter, digit, `-` or `_` (either case).
const NAME_CHAR = /[a-zA-Z0-9_-]/;

/** Does `text` contain `word` with word boundaries on both sides? `charAt` past an end is `''`. */
function hasWord(text: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(word, from);
    if (index < 0) return false;
    const before = text.charAt(index - 1);
    const after = text.charAt(index + word.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = index + 1;
  }
}

/** The tag name that starts at `index`, lowercased; `''` when there is none. */
function tagNameAt(html: string, index: number): string {
  const limit = Math.min(html.length, index + MAX_TAG_NAME);
  let end = index;
  while (end < limit && NAME_CHAR.test(html.charAt(end))) end++;
  return html.slice(index, end).toLowerCase();
}

/** ASCII-case-insensitive prefix test, without building a regex per tag. */
function matchesAt(html: string, index: number, text: string): boolean {
  if (index + text.length > html.length) return false;
  for (let i = 0; i < text.length; i++) {
    let code = html.charCodeAt(index + i);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Position of the first `</title>` at or after `from`, or -1. */
function findTitleClose(html: string, from: number): number {
  let at = from;
  for (;;) {
    const index = html.indexOf('<', at);
    if (index < 0) return -1;
    if (matchesAt(html, index, TITLE_CLOSE)) return index;
    at = index + 1;
  }
}

/**
 * Attributes of one tag — the text between its `<` and its `>` — without backtracking: name, `=`,
 * then a quoted or unquoted value, always advancing. The first occurrence of a name wins, like the
 * v1 regex; an attribute without `=` is ignored, which the v1 regex also did.
 */
function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let i = 0;
  while (i < tag.length) {
    while (i < tag.length && (isSpace(tag.charAt(i)) || tag.charAt(i) === '/')) i++;
    if (i >= tag.length) break;

    const nameStart = i;
    while (i < tag.length && !isSpace(tag.charAt(i)) && tag.charAt(i) !== '=') i++;
    const name = tag.slice(nameStart, i).toLowerCase();

    while (i < tag.length && isSpace(tag.charAt(i))) i++;
    if (tag.charAt(i) !== '=') continue; // no value: not an attribute the v1 regex would read
    i++;
    while (i < tag.length && isSpace(tag.charAt(i))) i++;

    const quote = tag.charAt(i);
    let value: string;
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, i + 1);
      if (end < 0) {
        value = tag.slice(i + 1);
        i = tag.length;
      } else {
        value = tag.slice(i + 1, end);
        i = end + 1;
      }
    } else {
      const valueStart = i;
      while (i < tag.length && !isSpace(tag.charAt(i))) i++;
      value = tag.slice(valueStart, i);
    }

    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

/** Lowercased extension of an href without its query or fragment (`''` when there is none). */
function extensionOf(href: string): string {
  const path = href.split('?')[0].split('#')[0].toLowerCase();
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1);
}

function decodeEntities(text: string): string {
  let decoded = text;
  for (const [pattern, value] of ENTITIES) decoded = decoded.replace(pattern, value);
  return decoded;
}

/** `<title>Tool A · Test</title>` → `'Tool A'`. Without a separator, the trimmed title. */
export function cleanTitle(title: string): string {
  let cut = -1;
  for (const separator of TITLE_SEPARATORS) {
    const index = title.indexOf(separator);
    if (index >= 0 && (cut < 0 || index < cut)) cut = index;
  }

  const trimmed = title.trim();
  if (cut < 0) return trimmed;

  const clean = title.slice(0, cut).trim();
  return clean === '' ? trimmed : clean;
}

/**
 * Reads title, icons and login form from a page.
 * Icons by preference: `apple-touch-icon`, `<link rel~=icon>` (png/svg before the rest), `og:image`
 * and, last, `/favicon.ico`. All absolute and without repetition.
 */
export function analyzeHtml(
  html: string,
  finalUrl: string,
): { title: string | null; icons: string[]; hasLoginForm: boolean } {
  const page = html.slice(0, MAX_HTML_SCAN);

  let title: string | null = null;
  let titleSearched = false;
  let hasLoginForm = false;
  const apple: string[] = [];
  const preferred: string[] = [];
  const others: string[] = [];
  const og: string[] = [];

  let cursor = 0;
  for (;;) {
    const open = page.indexOf('<', cursor);
    if (open < 0) break;
    cursor = open + 1;

    const name = tagNameAt(page, open + 1);
    if (name !== 'title' && name !== 'link' && name !== 'meta' && name !== 'input') continue;

    // The tag runs to the next '>'. Each closed tag moves the cursor past it, so these scans never
    // overlap and a document with no '>' at all costs exactly one pass.
    const close = page.indexOf('>', open);
    if (close < 0) break;
    cursor = close + 1;

    if (name === 'title') {
      if (titleSearched) continue;
      titleSearched = true;
      const end = findTitleClose(page, close + 1);
      if (end < 0) continue;
      const clean = cleanTitle(decodeEntities(page.slice(close + 1, end)));
      title = clean === '' ? null : clean;
      continue;
    }

    const attributes = parseAttributes(page.slice(open + 1, close));

    if (name === 'input') {
      if ((attributes.get('type') ?? '').trim().toLowerCase() === 'password') hasLoginForm = true;
      continue;
    }

    if (name === 'meta') {
      if ((attributes.get('property') ?? '').trim().toLowerCase() === 'og:image') {
        const content = attributes.get('content');
        if (content !== undefined && content !== '') og.push(content);
      }
      continue;
    }

    // name === 'link'
    const href = attributes.get('href');
    if (href === undefined || href === '') continue;
    const rel = (attributes.get('rel') ?? '').toLowerCase();
    if (rel.includes('apple-touch-icon')) {
      apple.push(href);
      continue;
    }
    if (!hasWord(rel, 'icon')) continue;
    const type = (attributes.get('type') ?? '').trim().toLowerCase();
    const extension = extensionOf(href);
    if (type === 'image/png' || type === 'image/svg+xml' || extension === 'png' || extension === 'svg') {
      preferred.push(href);
    } else {
      others.push(href);
    }
  }

  const icons: string[] = [];
  const seen = new Set<string>();
  for (const href of [...apple, ...preferred, ...others, ...og, '/favicon.ico']) {
    let absolute: string;
    try {
      absolute = new URL(href, finalUrl).href;
    } catch {
      continue; // href relative to an invalid base: there is nothing to resolve.
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    icons.push(absolute);
  }

  return { title, icons, hasLoginForm };
}

/** Origin of the identity provider when the page leaves the entry origin, or when the path is
 * already a login/OIDC flow of that same origin. `null` outside that. */
export function detectProvider(entryOrigin: string, finalUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return null;
  }
  if (url.origin !== entryOrigin) return url.origin;
  return IDENTITY_PATH.test(url.pathname) ? url.origin : null;
}

/** Does the URL path look like an identity provider flow? An invalid URL is not one. */
export function isIdentityPath(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return IDENTITY_PATH.test(parsed.pathname);
}

// Static lookup tables. `Object.hasOwn` because the keys come from the network: a bogus
// `Content-Type: constructor` must not reach `Object.prototype`.
const ICON_TYPE_BY_CONTENT_TYPE: Record<string, RawIcon['type']> = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

const ICON_TYPE_BY_EXTENSION: Record<string, RawIcon['type']> = {
  png: 'png',
  svg: 'svg',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
};

/** Icon type from the content type and, when that is not enough, from the path extension.
 * ICO → `null`. */
export function iconType(url: string, contentType: string | null): RawIcon['type'] | null {
  if (contentType !== null && contentType !== '') {
    const base = contentType.split(';')[0].trim().toLowerCase();
    if (Object.hasOwn(ICON_TYPE_BY_CONTENT_TYPE, base)) return ICON_TYPE_BY_CONTENT_TYPE[base];
  }

  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Relative or invalid URL: try the extension on the text that came in.
  }

  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(ICON_TYPE_BY_EXTENSION, extension) ? ICON_TYPE_BY_EXTENSION[extension] : null;
}
