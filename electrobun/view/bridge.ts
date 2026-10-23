// `window.tiny` for the main window of the Electrobun target (E06 parity contract).
//
// The page's only runtime dependency is this global: `src/api.ts` calls `tiny.api.call` and
// subscribes with `tiny.api.on`; `src/entry.ts` / `src/settings.ts` use `tiny.dialog`. The rest of
// the members below exist for the smoke drivers (`test/smoke/*.ts`), which run the same pages on
// both runtimes.
//
// Transport is Electroview RPC. The methods are the same object the main process defines:
//   request  'api.call'        { method, params } -> { ok: true, result } | { ok: false, error }
//   request  'dialog.openFile' { types? }         -> string | null
//   request  'dialog.saveFile' { types?, name? }  -> string | null
//   request  'store.set'       { key, value }     -> boolean
//   request  'win.getState'    {}                 -> TinyWinState | null
//   request  'win.show'        { activate? }      -> true
//   request  'win.setSize'     { width, height }  -> true
//   request  'clipboard.read'  {}                 -> clipboard payload
//   request  'clipboard.write' { data }           -> true
//   request  'fetch'           { url, init }      -> serialised response
//   message  'page.ready'      {}                 (page -> main)
//   message  'api.event'       { event, data }    (main -> page)
//
// `navigator.clipboard.writeText/readText` is routed through the same `clipboard.write`/`clipboard.read`
// requests: WKWebView refuses the page's own write with `NotAllowedError` (the Nod's 0.6.0b "Copy
// username"), while tinyjs allows it. The native methods stay as the fallback when the RPC is
// unavailable (the main window is closing, or no bridge was installed).
//
// `api.call` rejects with `new Error(message)`: the main process puts the exact string tinyjs
// rejects with in `error`, so `src/api.ts errorMessage` keeps returning the same sentence.
//
// This module is compiled as its own view (`build.views.bridge`) and injected as the main window's
// preload, which is what makes `window.tiny` exist before `src/app.ts` runs — in dev (vite URL) and
// in the packaged `views://mainview/index.html`.

import { Electroview } from 'electrobun/view';

import type {
  BridgeBody,
  BridgeFetchInit,
  BridgeFetchResponse,
  NodBridgeSchema,
  NodApiCall,
} from '../shared-rpc';

/** The RPC calls this page makes and sends (the shape `Electroview.defineRPC` returns). */
interface BridgeRpc {
  request: {
    'api.call'(
      params: { method: string; params: unknown },
      options?: { maxRequestTime?: number },
    ): Promise<NodApiCall>;
    'dialog.openFile'(params: { types?: string[] }): Promise<string | null>;
    'dialog.saveFile'(params: { types?: string[]; name?: string }): Promise<string | null>;
    'store.set'(params: { key: string; value: unknown }): Promise<boolean>;
    'win.getState'(params: Record<string, never>): Promise<unknown>;
    'win.show'(params: { activate?: boolean }): Promise<true>;
    'win.setSize'(params: { width: number; height: number }): Promise<true>;
    'clipboard.read'(params: Record<string, never>): Promise<unknown>;
    'clipboard.write'(params: { data: unknown }): Promise<true>;
    fetch(params: {
      url: string;
      init?: BridgeFetchInit;
    }): Promise<BridgeFetchResponse>;
  };
  send: {
    'page.ready'(payload: Record<string, never>): void | PromiseLike<void>;
  };
}

interface TinyDialogOptions {
  types?: string[];
}

interface TinySaveOptions extends TinyDialogOptions {
  name?: string;
}

/** The slice of the tinyjs page global the Nod actually uses (plus the smoke-only members). */
interface TinyPage {
  api: {
    call(method: string, params?: unknown): Promise<unknown>;
    on(event: string, fn: (data: unknown) => void): () => void;
    off(event: string, fn: (data: unknown) => void): void;
  };
  dialog: {
    openFile(opts?: TinyDialogOptions): Promise<string | null>;
    saveFile(opts?: TinySaveOptions): Promise<string | null>;
  };
  store: {
    set(key: string, value: unknown): Promise<boolean>;
  };
  fetch(url: string, init?: RequestInit): Promise<Response>;
  win: {
    readonly id: 'main';
    show(opts?: { activate?: boolean }): Promise<true>;
    getState(): Promise<unknown>;
    setSize(width: number, height: number): Promise<true>;
  };
  clipboard: {
    read(): Promise<unknown>;
    write(data: unknown): Promise<true>;
  };
}

const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function bodyOf(data: BodyInit | null | undefined): Promise<BridgeBody | undefined> {
  if (data === null || data === undefined) return undefined;
  if (typeof data === 'string') return { kind: 'text', value: data };
  if (data instanceof URLSearchParams) return { kind: 'text', value: data.toString() };
  if (data instanceof Blob) {
    return { kind: 'base64', value: bytesToBase64(new Uint8Array(await data.arrayBuffer())) };
  }
  if (data instanceof ArrayBuffer) return { kind: 'base64', value: bytesToBase64(new Uint8Array(data)) };
  if (ArrayBuffer.isView(data)) {
    return {
      kind: 'base64',
      value: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    };
  }
  throw new Error('tiny.fetch: unsupported request body in the Electrobun bridge');
}

function installBridge(rpc: BridgeRpc, listeners: EventListeners): void {
  const off = (event: string, fn: (data: unknown) => void): void => {
    const set = listeners.get(event);
    if (set === undefined) return;
    set.delete(fn);
    if (set.size === 0) listeners.delete(event);
  };

  const tiny: TinyPage = {
    api: {
      call(method, params) {
        return rpc.request['api.call']({ method, params: params ?? {} }).then((answer) => {
          if (answer.ok) return answer.result;
          throw new Error(answer.error);
        });
      },
      on(event, fn) {
        let set = listeners.get(event);
        if (set === undefined) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(fn);
        return () => off(event, fn);
      },
      off,
    },
    dialog: {
      openFile(opts) {
        return rpc.request['dialog.openFile']({ types: opts?.types });
      },
      saveFile(opts) {
        return rpc.request['dialog.saveFile']({ types: opts?.types, name: opts?.name });
      },
    },
    store: {
      set(key, value) {
        return rpc.request['store.set']({ key, value });
      },
    },
    async fetch(url, init) {
      const answer = await rpc.request.fetch({
        url,
        init: {
          method: init?.method,
          headers: init?.headers === undefined ? undefined : Array.from(new Headers(init.headers)),
          body: await bodyOf(init?.body),
          redirect: init?.redirect,
        },
      });
      return new Response(base64ToBytes(answer.body), {
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers,
      });
    },
    win: {
      id: 'main',
      show(opts) {
        return rpc.request['win.show']({ activate: opts?.activate });
      },
      getState() {
        return rpc.request['win.getState']({});
      },
      setSize(width, height) {
        return rpc.request['win.setSize']({ width, height });
      },
    },
    clipboard: {
      read() {
        return rpc.request['clipboard.read']({});
      },
      write(data) {
        return rpc.request['clipboard.write']({ data });
      },
    },
  };

  // The ambient `Window.tiny` is tinyjs's full surface; this bridge deliberately implements a
  // subset (plus smoke-only members), so the assignment casts once here.
  (window as unknown as { tiny?: TinyPage }).tiny = tiny;

  // WKWebView refuses the page's own `navigator.clipboard.writeText` outside a user gesture
  // (measured: `NotAllowedError`), while tinyjs allows the page to copy — the Nod's 0.6.0b "Copy
  // username" goes through it. Route the two methods the page uses through the backend clipboard and
  // keep the native ones as the fallback when the RPC cannot answer.
  const clipboard = navigator.clipboard;
  if (clipboard !== undefined) {
    const nativeWrite =
      typeof clipboard.writeText === 'function' ? clipboard.writeText.bind(clipboard) : null;
    const nativeRead =
      typeof clipboard.readText === 'function' ? clipboard.readText.bind(clipboard) : null;
    const replace = (
      name: 'writeText' | 'readText',
      value: (text: never) => Promise<unknown>,
    ): void => {
      try {
        Object.defineProperty(clipboard, name, { configurable: true, writable: true, value });
      } catch {
        try {
          (clipboard as unknown as Record<string, unknown>)[name] = value;
        } catch {
          // a clipboard object that refuses the override keeps the native behaviour
        }
      }
    };
    replace('writeText', async (text: string) => {
      try {
        await rpc.request['clipboard.write']({ data: text });
      } catch (error) {
        if (nativeWrite !== null) return await nativeWrite(text);
        throw error;
      }
    });
    replace('readText', async () => {
      try {
        const data = await rpc.request['clipboard.read']({});
        const text = (data as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      } catch (error) {
        if (nativeRead !== null) {
          const value = await nativeRead();
          return typeof value === 'string' ? value : '';
        }
        throw error;
      }
    });
  }
}

type EventListeners = Map<string, Set<(data: unknown) => void>>;

/**
 * Installs `window.tiny` in this page. Called at preload time; exported so the entry can be reused
 * as an ordinary page module by a test harness.
 */
export function installMainBridge(): void {
  if ((window as typeof window & { tiny?: unknown }).tiny !== undefined) return;
  const listeners: EventListeners = new Map();
  const defined = Electroview.defineRPC<NodBridgeSchema>({
    maxRequestTime: 120_000,
    handlers: {
      requests: {},
      messages: {
        'api.event': ({ event, data }) => {
          for (const fn of [...(listeners.get(event) ?? [])]) {
            try {
              fn(data);
            } catch (error) {
              console.error(`tiny.api.on(${event}) handler failed`, error);
            }
          }
        },
      },
    },
  });
  installBridge(defined as unknown as BridgeRpc, listeners);
  new Electroview({ rpc: defined });
  void defined.send['page.ready']({});
}

if (typeof window !== 'undefined') installMainBridge();
