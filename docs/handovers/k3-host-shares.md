# Slice K3 — Host side of E02: keys, shares, holders, assignments, rotation

Owner: the **host** slice of E02's block 2 (the Nod side is K2/K4/K5/K6's, `backend/` and `src/`).
Authorized by the coordinator's assignment in this session, under the `em-curso` issue **#31 (K3)**,
whose host parts also carry **#29 (K1)**'s `PUT /v1/keys`, **#34 (K6)**'s scope enforcement,
**#35 (K7)**'s holders list, **#36 (K8)**'s assignments and missing list, and **#37 (K9)**'s
`rotationPending`. The issue texts are in `/tmp/nod/issue-{29,31,34,35,36,37}.md`; the owner's epic is
`docs/epics/E02-credential-sharing.md`.

Contracts followed: `docs/specs/SP01-host-data-model.md` §3 (the four block 2 tables, column for
column) and §4 (a migration is never edited); `docs/specs/SP03-host-api.md` §1 (the status table, the
`{ error }` shape with a static message, the auth levels, guards mounted before routes) and §3 (every
block 2 route); `docs/specs/SP04-sync.md` §2 (the four block 2 `Snapshot` fields and the rule that
what is signed is the whole body); `docs/specs/SP06-credential-sharing.md` §2–§5 (the key pairs, the
sealed format the host never reads, the flows, the scope table); `host/context.md`, `AGENTS.md`,
`shared/context.md`.

Not run: the repo-wide `bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter —
the coordinator runs those once at the end of the phase. What ran: the acceptance's own command for
this folder (`bun test host/`), this slice's test file, the two files whose schema assertions move
with migration 2, and one scratch `tsc` probe of this slice's files (all disclosed below).

## Files touched

| File | What changed |
| --- | --- |
| `host/migrations.ts` | **Migration 2**, appended (migration 1 untouched): `person_keys`, `shares` (with the partial index `shares_to_open`), `credential_holders` and `assignments`, exactly the tables of SP01 §3, comments included. |
| `host/repo.ts` | The block 2 section: `SHARE_TTL_MS` (14 days), `ShareScope`, `ShareKind`, `PersonKeys`, `ShareRecord`, `HolderRecord`, `MissingCopyRecord`, `ShareItemInput`, `ShareInput`; the `SHARE_COLUMNS`/`HOLDER_COLUMNS` row shapes; and thirteen `Repo` members in one new section of the interface and of the implementation — `savePersonKeys`, `personKeys`, `keysByPerson`, `createShares`, `openShares`, `shareById`, `purgeExpiredShares`, `acceptShare`, `declineShare`, `holdersOf`, `heldCredentials`, `removeHolder`, `rotationPending`, `saveAssignment`, `missingCopies`. Every rule of SP06 §5 and §4 lives here, next to the queries; the routes only translate. |
| `host/routes/shares.ts` | **New.** `shareRoutes`, the block 2 person group of SP03 §3 behind `.use(personAuth)`: `PUT /v1/keys`, `POST /v1/shares` (it ids each row and passes the sealed copy through untouched), `POST /v1/shares/:id/accept`, `POST /v1/shares/:id/decline` (both purge what expired first), `GET /v1/credentials/:id/holders` (holder or admin, else 403; an admin on a credential nobody holds gets 404) and `DELETE /v1/credentials/:id/holders/:personId`. The body schemas are `shared/host-api.ts`'s shapes, so a bad body is app.ts's 400 naming the field. |
| `host/routes/assignments.ts` | **New.** `assignmentRoutes`, the block 2 admin group: `PUT /v1/admin/assignments` (`assignedBy` is the caller) and `GET /v1/admin/assignments/missing`, behind `.use(personAuth).use(adminAuth)` in that order (h5's rule). |
| `host/app.ts` | Two import lines and two `.use(...)` mount lines (`shareRoutes`, `assignmentRoutes`) plus the group comment. No other line; `bodyLimitFor` is untouched (a shares body is small and stays at 256 KB). |
| `host/snapshot.ts` | `SnapshotSource` gains the four block 2 reads (`people`, `incomingShares`, `holders`, `rotationPending`); `snapshotSource` runs the expiry purge, reads the keys by person and builds the roster from the non-disabled people; `incomingShareOf` maps a share row to `IncomingShare` (`fromId` → `from`); `snapshotDocument` writes the four fields into the signed body. |
| `shared/host-api.ts` | Eight `HOST_ROUTES` keys (`keys`, `shares`, `shareAccept`, `shareDecline`, `holders`, `holder`, `adminAssignments`, `adminAssignmentsMissing`), the block 2 types (`PublicKeys`, `ShareScope`, `ShareKind`, `ShareItem`, `ShareRequest`, `ShareResponse`, `IncomingShare`, `Holder`, `AssignmentRequest`, `MissingCopy`, `SnapshotPerson`) and the four **optional** `Snapshot` fields. The file's own scope comment was updated. |
| `host/shares.test.ts` | **New.** 17 tests on the real app over a temp data dir (below). |
| `host/repo.test.ts` | The schema test now expects the four block 2 tables, the `shares_to_open` index and `schema_version = '2'`; one new test applies migration 2 **over a data dir that only has migration 1** and asserts the person row survives; the header comment and the `setMeta` assertion follow. |
| `host/health.test.ts` | The fresh-boot assertion of `meta.schema_version`: `'1'` → `'2'`, with a comment naming migration 2. |
| `host/context.md` | The status paragraph (the two new groups, every SP03 §2–§3 route served, block 2's host side landed, this handover), the layout rows of `repo.ts`, `migrations.ts`, `snapshot.ts`, `repo.test.ts`, the two new route files and `shares.test.ts`, and four rules: the share is only ciphertext and does not live long; the recipient rules of SP06 §5 live in `createShares`; the sender becomes the owner holder and the holder rows are what the host derives everything from; the block 2 snapshot fields are inside the signed bytes. |
| `docs/handovers/k3-host-shares.md` | This file. |

**Not edited on purpose**: `docs/specs/*` (SP01 §5 still reads "reports `schema_version = 1`" — finding 1),
`backend/`, `src/`, `shared/types.ts` (`ApiContract`), any other host file.

## Acceptance criterion — how each item was met

### 1. Migration 2 applied on fresh and existing data dirs; `schema_version = 2`

| How | Evidence |
| --- | --- |
| Migration 2 is one new entry of `migrations.ts`, holding exactly SP01 §3's four tables and the partial index; `applyMigrations` applies what is missing inside one transaction with its version bump (SP01 §4), so a fresh `/data` lands on 2 and a `/data` at 1 gets only entry 2. | `execucao` |
| `host/repo.test.ts` — "the migrations create every table and report schema_version = 2" (fresh dir: the four tables, both indexes, the version row) and "migration 2 applies to a data dir that already holds block 1, keeping its rows" (migration 1 executed, a `people` row inserted, `applyMigrations` → 2, the row still there). `host/health.test.ts` asserts 2 on the live boot. | `execucao` |

### 2. Every SP03 §3 route except `/v1/meta/app` implemented with the specified checks, covered by tests

| Route | What was built | Test |
| --- | --- | --- |
| `PUT /v1/keys` | upsert of the pair (a reset replaces it), 43-character base64url keys, 401 without a session | "stores the pair, replaces it on a second call, and needs a session" |
| `POST /v1/shares` | per item: recipient exists (404), not disabled (403), has keys (409), tool granted to one of their roles (403); `role` also needs a role in common with the sender (403), `org` a `member` (403 for a client), `blocked` refuses the whole request (403) as does a credential whose owner holder row is blocked; `kind: 'assign'` only from an admin (403), `kind: 'update'` only from the credential's owner holder to a live holder; the sender becomes the owner holder; `expires_at = created_at + 14 days`; the answer is `{ ids }` | "stores one sealed row per recipient…", "refuses a role share with no role in common…", "an org share reaches a granted member and never a client", "a blocked credential accepts no share at all", "refuses an unknown, a disabled and a keyless recipient", "an update comes from the owner holder to current holders only" |
| `POST /v1/shares/:id/accept` | recipient only (403), open share only (409), sealed → `''` + `purged_at`, `accepted_at` set, holder row upserted with the share's scope and `via_share_id`, `removed_at` cleared | "accept purges the ciphertext, writes the holder row, and only its recipient may" |
| `POST /v1/shares/:id/decline` | the same checks, `declined_at` instead of `accepted_at`, no holder row | "decline purges the ciphertext and leaves the credential without a holder" |
| `GET /v1/credentials/:id/holders` | the caller's holder row or an admin (403 otherwise, 401 without a session; 404 for an admin on a credential nobody holds), owner first | "are visible to a holder and to the admin, refused to anyone else" |
| `DELETE /v1/credentials/:id/holders/:personId` | the owner holder or an admin (403 otherwise), 404 for an unknown holder, 409 for a row already removed, `removed_at` set, and the owner's `rotationPending` carries the credential until an `update` share exists | "removing one marks the credential rotation pending until the remaining holders get an update" |
| `PUT /v1/admin/assignments` | admin only (403/401), upsert on `true`, delete on `false`, the tool must be an org entry, `assignedBy` is the caller | "an assignment belongs to an admin, and so does the missing list", "a role assignment lists its members until each of them holds a copy" |
| `GET /v1/admin/assignments/missing` | per assignment, every non-disabled member of the role with keys, no live holder row and not the assigner | the same test: three members at first, one leaves after accepting an admin copy, a new member appears only once they have keys, a disabled one leaves, `assigned: false` empties the list |
| Expiry | `purgeExpiredShares` runs on the state build (`snapshotSource`) and before accept/decline; an expired share is `sealed = ''`, `purged_at` set, absent from the inbox, and its accept is the 409 of a share that is not open | "an expired share is purged by a read and never travels" |
| `PUT /v1/keys`'s content | the pair travels in `Snapshot.people`, which is how a sender seals to somebody (SP06 §3) | the keys test asserts the roster carries the replacement pair |

Two SP03 §1 statuses that the table does not pin are decisions of this slice (finding 3): `409
recipient has no keys` and `409 the owner cannot be removed`.

### 3. Snapshot carries `people`/`incomingShares`/`holders`/`rotationPending`

`snapshotDocument` writes the four fields, so they are inside the body the `version` digest and the
Ed25519 signature cover (SP04 §2); they are optional in the `Snapshot` type so a Nod still reads an
older host's body. The last test verifies the signature over the bytes as received with the key of
`GET /.well-known/nod`, and asserts the roster (with keys), the holders of both sides and the empty
inbox/rotation of a holder. `execucao`.

### 4. Rules of the epic that this slice had to honour

- **RF-44 (no credential content on the host)**: one test dumps every text value of every table of
  `host.db` after a send and asserts the sealed copy is there while neither the username nor the
  secret is (`execucao`); the host never decodes `sealed` and no route logs a body — a test captures
  `console` and asserts no line carries the sealed string, the username or the secret (`execucao`).
- **RF-47, RF-48, RF-53, RF-54**: the assignment/missing-list, rotation-pending, scope and holders
  tests above.
- **No secret in a log, an event or `store.json`**: the host writes no event of its own — `events` is
  filled only from a Nod's `POST /v1/events` batch — and nothing in this slice logs or answers a
  body value. The `share.sent`/`share.accepted`/`share.declined`/`share.expired` events of E02 §6 are
  the Nod's to raise (see "For other owners").

## Commands run and observed results

1. **This slice's file**, on the final tree:

   ```
   $ bun test host/shares.test.ts
   17 pass
   0 fail
   516 expect() calls
   Ran 17 tests across 1 file. [7.21s]
   ```

2. **The folder's own command** (the acceptance's), on the final tree:

   ```
   $ bun test host/
   155 pass
   0 fail
   1797 expect() calls
   Ran 155 tests across 11 files. [17.00s]
   ```

   11 files, i.e. the peers' `person.test.ts` and `meta.test.ts` too: the whole folder is green with
   migration 2 in place.

3. **The two files whose schema assertions move with the migration**, run right after the edit:

   ```
   $ bun test host/health.test.ts host/repo.test.ts
   31 pass, 0 fail
   ```

4. **A scratch `tsc` probe of this slice** (not the project gate; it mirrors `host/tsconfig.json`'s
   options the way `docs/handovers/i2h-guild-icon-host.md` disclosed its own):

   ```
   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2023 --module esnext \
       --moduleResolution bundler --lib es2023,dom --types bun --typeRoots ./host/node_modules/@types \
       --skipLibCheck --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax \
       --erasableSyntaxOnly --noFallthroughCasesInSwitch \
       host/migrations.ts host/repo.ts host/snapshot.ts host/routes/shares.ts \
       host/routes/assignments.ts host/shares.test.ts host/repo.test.ts host/health.test.ts
   (no diagnostics)  exit=0
   ```

   `host/app.ts` and `host/main.ts` were probed the same way with the peers' files pulled in: also
   clean. A first probe reported **one** error outside this slice (`host/routes/meta.ts` TS2352, the
   cast to `MetaContext`), which I reported to that slice's owner; it is fixed.

5. **Not run**: `bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter.

## Decisions and findings for the coordinator

1. **`docs/specs/SP01-host-data-model.md` §5 still reads "reports `schema_version = 1` (block 1)".**
   It is the spec of the owner of SP01, not a file of this slice, so it is left as it is: with
   migration 2 a fresh `/data` reports **2**, which is what `host/health.test.ts`, `host/repo.test.ts`
   and this handover now assert. Same for the `meta` key list of §2, which the icon's two rows never
   joined (finding of `i2h`).
2. **An admin who is not in the assigned role cannot send `kind: 'assign'` with scope `role`.**
   SP06 §5's `role` rule is "sender and recipient share ≥ 1 role", and the host applies it per item to
   every kind — which is what this slice's mandate says ("scope rules SP06 §5" + "`kind:'assign'` only
   from an admin" are stated side by side). The first admin holds the `admin` role only (SP03 §2's
   `setup`), so the admin's Bond has to seal an assignment to a whole role with scope **`org`**, or
   the host needs an assignment-specific rule ("the recipient is a member of a role the credential is
   assigned to"). The tests exercise the first reading. **Decision for the coordinator** (it changes
   the contract the K8 Nod codes against): keep SP06 §5 as it is and let the Nod use `org`, or widen
   the host's `assign` check — the second is a small change in `createShares`, and this slice did not
   take it on its own.
3. **Two statuses SP03 §1 does not pin, decided here** (both are state conflicts, so 409):
   `recipient has no keys` (there is nothing to seal to, SP06 §2) and `the owner cannot be removed`
   (the owner holder row is the anchor of `rotationPending` and of the update right; removing it would
   leave the credential ownerless in the host's bookkeeping). The owner is refused to an admin too,
   because the plaintext is that person's, not the host's.
4. **`rotationPending` is cleared by an `update` share `created_at >=` the latest `removed_at`**, not
   strictly `>`. The host's clock has millisecond resolution (`auth.now()` is
   `new Date().toISOString()`), so a removal and the update that follows it can share one instant;
   with `>` the badge would stay up after the owner had already re-sealed. SP04 §2 only says "I own
   with a removed holder".
5. **The purge runs on the read paths, not on a timer**: `snapshotSource` (every `GET /v1/state`) and
   the accept/decline routes. It is one `UPDATE … WHERE purged_at IS NULL AND expires_at <= ?`, a
   no-op while nothing has expired, and it keeps the rule "expired means purged" true for any read
   that can observe a share. A timer in `main.ts` would have to be restarted with the process anyway
   (SP07's boot) and would not cover a share that expires between two ticks.
6. **`snapshotSource` takes an optional third `now`** (the wall clock by default). `routes/state.ts`
   calls it with two arguments, and the file is not this slice's; the default is the same clock
   `auth.now()` reads, so nothing observable changes. One line in `routes/state.ts`
   (`snapshotSource(repo, person, auth.now())`) would make one request read one instant — for that
   file's owner, not a finding.
7. **A share to a recipient whose key pair was reset still passes the "has keys" check** (the row is
   the person's, replaced in place) and will fail to open on the receiver (`shared/seal.ts`'s
   `open`), which is the `invalid share` decline of SP06 §3 — the Nod re-sends, as E02 §3 says.
8. **The `missingCopies` query does not filter `kind`.** SP06 §5 forbids `org` shares to clients, but
   an assignment's scope is the admin's choice, so a `client` person holding an assigned role would
   appear in the list and could not be reached with an `org`-scoped copy. The fixture keeps clients
   out of assigned roles, and this is the literal reading of #36 ("every non-disabled member of
   `role_id`"). Nothing in this slice decides it.
9. **A request may carry the same recipient twice.** The host writes one row per item (#31 says one
   sealed copy per item, no uniqueness rule), and only the second accept's holder upsert could fail
   to surprise: the same person ends with one holder row. Reported rather than forbidden.
10. **`Snapshot.people` is the whole non-disabled roster of the guild, with public keys.** SP04 §2
    asks for it (a sender cannot seal without the recipient's key) and it is what E02 §3 accepts as
    the host's metadata visibility. Every block 1 field of a person row but `id`, `name`, `roles` and
    `kind` stays behind: no email.

## What was left out

- **The Nod side** (K2's key generation at activation, K4's send/accept/decline and vault inbox,
  K5's gate, K6's scope in the UI and in the outbox, K8's sealing to the missing members, K9's
  re-seal on rotation, the `share.*` events, Settings → Vault and the Holders screen): `backend/`
  and `src/`, other slices.
- **`shared/types.ts`'s `ApiContract`** (`host.share*` RPC methods) and the page: other slices.
- **`/v1/meta/app`**: O2's, already landed by another owner.
- **A timer for expiry**, the per-item duplicate rule, the assignment-specific scope rule and any
  change to `docs/specs/`: decisions 2–5 and 9 above.
- **`bun run typecheck`, the repo-wide `bun test`, the smoke**: the coordinator's.

## For other owners

- **Coordinator**: finding 1 (SP01 §5's `schema_version = 1`) and decision 2 (the `assign` + `role`
  scope reading) are the two that need a human answer; both are cheap to change if the answer differs.
- **K2/K4 (Nod, `backend/` + `shared/`)**: the wire names are as coded against — `HOST_ROUTES.keys` /
  `shares` / `shareAccept` / `shareDecline` / `holders` / `holder` / `adminAssignments` /
  `adminAssignmentsMissing`, the types `PublicKeys`, `ShareRequest` (`{ credentialId, toolId, scope,
  kind, items: [{ to, sealed }] }`), `ShareResponse` (`{ ids }`, in the order of `items`),
  `IncomingShare` (`from`, not `fromId`), `Holder` (`owner`, `scope`, `since`, `removedAt`),
  `AssignmentRequest`, `MissingCopy`, `SnapshotPerson`. `PUT /v1/keys` answers `204`, the two share
  answers `204`, the holders route `Holder[]`. The sealed copy is handed to the recipient's
  `Snapshot.incomingShares` untouched; the host purges it on accept, decline and 14 days, and the
  refuse messages are the static English of this slice's tests (`no role in common`, `tool not
  visible to recipient`, `org shares go to members only`, `the credential is blocked`,
  `recipient has no keys`, `recipient is disabled`, `not the owner`, `not a holder`, `not yours`,
  `share is not open`, `unknown person`, `unknown tool`, `unknown credential`, `unknown holder`,
  `recipient is disabled`).
- **K6/K8 (Nod)**: `kind: 'assign'` needs scope `org` while decision 2 stands; the missing list is
  the source of truth for who still needs a copy, and the admin who assigned is never in it.
- **K9 (Nod)**: `Snapshot.rotationPending` is the credential ids to show as "rotation pending"; it
  clears on the host the moment an `update` share you created exists at or after the removal, so the
  badge is driven by the host's data and not by local state.
- **K4 (Nod, events)**: the host stores events from `POST /v1/events` only; the `share.*` events of
  E02 §6 have to be raised (and kept content-free) on the Nod side.

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, written only by its owner: the files
touched, the acceptance and how it was met, the command and the observation, and what was left out).
The state of the work is not declared here; the coordinator's handover for the front carries it.
