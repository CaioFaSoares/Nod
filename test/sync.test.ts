// `backend/sync.ts` driven end to end against a real in-memory repository, a scripted
// `HostConnection` and an injected clock and interval pair: the four triggers of SP04 §3, the `304`,
// the stale state with its backoff, the sign-out of RF-39, the key change of SP04 §1, the outbox
// flush of SP04 §4 and the event push of SP04 §5 (batches of ≤ 500, the ack, `sync.rejected`).
import { describe, expect, test } from 'bun:test';
import { HOST_KEY_CHANGED, HostError, hostTokenKey } from '../backend/host-client';
import type { HostConnection, PinnedHost, SnapshotResult } from '../backend/host-client';
import { createRepo } from '../backend/repo';
import type { OutboxMethod, Repo } from '../backend/repo';
import { AFTER_WRITE_MS, BACKOFF_MS, createSync, SIGNED_OUT_ERROR, SYNC_INTERVAL_MS } from '../backend/sync';
import type { Sync, SyncDeps } from '../backend/sync';
import { HOST_ROUTES } from '../shared/host-api';
import type { ClientEvent, EventsRequest, EventsResponse, Snapshot } from '../shared/host-api';
import type { AuditEvent, Entry, HostState } from '../shared/types';
import { memorySqlite } from './helpers/sqlite-bun';

const START = Date.parse('2026-10-15T12:00:00.000Z');
const EARLIER = new Date(START - 60_000).toISOString();
const PUBLIC_KEY = 'A'.repeat(43);
const HOST: PinnedHost = {
  address: 'https://guild.example.test',
  kid: 'kid-1',
  publicKey: PUBLIC_KEY,
  personId: 'p1',
};
const TOKEN_KEY = hostTokenKey(HOST.kid, HOST.personId);

function entry(id: string, fields: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `Tool ${id}`,
    url: `https://${id}.example.test/app`,
    icon: null,
    order: 1,
    roles: [],
    views: [],
    auth: null,
    active: true,
    ...fields,
  };
}

const BODY: Snapshot = {
  api: 1,
  version: 'v1',
  issuedAt: '2026-10-15T10:00:00.000Z',
  me: { id: 'p1', email: 'p@example.test', name: 'P', roles: ['team'], admin: false, kind: 'member' },
  roles: [{ id: 'team', name: 'Team', admin: false }],
  orgTools: [entry('jitsi', { roles: ['team'], scope: 'org', ownerId: null })],
  personalTools: [entry('mine', { scope: 'personal', ownerId: 'p1' })],
  personalViews: [],
  favorites: ['jitsi'],
};
const BODY_RAW = JSON.stringify(BODY);

const offline = (): never => {
  throw new HostError('offline', 'could not reach the host');
};
const signedOut = (): never => {
  throw new HostError('signed-out', 'signed out', 401);
};
const fullBody = (): SnapshotResult => ({ notModified: false, snapshot: BODY, raw: BODY_RAW });

interface Script {
  /** What `GET /v1/state` does; a body when the host has one, a raise when it does not. */
  snapshot: () => SnapshotResult;
  /** What one replayed write does; `undefined` is the host taking it. */
  request?: (method: string, path: string, body: unknown) => unknown;
}

interface Harness {
  repo: Repo;
  sync: Sync;
  connection: HostConnection;
  script: Script;
  calls: { snapshot: number; options: ({ version?: string | null; notOlderThan?: string | null } | undefined)[]; request: { method: string; path: string; body: unknown }[] };
  /** One line per call the run made, in order: the outbox, the events, then the state (SP04 §3). */
  order: string[];
  keychain: Map<string, string>;
  states: HostState[];
  signedOutCount: () => number;
  advance: (ms: number) => void;
  /** The delay of the one armed timer, or null when nothing is armed. */
  delay: () => number | null;
  armed: () => number;
  /**
   * Waits for the run already in flight — `start()`'s or a timer's — and answers the state it
   * published. F5 gave `syncNow()` another meaning while a run is going (it asks for a run of its
   * own, chained behind it), so "wait for the run that is going" needs its own way in: every run
   * that reaches the host publishes exactly once, and that is the line this waits on.
   */
  settle: () => Promise<HostState>;
  /** Fires the armed timer the way the runtime would, and waits for the run it started. */
  fire: () => Promise<void>;
}

function harness(script: Partial<Script> = {}): Harness {
  const repo = createRepo(memorySqlite());
  repo.migrate();
  repo.saveHost({
    address: HOST.address,
    guild: 'Guild',
    kid: HOST.kid,
    publicKey: HOST.publicKey,
    personId: HOST.personId,
    salt: 'c2FsdA',
    addedAt: '2026-10-01T00:00:00.000Z',
  });

  const keychain = new Map<string, string>([[TOKEN_KEY, 'a-token-value']]);
  const calls: Harness['calls'] = { snapshot: 0, options: [], request: [] };
  const order: string[] = [];
  const live: Script = { snapshot: fullBody, ...script };

  const connection: HostConnection = {
    host: HOST,
    tokenKey: () => TOKEN_KEY,
    saveToken: async (token) => {
      keychain.set(TOKEN_KEY, token);
    },
    forgetToken: async () => {
      keychain.delete(TOKEN_KEY);
    },
    request: async (method, path, body) => {
      calls.request.push({ method, path, body });
      order.push(`${method} ${path}`);
      return live.request === undefined ? undefined : live.request(method, path, body);
    },
    snapshot: async (options) => {
      calls.snapshot += 1;
      calls.options.push(options);
      order.push(`GET ${HOST_ROUTES.state}`);
      return live.snapshot();
    },
  };

  let clock = START;
  const timers = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 1;
  const states: HostState[] = [];
  /** Resolves when a run publishes its state, oldest waiter first: the signal `settle` waits on. */
  const published: (() => void)[] = [];
  let signedOuts = 0;

  const deps: SyncDeps = {
    repo,
    connection: () => connection,
    now: () => clock,
    onState: (state) => {
      states.push(state);
      published.shift()?.();
    },
    onSignedOut: () => {
      signedOuts += 1;
    },
    setInterval: (run, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { run, ms });
      return id;
    },
    clearInterval: (handle) => {
      timers.delete(handle as number);
    },
  };

  const sync = createSync(deps);

  const settle = async (): Promise<HostState> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    published.push(resolve);
    await promise;
    // The run published what it saw; its tail — the `finally` that clears the run in flight and the
    // loop's re-arm — is a couple of microtasks of its own, and a few turns of the queue land them
    // (turns, not a duration: the queue is deterministic and no clock is involved).
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    return states.at(-1) ?? sync.state();
  };

  return {
    repo,
    sync,
    connection,
    script: live,
    calls,
    order,
    keychain,
    states,
    signedOutCount: () => signedOuts,
    advance: (ms) => {
      clock += ms;
    },
    delay: () => [...timers.values()][0]?.ms ?? null,
    armed: () => timers.size,
    settle,
    fire: async () => {
      const [id, timer] = [...timers.entries()][0] ?? [];
      if (id === undefined || timer === undefined) throw new Error('no timer armed');
      timers.delete(id);
      timer.run();
      await settle();
    },
  };
}

/** The row as a run of the default script leaves it: one verified body and a success time. */
function cachedSnapshot(h: Harness): string {
  const raw = h.calls.snapshot === 0 ? BODY_RAW : (h.repo.hostRecord()?.snapshot ?? '');
  h.repo.saveHostSnapshot({ snapshot: raw, version: 'v1', issuedAt: BODY.issuedAt, syncedAt: EARLIER });
  return raw;
}

function enqueue(h: Harness, method: OutboxMethod, path: string, body: unknown, at: string): void {
  h.repo.enqueueOutbox({ method, path, body: JSON.stringify(body), createdAt: at });
}

/** One local event as the app records it: the repo stamps the client id (SP04 §5). */
function recordEvent(h: Harness, at: string): AuditEvent {
  return h.repo.addEvent({
    personId: HOST.personId,
    toolId: 'alpha',
    type: 'tool_opened',
    url: 'https://alpha.example.test/app',
    result: null,
    detail: null,
    at,
  });
}

/** SP03 §2's host: the ids of the batch come back acked, in batch order. */
function ackBatch(_method: string, path: string, body: unknown): unknown {
  if (path !== HOST_ROUTES.events) return undefined;
  return { acked: (body as EventsRequest).events.map((event) => event.id) } satisfies EventsResponse;
}

/** What one `POST /v1/events` carried: the batches of a run, in order. */
function batchesOf(h: Harness): ClientEvent[][] {
  return h.calls.request
    .filter((call) => call.path === HOST_ROUTES.events)
    .map((call) => (call.body as EventsRequest).events);
}

describe('triggers', () => {
  test('start() syncs once and arms the five-minute timer', async () => {
    const h = harness();
    h.sync.start();
    const state = await h.settle();
    expect(h.calls.snapshot).toBe(1);
    expect(h.delay()).toBe(SYNC_INTERVAL_MS);
    expect(state.status).toBe('connected');
    expect(state.guild).toBe('Guild');
    expect(state.address).toBe(HOST.address);
    expect(state.lastSyncAt).toBe(new Date(START).toISOString());
    expect(state.lastError).toBeNull();
    expect(state.pendingWrites).toBe(0);
    // SP04 §1.1's fingerprint, computed from the pinned key.
    expect(state.fingerprint).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // The body lands verbatim, with its own version and issuedAt.
    expect(h.repo.hostRecord()?.snapshot).toBe(BODY_RAW);
    expect(h.repo.hostRecord()?.version).toBe('v1');
    expect(h.repo.hostRecord()?.issuedAt).toBe(BODY.issuedAt);
    expect(h.states.at(-1)).toEqual(state);
  });

  test('the five-minute timer runs the next sync', async () => {
    const h = harness();
    h.sync.start();
    await h.settle();
    h.advance(SYNC_INTERVAL_MS);
    await h.fire();
    expect(h.calls.snapshot).toBe(2);
    expect(h.repo.hostRecord()?.lastSyncAt).toBe(new Date(START + SYNC_INTERVAL_MS).toISOString());
  });

  test('syncNow() with no loop running syncs once and arms nothing', async () => {
    const h = harness();
    const state = await h.sync.syncNow();
    expect(h.calls.snapshot).toBe(1);
    expect(h.armed()).toBe(0);
    expect(state.status).toBe('connected');
  });

  test('stop() clears the timer and a manual sync afterwards arms nothing', async () => {
    const h = harness();
    h.sync.start();
    await h.settle();
    expect(h.armed()).toBe(1);
    h.sync.stop();
    h.sync.stop();
    expect(h.armed()).toBe(0);
    await h.sync.syncNow();
    expect(h.armed()).toBe(0);
    expect(h.calls.snapshot).toBe(2);
  });

  test('a write asks for a near-immediate sync, and a burst becomes one', async () => {
    const h = harness();
    h.sync.start();
    await h.settle();
    h.sync.afterWrite();
    h.sync.afterWrite();
    expect(h.armed()).toBe(1);
    expect(h.delay()).toBe(AFTER_WRITE_MS);
    await h.fire();
    expect(h.calls.snapshot).toBe(2);
    expect(h.delay()).toBe(SYNC_INTERVAL_MS);
  });

  test('afterWrite() without a running loop arms nothing', () => {
    const h = harness();
    h.sync.afterWrite();
    expect(h.armed()).toBe(0);
  });

  test('a syncNow() during an in-flight run chains one more run, which sees what changed', async () => {
    const h = harness();
    // The catalog the write produced: the run in flight below read the row before it existed.
    const newer: Snapshot = { ...BODY, version: 'v2', favorites: ['jitsi', 'kanban'] };
    const newerRaw = JSON.stringify(newer);
    let served = 0;
    h.script.snapshot = () => {
      served += 1;
      return served === 1 ? fullBody() : { notModified: false, snapshot: newer, raw: newerRaw };
    };

    h.sync.start(); // the run in flight
    const first = h.sync.syncNow(); // F5: this caller is answered by a run of its own
    const second = h.sync.syncNow(); // and this one waits for the same follow-up
    expect(second).toBe(first);

    const state = await first;
    expect(served).toBe(2);
    expect(h.calls.snapshot).toBe(2);
    expect(state.status).toBe('connected');
    expect(state.lastError).toBeNull();
    // The follow-up's answer is what landed, not the one the in-flight run had read.
    expect(h.repo.hostRecord()?.version).toBe('v2');
    expect(h.repo.hostRecord()?.snapshot).toBe(newerRaw);
    expect(h.armed()).toBe(1);
  });

  test('a write asked for during an in-flight run keeps its one-second deadline', async () => {
    const h = harness();
    h.sync.start();
    h.sync.afterWrite(); // SP04 §3: the write's own sync, one second from now
    await h.settle(); // the run ends and asks for the five minutes

    // F5: the run's re-arm must not push that write's sync back by up to five minutes.
    expect(h.delay()).toBe(AFTER_WRITE_MS);
    await h.fire();
    expect(h.calls.snapshot).toBe(2);
    expect(h.delay()).toBe(SYNC_INTERVAL_MS);
  });

  test('without a host row no sync reaches anywhere', async () => {
    const h = harness();
    h.repo.clearHost();
    const state = await h.sync.syncNow();
    expect(h.calls.snapshot).toBe(0);
    expect(h.calls.request).toEqual([]);
    expect(state).toEqual({
      status: 'none',
      guild: null,
      address: null,
      fingerprint: null,
      lastSyncAt: null,
      lastError: null,
      pendingWrites: 0,
    });
  });
});

describe('snapshot', () => {
  test('the last version is offered, and a 304 keeps the cached body', async () => {
    const h = harness({ snapshot: () => ({ notModified: true }) });
    const raw = cachedSnapshot(h);
    const state = await h.sync.syncNow();
    expect(h.calls.options).toEqual([{ version: 'v1', notOlderThan: BODY.issuedAt }]);
    expect(state.status).toBe('connected');
    expect(state.lastSyncAt).toBe(new Date(START).toISOString());
    expect(state.lastError).toBeNull();
    expect(h.repo.hostRecord()?.snapshot).toBe(raw);
    expect(h.repo.hostRecord()?.version).toBe('v1');
  });

  test('a network failure is stale, keeps the cache and backs off to five minutes', async () => {
    const h = harness({ snapshot: offline });
    const raw = cachedSnapshot(h);
    h.sync.start();
    const first = await h.settle();
    expect(first.status).toBe('stale');
    expect(first.lastError).toBe('could not reach the host');
    expect(first.lastSyncAt).toBe(EARLIER);
    expect(h.repo.hostRecord()?.snapshot).toBe(raw);
    expect(h.delay()).toBe(BACKOFF_MS[0]);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await h.fire();
      delays.push(h.delay() ?? 0);
    }
    // 1 min, 2 min, then the normal five minutes, and it stays there.
    expect(delays).toEqual([BACKOFF_MS[1], BACKOFF_MS[2], BACKOFF_MS[3], SYNC_INTERVAL_MS]);
    expect(h.states.at(-1)?.status).toBe('stale');
  });

  test('a changed host key writes the client message and stops the loop', async () => {
    const h = harness({
      snapshot: () => {
        throw new HostError('key-changed', HOST_KEY_CHANGED);
      },
    });
    h.sync.start();
    const state = await h.settle();
    expect(state.status).toBe('stale');
    expect(state.lastError).toBe(HOST_KEY_CHANGED);
    expect(state.guild).toBe('Guild');
    expect(h.armed()).toBe(0);
    expect(h.repo.hostRecord()?.snapshot).toBeNull();
  });
});

describe('401', () => {
  test('forgets the token, drops the org half, keeps the personal half and asks for sign-in once', async () => {
    const h = harness({ snapshot: signedOut, request: signedOut });
    cachedSnapshot(h);
    enqueue(h, 'PUT', '/v1/favorites', { entries: ['jitsi'], updatedAt: EARLIER }, EARLIER);
    h.sync.start();

    const state = await h.settle();
    expect(h.keychain.has(TOKEN_KEY)).toBe(false);
    expect(state.status).toBe('signed-out');
    expect(state.lastError).toBe(SIGNED_OUT_ERROR);
    expect(state.guild).toBe('Guild');
    expect(state.lastSyncAt).toBe(EARLIER);
    expect(h.signedOutCount()).toBe(1);
    // The write stays: a 401 judged the session, not the person's write (SP04 §4).
    expect(h.calls.request.length).toBe(1);
    expect(state.pendingWrites).toBe(1);

    const cached = h.repo.hostRecord()?.snapshot ?? '';
    const rows = JSON.parse(cached) as Snapshot;
    expect(rows.orgTools).toEqual([]);
    expect(rows.roles).toEqual([]);
    expect(rows.me.id).toBe('p1');
    expect(rows.personalTools.map((tool) => tool.id)).toEqual(['mine']);
    expect(rows.favorites).toEqual(['jitsi']);
    expect(h.repo.hostRecord()?.version).toBe('v1');
    expect(h.repo.hostRecord()?.issuedAt).toBe(BODY.issuedAt);

    // A second retry neither asks for sign-in again nor loses the pending write; it never reached
    // the snapshot, because the flush stopped at the same 401.
    await h.sync.syncNow();
    expect(h.signedOutCount()).toBe(1);
    expect(h.calls.snapshot).toBe(0);
    expect(h.repo.listOutbox()).toHaveLength(1);
  });

  test('a network failure after a sign-out leaves the state signed out', async () => {
    const h = harness({ snapshot: signedOut });
    cachedSnapshot(h);
    await h.sync.syncNow();
    h.script.snapshot = offline;
    const state = await h.sync.syncNow();
    expect(state.status).toBe('signed-out');
    expect(state.lastError).toBe(SIGNED_OUT_ERROR);
    expect(h.calls.options.at(-1)?.version).toBeNull();
  });

  test('a successful sync after the sign-in clears the state and brings the org half back', async () => {
    const h = harness({ snapshot: signedOut });
    cachedSnapshot(h);
    await h.sync.syncNow();
    expect(h.repo.hostRecord()?.snapshot).not.toBe(BODY_RAW);

    h.keychain.set(TOKEN_KEY, 'a-new-token');
    h.script.snapshot = fullBody;
    const state = await h.sync.syncNow();
    expect(state.status).toBe('connected');
    expect(state.lastError).toBeNull();
    expect(h.repo.hostRecord()?.snapshot).toBe(BODY_RAW);
    // The sign-out had emptied the cache, so that run went out unconditionally; the next one is
    // conditional again, because the row holds the host's own bytes.
    expect(h.calls.options.at(-1)?.version).toBeNull();
    await h.sync.syncNow();
    expect(h.calls.options.at(-1)?.version).toBe('v1');
  });
});

describe('outbox', () => {
  test('pending writes are replayed in id order and dropped when the host takes them', async () => {
    const h = harness();
    const write = { id: 'mine', scope: 'personal', ownerId: 'p1' };
    enqueue(h, 'PUT', '/v1/personal/tools/mine', write, '2026-10-15T11:00:00.000Z');
    enqueue(h, 'DELETE', '/v1/personal/views/v-1', { updatedAt: '2026-10-15T11:01:00.000Z' }, '2026-10-15T11:01:00.000Z');

    const state = await h.sync.syncNow();
    expect(h.calls.request.map((call) => [call.method, call.path])).toEqual([
      ['PUT', '/v1/personal/tools/mine'],
      ['DELETE', '/v1/personal/views/v-1'],
    ]);
    expect(h.calls.request[0]?.body).toEqual(write);
    expect(h.repo.listOutbox()).toEqual([]);
    expect(state.pendingWrites).toBe(0);
  });

  test('a write the host never received is marked and kept, and the next sync sends it', async () => {
    const h = harness({ snapshot: offline, request: offline });
    enqueue(h, 'PUT', '/v1/personal/tools/mine', { id: 'mine' }, '2026-10-15T11:00:00.000Z');
    enqueue(h, 'PUT', '/v1/personal/tools/other', { id: 'other' }, '2026-10-15T11:02:00.000Z');

    let state = await h.sync.syncNow();
    expect(state.status).toBe('stale');
    expect(state.pendingWrites).toBe(2);
    // One request at a time: the flush stops at the first write it could not place.
    expect(h.calls.request.length).toBe(1);
    const kept = h.repo.listOutbox();
    expect(kept.map((row) => row.id)).toEqual([1, 2]);
    expect(kept[0]?.attempts).toBe(1);
    expect(kept[0]?.lastError).toBe('could not reach the host');
    expect(kept[1]?.attempts).toBe(0);

    h.script.snapshot = fullBody;
    delete h.script.request;
    state = await h.sync.syncNow();
    expect(state.status).toBe('connected');
    expect(state.pendingWrites).toBe(0);
    expect(h.calls.request.length).toBe(3);
    expect(h.repo.listOutbox()).toEqual([]);
  });

  test('a 409 and a 403 drop the write: neither can be replayed', async () => {
    for (const status of [409, 403]) {
      const h = harness({
        // Only the write is refused: the host of SP03 §2 still takes the events and the state, and
        // the 403 of SP04 §4 raises the `sync.rejected` event that the run then pushes.
        request: (method, path, body) => {
          if (path === HOST_ROUTES.events) return ackBatch(method, path, body);
          throw new HostError('refused', 'the host refused the request', status);
        },
      });
      enqueue(h, 'PUT', '/v1/personal/tools/mine', { id: 'mine' }, '2026-10-15T11:00:00.000Z');
      const state = await h.sync.syncNow();
      expect(h.repo.listOutbox()).toEqual([]);
      expect(state.pendingWrites).toBe(0);
      // The rest of the run still happened: the snapshot was asked for.
      expect(h.calls.snapshot).toBe(1);
    }
  });

  test('a row whose body is not JSON is dropped rather than blocking the queue', async () => {
    const h = harness();
    h.repo.enqueueOutbox({ method: 'PUT', path: '/v1/personal/tools/mine', body: 'not json', createdAt: EARLIER });
    enqueue(h, 'PUT', '/v1/personal/tools/other', { id: 'other' }, EARLIER);
    const state = await h.sync.syncNow();
    expect(state.pendingWrites).toBe(0);
    expect(h.calls.request.map((call) => call.path)).toEqual(['/v1/personal/tools/other']);
  });
});

describe('event push', () => {
  test('1200 unsent events go up in three batches of 500/500/200, oldest first, all marked sent', async () => {
    const h = harness({ request: ackBatch });
    const at = (index: number) => new Date(Date.parse('2026-10-15T10:00:00.000Z') + index * 1000).toISOString();
    for (let index = 0; index < 1200; index += 1) recordEvent(h, at(index));
    const pending = h.repo.unsentEvents(1200).map((event) => event.clientId);

    const state = await h.sync.syncNow();

    const batches = batchesOf(h);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 200]);
    // Oldest first, and the three batches are consecutive: no row is skipped or repeated.
    expect(batches.flat().map((event) => event.id)).toEqual(pending);
    // The wire shape is SP04 §5's `ClientEvent` exactly — nothing more, nothing less.
    expect(batches[0]?.[0]).toEqual({
      id: pending[0],
      at: at(0),
      kind: 'tool_opened',
      toolId: 'alpha',
      url: 'https://alpha.example.test/app',
      result: null,
      detail: null,
    });
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 1200, pending: 0 });
    // SP04 §3's order, and no empty batch after the last one.
    expect(h.order).toEqual([
      `POST ${HOST_ROUTES.events}`,
      `POST ${HOST_ROUTES.events}`,
      `POST ${HOST_ROUTES.events}`,
      `GET ${HOST_ROUTES.state}`,
    ]);
    expect(state.status).toBe('connected');
    expect(state.lastError).toBeNull();
  });

  test('a partial ack marks only the acked ids; the rest stay pending and are re-sent', async () => {
    let posts = 0;
    const h = harness({
      request: (method, path, body) => {
        if (path !== HOST_ROUTES.events) return undefined;
        posts += 1;
        const events = (body as EventsRequest).events;
        // The first batch confirms one row of three; the second confirms nothing.
        return { acked: posts === 1 ? [events[0]!.id] : [] };
      },
    });
    const events = [recordEvent(h, EARLIER), recordEvent(h, EARLIER), recordEvent(h, EARLIER)];

    const state = await h.sync.syncNow();

    expect(h.repo.eventSyncCounts()).toEqual({ sent: 1, pending: 2 });
    const marked = h.repo.listEvents({});
    expect(marked.filter((event) => event.sentAt !== null).map((event) => event.clientId)).toEqual([
      events[0]?.clientId,
    ]);
    // The unacked pair went up again in the same run, then the push stopped instead of asking for
    // the same rows forever.
    expect(batchesOf(h).map((batch) => batch.map((event) => event.id))).toEqual([
      events.map((event) => event.clientId),
      [events[1]?.clientId, events[2]?.clientId],
    ]);
    expect(state.status).toBe('connected');
  });

  test('a failure keeps every event pending with its client id, and the next run sends the same ids', async () => {
    const h = harness({ request: offline });
    recordEvent(h, EARLIER);
    recordEvent(h, EARLIER);

    const failed = await h.sync.syncNow();
    expect(failed.status).toBe('stale');
    expect(failed.lastError).toBe('could not reach the host');
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 0, pending: 2 });
    // F6: the push stopped, and the state of SP04 §3 came anyway — the person kept receiving the org
    // half of the catalog while their own activity waited (the script's snapshot is offline too).
    expect(h.calls.snapshot).toBe(1);
    const first = batchesOf(h);
    expect(first).toHaveLength(1);

    h.script.request = ackBatch;
    const second = await h.sync.syncNow();
    expect(second.status).toBe('connected');
    expect(batchesOf(h)[1]?.map((event) => event.id)).toEqual(first[0]?.map((event) => event.id));
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 2, pending: 0 });
  });

  test('without a host row nothing is pushed and every event stays pending and private', async () => {
    const h = harness();
    recordEvent(h, EARLIER);
    recordEvent(h, EARLIER);
    h.repo.clearHost();

    const state = await h.sync.syncNow();

    expect(state.status).toBe('none');
    expect(h.calls.request).toEqual([]);
    expect(h.calls.snapshot).toBe(0);
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 0, pending: 2 });
  });

  test('the run goes outbox, events, state', async () => {
    const h = harness({ request: (method, path, body) => (path === HOST_ROUTES.events ? ackBatch(method, path, body) : undefined) });
    enqueue(h, 'PUT', '/v1/personal/tools/mine', { id: 'mine' }, EARLIER);
    recordEvent(h, EARLIER);

    await h.sync.syncNow();

    expect(h.order).toEqual([
      'PUT /v1/personal/tools/mine',
      `POST ${HOST_ROUTES.events}`,
      `GET ${HOST_ROUTES.state}`,
    ]);
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 1, pending: 0 });
  });

  test('a write the host refuses for good raises one sync.rejected event, pushed by the same run', async () => {
    const h = harness({
      request: (method, path, body) => {
        if (path === HOST_ROUTES.events) return ackBatch(method, path, body);
        throw new HostError('refused', 'the host refused the request', 403);
      },
    });
    enqueue(h, 'PUT', '/v1/personal/tools/mine', { id: 'mine' }, EARLIER);

    await h.sync.syncNow();

    // SP04 §4: the row is dropped and the person can see why; the body of the write is nowhere in
    // the event (canonico §13).
    const events = h.repo.listEvents({});
    expect(events.map((event) => [event.type, event.result, event.detail, event.personId])).toEqual([
      ['sync.rejected', '403', 'PUT /v1/personal/tools/mine', HOST.personId],
    ]);
    expect(batchesOf(h).map((batch) => batch.map((event) => event.kind))).toEqual([['sync.rejected']]);
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 1, pending: 0 });
    expect(h.repo.listOutbox()).toEqual([]);
  });

  test('a 409 is not a refusal: the write is dropped and no event is raised', async () => {
    const h = harness({
      request: (method, path, body) => {
        if (path === HOST_ROUTES.events) return ackBatch(method, path, body);
        throw new HostError('refused', 'the host refused the request', 409);
      },
    });
    enqueue(h, 'PUT', '/v1/personal/tools/mine', { id: 'mine' }, EARLIER);

    const state = await h.sync.syncNow();

    expect(h.repo.listOutbox()).toEqual([]);
    expect(h.repo.listEvents({})).toEqual([]);
    expect(state.status).toBe('connected');
  });

  test('a batch the host refuses with a 400 still brings the snapshot, noted once', async () => {
    const h = harness({
      request: (_method, path) => {
        if (path === HOST_ROUTES.events) throw new HostError('refused', 'the host refused the request', 400);
        return undefined;
      },
    });
    recordEvent(h, EARLIER);

    const state = await h.sync.syncNow();

    // F6: a refused push used to end the run here, and the person stopped receiving org changes.
    expect(h.calls.snapshot).toBe(1);
    expect(h.repo.hostRecord()?.snapshot).toBe(BODY_RAW);
    expect(state.status).toBe('stale');
    expect(state.lastError).toBe('the host refused the request');
    // SP04 §5 has no verdict for a batch refused for good: the events stay pending and the refusal
    // is one event of this run — the status and the route, never the events themselves (canonico §13).
    expect(h.repo.listEvents({}).map((event) => [event.type, event.result, event.detail])).toEqual([
      ['sync.rejected', '400', `POST ${HOST_ROUTES.events}`],
      ['tool_opened', null, null],
    ]);
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 0, pending: 2 });

    // The same batch refused again is the same refusal: it is noted once, not once per run.
    await h.sync.syncNow();
    expect(h.repo.listEvents({}).filter((event) => event.type === 'sync.rejected')).toHaveLength(1);
  });

  test('a batch the host never received keeps the events pending and still brings the snapshot', async () => {
    const h = harness({
      request: (_method, path) => {
        if (path === HOST_ROUTES.events) throw new HostError('server', 'the host failed to answer', 500);
        return undefined;
      },
    });
    recordEvent(h, EARLIER);

    const state = await h.sync.syncNow();

    expect(h.calls.snapshot).toBe(1);
    expect(h.repo.hostRecord()?.snapshot).toBe(BODY_RAW);
    expect(state.status).toBe('stale');
    expect(state.lastError).toBe('the host failed to answer');
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 0, pending: 1 });
    // A `5xx` is a host that may still take the batch: no `sync.rejected` for it.
    expect(h.repo.listEvents({}).map((event) => event.type)).toEqual(['tool_opened']);
  });

  test('a 401 on the push is still the sign-out path, not a failure to retry', async () => {
    const h = harness({
      request: (_method, path) => {
        if (path === HOST_ROUTES.events) throw new HostError('signed-out', 'signed out', 401);
        return undefined;
      },
    });
    recordEvent(h, EARLIER);

    const state = await h.sync.syncNow();

    // F6 leaves this path alone (SP04 §3, RF-39): the session ended, so there is no snapshot to ask
    // for and no note about a batch that was never judged.
    expect(state.status).toBe('signed-out');
    expect(state.lastError).toBe(SIGNED_OUT_ERROR);
    expect(h.keychain.has(TOKEN_KEY)).toBe(false);
    expect(h.signedOutCount()).toBe(1);
    expect(h.calls.snapshot).toBe(0);
    expect(h.repo.eventSyncCounts()).toEqual({ sent: 0, pending: 1 });
    expect(h.repo.listEvents({}).map((event) => event.type)).toEqual(['tool_opened']);
  });
});

describe('a run that outlives its host (F8)', () => {
  /** Another host — another `kid` and another add instant — added while a run was in flight. */
  const OTHER = {
    address: 'https://other.example.test',
    guild: 'Other Guild',
    kid: 'kid-2',
    publicKey: PUBLIC_KEY,
    personId: 'p1',
    salt: 'c2FsdA',
    addedAt: '2026-10-16T09:00:00.000Z',
  };

  test('remove and re-add during an in-flight run leaves the new row untouched', async () => {
    const h = harness();
    h.sync.start(); // the run in flight, holding the host it read
    h.repo.clearHost(); // `host.remove`
    h.repo.saveHost({ ...OTHER, addedAt: '2026-10-16T09:30:00.000Z' }); // the host added in its place

    const state = await h.settle();

    // The verified body of the old host is not the new row's to receive (F8).
    const record = h.repo.hostRecord();
    expect(record?.kid).toBe(OTHER.kid);
    expect(record?.snapshot).toBeNull();
    expect(record?.version).toBeNull();
    expect(record?.issuedAt).toBeNull();
    expect(record?.lastSyncAt).toBeNull();
    expect(record?.lastError).toBeNull();
    // What the loop shows is the row that is there now, and nothing was said about the old one.
    expect(state.guild).toBe('Other Guild');
    expect(state.status).toBe('connected');
  });

  test('a failure of a run whose host was replaced does not mark the new row', async () => {
    const h = harness({ snapshot: offline });
    h.sync.start();
    h.repo.clearHost();
    h.repo.saveHost(OTHER);

    await h.settle();

    expect(h.repo.hostRecord()?.lastError).toBeNull();
  });

  test('a 401 that outlives its host neither forgets the token nor signs the new row out', async () => {
    // The same host added again: its keychain item is the same `bond.host.<kid>.<personId>`.
    const h = harness({ snapshot: signedOut });
    h.sync.start();
    h.repo.clearHost();
    h.repo.saveHost({ ...OTHER, kid: HOST.kid });
    h.keychain.set(TOKEN_KEY, 'the-token-of-the-new-sign-in');

    await h.settle();

    expect(h.keychain.get(TOKEN_KEY)).toBe('the-token-of-the-new-sign-in');
    expect(h.signedOutCount()).toBe(0);
    expect(h.repo.hostRecord()?.lastError).toBeNull();
    expect(h.repo.hostRecord()?.snapshot).toBeNull();
  });

  test('a host replaced while the bearer is being forgotten is not written either', async () => {
    const h = harness({ snapshot: signedOut });
    // The keychain is the slow part of the sign-out: the person removes the host and adds another
    // while it is busy.
    h.connection.forgetToken = async () => {
      h.keychain.delete(TOKEN_KEY);
      h.repo.clearHost();
      h.repo.saveHost(OTHER);
    };

    await h.sync.syncNow();

    expect(h.repo.hostRecord()?.kid).toBe(OTHER.kid);
    expect(h.repo.hostRecord()?.lastError).toBeNull();
    expect(h.repo.hostRecord()?.snapshot).toBeNull();
    expect(h.signedOutCount()).toBe(0);
  });
});
