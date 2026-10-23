// The Electrobun target's origin gate, pure half.
//
// Electrobun's RPC handler receives only `params` — no sender, no origin
// (`api/shared/rpc.ts:455` in the devkit; `docs/handovers/e06-electrobun-spike.md` §4). The Nod
// therefore owns the gate: the runtime observes the committed origin of every frame group
// (`did-commit-navigation`) and this module decides, per view, whether a method is dispatched.
//
// Rules, matching `tinyjs.json` "api" + `backend/main.ts`'s `guarded()`:
//
//   main  — every method, but only while the committed origin is one of the app's own origins
//           (the build's `views://` origin, or the dev server origin from the generated config).
//           A remote page that navigates the main view loses the api immediately.
//   tool  — `login.report` only, dispatched from a sandboxed tool view via `host-message`, with
//           `meta.origin` = the committed origin the runtime observed. The per-tool entry-origin
//           check stays where tinyjs has it: `backend/main.ts` `requireToolOrigin`.
//   popup | link | embed — no method at all.
//
// The refusal sentence is byte-identical to the tinyjs launcher's gate
// (`~/.tinyjs/runtime/bridge.js`, `apiGate`), so a page's existing error handling keeps working.
//
// This file is pure: no `electrobun`, no `tjs`, no I/O. `test/electrobun-gate.test.ts` pins it.

import { MAIN_WINDOW } from '../../../shared/types';

/** What kind of view a call can come from. */
export type ViewKind = 'main' | 'tool' | 'popup' | 'link' | 'embed';

/** The only method a tool view may ever reach (`tinyjs.json`'s `TOOL_METHODS`). */
export const TOOL_METHOD = 'login.report';

/** The exact sentence the tinyjs gate throws (`bridge.js` `apiGate`). */
export function disabledMessage(method: string): string {
  return `"${method}" is disabled by tinyjs.json "api"`;
}

/** One dispatch question: where the call came from, the observed origin, and the method. */
export interface GateRequest {
  viewKind: ViewKind;
  /** Id of the window the call belongs to: 'main' or a `tiny.win.open` id. */
  windowId: string;
  /**
   * Origin of the calling frame as the runtime observed it (`did-commit-navigation`), never one
   * the page claims. `null` until a navigation has committed, which is a deny for every kind.
   */
  committedOrigin: string | null;
  /**
   * The app's own origins: the build's `views://` origin and, in dev, the generated config's dev
   * server origin. The tool entries' origins are deliberately NOT here — the backend checks those.
   */
  appOrigins: readonly string[];
  method: string;
}

export type GateDecision =
  | { allowed: true; meta: { window: string; origin: string } }
  | { allowed: false; error: string };

/**
 * Compare origins the way the engine reports them: scheme/host lowercase, no trailing slash.
 * An app origin may be written as a full URL (`views://mainview/index.html`) and is reduced to its
 * origin. Anything that is not a URL is compared as written (lowercased, trailing slashes gone).
 */
export function originKey(origin: string): string {
  const trimmed = origin.trim();
  if (trimmed === '') return '';
  const parsed = originOfUrl(trimmed);
  return (parsed ?? trimmed).replace(/\/+$/, '').toLowerCase();
}

/**
 * The origin of a committed URL: `views://mainview/index.html` -> `views://mainview`,
 * `http://127.0.0.1:5173/app` -> `http://127.0.0.1:5173`. `null` for documents with an opaque
 * origin (`file:`, `data:`, `about:blank`): nothing is trusted from them.
 */
export function originOfUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  switch (parsed.protocol) {
    case 'views:':
      // The Electrobun page origin: scheme + the views folder name.
      return parsed.host === '' ? null : `views://${parsed.host}`;
    case 'http:':
    case 'https:':
      return parsed.origin;
    default:
      // `file:`, `data:`, `about:`, `blob:`: opaque, never an app origin.
      return null;
  }
}

/** Whether `origin` is one of the app's own origins. Exact match; no wildcards, no subdomains. */
export function isAppOrigin(origin: string | null, appOrigins: readonly string[]): boolean {
  if (origin === null) return false;
  const key = originKey(origin);
  if (key === '') return false;
  return appOrigins.some((allowed) => originKey(allowed) === key);
}

function deny(method: string): GateDecision {
  return { allowed: false, error: disabledMessage(method) };
}

function allow(window: string, origin: string): GateDecision {
  return { allowed: true, meta: { window, origin } };
}

/**
 * The whole policy, as one decision. Stateless on purpose: the caller passes the origin it
 * observed for this call, so a call that was already in flight when the view navigated is judged
 * by the new committed origin (the race is documented in `facade/gate.ts`).
 */
export function decide(request: GateRequest): GateDecision {
  const method = request.method;
  if (request.viewKind === 'main') {
    if (isAppOrigin(request.committedOrigin, request.appOrigins)) {
      // The main window is always known to the backend under this name, whatever the runtime's
      // internal view id is.
      return allow(MAIN_WINDOW, request.committedOrigin as string);
    }
    return deny(method);
  }
  if (request.viewKind === 'tool') {
    if (
      method === TOOL_METHOD &&
      request.windowId !== '' &&
      request.committedOrigin !== null &&
      request.committedOrigin !== ''
    ) {
      // The committed origin, never a claimed one. `backend/main.ts` `requireToolOrigin` then
      // compares it with the tool's own entry origin.
      return allow(request.windowId, request.committedOrigin);
    }
    return deny(method);
  }
  // popup / link / embed: no api at all.
  return deny(method);
}
