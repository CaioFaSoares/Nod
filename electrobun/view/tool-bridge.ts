// Page shim for tool, popup, link and embed views, which are created `sandbox: true` (no RPC, no
// main bridge).
//
// Parity target (`e06-parity.md`): in tinyjs every page has `tiny.win.id`, and `tiny.api.call`
// returns a promise that RESOLVES with the handler's answer or REJECTS with the gate's message
// (`"login.report" is disabled by tinyjs.json "api"`, or the backend's own error such as
// `login.report only comes from a tool window`). The Electrobun sandbox keeps
// `window.__electrobunSendToHost` (a one-way channel), so the bridge adds the missing half:
//
//   page -> host  `{ id, method, params }`      (`id` is this page's counter, starting at 1)
//   host -> page  `window.__nodToolReply(id, ok, valueOrMessage)`  (via `executeJavascript`)
//
// The promise for a call lives in this page until the reply arrives; a reply naming an id this page
// never issued is ignored (it belongs to a document that is gone). The gate ignores every window or
// origin claim in the payload and stamps the observed one itself (`facade/gate.ts`).
//
// The source is generated per view because the window id has to be baked into the preload, exactly
// like a tinyjs page reads its own `tiny.win.id`. (tinyjs reads it through a getter only because a
// Linux popup inherits its opener's document-start shim; Electrobun gives every view its own
// preload, so a baked constant is the correct form here.)
//
// Members a tinyjs page has but the api gate denies for a sandboxed view (`win.getState`, dialogs,
// store, clipboard, fetch) reject with the byte-identical tinyjs sentence, so a page's existing
// error handling keeps working. `api.on/off` stay no-ops: nothing pushes events into a sandboxed
// view (parity: `login.report` is the only method a tool page may reach).

import { disabledMessage } from '../bun/facade/gate-core';

/**
 * One callable member of a tinyjs page that never reaches a sandboxed view. The method name is the
 * one the tinyjs launcher gates (`tiny.js` `call(...)` names), which is what its refusal sentence
 * carries.
 */
export interface RefusedMember {
  /** The `tiny.*` object the member lives on; `''` means `tiny` itself (`fetch`). */
  owner: 'win' | 'store' | 'dialog' | 'clipboard' | '';
  member: string;
  method: string;
}

/** Denied by `tinyjs.json` "api" for every tool entry (`gen-config.ts` `TOOL_METHODS` is the allow-list). */
export const REFUSED_MEMBERS: readonly RefusedMember[] = [
  { owner: 'win', member: 'getState', method: 'win.getState' },
  { owner: 'win', member: 'show', method: 'win.show' },
  { owner: 'win', member: 'setSize', method: 'win.setSize' },
  { owner: 'store', member: 'set', method: 'store.set' },
  { owner: 'dialog', member: 'openFile', method: 'dialog.openFile' },
  { owner: 'dialog', member: 'saveFile', method: 'dialog.saveFile' },
  { owner: 'clipboard', member: 'read', method: 'clip.read' },
  { owner: 'clipboard', member: 'write', method: 'clip.write' },
  { owner: '', member: 'fetch', method: 'fetch' },
];

/** JSON text that is safe to embed in a JavaScript argument list, whatever the string holds. */
function jsJson(value: unknown): string | null {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null; // circular or a throwing toJSON: there is no honest encoding
  }
  if (encoded === undefined) return null;
  // `JSON.stringify` leaves these two line separators raw; in an embedded script they can be read
  // as a line break inside a string literal by older engines. Escape them as JSON does for the rest.
  return encoded.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The `window.tiny` source for one sandboxed view, with `tiny.win.id` baked in. */
export function toolBridgeSource(windowId: string): string {
  const idText = jsJson(typeof windowId === 'string' && windowId !== '' ? windowId : 'main') ?? '"main"';
  const stubs = REFUSED_MEMBERS.map(({ owner, member, method }) => {
    const target = owner === '' ? `tiny.${member}` : `tiny.${owner}.${member}`;
    // The sentence is the gate's own, not a second copy of its wording.
    return `  ${target} = refuse(${jsJson(disabledMessage(method))});`;
  }).join('\n');

  return `(function () {
  'use strict';
  if (window.tiny && window.tiny.api) return;
  var WINDOW_ID = ${idText};
  var pending = {};
  var seq = 0;
  function refuse(message) {
    return function () {
      return Promise.reject(new Error(message));
    };
  }
  function call(method, params) {
    var entry = Promise.withResolvers();
    var id = ++seq;
    pending[id] = entry;
    try {
      if (typeof window.__electrobunSendToHost !== 'function') {
        throw new Error('the tool bridge has no host channel in this window');
      }
      window.__electrobunSendToHost({ id: id, method: String(method), params: params });
    } catch (error) {
      delete pending[id];
      entry.reject(error);
    }
    return entry.promise;
  }
  window.__nodToolReply = function (id, ok, value) {
    var entry = Object.prototype.hasOwnProperty.call(pending, id) ? pending[id] : null;
    if (entry === null) return;
    delete pending[id];
    if (ok === true) {
      entry.resolve(value);
      return;
    }
    entry.reject(new Error(typeof value === 'string' ? value : String(value)));
  };
  var tiny = {
    api: {
      call: call,
      on: function () {
        return function () {};
      },
      off: function () {}
    },
    win: { id: WINDOW_ID },
    store: {},
    dialog: {},
    clipboard: {}
  };
${stubs}
  // ---- downloads ----------------------------------------------------------------
  // A sandboxed view cannot write ~/Downloads: the engine's WKDownload path asks the system for a
  // sandbox extension for the account's Downloads directory and a packaged Nod never gets one, so
  // the file is lost before any delegate callback and no download-* event fires
  // (docs/handovers/e06-surface-check.md, item 10). The host is not sandboxed, so a click on
  // \`<a download>\` is handed over instead: a same-origin http(s) URL is fetched and saved by the
  // host, and a \`blob:\`/\`data:\` URL (the page's own bytes) travels along as base64. Every other
  // click keeps the page's default — the HTML rule ignores \`download\` for cross-origin URLs, and
  // this keeps that rule rather than turning the host into a fetch proxy.
  var DOWNLOAD_MAX_INLINE = 8388608;
  function postDownload(payload) {
    try {
      window.__electrobunSendToHost({ id: 0, method: 'nod.download', params: payload });
    } catch (error) {
      // no host channel in this document: there is nothing to save with
    }
  }
  function toBase64(bytes) {
    var binary = '';
    for (var index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }
  function onDownloadClick(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    var anchor = null;
    for (var index = 0; index < path.length; index += 1) {
      var node = path[index];
      if (node && node.nodeType === 1 && String(node.tagName).toLowerCase() === 'a' && node.hasAttribute('download')) {
        anchor = node;
        break;
      }
    }
    if (anchor === null) return;
    var href = anchor.href || '';
    var scheme = href.slice(0, href.indexOf(':') + 1).toLowerCase();
    var attribute = anchor.getAttribute('download');
    var filename = attribute && attribute.trim() !== '' ? attribute.trim() : null;
    if (scheme === 'http:' || scheme === 'https:') {
      var sameOrigin = false;
      try {
        sameOrigin = new URL(href).origin === window.location.origin;
      } catch (error) {
        sameOrigin = false;
      }
      if (!sameOrigin) return;
      event.preventDefault();
      postDownload({ url: href, filename: filename });
      return;
    }
    if (scheme !== 'blob:' && scheme !== 'data:') return;
    event.preventDefault();
    window
      .fetch(href)
      .then(function (response) {
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        if (buffer.byteLength > DOWNLOAD_MAX_INLINE) {
          postDownload({ filename: filename, error: 'the file is larger than 8 MiB' });
          return;
        }
        postDownload({ filename: filename, data: toBase64(new Uint8Array(buffer)) });
      })
      .catch(function (error) {
        postDownload({
          filename: filename,
          error: String(error && error.message ? error.message : error),
        });
      });
  }
  // \`document\` is absent when the source is evaluated outside a page (the gate unit test runs it
  // against a bare \`window\`): the interception is simply not installed there.
  if (typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function') {
    document.addEventListener('click', onDownloadClick, true);
  }
  window.tiny = tiny;
})();`;
}

/** How an answer is carried back to the page (`gate.ts` `HostReply`). */
export type ToolReply = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * The JavaScript that settles one pending call. Every argument is JSON-encoded — a page-supplied
 * value or an error message is data inside the call, never code. `null` when the id is not a
 * positive safe integer or the value has no JSON form, in which case the host sends nothing and the
 * page's promise stays pending (the call is lost, not answered with a lie).
 */
export function replySource(id: number, reply: ToolReply): string | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const encoded = jsJson(reply.ok ? (reply.result === undefined ? null : reply.result) : reply.error);
  if (encoded === null) return null;
  return `window.__nodToolReply(${String(id)}, ${reply.ok ? 'true' : 'false'}, ${encoded})`;
}
