// RPC schema of the Electrobun target's main window, shared by both sides: `bun/index.ts` (the main
// process) and `view/bridge.ts` (the page preload) import this type. Type-only module, so neither
// the Bun bundle nor the view bundle evaluates anything from here.
//
// Electrobun's `defineElectrobunRPC` reads each side's sections as what THAT side handles and
// receives: `handlers.requests` and `handlers.messages` come from `Schema[side]`, while the outgoing
// `send` proxy uses the other side's `messages`. Hence:
//   bun.requests      requests the main process handles  (page -> main)
//   bun.messages      messages the main process receives (page -> main)
//   webview.requests  requests the page handles           (main -> page; none today)
//   webview.messages  messages the page receives          (main -> page)
//
// Wire protocol:
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

/** Push payload of one backend event (`app.push(event, data)`). */
export interface BridgeEvent {
  event: string;
  data: unknown;
}

/** Serializable request body: text stays text, bytes travel base64. */
export interface BridgeBody {
  kind: 'text' | 'base64';
  value: string;
}

export interface BridgeFetchInit {
  method?: string;
  headers?: Array<[string, string]>;
  body?: BridgeBody;
  redirect?: RequestRedirect;
}

/** Answer of the main process `fetch`: a `Response` the page can rebuild, body base64. */
export interface BridgeFetchResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Array<[string, string]>;
  body: string;
}

export type NodApiCall =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/** RPC schema shared by the main process and the main window's page bridge. */
export type NodBridgeSchema = {
  bun: {
    requests: {
      'api.call': { params: { method: string; params: unknown }; response: NodApiCall };
      'dialog.openFile': { params: { types?: string[] }; response: string | null };
      'dialog.saveFile': { params: { types?: string[]; name?: string }; response: string | null };
      'store.set': { params: { key: string; value: unknown }; response: boolean };
      'win.getState': { params: Record<string, never>; response: unknown };
      'win.show': { params: { activate?: boolean }; response: true };
      'win.setSize': { params: { width: number; height: number }; response: true };
      'clipboard.read': { params: Record<string, never>; response: unknown };
      'clipboard.write': { params: { data: unknown }; response: true };
      fetch: { params: { url: string; init?: BridgeFetchInit }; response: BridgeFetchResponse };
    };
    messages: {
      'page.ready': Record<string, never>;
    };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      'api.event': BridgeEvent;
    };
  };
};
