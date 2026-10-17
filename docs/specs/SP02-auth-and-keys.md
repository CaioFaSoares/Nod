# SP02 — Auth and keys

Why: `docs/epics/E01-connected-mode.md` §7. Where the code goes: `shared/auth.ts` (derivation, both
runtimes), `shared/host-api.ts` (the access-code format — generate/format/normalize/validate and
`normalizeEmail`; they landed there, not in `shared/auth.ts`, c1), `host/auth.ts` (host side),
`backend/session.ts` and `backend/vault.ts` (Nod side).

## 1. Password → keys

```text
password  = the typed string, Unicode NFC, UTF-8 bytes
salt      = 16 random bytes (host: per person, chosen by the Nod at activation; local mode: per local account)
master    = PBKDF2-HMAC-SHA256(password, salt, iterations = PBKDF2_ITERATIONS (600 000), 32 bytes)
authKey   = HMAC-SHA256(key = master, data = UTF-8 "bond/auth/v1")    → 32 bytes, sent as base64url
vaultKey  = HMAC-SHA256(key = master, data = UTF-8 "bond/vault/v1")   → 32 bytes, never leaves the machine
localKey  = HMAC-SHA256(key = master, data = UTF-8 "bond/local/v1")   → 32 bytes, offline unlock check (§6)
```

- One PBKDF2 per unlock or sign-in; the three HMACs are cheap.
- `shared/auth.ts` exports `deriveKeys(password, salt, iterations) → { authKey, vaultKey, localKey }`
  using only `crypto.subtle` (PBKDF2 and HMAC are native in the Nod runtime, `docs/tinyjs.md` §5,
  and in Bun).
- **Test vectors** (story H3): the test suite fixes three `(password, salt, iterations)` triples,
  including a non-ASCII password, with the expected outputs computed under Bun. The same vectors
  run inside the Nod backend under txiki.js through the smoke harness. Same bytes, or H3 fails.
- H3 also measures one `deriveKeys` at 600 000 iterations in the Nod runtime on the owner's
  machine, and records it in `docs/tinyjs.md` §5 (answers `docs/canonico.md` §23 q6).

## 2. Host storage of `authKey`

`auth_hash = await Bun.password.hash(base64url(authKey), { algorithm: 'argon2id' })` with Bun's
defaults (`https://bun.com/docs/runtime/hashing`). Verified with `Bun.password.verify`. The salt is
stored in clear (`people.salt`).

## 3. Access and setup codes

| | Access code | Setup code | Invite code |
| --- | --- | --- | --- |
| Purpose | `activate`: one person's first sign-in or reset | `setup`: creates the first admin | `invite`: joins the guild — whoever holds it creates their own account (RF-59) |
| Random | 5 bytes → 8 Crockford base32 chars | 10 bytes → 16 chars | 15 bytes → 24 chars (it opens accounts for anyone holding it, several times) |
| Shown as | `XXXX-XXXX` | `XXXX-XXXX-XXXX-XXXX` | `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` |
| TTL | 72 h | 24 h | the admin's choice at creation, 1 minute to 30 days, or never |
| Wrong tries | 5, then revoked | 5, then revoked | — the invite is bound to nobody, so a dead one is the one `invalid invite` (RF-59), not an attempt count |
| Issued by | admin (`POST /v1/admin/people/:id/code`) | `bun run setup-code` in the container, only while no admin exists | admin (`POST /v1/admin/invites`), with the roles it grants (never an admin one), a max-use count and an expiry |
| Bound to | the person's email | whoever redeems it gives email and name | nobody: the person gives email, name and password; the host creates them with the invite's roles |

- Alphabet: Crockford base32 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
- Normalization before hashing: uppercase; drop spaces and hyphens; `O→0`, `I→1`, `L→1`. A `U` is
  invalid.
- Stored: hex SHA-256 of the normalized code. The plain code is returned once and never logged.
- Issuing a new code for a person revokes their previous unused one.
- `setup-code` prints only to the terminal that ran it. Running it again revokes the previous one.
  It refuses when an admin exists.
- The kind is read from the length alone (`shared/host-api.ts`: `CODE_LENGTH`, `codeKindOf`), so
  `POST /v1/auth/join` refuses an access or setup code with the same `invalid invite` an unknown
  invite answers, and pays the argon2id hash before that branch (the F4 rule of §5; the invite kind
  was added in 0.5.0, RF-59).
- An invite is not a row of `access_codes`: `host/repo.ts` keeps it in `guild_invites` (SP01 §2,
  migration 5) with its roles, `max_uses`, `uses`, `expires_at` and `revoked_at`. `uses` grows only
  when the join created the person — a taken email (`409`) or a rolled-back join spends nothing.
- **An invite never grants an admin role** (RF-59): it is a bearer code pasted into chats, so a role
  with `admin = 1` in the create body is `400 { error: 'an invite cannot grant an admin role' }` and
  stores nothing — and the join re-checks the roles it would grant, because a role can be promoted to
  admin after the invite was made. That re-check answers the same `401 invalid invite` and spends no
  use, and the invite works again if the role is demoted or removed. Making somebody an admin stays
  `PATCH /v1/admin/people/:id`.
- Redeeming an invite is public (`POST /v1/auth/join`): it takes the account's email, name, salt and
  `authKey`, and `POST /v1/auth/invite` shows the guild, its icon (base64url PNG) and the roles the
  invite grants before any account is typed. Both sit inside §5's address budget, and a failed join
  spends that email's budget.

## 4. Salt lookup without an existence oracle

`POST /v1/auth/salt { email }` always answers `{ salt, iterations }`:

- an activated person: their stored salt;
- anyone else: `base64url(HMAC-SHA256(host-secret, "fake-salt/" + email)[0..16])`, so it stays the
  same for repeated asks.

`iterations` is `600000` for everyone. Login then costs one argon2id verify. For an unknown email
the host verifies against a fixed dummy hash, so timing doesn't tell who exists (same idea as
`backend/session.ts`'s fixed hash).

## 5. Sessions

- Token: 32 random bytes, base64url, returned once. The host stores hex SHA-256.
- Sent as `Authorization: Bearer <token>`.
- Sliding expiry: every authenticated request sets `last_seen_at = now`, `expires_at = now + 14 d`.
- Revoked by:
  - the person, for any of their sessions;
  - the admin, for anyone's;
  - disabling the person, which revokes all of theirs.
- **Nod side**: the token is kept under `nod.host.<hostKid>.<personId>`, never in plaintext in SQLite
  or in `store.json`. It is read only after the local unlock (§6). Since 0.5.1 (RF-63) it is sealed
  as a `bv1.` value under `vaultKey` with that string as AAD (§8) and kept in the `secret` table of
  `nod.db` (`backend/secret-store.ts` `sealedSecrets`); a password change re-seals it in the §7 batch.
- Errors: every sign-in failure answers `401 { "error": "invalid credentials" }`; every code failure
  answers `401 { "error": "invalid code" }`.
- Rate limits answer `429 { "error": "too many attempts" }`:
  - per IP: 30 auth requests per minute;
  - per email: 10 failed attempts per 15 minutes.

## 6. Local unlock (Nod)

The local account keeps working offline. Today it stores a `PasswordHash` (`shared/types.ts`). New
format, `PasswordHashV2`:

```ts
{ algorithm: 'BOND-KDF-V1', salt: string /* base64url 16 */, iterations: number, check: string /* base64url SHA-256(localKey) */ }
```

- Unlock: `deriveKeys(password, salt)`, compare `SHA-256(localKey)` to `check` in constant time. On
  success, `vaultKey` and (connected) `authKey` are kept in memory for the session. `lock()`
  forgets them.
- **Connected mode**: the salt is the host salt. The Nod caches it next to the host record (SP05
  §2), so offline unlock derives the same keys.
- **Migration**: the first unlock of a v1 account verifies the old PBKDF2 hash, then writes
  `PasswordHashV2` with a fresh salt. Local mode only; a connected account is created with V2.
- The unlock backoff stays as it is (`backend/session.ts`).

## 7. Password change and reset

- **Change** (online): `POST /v1/auth/password { currentAuthKey, newSalt, newAuthKey }` with the
  session. The host verifies the current key, stores the new salt and hash, and keeps the session.
  The Nod then re-encrypts every vault item with the new `vaultKey` (§8) and rewrites
  `PasswordHashV2`, in that order. If the Nod crashes between the two steps, the next unlock tries
  the new password first and re-encrypts any item that still opens with the old key.
  - The E02 pair of SP06 §2 does not change with the password, but its keychain value
    (`nod.keys.<person>`, a `bv1.` value under the same `vaultKey`, AAD = the same string) is
    **re-sealed in the very batch that moves the vault items** (`reencryptVaultItems`, which takes
    those extra values with their AADs), so no crash can leave the pair under a key nothing holds;
    the public halves stay untouched. Only the host's blob is left, published right after by
    `backend/keys.ts` `reSeal`. A `keys.reseal.pending.<person>` mark is written **before** the vault
    moves and cleared only once the host took the new blob, so a host that refuses — or a crash
    between the batch and the publish — leaves the blob republishable by the next `ensure` instead of
    leaving the host with a blob sealed under a key nobody holds, and the next machine of that person
    waiting forever (`keys.mine` reports `pending` meanwhile). Review finding M1.
- **Reset** (new access code): activation stores a new salt. The Nod detects a salt change at
  sign-in (cached salt ≠ host salt). It then:
  - tells the person their saved logins on this machine will be removed;
  - deletes every `nod.cred.<person>.*` item and its index;
  - regenerates the E02 key pairs (SP06 §2).

## 8. Vault encryption (story V1)

Keychain value of each credential, replacing today's plaintext:

```text
"bv1." + base64url( nonce(12) || AES-256-GCM(key = vaultKey, iv = nonce, aad = UTF-8 keychainKey, plaintext = UTF-8 JSON { "username": "...", "secret": "..." }) )
```

- New nonce on every write.
- AAD binds the value to its keychain key, so a value moved to another item doesn't open.
- Values without the `bv1.` prefix are legacy plaintext: on the first unlock after V1 ships they're
  re-encrypted.
- The Windows keychain limit of 2560 UTF-8 bytes per value (`docs/canonico.md` §11) still applies
  after encoding: about 1.8 KB of JSON. Longer values are refused with a clear message.
- Each vault index row also stores `origin` (the tool's origin when saved). The login adapter fills
  only when the window's origin equals it (B9, RF-38).
- Since 0.5.1 (RF-63) these values — and the E02 pair's `nod.keys.<person>` — are kept in the
  `secret` table of `nod.db` under the same key instead of one keychain item each; only `bv1.` values
  are ever written there, and outside `nod.bio.*` the backend never reads, writes or deletes a
  keychain item in normal use (each such call was a password prompt whenever the item's ACL did not
  name the running build). What an older Nod left in the keychain is copied once, read-only, right
  after the first unlock — only keys the table lacks; a plaintext is sealed on the way in — and a
  `meta` mark (`keychain_imported.<person>`) is set after that one attempt whatever happened: an item
  the keychain refused (the person denied the prompt) is counted in `keychain_import_skipped.<person>`
  and never retried, so it can never bring the prompt back. The old items stay in the keychain untouched.

## 9. Biometrics

Today `nod.bio.<person>` holds the person id as a marker (`backend/session.ts`). With V1 it holds
`base64url(vaultKey)` instead. That is the trade-off the owner accepted (E01 §7).

- Biometric unlock: `app.authenticate`, then read `vaultKey` from that item; `authKey` isn't needed
  offline.
- The password still unlocks where biometrics exist: the entry screen keeps its password field and
  offers the biometrics button beside it, so the item is a shortcut, not the only way in
  (`src/app.ts` `renderUnlock`).
- Any host call that needs a fresh sign-in after the session token expires asks for the password.
- Enabling or disabling biometrics writes or deletes the item.
- Linux has no biometrics (`docs/canonico.md` §9), so the item never exists there.

- Since 0.5.1 (RF-63) this item is the only one the Nod keeps in the system keychain. Whether a
  person has it is a `store.json` flag (`biometric_people`, `{ [personId]: boolean }`), written beside
  every write or delete of the item, so the entry screen and the password unlock never read the
  keychain; a person with no flag yet (enabled by an older Nod) is answered by one read of the item.
  The biometric unlock reads the item once, after `app.authenticate`.

The gate for reveal, copy, accept and send (E02 §5) is `app.authenticate` wherever the runtime
reports the `authenticate` capability — the **machine's** capability, not the per-person shortcut of
`session.state.biometric` (`docs/canonico.md` §22, "gate where biometrics exist"). The page reads
that capability from `nod.info` (`biometricAvailable`) and sends no password there: the operating
system's prompt is what runs. Since 0.5.1 a confirmation — the Touch ID unlock, or a gate that
passed — covers the same person's next gated calls until 15 minutes pass without one (`GATE_WINDOW_MS`
in `backend/main.ts`); a lock forgets it (owner, 2026-10-17: "peça sempre no máximo uma vez").

A typed password is the factor only where the capability is absent (Linux, `docs/canonico.md` §9)
and, in a non-release dev run (`tinyjs dev`), where it exists too — the Proposto "gate in a dev run"
of `docs/canonico.md` §22, which is what lets the unattended connected smoke pass the gate with the
account's password (`test/smoke/connected.html`). The run's mode is read once at start-up from the
build-mode stamp `scripts/gen-config.ts <dev|build>` leaves beside the seed in `resources/`
(`shared/build-mode.ts`, `nod.info.devRun`); it comes from no environment variable, no seed and no
page, and a release's `"resources"` list never carries the stamp — so a release build answers
`false` and never takes a password on a machine that has `authenticate` — until its system prompt
fails.

**Fallback when the system prompt fails (0.5.0, Proposto in `docs/canonico.md` §22).** The
runtime reports `authenticate` per OS, not per enrollment: Windows without Hello enrolled reports
it and then answers `false` to every prompt (`~/.tinyjs/skill/references/platforms.md`, "false
where not enrolled"), which left such a person unable to accept a share, reveal, copy or send. Now a
prompt that does not confirm answers `GATE_PROMPT_FAILED` (`shared/types.ts`), and for the rest of
that unlocked session the backend also takes the typed password (`gateFactor`'s `promptFailed`,
cleared at every lock and unlock). The page reopens the same action on the password prompt, and
the password is verified against the unlocked person's verifier exactly as on Linux.

Reveal shows a countdown (10 s) and then clears the value from the page. The deadline is a wall-clock
instant, and the page drops the value the moment it is hidden, so a throttled background page cannot
keep it past the ten seconds (review finding L5).
