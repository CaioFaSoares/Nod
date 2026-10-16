// backend/tool-windows.ts against a fake runtime: opening/focusing (RF-19), geometry, the login
// cascade with its re-check (A7, D3), navigation and popup policy (D2, A20, D1, P9), persistence
// with `closeAll`/`restore` (RF-06), `reconcile` and the global shortcuts (canonico §7, §10, §13).
//
// The fake records every call the module makes to the runtime. Time is under `vi`'s control, so
// the 4 s re-check is advanced, never waited for.

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { createToolWindows } from '../backend/tool-windows';
import type { ToolWindows, ToolWindowsDeps } from '../backend/tool-windows';
import type { Entry, Id, ToolStatus } from '../shared/types';

const ENTRY_URL = 'https://kanban.example/app';
const ENTRY_AUDIT = 'https://kanban.example/app';
/** A navigation inside the entry origin that carries a query: the event must not keep it. */
const FINISH_URL = 'https://kanban.example/app?token=abc#frag';

const KANBAN: Entry = {
  id: 'kanban',
  title: 'Kanban',
  url: ENTRY_URL,
  icon: null,
  order: 10,
  roles: ['team'],
  views: [{ label: 'Sprint', url: 'https://kanban.example/boards/42', mode: 'window' }],
  auth: null,
  active: true,
};

const MAIL: Entry = {
  id: 'mail',
  title: 'Mail',
  url: 'https://mail.example/web',
  icon: null,
  order: 20,
  roles: ['team'],
  views: [
    { label: 'Inbox', url: 'https://mail.example/inbox', mode: 'navigate' },
    { label: 'Archive', url: 'https://mail.example/archive', mode: 'navigate' },
  ],
  auth: null,
  active: true,
};

const LETTER: Entry = {
  id: 'mail',
  title: 'Mail',
  url: 'https://mail.example/web',
  icon: null,
  order: 20,
  roles: ['team'],
  views: [{ label: 'Inbox', url: 'https://mail.example/inbox', mode: 'window' }],
  auth: { noFill: true },
  active: true,
};

// ---------------------------------------------------------------- fake runtime

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FakeScreen extends Rect {
  id: number;
  name: string | null;
  visible: Rect;
  scale: number;
  primary: boolean;
}

interface FakeHandle {
  show: number;
  close: number;
  evals: string[];
  position: number[] | null;
  size: number[] | null;
}

interface OpenedWindow {
  id: string;
  options: { page?: string; title?: string; size?: string; x?: number; y?: number };
}

interface RecordedEvent {
  toolId: Id | null;
  type: string;
  url: string | null;
  result: string | null;
  detail: string | null;
}

interface FakeState {
  entries: Entry[];
  screens: FakeScreen[];
  main: Rect | null;
  credential: { username: string; secret: string } | null;
  /** The vault index: it decides the fill, and it is independent of `credential` (the keychain) —
   *  the desync case is a real one. */
  hasCredential: boolean;
  failEval: boolean;
  /** true makes `win.open` throw, the way the launcher does when it refuses a window */
  failOpen: boolean;
}

interface FakeEnvironment {
  state: FakeState;
  app: unknown;
  deps: ToolWindowsDeps;
  opened: OpenedWindow[];
  handles: Map<string, FakeHandle>;
  records: RecordedEvent[];
  pushed: { event: string; data?: unknown }[];
  registered: { id: string; combo: string }[];
  unregistered: string[];
  calls: { credential: number };
  store: Map<string, unknown>;
  /** A window the runtime opened by itself: a popup that became a window never goes through
   *  `win.open`, so its handle exists before the module touches it. */
  spawnWindow(id: string): FakeHandle;
}

const BIG_SCREEN: FakeScreen = {
  id: 1,
  name: 'Built-in',
  x: 0,
  y: 0,
  width: 1680,
  height: 1050,
  visible: { x: 0, y: 25, width: 1680, height: 1025 },
  scale: 2,
  primary: true,
};

function fakeEnvironment(): FakeEnvironment {
  const state: FakeState = {
    entries: [KANBAN, MAIL],
    screens: [BIG_SCREEN],
    main: { x: 100, y: 80, width: 900, height: 600 },
    credential: { username: 'ana', secret: 's3cret' },
    hasCredential: true,
    failEval: false,
    failOpen: false,
  };
  const opened: OpenedWindow[] = [];
  const handles = new Map<string, FakeHandle>();
  const records: RecordedEvent[] = [];
  const pushed: { event: string; data?: unknown }[] = [];
  const registered: { id: string; combo: string }[] = [];
  const unregistered: string[] = [];
  const calls = { credential: 0 };
  const store = new Map<string, unknown>();

  function handle(id: string): FakeHandle {
    const existing = handles.get(id);
    if (existing !== undefined) return existing;
    const created: FakeHandle = { show: 0, close: 0, evals: [], position: null, size: null };
    handles.set(id, created);
    return created;
  }

  const app = {
    push: (event: string, data?: unknown) => {
      pushed.push({ event, data });
    },
    win: {
      open: (id: string, options?: OpenedWindow['options']) => {
        if (state.failOpen) throw new Error('no window for you');
        opened.push({ id, options: options ?? {} });
        handle(id);
      },
      getState: async () => state.main,
    },
    window: (id: string) => {
      const record = handle(id);
      return {
        id,
        show: () => {
          record.show += 1;
        },
        close: () => {
          record.close += 1;
          handles.delete(id);
        },
        eval: (js: string) => {
          if (state.failEval) throw new Error('eval refused');
          record.evals.push(js);
        },
        setPosition: (x: number, y: number) => {
          record.position = [x, y];
        },
        setSize: (width: number, height: number) => {
          record.size = [width, height];
        },
      };
    },
    screens: async () => state.screens,
    hotkey: {
      register: (id: string, combo: string) => {
        registered.push({ id, combo });
      },
      unregister: (id: string) => {
        unregistered.push(id);
      },
    },
  };

  const deps: ToolWindowsDeps = {
    entries: () => state.entries,
    icon: () => null,
    credential: async () => {
      calls.credential += 1;
      return state.credential;
    },
    hasCredential: () => state.hasCredential,
    record: (event) => {
      records.push({
        toolId: event.toolId,
        type: event.type,
        url: event.url,
        result: event.result,
        detail: event.detail,
      });
    },
    store: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
        return true;
      },
    },
    os: 'macos',
    hotkeys: true,
  };

  return {
    state,
    app,
    deps,
    opened,
    handles,
    records,
    pushed,
    registered,
    unregistered,
    calls,
    store,
    spawnWindow: handle,
  };
}

/** The fake implements the slice of the runtime `TinyApp` the module touches. */
function makeToolWindows(env: FakeEnvironment, deps: ToolWindowsDeps = env.deps): ToolWindows {
  return createToolWindows(env.app as never, deps);
}

function handle(env: FakeEnvironment, id: string): FakeHandle {
  const found = env.handles.get(id);
  if (found === undefined) throw new Error(`no fake handle for ${id}`);
  return found;
}

function tool(toolWindows: ToolWindows, id: Id): ToolStatus {
  const found = toolWindows.state().tools.find((status) => status.id === id);
  if (found === undefined) throw new Error(`no tool state for ${id}`);
  return found;
}

function openTools(env: FakeEnvironment): unknown {
  return env.store.get('open_tools') ?? null;
}

interface NavEvent {
  window: string;
  kind: 'policy' | 'start' | 'commit' | 'finish' | 'fail' | 'crash';
  url: string;
  isMainFrame?: boolean | null;
  error?: string;
}

interface PopupEvent {
  window: string | null;
  opener?: string;
  url: string;
  kind?: 'policy' | 'open';
  mode?: string;
  action?: 'window' | 'external' | 'deny';
}

function nav(over: Partial<NavEvent> = {}): NavEvent {
  return { window: 'tool_kanban', kind: 'policy', url: ENTRY_URL, isMainFrame: true, ...over };
}

function popup(over: Partial<PopupEvent> = {}): PopupEvent {
  return { window: null, opener: 'tool_kanban', url: ENTRY_URL, kind: 'policy', ...over };
}

/** Lets the pending microtasks run: `void apply(...)` and the open chain continue after awaits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- opening

describe('tool windows — opening', () => {
  test('opening the same tool twice opens one window and only focuses it the second time', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('kanban');
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban']);
    expect(handle(env, 'tool_kanban').show).toBe(1);
    expect(handle(env, 'tool_kanban').evals).toEqual([]); // nothing reloads (RF-19)
    expect(tool(toolWindows, 'kanban').openWindows).toBe(1);
  });

  test('the window opens at 1280×800, cascaded 28 px, and the geometry lands on the handle', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(env.opened).toEqual([
      {
        id: 'tool_kanban',
        options: {
          page: ENTRY_URL,
          title: 'Kanban',
          x: 128,
          y: 108,
          size: '1280x800',
        },
      },
    ]);
    expect(handle(env, 'tool_kanban').position).toEqual([128, 108]);
    expect(handle(env, 'tool_kanban').size).toEqual([1280, 800]);
  });

  test('the window is capped at 90% of the usable area of the screen', async () => {
    const env = fakeEnvironment();
    env.state.screens = [
      {
        id: 1,
        name: 'Small',
        x: 0,
        y: 0,
        width: 1024,
        height: 600,
        visible: { x: 0, y: 25, width: 1024, height: 600 },
        scale: 1,
        primary: true,
      },
    ];
    await makeToolWindows(env).open('kanban');
    expect(env.opened[0].options.size).toBe('922x540');
  });

  test('the geometry follows the screen the main window sits on', async () => {
    const env = fakeEnvironment();
    env.state.screens = [
      {
        id: 1,
        name: 'Laptop',
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        visible: { x: 0, y: 25, width: 1440, height: 875 },
        scale: 2,
        primary: true,
      },
      {
        id: 2,
        name: 'Studio',
        x: 1440,
        y: 0,
        width: 1920,
        height: 1080,
        visible: { x: 1440, y: 0, width: 1920, height: 1080 },
        scale: 2,
        primary: false,
      },
    ];
    env.state.main = { x: 1500, y: 100, width: 900, height: 600 };
    await makeToolWindows(env).open('kanban');
    expect(env.opened[0].options).toMatchObject({ x: 1528, y: 128, size: '1280x800' });
  });

  test('without a main window the default geometry comes from the primary screen', async () => {
    const env = fakeEnvironment();
    env.state.main = null;
    await makeToolWindows(env).open('kanban');
    expect(env.opened[0].options).toMatchObject({ x: 0, y: 25, size: '1280x800' });
  });

  test('a tool that is not visible does not open a window', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await expect(toolWindows.open('nope')).rejects.toThrow('unknown tool');
    expect(env.opened).toEqual([]);
  });

  test('a window that refuses to open becomes the tool error, audited', async () => {
    const env = fakeEnvironment();
    env.state.failOpen = true;
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(env.opened).toEqual([]);
    expect(tool(toolWindows, 'kanban').error).toBe('could not open the tool window');
    expect(env.records).toContainEqual({
      toolId: 'kanban',
      type: 'load_failed',
      url: ENTRY_AUDIT,
      result: 'failed',
      detail: 'could not open the tool window',
    });
  });
});

// ---------------------------------------------------------------- state and loading

describe('tool windows — state', () => {
  test('state reports the digit, the open windows, loading, error and the login result', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(tool(toolWindows, 'kanban')).toEqual({
      id: 'kanban',
      title: 'Kanban',
      icon: null,
      digit: 1,
      openWindows: 1,
      loading: true,
      error: null,
      login: null,
    });
    expect(tool(toolWindows, 'mail')).toEqual({
      id: 'mail',
      title: 'Mail',
      icon: null,
      digit: 2,
      openWindows: 0,
      loading: false,
      error: null,
      login: null,
    });
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();
    expect(tool(toolWindows, 'kanban').loading).toBe(false);
    toolWindows.onNavigate(nav({ kind: 'fail', url: ENTRY_URL, error: 'connection refused' }));
    const status = tool(toolWindows, 'kanban');
    expect(status.loading).toBe(false);
    expect(status.error).toBe('failed to load');
    expect(env.records).toContainEqual({
      toolId: 'kanban',
      type: 'load_failed',
      url: ENTRY_AUDIT,
      result: 'failed',
      detail: 'connection refused',
    });
  });

  test('a finish from a subframe does not end the loading of the tool window', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL, isMainFrame: false }));
    await settle();
    expect(tool(toolWindows, 'kanban').loading).toBe(true);
    expect(handle(env, 'tool_kanban').evals).toEqual([]);
  });
});

// ---------------------------------------------------------------- views

describe('tool windows — views', () => {
  test('a window-mode view opens its own window at the view address', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.openView('kanban', 0);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban_0']);
    expect(env.opened[0].options).toMatchObject({
      page: 'https://kanban.example/boards/42',
      title: 'Kanban · Sprint',
    });
    expect(tool(toolWindows, 'kanban').openWindows).toBe(1);
  });

  test('opening the same view twice focuses its window instead of opening another', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.openView('kanban', 0);
    await toolWindows.openView('kanban', 0);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban_0']);
    expect(handle(env, 'tool_kanban_0').show).toBe(1);
  });

  test('a navigate-mode view on a cold tool opens the window straight at the view address', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.openView('mail', 0);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_mail']);
    expect(env.opened[0].options).toMatchObject({
      page: 'https://mail.example/inbox',
      title: 'Mail',
    });
    expect(env.records.some((event) => event.type === 'view_opened')).toBe(true);
  });

  test('a navigate-mode view on an open tool navigates the existing window', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('mail');
    await toolWindows.openView('mail', 1);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_mail']);
    expect(handle(env, 'tool_mail').show).toBe(1);
    expect(handle(env, 'tool_mail').evals).toEqual([
      'location.href = "https://mail.example/archive"',
    ]);
    expect(env.records).toContainEqual({
      toolId: 'mail',
      type: 'view_opened',
      url: 'https://mail.example/archive',
      result: null,
      detail: 'Archive',
    });
  });

  test('a view that does not exist is refused', async () => {
    const env = fakeEnvironment();
    await expect(makeToolWindows(env).openView('kanban', 3)).rejects.toThrow('view not found');
    expect(env.opened).toEqual([]);
  });
});

// ---------------------------------------------------------------- navigation policy

describe('tool windows — navigation policy', () => {
  test('mailto and tel from the main frame go to the browser; other schemes are denied', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(toolWindows.onNavigate(nav({ url: 'mailto:ana@example.com' }))).toBe('external');
    expect(toolWindows.onNavigate(nav({ url: 'tel:+5511999999999' }))).toBe('external');
    expect(toolWindows.onNavigate(nav({ url: 'javascript:alert(1)' }))).toBe('deny');
    expect(toolWindows.onNavigate(nav({ url: 'smb://fileserver/share' }))).toBe('deny');
    expect(env.records).toContainEqual({
      toolId: 'kanban',
      type: 'external_opened',
      url: null, // mailto: has no auditable URL — and the raw one never enters the event
      result: 'external',
      detail: 'mailto:',
    });
    expect(env.records).toContainEqual({
      toolId: 'kanban',
      type: 'navigation_blocked',
      url: null,
      result: 'denied',
      detail: 'javascript:',
    });
    expect(env.records.filter((event) => event.type === 'navigation_blocked')).toHaveLength(2);
  });

  test('mailto from a subframe is denied', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(toolWindows.onNavigate(nav({ url: 'mailto:ana@example.com', isMainFrame: false }))).toBe(
      'deny',
    );
  });

  test('plain http outside loopback is denied; https and loopback http load', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(
      toolWindows.onNavigate(nav({ url: 'http://example.com/steal?token=abc' })),
    ).toBe('deny');
    expect(
      env.records.filter((event) => event.type === 'navigation_blocked'),
    ).toEqual([
      { toolId: 'kanban', type: 'navigation_blocked', url: null, result: 'denied', detail: 'http:' },
    ]);
    expect(
      toolWindows.onNavigate(nav({ url: 'https://idp.example/login?token=abc' })),
    ).toBeUndefined();
    expect(toolWindows.onNavigate(nav({ url: 'http://127.0.0.1:5173/app' }))).toBeUndefined();
  });

  test('the main window and windows of other origins are not this module business', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    expect(toolWindows.onNavigate(nav({ window: 'main', url: 'mailto:ana@example.com' }))).toBeUndefined();
    expect(toolWindows.onNavigate(nav({ window: 'tool_other', url: 'javascript:alert(1)' }))).toBeUndefined();
    expect(toolWindows.onNavigate(nav({ window: 'main', kind: 'finish' }))).toBeUndefined();
    expect(env.records).toEqual([]);
  });

  test('an event never carries the query string or the fragment', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(
      toolWindows.onPopup(
        popup({ url: 'https://elsewhere.example/page?token=abc#frag' }),
      ),
    ).toBe('external');
    expect(env.records).toContainEqual({
      toolId: 'kanban',
      type: 'external_opened',
      url: 'https://elsewhere.example/page',
      result: 'external',
      detail: null,
    });
  });
});

// ---------------------------------------------------------------- popups

describe('tool windows — popups', () => {
  test('a popup on the entry origin becomes a window', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(toolWindows.onPopup(popup({ url: `${ENTRY_URL}/board/7` }))).toBe('window');
  });

  test('a popup on a provider origin already seen in that window becomes a window', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: 'https://idp.example/login' }));
    await settle();
    expect(toolWindows.onPopup(popup({ url: 'https://idp.example/consent' }))).toBe('window');
  });

  test('an identity path becomes a window even on an unseen origin', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(toolWindows.onPopup(popup({ url: 'https://sso.example/saml/acs' }))).toBe('window');
  });

  test('another origin goes to the browser; a non-http scheme is denied', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(toolWindows.onPopup(popup({ url: 'https://elsewhere.example/x' }))).toBe('external');
    expect(toolWindows.onPopup(popup({ url: 'mailto:ana@example.com' }))).toBe('deny');
  });

  test('a popup outside a tool window is left to the configured mode', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    const recorded = env.records.length;
    expect(toolWindows.onPopup(popup({ opener: 'main', url: 'https://elsewhere.example/x' }))).toBeUndefined();
    expect(toolWindows.onPopup(popup({ opener: 'tool_closed', url: 'https://x.example/' }))).toBeUndefined();
    expect(toolWindows.onPopup({ ...popup({ url: 'https://x.example/' }), kind: undefined })).toBeUndefined();
    // `open` already recorded `tool_opened` (§4): the popups below add no event on top of it.
    expect(env.records).toHaveLength(recorded);
  });

  test('a popup that became a window is closed on lock (D1)', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    // The popup window is the runtime's: it was born before the event reached the module.
    const popupHandle = env.spawnWindow('pop_1');
    toolWindows.onPopup({
      kind: 'open',
      window: 'pop_1',
      action: 'window',
      opener: 'tool_kanban',
      url: `${ENTRY_URL}/board/7`,
    });
    toolWindows.closeAll();
    expect(popupHandle.close).toBe(1);
    expect(env.handles.has('pop_1')).toBe(false);
  });
});

// ---------------------------------------------------------------- login cascade

describe('tool windows — login cascade', () => {
  test('the first finish injects the credential once; a second finish retries without fill', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();
    const evals = handle(env, 'tool_kanban').evals;
    expect(evals).toHaveLength(1);
    expect(evals[0]).toContain('"fill":true');
    expect(evals[0]).toContain('"origin":"https://kanban.example"');
    expect(env.calls.credential).toBe(1);
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(2);
    expect(handle(env, 'tool_kanban').evals[1]).toContain('"fill":false');
    expect(handle(env, 'tool_kanban').evals[1]).not.toContain('s3cret');
    expect(env.calls.credential).toBe(1); // the second step does not read the keychain
  });

  test('without a credential the adapter still inspects the page, without fill', async () => {
    const env = fakeEnvironment();
    env.state.credential = null;
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"fill":false');
    expect(env.records.some((event) => event.type === 'login')).toBe(false);
  });

  test('a tool with no credential in the vault index ends in session, never in filled', async () => {
    const env = fakeEnvironment();
    env.state.hasCredential = false;
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();
    expect(env.calls.credential).toBe(0); // nothing to read: the cascade never asked for a fill
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"fill":false');
    toolWindows.onReport('tool_kanban', 'no-form', 'https://kanban.example');
    await settle();
    expect(tool(toolWindows, 'kanban').login).toBe('session');
    expect(env.records.filter((event) => event.type === 'login')).toEqual([
      { toolId: 'kanban', type: 'login', url: ENTRY_AUDIT, result: 'session', detail: null },
    ]);
  });

  test('an index that has the item and a keychain that lost it gives the attempt back', async () => {
    const env = fakeEnvironment();
    env.state.credential = null; // `hasCredential` stays true: the index has the item
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(env.calls.credential).toBe(1);
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"fill":false');
    // The attempt came back: the next finish tries the fill again instead of reading it as spent.
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(env.calls.credential).toBe(2);
    expect(handle(env, 'tool_kanban').evals).toHaveLength(2);
    expect(handle(env, 'tool_kanban').evals[1]).toContain('"fill":false');
    toolWindows.onReport('tool_kanban', 'no-form', 'https://kanban.example');
    await settle();
    expect(tool(toolWindows, 'kanban').login).toBe('session');
    expect(env.records.filter((event) => event.type === 'login')).toEqual([
      { toolId: 'kanban', type: 'login', url: ENTRY_AUDIT, result: 'session', detail: null },
    ]);
  });

  test('the tool override noFill keeps the credential out of the page', async () => {
    const env = fakeEnvironment();
    env.state.entries = [LETTER];
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('mail');
    toolWindows.onNavigate(nav({ window: 'tool_mail', kind: 'finish', url: 'https://mail.example/web' }));
    await settle();
    expect(env.calls.credential).toBe(0);
    expect(handle(env, 'tool_mail').evals[0]).toContain('"fill":false');
  });

  test('a report from another origin is ignored; the entry origin closes the cascade', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();
    toolWindows.onReport('tool_kanban', 'no-form', 'https://elsewhere.example');
    await settle();
    expect(tool(toolWindows, 'kanban').login).toBeNull();
    expect(env.records.filter((event) => event.type === 'login')).toEqual([]);
    toolWindows.onReport('tool_kanban', 'no-form', undefined);
    await settle();
    expect(tool(toolWindows, 'kanban').login).toBe('filled');
    expect(env.records.filter((event) => event.type === 'login')).toEqual([
      { toolId: 'kanban', type: 'login', url: ENTRY_AUDIT, result: 'filled', detail: null },
    ]);
  });

  test('a report from a window that is not ours is ignored', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    // `open` already recorded `tool_opened` (§4): these reports must add no event on top of it.
    const recorded = env.records.length;
    toolWindows.onReport('main', 'filled', undefined);
    toolWindows.onReport('tool_closed', 'filled', undefined);
    await settle();
    expect(env.records).toHaveLength(recorded);
  });

  test('a refused eval is audited as a failed login (A10)', async () => {
    const env = fakeEnvironment();
    env.state.failEval = true;
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(handle(env, 'tool_kanban').evals).toEqual([]);
    expect(env.records).toContainEqual({
      toolId: 'kanban',
      type: 'login',
      url: ENTRY_AUDIT,
      result: 'failed',
      detail: 'could not reach the tool window',
    });
    // The attempt was spent: a later finish does not inject again (no login loop).
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(env.calls.credential).toBe(1);
  });

  test('leaving the entry origin blocks the injection until the window comes back', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'start', url: 'https://idp.example/authorize' }));
    await settle();
    expect(handle(env, 'tool_kanban').evals).toEqual([]);
    toolWindows.onNavigate(nav({ kind: 'finish', url: 'https://idp.example/authorize' }));
    await settle();
    // D3: the last URL seen is the provider, so the credential never reaches it.
    expect(handle(env, 'tool_kanban').evals).toEqual([]);
    expect(env.calls.credential).toBe(0);
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    // The provider resolved the login: the adapter finds no form back on the entry origin.
    toolWindows.onReport('tool_kanban', 'no-form', 'https://kanban.example');
    await settle();
    expect(tool(toolWindows, 'kanban').login).toBe('provider');
  });

  test('the fill that is never reported is re-checked after 4 s (A7)', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    vi.advanceTimersByTime(3999);
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(2);
    expect(handle(env, 'tool_kanban').evals[1]).toContain('"fill":false');
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(2);
  });

  test('the re-check is dropped when the window is gone', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    const before = handle(env, 'tool_kanban');
    expect(before.evals).toHaveLength(1);
    toolWindows.close('kanban');
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(before.evals).toHaveLength(1); // the timer went with the window
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban']);
  });
});

// ---------------------------------------------------------------- close, restore, reconcile

describe('tool windows — closing and restoring', () => {
  test('closing a tool removes it from the persisted list', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('mail');
    expect(openTools(env)).toEqual([{ toolId: 'kanban' }, { toolId: 'mail' }]);
    const before = handle(env, 'tool_kanban');
    const state = toolWindows.close('kanban');
    expect(before.close).toBe(1);
    expect(state.tools.find((status) => status.id === 'kanban')?.openWindows).toBe(0);
    expect(openTools(env)).toEqual([{ toolId: 'mail' }]);
  });

  test('a window the person closed leaves the persisted list', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('mail');
    toolWindows.onWindowClosed('tool_mail');
    expect(openTools(env)).toEqual([{ toolId: 'kanban' }]);
    expect(tool(toolWindows, 'mail').openWindows).toBe(0);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_mail']);
  });

  test('a window the module closed itself does not touch the list again', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.closeAll();
    toolWindows.onWindowClosed('tool_kanban'); // the late event of a window we closed
    expect(openTools(env)).toEqual([{ toolId: 'kanban' }]);
  });

  test('closeAll closes the windows and keeps the list; restore reopens only visible tools', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('mail');
    toolWindows.closeAll();
    expect(env.handles.size).toBe(0);
    expect(openTools(env)).toEqual([{ toolId: 'kanban' }, { toolId: 'mail' }]);
    env.state.entries = [KANBAN];
    await toolWindows.restore();
    expect(env.handles.has('tool_kanban')).toBe(true);
    expect(env.handles.has('tool_mail')).toBe(false);
    expect(openTools(env)).toEqual([{ toolId: 'kanban' }]);
    expect(tool(toolWindows, 'kanban').loading).toBe(true);
  });

  test('restore reopens a view window at the view address', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.openView('kanban', 0);
    expect(openTools(env)).toEqual([{ toolId: 'kanban', view: 0 }]);
    toolWindows.closeAll();
    await toolWindows.restore();
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban_0', 'tool_kanban_0']);
    expect(env.opened[1].options.page).toBe('https://kanban.example/boards/42');
  });

  test('restore ignores a store that holds garbage', async () => {
    const env = fakeEnvironment();
    env.store.set('open_tools', 'not a list');
    const toolWindows = makeToolWindows(env);
    await toolWindows.restore();
    expect(env.opened).toEqual([]);
    expect(openTools(env)).toEqual([]);
  });

  test('reconcile closes the windows of tools that are no longer visible', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('mail');
    env.state.entries = [KANBAN];
    const before = handle(env, 'tool_mail');
    toolWindows.reconcile();
    expect(before.close).toBe(1);
    expect(env.handles.has('tool_kanban')).toBe(true);
    expect(toolWindows.state().tools.map((status) => status.id)).toEqual(['kanban']);
    expect(openTools(env)).toEqual([{ toolId: 'kanban' }]);
  });

  test('reconcile while nothing is visible keeps the persisted list for the next unlock', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.closeAll();
    env.state.entries = []; // locked: no entry is visible
    toolWindows.reconcile();
    expect(openTools(env)).toEqual([{ toolId: 'kanban' }]);
  });

  test('reload opens the tool again from scratch', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    const before = handle(env, 'tool_kanban');
    await toolWindows.reload('kanban');
    expect(before.close).toBe(1);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_kanban']);
    expect(tool(toolWindows, 'kanban').loading).toBe(true);
    expect(tool(toolWindows, 'kanban').openWindows).toBe(1);
    expect(handle(env, 'tool_kanban').evals).toEqual([]);
  });
});

// ---------------------------------------------------------------- shortcuts

describe('tool windows — global shortcuts', () => {
  test('the shortcuts are registered once while a Bond window is focused and released after', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onFocus('tool_kanban', true);
    const ids = ['digit-1', 'digit-2', 'digit-3', 'digit-4', 'digit-5', 'digit-6', 'digit-7', 'digit-8', 'digit-9', 'palette'];
    expect(env.registered.map((entry) => entry.id)).toEqual(ids);
    expect(env.registered[0].combo).toBe('cmd+1');
    expect(env.registered[9].combo).toBe('cmd+k');
    toolWindows.onFocus('tool_kanban', true); // focusing again registers nothing
    expect(env.registered.map((entry) => entry.id)).toEqual(ids);
    toolWindows.onFocus('main', true);
    toolWindows.onFocus('tool_kanban', false);
    expect(env.unregistered).toEqual([]); // the main window is still focused
    toolWindows.onFocus('main', false);
    expect(env.unregistered).toEqual(ids);
    expect(env.registered.map((entry) => entry.id)).toEqual(ids); // no double registration
  });

  test('a window that is not ours does not hold the shortcuts', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    toolWindows.onFocus('tool_kanban', true); // not open
    toolWindows.onFocus('some_other_app', true);
    expect(env.registered).toEqual([]);
  });

  test('without the capability no shortcut is ever registered', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env, { ...env.deps, hotkeys: false });
    toolWindows.onFocus('main', true);
    expect(env.registered).toEqual([]);
    expect(env.unregistered).toEqual([]);
  });

  test('a digit shortcut opens the tool in that position', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    toolWindows.onHotkey('digit-2');
    await settle();
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_mail']);
    toolWindows.onHotkey('digit-9');
    toolWindows.onHotkey('digit-');
    toolWindows.onHotkey('nonsense');
    await settle();
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_mail']);
  });

  test('the palette shortcut shows the main window and pushes the event', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    toolWindows.onHotkey('palette');
    expect(handle(env, 'main').show).toBe(1);
    expect(env.pushed).toContainEqual({ event: 'palette', data: null });
  });
});
