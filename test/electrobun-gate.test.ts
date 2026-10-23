// E06: the Electrobun origin gate and the hotkey accelerator mapping.
//
// These pin the security core the Electrobun target exists around (`e06-parity.md`, row
// `gate-core.ts`): a remote page that navigates the main view loses the api, a tool view reaches
// only `login.report`, a page-claimed origin is never believed, and an in-flight call is judged by
// the origin committed when it is dispatched. The last group pins the combo translation
// `shared/shortcuts.ts` -> the devkit's `GlobalShortcut` syntax.

import { describe, expect, test } from 'bun:test';
import { combo, ctrlCombo, shiftCombo } from '../shared/shortcuts';
import {
  decide,
  disabledMessage,
  isAppOrigin,
  originOfUrl,
  type GateRequest,
} from '../electrobun/bun/facade/gate-core';
import { createGate, createViewGate } from '../electrobun/bun/facade/gate';
import {
  REFUSED_MEMBERS,
  replySource,
  toolBridgeSource,
} from '../electrobun/view/tool-bridge';
import { toAccelerator } from '../electrobun/bun/facade/app';

const VIEWS = 'views://mainview';
const DEV = 'http://127.0.0.1:5173';
const REMOTE = 'https://evil.example';
const OWN = [VIEWS, DEV];

function main(committedOrigin: string | null, method = 'session.state'): GateRequest {
  return { viewKind: 'main', windowId: 'main', committedOrigin, appOrigins: OWN, method };
}

describe('main view', () => {
  test('dispatches while the committed origin is the build views origin', () => {
    expect(decide(main(VIEWS))).toEqual({
      allowed: true,
      meta: { window: 'main', origin: VIEWS },
    });
  });

  test('dispatches while the committed origin is the dev server origin', () => {
    expect(decide(main(DEV)).allowed).toBe(true);
  });

  test('navigation to a remote origin revokes access', () => {
    expect(decide(main(REMOTE))).toEqual({
      allowed: false,
      error: '"session.state" is disabled by tinyjs.json "api"',
    });
  });

  test('no committed origin yet means no api', () => {
    expect(decide(main(null)).allowed).toBe(false);
  });

  test('the refusal carries the method name, like the tinyjs gate', () => {
    const denied = decide(main(REMOTE, 'win.getState'));
    expect(denied).toEqual({
      allowed: false,
      error: '"win.getState" is disabled by tinyjs.json "api"',
    });
    expect(disabledMessage('win.getState')).toBe('"win.getState" is disabled by tinyjs.json "api"');
  });

  test('trailing slashes and a full URL in the allow-list compare by origin', () => {
    const request = main(VIEWS);
    request.appOrigins = ['views://mainview/'];
    expect(decide(request).allowed).toBe(true);
  });
});

describe('tool, popup and embedded views', () => {
  test('login.report from a tool view carries the committed origin', () => {
    const decision = decide({
      viewKind: 'tool',
      windowId: 'tool-7',
      committedOrigin: 'https://airtable.com',
      appOrigins: OWN,
      method: 'login.report',
    });
    expect(decision).toEqual({
      allowed: true,
      meta: { window: 'tool-7', origin: 'https://airtable.com' },
    });
  });

  test('a tool view reaches nothing else', () => {
    for (const method of [
      'win.getState',
      'session.state',
      'catalog.get',
      'login.report.extra',
      'media.camera',
    ]) {
      const decision = decide({
        viewKind: 'tool',
        windowId: 'tool-7',
        committedOrigin: VIEWS,
        appOrigins: OWN,
        method,
      });
      expect(decision).toEqual({ allowed: false, error: disabledMessage(method) });
    }
  });

  test('a tool view with no committed origin is refused', () => {
    const decision = decide({
      viewKind: 'tool',
      windowId: 'tool-7',
      committedOrigin: null,
      appOrigins: OWN,
      method: 'login.report',
    });
    expect(decision.allowed).toBe(false);
  });

  test('popup, link and embedded views get no method at all', () => {
    for (const viewKind of ['popup', 'link', 'embed'] as const) {
      const decision = decide({
        viewKind,
        windowId: 'some-view',
        committedOrigin: VIEWS,
        appOrigins: OWN,
        method: 'login.report',
      });
      expect(decision.allowed).toBe(false);
    }
  });

  test('a tool view claiming an origin in its payload is ignored', () => {
    let dispatched: { method: string; meta: { window: string; origin?: string } } | null = null;
    const withDispatch = createViewGate({
      appOrigins: () => OWN,
      onHostCall(method, _params, meta) {
        dispatched = { method, meta };
      },
    });
    withDispatch.register(11, 'tool-7', 'tool');
    withDispatch.commit(11, 'https://airtable.com');

    const decision = withDispatch.hostMessage(
      11,
      'main',
      {
        method: 'login.report',
        params: { state: 'submitted' },
        // The page's claims: neither is read.
        window: 'main',
        origin: 'views://mainview',
      },
      'https://airtable.com',
    );

    expect(decision).toEqual({
      allowed: true,
      meta: { window: 'tool-7', origin: 'https://airtable.com' },
    });
    expect(dispatched).toEqual({
      method: 'login.report',
      meta: { window: 'tool-7', origin: 'https://airtable.com' },
    });
  });

  test('a host-message naming another method is refused and not dispatched', () => {
    let dispatched = false;
    const withDispatch = createViewGate({
      appOrigins: () => OWN,
      onHostCall() {
        dispatched = true;
      },
    });
    withDispatch.register(12, 'tool-8', 'tool');
    withDispatch.commit(12, 'https://airtable.com');
    const decision = withDispatch.hostMessage(
      12,
      'tool-8',
      { method: 'session.state' },
      'https://airtable.com',
    );
    expect(decision.allowed).toBe(false);
    expect(dispatched).toBe(false);
  });
});

describe('the view registry (navigation race)', () => {
  test('an in-flight call after navigation is judged by the new origin', () => {
    const gate = createViewGate({ appOrigins: () => OWN });
    gate.register(1, 'main', 'main');
    gate.commit(1, VIEWS);
    // The call is queued while the view is still the app's own page.
    expect(gate.decide(1, 'session.state').allowed).toBe(true);

    // Navigation starts, then commits elsewhere; the queued call is dispatched now.
    gate.beginNavigation(1);
    expect(gate.decide(1, 'session.state').allowed).toBe(false);
    gate.commit(1, 'https://evil.example');
    expect(gate.decide(1, 'session.state')).toEqual({
      allowed: false,
      error: disabledMessage('session.state'),
    });
  });

  test('a closed view is unknown and refused', () => {
    const gate = createViewGate({ appOrigins: () => OWN });
    gate.register(2, 'tool-9', 'tool');
    gate.commit(2, 'https://airtable.com');
    gate.forget(2);
    expect(gate.decide(2, 'login.report').allowed).toBe(false);
  });

  test('a commit given as a URL is reduced to its origin', () => {
    const gate = createViewGate({ appOrigins: () => OWN });
    gate.register(3, 'main', 'main');
    gate.commit(3, 'http://127.0.0.1:5173/app/index.html?x=1');
    expect(gate.originOf(3)).toBe(DEV);
    expect(gate.decide(3, 'session.state').allowed).toBe(true);
  });

  test('sandbox() is true for every view except main', () => {
    const gate = createViewGate({ appOrigins: () => OWN });
    expect(gate.sandbox('main')).toBe(false);
    for (const kind of ['tool', 'popup', 'link', 'embed'] as const) {
      expect(gate.sandbox(kind)).toBe(true);
    }
  });
});

describe('createGate (the main RPC path)', () => {
  test('refuses until the main view commits one of the app origins', async () => {
    const gate = createGate({
      api: { 'session.state': () => ({ ok: true }) },
      app: () => ({}) as TinyApp,
      appOrigins: () => OWN,
    });
    await expect(gate.call('session.state', {}, { window: 'main' })).rejects.toThrow(
      '"session.state" is disabled by tinyjs.json "api"',
    );
    gate.committed(null, 'https://evil.example/');
    await expect(gate.call('session.state', {}, { window: 'main' })).rejects.toThrow(
      '"session.state" is disabled by tinyjs.json "api"',
    );
  });

  test('dispatches with the committed origin and ignores the caller meta', async () => {
    const app = {} as TinyApp;
    let seen: { window: string; origin?: string } | null = null;
    const gate = createGate({
      api: {
        'session.state': (_params, _app, meta) => {
          seen = meta;
          return { ok: true };
        },
      },
      app: () => app,
      appOrigins: () => OWN,
    });
    gate.committed(VIEWS, 'views://mainview/index.html');
    await expect(
      gate.call('session.state', {}, { window: 'main', origin: 'https://evil.example' }),
    ).resolves.toEqual({ ok: true });
    expect(seen).toEqual({ window: 'main', origin: VIEWS });

    // A remote commit revokes the api (the race, at the RPC boundary).
    gate.committed('https://evil.example', 'https://evil.example/login');
    await expect(gate.call('session.state', {}, { window: 'main' })).rejects.toThrow(
      '"session.state" is disabled by tinyjs.json "api"',
    );
  });

  test('sandboxView registers the login.report path', () => {
    const gate = createGate({ api: {}, app: () => ({}) as TinyApp, appOrigins: () => OWN });
    gate.sandboxView(9, 'https://airtable.com', 'tool-9');
    const decision = gate.hostMessage(
      9,
      'tool-9',
      { method: 'login.report', params: { state: 'submitted' } },
      'https://airtable.com',
    );
    expect(decision).toEqual({
      allowed: true,
      meta: { window: 'tool-9', origin: 'https://airtable.com' },
    });
  });
});

describe('origin helpers', () => {
  test('originOfUrl understands the Electrobun views scheme and http', () => {
    expect(originOfUrl('views://mainview/index.html')).toBe(VIEWS);
    expect(originOfUrl('http://127.0.0.1:5173/app')).toBe(DEV);
    expect(originOfUrl('https://example.com/a/b?c=1')).toBe('https://example.com');
    expect(originOfUrl('file:///Users/x/app/index.html')).toBeNull();
    expect(originOfUrl('about:blank')).toBeNull();
    expect(originOfUrl('')).toBeNull();
  });

  test('isAppOrigin is exact: no subdomain or path leakage', () => {
    expect(isAppOrigin(VIEWS, OWN)).toBe(true);
    expect(isAppOrigin('views://mainview2', OWN)).toBe(false);
    expect(isAppOrigin('https://127.0.0.1:5173', OWN)).toBe(false);
    expect(isAppOrigin(null, OWN)).toBe(false);
  });
});

describe('toAccelerator', () => {
  test('maps the macOS combos shared/shortcuts.ts produces', () => {
    expect(toAccelerator(combo('k', 'macos'))).toBe('Command+K');
    expect(toAccelerator(combo('t', 'macos'))).toBe('Command+T');
    expect(toAccelerator(combo('w', 'macos'))).toBe('Command+W');
    expect(toAccelerator(combo('l', 'macos'))).toBe('Command+L');
    expect(toAccelerator(combo('d', 'macos'))).toBe('Command+D');
    expect(toAccelerator(shiftCombo('d', 'macos'))).toBe('Command+Shift+D');
    expect(toAccelerator(ctrlCombo('tab'))).toBe('Control+Tab');
    expect(toAccelerator(ctrlCombo('tab', true))).toBe('Control+Shift+Tab');
  });

  test('maps the Ctrl combos produced on Windows/Linux', () => {
    for (let n = 1; n <= 9; n += 1) {
      expect(toAccelerator(combo(String(n), 'windows'))).toBe(`Control+${n}`);
      expect(toAccelerator(combo(String(n), 'macos'))).toBe(`Command+${n}`);
    }
    expect(toAccelerator(shiftCombo('d', 'linux'))).toBe('Control+Shift+D');
  });

  test('rejects what the devkit cannot register instead of guessing', () => {
    expect(toAccelerator('k')).toBeNull();
    expect(toAccelerator('cmd')).toBeNull();
    expect(toAccelerator('hyper+k')).toBeNull();
    expect(toAccelerator('cmd+')).toBeNull();
    expect(toAccelerator('cmd+shift+unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------- the tool bridge (request/reply)

/** Runs the generated preload against a fake sandbox: its only global is `window`. */
interface FakeSandbox {
  tiny: {
    api: { call(method: string, params?: unknown): Promise<unknown> };
    win: { id: string; getState(): Promise<unknown> };
  };
  __nodToolReply(id: number, ok: boolean, value: unknown): void;
  sent: unknown[];
}

function runBridge(source: string): FakeSandbox {
  const sent: unknown[] = [];
  const sandbox = {
    sent,
    __electrobunSendToHost(payload: unknown) {
      sent.push(payload);
    },
  };
  new Function('window', source)(sandbox);
  return sandbox as unknown as FakeSandbox;
}

describe('the sandboxed page bridge (tool-bridge)', () => {
  test('bakes the window id into `tiny.win.id`, JSON-encoded', () => {
    expect(toolBridgeSource('tool_tool-a')).toContain('var WINDOW_ID = "tool_tool-a";');
    const hostile = runBridge(toolBridgeSource('a"b\nc'));
    expect(hostile.tiny.win.id).toBe('a"b\nc');
  });

  test('every api-gated member rejects with the exact tinyjs sentence', async () => {
    const source = toolBridgeSource('link_1');
    for (const member of REFUSED_MEMBERS) {
      const target =
        member.owner === '' ? `tiny.${member.member}` : `tiny.${member.owner}.${member.member}`;
      expect(source).toContain(
        `${target} = refuse(${JSON.stringify(disabledMessage(member.method))});`,
      );
    }
    const page = runBridge(source);
    await expect(page.tiny.win.getState()).rejects.toThrow(
      '"win.getState" is disabled by tinyjs.json "api"',
    );
  });

  test('api.call sends an id and settles when the host replies', async () => {
    const page = runBridge(toolBridgeSource('tool_tool-a'));
    const first = page.tiny.api.call('login.report', { state: 'form' });
    expect(page.sent).toEqual([{ id: 1, method: 'login.report', params: { state: 'form' } }]);

    page.__nodToolReply(1, true, { ok: true });
    await expect(first).resolves.toEqual({ ok: true });

    const second = page.tiny.api.call('login.report');
    expect(page.sent[1]).toEqual({ id: 2, method: 'login.report', params: undefined });
    page.__nodToolReply(2, false, '"login.report" is disabled by tinyjs.json "api"');
    await expect(second).rejects.toThrow('"login.report" is disabled by tinyjs.json "api"');
  });

  test('a reply for an id the page never issued is ignored', async () => {
    const page = runBridge(toolBridgeSource('popup1'));
    const pending = page.tiny.api.call('login.report');
    // Not the pending id: no promise is settled and the real one still answers.
    page.__nodToolReply(99, true, { wrong: true });
    page.__nodToolReply(1, true, 'the right answer');
    await expect(pending).resolves.toBe('the right answer');
  });
});

describe('replySource', () => {
  test('carries id, ok and the value as JSON arguments', () => {
    expect(replySource(7, { ok: true, result: { state: 'form' } })).toBe(
      'window.__nodToolReply(7, true, {"state":"form"})',
    );
    expect(replySource(12, { ok: false, error: disabledMessage('login.report') })).toBe(
      'window.__nodToolReply(12, false, "\\"login.report\\" is disabled by tinyjs.json \\"api\\"")',
    );
    expect(replySource(1, { ok: true, result: undefined })).toBe(
      'window.__nodToolReply(1, true, null)',
    );
  });

  test('a hostile message stays data, never code', () => {
    const js = replySource(3, { ok: false, error: 'x"); window.pwned = 1; //' });
    expect(js).toBe('window.__nodToolReply(3, false, "x\\"); window.pwned = 1; //")');
    const calls: unknown[][] = [];
    const fake: Record<string, unknown> = {
      __nodToolReply: (...args: unknown[]) => {
        calls.push(args);
      },
    };
    new Function('window', String(js))(fake);
    expect(fake.pwned).toBeUndefined();
    expect(calls).toEqual([[3, false, 'x"); window.pwned = 1; //']]);
  });

  test('an id a page cannot have sent produces no script at all', () => {
    for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(replySource(id, { ok: true, result: 1 })).toBeNull();
    }
  });
});

/** The reply promise of a request the test just made, or a failed expectation. */
async function answered(request: { id: number | null; reply: Promise<unknown> | null }): Promise<unknown> {
  expect(request.reply).not.toBeNull();
  return await (request.reply as Promise<unknown>);
}

describe('hostRequest (one sandboxed page call, answered)', () => {
  test('a tool view login.report resolves with the handler answer', async () => {
    const gate = createViewGate({
      appOrigins: () => OWN,
      onHostCall: (method, params, meta) => ({ method, params, meta }),
    });
    gate.register(21, 'tool-7', 'tool');
    gate.commit(21, 'https://airtable.com');
    const request = gate.hostRequest(
      21,
      'tool-7',
      { id: 3, method: 'login.report', params: { state: 'form' } },
      'https://airtable.com',
    );
    expect(request.id).toBe(3);
    expect(request.decision).toEqual({
      allowed: true,
      meta: { window: 'tool-7', origin: 'https://airtable.com' },
    });
    await expect(answered(request)).resolves.toEqual({
      ok: true,
      result: {
        method: 'login.report',
        params: { state: 'form' },
        meta: { window: 'tool-7', origin: 'https://airtable.com' },
      },
    });
  });

  test('popup, link and embed views are refused with the tinyjs sentence for any method', async () => {
    for (const kind of ['popup', 'link', 'embed'] as const) {
      const gate = createViewGate({ appOrigins: () => OWN });
      gate.register(30, `${kind}-1`, kind);
      gate.commit(30, 'https://example.com');
      for (const method of ['login.report', 'win.getState']) {
        const request = gate.hostRequest(
          30,
          `${kind}-1`,
          { id: 1, method, params: {} },
          'https://example.com',
        );
        expect(request.decision).toEqual({ allowed: false, error: disabledMessage(method) });
        await expect(answered(request)).resolves.toEqual({
          ok: false,
          error: `"${method}" is disabled by tinyjs.json "api"`,
        });
      }
    }
  });

  test('a tool view asking for win.getState rejects with the exact sentence', async () => {
    const gate = createViewGate({ appOrigins: () => OWN });
    gate.register(22, 'tool-8', 'tool');
    gate.commit(22, 'https://airtable.com');
    const request = gate.hostRequest(
      22,
      'tool-8',
      { id: 2, method: 'win.getState', params: {} },
      'https://airtable.com',
    );
    await expect(answered(request)).resolves.toEqual({
      ok: false,
      error: '"win.getState" is disabled by tinyjs.json "api"',
    });
  });

  test('a throwing or rejecting handler becomes the page rejection, verbatim', async () => {
    const thrown = createViewGate({
      appOrigins: () => OWN,
      onHostCall() {
        throw new Error('login.report only comes from a tool window');
      },
    });
    thrown.register(23, 'tool-9', 'tool');
    thrown.commit(23, 'https://airtable.com');
    await expect(
      answered(
        thrown.hostRequest(
          23,
          'tool-9',
          { id: 1, method: 'login.report', params: {} },
          'https://airtable.com',
        ),
      ),
    ).resolves.toEqual({ ok: false, error: 'login.report only comes from a tool window' });

    const rejected = createViewGate({
      appOrigins: () => OWN,
      onHostCall: () => Promise.reject(new Error('login.report only comes from the tool origin')),
    });
    rejected.register(24, 'tool-10', 'tool');
    rejected.commit(24, 'https://airtable.com');
    await expect(
      answered(
        rejected.hostRequest(
          24,
          'tool-10',
          { id: 1, method: 'login.report', params: {} },
          'https://airtable.com',
        ),
      ),
    ).resolves.toEqual({ ok: false, error: 'login.report only comes from the tool origin' });
  });

  test('a payload without a usable id is dispatched and left unanswered (the one-way call)', async () => {
    const dispatched: string[] = [];
    const gate = createViewGate({
      appOrigins: () => OWN,
      onHostCall(method) {
        dispatched.push(method);
      },
    });
    gate.register(25, 'tool-11', 'tool');
    gate.commit(25, 'https://airtable.com');
    for (const payload of [
      { method: 'login.report', params: {} },
      { id: '1', method: 'login.report', params: {} },
      { id: 0, method: 'login.report', params: {} },
      { id: -4, method: 'login.report', params: {} },
      { id: 2.5, method: 'login.report', params: {} },
    ]) {
      const request = gate.hostRequest(25, 'tool-11', payload, 'https://airtable.com');
      expect(request.decision.allowed).toBe(true);
      expect(request.id).toBeNull();
      expect(request.reply).toBeNull();
    }
    expect(dispatched).toEqual(Array(5).fill('login.report'));
  });
});

describe('createGate request/reply (the backend path)', () => {
  test('a tool view login.report runs the backend handler and answers with its result', async () => {
    const seen: TinyApiMeta[] = [];
    const gate = createGate({
      api: {
        'login.report': (_params, _app, meta) => {
          seen.push(meta);
          return true;
        },
      },
      app: () => ({}) as TinyApp,
      appOrigins: () => OWN,
    });
    gate.sandboxView(9, 'https://airtable.com', 'tool-9');
    await expect(
      answered(
        gate.hostRequest(
          9,
          'tool-9',
          { id: 1, method: 'login.report', params: { state: 'form' } },
          'https://airtable.com',
        ),
      ),
    ).resolves.toEqual({ ok: true, result: true });
    expect(seen).toEqual([{ window: 'tool-9', origin: 'https://airtable.com' }]);
  });

  test('the backend refusal is the page rejection, verbatim', async () => {
    const gate = createGate({
      api: {
        'login.report': () => {
          throw new Error('login.report only comes from a tool window');
        },
      },
      app: () => ({}) as TinyApp,
      appOrigins: () => OWN,
    });
    gate.sandboxView(10, 'https://airtable.com', 'tool-10');
    await expect(
      answered(
        gate.hostRequest(
          10,
          'tool-10',
          { id: 1, method: 'login.report', params: {} },
          'https://airtable.com',
        ),
      ),
    ).resolves.toEqual({ ok: false, error: 'login.report only comes from a tool window' });
  });
});
