// The event surface of the host, on the real Elysia app over a temp data dir (SP03 §1–§2, SP04 §5).
// Every request goes through `app.handle(new Request(...))` and every read goes to the database the
// app wrote: nothing here mocks the repo, the guards or the app. Run it with
// `bun test host/events.test.ts`.
//
// The app is `createApp` alone — the one `host/main.ts` serves and the one `host/app.ts` mounts the
// events group in (`H5`). A test that mounted `eventRoutes` itself would keep passing after that
// `.use(...)` line went missing.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  type ClientEvent,
  type ErrorResponse,
  type EventsResponse,
} from '../shared/host-api';
import { createApp } from './app';
import { INVALID_CREDENTIALS } from './auth';
import { DEFAULT_PORT, type HostConfig } from './config';
import { bootHost, type Host } from './main';
import { createRepo, type Repo } from './repo';
import { MAX_EVENTS_PER_BATCH } from './routes/events';

const DEVICE = { name: 'bond-events-test', os: 'macos', appVersion: '0.3.0' } as const;

/** What a test needs from an app: Elysia's answer to one `Request`. */
type HttpApp = { handle(request: Request): Promise<Response> };

type TestHost = {
  /** The real app: `createApp`, with the events group it mounts, over the booted data dir. */
  app: HttpApp;
  repo: Repo;
  /** The connection `bootHost` opened: its type comes from the boot, never from `bun:sqlite` here. */
  db: Host['db'];
  dir: string;
  cleanup(): void;
};

const hosts: TestHost[] = [];
const dirs: string[] = [];

async function startHost(): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'bond-events-'));
  dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://bond.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  const host = await bootHost(config);
  const started: TestHost = {
    // The real app: `createApp` mounts the events group with one `.use(...)` line (H5's
    // `host/app.ts`), so mounting it here again would only hide that line going missing.
    app: createApp({ config, db: host.db }),
    repo: createRepo(host.db),
    db: host.db,
    dir,
    cleanup: () => host.close(),
  };
  hosts.push(started);
  return started;
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

const instant = (): string => new Date().toISOString();

/** One event as the Bond sends it (SP04 §5): the client id plus the fields of `ClientEvent`. */
function event(id: string, overrides: Partial<ClientEvent> = {}): ClientEvent {
  return {
    id,
    at: instant(),
    kind: 'tool_opened',
    toolId: null,
    url: null,
    result: null,
    detail: null,
    ...overrides,
  };
}

/**
 * A person of the guild with one live session: the token pair `personAuth` accepts (SP02 §5). No
 * event route reads `activated_at`, so nobody is activated here (that is H4's surface, and its tests
 * own it).
 */
async function signedIn(host: TestHost, email: string) {
  const at = instant();
  const person = host.repo.createPerson({ id: crypto.randomUUID(), email, name: email }, at);
  const sessionId = crypto.randomUUID();
  const token = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  host.repo.createSession(
    { id: sessionId, personId: person.id, tokenHash: await sha256Hex(token), device: DEVICE },
    at,
  );
  return { person, sessionId, token };
}

function post(app: HttpApp, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.handle(
    new Request(`http://bond.test${HOST_ROUTES.events}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

type EventRow = {
  id: string;
  personId: string;
  sessionId: string;
  at: string;
  kind: string;
  toolId: string | null;
  url: string | null;
  result: string | null;
  detail: string | null;
  receivedAt: string;
};

const EVENT_COLUMNS = `id, person_id AS personId, session_id AS sessionId, at, kind,
  tool_id AS toolId, url, result, detail, received_at AS receivedAt`;

/** Every row the host holds, as the `events` table of SP01 §2 stores it. */
function rows(host: TestHost): EventRow[] {
  return host.db.query<EventRow, []>(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY id`).all();
}

/** The bytes of every file of a data dir, for "no secret in an event" (canonico §13, SP01 §1). */
function dataDirBytes(dir: string): string {
  let bytes = '';
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${dir}/host.db${suffix}`;
    if (existsSync(path)) bytes += readFileSync(path, 'utf8');
  }
  return bytes;
}

/** The kinds `shared/types.ts`'s `EventType` declares, read from the source (canonico §13). */
function eventKinds(): string[] {
  const source = readFileSync(join(import.meta.dir, '..', 'shared', 'types.ts'), 'utf8');
  const block = /export type EventType =([\s\S]*?);\n/.exec(source);
  if (block === null) throw new Error('shared/types.ts no longer declares EventType');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------- the batch (SP04 §5)

describe('POST /v1/events', () => {
  test('the batch lands on the session person and the ids the host holds come back', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');
    const sent = [
      event('e1', {
        kind: 'tool_opened',
        toolId: 'kanban',
        url: 'https://kanban.example.test/app',
        result: null,
        detail: null,
      }),
      event('e2', { kind: 'login', toolId: 'kanban', result: 'session', detail: null }),
    ];

    const response = await post(host.app, { events: sent }, ada.token);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as EventsResponse;
    // SP03 §2: `{ acked }` and nothing else; SP04 §5: every id the host now holds.
    expect(Object.keys(body)).toEqual(['acked']);
    expect([...body.acked].sort()).toEqual(['e1', 'e2']);

    const stored = rows(host);
    expect(stored).toHaveLength(2);
    // The person and the session are the token's, and every field of the event is the client's.
    expect(stored[0]).toMatchObject({
      id: 'e1',
      personId: ada.person.id,
      sessionId: ada.sessionId,
      at: sent[0].at,
      kind: 'tool_opened',
      toolId: 'kanban',
      url: 'https://kanban.example.test/app',
      result: null,
      detail: null,
    });
    expect(stored[1]).toMatchObject({ id: 'e2', kind: 'login', result: 'session' });
    for (const row of stored) {
      expect(row.receivedAt).not.toBe('');
    }
  });

  test('the same batch twice leaves one row per event and acks the same ids', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');
    const sent = [event('e1'), event('e2', { kind: 'unlocked' }), event('e3', { kind: 'locked' })];

    const first = await post(host.app, { events: sent }, ada.token);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as EventsResponse;
    const receipts = rows(host).map((row) => row.receivedAt);

    const second = await post(host.app, { events: sent }, ada.token);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as EventsResponse;
    expect([...secondBody.acked].sort()).toEqual([...firstBody.acked].sort());
    // `ON CONFLICT(id) DO NOTHING` (SP04 §5): one row per event, and the receipt of the first batch
    // stands — the replay wrote nothing.
    expect(rows(host)).toHaveLength(3);
    expect(rows(host).map((row) => row.receivedAt)).toEqual(receipts);

    // A replay that carries one new event acks it together with the old ones and inserts only it.
    const third = await post(
      host.app,
      { events: [...sent, event('e4', { kind: 'download' })] },
      ada.token,
    );
    expect(third.status).toBe(200);
    expect([...((await third.json()) as EventsResponse).acked].sort()).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
    ]);
    expect(rows(host)).toHaveLength(4);
  });

  test('an empty batch is honest: nothing lands and nothing is acked', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');

    const response = await post(host.app, { events: [] }, ada.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acked: [] });
    expect(rows(host)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- the 500 cap (SP03 §2)

  test('500 events land and the 501st answers 400 without writing', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, index) => event(`e${index}`));

    const over = await post(host.app, { events: many }, ada.token);
    expect(over.status).toBe(400);
    const refusal = (await over.json()) as ErrorResponse;
    // SP03 §1: the message names the field, and never a value from the request.
    expect(refusal.error).toContain('events');
    expect(rows(host)).toHaveLength(0);

    const full = await post(host.app, { events: many.slice(0, MAX_EVENTS_PER_BATCH) }, ada.token);
    expect(full.status).toBe(200);
    expect(((await full.json()) as EventsResponse).acked).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(rows(host)).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  test('a body that is not a batch of client events answers 400 naming the field', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');

    const noBatch = await post(host.app, {}, ada.token);
    expect(noBatch.status).toBe(400);
    expect(((await noBatch.json()) as ErrorResponse).error).toContain('events');

    // SP03 §2: every event carries a client id — it is the idempotency key.
    const noId = await post(
      host.app,
      {
        events: [
          { at: instant(), kind: 'unlocked', toolId: null, url: null, result: null, detail: null },
        ],
      },
      ada.token,
    );
    expect(noId.status).toBe(400);
    expect(((await noId.json()) as ErrorResponse).error).toContain('id');
    expect(rows(host)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- the kinds (canonico §13)

  test('every kind the shared EventType declares is accepted, and an unknown one is refused', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');
    const kinds = eventKinds();
    expect(kinds.length).toBeGreaterThan(20);

    const response = await post(
      host.app,
      {
        events: kinds.map((kind, index) =>
          event(`k${index}`, { kind: kind as ClientEvent['kind'] }),
        ),
      },
      ada.token,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as EventsResponse).acked).toHaveLength(kinds.length);
    expect(rows(host).map((row) => row.kind).sort()).toEqual([...kinds].sort());

    const bogus = await post(
      host.app,
      { events: [{ ...event('bad'), kind: 'no_such_kind' }] },
      ada.token,
    );
    expect(bogus.status).toBe(400);
    const refusal = (await bogus.json()) as ErrorResponse;
    expect(refusal.error).toContain('kind');
    expect(rows(host)).toHaveLength(kinds.length);
  });

  // ---------------------------------------------------------------- the URL rule (SP01 §2, SP04 §5)

  test('a url lands as origin + pathname: query string and fragment never reach the row', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');

    const response = await post(
      host.app,
      {
        events: [
          event('e1', { url: 'https://kanban.example.test/app?token=QUERY-TOKEN-1#FRAGMENT-1' }),
          event('e2', { url: 'https://kanban.example.test/board#FRAGMENT-2' }),
          // A URL the rule refuses (plain http outside loopback) is stored as null, not rejected.
          event('e3', { url: 'http://plain.example.test/app?token=QUERY-TOKEN-2' }),
          event('e4', { url: null }),
        ],
      },
      ada.token,
    );
    expect(response.status).toBe(200);

    const urlOf = (id: string): string | null | undefined =>
      rows(host).find((row) => row.id === id)?.url;
    expect(urlOf('e1')).toBe('https://kanban.example.test/app');
    expect(urlOf('e2')).toBe('https://kanban.example.test/board');
    expect(urlOf('e3')).toBeNull();
    expect(urlOf('e4')).toBeNull();

    // canonico §13: no secret in an event — the query string and the fragment are nowhere in the
    // data dir (not in the row, not in the WAL beside it).
    const bytes = dataDirBytes(host.dir);
    expect(bytes.includes('QUERY-TOKEN-1')).toBe(false);
    expect(bytes.includes('QUERY-TOKEN-2')).toBe(false);
    expect(bytes.includes('FRAGMENT-1')).toBe(false);
    expect(bytes.includes('FRAGMENT-2')).toBe(false);
  });

  // ---------------------------------------------------------------- the caller (SP03 §1)

  test("the person is the session's, never the body's", async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');
    const bob = await signedIn(host, 'bob@bond.test');

    const response = await post(
      host.app,
      { events: [{ ...event('e1'), personId: ada.person.id, person_id: ada.person.id }] },
      bob.token,
    );
    expect(response.status).toBe(200);
    expect(rows(host)).toHaveLength(1);
    expect(rows(host)[0].personId).toBe(bob.person.id);
    expect(rows(host)[0].sessionId).toBe(bob.sessionId);
    expect(JSON.stringify(await response.json())).not.toContain(ada.person.id);
  });

  test('an id the host already holds for another person is not taken over', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');
    const bob = await signedIn(host, 'bob@bond.test');

    await post(
      host.app,
      { events: [event('shared', { toolId: 'kanban', detail: 'first' })] },
      ada.token,
    );
    const before = rows(host);

    const response = await post(
      host.app,
      { events: [event('shared', { kind: 'locked', detail: 'second' })] },
      bob.token,
    );
    expect(response.status).toBe(200);
    // SP04 §5 answers every id the host now holds, and it holds this one: the row of the first
    // writer stands, untouched (the id is the table's primary key, not a per-person key).
    expect(((await response.json()) as EventsResponse).acked).toEqual(['shared']);
    expect(rows(host)).toEqual(before);
  });

  test('a batch without a live session answers 401 and writes nothing', async () => {
    const host = await startHost();
    const ada = await signedIn(host, 'ada@bond.test');
    const batch = { events: [event('e1')] };

    const anonymous = await post(host.app, batch, null);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: INVALID_CREDENTIALS });

    const dead = await post(host.app, batch, toBase64url(crypto.getRandomValues(new Uint8Array(32))));
    expect(dead.status).toBe(401);
    expect(await dead.json()).toEqual({ error: INVALID_CREDENTIALS });

    // SP02 §5: a revoked session is as dead as an unknown token.
    host.repo.revokeOwnSession(ada.person.id, ada.sessionId, instant());
    const revoked = await post(host.app, batch, ada.token);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: INVALID_CREDENTIALS });

    expect(rows(host)).toHaveLength(0);
  });
});
