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


---

## FixJoinFlow — F1, F2, F3, F7 (the join, the adoption, the snapshot's admin flag)

Contracts of this slice: `docs/specs/SP05-bond-connected.md` §2–§4, `docs/specs/SP02-auth-and-keys.md`
§1–§7, `docs/specs/SP04-sync.md` §1–§3. Rules: `AGENTS.md`, `backend/context.md`, `src/context.md`.
Nothing here carries a secret: no code, password, `authKey`, token or credential value enters a file,
a log, an event or `store.json`.

### F1 (HIGH) — the join that collides with a local account spent the code and left nothing

**Cause.** `host.activate` redeemed the code on the host **first** and only then called
`adoptConnectedAccount`, which refused the email a local person already held
(`email already registered`). The single-use code — the setup code included — was spent, and no
retry could fix it. A *revoked* local row with that email was worse: `personByEmail` hides it, so the
refusal never fired and the host person's insert died on the unique email column
(`UNIQUE constraint failed: person.email`). `host.signIn` had the same shape.

**Fix.** The decision moved before the first host call, and adopting became a real operation:

- `backend/session.ts`, `joinGate()` (new): the local half of a join, in the one order the rules
  need. It reads the email with `Repo.personByEmailAnyState` (revoked included, new read), decides,
  and runs the caller's host call only after that. An email a live local account of *another* person
  holds is refused (`this email belongs to another account of this Bond — unlock it, then join`); with
  the session unlocked as that person and `adoptLocal` absent it answers the choice
  (`{ kind: 'choose', person }`) — **no request, the code is whole**; with `adoptLocal: true` it goes
  out and marks the account to adopt. A revoked row can never be unlocked, so any unlocked session
  adopts it (its data is otherwise unreachable).
- `backend/repo.ts`, `adoptPersonId()` (new): one transaction. The `person` row's id, its
  `person_role` rows, its `vault_item` rows (and their `keychain_key`, built by the caller's
  `keychainKeyOf`) and every `event` that named it move to the host person id. The children move
  before the parent's key and the transaction defers the foreign keys to the commit: with them on
  (the runtime's `openSqlite`) SQLite refuses the intermediate state — observed below. A target id
  another `person` row already holds is refused here, with a sentence, before anything moves.
- `backend/session.ts`, `adoptConnectedAccount({ …, adoptLocalId })`: after the re-key it moves the
  keychain items (`bond.cred.<old>.<tool>` → `bond.cred.<new>.<tool>`: read, write, delete; a
  keychain that refuses reports the credential and leaves the old item) and the biometric marker
  (`bond.bio.<person>`, whose value is the person id today), then writes the V2 verifier over the host
  salt — the existing path. The **roles of the adopted account survive**; the host's `admin` flag is
  reconciled on top of them.
- `shared/types.ts`: `JoinResult` (`{ kind: 'session'; session }` | `{ kind: 'local-account';
  personId; email; name }`), and `host.activate`/`host.signIn` take `adoptLocal?: boolean` and answer
  it. Chosen over a `host.checkJoin` RPC: one round trip, and the check cannot disagree with the join
  it decides.
- `backend/main.ts`: both handlers run `s.joinGate` **before** the discovery, map `choose` to
  `local-account`, and pass `adoptLocalId`. An adopted account keeps its own name until the snapshot's
  `me.name` lands (F2).
- `src/settings.ts`: the join flow asks the choice — a `<select>` in the account card ("Use the guild
  account" / "Keep using the local account", with the owner's wording) and the explanation; the next
  submit carries `adoptLocal: true`. Keeping the local account cancels the join (nothing is sent). The
  email field drops the choice again, since another email is another question.

### F2 (HIGH) — `me.admin`/`me.name` never reached the local person

**Cause.** `person.admin` was set once, at the join (`admin: setup`, or the local row's flag at
sign-in), and the snapshot's `me` was only ever read for the catalog. An admin created by an access
code never got the admin screens; a demoted admin kept them.

**Fix.** `Repo.saveConnectedIdentity(personId, { name, admin })` (new): the local row's name (a blank
one ignored) and its local admin role follow the snapshot, keeping every other local role.
`Session.reconcileConnectedIdentity(me)` applies it to the unlocked person and reloads it
(`refresh()`). `backend/main.ts` runs it on **every** state the sync publishes (`onState`) and pushes
the session to the page when something moved.

### F3 (MEDIUM) — the join from the lock screen, and the sign-in without the backoff

**Cause.** `host.activate`/`host.signIn` are in `WITHOUT_SESSION`, so anyone at the lock screen could
connect a Bond that already had an account to a host of their choice; `signIn` also skipped the unlock
backoff, and nothing tied it to the pinned host beyond the key check.

**Fix.** `joinGate` refuses both handlers when this Bond already has an account and no `host` row is
pinned (`unlock this Bond first, then join the guild`), the host untouched. With a host row a locked
sign-in stays allowed (that is the signed-out case) but only against the pinned host — `host.signIn`
refuses another address (`this Bond is connected to another host — remove it first`) and discovers at
`row.address` with the pinned key — and it pays RF-23's backoff: `joinGate({ signIn: true })` reads
`waitMs()` before and counts a `401` as a failed attempt, the same `meta` counter `session.unlock`
uses. The first run (no account at all) joins with no session, unchanged.

### F7 (LOW-MEDIUM) — a wrong code read as "signed out"

**Cause.** SP02 §5 answers `401` for a wrong code or password, and `backend/host-client.ts` maps every
`401` to `HostError('signed-out')` — a sentence about a revoked session, shown by the join screen.

**Fix.** `joinGate` turns a `401` from the join's own auth calls into one Bond sentence,
`invalid code or password`, and passes everything else through whole (key mismatch, offline, 5xx).

### Regression tests (`execucao`)

`test/session.test.ts` (15 new: the gate's five decisions, the backoff, the adoption with its roles,
vault, keychain, biometric, revoked row, taken target, keychain refusal, and the reconcile),
`test/repo.test.ts` (4 new: `personByEmailAnyState`, `adoptPersonId` twice, `saveConnectedIdentity`),
`test/host-admin.test.ts` (6 new, against the **real** host: the choice with the code still
redeemable, the adoption with the credential, the locked refusals, the first run, the wrong code, and
F2 through a real sync).

```
$ bun test test/session.test.ts test/repo.test.ts test/host-admin.test.ts
 127 pass
 0 fail
 795 expect() calls
Ran 127 tests across 3 files. [2.52s]
```

Before the fix, with each hunk neutralised by hand and restored after the run:

```
$ bun test test/session.test.ts -t 'nothing adopts is still refused'      # holder read: personByEmail
Expected: "email already registered"
Received: "UNIQUE constraint failed: person.email"                        # F1's raw SQLite failure

$ bun test test/session.test.ts -t 'answers the choice'                   # the choice branch removed
Expected: { "kind": "choose", "person": … }
Received: { "kind": "join", "local": { "admin": true, … } }               # the host was asked

$ bun test test/host-admin.test.ts -t 'the choice is answered before any host call'
  + "requests": 3                                                         # F1: the code was spent

$ bun test test/session.test.ts -t 'refuses a locked join'                # F3's guard removed
Expected: "unlock this Bond first, then join the guild"
Received: "did not throw"

$ bun test test/host-admin.test.ts -t 'refuses the join, and no request leaves'
Expected: "unlock this Bond first, then join the guild"
Received: "did not throw"

$ bun test test/session.test.ts -t 'a 401 of the host is one sentence'    # the 401 mapping removed
Expected: "invalid code or password"   Received: "signed out"

$ bun test test/host-admin.test.ts -t 'wrong code is the join'            # the same, real host
Expected: "invalid code or password"   Received: "signed out"

$ bun test test/session.test.ts -t 'follow the snapshot'                  # reconcile made a no-op
Expected: true   Received: false

$ bun test test/host-admin.test.ts -t 'promotes the person'               # the same, real sync
(- "admin": true  + "admin": false)                                       # the flag never followed

$ bun test test/repo.test.ts -t 'adoptPersonId moves'                     # defer_foreign_keys removed
SQLiteError: FOREIGN KEY constraint failed
(fail) … adoptPersonId moves the row, its roles, its vault rows and its events in one go
```

After each restore, the same commands pass. The `defer_foreign_keys` run is what says the pragma is
load-bearing: `test/helpers/sqlite-bun.ts` turns `PRAGMA foreign_keys = ON`, exactly like the runtime.

### Connected smoke (`execucao`)

`test/smoke/connected.html` gained three steps in `admin-publish` and `test/smoke/connected.ts` the
row check: the admin Bond creates the local account with the guild's email and saves a credential
**before** the join; the setup-code join then answers the choice (`nothing sent`), the same code
redeems with `adoptLocal: true`, and the saved credential reads back under the guild person id with
its keychain key renamed.

```
$ bun test/smoke/connected.ts --force
ok 2.1b session.createAccount (the guild email, F1)     local account … exists and is unlocked
ok 2.1c vault.save (before the join, F1)                credential saved for tool-a before the join
ok 2.4 host.activate (the choice, F1)                   the join asked which account wins, nothing sent
ok 2.4b host.activate (adoptLocal, F1)                  activated …, adopting the local account; … admin
ok 2.4c vault.list/reveal (the credential came along)   the credential reads back under the guild person id
…
the admin Bond's vault row after the adopt (F1):
  people: 1 (expected 1: the adopted account)
  vault row of tool-a: person 4969232c-…, key bond.cred.4969232c-….tool-a
connected smoke ok: 4 phases, 44 steps, admin-publish:17 person-join:16 admin-revoke:7 person-signed-out:4
```

The runner compares that row against the host's own `people` row for the admin email, so the rename is
the host's identity and this machine's row agreeing. The smoke also proves the pragma on the real
surface: the adopt runs inside `tjs:sqlite` (`tinyjs dev`), not only under `bun:sqlite`.

### Commands run

1. The three test files of the slice and the two smokes, above. `bun test test/smoke/connected.ts
   --force` only (never `run.ts`).
2. Scratch compiles of the files this slice changed — not the project gate:

```
$ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext \
    --moduleResolution bundler --lib es2022,dom --skipLibCheck \
    shared/types.ts backend/repo.ts backend/session.ts                                    # exit=0
$ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext \
    --moduleResolution bundler --lib es2022,dom --skipLibCheck \
    backend/tjs.d.ts backend/tiny.d.ts backend/main.ts                                    # exit=0
$ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUnusedLocals \
    --noUnusedParameters --verbatimModuleSyntax --erasableSyntaxOnly --target es2022 \
    --module esnext --moduleResolution bundler --lib ES2023,DOM --skipLibCheck \
    src/tiny.d.ts src/api.ts src/app.ts src/settings.ts                                   # exit=0
```

3. Not run: the project gates (`bun run typecheck`, `bun test test/`, `bun run app:build`), the formatter
   and `test/smoke/run.ts`. Nothing here is called verified on the real surface beyond what the smoke
   above observed.

### Files touched

- `backend/session.ts` — `joinGate`, `JoinGate`, `reconcileConnectedIdentity`, `adoptConnectedAccount`'s
  `adoptLocalId` (re-key, keychain items, biometric marker, roles), the `isNew` fix for an adopted row.
- `backend/repo.ts` — `personByEmailAnyState`, `adoptPersonId`, `saveConnectedIdentity` and their
  interface entries.
- `backend/main.ts` — both join handlers through the gate, `localAccountChoice`, the sync's `onState`
  reconcile.
- `shared/types.ts` — `JoinResult`; the two method signatures.
- `src/settings.ts` — the join choice (the select, the cancel, `adoptLocal` in the next submit).
- `test/session.test.ts`, `test/repo.test.ts`, `test/host-admin.test.ts` — the tests above.
- `test/smoke/connected.html`, `test/smoke/connected.ts` — the adopt steps and the row check.
- `docs/handovers/review-fixes.md` — this section.

`src/app.ts` and `src/style.css` were **not** touched: the choice lives inside `mountJoinFlow`, which
both entry points already mount, and the select reuses `.input`.

### Decisions, and what another owner must do

1. **`defer_foreign_keys` in the re-key.** The alternative orders all end in an intermediate state
   SQLite refuses with the foreign keys on; the pragma is scoped to the one transaction and
   `openSqlite`'s setting is untouched. Proven on the runtime by the smoke (above).
2. **The host decides the admin flag of an adopted account.** The local roles survive, and the `admin`
   role follows the host's answer — the snapshot is the last word anyway (F2). If the intended reading
   is "the local admin role is never dropped by a join", that is one line in `withHostAdmin`.
3. **A revoked local row of the join email is adoptable with any unlocked session** (it can never be
   unlocked itself). The alternative — refuse — would leave that email permanently unjoinable, since
   nothing in the app removes a revoked row.
4. **F7's sentence lives in `joinGate`**, not in the two handlers: it is the join's own refusal, and
   `backend/session.ts` is where the whole local half of a join is testable. It imports `HostError`
   from `backend/host-client.ts` for it.
5. **`docs/arquitetura.md` §4–§5** is behind: `Session` has `joinGate`/`reconcileConnectedIdentity` and
   `adoptConnectedAccount` takes `adoptLocalId`; `Repo` has three more methods; `ApiContract`'s two
   joins answer `JoinResult` instead of `SessionState`. Not a file of this slice.
6. **`docs/specs/SP05-bond-connected.md` §3–§4**: the table still declares `SessionState` as the answer
   of `host.activate`/`host.signIn`, and §4 does not describe the choice. The spec is the coordinator's.
7. **The unlock screen's "Join a guild" button** now mostly refuses: with an account, the join belongs
   to the unlocked Bond (Settings → Hosts, where the same component asks the choice). The button is
   still right for a signed-out Bond with a host row, which is exactly the case the lock screen cannot
   tell apart from the rest (`host.state` needs a session). Hiding it for the other cases needs that
   fact on the session state — a contract decision, not this slice's.
