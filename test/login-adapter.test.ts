// adapterScript: the code the backend injects into a tool's page (docs/arquitetura.md §4).
// Slice acceptance: the values enter only as JSON literals, the script is syntactically and
// semantically valid, without `fill` the secret does not show up in the generated code, and
// running it against a minimal fake DOM proves the origin/top-frame guard, the wait for the
// password field, the form-action check (P7) and the reports.
//
// The script's `setTimeout` is driven by a controlled clock owned by the harness: no test waits on
// the wall clock, and "the wait elapsed" is a call, not a guessed duration.

import { describe, expect, test } from 'bun:test';
import { adapterScript } from '../backend/login-adapter';

const ORIGIN = 'https://kanban.example';
const USERNAME = 'a"b';
const SECRET = "x'</script>";
/** U+2028 inside a string literal: legal since ES2019, and it must survive the round trip. */
const LINE_SEPARATOR = 'a\u2028b';
const MARKER = 'var data = ';
/** Short wait for the tests; the real script waits 3 s for the field to show up. */
const WAIT_MS = 5;

/** Slices the `var data = …` JSON literal, counting braces and respecting strings and escapes. */
function dataLiteral(script: string): { text: string; start: number; end: number } {
  const marker = script.indexOf(MARKER);
  expect(marker).toBeGreaterThanOrEqual(0);
  const start = script.indexOf('{', marker + MARKER.length);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let inText = false;
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const c = script[i];
    if (inText) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inText = false;
      continue;
    }
    if (c === '"') inText = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { text: script.slice(start, i + 1), start, end: i + 1 };
    }
  }
  throw new Error('data literal not found in the script');
}

// ---------------------------------------------------------------- controlled clock

/** Timer queue the harness hands to the script as `setTimeout`/`clearTimeout`. */
class TestClock {
  /** delays the script asked for, in order — the "up to 3 s" of the contract, made visible */
  readonly delays: number[] = [];
  private readonly queue = new Map<number, () => void>();
  private next = 1;

  schedule(handler: () => void, delay?: number): number {
    const id = this.next;
    this.next += 1;
    this.delays.push(delay ?? 0);
    this.queue.set(id, handler);
    return id;
  }

  cancel(id: number): void {
    this.queue.delete(id);
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Runs every timer scheduled so far, in order. */
  run(): void {
    const handlers = [...this.queue.values()];
    this.queue.clear();
    for (const handler of handlers) handler();
  }
}

// ---------------------------------------------------------------- minimal DOM

interface FakeSubmitButton {
  click(): void;
}

interface FakeForm {
  querySelectorAll(selector: string): FakeInput[];
  querySelector(selector: string): FakeSubmitButton | null;
  getAttribute(name: string): string | null;
  requestSubmit?(): void;
  submit?(): void;
}

interface FakeInput {
  attributes: Record<string, string>;
  visible: boolean;
  form: FakeForm | null;
  events: string[];
  value: string;
  getAttribute(name: string): string | null;
  getClientRects(): unknown[];
  offsetParent: unknown;
  dispatchEvent(event: { type: string }): boolean;
}

/** Prototype carrying the `value` accessor: the descriptor the script uses to write a field. */
const INPUT_PROTOTYPE = {
  _value: '',
  get value(): string {
    return this._value;
  },
  set value(next: string) {
    this._value = next;
  },
};

function fakeInput(attributes: Record<string, string>, visible = true): FakeInput {
  const input = Object.create(INPUT_PROTOTYPE) as FakeInput;
  input.attributes = attributes;
  input.visible = visible;
  input.form = null;
  input.events = [];
  input.value = '';
  input.getAttribute = (name) => attributes[name] ?? null;
  input.getClientRects = () => (visible ? [{}] : []);
  input.offsetParent = visible ? {} : null;
  input.dispatchEvent = (event) => {
    input.events.push(event.type);
    return true;
  };
  return input;
}

interface FormOptions {
  /** the `action` attribute; absent means the document's own origin (P7) */
  action?: string;
  /** false leaves the form without `requestSubmit` (the script falls back) */
  requestSubmit?: boolean;
  /** true makes `querySelector('[type=submit]')` find a button */
  button?: boolean;
}

interface FakeFormHandle {
  form: FakeForm;
  /** how many times the form was sent, by any of the three paths */
  submissions: { count: number };
  /** how many times the submit button was clicked */
  clicks: { count: number };
}

function fakeForm(inputs: FakeInput[], options: FormOptions = {}): FakeFormHandle {
  const submissions = { count: 0 };
  const clicks = { count: 0 };
  const button: FakeSubmitButton = {
    click: () => {
      clicks.count += 1;
      submissions.count += 1;
    },
  };
  const form: FakeForm = {
    querySelectorAll: () => inputs,
    querySelector: () => (options.button === true ? button : null),
    getAttribute: (name) => (name === 'action' ? options.action ?? null : null),
  };
  if (options.requestSubmit !== false) {
    form.requestSubmit = () => {
      submissions.count += 1;
    };
  }
  form.submit = () => {
    submissions.count += 1;
  };
  for (const input of inputs) input.form = form;
  return { form, submissions, clicks };
}

// ---------------------------------------------------------------- harness

interface HarnessOptions {
  /** origin the fake page reports; a different one must make the script leave silently */
  origin?: string;
  /** false installs a page without `window.tiny` */
  tiny?: boolean;
  /** false makes `window.top` another object */
  topFrame?: boolean;
  /** the page's DOM: a document whose `querySelectorAll` throws */
  brokenDocument?: boolean;
  /** run the timers the script scheduled before it returns (the wait elapsed) */
  elapseWait?: boolean;
}

interface Harness {
  reports: { method: string; params: { state?: string } }[];
  clock: TestClock;
}

/**
 * Installs the fake globals, runs the generated script and puts the original globals back.
 * Everything the script needs lives here: document, window, location, the input prototype, Event
 * and the clock.
 */
function runScript(script: string, inputs: FakeInput[], options: HarnessOptions = {}): Harness {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous: Record<string, unknown> = {
    document: globals.document,
    window: globals.window,
    location: globals.location,
    HTMLInputElement: globals.HTMLInputElement,
    Event: globals.Event,
    setTimeout: globals.setTimeout,
    clearTimeout: globals.clearTimeout,
  };
  const clock = new TestClock();
  const reports: Harness['reports'] = [];
  const origin = options.origin ?? ORIGIN;
  const fakeWindow: Record<string, unknown> = {};
  if (options.tiny !== false) {
    fakeWindow.tiny = {
      api: {
        call: (method: string, params: { state?: string }) => {
          reports.push({ method, params });
        },
      },
    };
  }
  fakeWindow.top = options.topFrame === false ? {} : fakeWindow;
  globals.document =
    options.brokenDocument === true
      ? {
          querySelectorAll: () => {
            throw new Error('broken DOM');
          },
          documentElement: {},
        }
      : { querySelectorAll: () => inputs, documentElement: {} };
  globals.window = fakeWindow;
  globals.location = { origin, href: `${origin}/login` };
  globals.HTMLInputElement = { prototype: INPUT_PROTOTYPE };
  globals.setTimeout = (handler: () => void, delay?: number) => clock.schedule(handler, delay);
  globals.clearTimeout = (id?: number) => {
    if (typeof id === 'number') clock.cancel(id);
  };
  class FakeEvent {
    readonly type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  globals.Event = FakeEvent;
  try {
    new Function(script)();
    if (options.elapseWait === true) clock.run();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globals[key];
      else globals[key] = previous[key];
    }
  }
  return { reports, clock };
}

// ---------------------------------------------------------------- injected values

describe('adapterScript — injected values', () => {
  test('the values enter as a JSON literal that comes back identical', () => {
    const script = adapterScript({
      fill: true,
      origin: ORIGIN,
      username: USERNAME,
      secret: SECRET,
    });
    const { text } = dataLiteral(script);
    expect(text).toBe(
      JSON.stringify({ fill: true, origin: ORIGIN, username: USERNAME, secret: SECRET }),
    );
    const read = JSON.parse(text) as { username: string; secret: string };
    expect(read.username).toBe(USERNAME);
    expect(read.secret).toBe(SECRET);
  });

  test('a line separator (U+2028) survives the literal and the script still compiles', () => {
    const script = adapterScript({
      fill: true,
      origin: ORIGIN,
      username: LINE_SEPARATOR,
      secret: LINE_SEPARATOR,
    });
    const { text } = dataLiteral(script);
    const read = JSON.parse(text) as { username: string; secret: string };
    expect(read.username).toBe(LINE_SEPARATOR);
    expect(read.secret).toBe(LINE_SEPARATOR);
    expect(() => new Function(script)).not.toThrow();
  });

  test('the values show up only inside the literal: no raw concatenation', () => {
    const script = adapterScript({
      fill: true,
      origin: ORIGIN,
      username: USERNAME,
      secret: SECRET,
    });
    const { start, end } = dataLiteral(script);
    const outside = script.slice(0, start) + script.slice(end);
    for (const value of [USERNAME, SECRET]) {
      expect(script.includes(JSON.stringify(value))).toBe(true);
      expect(outside.includes(JSON.stringify(value))).toBe(false);
      expect(outside.includes(value)).toBe(false);
    }
    expect(script.includes("' + ")).toBe(false);
    expect(script.includes('" + ')).toBe(false);
  });

  test('without fill the secret does not enter the script', () => {
    const script = adapterScript({
      fill: false,
      origin: ORIGIN,
      username: USERNAME,
      secret: SECRET,
    });
    expect(script.includes(SECRET)).toBe(false);
    expect(script.includes(JSON.stringify(SECRET))).toBe(false);
    expect(script.includes(USERNAME)).toBe(false);
    expect(dataLiteral(script).text).toBe(JSON.stringify({ fill: false, origin: ORIGIN }));
  });

  test('fill without both values carries no credential', () => {
    const script = adapterScript({ fill: true, origin: ORIGIN, username: USERNAME });
    expect(dataLiteral(script).text).toBe(JSON.stringify({ fill: false, origin: ORIGIN }));
    expect(script.includes(USERNAME)).toBe(false);
  });

  test('the script is syntactically valid in every combination', () => {
    const combinations = [
      { fill: true, origin: ORIGIN, username: USERNAME, secret: SECRET },
      { fill: true, origin: ORIGIN },
      { fill: false, origin: ORIGIN },
      { fill: false, origin: ORIGIN, username: '', secret: '' },
    ];
    for (const options of combinations) {
      const script = adapterScript(options);
      expect(() => new Function(script)).not.toThrow();
      expect(script.startsWith('(function () {')).toBe(true);
      expect(script.trimEnd().endsWith('})();')).toBe(true);
    }
  });

  test('the wait lands in the script, 3 s by default', () => {
    expect(adapterScript({ fill: false, origin: ORIGIN, waitMs: 25 })).toContain('var waitMs = 25;');
    expect(adapterScript({ fill: false, origin: ORIGIN })).toContain('var waitMs = 3000;');
  });

  test('reports through login.report and uses the required mechanisms', () => {
    const script = adapterScript({
      fill: true,
      origin: ORIGIN,
      username: 'ana',
      secret: 'secret-value',
    });
    expect(script).toContain("'login.report'");
    expect(script).toContain("'no-form'");
    expect(script).toContain("'form'");
    expect(script).toContain("'filled'");
    expect(script).toContain("'error'");
    expect(script).toContain('requestSubmit');
    expect(script).toContain('[type=submit]');
    expect(script).toContain("getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')");
    expect(script).toContain("new Event('input', { bubbles: true })");
    expect(script).toContain("new Event('change', { bubbles: true })");
    expect(script).toContain('offsetParent !== null');
    expect(script).toContain('getClientRects');
    expect(script).toContain('MutationObserver');
    expect(script).toContain('location.origin');
    expect(script).toContain('window.top');
  });
});

// ---------------------------------------------------------------- guards

describe('adapterScript — origin and frame guards', () => {
  test('another origin: nothing is reported and nothing is written', () => {
    const password = fakeInput({ type: 'password' });
    fakeForm([password]);
    const { reports, clock } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [password],
      { origin: 'https://elsewhere.example', elapseWait: true },
    );
    expect(reports).toEqual([]);
    expect(password.value).toBe('');
    expect(clock.delays).toEqual([]); // it left before even waiting
  });

  test('not the top frame: nothing is reported', () => {
    const password = fakeInput({ type: 'password' });
    fakeForm([password]);
    const { reports, clock } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [password],
      { topFrame: false, elapseWait: true },
    );
    expect(reports).toEqual([]);
    expect(clock.delays).toEqual([]);
  });

  test('a broken DOM: reports error and never throws out', () => {
    const { reports } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [],
      { brokenDocument: true },
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'error' } }]);
  });

  test('without window.tiny the script reports nothing and does not throw', () => {
    const password = fakeInput({ type: 'password' });
    fakeForm([password]);
    const { reports } = runScript(
      adapterScript({ fill: false, origin: ORIGIN, waitMs: WAIT_MS }),
      [password],
      { tiny: false },
    );
    expect(reports).toEqual([]);
    expect(password.value).toBe('');
  });
});

// ---------------------------------------------------------------- the wait

describe('adapterScript — waiting for the password field', () => {
  test('no password field: it waits, then reports no-form', () => {
    const search = fakeInput({ type: 'text', name: 'search' });
    const { reports, clock } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [search],
      { elapseWait: true },
    );
    expect(clock.delays).toEqual([WAIT_MS]);
    expect(clock.pending).toBe(0);
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'no-form' } }]);
    expect(search.value).toBe('');
  });

  test('nothing is reported before the wait elapses', () => {
    const search = fakeInput({ type: 'text', name: 'search' });
    const { reports } = runScript(
      adapterScript({ fill: false, origin: ORIGIN, waitMs: WAIT_MS }),
      [search],
    );
    expect(reports).toEqual([]);
  });

  test('a hidden password field does not count as a form', () => {
    const { reports } = runScript(
      adapterScript({ fill: false, origin: ORIGIN, waitMs: WAIT_MS }),
      [fakeInput({ type: 'password' }, false)],
      { elapseWait: true },
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'no-form' } }]);
  });
});

// ---------------------------------------------------------------- behaviour of the script

describe('adapterScript — behaviour of the generated script', () => {
  test('a visible password field with fill false: reports form and writes nothing', () => {
    const username = fakeInput({ type: 'text', name: 'username' });
    const password = fakeInput({ type: 'password' });
    const { submissions } = fakeForm([username, password]);
    const { reports, clock } = runScript(
      adapterScript({ fill: false, origin: ORIGIN, waitMs: WAIT_MS }),
      [username, password],
      { elapseWait: true },
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'form' } }]);
    expect(submissions.count).toBe(0);
    expect(username.value).toBe('');
    expect(password.value).toBe('');
    expect(clock.delays).toEqual([]); // the field was there: no wait
  });

  test('fill: writes both fields, fires input/change, submits once and reports filled', () => {
    const username = fakeInput({ type: 'text', name: 'username' });
    const password = fakeInput({ type: 'password' });
    const { submissions } = fakeForm([username, password]);
    const { reports } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [username, password],
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'filled' } }]);
    expect(username.value).toBe('ana');
    expect(password.value).toBe('s3cret');
    expect(username.events).toEqual(['input', 'change']);
    expect(password.events).toEqual(['input', 'change']);
    expect(submissions.count).toBe(1);
  });

  test('without a hint the username is the first text field before the password', () => {
    const username = fakeInput({ type: 'text' });
    const password = fakeInput({ type: 'password' });
    const after = fakeInput({ type: 'text', name: 'after' });
    fakeForm([username, password, after]);
    const { reports } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [username, password, after],
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'filled' } }]);
    expect(username.value).toBe('ana');
    expect(password.value).toBe('s3cret');
    expect(after.value).toBe('');
  });

  test('a cross-origin form action: nothing is written or sent, reports form', () => {
    const username = fakeInput({ type: 'text', name: 'username' });
    const password = fakeInput({ type: 'password' });
    const { submissions } = fakeForm([username, password], {
      action: 'https://elsewhere.example/steal',
    });
    const { reports } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [username, password],
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'form' } }]);
    expect(submissions.count).toBe(0);
    expect(username.value).toBe('');
    expect(password.value).toBe('');
  });

  test('a same-origin absolute action is still sent', () => {
    const password = fakeInput({ type: 'password' });
    const { submissions } = fakeForm([password], { action: `${ORIGIN}/session` });
    const { reports } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [password],
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'filled' } }]);
    expect(submissions.count).toBe(1);
  });

  test('without requestSubmit it clicks the submit button', () => {
    const password = fakeInput({ type: 'password' });
    const { submissions, clicks } = fakeForm([password], { requestSubmit: false, button: true });
    const { reports } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [password],
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'filled' } }]);
    expect(clicks.count).toBe(1);
    expect(submissions.count).toBe(1);
  });

  test('without requestSubmit or a button it falls back to form.submit', () => {
    const password = fakeInput({ type: 'password' });
    const { submissions } = fakeForm([password], { requestSubmit: false });
    const { reports } = runScript(
      adapterScript({
        fill: true,
        origin: ORIGIN,
        username: 'ana',
        secret: 's3cret',
        waitMs: WAIT_MS,
      }),
      [password],
    );
    expect(reports).toEqual([{ method: 'login.report', params: { state: 'filled' } }]);
    expect(submissions.count).toBe(1);
  });
});
