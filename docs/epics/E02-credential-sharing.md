---
id: E02
frente: bond
titulo: Credential sharing — send, assign and share tool logins between people of a guild, end to end
status: proposto
tipo: epico
origem: dono
aberta_em: 2026-10-16
depende_de: E01
---

# E02 — Credential sharing

Owner, 2026-10-16:

> acho que é bom pensarmos na forma de interagir com isso de qlqr forma para poder por exemplo
> mandar senhas entre sí ou apontar senhas novas para membros da mesma rede (ou até compartilhar
> entre as pessoas, passando por biometria para conseguir sequer ver).

Proposal waiting for the owner's reading (`AGENTS.md`). It builds on E01's keys and vault
(`docs/epics/E01-connected-mode.md` §7). It also answers `docs/canonico.md` §23 question 7 (how to
hand credentials to a person) with the X25519 seal that question already named.

Evidence: `leitura`. Nothing here was executed.

## 1. What it does

| Action | Who | Example |
| --- | --- | --- |
| **Send** | a person → another person allowed by the credential's **sharing scope** (below) | "here's the Figma login" |
| **Assign** | admin → a person or every member of a role | new hire gets the Kanban login; role "team" gets the shared Jitsi admin |
| **Share** | the owner of a credential → people, keeping it in sync | the owner rotates the password, and everyone it was shared with gets the new one |

The receiver accepts it into their vault. Revealing, copying or accepting a credential passes the
local gate (biometrics, or the password where biometrics don't exist).

### Sharing scope

Decided by the owner on 2026-10-16. Each credential carries one scope, chosen by its owner, or by
the admin for assigned credentials:

| Scope | Who can receive it |
| --- | --- |
| **Role** (default) | only people who share at least one role with the sender **and** can see the tool |
| **Blocked** | nobody: it can't be sent or re-shared |
| **Org** | anyone in the guild |

The scope travels inside the sealed share. The receiver's Nod enforces it on any re-send, and the
host enforces the recipient list from roles it already knows. A modified Nod could still decrypt
and pass a secret along by hand; scope is a rule between honest clients, not a cryptographic
barrier.

Reading note: the owner wrote "mesma role acima". Roles in the Nod are flat — named sets, with
only `admin` set apart (`docs/canonico.md` §10) — so "acima" is read as "mentioned above", not as a
role hierarchy. To confirm (question 1).

### Who can see this password

Decided by the owner on 2026-10-16: "é bom ver que consegue ver aquele password". Each credential
in the vault shows a **Holders** list: who has it, who sent it, when, and the scope. The list comes
from the share metadata on the host, which therefore sees who shared which tool with whom, but never
the content. An admin sees the holders of every org credential.

## 2. The rule that shapes everything

**The host relays, it never reads.** A credential leaves a machine only encrypted to the receiver's
public key; the host stores and forwards ciphertext. This keeps E01's promise that the server
(and whoever runs it) has no access to the vault.

## 3. Keys

Each person, at activation (E01 §7), generates on their machine:

- an **X25519 key pair** for receiving;
- an **Ed25519 key pair** for signing what they send.

Both are native in the Nod runtime (`docs/tinyjs.md` §5).

- The **public keys** go to the host, attached to the person, and come down in the snapshot.
- The **private keys** stay local, encrypted with `vaultKey`.
- A password reset (new access code) creates new key pairs. Shares that were waiting for the old
  key have to be sent again.

**Trusting someone else's public key.** The host could hand out a fake public key and read what is
sent to it. Defense:

- The Nod **pins** each colleague's keys the first time it sees them.
- A key change shows a warning and requires confirmation before anything is sent again.
- Each person has a short **fingerprint** in Settings, to compare in person or on a call when it
  matters.

The owner runs the host, so this is a guard against a compromised host, not against the owner.

## 4. Flow

```mermaid
sequenceDiagram
    participant A as Alice's Nod
    participant H as Host (relay)
    participant B as Bob's Nod
    A->>A: gate (biometrics) → read credential from vault
    A->>A: seal to Bob's X25519 key + sign with Alice's Ed25519 key
    A->>H: POST /v1/shares {to: bob, toolId, ciphertext, signature}
    H-->>B: snapshot: 1 incoming share (ciphertext only)
    B->>B: notice "Alice sent: Figma" → gate (biometrics) → verify signature → open
    B->>B: store in vault (encrypted with Bob's vaultKey); ack
    B->>H: POST /v1/shares/:id/accept → host deletes the ciphertext
```

- **Seal**:
  - an ephemeral X25519 key and the receiver's key → shared secret;
  - HKDF-SHA256 → an AES-256-GCM key;
  - the ciphertext carries the tool id, label, username and secret.

  Signed by the sender over the ciphertext and the ids.
- **Bound to the tool's origin.** The share names the tool entry, and the receiver stores it bound
  to that entry's origin (E01 RF-38). A share for a tool the receiver can't see is held until they
  can, or declined.
- **Assign to a role**: the admin's Nod seals one copy per current member of the role.
  - New members later: the host can't produce a copy. The admin's Nod, on its next sync, sees
    "role team has 1 member without the Jitsi login" and seals the missing copy after a gate
    prompt.
- **Share with updates**: the share remembers the recipients, so a rotation by the owner re-seals
  to each of them.
- **Revocation**: removing someone from a share, or revoking a person, can't erase what their
  machine already decrypted. The Nod marks the credential **rotation pending** on the owner's
  side; that state already exists in the admin's vault screen (`docs/canonico.md` §12).
- **Expiry**: an unaccepted share expires after 14 days, and the host deletes its ciphertext.

## 5. The gate

"Biometria interna pra tudo" (owner, 2026-10-16), applied per action:

| Action | Gate |
| --- | --- |
| Unlock the Nod | biometrics or password |
| Reveal a credential | biometrics; the secret then stays visible for **a few seconds with a countdown indicator** (proposal: 10 s), and hides itself at zero. Revealing again asks again |
| Copy a credential | biometrics |
| Accept an incoming share | biometrics |
| Send, assign or re-share | biometrics |
| Autofill into a tool window | none beyond unlock — that's the point of the cascade |

`app.authenticate` exists on macOS and Windows. On Linux it always returns `false`, so the gate
asks for the password (`docs/canonico.md` §9).

It is an **app-level gate**, not a keychain access control tied to biometrics. That's enough to
stop someone at an unlocked machine from viewing a credential. It doesn't stop malware running as
the same user, which can read the stored `vaultKey` (E01 §7).

## 6. Host additions

- People: `x25519Public`, `ed25519Public`.
- Table `shares`: id, from, to, toolId, ciphertext, signature, createdAt, expiresAt, acceptedAt. The
  host can see the metadata (who sent which tool to whom), never the contents.
- Routes:
  - `POST /v1/shares`;
  - the incoming shares in `/v1/state`;
  - `POST /v1/shares/:id/accept|decline`;
  - for the admin, a "members missing an assigned credential" list.
- Events: `share.sent`, `share.accepted`, `share.declined`, `share.expired` — never with content
  (`docs/canonico.md` §13).

## 7. Milestones

Stories, points and effort blocks: `docs/epics/blocks.md`.

| Milestone | Scope | Proof |
| --- | --- | --- |
| **S0 — spike** | X25519 + HKDF + AES-GCM seal and Ed25519 sign/verify running in the Nod backend (txiki.js `subtle`) and in Bun (for tests), with the same bytes on both sides | A sealed test credential opens on the other runtime; cost measured (`docs/canonico.md` §23 q6) |
| **M1 — send** | Keys at activation, key pinning, send/accept/decline, gate, Settings → Vault inbox | Alice sends Bob a login; the host DB holds only ciphertext; Bob sees it only after the gate |
| **M2 — assign** | Admin assigns to a person or a role; missing-copy list; rotation pending | New member of "team" gets the Jitsi login after the admin's next sync |
| **M3 — share with updates** | Recipients remembered; rotation re-seals | Owner changes the password; recipients get it at the next sync |

## 8. Requirements

These requirements entered `docs/canonico.md` §14 on 2026-10-16 (RF-44 to RF-48, RF-53, RF-54). The table stays here for reference.

| ID | Requirement | Acceptance |
| --- | --- | --- |
| RF-44 | Credentials cross the host only sealed to the receiver's key and signed by the sender. | The host DB and a traffic capture show no username or secret in clear; a share with a bad signature is refused. |
| RF-45 | A changed public key of a colleague blocks sending until confirmed. | Swapping Bob's key on the host makes Alice's Nod warn and refuse until she confirms. |
| RF-46 | Revealing, copying, accepting and sending a credential each pass the gate; a revealed secret hides itself after a visible countdown. | With biometrics cancelled, nothing is shown, copied, accepted or sent; a revealed secret shows a countdown and is hidden when it ends. |
| RF-47 | Assigning to a role reaches every current member, and the admin sees members still missing a copy. | Add a member to the role; the list shows them until the admin's Nod seals their copy. |
| RF-48 | Revoking someone from a shared credential marks it rotation pending. | After revocation, the owner's vault shows "rotation pending" for that tool. |
| RF-53 | Each credential has a sharing scope — role, blocked or org — enforced on send and re-send. | A "role" credential can't be sent to someone with no common role; a "blocked" one offers no send at all. |
| RF-54 | Each credential shows its holders. | After Alice sends Figma to Bob, both see "Alice, Bob" with date and scope. |

## 9. Open questions

1. ~~Who can send to whom~~ — decided 2026-10-16: per-credential scope role / blocked / org (§1).
   To confirm: "mesma role acima" read as "same role", not a role hierarchy.
2. ~~Reveal grace~~ — decided 2026-10-16: visible for a few seconds with a countdown (10 s proposed).
3. ~~Re-share~~ — governed by the scope (§1).
4. ~~Host sees metadata~~ — accepted 2026-10-16; it powers the Holders list.
