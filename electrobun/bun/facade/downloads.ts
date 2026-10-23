// Sandboxed-view downloads for the Electrobun target (E06 surface-check finding 10).
//
// Why this file exists. On the Electrobun target every tool, popup and ad-hoc view is created
// `sandbox: true` (contract invariant). The devkit's own download path is a WKDownload whose
// destination is the account's `~/Downloads` directory, decided inside `libNativeWrapper.dylib`
// (`download:decideDestinationUsingResponse:suggestedFilename:completionHandler:`); WebKit asks the
// system for a sandbox extension for that path, and a packaged Nod cannot get one:
//
//   sandbox_extension_issue_file failed for /Users/caio/Downloads: 1 (Operation not permitted)
//   (docs/handovers/e06-surface-check.md, item 10)
//
// No FFI symbol exposes the destination (`proc/native.ts` has the four `download-*` events and
// nothing else), and the failure happens before any delegate callback, so neither
// `download-completed` nor `download-failed` ever fires. The one thing this target CAN do is let the
// page ask the host to save the file: the sandboxed preload (`view/tool-bridge.ts`) intercepts a
// click on `<a download>` and sends `{ method: 'nod.download', params }` over
// `__electrobunSendToHost`, the one channel a sandbox keeps. This module is the host half: it fetches
// (or takes the page's own bytes for a `blob:`/`data:` URL), writes into `~/Downloads` with the
// de-dup naming the engine uses, and reports through `onDownload` exactly like the native path does.
//
// Policy (security, see `facade/gate.ts` for where the request is admitted):
//   - only views that are not the main window (`main` keeps the native path);
//   - only from a view whose committed origin the runtime observed;
//   - a URL is fetched only when it is SAME ORIGIN with that view: the HTML `download` attribute is
//     ignored for cross-origin URLs, so this matches the browser rule and keeps the host from
//     becoming a fetch proxy for any other host (a page can already talk to its own server);
//   - the origin's cookies are attached for the initial request, and recomputed per redirect hop so
//     a cross-origin redirect never receives them;
//   - the only bytes written are the response body, or `blob:`/`data:` bytes the page itself
//     produced, always inside `~/Downloads`, never through a path the page supplies;
//   - the page gets back only `{ filename, path }` (or the error message), never the body.
//
// Unlike tinyjs' engine, which owns the whole webview, this path is a *substitute* for the broken
// native one: it covers a click on `<a download>` and blob/data links. A server that answers a plain
// navigation (no `download` attribute, no page-side blob) with `Content-Disposition: attachment`
// still reaches the native WKDownload and still fails — that gap is recorded in the handover, not
// hidden here.

import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ViewKind } from './gate-core';

/** The reserved shell method the sandboxed preload sends for a download click. Not an api method. */
export const DOWNLOAD_METHOD = 'nod.download';

/** The devkit's partition when a view does not set one (`proc/native.ts`: `persist:default`). */
export const DOWNLOAD_PARTITION = 'persist:default';

/** `blob:`/`data:` bytes are carried inline as base64; this is the ceiling for one file. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** Redirect hops followed before giving up (a browser stops earlier on a loop). */
const MAX_REDIRECTS = 8;

/** Longest basename written; APFS allows 255 bytes, the UI does not need the last ones. */
const MAX_NAME_LENGTH = 180;

/** A download request, as the gate forwards it: the observed view, never the page's claims. */
export interface DownloadOrigin {
  windowId: string;
  kind: ViewKind;
  /** The origin `did-commit-navigation` last reported for the view, `null` when unknown. */
  origin: string | null;
}

/** What the gate gets back for a page that used `tiny.api.call('nod.download', …)`. */
export type DownloadAnswer =
  | { ok: true; result: { filename: string; path: string } }
  | { ok: false; error: string };

export interface DownloadSink {
  /** Accepts (or refuses) one page request. Never throws; every refusal is an answered failure. */
  request(view: DownloadOrigin, params: unknown): Promise<DownloadAnswer>;
}

export interface DownloadOptions {
  /** `~/Downloads` (tinyjs `downloads: 'auto'` destination); `null` when it cannot be resolved. */
  saveDir(): string | null;
  /** Cookies for a URL, from the view's session; `''` when there are none. */
  cookieHeader?(url: string): string;
  /** The backend's `onDownload` (`backend/main.ts`): `done`/`failed` become the audit event. */
  onDownload?(info: TinyDownloadEvent): void;
}

/** One admitted request, decoded from the page's JSON. */
interface Request {
  /** Same-origin http(s) URL, when the file is fetched by the host. */
  url: string | null;
  /** Bytes the page produced (`blob:`/`data:`), base64. */
  data: string | null;
  /** The `download` attribute's value, when it had one. */
  filename: string | null;
  /** A page-side failure (`blob:` read, size ceiling): nothing to fetch, report it. */
  error: string | null;
}

/** Last path segment of a URL, percent-decoded; `null` when there is none. */
function nameFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const raw = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
  if (raw === '') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * A basename that can only land inside `~/Downloads`: no separators, no control characters, no
 * leading dot (a page must not create hidden files), no `..`, a bounded length. `'download'` when
 * nothing usable is left.
 */
export function safeName(candidate: string | null): string {
  if (candidate === null) return 'download';
  const last = candidate.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/:/g, '-')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'download';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  // Keep the extension when the name has to be shortened.
  const dot = cleaned.lastIndexOf('.');
  if (dot > 0 && cleaned.length - dot <= 16) {
    const ext = cleaned.slice(dot);
    return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/** `Content-Disposition`'s own name (`filename*` first, then `filename`), when it carries one. */
function nameFromDisposition(header: string | null): string | null {
  if (header === null || header === '') return null;
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended !== null && extended[1] !== undefined) {
    const value = extended[1].trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted !== null && quoted[1] !== undefined) return quoted[1];
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  return bare !== null && bare[1] !== undefined ? bare[1].trim() : null;
}

/** Readable message of anything a filesystem or fetch call threw. */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

/** A filesystem error's `code` (`EEXIST`, `EPERM`, …), `null` when it has none. */
function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

/** Writes `bytes` at the first free de-duped name; answers the path or the failure sentence. */
function save(dir: string, filename: string, bytes: Uint8Array): { path: string; filename: string } | string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let index = 0; index < 1000; index += 1) {
    const name = index === 0 ? `${stem}${ext}` : `${stem} (${index})${ext}`;
    const candidate = join(dir, name);
    let fd: number;
    try {
      fd = openSync(candidate, 'wx');
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      return `Cannot create file: ${errorMessage(error)}`;
    }
    try {
      writeSync(fd, bytes);
    } catch (error) {
      closeSync(fd);
      // A half-written file must not keep the name: the next attempt gets the plain name back.
      try {
        unlinkSync(candidate);
      } catch {
        // the file is gone already
      }
      return `Cannot write file: ${errorMessage(error)}`;
    }
    closeSync(fd);
    return { path: candidate, filename: name };
  }
  return 'Cannot create file: too many files with that name';
}

/**
 * Decoded request. A malformed payload is not thrown away: it comes back with `error` set, so the
 * refusal is audited exactly like a failed transfer (the backend records `done`/`failed` only).
 */
function readRequest(params: unknown): Request {
  const empty: Request = { url: null, data: null, filename: null, error: null };
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ...empty, error: 'the download request carried no parameters' };
  }
  // The page's JSON: `object` narrowed to a record so its fields can be read with `typeof`. Every
  // read below is checked; nothing about the value is trusted.
  const body = params as Record<string, unknown>;
  const rawUrl = typeof body.url === 'string' && body.url !== '' ? body.url : null;
  const rawData = typeof body.data === 'string' && body.data !== '' ? body.data : null;
  const filename =
    typeof body.filename === 'string' && body.filename.trim() !== '' ? body.filename.trim() : null;
  const error = typeof body.error === 'string' && body.error !== '' ? body.error : null;
  if (rawData !== null) return { url: null, data: rawData, filename, error };
  if (rawUrl === null) {
    // A page-side failure (`blob:` unreadable, over the ceiling) arrives as `{filename, error}`:
    // its own sentence is the reason, not the missing URL.
    return {
      ...empty,
      filename,
      error: error ?? 'the download request carried no URL',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ...empty, filename, error: 'the download URL is not a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...empty, filename, error: `"${parsed.protocol}" downloads are not supported on this target` };
  }
  return { url: parsed.href, data: null, filename, error };
}

/**
 * `base64` → bytes, `null` when it is not base64 or over the inline ceiling. The preload always
 * sends plain base64 (it reads a `blob:`/`data:` URL through `fetch` first), so there is one form.
 */
function decodeInline(data: string): Uint8Array | null {
  const clean = data.replace(/\s+/g, '');
  if (Math.floor((clean.length * 3) / 4) > MAX_INLINE_BYTES) return null;
  if (clean === '') return new Uint8Array(0);
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Origin of a URL the way the gate compares them; `null` for anything that is not http(s). */
function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Builds the download service. `gate.ts` admits the request (view kind + observed origin) and hands
 * it here; nothing in this module is reachable from a page except through that admission.
 */
export function createDownloads(options: DownloadOptions): DownloadSink {
  let sequence = 0;

  function emit(info: TinyDownloadEvent): void {
    try {
      options.onDownload?.(info);
    } catch {
      // the backend's audit never takes a download down
    }
  }

  /** `id` from the service's own counter, like the native path's per-view one. */
  function report(
    id: number,
    url: string,
    requested: string,
    outcome: { path: string } | { error: string },
  ): DownloadAnswer {
    // The audit's `detail` is the basename alone: a page-supplied path never reaches it.
    const filename = safeName(requested);
    if ('path' in outcome) {
      emit({ id, url, filename, path: outcome.path, state: 'done' });
      return { ok: true, result: { filename, path: outcome.path } };
    }
    emit({ id, url, filename, path: null, state: 'failed', error: outcome.error });
    return { ok: false, error: outcome.error };
  }

  async function run(view: DownloadOrigin, request: Request, id: number): Promise<DownloadAnswer> {
    const dir = options.saveDir();
    if (dir === null || dir === '') return report(id, '', request.filename ?? 'download', { error: 'there is no Downloads directory' });

    if (request.error !== null) {
      // A page-side failure (`blob:` too large, unreadable): audited, nothing written.
      return report(id, '', request.filename ?? 'download', { error: request.error });
    }

    if (request.data !== null) {
      const bytes = decodeInline(request.data);
      if (bytes === null) {
        return report(id, '', request.filename ?? 'download', {
          error: `the page's file is not valid base64 or is larger than ${String(MAX_INLINE_BYTES / (1024 * 1024))} MiB`,
        });
      }
      const name = safeName(request.filename);
      const saved = save(dir, name, bytes);
      return typeof saved === 'string'
        ? report(id, '', name, { error: saved })
        : report(id, '', saved.filename, { path: saved.path });
    }

    const url = request.url;
    if (url === null) return report(id, '', request.filename ?? 'download', { error: 'no URL' });

    let current = url;
    let response: Response | null = null;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const headers: Record<string, string> = { Accept: '*/*' };
        const cookies = options.cookieHeader?.(current) ?? '';
        if (cookies !== '') headers.Cookie = cookies;
        const answer = await fetch(current, { headers, redirect: 'manual' });
        if (answer.status >= 300 && answer.status < 400) {
          const location = answer.headers.get('location');
          if (location === null) {
            response = answer;
            break;
          }
          const next = new URL(location, current);
          if (webOrigin(next.href) === null) {
            return report(id, current, request.filename ?? nameFromUrl(current) ?? 'download', {
              error: `the download redirected to "${next.protocol}"`,
            });
          }
          await answer.body?.cancel().catch(() => undefined);
          // A redirect target outside the view's origin is refused: the host attaches cookies per
          // hop, and only the view's own origin is one it can speak for.
          if (webOrigin(next.href) !== view.origin) {
            return report(id, current, request.filename ?? nameFromUrl(current) ?? 'download', {
              error: `the download redirected outside ${view.origin ?? 'the view'}'s origin`,
            });
          }
          current = next.href;
          continue;
        }
        response = answer;
        break;
      }
    } catch (error) {
      return report(id, url, request.filename ?? nameFromUrl(url) ?? 'download', {
        error: `the download request failed: ${errorMessage(error)}`,
      });
    }
    if (response === null) {
      return report(id, url, request.filename ?? nameFromUrl(url) ?? 'download', {
        error: 'the download redirected too many times',
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return report(id, current, request.filename ?? nameFromUrl(current) ?? 'download', {
        error: `the server answered ${String(response.status)} ${response.statusText}`.trim(),
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return report(id, current, request.filename ?? nameFromUrl(current) ?? 'download', {
        error: `the download body failed: ${errorMessage(error)}`,
      });
    }
    const name = safeName(
      request.filename ?? nameFromDisposition(response.headers.get('content-disposition')) ?? nameFromUrl(current),
    );
    const saved = save(dir, name, bytes);
    return typeof saved === 'string'
      ? report(id, current, name, { error: saved })
      : report(id, current, saved.filename, { path: saved.path });
  }

  return {
    async request(view, params) {
      const id = ++sequence;
      const decoded = readRequest(params);
      // Same-origin only, checked here as well as in `gate.ts`: this module is the last place a
      // request can be refused, and a test or another host may call it directly.
      if (decoded.url !== null) {
        const origin = webOrigin(decoded.url);
        if (origin === null || view.origin === null || origin !== view.origin) {
          return report(id, decoded.url, decoded.filename ?? nameFromUrl(decoded.url) ?? 'download', {
            error: `the download is outside ${view.origin ?? 'the view origin'}'s origin`,
          });
        }
      }
      return await run(view, decoded, id);
    },
  };
}
