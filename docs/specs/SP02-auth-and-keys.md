# SP02 — Auth and keys

Why: `docs/epics/E01-connected-mode.md` §7. Where the code goes: `shared/auth.ts` (derivation,
code format, both runtimes), `host/auth.ts` (host side), `backend/session.ts` and `backend/vault.ts`
(Bond side).

## 1. Password → keys

```text
password  = the typed string, Unicode NFC, UTF-8 bytes
salt      = 16 random bytes (host: per person, chosen by the Bond at activation; local mode: per local account)
master    = PBKDF2-HMAC-SHA256(password, salt, iterations = PBKDF2_ITERATIONS (600 000), 32 bytes)
authKey   = HMAC-SHA256(key = master, data = UTF-8 "bond/auth/v1")    → 32 bytes, sent as base64url
vaultKey  = HMAC-SHA256(key = master, data = UTF-8 "bond/vault/v1")   → 32 bytes, never leaves the machine
localKey  = HMAC-SHA256(key = master, data = UTF-8 "bond/local/v1")   → 32 bytes, offline unlock check (§6)
```

- One PBKDF2 per unlock or sign-in; the three HMACs are cheap.
- `shared/auth.ts` exports `deriveKeys(password, salt, iterations) → { authKey, vaultKey, localKey }`
  using only `crypto.subtle` (PBKDF2 and HMAC are native in the Bond runtime, `docs/tinyjs.md` §5,
  and in Bun).
- **Test vectors** (story H3): the test suite fixes three `(password, salt, iterations)` triples,
  including a non-ASCII password, with the expected outputs computed under Bun. The same vectors
  run inside the Bond backend under txiki.js through the smoke harness. Same bytes, or H3 fails.
- H3 also measures one `deriveKeys` at 600 000 iterations in the Bond runtime on the owner's
  machine, and records it in `docs/tinyjs.md` §5 (answers `docs/canonico.md` §23 q6).

## 2. Host storage of `authKey`

`auth_hash = await Bun.password.hash(base64url(authKey), { algorithm: 'argon2id' })` with Bun's
defaults (`https://bun.com/docs/runtime/hashing`). Verified with `Bun.password.verify`. The salt is
stored in clear (`people.salt`).

## 3. Access and setup codes

| | Access code | Setup code |
| --- | --- | --- |
| Purpose | `activate`: one person's first sign-in or reset | `setup`: creates the first admin |
| Random | 5 bytes → 8 Crockford base32 chars | 10 bytes → 16 chars |
| Shown as | `XXXX-XXXX` | `XXXX-XXXX-XXXX-XXXX` |
| TTL | 72 h | 24 h |
| Wrong tries | 5, then revoked | 5, then revoked |
| Issued by | admin (`POST /v1/admin/people/:id/code`) | `bun run setup-code` in the container, only while no admin exists |
| Bound to | the person's email | whoever redeems it gives email and name |

- Alphabet: Crockford base32 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
- Normalization before hashing: uppercase; drop spaces and hyphens; `O→0`, `I→1`, `L→1`. A `U` is
  invalid.
- Stored: hex SHA-256 of the normalized code. The plain code is returned once and never logged.
- Issuing a new code for a person revokes their previous unused one.
- `setup-code` prints only to the terminal that ran it. Running it again revokes the previous one.
  It refuses when an admin exists.

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
- **Bond side**: the token lives in the keychain under `bond.host.<hostKid>.<personId>`, never in
  SQLite or `store.json`. It is read only after the local unlock (§6).
- Errors: every sign-in failure answers `401 { "error": "invalid credentials" }`; every code failure
  answers `401 { "error": "invalid code" }`.
- Rate limits answer `429 { "error": "too many attempts" }`:
  - per IP: 30 auth requests per minute;
  - per email: 10 failed attempts per 15 minutes.

## 6. Local unlock (Bond)

The local account keeps working offline. Today it stores a `PasswordHash` (`shared/types.ts`). New
format, `PasswordHashV2`:

```ts
{ algorithm: 'BOND-KDF-V1', salt: string /* base64url 16 */, iterations: number, check: string /* base64url SHA-256(localKey) */ }
```

- Unlock: `deriveKeys(password, salt)`, compare `SHA-256(localKey)` to `check` in constant time. On
  success, `vaultKey` and (connected) `authKey` are kept in memory for the session. `lock()`
  forgets them.
- **Connected mode**: the salt is the host salt. The Bond caches it next to the host record (SP05
  §2), so offline unlock derives the same keys.
- **Migration**: the first unlock of a v1 account verifies the old PBKDF2 hash, then writes
  `PasswordHashV2` with a fresh salt. Local mode only; a connected account is created with V2.
- The unlock backoff stays as it is (`backend/session.ts`).

## 7. Password change and reset

- **Change** (online): `POST /v1/auth/password { currentAuthKey, newSalt, newAuthKey }` with the
  session. The host verifies the current key, stores the new salt and hash, and keeps the session.
  The Bond then re-encrypts every vault item with the new `vaultKey` (§8) and rewrites
  `PasswordHashV2`, in that order. If the Bond crashes between the two steps, the next unlock tries
  the new password first and re-encrypts any item that still opens with the old key.
- **Reset** (new access code): activation stores a new salt. The Bond detects a salt change at
  sign-in (cached salt ≠ host salt). It then:
  - tells the person their saved logins on this machine will be removed;
  - deletes every `bond.cred.<person>.*` item and its index;
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

## 9. Biometrics

Today `bond.bio.<person>` holds the person id as a marker (`backend/session.ts`). With V1 it holds
`base64url(vaultKey)` instead. That is the trade-off the owner accepted (E01 §7).

- Biometric unlock: `app.authenticate`, then read `vaultKey` from that item; `authKey` isn't needed
  offline.
- Any host call that needs a fresh sign-in after the session token expires asks for the password.
- Enabling or disabling biometrics writes or deletes the item.
- Linux has no biometrics (`docs/canonico.md` §9), so the item never exists there.

The gate for reveal, copy, accept and send (E02 §5) calls `app.authenticate` each time, or asks for
the password where biometrics are unavailable. Reveal shows a countdown (10 s) and then clears the
value from the page.
