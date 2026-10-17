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
4. **Two machines of one account fight over one pair, and this slice re-publishes the local one.**
   SP06 §2 has one pair per account, generated at activation and again after a reset; it says nothing
   about a second machine signing in. This slice's rule (from the assignment): a machine whose stored
   private halves belong to this account re-publishes them when the snapshot's own entry differs —
   which is what makes `ensure` after an applied snapshot meaningful. The consequence is real and
   worth the coordinator's eye: the last machine to sync owns the account's pair, and shares sealed
   to the previous one stop opening on the machine that published it (the `invalid share` decline of
   SP06 §3, which E02 §3 already answers with a re-send). A per-device pair, or a rule that the first
   publisher keeps the account's, are spec decisions.
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
- **Coordinator**: findings 1 (the four extra columns), 4 (two machines, one pair) and 10
  (`bond.keys` vs `nod.keys`) are the ones that need a spec answer; s0's finding stands that
  `docs/arquitetura.md` §3/§4 have no entry for `shared/seal.ts` (and now none for `backend/keys.ts`).

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
- **`docs/specs/SP06-credential-sharing.md` and `docs/arquitetura.md`**: not edited; findings 1, 4
  and 10 above and s0's entry finding are reported instead.

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, written only by its owner: the files
touched, the acceptance and how it was met, the command and the observation, and what was left out).
The state of #29 and #30 is the GitHub issues; this file closes nothing and decides no spec.
