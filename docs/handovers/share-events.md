# Slice — the `share.*` events of E02 §6 (issue #31 acceptance: "events never carry content")

Owner: the events slice of E02's block 2, under the `em-curso` issue **#31 (K3)**. E02 §6 lists four
kinds (`docs/epics/E02-credential-sharing.md` §6: `share.sent`, `share.accepted`, `share.declined`,
`share.expired` — never with content) and `docs/canonico.md` §13 is the rule they obey. Before this
slice no builder existed: `docs/handovers/k10-docs.md` finding 1 and `docs/handovers/k3-host-shares.md`
("For other owners": the `share.*` family "has to be raised on the Nod side"; the host "writes no
event of its own"). This slice closes that gap.

Contracts followed: `docs/canonico.md` §13 (one event per relevant action; when, who, tool, address,
result, short detail; **no credential value is ever an event parameter**), RF-44 (no credential
content for the host), SP04 §5 (the local row is pushed to the host by the Sync loop), SP01 §2 (the
`events` row shape and its `session_id NOT NULL REFERENCES sessions`). Not run: the repo-wide
`bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter — the coordinator runs those
at the end of the phase. What ran: this slice's two test files plus the four whose schema assertions
move with `EventType` (below).

## Files touched

| File | What changed |
| --- | --- |
| `shared/types.ts` | `EventType` gains `share.sent`, `share.accepted`, `share.declined`, `share.expired`, with the doc comment of the family (E02 §6, canonico §13, RF-44). |
| `host/routes/events.ts` | `KIND_SET` (the wire schema keyed by `EventType`, the compiler guard against drift) gains the four kinds. |
| `backend/shares.ts` | One `record()` helper that writes through `deps.repo.addEvent` (the local, pushed path), and its call sites in `send` (one `share.sent` per recipient), `sealUpdate` (kind `update`), `sealAssigned` (kind `assign`), `accept` (`share.accepted`), `decline` (`share.declined`) and `declineInvalid` (`share.declined` with `result` = the refusal). |
| `host/repo.ts` | `purgeExpiredShares` now claims each expired share row, purges its ciphertext and writes one `share.expired` event for the recipient, all in one transaction; new `sessionForEvent`, which resolves the session the host-written row is attributed to. The `Repo` interface doc of `purgeExpiredShares` follows. |
| `host/snapshot.ts` | One comment at the purge call site, the only line touched: the read path now also records the expiry events. |
| `test/shares.test.ts` | Three new tests: one `share.sent` per recipient, content-free; the update fan-out's `share.sent` with `kind=update`; and the accept / decline / invalid-decline triad, `result` = `invalid share` on the last. |
| `host/shares.test.ts` | The expiry test now asserts the single `share.expired` row (recipient, tool, `detail` = share id, `url`/`result` null) and that it carries neither username, secret nor sealed body; new `eventRows` helper. |
| `docs/epics/E02-credential-sharing.md` | One line under §6's event bullet, pointing here. |
| `docs/canonico.md` | One line under §13, pointing here. |
| `docs/handovers/share-events.md` | This file. |

**Not edited on purpose**: `backend/main.ts` (the wiring already carries `repo` into `createShares`;
nothing new had to be injected, so the `authenticate` hot file was left alone), `shared/host-api.ts`
(no wire shape changed), and the `host/migrations.ts` schema (no column was needed).

## The acceptance and how it was met

**"Send/accept/decline produce `share.*` events locally that reach the host by the normal push."**
`backend/shares.ts` records through `deps.repo.addEvent`, the same repository call every other local
event uses (`backend/session.ts`, `backend/main.ts`). The rows land in `event`, and
`repo.unsentEvents` / `backend/sync.ts` push them to `POST /v1/events` exactly like the rest — no new
transport. The four kinds are accepted by the host's wire schema (`KIND_SET`).

- `share.sent` — one per recipient, after the host takes the copies. `person_id` is the actor
  (sender/owner/admin); `tool_id` the tool; `detail` = `<recipient id> scope=<role|org> kind=<send|assign|update>`.
  The task's "include assign/update kinds as `share.sent`" is exact: an assignment fan-out
  (`sealAssigned`) and a rotation fan-out (`sealUpdate`) each raise `share.sent` with the kind in the
  detail. The scope is the one that travelled (`org` or `role`), never a credential value.
- `share.accepted` — on the accept that landed on the host and in the vault; `person_id` the
  recipient, `tool_id` the share's tool, `detail` the share id. An `update` applied on sync goes
  through the same `accept` and is recorded the same way (E02 §6 has no separate `update` kind).
- `share.declined` — the recipient's own decline (`decline`) with `detail` the share id, and every
  validation refusal (`declineInvalid`) with `result` = `invalid share` — the one place that reason
  is carried, per the task's "with result `invalid share` when declined by validation".
- `share.expired` — written by the host on the expiry purge (below).

**"Expiry is recorded."** `purgeExpiredShares` (called from `snapshotSource` on every state read and
from the accept/decline routes, K3's rule) now claims the expired rows, purges the ciphertext and
inserts one `share.expired` per purged share in the same `runInTransaction`: `person_id` = `to_id`,
`tool_id`, `detail` = the share id, `url` and `result` null. A share is claimed once, so a repeated
purge cannot double the event.

**"No event carries content."** Every detail is an id plus scope/kind; the two tests serialize the
whole event set (`test/shares.test.ts`) or the host's `events` rows (`host/shares.test.ts`) and assert
the username, the secret and the sealed body are absent. This is RF-44/canonico §13's rule made
observable.

## The session decision (`share.expired` is the one host-written event)

`events.session_id` is `NOT NULL REFERENCES sessions`, and the purge runs off a read rather than off
the recipient's own request, so the host has no caller session in hand. The smallest sound option:

- **the row is attributed to the recipient's own session** — `sessionForEvent` returns their newest
  live session, else (since `sessions` rows are never deleted) the newest they ever had. The event is
  the host's, the instant is the purge's, and the session is the recipient's latest device.
- **the residual case cannot arise for a real share, so no snapshot field was added.** A share
  recipient always has a `sessions` row: `host/repo.ts`'s `createShares` refuses a keyless recipient
  (`recipient has no keys`), and keys are only ever published from an authenticated session
  (`PUT /v1/keys` sits behind `personAuth`), so anyone who could receive a share had a session. If
  `sessionForEvent` ever returned `null`, the share is still purged (SP06 §4's security rule) and no
  event is written — that is the asymmetry the task asked to report, and it is reported here rather
  than papered over with a signed-snapshot field that could only ever be empty.
- **Deliberate departure from K3's finding.** `docs/handovers/k3-host-shares.md` recorded "the host
  writes no event of its own". `share.expired` is now the single exception, and the only way to keep
  "expiry is recorded" true without inventing a transport for an event no Nod is present to raise.
  The doc lines in E02 §6 and canonico §13 point here. The host-generated `id` is a fresh uuid never
  offered by a Nod, so it cannot collide with the client-id idempotency of `POST /v1/events`.

## Commands run and observed results

```
$ bun test test/shares.test.ts host/shares.test.ts host/events.test.ts test/sync.test.ts host/repo.test.ts
128 pass
0 fail
1290 expect() calls
Ran 128 tests across 5 files. [9.35s]
```

`test/shares.test.ts` 31 pass (three new), `host/shares.test.ts` 20 pass (the expiry test extended),
`host/events.test.ts` 10 pass (the kind-schema test reads `EventType` from source; the four new kinds
are keyed in `KIND_SET`, which the compiler checks against the union), `test/sync.test.ts` and
`host/repo.test.ts` unchanged and green.

## Left out, with the reason

- **No `share.*` kind beyond E02 §6's four.** No `share.updated` — an applied update is a
  `share.accepted` of an `update` share, and the epic lists none.
- **No snapshot/inbox field for expiry** — reasoned above.
- **`host/events.test.ts`'s `eventKinds()` parser** reads `'([a-z_]+)'`, so it never matched
  `'sync.rejected'` and does not match the dotted `share.*` names either; the compiler's
  `Record<EventType, true>` on `KIND_SET` is the guard that does. Fixing the parser is outside this
  slice's files.
