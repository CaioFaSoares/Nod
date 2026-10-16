# Block 1 review — fixes

One section per owner, written only by that owner. Scope: the findings of the independent Block 1
review, which each owner received in its own task (the reviewer's transcript is not readable by the
fixers). Contracts of this slice: `docs/specs/SP02-auth-and-keys.md` §3–§5, `docs/specs/SP03-host-api.md`
§1–§2. Rules: `AGENTS.md`, `host/context.md` ("the same timing for unknown and known emails"), English
only (RNF-08). Nothing here carries a secret: no `authKey`, code, token or salt enters a file or a log.

---

## FixHostActivateTiming — F4: the activity of `POST /v1/auth/activate` as an email-existence oracle (MEDIUM)

### Cause

`host/routes/auth.ts` answered `activate`'s two early failures before any argon2 work:

```ts
const codeHash = await storedCodeHash(ctx.body.code, 'access');
const person = codeHash === null ? null : repo.personByEmail(email);
if (codeHash === null || person === null) return failure(auth, email, INVALID_CODE);  // ← returns here
const authHash = await auth.hashAuthKey(ctx.body.authKey);                            // ← only reached later
```

A known email with a wrong code reached `hashAuthKey` (and the `redeemCode` null branch paid it too),
an unknown email and a code the normalizer refuses did not. One `invalid code`, one status, two
different costs — the clock told apart the branch the body hides, which is exactly the oracle
`host/auth.ts`'s dummy verify already closes for `login` (SP02 §4). `setup` had the same shape for a
malformed code: `codeHash === null` answered before `hashAuthKey`, a well-formed code paid it.

### Fix

`host/routes/auth.ts` only. The `authKey` is hashed up front, before the branch that can answer, in
both `activate` and `setup`; the pre-computed `authHash` is then the one stored. Every `invalid code`
branch now pays exactly one argon2id hash; the success path is unchanged (same hash, same transaction,
same bytes) and the file header records the rule. No message, status, header, schema, route or
persistence format changed — the byte-identical bodies are asserted by the pre-existing test
"a code of another email, and an email nobody holds, are the same single failure", which still passes.

### What this deliberately leaves alone

The 429 branch (`allowEmail` false) still answers before any hashing, in `activate`, `setup` and
`login` alike. The budget is counted per email whether or not the person exists (`failure` calls
`failEmail` for both), so it is existence-independent and reveals nothing; and refusing cheaply is the
point of SP02 §5's budget. `login` has had this exact shape all along, and F4 named only the
`invalid code` branches.

### Regression test (`execucao`)

`host/auth.test.ts`, new tests, run against the code **before** the fix (cwd `host/`):

```
$ bun test auth.test.ts -t 'argon2id hash'
error: expect(received).toBe(expected)
Expected: 1
Received: 0
      at <anonymous> (/Users/caio/_Nexus/valus/_Workspace/_work/_Copland/Bond/host/auth.test.ts:433:48)
(fail) POST /v1/auth/setup > a malformed code and a real redemption pay one argon2id hash each [110.91ms]
error: expect(received).toEqual(expected)
  [
-   1,
-   1,
+   0,
+   0,
    1,
      at <anonymous> (/Users/caio/_Nexus/valus/_Workspace/_work/_Copland/Bond/host/auth.test.ts:620:60)
(fail) POST /v1/auth/activate > an unknown email, a malformed code and a wrong code each pay one argon2id hash [147.13ms]

 0 pass
 28 filtered out
 2 fail
```

After the fix, same command:

```
$ bun test auth.test.ts -t 'argon2id hash'
 2 pass
 28 filtered out
 0 fail
 15 expect() calls
```

And the whole file, after the fix:

```
$ bun test auth.test.ts
 30 pass
 0 fail
 302 expect() calls
Ran 30 tests across 1 file. [5.53s]
```

The tests are deterministic — no timing bound. `host/auth.test.ts` builds the real `authRoutes` over
the booted repo with a service that counts `hashAuthKey` and delegates to the real one (`countHashes`);
the database, the repo, the routes and the argon2id implementation stay real, only the number of hash
calls is observed. The activate test asserts status `401`, byte-identical bodies and exactly one hash
for an unknown email, a malformed code and a wrong code of an existing person, and one hash for the
success path (which stores the `$argon2id$` hash, checked); the setup test asserts the same pair for a
malformed code and a real redemption.

### Files touched

- `host/routes/auth.ts` — `activate` and `setup` hash the `authKey` before their failure branch; the
  header documents the equal-cost rule.
- `host/auth.test.ts` — the `countHashes` helper and the two regression tests above.
- `docs/handovers/review-fixes.md` — this section.

Not touched, and not run: the project gates and the smokes (another owner's job after all fixes land);
`backend/main.ts`, `backend/session.ts` and every other owner's file. `host/auth.ts` was not changed —
F4 needed no change there, the fix is entirely in the route's branch order.

---

## FixSyncRaces — F5, F6, F8, F9 (the sync loop and the host client)

### F5 (MEDIUM) — `syncNow()` answered with a run that had read the row before the write

**Cause.** `syncNow()` returned the promise of the run in flight (`backend/sync.ts` ~153), so a
timer-started run that had read the snapshot before an admin write answered with the catalog of a
moment ago; and the in-flight run's tail `arm(nextDelay())` disarmed whatever was armed, turning the
write's own 1 s `afterWrite` timer into a 5 min one.

**Fix.** `backend/sync.ts`: while a run is in flight, `syncNow()` chains exactly one follow-up run
behind it (`chain` → `beginRun`) and every caller that arrives before that run starts waits for the
same promise; `arm()` now keeps the earlier deadline, so the 5 min re-arm cannot push a write's 1 s
timer back. The `Sync` interface is unchanged (five methods), so `backend/main.ts` is untouched.

**Test.** `test/sync.test.ts`, `describe('triggers')`: "a syncNow() during an in-flight run chains one
more run, which sees what changed" (the follow-up's body — `version: 'v2'` — is what lands, and both
callers receive the same promise) and "a write asked for during an in-flight run keeps its one-second
deadline". The harness gained `settle()`, and `fire()` waits on it: F5 changed what `syncNow()` means
while a run is going, so "wait for the run that is going" needed its own way in (the seven
`start(); await h.sync.syncNow()` sites of the file now use it; with the fix reverted they behave
exactly as before, which is what makes that rewrite neutral).

Before the fix (two hunks reverted by hand — `if (current !== null) return current;` and the `timerAt`
guard):

```
$ bun test test/sync.test.ts -t 'in-flight'
Expected: 2   Received: 1        (the overlapping caller got the in-flight run: served = 1)
Expected: 1000  Received: 300000 (the write's 1 s timer was cancelled by the 5 min re-arm)
 1 pass
 28 filtered out
 2 fail
```

After:

```
$ bun test test/sync.test.ts -t 'in-flight'
 3 pass
 30 filtered out
 0 fail
 19 expect() calls
```

(The third match is the F8 test below; it does not depend on the chaining and passed both times.)

### F6 (MEDIUM) — a failed event push ended the run before the snapshot

**Cause.** `runOnce` ran `flushOutbox`, `pushEvents` and `fetchSnapshot` inside one `try`, so any
non-401 failure of the push (`400`/`413`/`5xx`/offline) threw out of the run and `GET /v1/state` was
never made: the person stopped receiving org changes while their events were stuck.

**Fix.** `backend/sync.ts`: the push has its own `try`. A `401` and the key failures keep today's
paths (delegated to `failed`, unchanged); any other failure is remembered, the run goes on to the
snapshot, and at the end the remembered failure is recorded — the state is `stale` with that error
and the backoff applies, while the fresh snapshot stays. In `pushEvents`, a batch refused with a 4xx
other than 401/429 (the host client's `refused`) is left pending and noted once as a `sync.rejected`
event — `result` the status, `detail` `POST /v1/events`, no part of the events themselves
(canonico §13). SP04 §5 has no verdict for such a batch; the note is once per batch (its first client
id is remembered for the session), not once per retry.

**Test.** Three in `describe('event push')`: "a batch the host refuses with a 400 still brings the
snapshot, noted once" (also asserts the second run does not note it again), "a batch the host never
received keeps the events pending and still brings the snapshot", and "a 401 on the push is still the
sign-out path, not a failure to retry" (the boundary F6 must not move). The pre-existing test "a
failure keeps every event pending with its client id…" changed its expectation (`h.calls.snapshot`
`0` → `1`): that `0` was the finding.

Before the fix (the `runOnce` body reverted to the single `try`, and separately the `sync.rejected`
note removed):

```
$ bun test test/sync.test.ts -t 'refuses with a 400'
Expected: 1   Received: 0        (h.calls.snapshot — the run ended at the push)
(fail) event push > a batch the host refuses with a 400 still brings the snapshot, noted once

$ bun test test/sync.test.ts -t 'never received'
Expected: 1   Received: 0        (the same, for a `5xx`)

$ bun test test/sync.test.ts -t 'refuses with a 400'   (only the note removed)
@@ -2,7 +2,2 @@      (no `sync.rejected` row at all)
```

After:

```
$ bun test test/sync.test.ts -t 'refuses with a 400'
 1 pass
 32 filtered out
 0 fail
 7 expect() calls
```

### F8 (LOW) — a run wrote into a host added in the middle of it

**Cause.** `saveHostSnapshot`/`saveHostError` update `WHERE id = 1` with no identity check: a run
started before `host.remove` and finishing after a new `saveHost` wrote the old host's verified body,
its failure message or its sign-out marker into the new row — and `signedOut()`'s `forgetToken()`
could delete the new sign-in's token, which is the same keychain item when the same host is added
again.

**Fix.** `backend/sync.ts`: `stillTheHost(record)` — the identity of the row the run read, `kid` +
`addedAt` — checked before every host-row write: both `saveHostSnapshot` call sites, both
`saveHostError` call sites, and `signedOut()` before `forgetToken()` and again before its two writes.
`backend/repo.ts` and `test/repo.test.ts` were **not** touched: this is the finding's second option,
it needs no signature change, and `sync.ts` is the only writer of those columns (grep over
`backend/`, `test/`, `host/`).

**Test.** Four in `describe('a run that outlives its host (F8)')`: remove+re-add during a run leaves
the new row with no snapshot/version/issuedAt/lastSyncAt/lastError; a failure of a run whose host was
replaced does not mark the new row; a 401 that outlives its host neither forgets the token nor signs
the new row out; and a host replaced while the bearer is being forgotten is not written either (the
second guard).

Before the fix (the guard neutralised to "the row exists"):

```
$ bun test test/sync.test.ts -t 'outlives'
expect(record?.snapshot).toBeNull()          Received: "{\"api\":1,\"version\":\"v1\",…"   (the old body in the new row)
expect(h.repo.hostRecord()?.lastError).toBeNull()  Received: "could not reach the host"
expect(h.keychain.get(TOKEN_KEY)).toBe('the-token-of-the-new-sign-in')  Received: undefined (the new sign-in forgotten)
 0 pass
 28 filtered out
 3 fail
```

(the fourth test fails the same way for the guard after `forgetToken` — observed separately with only
that check neutralised: `Received: "signed out — sign in again"`).

After:

```
$ bun test test/sync.test.ts -t 'outlives'
 4 pass
 29 filtered out
 0 fail
 17 expect() calls
```

### F9 (LOW) — a redirect would carry the bearer to another origin

**Cause.** `send()` built `init` as `{ method, headers }`; the runtime's `fetch` follows a `3xx` by
default, so a host answering `302 Location: …` had the `Authorization: Bearer …` of the pinned host
replayed at that origin — and the backend's fetch has no CORS limit in the way (`docs/tinyjs.md` §6).

**Fix.** `backend/host-client.ts`: `redirect: 'error'` on every host call (`send()`), which makes
`fetch` reject and the existing mapping turn it into the `offline` failure of SP04 §3. The host is not
asked twice, and no header reaches the other origin.

**Test.** `test/host-client.test.ts`, "the bearer never reaches the origin the host points at": the
test host answers `/v1/redirect` with a `302` to a second loopback server that records every
`Authorization` it is asked for (a `redirect()` setter was added to the test host for it).

Before:

```
$ bun test test/host-client.test.ts -t 'never reaches the origin'
error: expected the call to be refused   (the redirect was followed: the call resolved)
 1 fail
```

After:

```
$ bun test test/host-client.test.ts -t 'never reaches the origin'
 1 pass
 24 filtered out
 0 fail
 3 expect() calls
```

### Files touched

- `backend/sync.ts` — F5 (the follow-up run and the earlier-deadline `arm`), F6 (the push failure no
  longer ends the run; one `sync.rejected` per refused batch), F8 (`stillTheHost` before every
  host-row write).
- `test/sync.test.ts` — the harness's `settle()`/`fire()`, the seven `start(); await syncNow()` sites
  moved to `settle()`, the one F6-affected expectation, and nine new tests (2 F5, 3 F6, 4 F8).
- `backend/host-client.ts` — F9.
- `test/host-client.test.ts` — the `/v1/redirect` route, the `redirect()` setter and the F9 test.
- `docs/handovers/review-fixes.md` — this section.

### Not touched, not run

- `backend/repo.ts` and `test/repo.test.ts`: no change was needed (F8's guard lives in the run, and
  no other slice writes those two columns).
- `backend/main.ts` and `backend/session.ts`: another owner's files.
- The project gates and the two smokes: not run here (main's verification after every fix lands).

### Commands (`execucao`, 2026-10-16)

```
$ bun test test/sync.test.ts test/repo.test.ts test/host-client.test.ts
 111 pass
 0 fail
 552 expect() calls
Ran 111 tests across 3 files. [102.00ms]

$ bun test test/host-admin.test.ts     # the other unit test that builds a sync: blast radius of F5
 8 pass
 0 fail
 81 expect() calls
```

### For the coordinator

- One decision worth a reading: SP04 §5 has no verdict for a batch refused for good. Following the
  finding, the events stay pending (they are the audit) and the refusal is noted once per batch per
  session; the batch therefore stays at the head of the queue and later events wait behind it until
  the host takes it. If the intended reading is "drop the refused batch", that is a spec decision
  (and a change to the append-only event table), not a fix.
- The event push failing now leaves the state `stale` and applies the backoff even though the snapshot
  succeeded. That is the finding's "recorded (lastError)"; the org data itself is fresh.
- `main.ts`'s `host.syncNow` and Settings' button now wait for a run of their own when a run is in
  flight (one extra run per overlap, coalesced). The smoke drives `host.syncNow` sequentially, so its
  call counts do not change; the smokes were not run here.

