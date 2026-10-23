// backend/tool-windows.ts against a fake runtime: opening/focusing (RF-19), geometry, the login
// cascade with its re-check (A7, D3), navigation and popup policy (D2, A20, D1, P9), persistence
// with `closeAll`/`restore` (RF-06), `reconcile` and the global shortcuts (canonico §7, §10, §13).
//
// The fake records every call the module makes to the runtime. Time is under `vi`'s control, so
// the 4 s re-check is advanced, never waited for. The fill gate (RF-38) runs against the real
// `backend/repo.ts` and `backend/vault.ts`: there the entry address and the saved origin come from
// SQLite, so the cascade reads what the person actually saved the credential for.

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { createRepo } from '../backend/repo';
import { createToolWindows, warningScript } from '../backend/tool-windows';
import { createVault } from '../backend/vault';
import { memorySqlite } from './helpers/sqlite-bun';
import type { Repo } from '../backend/repo';
import type { ToolWindows, ToolWindowsDeps } from '../backend/tool-windows';
import type { Vault } from '../backend/vault';
import type { Entry, Id, PasswordHash, Person, SecretStore, ToolStatus } from '../shared/types';

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
  /** one entry per `show()`, true when it asked for the focus (`activate` was not false) */
  shows: boolean[];
  /** `hide()` calls — a docked tab put away with `{ app: false }` (RF-50) */
  hides: number;
  close: number;
  evals: string[];
  position: number[] | null;
  size: number[] | null;
  /** the last `setChrome` call (E03/RF-51), or null when the window was never re-chromed */
  chrome: { frame?: boolean } | null;
}

interface OpenedWindow {
  id: string;
  options: {
    page?: string;
    title?: string;
    size?: string;
    x?: number;
    y?: number;
    /** E03/RF-49: `{ frame: false }` is how a docked tab is born frameless (S1) */
    chrome?: { frame?: boolean };
  };
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
  /** the footprint of main, decorations included — what the slot formula reads (spikes §3) */
  outer: { width: number; height: number };
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  /** Wayland answers false; there the backend runs in windows mode (RF-49, RF-52) */
  canPosition: boolean;
  credential: { username: string; secret: string } | null;
  /** The vault index: the origin the credential was saved for. It decides the fill, and it is
   *  independent of `credential` (the keychain) — the desync case is a real one. */
  vaultOrigin: string | null;
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
  calls: { credential: number; saveTab: string[] };
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
    outer: { width: 900, height: 632 },
    visible: true,
    minimized: false,
    focused: false,
    canPosition: false,
    credential: { username: 'ana', secret: 's3cret' },
    vaultOrigin: 'https://kanban.example',
    failEval: false,
    failOpen: false,
  };
  const opened: OpenedWindow[] = [];
  const handles = new Map<string, FakeHandle>();
  const records: RecordedEvent[] = [];
  const pushed: { event: string; data?: unknown }[] = [];
  const registered: { id: string; combo: string }[] = [];
  const unregistered: string[] = [];
  const calls = { credential: 0, saveTab: [] as string[] };
  // The fixture runs in Windows mode (Wayland): the day-one behavior these tests pin (RF-52). A
  // docked test asks for the other mode by making the runtime able to position windows.
  const store = new Map<string, unknown>();

  function handle(id: string): FakeHandle {
    const existing = handles.get(id);
    if (existing !== undefined) return existing;
    const created: FakeHandle = { shows: [], hides: 0, close: 0, evals: [], position: null, size: null, chrome: null };
    handles.set(id, created);
    return created;
  }

  /** Main as `win.getState()` answers: the rect the tests set, plus what the OS says of it. */
  function mainState(): Record<string, unknown> | null {
    if (state.main === null) return null;
    return {
      ...state.main,
      outer: state.outer,
      visible: state.visible,
      minimized: state.minimized,
      focused: state.focused,
      canPosition: state.canPosition,
    };
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
      getState: async () => mainState(),
    },
    window: (id: string) => {
      const record = handle(id);
      return {
        id,
        show: (opts?: { activate?: boolean }) => {
          record.shows.push(opts === undefined || opts.activate !== false);
        },
        hide: () => {
          record.hides += 1;
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
        setChrome: (opts: { frame?: boolean }) => {
          record.chrome = opts;
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
    vaultOrigin: () => state.vaultOrigin,
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
    saveTab: async (id) => {
      calls.saveTab.push(id);
      return { kind: 'view', entryId: 'kanban' };
    },
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

// ---------------------------------------------------------------- real catalog and vault

// The fill gate is the one place in this module that reads the catalog and the vault, so those
// tests put the real `backend/repo.ts` and `backend/vault.ts` behind the dependencies (RF-38):
// the entry address and the origin the credential was saved for come from SQLite, never from the
// fake state. Only the runtime stays fake — the adapter script is recorded, never executed.

function memoryKeychain(): SecretStore {
  const items = new Map<string, string>();
  return {
    async get(key) {
      return items.get(key) ?? null;
    },
    async set(key, value) {
      items.set(key, value);
      return true;
    },
    async delete(key) {
      return items.delete(key);
    },
  };
}

const VAULT_PASSWORD: PasswordHash = {
  algorithm: 'PBKDF2-SHA256',
  hash: 'aGFzaC1ub3QtdXNlZA==',
  salt: 'c2FsdC1ub3QtdXNlZA==',
  iterations: 1000,
};

interface Catalog {
  repo: Repo;
  vault: Vault;
  person: Person;
}

/** The `vaultKey` of the unlocked session behind these windows (SP02 §8): the vault needs one. */
const VAULT_KEY = new Uint8Array(32).fill(5);

/** A real repository holding `entry`, with a real vault and one person. */
function catalog(entry: Entry): Catalog {
  const repo = createRepo(memorySqlite());
  repo.migrate();
  // The entry's grants are foreign keys into `role`: the roles it names have to exist.
  for (const roleId of entry.roles) repo.saveRole({ id: roleId, name: roleId, admin: false });
  repo.saveEntry(entry);
  const vault = createVault({ repo, keychain: memoryKeychain(), vaultKey: () => VAULT_KEY });
  const person = repo.createPerson({
    email: 'ana@example.test',
    name: 'Ana',
    password: VAULT_PASSWORD,
    roles: [],
  });
  return { repo, vault, person };
}

/** The fake runtime with that real catalog behind the window dependencies. */
function makeCatalogToolWindows(env: FakeEnvironment, catalog: Catalog): ToolWindows {
  return makeToolWindows(env, {
    ...env.deps,
    entries: () => catalog.repo.listEntries().filter((entry) => entry.active),
    credential: async (toolId) => {
      env.calls.credential += 1;
      // RF-65: the window knows its tool; which credential fills it is the vault's own rule.
      return catalog.vault.readDefault(catalog.person.id, toolId);
    },
    vaultOrigin: (toolId) => catalog.repo.vaultOrigin(catalog.person.id, toolId),
  });
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

/** A window state event, the way `backend/main.ts`'s `onWindowState` hands it down (E03/RF-49). */
function winState(win: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { win, fullscreen: false, maximized: false, minimized: false, focused: true, ...over };
}

/** The same fake, able to position windows, and the panel the main page reports (E03/RF-49). */
function dockedEnvironment(): FakeEnvironment {
  const env = fakeEnvironment();
  env.state.canPosition = true;
  return env;
}

/** The slot as the page measures it: the center panel of a 900×600 main page at 100,80. */
const SLOT = { x: 40, y: 60, width: 500, height: 340 };
/** …and where it lands: dx 0, dy 32 (the title bar) — `docs/handovers/e03-spikes.md` §3. */
const SLOT_SCREEN = { x: 140, y: 172, width: 500, height: 340 };

/** Opens `kanban` docked on a known slot, the state the E03 tests start from. */
async function dockedKanban(toolWindows: ToolWindows): Promise<void> {
  expect(toolWindows.setSlot(SLOT)).toBe(true);
  await settle();
  await toolWindows.open('kanban');
}

/** Lets the pending microtasks run: `void apply(...)` and the open chain continue after awaits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  // V1 (SP02 §8): reading a credential now opens a `bv1.` value with WebCrypto, whose promise
  // completes on a later task rather than in the microtask queue. Real task turns drain it without
  // touching the fake clock the 4 s re-check lives on; the budget covers a loaded machine too.
  for (let i = 0; i < 256; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
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
    expect(handle(env, 'tool_kanban').shows.length).toBe(1);
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
    expect(handle(env, 'tool_kanban_0').shows.length).toBe(1);
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
    expect(handle(env, 'tool_mail').shows.length).toBe(1);
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
    env.state.vaultOrigin = null;
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
    env.state.credential = null; // `vaultOrigin` still matches: the index has the item
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

  test('a credential saved for the entry origin is filled into the form (RF-38)', async () => {
    const env = fakeEnvironment();
    const c = catalog(KANBAN);
    await c.vault.save(c.person.id, { toolId: 'kanban', username: 'ana', secret: 's3cret' });
    const toolWindows = makeCatalogToolWindows(env, c);

    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();

    expect(c.repo.vaultOrigin(c.person.id, 'kanban')).toBe('https://kanban.example');
    expect(env.calls.credential).toBe(1);
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"fill":true');
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"username":"ana"');
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"secret":"s3cret"');
  });

  test('the fill reads the default credential when the tool holds several (RF-65)', async () => {
    const env = fakeEnvironment();
    const c = catalog(KANBAN);
    await c.vault.save(c.person.id, { toolId: 'kanban', username: 'ana', secret: 's3cret' });
    const ops = await c.vault.save(c.person.id, {
      toolId: 'kanban',
      username: 'ops',
      secret: 'other',
      label: 'Ops',
    });
    const toolWindows = makeCatalogToolWindows(env, c);

    // The first credential of the tool is the default: that is the one the window receives.
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();

    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"username":"ana"');
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"secret":"s3cret"');

    // The person picks the other credential; a fresh window fills with that one instead.
    c.repo.setVaultDefault(c.person.id, ops.id);
    const second = fakeEnvironment();
    const other = makeCatalogToolWindows(second, c);
    await other.open('kanban');
    other.onNavigate(nav({ kind: 'finish', url: FINISH_URL }));
    await settle();

    expect(handle(second, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(second, 'tool_kanban').evals[0]).toContain('"username":"ops"');
    expect(handle(second, 'tool_kanban').evals[0]).toContain('"secret":"other"');
    expect(handle(second, 'tool_kanban').evals[0]).not.toContain('s3cret');
  });

  test('a local edit that moves the tool to another origin stops the fill (RF-38)', async () => {
    const env = fakeEnvironment();
    const c = catalog(KANBAN);
    await c.vault.save(c.person.id, { toolId: 'kanban', username: 'ana', secret: 's3cret' });
    // Settings: the person edits the address of the tool it saved a credential for.
    c.repo.saveEntry({ ...KANBAN, url: 'https://moved.example/app' });
    const toolWindows = makeCatalogToolWindows(env, c);

    await toolWindows.open('kanban');
    expect(env.opened[0]?.options.page).toBe('https://moved.example/app');
    toolWindows.onNavigate(nav({ kind: 'finish', url: 'https://moved.example/app' }));
    await settle();

    // The keychain is never read: the origin the credential was saved for is another one.
    expect(env.calls.credential).toBe(0);
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"fill":false');
    expect(handle(env, 'tool_kanban').evals[0]).not.toContain('s3cret');
    toolWindows.onReport('tool_kanban', 'form', 'https://moved.example');
    await settle();
    // Acts as a tool with no credential: the cascade ends in manual, never in filled/failed.
    expect(tool(toolWindows, 'kanban').login).toBe('manual');
  });

  test('a host sync that rewrites the entry with another address stops the fill (RF-38)', async () => {
    const env = fakeEnvironment();
    const c = catalog(KANBAN);
    await c.vault.save(c.person.id, { toolId: 'kanban', username: 'ana', secret: 's3cret' });
    // A snapshot apply writes the entry whole, so the swapped address arrives through `saveEntry`.
    c.repo.saveEntry({
      ...KANBAN,
      url: 'https://swapped.example/app',
      views: [{ label: 'Sprint', url: 'https://swapped.example/boards/42', mode: 'window' }],
    });
    const toolWindows = makeCatalogToolWindows(env, c);

    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: 'https://swapped.example/app' }));
    await settle();

    expect(env.calls.credential).toBe(0);
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"fill":false');
    expect(handle(env, 'tool_kanban').evals[0]).not.toContain('s3cret');
    toolWindows.onReport('tool_kanban', 'form', 'https://swapped.example');
    await settle();
    expect(tool(toolWindows, 'kanban').login).toBe('manual');
  });

  test('an address change inside the saved origin still fills (RF-38)', async () => {
    const env = fakeEnvironment();
    const c = catalog(KANBAN);
    await c.vault.save(c.person.id, { toolId: 'kanban', username: 'ana', secret: 's3cret' });
    // Another path on the same origin: the credential belongs to the origin, not to the page.
    c.repo.saveEntry({ ...KANBAN, url: 'https://kanban.example/renewed' });
    const toolWindows = makeCatalogToolWindows(env, c);

    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: 'https://kanban.example/renewed' }));
    await settle();

    expect(env.calls.credential).toBe(1);
    expect(handle(env, 'tool_kanban').evals).toHaveLength(1);
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"origin":"https://kanban.example"');
    expect(handle(env, 'tool_kanban').evals[0]).toContain('"fill":true');
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
    expect(openTools(env)).toEqual([
      { toolId: 'kanban', url: ENTRY_AUDIT },
      { toolId: 'mail', url: 'https://mail.example/web' },
    ]);
    const before = handle(env, 'tool_kanban');
    const state = toolWindows.close('kanban');
    expect(before.close).toBe(1);
    expect(state.tools.find((status) => status.id === 'kanban')?.openWindows).toBe(0);
    expect(openTools(env)).toEqual([{ toolId: 'mail', url: 'https://mail.example/web' }]);
  });

  test('a window the person closed leaves the persisted list', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('mail');
    toolWindows.onWindowClosed('tool_mail');
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT }]);
    expect(tool(toolWindows, 'mail').openWindows).toBe(0);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_mail']);
  });

  test('a window the module closed itself does not touch the list again', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.closeAll();
    toolWindows.onWindowClosed('tool_kanban'); // the late event of a window we closed
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT }]);
  });

  test('closeAll closes the windows and keeps the list; restore reopens only visible tools', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('mail');
    toolWindows.closeAll();
    expect(env.handles.size).toBe(0);
    expect(openTools(env)).toEqual([
      { toolId: 'kanban', url: ENTRY_AUDIT },
      { toolId: 'mail', url: 'https://mail.example/web' },
    ]);
    env.state.entries = [KANBAN];
    await toolWindows.restore();
    expect(env.handles.has('tool_kanban')).toBe(true);
    expect(env.handles.has('tool_mail')).toBe(false);
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT }]);
    expect(tool(toolWindows, 'kanban').loading).toBe(true);
  });

  test('restore reopens a view window at the view address', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.openView('kanban', 0);
    expect(openTools(env)).toEqual([{ toolId: 'kanban', view: 0, url: 'https://kanban.example/boards/42' }]);
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
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT }]);
  });

  test('reconcile while nothing is visible keeps the persisted list for the next unlock', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.closeAll();
    env.state.entries = []; // locked: no entry is visible
    toolWindows.reconcile();
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT }]);
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
  test('the shortcuts are registered once while a Nod window is focused and released after', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onWindowState(winState('tool_kanban'));
    const ids = ['digit-1', 'digit-2', 'digit-3', 'digit-4', 'digit-5', 'digit-6', 'digit-7', 'digit-8', 'digit-9', 'palette'];
    expect(env.registered.map((entry) => entry.id)).toEqual(ids);
    expect(env.registered[0].combo).toBe('cmd+1');
    expect(env.registered[9].combo).toBe('cmd+k');
    toolWindows.onWindowState(winState('tool_kanban')); // focusing again registers nothing
    expect(env.registered.map((entry) => entry.id)).toEqual(ids);
    toolWindows.onWindowState(winState('main'));
    toolWindows.onWindowState(winState('tool_kanban', { focused: false }));
    expect(env.unregistered).toEqual([]); // the main window is still focused
    toolWindows.onWindowState(winState('main', { focused: false }));
    expect(env.unregistered).toEqual(ids);
    expect(env.registered.map((entry) => entry.id)).toEqual(ids); // no double registration
  });

  test('a window that is not ours does not hold the shortcuts', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    toolWindows.onWindowState(winState('tool_kanban')); // not open
    toolWindows.onWindowState(winState('some_other_app'));
    expect(env.registered).toEqual([]);
  });

  test('without the capability no shortcut is ever registered', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env, { ...env.deps, hotkeys: false });
    toolWindows.onWindowState(winState('main'));
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
    expect(handle(env, 'main').shows.length).toBe(1);
    expect(env.pushed).toContainEqual({ event: 'palette', data: null });
  });
});

// ---------------------------------------------------------------- the not-from-org warning (B7)

describe('the warning of a tool that did not come from the org (canonico §22)', () => {
  const PERSONAL: Entry = { ...KANBAN, id: 'notes', scope: 'personal', ownerId: 'p1', views: [] };

  test('an org tool carries neither the title nor the banner', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    toolWindows.onNavigate(nav({ kind: 'finish', url: ENTRY_URL }));
    await settle();
    expect(env.opened[0].options?.title).toBe('Kanban');
    // The cascade may still evaluate the adapter (the fixture has a credential); the warning never.
    expect(handle(env, 'tool_kanban').evals.filter((js) => js.includes('nod-not-from-org'))).toEqual([]);
  });

  test('a personal tool is titled and gets the banner once it lands on its own origin', async () => {
    const env = fakeEnvironment();
    env.state.entries = [PERSONAL];
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('notes');
    expect(env.opened[0].options?.title).toBe('Not from your org — Kanban');

    // A hop through another origin is not the tool's page: no banner there.
    toolWindows.onNavigate(nav({ window: 'tool_notes', kind: 'finish', url: 'https://idp.example/login' }));
    await settle();
    expect(handle(env, 'tool_notes').evals.filter((js) => js.includes('nod-not-from-org'))).toEqual([]);

    toolWindows.onNavigate(nav({ window: 'tool_notes', kind: 'finish', url: ENTRY_URL }));
    await settle();
    const banners = handle(env, 'tool_notes').evals.filter((js) => js.includes('nod-not-from-org'));
    expect(banners).toHaveLength(1);
    expect(banners[0]).toContain('Not from your org');
    expect(banners[0]).toContain('window.top !== window');
  });

  test('warningScript is idempotent by its own id and reads nothing from the page', () => {
    const script = warningScript();
    expect(script).toContain("getElementById(\"nod-not-from-org\")");
    expect(script).toContain('textContent');
    expect(script).not.toContain('innerHTML');
  });
});

// ---------------------------------------------------------------- tabs and docked mode (E03)

describe('tabs — docked mode (RF-49…RF-52, RF-66…RF-68)', () => {
  test('a new tab opens frameless exactly on the slot, and the panel shows it', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    expect(env.opened).toEqual([
      {
        id: 'tool_kanban',
        options: {
          page: ENTRY_URL,
          title: 'Kanban',
          x: SLOT_SCREEN.x,
          y: SLOT_SCREEN.y,
          size: '500x340',
          chrome: { frame: false },
        },
      },
    ]);
    // S0: the geometry lands on the handle too, in the same tick as the open.
    expect(handle(env, 'tool_kanban').position).toEqual([140, 172]);
    expect(handle(env, 'tool_kanban').size).toEqual([500, 340]);
    expect(toolWindows.state().tabs).toEqual([
      {
        id: 'tool_kanban',
        toolId: 'kanban',
        title: 'Kanban',
        url: ENTRY_AUDIT,
        docked: true,
        adhoc: false,
        loading: true,
        error: null,
      },
    ]);
    expect(toolWindows.state()).toMatchObject({
      mode: 'docked',
      tabHotkeys: true,
      active: 'tool_kanban',
    });
    // The backend opened it on its own, so the page is told which tab to show.
    expect(env.pushed).toContainEqual({ event: 'tab', data: 'tool_kanban' });
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT, active: true }]);
  });

  test('a second tab of the tool is tool_kanban_t2, and the first is hidden alive (RF-50)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    await toolWindows.newTab('kanban');
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_kanban_t2']);
    expect(env.opened[1].options).toMatchObject({
      page: ENTRY_URL,
      x: SLOT_SCREEN.x,
      y: SLOT_SCREEN.y,
      chrome: { frame: false },
    });
    expect(handle(env, 'tool_kanban').hides).toBe(1);
    expect(handle(env, 'tool_kanban').close).toBe(0);
    expect(handle(env, 'tool_kanban').evals).toEqual([]);
    expect(toolWindows.state().tabs.map((tab) => tab.id)).toEqual(['tool_kanban', 'tool_kanban_t2']);
    expect(toolWindows.state().active).toBe('tool_kanban_t2');
    expect(tool(toolWindows, 'kanban').openWindows).toBe(2);
  });

  test('activating the other tab raises it without closing or reloading anything (RF-50)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    await toolWindows.newTab('kanban');
    const before = env.opened.length;

    toolWindows.activate('tool_kanban');
    expect(toolWindows.state().active).toBe('tool_kanban');
    expect(handle(env, 'tool_kanban').shows).toEqual([false]); // raised, never activated (S3)
    expect(handle(env, 'tool_kanban').hides).toBe(1);
    expect(handle(env, 'tool_kanban_t2').hides).toBe(1);
    expect(handle(env, 'tool_kanban').close).toBe(0);
    expect(handle(env, 'tool_kanban').evals).toEqual([]);
    expect(env.opened.length).toBe(before);
  });

  test('detach and dock re-chrome the same window and never close or open one (RF-51)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    toolWindows.detach('tool_kanban');
    expect(handle(env, 'tool_kanban').chrome).toEqual({ frame: true });
    expect(handle(env, 'tool_kanban').position).toEqual([168, 200]); // a step off the panel
    expect(handle(env, 'tool_kanban').shows).toEqual([true]); // the person asked for this one
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban']);
    expect(toolWindows.state().tabs[0].docked).toBe(false);
    expect(toolWindows.state().active).toBeNull();
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT, detached: true }]);

    toolWindows.dock('tool_kanban');
    expect(handle(env, 'tool_kanban').chrome).toEqual({ frame: false });
    expect(handle(env, 'tool_kanban').position).toEqual([140, 172]);
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban']);
    expect(toolWindows.state().tabs[0].docked).toBe(true);
    expect(toolWindows.state().active).toBe('tool_kanban');
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT, active: true }]);
  });

  test('closing the active tab puts its neighbour on the slot (⌘W)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    await toolWindows.newTab('kanban');

    const closed = handle(env, 'tool_kanban_t2'); // the fake drops a handle when it is closed
    const state = toolWindows.closeTab('tool_kanban_t2');
    expect(state.active).toBe('tool_kanban');
    expect(closed.close).toBe(1);
    expect(handle(env, 'tool_kanban').shows).toEqual([false]); // back on the panel, without focus
    expect(state.tabs.map((tab) => tab.id)).toEqual(['tool_kanban']);
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT, active: true }]);
  });

  test('dock works on any detached tab id, not only the selected one (RF-51)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    await toolWindows.newTab('kanban'); // the active tab is now tool_kanban_t2
    toolWindows.detach('tool_kanban_t2'); // …and the panel falls back to tool_kanban
    expect(toolWindows.state().active).toBe('tool_kanban');
    expect(handle(env, 'tool_kanban_t2').chrome).toEqual({ frame: true });

    const state = toolWindows.dock('tool_kanban_t2');
    expect(state.active).toBe('tool_kanban_t2'); // docking makes it the selected tab
    expect(state.tabs.map((tab) => tab.id)).toEqual(['tool_kanban', 'tool_kanban_t2']);
    expect(handle(env, 'tool_kanban_t2').chrome).toEqual({ frame: false });
    expect(handle(env, 'tool_kanban_t2').position).toEqual([140, 172]);
    expect(handle(env, 'tool_kanban').hides).toBe(2); // hidden when it opened, hidden again now
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_kanban_t2']);
  });

  test('a link a tab opens is adopted right after it as an ad-hoc tab (RF-66)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    // S4: the policy event carries the opener, the open event does not.
    expect(
      toolWindows.onPopup(
        popup({ window: 'popup1', opener: 'tool_kanban', url: 'https://docs.example/guide' }),
      ),
    ).toBe('window');
    const popupHandle = env.spawnWindow('popup1');
    toolWindows.onPopup({
      kind: 'open',
      window: 'popup1',
      action: 'window',
      url: 'https://docs.example/guide',
    });

    expect(toolWindows.state().tabs.map((tab) => tab.id)).toEqual(['tool_kanban', 'popup1']);
    expect(toolWindows.state().tabs[1]).toMatchObject({
      toolId: null,
      adhoc: true,
      docked: true,
      title: 'docs.example',
      url: 'https://docs.example/guide',
    });
    expect(toolWindows.state().active).toBe('popup1');
    expect(popupHandle.chrome).toEqual({ frame: false });
    expect(popupHandle.position).toEqual([140, 172]);
    expect(env.pushed).toContainEqual({ event: 'tab', data: 'popup1' });
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT }]); // never persisted
  });

  test('an identity popup stays a floating window in docked mode too, and the lock closes it', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    expect(
      toolWindows.onPopup(
        popup({ window: 'popup2', opener: 'tool_kanban', url: 'https://idp.example/saml/acs' }),
      ),
    ).toBe('window');
    const popupHandle = env.spawnWindow('popup2');
    toolWindows.onPopup({
      kind: 'open',
      window: 'popup2',
      action: 'window',
      url: 'https://idp.example/saml/acs',
    });

    expect(toolWindows.state().tabs.map((tab) => tab.id)).toEqual(['tool_kanban']);
    expect(popupHandle.chrome).toBeNull(); // never re-chromed: it closes itself (S4)
    toolWindows.closeAll();
    expect(popupHandle.close).toBe(1);
  });

  test('an ad-hoc tab gets no report, no cascade and never an eval (RF-68)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    await toolWindows.openLink('https://docs.example/guide');
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'link_1']);
    expect(toolWindows.state().tabs.map((tab) => tab.id)).toEqual(['tool_kanban', 'link_1']);
    expect(toolWindows.state().tabs[1]).toMatchObject({ toolId: null, adhoc: true, title: 'docs.example' });
    expect(toolWindows.state().active).toBe('link_1');

    toolWindows.onNavigate(nav({ window: 'link_1', kind: 'finish', url: 'https://docs.example/guide' }));
    toolWindows.onReport('link_1', 'filled', 'https://docs.example');
    await settle();
    expect(handle(env, 'link_1').evals).toEqual([]);
    expect(env.calls.credential).toBe(0);
    expect(env.records.filter((event) => event.type === 'login')).toEqual([]);

    // Its own navigation is still policed — and audited with no tool at all.
    expect(toolWindows.onNavigate(nav({ window: 'link_1', url: 'javascript:alert(1)' }))).toBe('deny');
    expect(env.records).toContainEqual({
      toolId: null,
      type: 'navigation_blocked',
      url: null,
      result: 'denied',
      detail: 'javascript:',
    });
  });

  test('a link the parser refuses opens nothing, and a bare host still opens (RF-66)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    // The same parser the page and the deep link go through: credentials in the address, another
    // scheme, or an address past 2048 characters never reach a window.
    await expect(toolWindows.openLink('https://u:p@x.example/')).rejects.toThrow('invalid link');
    await expect(toolWindows.openLink('ftp://x.example/')).rejects.toThrow('invalid link');
    await expect(toolWindows.openLink(`https://x.example/${'a'.repeat(2100)}`)).rejects.toThrow(
      'invalid link',
    );
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban']);
    expect(toolWindows.state().tabs.map((tab) => tab.id)).toEqual(['tool_kanban']);

    // A pasted bare host is read as https, which is what opens.
    await toolWindows.openLink('docs.example/guide');
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'link_1']);
    expect(env.opened[1].options.page).toBe('https://docs.example/guide');
    expect(toolWindows.state().tabs[1]).toMatchObject({ id: 'link_1', adhoc: true, title: 'docs.example' });
  });

  test('the page closing the panel hides the docked tab; it comes back with the next slot (RF-49)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    toolWindows.setSlot(null);
    expect(handle(env, 'tool_kanban').hides).toBe(1);
    toolWindows.setSlot(SLOT);
    await settle();
    expect(handle(env, 'tool_kanban').shows).toEqual([false]);
  });

  test('main minimized takes the docked tab away; main focused raises it without activating it (S3)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    toolWindows.onWindowState(winState('main', { minimized: true }));
    expect(handle(env, 'tool_kanban').hides).toBe(1);
    toolWindows.onWindowState(winState('main'));
    expect(handle(env, 'tool_kanban').shows).toEqual([false]);
  });

  test('main hidden with the tray takes the docked tab with it (RF-15)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);

    env.state.visible = false;
    toolWindows.onWindowState(winState('main', { focused: false }));
    await settle();
    expect(handle(env, 'tool_kanban').hides).toBe(1);

    env.state.visible = true;
    toolWindows.onWindowState(winState('main'));
    expect(handle(env, 'tool_kanban').shows).toEqual([false]);
  });

  test('the docked tab follows main whenever it is shown, focus or not (S2)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows); // no focus event at all: main never took it
    env.state.main = { x: 300, y: 180, width: 900, height: 600 };
    vi.advanceTimersByTime(50);
    await settle();
    expect(handle(env, 'tool_kanban').position).toEqual([340, 272]); // a WM moved main without focus

    // Minimizing main is what ends the following: nothing docked may show on the slot then.
    env.state.minimized = true;
    toolWindows.onWindowState(winState('main', { focused: false, minimized: true }));
    env.state.main = { x: 500, y: 180, width: 900, height: 600 };
    vi.advanceTimersByTime(200);
    await settle();
    expect(handle(env, 'tool_kanban').position).toEqual([340, 272]);
  });

  test('restore reopens the tabs in order, docked/detached and active as saved (T6)', async () => {
    const env = dockedEnvironment();
    env.store.set('open_tools', [
      { toolId: 'kanban', active: true },
      { toolId: 'mail', detached: true },
    ]);
    const toolWindows = makeToolWindows(env);
    expect(toolWindows.setSlot(SLOT)).toBe(true);
    await settle();
    await toolWindows.restore();

    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_mail']);
    expect(env.opened[0].options).toMatchObject({ x: 140, y: 172, size: '500x340', chrome: { frame: false } });
    expect(env.opened[1].options).toMatchObject({ x: 168, y: 200, size: '500x340' });
    expect(env.opened[1].options.chrome).toBeUndefined();
    const tabs = toolWindows.state().tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(['tool_kanban', 'tool_mail']);
    expect(tabs.map((tab) => tab.docked)).toEqual([true, false]);
    expect(toolWindows.state().active).toBe('tool_kanban');
    // An old item without `url` restores the tool's own address, and the list is written back whole.
    expect(openTools(env)).toEqual([
      { toolId: 'kanban', url: ENTRY_AUDIT, active: true },
      { toolId: 'mail', url: 'https://mail.example/web', detached: true },
    ]);
  });

  test('windows mode is where the runtime cannot position windows (RF-49, RF-52)', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    expect(toolWindows.state()).toMatchObject({ mode: 'windows', tabHotkeys: false });
    expect(handle(env, 'tool_kanban').chrome).toBeNull();
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT }]);
  });

  test('the docked mode registers the tab shortcuts globally, and the strip state says so (E03)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    toolWindows.onWindowState(winState('main'));

    expect(env.registered.map((entry) => entry.id)).toEqual([
      'digit-1', 'digit-2', 'digit-3', 'digit-4', 'digit-5', 'digit-6', 'digit-7', 'digit-8', 'digit-9',
      'palette',
      'tab-new', 'tab-close', 'tab-detach', 'tab-next', 'tab-prev', 'open-link', 'tab-save',
    ]);
    const comboOf = (id: string) => env.registered.find((entry) => entry.id === id)?.combo;
    expect(comboOf('tab-new')).toBe('cmd+t');
    expect(comboOf('tab-close')).toBe('cmd+w');
    expect(comboOf('tab-detach')).toBe('cmd+shift+d');
    expect(comboOf('tab-next')).toBe('ctrl+tab');
    expect(comboOf('tab-prev')).toBe('ctrl+shift+tab');
    expect(comboOf('open-link')).toBe('cmd+l');
    expect(comboOf('tab-save')).toBe('cmd+d');
    expect(toolWindows.state().tabHotkeys).toBe(true);
  });

  test('⌘T acts on the active tab tool, ⌘W on the active tab, ⌘L asks the page for a link', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    // The tab hotkeys exist while a Nod window is focused; with main in front the target is the tab
    // on the slot (E03).
    toolWindows.onWindowState(winState('main'));

    toolWindows.onHotkey('tab-new');
    await settle();
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_kanban_t2']);
    expect(env.pushed).toContainEqual({ event: 'tab', data: 'tool_kanban_t2' });

    toolWindows.onHotkey('tab-close');
    await settle();
    expect(env.handles.has('tool_kanban_t2')).toBe(false);
    expect(env.pushed).toContainEqual({ event: 'tab', data: 'tool_kanban' });

    toolWindows.onHotkey('open-link');
    expect(env.pushed).toContainEqual({ event: 'openLink', data: null });
    expect(handle(env, 'main').shows.length).toBe(1);
  });

  test('⌘D asks the backend side to save the active tab, with the address the page has (RF-67)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    await toolWindows.openLink('https://docs.example/guide?q=1#top');
    toolWindows.onWindowState(winState('main')); // the ⌘D target is resolved from the focus (E03)

    toolWindows.onHotkey('tab-save');
    await settle();
    expect(env.calls.saveTab).toEqual(['link_1']);
    expect(handle(env, 'main').shows.length).toBe(1);
    expect(toolWindows.tabForSave('link_1')).toEqual({
      id: 'link_1',
      toolId: null,
      url: 'https://docs.example/guide?q=1#top',
    });
    expect(toolWindows.tabForSave('nope')).toBeNull();
  });

  test('a tab that became a personal tool is a tool tab of it from then on, same window (RF-67)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    await toolWindows.openLink('https://docs.example/guide');
    env.state.entries = [
      KANBAN,
      { ...KANBAN, id: 'p-docs', title: 'Docs', url: 'https://docs.example/guide', scope: 'personal', ownerId: 'p1', views: [] },
    ];

    const state = toolWindows.adoptSavedTab('link_1', 'p-docs');
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'link_1']); // no reopen
    expect(state.tabs[1]).toMatchObject({ id: 'link_1', toolId: 'p-docs', adhoc: false, title: 'Docs' });
    // It is a personal tool's window now, so it carries the warning of a link that is not the org's
    // (canonico §22) — and nothing else is ever evaluated in it.
    expect(handle(env, 'link_1').evals).toHaveLength(1);
    expect(handle(env, 'link_1').evals[0]).toContain('nod-not-from-org');
    expect(openTools(env)).toEqual([
      { toolId: 'kanban', url: ENTRY_AUDIT },
      { toolId: 'p-docs', url: 'https://docs.example/guide', active: true },
    ]);
  });

  test('windows mode: a hand-opened link is a framed window of its own (RF-66)', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    // The stored mode is read once at creation; `state()` is synchronous, so the answer of the
    // store has to land before the mode is the one this fixture pins.
    await settle();
    expect(toolWindows.state()).toMatchObject({ mode: 'windows', active: null, tabHotkeys: false });

    await toolWindows.openLink('https://docs.example/guide');
    expect(env.opened).toEqual([
      {
        id: 'link_1',
        options: { page: 'https://docs.example/guide', title: 'docs.example', x: 128, y: 108, size: '1280x800' },
      },
    ]);
    expect(toolWindows.state().tabs[0]).toMatchObject({
      id: 'link_1',
      toolId: null,
      adhoc: true,
      docked: false,
      title: 'docs.example',
    });
    expect(openTools(env)).toEqual([]); // an ad-hoc tab is never persisted
  });

  test('windows mode never re-chromes a tab and never opens a second window (RF-19, RF-52)', async () => {
    const env = fakeEnvironment();
    const toolWindows = makeToolWindows(env);
    await toolWindows.open('kanban');
    await toolWindows.open('kanban');
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban']);
    expect(handle(env, 'tool_kanban').shows.length).toBe(1);
    expect(handle(env, 'tool_kanban').chrome).toBeNull();
    expect(toolWindows.state().tabs).toEqual([
      {
        id: 'tool_kanban',
        toolId: 'kanban',
        title: 'Kanban',
        url: ENTRY_AUDIT,
        docked: false,
        adhoc: false,
        loading: true,
        error: null,
      },
    ]);
  });
});

// ---------------------------------------------------------------- the E03 review findings

describe('tabs — hotkey target, relay and the unlock guards (E03 review)', () => {
  test('⌘W closes the tab window the person is in, not the hidden one on the slot', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    await toolWindows.newTab('kanban'); // tool_kanban_t2, docked and active
    toolWindows.detach('tool_kanban_t2'); // it leaves the panel: the slot falls back to tool_kanban
    toolWindows.onWindowState(winState('tool_kanban_t2')); // …and the person is in that window
    expect(toolWindows.state().active).toBe('tool_kanban');

    toolWindows.onHotkey('tab-close');
    await settle();
    expect(env.handles.has('tool_kanban_t2')).toBe(false); // the focused window went away
    expect(env.handles.has('tool_kanban')).toBe(true); // the hidden one is untouched
    expect(toolWindows.state().tabs.map((tab) => tab.id)).toEqual(['tool_kanban']);
  });

  test('⌘⇧D follows the focus: it detaches the tab in hand and docks it back (RF-51)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    toolWindows.onWindowState(winState('tool_kanban')); // the docked tab window has the focus

    toolWindows.onHotkey('tab-detach');
    expect(toolWindows.state().tabs[0].docked).toBe(false);
    expect(handle(env, 'tool_kanban').chrome).toEqual({ frame: true });

    toolWindows.onHotkey('tab-detach'); // the other half of the palette's toggle
    expect(toolWindows.state().tabs[0].docked).toBe(true);
    expect(toolWindows.state().active).toBe('tool_kanban');
    expect(handle(env, 'tool_kanban').chrome).toEqual({ frame: false });
    expect(env.opened.length).toBe(1); // the same window, never reopened
  });

  test('a tab hotkey with no Nod window in front has no target at all', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    toolWindows.onWindowState(winState('tool_kanban')); // focus, then it goes away
    toolWindows.onWindowState(winState('tool_kanban', { focused: false }));

    toolWindows.onHotkey('tab-close');
    toolWindows.onHotkey('tab-detach');
    await settle();
    expect(env.handles.has('tool_kanban')).toBe(true);
    expect(toolWindows.state().tabs[0].docked).toBe(true);
    expect(env.calls.saveTab).toEqual([]);
  });

  test('⌃Tab steps from the last selected tab, so a detached one is not a trap', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows); // tool_kanban: docked and active
    await toolWindows.newTab('kanban'); // tool_kanban_t2
    await toolWindows.newTab('kanban'); // tool_kanban_t3: docked and active
    toolWindows.detach('tool_kanban_t2'); // it leaves the panel…
    toolWindows.activate('tool_kanban_t2'); // …and comes forward: now it is the last used tab
    expect(toolWindows.state().active).toBe('tool_kanban_t3'); // the slot still shows t3

    const showsBefore = handle(env, 'tool_kanban_t2').shows.length;
    const state = toolWindows.next(1);
    // The tab after t2 is t3; stepping from the slot would wrap around to tool_kanban instead.
    expect(state.active).toBe('tool_kanban_t3');
    expect(handle(env, 'tool_kanban_t2').shows.length).toBe(showsBefore); // never selected again
  });

  test('saving a tool tab keeps it the tab of its own tool (RF-67)', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    env.state.entries = [
      KANBAN,
      { ...KANBAN, id: 'p-docs', title: 'Docs', url: 'https://docs.example/guide', scope: 'personal', ownerId: 'p1', views: [] },
    ];

    const state = toolWindows.adoptSavedTab('tool_kanban', 'p-docs');
    expect(state.tabs[0]).toMatchObject({ id: 'tool_kanban', toolId: 'kanban', adhoc: false });
    expect(state.tools.find((status) => status.id === 'kanban')?.openWindows).toBe(1);
    expect(state.tools.find((status) => status.id === 'p-docs')?.openWindows).toBe(0);
    expect(openTools(env)).toEqual([{ toolId: 'kanban', url: ENTRY_AUDIT, active: true }]);
  });

  test('the lock clears the slot, so the restored tabs do not cover Home', async () => {
    const env = dockedEnvironment();
    const toolWindows = makeToolWindows(env);
    await dockedKanban(toolWindows);
    toolWindows.closeAll();

    await toolWindows.restore(); // the tabs come back, the panel does not know where it is
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban', 'tool_kanban']);
    expect(handle(env, 'tool_kanban').hides).toBe(1); // hidden: Home is not covered
    expect(handle(env, 'tool_kanban').shows).toEqual([]);

    toolWindows.setSlot(SLOT); // the page mounts the tab view and reports the panel
    await settle();
    expect(handle(env, 'tool_kanban').shows).toEqual([false]);
  });

  test('restore and a click racing for the same tool open its window once', async () => {
    const env = dockedEnvironment();
    env.store.set('open_tools', [{ toolId: 'kanban', active: true }]);
    const toolWindows = makeToolWindows(env);

    // `restore` awaits the store and the geometry; a ⌘1 (or a click on the sidebar) reaches the
    // same tool while it is in flight. The id is claimed before the first await.
    const restoring = toolWindows.restore();
    await toolWindows.open('kanban');
    await restoring;
    expect(env.opened.map((entry) => entry.id)).toEqual(['tool_kanban']);
    expect(toolWindows.state().tabs.map((tab) => tab.id)).toEqual(['tool_kanban']);
  });
});
