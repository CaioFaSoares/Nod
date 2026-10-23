// The Electrobun target's origin gate, stateful half.
//
// One registry of views — `viewId -> { windowId, kind, committedOrigin }` — fed by the runtime's
// own navigation events, plus the policy of `gate-core.ts`. Windows (`facade/windows.ts`) creates
// the views and calls in; index.ts calls `call()` for the main view's RPC. This file never touches
// the devkit.
//
// Race (documented, do not "fix" by caching): a call is judged with the origin committed AT THE
// MOMENT OF DISPATCH, not the one the view had when the call was queued. If the main view commits
// a navigation to a remote origin between the page's call and the handler reading the registry,
// the call is refused — that is the required direction. `beginNavigation` additionally fails
// closed for the whole navigation (origin becomes null), so the window between "navigation
// started" and "navigation committed" grants nothing either.
//
// Origins never come from the page. `hostMessage` ignores any `origin` field the payload claims and
// uses only the origin the caller observed (`did-commit-navigation`), matching
// `docs/handovers/e06-electrobun-spike.md` §4.
//
// Request/reply: `hostRequest` is `hostMessage` plus the page's call id. The gate runs the handler
// and answers `{ ok: true, result }` or `{ ok: false, error }`; the caller writes that back through
// `view.executeJavascript` (never interpolated as code — see `replySource`). A reply is only
// meaningful to the document that made the call: each document's id counter starts at 1, so the
// caller must drop a reply whose view committed a navigation since the call (`windows.ts` tracks the
// commit generation). This gate keeps no per-call state, by design: the answer belongs to the
// caller that can observe the view's lifetime.

import { MAIN_WINDOW } from '../../../shared/types';
import {
  decide as coreDecide,
  disabledMessage,
  originOfUrl,
  type GateDecision,
  type GateRequest,
  type ViewKind,
} from './gate-core';
import { DOWNLOAD_METHOD, type DownloadOrigin, type DownloadSink } from './downloads';

export type { GateDecision, GateRequest, ViewKind };

/** An observed origin, or the origin of an observed URL; `null`/`''` mean "not observed". */
function normalizeObserved(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // A committed URL is the normal input; a bare origin (`views://mainview`, `http://host:port`)
  // may also arrive. `originOfUrl` understands both.
  return originOfUrl(trimmed) ?? trimmed.replace(/\/+$/, '');
}

interface RegisteredView {
  windowId: string;
  kind: ViewKind;
  origin: string | null;
}

export interface ViewGateCallbacks {
  /** The app's own origins (build `views://` + dev server origin). Read on every decision. */
  appOrigins: () => readonly string[];
  /**
   * The backend dispatch, called only for an allowed `host-message` call. The caller (Shell)
   * invokes `api[method](params, app, meta)`; the answer becomes the page's resolved value (or its
   * rejection, when it throws). `hostMessage` ignores it; `hostRequest` sends it back.
   */
  onHostCall?: (method: string, params: unknown, meta: TinyApiMeta) => unknown | Promise<unknown>;
  /**
   * The shell's download channel (`facade/downloads.ts`): the one page request that is not an api
   * method. It can only save a response into `~/Downloads`; it never reaches the backend, returns no
   * body to the page, and is admitted only for a non-main view whose origin the runtime observed
   * (see `gate.ts` `admitDownload`). Absent when the host has no download service.
   */
  download?: DownloadSink;
}

/** The tool bridge's answer to one pending page call (`electrobun/view/tool-bridge.ts`). */
export type HostReply = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * What `hostRequest` gives its caller: the decision, the page's call id (for
 * `window.__nodToolReply`) and the answer to write back. The caller must drop the reply if the view
 * committed a navigation after this call — the new document's counter starts over, so an old id can
 * name a promise the new page made (`facade/windows.ts`).
 */
export interface HostRequest {
  decision: GateDecision;
  /** The page-local call id; `null` when the payload carried no usable one. */
  id: number | null;
  /** `null` when there is no id to answer; the call was still dispatched, exactly like `hostMessage`. */
  reply: Promise<HostReply> | null;
}

export interface ViewGate {
  /** A view was created. `main`, `tool` and `popup` come from `windows.ts`. */
  register(viewId: number, windowId: string, kind: ViewKind): void;
  /** The window went away: its view id grants nothing from now on. */
  forget(viewId: number): void;
  /** A top-frame navigation started: drop the trust the view had until it commits again. */
  beginNavigation(viewId: number): void;
  /**
   * A top-frame navigation committed. `url` is the raw committed URL when the caller has it
   * (`did-commit-navigation`); otherwise the origin is read from `originOrUrl`.
   */
  commit(viewId: number, originOrUrl: string, url?: string): void;
  /** The origin the runtime last observed for this view, `null` when unknown. */
  originOf(viewId: number): string | null;
  /** Should `method` from this view be dispatched, and with which meta? */
  decide(viewId: number, method: string): GateDecision;
  /**
   * A sandboxed view sent `host-message` (Electrobun keeps `__electrobunSendToHost` in sandboxes;
   * `e06-electrobun-spike.md` row 23). Only `login.report` from a tool view is dispatched.
   * The payload's own `origin`/`window` fields are ignored.
   */
  hostMessage(
    viewId: number,
    windowId: string,
    payload: unknown,
    observedOrigin: string | null,
  ): GateDecision;
  /**
   * The same decision and dispatch as `hostMessage`, plus the answer the tool bridge's pending
   * promise waits for. A payload without a usable `id` (the old one-way call) is dispatched and left
   * unanswered, exactly as before.
   */
  hostRequest(
    viewId: number,
    windowId: string,
    payload: unknown,
    observedOrigin: string | null,
  ): HostRequest;
  /** Every view that is not the main one is created with `sandbox: true`. */
  sandbox(kind: ViewKind): boolean;
}

/**
 * `viewId -> view`. `appOrigins` is a function so a config load that happens after the windows
 * exist still reaches every decision.
 */
export function createViewGate(callbacks: ViewGateCallbacks): ViewGate {
  const views = new Map<number, RegisteredView>();

  /** The page's claim, decoded only: `method` must be a string, `params` is whatever came. */
  function decode(payload: unknown): { method: string; params: unknown } {
    const body =
      payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    return {
      method: typeof body?.method === 'string' ? body.method : '',
      params: body?.params,
    };
  }

  /** The page-local call id; `null` for a payload that cannot be answered (the old one-way call). */
  function callId(payload: unknown): number | null {
    const body =
      payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    const id = body?.id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function decisionFor(
    viewId: number,
    method: string,
    observedOrigin: string | null,
  ): GateDecision {
    const view = views.get(viewId);
    if (view === undefined) return { allowed: false, error: disabledMessage(method) };
    // The page's own claims are never read; the caller's observation is authoritative. When the
    // caller has none, keep what `did-commit-navigation` last committed.
    return coreDecide({
      viewKind: view.kind,
      windowId: view.windowId,
      committedOrigin: normalizeObserved(observedOrigin) ?? view.origin,
      appOrigins: callbacks.appOrigins(),
      method,
    });
  }

  /**
   * Run the handler and fold its answer or throw into the page's reply. Never rejects: a handler
   * failure is a message the page shows, not an exception in the host's event loop. A gate that
   * allows a method with no handler behind it refuses with the same sentence as the api gate.
   */
  function dispatchCall(method: string, params: unknown, meta: TinyApiMeta): Promise<HostReply> {
    const handler = callbacks.onHostCall;
    if (handler === undefined) {
      return Promise.resolve({ ok: false, error: disabledMessage(method) });
    }
    const failure = (error: unknown): HostReply => ({
      ok: false,
      error: error instanceof Error && error.message !== '' ? error.message : String(error),
    });
    try {
      return Promise.resolve(handler(method, params, meta)).then(
        (result): HostReply => ({ ok: true, result }),
        failure,
      );
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  }

  /**
   * Admission for the shell's download channel (`DOWNLOAD_METHOD`). It is NOT an api method: the
   * answer is a saved file, never a backend call, so `gate-core.decide` does not see it. The rules
   * this file enforces are the same shape as the api's: the view must be one the runtime created,
   * it must not be the main window (main keeps the engine's native download path), and its origin
   * must be one the runtime observed — never one the page claims. Anything else refuses with the
   * api gate's sentence.
   */
  function admitDownload(
    viewId: number,
    method: string,
    observedOrigin: string | null,
  ):
    | { allowed: true; view: DownloadOrigin; decision: GateDecision }
    | { allowed: false; decision: { allowed: false; error: string } } {
    const view = views.get(viewId);
    const origin = normalizeObserved(observedOrigin) ?? view?.origin ?? null;
    if (
      view === undefined ||
      view.kind === 'main' ||
      origin === null ||
      callbacks.download === undefined
    ) {
      return { allowed: false, decision: { allowed: false, error: disabledMessage(method) } };
    }
    return {
      allowed: true,
      view: { windowId: view.windowId, kind: view.kind, origin },
      decision: { allowed: true, meta: { window: view.windowId, origin } },
    };
  }

  return {
    register(viewId, windowId, kind) {
      views.set(viewId, { windowId, kind, origin: null });
    },
    forget(viewId) {
      views.delete(viewId);
    },
    beginNavigation(viewId) {
      const view = views.get(viewId);
      if (view !== undefined) view.origin = null;
    },
    commit(viewId, originOrUrl, url) {
      const view = views.get(viewId);
      if (view === undefined) return;
      const observed = normalizeObserved(url ?? originOrUrl);
      view.origin = observed;
    },
    originOf(viewId) {
      return views.get(viewId)?.origin ?? null;
    },
    decide(viewId, method) {
      return decisionFor(viewId, method, null);
    },
    hostMessage(viewId, _windowId, payload, observedOrigin) {
      const { method, params } = decode(payload);
      if (method === DOWNLOAD_METHOD) {
        const admitted = admitDownload(viewId, method, observedOrigin);
        if (admitted.allowed) {
          // Fire-and-forget, like the api path: the click has no promise waiting on it.
          const started = callbacks.download?.request(admitted.view, params);
          if (started !== undefined) void started.catch(() => undefined);
        }
        return admitted.decision;
      }
      const decision = decisionFor(viewId, method, observedOrigin);
      // Fire-and-forget: the answer (or its failure) has nowhere to go on this path.
      if (decision.allowed) void dispatchCall(method, params, decision.meta);
      return decision;
    },
    hostRequest(viewId, _windowId, payload, observedOrigin) {
      const { method, params } = decode(payload);
      if (method === DOWNLOAD_METHOD) {
        const admitted = admitDownload(viewId, method, observedOrigin);
        const sink = callbacks.download;
        const started: Promise<HostReply> =
          admitted.allowed && sink !== undefined
            ? sink.request(admitted.view, params)
            : Promise.resolve({
                ok: false as const,
                error: admitted.allowed ? disabledMessage(method) : admitted.decision.error,
              });
        const downloadId = callId(payload);
        if (downloadId === null) {
          // The interceptor's own click: nothing waits for the answer, but the save still runs.
          void started.catch(() => undefined);
          return { decision: admitted.decision, id: null, reply: null };
        }
        return { decision: admitted.decision, id: downloadId, reply: started };
      }
      const decision = decisionFor(viewId, method, observedOrigin);
      const id = callId(payload);
      if (id === null) {
        if (decision.allowed) void dispatchCall(method, params, decision.meta);
        return { decision, id: null, reply: null };
      }
      return {
        decision,
        id,
        reply: decision.allowed
          ? dispatchCall(method, params, decision.meta)
          : Promise.resolve({ ok: false as const, error: decision.error }),
      };
    },
    sandbox(kind) {
      return kind !== 'main';
    },
  };
}

/**
 * The gate index.ts talks to: the main view's RPC calls plus the tool-view path Windows feeds.
 * `call` throws the tinyjs sentence, so `src/api.ts` sees the same error it always did.
 */
export interface Gate extends ViewGate {
  /** Dispatch a main-window call; refuses with `"<method>" is disabled by tinyjs.json "api"`. */
  call(method: string, params: unknown, meta: TinyApiMeta): Promise<unknown>;
  /** The main view committed a navigation; `origin` null (or opaque) disables the api. */
  committed(origin: string | null, href: string): void;
  /** Register a sandboxed view for the `login.report` path (`windows.ts` also registers its own). */
  sandboxView(viewId: number, origin: string | null, windowId: string): void;
}

export interface GateOptions {
  /** The backend's api map (`backend/main.ts`'s `api`). */
  api: Record<string, TinyApiHandler>;
  /** The composed TinyApp, read at dispatch time (`init(app)` runs before any call). */
  app: () => TinyApp;
  /** The app's own origins: build `views://` origin and the dev server origin from the config. */
  appOrigins: () => readonly string[];
  /**
   * The shell's download service (`facade/downloads.ts`). A sandboxed view has no other way to
   * save a file: the engine's native download path cannot write `~/Downloads` from a packaged Nod
   * (`docs/handovers/e06-surface-check.md` item 10). The preload sends `nod.download` and this gate
   * admits it under the same origin rule as the api.
   */
  download?: DownloadSink;
}

export function createGate(options: GateOptions): Gate {
  let mainOrigin: string | null = null;

  const views = createViewGate({
    appOrigins: options.appOrigins,
    download: options.download,
    onHostCall(method, params, meta) {
      const handler = options.api[method];
      // An allowed method with nothing behind it refuses like the api gate; the tool page's
      // promise rejects with the sentence instead of hanging.
      if (handler === undefined) throw new Error(disabledMessage(method));
      return handler(params, options.app(), meta);
    },
  });

  function call(method: string, params: unknown, _meta: TinyApiMeta): Promise<unknown> {
    // The committed origin of the main view is the only source; a meta the page (or a bridge
    // wrapper) hands in is not consulted.
    const decision = coreDecide({
      viewKind: 'main',
      windowId: MAIN_WINDOW,
      committedOrigin: mainOrigin,
      appOrigins: options.appOrigins(),
      method,
    });
    if (!decision.allowed) return Promise.reject(new Error(decision.error));
    const handler = options.api[method];
    if (handler === undefined) return Promise.reject(new Error(disabledMessage(method)));
    const meta: TinyApiMeta = { window: MAIN_WINDOW, origin: decision.meta.origin };
    try {
      return Promise.resolve(handler(params, options.app(), meta));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return {
    ...views,
    call,
    committed(origin, href) {
      mainOrigin = normalizeObserved(origin) ?? normalizeObserved(href);
    },
    sandboxView(viewId, origin, windowId) {
      views.register(viewId, windowId, 'tool');
      if (origin !== null) views.commit(viewId, origin);
    },
  };
}
