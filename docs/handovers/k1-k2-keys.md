# Slice K1 + K2 (Nod side) — the E02 key pairs and the key pinning of colleagues

Authorizing issues: **#29** (K1, `[K1] Key pairs at activation; private keys under vaultKey; public
keys on host`) and **#30** (K2, `[K2] Colleague key pinning and key-change warning`), the copies in
`/tmp/nod/issue-29.md` and `/tmp/nod/issue-30.md`. Epic #3 (E02 — credential sharing), Block 2
("Mine and shared" — `docs/epics/blocks.md`). Requirements: RF-44, RF-45.

Contracts followed: `docs/specs/SP06-credential-sharing.md` §2 (the two key pairs, the `bv1.` value,
the fingerprint, `peer_keys` and what "changed" means) and §3 (the pinned Ed25519 key verifies an
incoming share, and the opener supplies its own x25519 public key); `SP02-auth-and-keys.md` §1 (the
`vaultKey`), §6 (unlock), §7 (reset) and §8 (the `bv1.` envelope and the AAD); `SP04-sync.md` §2
(`Snapshot.people`); `SP03-host-api.md` §3 (`PUT /v1/keys`); `AGENTS.md`, `backend/context.md`,
`shared/context.md`, `src/context.md`, `host/context.md`.

Nothing here is a secret: a public key, a fingerprint of two public keys, and a `person_id`. The
private halves exist inside `bv1.` keychain values and in the memory of an unlock, never in a log, an
event, an error, `store.json` or the page.

## Files touched

| File | What changed |
| --- | --- |
| `shared/seal.ts` | `PERSON_FINGERPRINT_BYTES` (10) and **`personFingerprint(x25519Public, ed25519Public)`** — SHA-256 of `x ‖ ed`, first 10 bytes, Crockford base32 grouped `XXXX-XXXX-XXXX-XXXX` (SP06 §2). The alphabet and the grouping are `shared/host-api.ts`'s (`CODE_ALPHABET`, `formatCode`), so the product keeps one Crockford definition: this module gained its **only** import. |
| `shared/types.ts` | **`PeerKey`** (a colleague: `personId`, `name`, `fingerprint`, `status: 'pinned' \| 'changed' \| 'unknown'`, `firstSeen`, `confirmedAt`) and three `ApiContract` methods: `keys.mine` → `{ fingerprint } \| null`, `peers.list` → `PeerKey[]`, `peers.confirm { personId }` → `true`. |
| `backend/keys.ts` | **New.** K1: `ensure(connection, { regenerate })` — generates the X25519 and Ed25519 pairs when there are none (activation, a sign-in on a machine without one), replaces a pair the current `vaultKey` cannot open (a reset) or one `regenerate` names, seals the private halves as a `bv1.` value under `nod.keys.<person>` (AAD = the same key), keeps the raw public halves in `meta.keys.public.<person>` and publishes them with `PUT /v1/keys` when the cached roster does not carry them. K2: the pure `pinAction(previous, seen)` → `pin \| none \| changed \| clear`, `observe()` (the snapshot's `people` → `peer_keys`), `peers()` (the screen's rows), `peerKeyFor(personId)` (the pinned pair + `pinned`/`changed`, the seam a sender must refuse on) and `confirm(personId)`. `keysKey(personId)` is exported (the keychain key and the AAD). |
| `backend/repo.ts` | **Migration 4**: `SCHEMA_VERSION = 4`, `KNOWN_VERSIONS` gains `3`, and `peer_keys` joins `SCHEMA` (SP06 §2's six columns plus `pending_x25519`, `pending_ed25519`, `pending_fingerprint`, `pending_since` — the `changed` state). `PeerKeyRow`/`PeerKeyRecord` and five `Repo` members: `peerKey`, `pinPeerKey`, `markPeerKeyChanged`, `clearPeerKeyChange`, `confirmPeerKey`. |
| `backend/host-client.ts` | `HostConnection.putKeys(keys: PublicKeys)` → `PUT /v1/keys` with the bearer (204, no body read). |
| `backend/main.ts` | `keys` built beside the vault; **`session.onActivated`** registered (VaultFinish's hook — an activation, and the reset an activation over an existing account is), `afterUnlock` ensures the pair while a `host` row exists, and `onState` (a run that moved the snapshot) runs `observe()` + `ensure(keysConnection())`; the three handlers `keys.mine`, `peers.list`, `peers.confirm`; `keysConnection()` — `null` while the O2 gate has this Nod too old to write to the host — and `ensureKeys(regenerate)` as the one call the three moments share (`afterUnlock` shadows the name `keys` with the `vaultKey` it reads). |
| `src/settings.ts` | Account: **`keyFingerprintCard()`** ("Your key fingerprint") and **`colleaguesCard()`** — one row per colleague with the pinned fingerprint, a `key changed — confirm` warning and its **Confirm** (`peers.confirm`); both read with the tab (`keys.mine`, `peers.list`) and drawn only with a host. State: `keys`, `peers`. |
| `src/style.css` | `.chip-warn` (the warning chip's colour), four lines, next to the O2 notice. |
| `test/keys.test.ts` | **New.** 25 tests: the fingerprint vectors and its shape, `pinAction`'s four outcomes, the pairs of an activation (sealed value, published publics, `meta`, `mine`), the replacement on a moved `vaultKey`, `regenerate`, a refusing keychain, a locked session, a host that refuses, no connection; the pin table first sight / repeat / change / confirm / unknown / back-to-pinned, and the repo's "a pin is only made once". |
| `test/repo.test.ts` | The schema assertions of migration 4 (`SCHEMA_VERSION`, `user_version`, the table list, a v3→v4 test with its rows kept), the "unknown version" probe (`4` → `5`, since 4 is now this build's) and the `vault_item` rebuild loop (`[2, 3]` → `[2, 3, 4]`). |
| `test/sync.test.ts` | The scripted `HostConnection` gained `putKeys` (the interface has a new member). |
| `backend/context.md`, `shared/context.md`, `src/context.md`, `test/context.md` | The module rows of `keys.ts`, `repo.ts`, `host-client.ts`, `main.ts`; the `seal.ts` and `types.ts` rows; the two new Account cards; the two new rules (the key material rule and `PUT /v1/keys` under the O2 gate); the K1–K2 proof row. |
| `docs/handovers/k1-k2-keys.md` | This file. |

**Not edited on purpose**: `backend/session.ts` and `backend/vault.ts` (VaultFinish's this phase —
`session.onActivated` and `session.vaultKey()` were used as published), `shared/vault-crypto.ts`
(`encryptVaultBytes`/`decryptVaultBytes` used as they are), `shared/host-merge.ts`
(`SnapshotRows` has no `people`; `backend/keys.ts` reads that one field from the cached body itself
rather than widening another slice's shape), `shared/host-api.ts` (`HOST_ROUTES.keys` and
`PublicKeys` were already there, from K3), `host/**`, `docs/specs/*`, `docs/arquitetura.md`
(§3/§4 have no entry for `shared/seal.ts` or `backend/keys.ts` — s0's finding, the coordinator's).

## Acceptance — how each item is met

`execucao` = run and observed; `leitura` = read from the code and the specs.

### #29 — K1

| Item | How | Evidence |
| --- | --- | --- |
| Activation creates an X25519 and an Ed25519 pair | `backend/main.ts`: `session.onActivated` (VaultFinish's hook: the row is written and the keys of the account are in hand) → `ensureKeys(event.reset)`, and `afterUnlock` → `ensureKeys(false)` while a `host` row exists (the sign-in on a machine that never had a pair). `backend/keys.ts` `ensure` is what makes and stores them | `execucao` for `ensure` itself (1, 3 and `test/keys.test.ts`); `leitura` + the `tsc` probe (command 4) for the three call sites — the app under tinyjs was not run |
| The private keys are stored as `bv1.` under `nod.keys.<person>` | `backend/keys.ts` `ownPair`: the two PKCS#8 keys as JSON, `encryptVaultBytes(vaultKey, keysKey(personId), …)`; `keysKey` is `nod.keys.<person>` and the same string is the AAD, so a value moved to another item does not open (SP02 §8) | `execucao` (1: `keychain item nod.keys.<uuid> bv1.`); `leitura` (the value never holds a clear private key — asserted in `test/keys.test.ts`) |
| `PUT /v1/keys` stores the public keys | `ensure` publishes when the cached roster does not carry this person's pair (or carries another one): `connection.putKeys({ x25519Public, ed25519Public })` — raw 32 bytes, base64url (SP06 §2) | `execucao` (1: the host's own `person_keys` row equals `meta.keys.public.<person>`, and the fingerprint is the digest of the host's pair; 3: after another machine replaced the pair, `ensure` published again and the host holds mine) |
| A reset regenerates and replaces them | Two paths, both real: the account was activated again (the `vaultKey` moved) → the stored `bv1.` value does not open → a fresh pair is stored and published; and `session.onActivated` with `reset: true` forces the same through `regenerate` | `execucao` (1: `ensure after a reset { created: true, published: true }`, the host's row = the new pair); `execucao` (`test/keys.test.ts`: "a value the current vaultKey cannot open is replaced…", "regenerate replaces a pair that still opens…") |
| Settings → Account shows the person's fingerprint | `src/settings.ts` `keyFingerprintCard()`, fed by `keys.mine` → `backend/keys.ts` `mine()` (the fingerprint of the pair this machine holds) | `leitura` (the card and the call; the page was not driven in a window — see "What was left out") |
| Never a private key or `vaultKey` in the page, a log, an event or `store.json` | The three RPCs answer a fingerprint, a list of public fingerprints and `true`; `keys.ts` writes only the keychain (the `bv1.` value) and `meta` (the **public** halves); no log line, no event and no `store` entry was added | `leitura`; `execucao` (`test/keys.test.ts`: the stored value does not contain the base64url of either private key) |

### #30 — K2

| Item | How | Evidence |
| --- | --- | --- |
| First sight pins a colleague's keys | `observe()` runs on every run that applied a snapshot; `pinAction(null, seen)` → `pin` → `repo.pinPeerKey` (which is `INSERT … ON CONFLICT DO NOTHING`, so a later sight can never re-pin) | `execucao` (2: `observe (first sight) true`, Bea listed `pinned` with the fingerprint of her pair) |
| A different key marks them changed | `pinAction(pinned, seen)` → `changed` → `markPeerKeyChanged` keeps the pinned pair and records the new one as pending; `peerKeyFor` answers `status: 'changed'`, and the pinned Ed25519 key is still the one an incoming share is verified with (SP06 §3 step 2) | `execucao` (2: `peerKeyFor (changed) { … status: "changed" }`, with the pair Bea had before); `execucao` (`test/keys.test.ts`: "a different pair marks the peer changed…") |
| …and blocks sending until confirmed in the UI | The seam is `peerKeyFor(personId)`: `changed` is what a sender refuses on (K4). The screen shows the new fingerprint and `Confirm` → `peers.confirm` → `repo.confirmPeerKey` promotes the pending pair | `execucao` (2: `confirm true`, then `peerKeyFor (confirmed) … status: "pinned"` with the new pair); `leitura` (the card and the button) |
| Settings shows the fingerprint per colleague | `peers.list` → `PeerKey[]` (the roster's names + the pin table) → `colleaguesCard()`: name, fingerprint, the `key changed — confirm` chip and Confirm, `no keys yet` for a colleague without a pair | `leitura` (the page was not driven in a window) |

## Commands run and observed results

Only this slice's files were run — no `bun run typecheck`, no repo-wide `bun test`, no formatter, no
smoke (the coordinator's, at the end of the phase).

1. **This slice's test file**, final tree:

   ```
   $ bun test test/keys.test.ts
   25 pass
   0 fail
   107 expect() calls
   Ran 25 tests across 1 file. [162.00ms]
   ```

2. **The schema file whose assertions move with migration 4**:

   ```
   $ bun test test/repo.test.ts
   58 pass
   0 fail
   356 expect() calls
   Ran 58 tests across 1 file. [165.00ms]
   ```

3. **A scratch end-to-end probe of K1/K2 against the real host** (`/tmp/nodkeys/probe.ts`, outside
   the repo and left there so the coordinator can re-run it): the real
   `host/app.ts` over a temp data dir (`bootHost` + `createApp`, every route and guard), the real
   `backend/host-client` as the wire (`fetch` → `app.handle`), the real `backend/repo.ts` over
   `bun:sqlite`, and the real `backend/keys.ts`; only the keychain and the session are doubles, as
   they must be outside the app. It runs the real setup code, the real activation, `PUT /v1/keys`,
   a second person's keys, a second `PUT /v1/keys` for them, and reads the host's own `person_keys`
   through `hostRepo.personKeys`. Lines of the run (`execucao`):

   ```
   discovery https://nod.example Probe Guild W8KQ-BJ7S-A5S3-ZV2D
   activated admin 68f5e40d-888a-4bfb-a975-beb741ac3017
   ensure { fingerprint: "YXQ1-AKRA-EXF5-7340", created: true, published: true, error: null }
   host person_keys { x25519Public: "kHLk5KZNePDYU7Dd2S4bdd5XWjOgCs96nDgOIdugbAE",
                      ed25519Public: "un4821ik1BC57WpeubzIEtLbXzMkhC6GhZ9uhQ8Sntk" }
   keychain item nod.keys.68f5e40d-… bv1.
   host row equals my meta publics true
   fingerprint is personFingerprint of the host pair true
   observe (first sight) true
   peers [ { personId: "9ac17583-…", name: "Bea", fingerprint: "MXXD-VJGW-QG6N-MPPS",
             status: "pinned", … } ]
   observe (change) true
   peerKeyFor (changed) { x25519: "qchQmIJtb-tjP-VGyNc4GmYkOwi2ms4XvCZl3021wEM", …, status: "changed" }
   peers (changed) [ { …, fingerprint: "85T5-Z212-G0BZ-2KCT", status: "changed" } ]
   confirm true
   peerKeyFor (confirmed) { …, fingerprint: "85T5-Z212-G0BZ-2KCT", status: "pinned" }
   ensure after another machine replaced the pair { fingerprint: "5VTY-5YCV-B39Q-HXYJ", created: false,
                                                    published: true, error: null }
   host now holds mine again true
   ensure after a reset { fingerprint: "XZBY-GXGY-YGJK-VHRA", created: true, published: true, error: null }
   the new pair is on the host true
   ```

   The same script is what proved the fingerprint vectors: `ZQNB-KB7K-E41P-5F96` for
   `x = 0x00…0x1f ‖ ed = 0x20…0x3f` was cross-checked against an independent SHA-256 (Python
   `hashlib`) before it was pinned in `test/keys.test.ts`.

4. **A scratch `tsc` probe of this slice's files** (not the project gate; the same recipe
   `docs/handovers/k3-host-shares.md` discloses), right after the last edit:

   ```
   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 --module es2022 \
       --moduleResolution bundler --skipLibCheck backend/tiny.d.ts backend/tjs.d.ts \
       backend/keys.ts backend/repo.ts shared/seal.ts shared/types.ts shared/host-api.ts \
       shared/vault-crypto.ts shared/encoding.ts shared/auth.ts shared/catalog.ts
   (no diagnostics)  exit=0

   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 --module es2022 \
       --moduleResolution bundler --skipLibCheck backend/tiny.d.ts backend/tjs.d.ts \
       backend/main.ts backend/host-client.ts
   (no diagnostics)  exit=0

   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2023 --module esnext \
       --moduleResolution bundler --lib es2023,dom --skipLibCheck --verbatimModuleSyntax \
       --erasableSyntaxOnly --noUnusedLocals --noUnusedParameters src/tiny.d.ts src/settings.ts
   (no diagnostics)  exit=0
   ```

   The first run of the middle command reported one error of this slice —
   `backend/main.ts(973,34): error TS2339: Property 'ensure' does not exist on type 'Uint8Array<ArrayBuffer>'`,
   because `afterUnlock` shadows the module's `keys` with the `vaultKey` it reads; the fix is
   `ensureKeys`, the named call the three moments share. The command is what caught it, and it is
   why the wiring is claimed as read-and-probed rather than read.

5. **Not run**: `bun run typecheck` (the project gate), the repo-wide `bun test`, `test/smoke/`
   (local or connected), any formatter or linter.

## Decisions and findings for the coordinator

1. **`peer_keys` carries four columns SP06 §2 does not list.** The spec pins
   `peer_keys(person_id PK, x25519, ed25519, fingerprint, first_seen, confirmed_at)` and then says a
   different key "marks the peer `changed`", without a column for it. The state has to live
   somewhere: `pending_x25519`, `pending_ed25519`, `pending_fingerprint`, `pending_since` were added
   (one migration, `user_version = 4`), and the spec's sentence about the table is what a future
   edit of SP06 §2 §2 would have to name. Reported rather than assumed: it is the owner of SP06 who
   decides whether the list in §2 grows or the pending pair is meant to live elsewhere.
2. **`PeerKey.fingerprint` is `string | null`, and while `changed` it is the *pending* fingerprint.**
   The assignment's sketch gives one `fingerprint` string; the `unknown` state (a roster entry with
   no pair to pin — not activated, or a reset with no pair published yet) has nothing to fingerprint,
   so `null` is the honest value there; and while `changed` the string the person has to read out
   loud (compare with the colleague) is the **new** one, while the pinned one stays in the table for
   the seal's verification. The pinned fingerprint is not lost: it is `peerKeyFor().fingerprint`.
3. **First sight writes `confirmed_at`.** SP06 §2 says "on first sight, pin" and its table has
   `confirmed_at`; a first sight has nothing to compare against, so the pin *is* the confirmation
   that this machine met the key then, and the screen shows that instants as the confirmed one. A
   promotion of a pending pair moves `confirmed_at` to the confirmation and `first_seen` to when the
   new pair first appeared (`pending_since`), because that is when the machine met the key it now
   trusts.
4. **Two machines of one account fight over one pair — resolved by the owner.** This slice made the
   machine whose stored private halves belong to the account re-publish them when the snapshot's own
   entry differs, so the last machine to sync owned the pair and shares sealed to the previous one
   stopped opening (the `invalid share` decline of SP06 §3). The owner decided the opposite rule
   (`docs/canonico.md` §22, 2026-10-17): the first machine to activate publishes its private pair as
   a `bv1.` blob beside the public keys, and every other machine of that person adopts it instead of
   generating a competitor. `backend/keys.ts` no longer re-publishes a local pair the host does not
   hold; the implementation and its evidence are in the "Key sync" section at the end of this file,
   and SP06 §2 carries the rule.
5. **The public halves live in `meta.keys.public.<person>`, the private ones in the keychain.**
   SP06 §2 only says where the privates go; the assignment allows either the same keychain JSON or
   `meta`. `meta` was taken because the opener needs its own x25519 **public** key besides the
   private one (SP06 §3 step 3) and a PKCS#8 private key cannot yield it (s0): one synchronous read
   from the repository is what `ensure`, `mine` and the future sender need. They are public keys —
   the host holds them too. The corner case is declared in the code: a keychain item that survives a
   lost `meta` row is unusable (the public half is unknown), so `ensure` regenerates it like a reset.
6. **`peers.confirm` with nothing pending (or an unknown person) is a no-op that answers `true`.**
   The button only exists while the peer is `changed`; making the call an error would turn a repeated
   click or a stale screen into a failure for no gain.
7. **The Account tab does not re-read the pins on a `host` push.** `backend/sync.ts` publishes a state
   on every run (including the `304`s), so reloading on that push would spend four RPCs per run for a
   list that only moves when a snapshot does. The list is read when the tab loads and after a
   Confirm; what must not wait for a screen is the refusal itself, and that is `peerKeyFor`'s
   `changed` in the sender (K4). If the owner wants the warning to appear live, the push needs a
   "snapshot moved" signal — `HostState` has none today.
8. **`PUT /v1/keys` respects the O2 gate.** It is not an RPC method, so it is not in `HOST_WRITES`;
   `keysConnection()` in `main.ts` hands `backend/keys.ts` a `null` connection while this Nod is older
   than the host's `minAppVersion`, and the pair waits on the machine until the update. `backend/context.md`
   carries the rule so a later write of the same kind (the share flows) lands in both halves.
9. **The fingerprint's encoder is `shared/host-api.ts`'s.** `peopleFingerprint` uses `CODE_ALPHABET`
   and `formatCode`, which is the host key's own fingerprint alphabet (SP04 §1.1) — one Crockford
   definition and one grouping in the product. The copy inside `backend/host-client.ts`
   (`fingerprintOf`, B1's finding) is untouched: folding it into `shared/seal.ts` would be a change
   to that slice's file.
10. **The issue text and the spec disagree on the keychain key's name.** #29's acceptance says
    `bond.keys.<person>`; SP06 §2 (and this assignment) say `nod.keys.<person>`. The code uses
    **`nod.keys.<person>`** (`keysKey`), the one home of the string; the issue's line is the outlier.
11. **`SCHEMA_VERSION` 3 → 4** (the only bump allowed this phase). `KNOWN_VERSIONS` gained `3` so a
    block-1 database is completed and re-stamped instead of refused; the four schema assertions that
    move with it are in `test/repo.test.ts`, and the "a version this build does not know" probe now
    uses `5`.
12. **`shared/seal.ts` gained one import** (`shared/host-api.ts`, for the alphabet and the grouping) —
    its header said "no import from any other module". `host-api.ts` imports only types from
    `shared/types.ts`, so the two keep their direction with no runtime cycle.

## For other owners

- **K4/K5 (send and the gate)**: the only seam to read a recipient's key is
  `keys.peerKeyFor(personId)` → `{ x25519, ed25519, fingerprint, status }`; **`changed` must refuse
  the send** (RF-45), and `null` means nothing is pinned for that person (they have no pair on the
  host, so there is nothing to seal to). The sender's own Ed25519 private key is **not** exported yet
  on purpose (no dead code): `backend/keys.ts`'s private `openPrivateKeys` is the read path — message
  me and I add the export K4 needs (a signature like
  `signingKey(): Promise<{ ed25519: Uint8Array<ArrayBuffer>; x25519: Uint8Array<ArrayBuffer> } | null>`)
  rather than a second decrypt of the keychain elsewhere. The opener's own x25519 public key is
  `meta.keys.public.<person>` (or `mine()`, which answers the fingerprint only) — K4 will want a
  named read for it too.
- **K9/K10**: the `share.*` events are still nobody's, and nothing of this slice raises one.
- **Coordinator**: findings 1 (the four extra columns) and 10 (`bond.keys` vs `nod.keys`) are the
  ones that still need a spec answer; finding 4 (two machines, one pair) was decided by the owner
  (`docs/canonico.md` §22) and implemented — see the "Key sync" section at the end of this file. s0's
  finding stands that `docs/arquitetura.md` §3/§4 have no entry for `shared/seal.ts` (and none for
  `backend/keys.ts`).

## What was left out

- **The share flows** (K4–K10: sealing, the inbox and accept, the gate, the scope in the outbox, the
  assignments, the rotation re-seal, the `share.*` events): other slices.
- **The page driven in a window**: the two Account cards and the Confirm were written and read, not
  clicked — the smoke and the window are the coordinator's. What the fingerprint card shows is
  `keys.mine`, which the probe exercised from the backend side.
- **The smoke (local and connected)**: not run; nothing under `test/smoke/` was touched. No step of
  either smoke covers a key pair or a pin, so the `people`/`peer_keys` half of K1–K2 has only the
  unit and probe evidence above.
- **`bun run typecheck`, the repo-wide `bun test`, formatters and linters**: the coordinator's.
- **`docs/arquitetura.md`**: not edited; s0's entry finding is reported instead. (SP06 §2, SP01 §3–§4
  and SP03 §3 were edited by the "Key sync" work at the end of this file; findings 1 and 10 above
  still await a spec answer.)

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, written only by its owner: the files
touched, the acceptance and how it was met, the command and the observation, and what was left out).
The state of #29 and #30 is the GitHub issues; this file closes nothing and decides no spec.

---

## Key sync — one pair per person across machines (`docs/canonico.md` §22, Decidido 2026-10-17)

The owner's decision after finding 4 above: the **first machine to activate publishes its private
pair to the host** as a `bv1.` blob (`privateSealed`) beside the public keys, and **every other
machine of the same person downloads and opens it** instead of generating a pair of its own. The
host stores only ciphertext; a reset replaces both halves; a password change re-seals the blob.

### Files touched

| File | What changed |
| --- | --- |
| `host/migrations.ts` | **Migration 3**: `ALTER TABLE person_keys ADD COLUMN private_sealed TEXT` (nullable; entry 2 is untouched). A fresh `/data` reports `schema_version = 3`. |
| `host/repo.ts` | `OwnPersonKeys` (`PersonKeys` + `privateSealed`); `savePersonKeys(personId, keys, privateSealed, now)` with the two rules of the decision (new public keys replace the row and its `created_at`; the same ones move `private_sealed` alone, a `null` blob keeping what is stored); `ownPersonKeys(personId)` — the only read that carries the blob. `personKeys`/`keysByPerson` (the roster and the sender's lookup) stay public-only. |
| `host/routes/shares.ts` | `PUT /v1/keys` body gains `privateSealed?` (schema `^bv1\.[A-Za-z0-9_-]+$`, opaque like `sealed`); new `GET /v1/keys/private` → the caller's own `OwnKeys`, `404` without a row, never another person's. |
| `shared/host-api.ts` | `HOST_ROUTES.keysPrivate`; `PublicKeys.privateSealed?`; `OwnKeys`. |
| `backend/host-client.ts` | `HostConnection.getOwnKeys()` → `OwnKeys \| null` (`null` on the host's `404`, every other refusal still throws); `readOwnKeys` shape check. |
| `backend/keys.ts` | `privateKeysAad(personId)` = `nod.keys.private/v1\|<person>`; `KeyPair`/`BlobFields`; `localPair`, `generatePair`, `storePair`, `publicKeysOf`, `sealBlob`, `openBlob`, `adoptBlob`, `report`, `publish`; `ensure` rewritten to the five cases below; **`reSeal(previousVaultKey, connection)`** for the password change; a `meta` mark `keys.pending.<person>` for a pair generated while the host could not be asked. |
| `backend/main.ts` | The `session.changePassword` handler reads `session.vaultKey()` before the call and runs `keys.reSeal(previous, keysConnection())` after it. |
| `host/shares.test.ts` | `PUT /v1/keys` stores the blob byte for byte and the roster never carries it; the new `GET /v1/keys/private` describe (own row, `404`, `401`, never another person's). |
| `host/health.test.ts`, `host/repo.test.ts` | `schema_version` 2 → **3**, the `private_sealed` column, and a v2→v3 test keeping a published pair. |
| `test/keys.test.ts` | Harness: the host's own row (`getOwnKeys`/`setHostKeys`) and `forgetLocal`; the blob format pinned by the test itself (`hostBlob`); cases (a)–(e) and both `reSeal` outcomes. |
| `test/shares.test.ts` | The two-machine end-to-end over the **real** host app, client, session and `backend/keys.ts`: machine 1 publishes, machine 2 signs in and adopts, Bob's pin of Alice never moves. |
| `test/sync.test.ts` | The scripted `HostConnection` gained `getOwnKeys` (the interface has a new member). |
| `docs/specs/SP06-credential-sharing.md` §2, `SP01-host-data-model.md` §3/§4, `SP03-host-api.md` §3 | The rule, the column, the migration, the two routes. |

### `ensure` — the five cases

1. **(a) Local pair = the host's publics**: the host's blob is uploaded when it lacks one (the repair
   for a row published before migration 3); otherwise nothing is written.
2. **(b) No usable local pair**: `GET /v1/keys/private`; a blob this `vaultKey` opens *and* whose
   public halves are the host's is decrypted, stored (keychain + `meta`) and nothing is published; a
   `404` (or a row whose blob is `null`) means this machine makes the pair and publishes both halves.
3. **(c) Local pair ≠ the host's publics, not a reset**: nothing is re-published (this is what stops
   the fight of finding 4); the host's blob is opened and adopted, replacing the local pair.
4. **(d) `regenerate` (the activation event's reset)**: the host's blob is adopted when it opens with
   this `vaultKey` — that is another machine's reset having published the new pair, and adopting it is
   what keeps the two machines from fighting; otherwise a fresh pair is generated and replaces both
   halves on the host. A pair generated while the connection was `null` (the `host` row does not exist
   yet at the activation hook, or the O2 gate is closed) is marked `keys.pending.<person>`, and the
   next `ensure` publishes *it* instead of adopting the pair the reset replaced.
5. **(e) The blob does not open** (the password moved elsewhere and this machine still holds the old
   `vaultKey`): nothing is written and no pair is generated — the answer is
   `keys unavailable — sign in again` in `KeyStatus.error`, the status the UI shows. A machine with no
   keys of its own is refused the same way, which is what "never a competing pair" means.

`reSeal(previousVaultKey, connection)` opens the keychain value with the key the session held before
the change, stores it again under the new one and publishes the re-sealed blob. The public keys never
move, so no colleague's pin goes `changed`; a value the old key does not open is left exactly as it is
and reported the same way as (e).

### Commands run and observed

```
$ bun test test/keys.test.ts            35 pass  0 fail  (178 expect() calls)
$ bun test test/shares.test.ts          28 pass  0 fail  (127 expect() calls)
$ bun test test/sync.test.ts            41 pass  0 fail  (213 expect() calls)
$ bun test host/shares.test.ts          20 pass  0 fail  (603 expect() calls)
$ bun test host/repo.test.ts            26 pass  0 fail  (265 expect() calls)
$ bun test host/health.test.ts           7 pass  0 fail
```

### Open findings

1. **`ensure` reads `GET /v1/keys/private` on every call that has a connection** — it is the only way
   to know whether the host holds the blob, and it is what makes case (a) repair a legacy row. The
   call happens on an unlock and on every snapshot that moved, so it is one extra small GET per
   changed snapshot. A `meta` flag ("this machine published a blob") would remove it from the steady
   state at the cost of a second source of truth; not done here.
2. **The activation path passes `reset: false` for an access-code activation of a person who already
   has keys on the host** (`session.announceActivated` reports `reset` only when this machine's vault
   was wiped). That machine's fresh pair then meets a host blob sealed under the previous salt, which
   does not open: case (c) reports `keys unavailable — sign in again` until the person signs in (which
   moves the cached salt and reports the reset). With `keys.pending.<person>` the pair is not lost:
   the same activation's `afterUnlock` publishes it. Reported rather than changed: `session.ts` is
   another slice's file.
3. **A `null` blob on a row whose public keys differ is replaced by a generated pair** (case b, the
   legacy window before any machine uploads a blob): the pair changes once and every colleague sees
   `changed` once. Documented, not special-cased.
4. **`KeyStatus.error` is reported but not drawn**: `keys.mine` answers the fingerprint alone, so
   Settings → Account cannot show `keys unavailable — sign in again` yet. A UI seam (a new RPC field)
   is a decision for the owner of `src/settings.ts`.

---

## Fixes — finding 2 (activation reset) and finding 4 (`keys.mine` status)

Owner assignment: close the two open findings of the "Key sync" section above. Both are K1; nothing
here changes a contract SP06 §2 pins (no spec edit — SP06 does not document the `keys.mine` shape).

### Files touched

| File | What changed |
| --- | --- |
| `backend/session.ts` | `adoptConnectedAccount` gained `activation?: boolean`; `announceActivated` gained the matching argument. `reset` is now `activation \|\| (lastWiped matched)` — an access-code activation (or the setup) always derives a fresh salt, so the pair sealed under the old `vaultKey` can never open; the wipe alone is what `host.signIn` still reports through. `ActivationEvent`/`onActivated` docs restated to "the pair must be regenerated". |
| `backend/main.ts` | `host.activate` passes `activation: true` to `adoptConnectedAccount` (one flag covers the setup and an access-code activation). The `onActivated` comment restated. **`keys.mine`** now returns `MineKeys` unchanged from `backend/keys.ts` (no more `null`-or-`{ fingerprint }` narrowing). |
| `backend/keys.ts` | `Keys.mine()` returns the new `MineKeys`: `localPair` (the `meta` row **and** the keychain value this `vaultKey` opens) decides the fingerprint, `pendingPublish` decides `pending`, and the two "no usable pair" answers become `unavailable` with the instruction in `message`. New `PENDING_PUBLISH` sentence. `clearPending` now runs wherever this machine adopts the host's pair, so an adopted pair can never leave the `pending` mark of a pair this machine once made. |
| `shared/types.ts` | **`MineKeys`** = `{ fingerprint: string \| null; status: 'ok' \| 'pending' \| 'unavailable'; message: string \| null }`; `keys.mine` → `[void, MineKeys]` (was `{ fingerprint } \| null`). |
| `src/settings.ts` | Account: `state.keys` is `MineKeys \| null`, `readOwnFingerprint` returns it, and `keyFingerprintCard()` shows the fingerprint when there is one, the `pending` note, or the `unavailable` sentence (`keys unavailable — sign in again`). |
| `test/keys.test.ts` | `mine()` assertions moved to the new shape; `unavailable` for a value the moved `vaultKey` cannot open; `ok`/`pending`/`ok`-after-publish transitions; the "no connection" test now pins `pending`; adopting the host's pair clears a stale `pending`. |
| `test/session.test.ts` | New test: an activation (`activation: true`) reports `reset: true` with no `wipeVault`, and a plain `adoptConnectedAccount` (a sign-in) still reports `reset: false`. |
| `docs/handovers/k1-k2-keys.md` | This section. |

### Findings 2 and 4, and how they are closed

**Finding 2 — an access-code activation of a person who already had host keys left the machine with
`keys unavailable — sign in again` forever.** `wipeResetVault` (main.ts) returns `false` whenever
`local.id !== personId` or the vault is empty — an F1 adoption, or a machine that never held the
account — so `announceActivated` reported `reset: false` and `keys.ensure` ran the non-regenerate
path, hit the host's blob sealed under the old `vaultKey` and refused (case e) without generating a
pair. The fix keeps the wipe decision (it still decides `wipedVault` in the answer and the local
`salt` cache) out of the key decision: an activation always chooses a fresh salt
(`randomSalt()` in `backend/main.ts`), so `activation: true` makes `reset: true` unconditionally, and
`ensure(regenerate: true)` adopts the host's blob **when this `vaultKey` opens it** (another machine
of the same activation already published) or generates and replaces both halves otherwise
(`keys.pending.<person>` covers a reset whose `PUT /v1/keys` could not go out).

**Finding 4 — `keys.mine` answered a fingerprint or `null`, so the card could not draw the
instruction.** It now answers the status and the sentence, and the Account card draws
`keys unavailable — sign in again` (unavailable) and the pending-publish note.

### Acceptance — evidence

| Item | How | Evidence |
| --- | --- | --- |
| Reset by access code replaces the pair on the host; no permanent `keys unavailable` | `activation: true` → `reset: true` → `ensure(regenerate)`; the host blob that cannot open is replaced by a fresh pair that is published (`markPending` + `PUT /v1/keys`) | `execucao` (`test/session.test.ts`: "an access-code activation reports a key reset even when no vault was wiped (K1)" — `reset: true` with no `wipeVault`; the pre-existing "a reported reset replaces the pair the key cannot open" drives the same `ensure(regenerate)` path against the host) |
| Account card shows the key status | `keys.mine` → `MineKeys` → `keyFingerprintCard()` | `execucao` (`test/keys.test.ts`: `ok`/`pending`/`unavailable` — `pending` on the O2 gate, `ok` once the host takes the pair, `unavailable` for a value the moved `vaultKey` cannot open, a locked session and a refused keychain); `leitura` (the card branches on `status`; the page was not driven in a window — SmokeK10/coordinator) |

```
$ bun test test/keys.test.ts test/session.test.ts
97 pass
0 fail
557 expect() calls
Ran 97 tests across 2 files. [137.00ms]
```

### For other owners

- **DocsK10**: no spec edit was needed (SP06 does not pin the `keys.mine` shape); the two Account
  cards' rule in `src/context.md` / `backend/context.md` names the old fingerprint-or-null result, so
  the module rows want the `MineKeys` status.
- **Coordinator / SmokeK10**: the smoke's `host.activate` steps now run `ensure(regenerate: true)`
  for a fresh activation; the outcome is the same (the pair is generated and published by the
  `afterUnlock` that closes the join, `keys.pending.<person>` bridging the gap), and a re-activation
  now replaces the pair instead of failing.

## Review fixes — M1 and L2 (`docs/handovers/block2-review.md`)

### M1 — a password change no longer leaves the host's blob sealed under the old `vaultKey`

`backend/keys.ts` gained a second `meta` mark, `keys.reseal.pending.<person>`:

- `Keys.beginReseal()` writes it, and `backend/main.ts`'s `session.changePassword` calls it **before**
  the vault moves (`main.ts:1578`). The order is the point: a host that refuses the new blob leaves
  the mark, and so does a process that dies between the change and the re-seal.
- `publish` clears it beside `keys.pending.` once `PUT /v1/keys` lands, and an adoption clears it too
  — an adopted blob is one the current `vaultKey` has just opened.
- `ensure`'s branch (a) no longer stops at "the public keys match": with the mark set it republishes
  the blob (`keys.ts:799`, the branch the review names at old `keys.ts:735`).
- `keys.mine` answers `pending` while the mark is set, and `src/settings.ts` reads `keys.mine` again
  right after a successful password change (`settings.ts:1821`), so Settings → Account says so
  without a reload.

Tests (`bun test test/keys.test.ts`, 40 pass): "a re-seal the host refused is repaired by the next
ensure (M1)" — the harness gained a put-only refusal (`refusePut`) so the host keeps answering
`GET /v1/keys/private` while refusing the write; it fails before the fix (the early return answers
`published: false` and `mine` says `ok`) and passes after. "a pair that is in step is not republished,
mark or no mark (M1)" pins the other side: the mark, not the code path, is what triggers it.

**Open finding, same id** (closed by the follow-up section at the end of this file): the window
*between* `session.changePassword` and `reSeal`'s local re-seal was unrecoverable, because there the
keychain value is sealed under the old `vaultKey` and so is the host's blob. The follow-up moves that
value into the session's own keychain batch; what follows is the state of the first fix.

### L2 — `peers.confirm` is bound to the fingerprint the person read

`Keys.confirm(personId, fingerprint)` refuses anything that is not the row's `pending_fingerprint`
(`keys.ts:979`) with `the key changed since this list was drawn — check the fingerprint again`;
`peers.confirm` takes `{ personId, fingerprint }` (`shared/types.ts`), `backend/main.ts` passes both,
and the Confirm button sends the fingerprint it displayed (`src/settings.ts` `confirmPeer`).

Tests (`test/keys.test.ts`): "confirm promotes the pending pair, and the peer is pinned again" now
carries the shown fingerprint and expects a refusal for the same call once nothing is pending, and
"confirm refuses a fingerprint the list is not showing (L2)" drives a third pair arriving between the
read and the click — the call is refused, the pin table does not move, and the fingerprint the newest
list shows is the one that goes through.

Spec: SP06 §2 (pinning, the confirmation's fingerprint) and SP02 §7 (the `keys.reseal.pending` mark);
SP02 §9 for M3, below in `k10-smoke.md`.

## Review fix — M1, the residual window closed (follow-up)

The open finding above is closed: the pair's keychain value no longer depends on `reSeal` running
after the vault has moved.

**The session's own batch takes it.** `reencryptVaultItems` (`backend/vault.ts`) gained a fifth
parameter, `extra: readonly { key: string; aad: string }[]` — `bv1.` values that live under the same
`vaultKey` but are not vault items. They are opened first, with the vault set, and written in the
same `planned` pass, so the existing abort discipline still holds for the vault and a crash cannot
leave one half of the batch behind. `session.changePassword` passes the E02 pair's own item
(`{ key: keysKey(person.id), aad: keysKey(person.id) }`, `backend/session.ts:944`): that value is a
`bv1.` envelope over the same key with the same string as its AAD (SP06 §2), so the session can move
it without knowing what it holds. An extra value the keychain does not hold, or one neither key
opens, is **skipped** rather than fatal: such a pair is already unusable (a reset elsewhere) and must
not block a password change; `keys.reSeal` is what reports it.

**`reSeal` now accepts a value the session already moved** (`backend/keys.ts:853`): it opens with
`previousVaultKey`, and when that fails it opens with the key in hand — then there is no second write,
only the publish. Before, a session that had done its job made `reSeal` answer
`keys unavailable — sign in again` about its own work, and the blob waited for the next `ensure`.

**Every window is now covered.** Death between the batch and the verifier: the old password still
works, the host's blob (still under the old key, since nothing published) opens with it, and the next
`ensure` adopts and re-stores — consistent again. Death after the verifier, or a host that refuses the
blob: the value is already under the new key, `keys.mine` says `pending`, and the next `ensure`
republishes the blob through the mark (the fix above).

**Tests** (`bun test test/keys.test.ts test/session.test.ts test/vault.test.ts`, 124 pass):
`test/session.test.ts` "the E02 pair of this machine moves in the same batch, under the new
`vaultKey` (M1)" writes the item as `backend/keys.ts` writes it, changes the password and asserts it
opens with the new key and no longer with the old (fails before this fix: the item stayed under the
old key), plus "a value of the batch the keychain does not hold is skipped, not fatal (M1)" for a
machine that never ran `ensure`. `test/keys.test.ts` "a value the session already moved is published
without a second write (M1)" puts the harness in exactly that state (`resealLocal`), refuses the
host's write and asserts the error is the **host's** (`could not reach the host`; pre-fix it was
`keys unavailable — sign in again`), that the keychain value is byte-identical afterwards (no second
re-seal), that `mine` is `pending`, and that the next `ensure` publishes the blob and turns it `ok`.

Files: `backend/vault.ts`, `backend/session.ts`, `backend/keys.ts`, `test/session.test.ts`,
`test/keys.test.ts`, SP02 §7, `backend/context.md` (session.ts and vault.ts rows).
