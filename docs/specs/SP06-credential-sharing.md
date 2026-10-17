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
- **One pair per person, not per machine** (`docs/canonico.md` §22): the private keys are exported as
  PKCS#8, encrypted like a vault value (`bv1.` format, SP02 §8, AAD `nod.keys.<person>`), and stored
  in the keychain under `nod.keys.<person>`.
  - The first machine to activate seals the same pair a second time — a `bv1.` value under AAD
    `nod.keys.private/v1|<person>`, whose plaintext is UTF-8 JSON
    `{ x25519Pkcs8, ed25519Pkcs8, x25519Public, ed25519Public }` (base64url) — and publishes it with
    the public keys, as the optional `privateSealed` of `PUT /v1/keys`.
  - Every other machine of that person downloads it with `GET /v1/keys/private` (its own row only)
    and opens it with the `vaultKey` the same password and the host's salt give (SP02 §1), instead of
    generating a pair of its own: a machine that published a competitor is what turns every
    colleague's pin `changed`.
  - The host stores the blob as opaque ciphertext and never opens it; `Snapshot.people` never carries
    it. A reset replaces both halves (new public keys, new blob). A password change re-seals the blob
    under the new `vaultKey` — the public keys do not move, so no colleague is asked to confirm.
- The **public** keys go to `PUT /v1/keys` as raw 32 bytes, base64url.
- **Fingerprint** of a person: SHA-256 of `x25519Public || ed25519Public`, first 10 bytes, Crockford
  base32 `XXXX-XXXX-XXXX-XXXX`, shown in Settings → Account.
- **Pinning**: the local table `peer_keys(person_id PK, x25519, ed25519, fingerprint, first_seen,
  confirmed_at, pending_x25519, pending_ed25519, pending_fingerprint, pending_since)`. The six pinned
  columns are the pair this machine trusts; the four `pending_*` ones hold a pair that differs while
  the peer is `changed`, until the person confirms (k1).
  - On first sight, pin.
  - On a different key, mark the peer `changed`; sending to them is refused until the person
    confirms in the UI (RF-45). The confirmation carries the fingerprint the list showed and is
    refused when that is not the pair still pending (`peers.confirm { personId, fingerprint }`, L2):
    a host that publishes again between the read and the click is not confirmed unseen, and there is
    nothing to promote once nothing is pending.

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

Any failure of steps 2–5 declines with reason `invalid share`; no partial state. A key miss that is
not a verdict on the bytes — this Nod's own pair unavailable (a locked keychain) or no pinned key
for `from` yet — refuses without declining, leaving the share in the inbox (M2).

## 4. Flows

- **Send**:
  1. Gate (biometrics).
  2. Read the credential from the vault.
  3. Pick recipients the scope allows (§5).
  4. Seal one copy per recipient.
  5. `POST /v1/shares` with `kind: 'send'`.
  6. The sender becomes the owner holder only when the credential has no holder row at all. Once
     it has holders, `send` and `assign` come from a live (non-removed) holder — an admin included —
     and `toolId` must equal the credential's existing rows (`409` otherwise). The owner row is
     written once and never duplicated.
  7. The body's scope may narrow the scope stored on the owner row, never widen it (`403`); a
     `blocked` owner row refuses every share.
- **Accept**:
  1. Gate.
  2. Open the share with the **pinned** key of `from`. A sender flagged `changed` is still verified
     with the pinned (old) key, so a share signed before the rotation opens. A transient key miss
     (a locked keychain, a sender this Nod never pinned) refuses without declining: the share stays
     in the inbox. Only a real `open`/`match` failure declines with `invalid share`.
  3. Store it as a vault item with `origin = toolOrigin`, keeping `credentialId` in the index.
  4. `POST /v1/shares/:id/accept`.
  5. Two accepts of one share are serialized per share id, so a concurrent sync run cannot
     double-apply or roll back the winner.
  A settled share (accepted or declined) drops its `sealed` body from the cached snapshot at once.
- **Assign** (admin):
  1. `PUT /v1/admin/assignments`.
  2. On each sync, the admin's Nod reads `GET /v1/admin/assignments/missing`. For members without a
     copy it shows a prompt; after the gate it seals and sends them with `kind: 'assign'`.
  3. The action answers `{ sent, skipped }`; the dialog reports it. A direct `personId` assignment
     whose copy reached nobody throws the key-state reason (`recipient key changed` /
     `recipient has no pinned key`) instead of reporting a success. A `credentialId` generated by
     the action is kept on the item only after the host accepted it (the assignment row or the
     sealed copy), so a refused action leaves no orphan id and the scope stays settable.
- **Update**:
  1. When the owner edits a shared credential, the Nod seals the new value to every current holder
     with `kind: 'update'`. The owner's save is its own intent — the person just typed the secret —
     so it is not gated a second time; the fan-out is best effort, and a host that cannot be reached
     leaves a pending marker retried on the next sync.
  2. The receiver's Nod replaces the item on accept. An `update` to a credential already held is
     applied by the sync that delivers it, with no gate and nothing shown — **but only when its
     `from` is the credential's live owner holder in the verified snapshot**; any other sender's
     `update` waits in the inbox for the gated accept (a member who learned a `credentialId` cannot
     overwrite every holder silently). A holder whose pinned key is `changed` is skipped with a
     warning when fanning out (RF-45).
  3. An `update` whose `issuedAt` is not newer than the last payload this Nod applied to that
     credential is a replay: it is declined as `invalid share`. An accepted or declined share drops
     its ciphertext from the cached snapshot at once.
- **Revoke a holder**: `DELETE /v1/credentials/:id/holders/:personId`. The owner's snapshot then
…
  an admin. A revoked member of an assigned role is not listed as missing again — giving the copy
  back takes the explicit direct assignment (`docs/canonico.md` §22).
- **List holders**: each credential's vault card shows its holders with date and scope (RF-54). An
  admin's Settings → Vault also carries a "Credential holders" card, read from the `holders.list`
  RPC, that lists the holders of every credential of the guild — including the credentials the
  admin's own vault does not hold. The list comes from the verified snapshot
  (`Snapshot.holders`, which the host answers whole for an admin), the names from its roster, and
  the tool titles from the effective catalog; a credential this Nod cannot name a tool for is listed
  under its own id (review finding M7).

## 5. Scope

| Scope | Nod offers as recipients | Host accepts when |
| --- | --- | --- |
| `role` (default) | people sharing ≥ 1 role with the sender **and** granted the tool | the same check, on its data |
| `org` | every member (`kind = member`) granted the tool | same |
| `blocked` | none; no send button | never accepts a share for that `credentialId` |

- The owner holder (or an admin) sets the credential's scope through
  `PUT /v1/credentials/:id/scope`; the host writes it to every holder row. The owner row is the
  reference: every later share may narrow it, never widen it (`403 scope wider than the
  credential`), and a `blocked` owner row refuses every share before any row is written.
- On the Nod, a credential that already has holder rows calls that route **before** storing the
  scope locally, so `blocked` reaches the host and a refused call changes nothing. A credential with
  no holder row (never shared, or a first send the host refused) stores the scope locally; it
  travels with the first send. The scope is never widened on a re-send: a receiver's copy keeps the
  scope of its payload.
- The host also refuses a share to oneself and a share from a sender who cannot see the tool, and
  bounds a batch (`items` 1–500) and each sealed copy (64 KB) — hardening of the wire, not a new
  flow.
- A receiver's Nod re-sending a credential applies the scope from the payload, never a wider one.
- **An assignment is not a member-to-member share.** For `kind: 'assign'` the `role` row's "shares
  ≥ 1 role with the sender" rule does not apply — the admin who assigns to `team` need not be in
  `team` — and the host accepts the copy instead when the recipient is a member of a role the
  credential is assigned to; a credential with no assignment row is the direct person assignment.
  Every other rule of the table holds for every kind, and `assign` still requires an admin who is a
  live holder once the credential has holder rows.
- Clients (`kind = client`, E04) never receive `org` shares, and the admin's missing list leaves them
  out for the same reason (SP03 §3, K8). A revoked holder stays out of that list (canonico §22).

## 6. Acceptance

- **S0**: vectors sealed under Bun open under txiki.js, and the reverse; a flipped bit in `body`,
  `sig` or the AAD fails; cost per seal/open recorded.
- **Host**: a dump of `host.db` after a send contains no username or secret (RF-44).
- **Pinning**: changing a peer's key on the host blocks sending until confirmed (RF-45).
- **Key sync** (`docs/canonico.md` §22): a second machine of the same person signs in and ends with
  the host's pair, publishing nothing (so no colleague's pin goes `changed`); a reset replaces both
  halves; a password change re-seals the blob and leaves the public keys alone; a dump of `host.db`
  holds the sealed blob and not one byte of a private key.
- **Scope**: a `role` share to someone with no common role is refused by both the Nod and the
  host; `blocked` shows no send action (RF-53).
- **Holders**: after accept, both sides list both people with date and scope (RF-54).
- **Admin holders** (finding M7): a member shares a credential with another member while the admin's
  vault does not hold it; the admin's Settings → Vault lists that credential's holders, named, with
  date and scope.
