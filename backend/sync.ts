// The sync loop of a connected Bond: the triggers, the outbox flush, the event push, the snapshot
// apply, the stale state and the backoff (SP04 §3–§5, SP05 §1–§2; RF-37, RF-39).
//
// The runtime arrives as parameters — the repository, the connection, the clock and the interval pair
// (`docs/tinyjs.md` §3: the page is throttled when hidden, so the timer lives in the backend) — which
// is what lets `bun test` drive the whole loop with a fake connection and a fake clock.
// `backend/main.ts` (B2) owns the wiring: `start()` right after unlock, `stop()` on lock or on
// removing the host, and `host.syncNow` → `syncNow()`.
//
// The bearer never passes through here: it lives in the keychain (SP02 §5) and
// `backend/host-client.ts` reads it per call. Nothing in this file writes a password, a token or a
// credential value into a row, a message, a log or a state (`AGENTS.md`).

import { fromBase64url } from '../shared/encoding';
import { HOST_ROUTES } from '../shared/host-api';
import type { ClientEvent, EventsResponse } from '../shared/host-api';
import { clearOrgData, outboxVerdict } from '../shared/host-merge';
import type { HostState } from '../shared/types';
import { fingerprintOf, HostError } from './host-client';
import type { HostConnection } from './host-client';
import type { HostRecord, Repo } from './repo';

/** SP04 §3: while unlocked, one sync every five minutes. */
export const SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * SP04 §5: how many events one `POST /v1/events` carries. The host refuses the 501st with a `400`
 * that writes nothing (SP03 §2, `host/routes/events.ts`), so the Bond never assembles one: the
 * number is the client's own choice inside the "up to 500" rule.
 */
export const EVENTS_PER_BATCH = 500;

/**
 * SP04 §3: after a failure the next try comes 30 s, 1 min and 2 min later, and from then on the
 * normal five minutes. The array is the schedule itself — `failures` indexes into it.
 */
export const BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, SYNC_INTERVAL_MS];

/** SP04 §3: a write asks for a sync of its own; this is how long a burst of writes coalesces. */
export const AFTER_WRITE_MS = 1_000;

/**
 * What a `401` leaves in `host.last_error` (SP04 §3, RF-39). It is the state Settings → Hosts and
 * the sidebar read as *signed out*, and it is also what tells a later sync that the cached body is
 * no longer the bytes the host signed — so its `version` must not be offered as an `ETag` again, or
 * the host would answer `304` and the org half would never come back.
 */
export const SIGNED_OUT_ERROR = 'signed out — sign in again';

/** What `createSync` needs from its runtime. */
export interface SyncDeps {
  repo: Repo;
  /** The connection to the pinned host, or `null`. RF-30: no host row, no client, no call. */
  connection: () => HostConnection | null;
  /** Milliseconds since the epoch: the backoff, `syncedAt` and the state's clock. */
  now: () => number;
  /** Every state the loop observes, for `host.state` and the sidebar badge (SP05 §3–§4). */
  onState: (state: HostState) => void;
  /** Once per session that ends on a `401`: the app asks for sign-in (SP04 §3, RF-39). */
  onSignedOut: () => void;
  setInterval: (run: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/** What `backend/main.ts` and the RPC methods use. */
export interface Sync {
  start(): void;
  stop(): void;
  syncNow(): Promise<HostState>;
  state(): HostState;
  afterWrite(): void;
}

export function createSync(deps: SyncDeps): Sync {
  const repo = deps.repo;
  const setInterval = deps.setInterval;
  const clearInterval = deps.clearInterval;

  /** The armed timer: the next sync, or a write's near-immediate one. */
  let timer: unknown | null = null;
  /** `start()` was called and `stop()` has not: only then does a finished run re-arm. */
  let running = false;
  /** Consecutive runs that did not reach the host: indexes into `BACKOFF_MS`. */
  let failures = 0;
  /** The run in flight, so a timer and a manual "Sync now" never overlap. */
  let current: Promise<HostState> | null = null;
  /** The pinned key's fingerprint, computed once per key (`fingerprintOf` is async). */
  let fingerprint: { kid: string; publicKey: string; value: string } | null = null;

  // ---------------------------------------------------------------- timers

  function disarm(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  /**
   * Schedules one run `ms` from now. The pair the runtime gives us is an interval; a one-shot is an
   * interval that clears itself the first time it fires, so `arm` is also how a burst of writes
   * coalesces (`AFTER_WRITE_MS`) into one sync.
   */
  function arm(ms: number): void {
    disarm();
    let fired = false;
    const handle = setInterval(() => {
      if (fired) return;
      fired = true;
      clearInterval(handle);
      if (timer === handle) timer = null;
      run();
    }, ms);
    timer = handle;
  }

  /** A run rung by a timer. The loop must survive it: `runOnce` already turned every host failure
   *  into state, so what rejects here is a bug in our own code or in the repository — and the loop
   *  keeps its cadence instead of dying silently, leaving the next tick to try again. */
  function run(): void {
    void syncNow().catch(() => {
      if (running) arm(nextDelay());
    });
  }

  /** SP04 §3's schedule: the five minutes when all is well, the backoff otherwise. */
  function nextDelay(): number {
    if (failures === 0) return SYNC_INTERVAL_MS;
    return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? SYNC_INTERVAL_MS;
  }

  // ---------------------------------------------------------------- the loop

  function start(): void {
    if (running) return;
    running = true;
    failures = 0;
    // SP04 §3: right after unlock. The run itself arms the five-minute timer once it is done.
    run();
  }

  function stop(): void {
    running = false;
    disarm();
  }

  function afterWrite(): void {
    // SP04 §3: after any admin write. Near-immediate, and the writes of a burst become one sync.
    if (!running) return;
    arm(AFTER_WRITE_MS);
  }

  function syncNow(): Promise<HostState> {
    if (current !== null) return current;
    current = runOnce().finally(() => {
      current = null;
    });
    return current.then((state) => {
      if (running) arm(nextDelay());
      return state;
    });
  }

  // ---------------------------------------------------------------- one run

  async function runOnce(): Promise<HostState> {
    const connection = deps.connection();
    const record = repo.hostRecord();
    // RF-30: without a host row there is nothing to sync with, and no call is made.
    if (connection === null || record === null) return state();
    await rememberFingerprint(record);
    const at = new Date(deps.now()).toISOString();
    try {
      // SP04 §3's order: the outbox, then the events, then the state.
      await flushOutbox(connection);
      await pushEvents(connection, at);
      await fetchSnapshot(connection, record, at);
      failures = 0;
      return publish();
    } catch (error) {
      return failed(connection, record, error);
    }
  }

  /**
   * SP04 §2–§3: `GET /v1/state` with the last accepted `version` (the host answers `304` when the
   * body did not change) and the last accepted `issuedAt` as the floor below which a body is refused.
   * The body lands in the row verbatim with its own `version` and `issuedAt` and the time of this
   * success; a `304` keeps the cached body and records the success all the same.
   */
  async function fetchSnapshot(connection: HostConnection, record: HostRecord, at: string): Promise<void> {
    // A cache the sign-out emptied is no longer the host's bytes, and a `304` would keep it empty
    // for good: after a sign-out the request goes out without `If-None-Match` (SIGNED_OUT_ERROR).
    const conditional =
      record.lastError !== SIGNED_OUT_ERROR && record.version !== null && record.snapshot !== null;
    const result = await connection.snapshot({
      version: conditional ? record.version : null,
      notOlderThan: record.issuedAt,
    });
    if (!result.notModified) {
      repo.saveHostSnapshot({
        snapshot: result.raw,
        version: result.snapshot.version,
        issuedAt: result.snapshot.issuedAt,
        syncedAt: at,
      });
      return;
    }
    // Only a conditional request is answered with `304`, and that needs the whole cached row.
    if (record.snapshot === null || record.version === null || record.issuedAt === null) {
      throw new Error('the host answered 304 with no cached snapshot');
    }
    repo.saveHostSnapshot({
      snapshot: record.snapshot,
      version: record.version,
      issuedAt: record.issuedAt,
      syncedAt: at,
    });
  }

  /**
   * SP04 §4: in `id` order, one request at a time. A request that resolves drops the row; a `409`
   * drops it and the next snapshot brings the host's version; another `4xx` drops it as refused; a
   * `5xx` or a call that never arrived marks the attempt and stops the flush until the next sync.
   */
  async function flushOutbox(connection: HostConnection): Promise<void> {
    for (const entry of repo.listOutbox()) {
      let body: unknown;
      try {
        body = entry.body === '' ? undefined : (JSON.parse(entry.body) as unknown);
      } catch {
        // A body of our own that does not parse can never be replayed; SP04 §4 has no verdict for
        // it, and keeping it would block every write behind it.
        repo.deleteOutbox(entry.id);
        continue;
      }
      try {
        await connection.request(entry.method, entry.path, body);
        repo.deleteOutbox(entry.id);
        continue;
      } catch (error) {
        if (!(error instanceof HostError)) throw error;
        // A session that ended or a host whose key changed is not a verdict on this write: the run
        // reacts to it as a whole (SP04 §1, §3).
        if (error.failure === 'signed-out' || error.failure === 'key-changed' || error.failure === 'key-mismatch') {
          throw error;
        }
        const verdict = outboxVerdict(error.status);
        if (verdict === 'retry') {
          // The rest would fail the same way: the flush stops and the next sync tries again.
          repo.markOutboxAttempt(entry.id, error.message);
          return;
        }
        // `drop` is a `409`: the host holds a newer version and the snapshot brings it. `rejected` is
        // a `4xx` the host refuses for good — SP04 §4 pairs it with a `sync.rejected` event, so the
        // person sees which of their writes never landed. The status and the route are the whole
        // event: neither the body nor the answer of the host goes anywhere near a row (canonico §13).
        if (verdict === 'rejected') {
          repo.addEvent({
            personId: connection.host.personId,
            toolId: null,
            type: 'sync.rejected',
            url: null,
            result: String(error.status),
            detail: `${entry.method} ${entry.path}`,
          });
        }
        repo.deleteOutbox(entry.id);
      }
    }
  }

  // ---------------------------------------------------------------- event push (SP04 §5)

  /**
   * SP04 §5: every unsent event goes up, oldest first, in batches of at most `EVENTS_PER_BATCH`, until
   * none is left pending. The body is `host/routes/events.ts`'s shape exactly — `shared/host-api.ts`'s
   * `ClientEvent`, with `null` for the fields the event does not carry — and the client id is the
   * local event's own, which is what makes a retry a no-op on the host (`ON CONFLICT(id) DO NOTHING`).
   *
   * Only the ids the host acked are marked, so a partial ack leaves the rest pending for the next
   * round; a batch that acks nothing ends the push instead of asking for the same rows forever. A
   * failure — the host did not answer, answered `5xx`, or refused the batch — raises out of here and
   * the run reacts to it as a whole (SP04 §3): the events stay pending, with their client ids, and the
   * next run sends exactly the same ones.
   *
   * `url` travels as the row holds it (`origin + pathname`, canonico §13) — the host strips it too —
   * and nothing else of the event is added: the body has no field the route does not declare.
   */
  async function pushEvents(connection: HostConnection, at: string): Promise<void> {
    for (;;) {
      const pending = repo.unsentEvents(EVENTS_PER_BATCH);
      if (pending.length === 0) return;
      const events: ClientEvent[] = pending.map((e) => ({
        id: e.clientId,
        at: e.at,
        kind: e.type,
        toolId: e.toolId,
        url: e.url,
        result: e.result,
        detail: e.detail,
      }));
      const answer = await connection.request<EventsResponse>('POST', HOST_ROUTES.events, { events });
      // The host answers every id it now holds, in batch order; the set is what matters, so an id it
      // already had from an earlier batch is acked just the same.
      const acked = new Set(answer.acked);
      const confirmed = pending.filter((e) => acked.has(e.clientId)).map((e) => e.clientId);
      if (confirmed.length === 0) return;
      repo.markEventsSent(confirmed, at);
    }
  }

  // ---------------------------------------------------------------- failure

  async function failed(connection: HostConnection, record: HostRecord, error: unknown): Promise<HostState> {
    if (!(error instanceof HostError)) throw error;
    if (error.failure === 'signed-out') return signedOut(connection, record);
    if (error.failure === 'key-changed' || error.failure === 'key-mismatch') {
      // SP04 §1: nothing is replaced silently. The client's own message is what the screen shows,
      // and the loop stops: retrying cannot fix a key that has to be confirmed by a person.
      repo.saveHostError(error.message);
      stop();
      return publish();
    }
    // The sign-out marker is sticky until a sync succeeds; it is also the `304` guard of
    // `fetchSnapshot`, so a later failure of another kind must not overwrite it.
    if (record.lastError === SIGNED_OUT_ERROR) return publish();
    // Every other failure — the host was not reached, answered a `5xx`, refused the request, or sent
    // a body that did not verify or was older than the last accepted one — leaves the cache in use,
    // shows the failure and backs off (SP04 §3, §6).
    failures = Math.min(failures + 1, BACKOFF_MS.length);
    repo.saveHostError(error.message);
    return publish();
  }

  /**
   * SP04 §3, RF-39: the host refused the session. The bearer goes (it was revoked or expired), the
   * org half of the cache is dropped while the personal half stays, and the app is asked for a
   * sign-in — once per ended session, not once per retry.
   */
  async function signedOut(connection: HostConnection, record: HostRecord): Promise<HostState> {
    await connection.forgetToken();
    if (record.snapshot !== null && record.lastSyncAt !== null) {
      const cleared = clearOrgData(record.snapshot);
      if (cleared !== null) {
        repo.saveHostSnapshot({
          snapshot: cleared,
          version: record.version ?? '',
          issuedAt: record.issuedAt ?? '',
          syncedAt: record.lastSyncAt,
        });
      }
    }
    repo.saveHostError(SIGNED_OUT_ERROR);
    failures = 0;
    const published = publish();
    if (record.lastError !== SIGNED_OUT_ERROR) deps.onSignedOut();
    return published;
  }

  // ---------------------------------------------------------------- state

  /** SP05 §5's badge: no row is `none`, the sign-out marker is `signed-out`, another error is
   *  `stale` and a row with no error is `connected`. */
  function statusOf(record: HostRecord | null): HostState['status'] {
    if (record === null) return 'none';
    if (record.lastError === SIGNED_OUT_ERROR) return 'signed-out';
    return record.lastError === null ? 'connected' : 'stale';
  }

  function fingerprintOfRecord(record: HostRecord | null): string | null {
    if (record === null || fingerprint === null) return null;
    return fingerprint.kid === record.kid && fingerprint.publicKey === record.publicKey
      ? fingerprint.value
      : null;
  }

  async function rememberFingerprint(record: HostRecord): Promise<void> {
    if (fingerprint !== null && fingerprint.kid === record.kid && fingerprint.publicKey === record.publicKey) {
      return;
    }
    try {
      fingerprint = {
        kid: record.kid,
        publicKey: record.publicKey,
        value: await fingerprintOf(fromBase64url(record.publicKey)),
      };
    } catch {
      // A pinned key that is not 32 raw bytes is a row this run cannot read; SP04 §1's check belongs
      // to whoever pinned it. The state then shows no fingerprint.
      fingerprint = null;
    }
  }

  function state(): HostState {
    const record = repo.hostRecord();
    return {
      status: statusOf(record),
      guild: record === null ? null : record.guild,
      address: record === null ? null : record.address,
      fingerprint: fingerprintOfRecord(record),
      lastSyncAt: record === null ? null : record.lastSyncAt,
      lastError: record === null ? null : record.lastError,
      pendingWrites: repo.listOutbox().length,
    };
  }

  function publish(): HostState {
    const published = state();
    deps.onState(published);
    return published;
  }

  return { start, stop, syncNow, state, afterWrite };
}
