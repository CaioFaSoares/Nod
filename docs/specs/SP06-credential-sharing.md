# SP06 — Credential sharing

Why: `docs/epics/E02-credential-sharing.md`. Pure crypto in `shared/seal.ts` (new), run under Bun
for tests and under txiki.js in the Nod backend. Spike S0 proves both produce and open the same
bytes before anything else in this spec is built.

## 1. Primitives

| Need | Primitive | Where it's native |
| --- | --- | --- |
| Key agreement | X25519 (`crypto.subtle` `deriveBits`) | txiki.js (`docs/tinyjs.md` §5); Bun — S0 confirmed, both runtimes |
| Signature | Ed25519 (`crypto.subtle` `sign`/`verify`) | same |
| KDF | HKDF-SHA256, **written in `shared/seal.ts` on top of HMAC** (RFC 5869), so it doesn't depend on `subtle` HKDF support | HMAC is native in both |
| Cipher | AES-256-GCM, 12-byte nonce | both |

S0 ran: X25519, Ed25519, AES-256-GCM and HKDF are all present in both runtimes and produce the same
bytes, cost per operation in `docs/tinyjs.md` §5. HKDF **is** native in both (~0.01 ms per call), so
the hand-rolled-over-HMAC path of this table is portability, not necessity, and it costs no extra
round trip beyond the `seal`/`open` figures (s0). The fallback below never fired.

If S0 finds X25519 or Ed25519 missing in either runtime, E02 stops there and the owner chooses
another route; nothing in E02 is built on an unproven primitive.

## 2. Key pairs

- Generated at activation (and again after a reset), in the Nod backend:
  - one X25519 pair for receiving;
  - one Ed25519 pair for signing.
- The **private** keys are exported as PKCS#8, encrypted like a vault value (`bv1.` format, SP02 §8,
  AAD `nod.keys.<person>`), and stored in the keychain under `nod.keys.<person>`.
- The **public** keys go to `PUT /v1/keys` as raw 32 bytes, base64url.
- **Fingerprint** of a person: SHA-256 of `x25519Public || ed25519Public`, first 10 bytes, Crockford
  base32 `XXXX-XXXX-XXXX-XXXX`, shown in Settings → Account.
- **Pinning**: the local table `peer_keys(person_id PK, x25519, ed25519, fingerprint, first_seen,
  confirmed_at)`.
  - On first sight, pin.
  - On a different key, mark the peer `changed`; sending to them is refused until the person
    confirms in the UI (RF-45).

## 3. Sealed share format

```text
payload  = UTF-8 JSON {
  "v": 1, "credentialId", "toolId", "toolOrigin", "label", "username", "secret",
  "scope": "role" | "org", "from": <personId>, "to": <personId>, "kind": "send" | "assign" | "update",
  "issuedAt"
}
eph      = fresh X25519 key pair
shared   = X25519(eph.private, recipient.x25519Public)                         -- 32 bytes
key      = HKDF-SHA256(ikm = shared, salt = eph.public || recipient.x25519Public, info = "bond/share/v1", 32)
nonce    = 12 random bytes
ct       = AES-256-GCM(key, nonce, aad = UTF-8 (credentialId + "|" + to), payload)
body     = 0x01 || eph.public(32) || nonce(12) || ct
sig      = Ed25519(sender.ed25519Private, body)                                -- 64 bytes
sealed   = base64url(body || sig)
```

**Opening**:

1. Split `sig` (last 64 bytes).
2. Verify with the **pinned** Ed25519 key of `from`, not the one in the snapshot if they differ.
3. Derive the key and decrypt. The opener supplies the recipient's **own x25519 public key** besides
   its private key: the HKDF salt is `eph.public || recipient.x25519Public`, and a PKCS#8 private key
   cannot yield the public half (s0).
4. Check `payload.to == me`, and that `credentialId`, `toolId` and `kind` match the host's metadata
   for the share.
5. Check the tool is visible to me and `toolOrigin` equals that entry's origin.

Any failure: decline with reason `invalid share`; no partial state.

## 4. Flows

- **Send**:
  1. Gate (biometrics).
  2. Read the credential from the vault.
  3. Pick recipients the scope allows (§5).
  4. Seal one copy per recipient.
  5. `POST /v1/shares` with `kind: 'send'`.
  6. The sender becomes the owner holder if not yet one.
- **Accept**:
  1. Gate.
  2. Open the share.
  3. Store it as a vault item with `origin = toolOrigin`, keeping `credentialId` in the index.
  4. `POST /v1/shares/:id/accept`.
- **Assign** (admin):
  1. `PUT /v1/admin/assignments`.
  2. On each sync, the admin's Nod reads `GET /v1/admin/assignments/missing`. For members without a
     copy it shows a prompt; after the gate it seals and sends them with `kind: 'assign'`.
- **Update**:
  1. When the owner edits a shared credential, the Nod seals the new value to every current holder
     with `kind: 'update'`.
  2. The receiver's Nod replaces the item on accept. Accepting an update to a credential you
     already hold needs no gate, because nothing is shown.
- **Revoke a holder**: `DELETE /v1/credentials/:id/holders/:personId`. The owner's snapshot then
  lists the credential in `rotationPending`, and the vault shows "rotation pending" until the owner
  saves a new secret, which triggers an update to the remaining holders.

## 5. Scope

| Scope | Nod offers as recipients | Host accepts when |
| --- | --- | --- |
| `role` (default) | people sharing ≥ 1 role with the sender **and** granted the tool | the same check, on its data |
| `org` | every member (`kind = member`) granted the tool | same |
| `blocked` | none; no send button | never accepts a share for that `credentialId` |

- The scope is set by the credential's owner, or by the admin for an assignment. It travels inside
  the sealed payload, and the host keeps it on the holder rows.
- A receiver's Nod re-sending a credential applies the scope from the payload, never a wider one.
- Clients (`kind = client`, E04) never receive `org` shares.

## 6. Acceptance

- **S0**: vectors sealed under Bun open under txiki.js, and the reverse; a flipped bit in `body`,
  `sig` or the AAD fails; cost per seal/open recorded.
- **Host**: a dump of `host.db` after a send contains no username or secret (RF-44).
- **Pinning**: changing a peer's key on the host blocks sending until confirmed (RF-45).
- **Scope**: a `role` share to someone with no common role is refused by both the Nod and the
  host; `blocked` shows no send action (RF-53).
- **Holders**: after accept, both sides list both people with date and scope (RF-54).
