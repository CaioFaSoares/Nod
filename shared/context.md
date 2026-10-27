# shared/ — pure logic used by every side

Code that runs unchanged in the Nod page, the Nod backend (txiki.js), the host (Bun) and the tests
(Bun). Module by module: `docs/arquitetura.md` §3.

## Rule that defines the folder

No `tjs`, no `tiny`, no DOM, no `bun:*`, no Node built-ins. Only the language, `crypto.subtle` and
`crypto.getRandomValues`, and type-only imports. If a module needs the system, it belongs in
`backend/` or `host/`, and receives what it needs as a parameter.

This rule is what lets the host and the Nod share one definition of every contract
(`docs/epics/E01-connected-mode.md` §11).

## Modules (block 1 and block 2 landed)

| Module | State | Story | Spec |
| --- | --- | --- | --- |
| `auth.ts` | `deriveKeys`, `PasswordHashV2` and its verify/migrate, invite helpers | H3, B3 | SP02 §1, §6 |
| `build-mode.ts` (new) | `BUILD_MODE_STAMP` (`resources/build-mode`) and `stampMode`: the stamp `scripts/gen-electrobun-config.ts <dev\|build>` writes and `backend/main.ts` reads, the one fact that tells a non-release dev run from a release build (review finding M3) | K5 | SP02 §9, `docs/canonico.md` §22 |
| `encoding.ts` (new) | `toBase64url`/`fromBase64url`, `toHex`/`fromHex`, `sha256Hex` | C1 | specs README shared rules |
| `host-api.ts` (new) | Discovery, Snapshot and every block 1 body; the block 2 bodies (`PublicKeys`, `ShareRequest`/`ShareResponse`/`ShareItem`, `IncomingShare`, `Holder`, `AssignmentRequest`, `MissingCopy`, `SnapshotPerson`, `ShareScope`/`ShareKind`); **the code helpers** (`generateCode`, `formatCode`, `normalizeCode`, `validateCode`, `CODE_*`) and `normalizeEmail` — they live here, not in `auth.ts` (c1) | C1, H4, K1–K3 | SP03, SP04, SP02 §3, SP06 |
| `host-merge.ts` (new) | snapshot → rows (RF-62's `Entry.category` read, an old host's absent field as `null`), the 14-day org window, sidebar order (favorites → org grouped by category → personal), outbox verdicts, the pending-write overlay over the personal half and the person's views hung under their entry, `clearOrgData`, the RF-40 leftover rule (`leftoverLocalTools`) | B5, B7, B8b, B10 | SP04 §3–§5, SP05 |
| `seal.ts` (new) | key pairs, `seal`/`open`, HKDF over HMAC, `personFingerprint` (SHA-256 of `x‖ed`, first 10 bytes, Crockford) | S0, K1–K2 | SP06 §1–§3 |
| `vault-crypto.ts` (new) | the `bv1.` envelope (AES-256-GCM, AAD = keychain key, 2560-byte storage gate), `encryptVaultValue`/`decryptVaultValue`, `encryptVaultBytes`/`decryptVaultBytes` (K1 keys), `plainVaultCredential`, `decodeVaultKey` for the biometric item | V1, K1 | SP02 §8–§9 |
| `types.ts` | `Entry.scope/ownerId`, `View.id/scope/ownerId`, `HostState` (with `missingCopies`, K8: the count of the last missing-copy read), `PeerKey` (a colleague's pinned fingerprint and its `pinned`/`changed`/`unknown` state, K2), `VaultItem.credentialId/scope/rotationPending/holders` and `ShareRecipient`/`InboxShare` (K4–K7), `MissingCopyView` (K8: a member of an assigned role without a copy, their name and key state), `VaultItem.updateWarning` (K9: what a save's update fan-out had to say), the `ApiContract` methods (B7: `personal.*`, `favorites.*`, and the `PersonalToolDraft`/`PersonalViewDraft` the page sends; B8b: `host.localLeftovers`, `host.adoptLocalAsPersonal`; K1–K2: `keys.mine` (→ `MineKeys`: fingerprint, `ok`/`pending`/`unavailable` and the sentence to show), `peers.list`, `peers.confirm`; K4–K7: `vault.setScope`/`vault.copy`, `shares.recipients`/`send`/`inbox`/`accept`/`decline`; K8: `assignments.set`/`missing`/`sealMissing`; K9: `shares.removeHolder`; ShareEvents: the `EventType` kinds `share.sent`/`share.accepted`/`share.declined`/`share.expired`) | C1, B2, B7, B8b, K1–K9 | SP04 §2, SP05 §3, SP06 §2–§5 |

Block 2 has landed: the sealed share itself is `seal`/`open` (S0) and the block 2 types above;
the share flows of K4, K6 and K7 live in `backend/shares.ts` and the K5 gate in `backend/main.ts`,
the K8 assignments (the admin's `assign`/`missing`/`sealMissing` and the `assignments.*` methods)
hang off that same module and file, and K9's rotation flow (the owner's `update`, the explicit
`rotated` signal of RF-48 and `shares.removeHolder`) hangs off them too.
The page half (K4–K7 screens, K9's holder `Remove` and the rotation chip, K8's assign dialog and
missing-copy list) is `src/`. The `share.*` event family of E02 §6 landed too (ShareEvents):
`backend/shares.ts` raises the content-free `share.sent`/`accepted`/`declined` and `host/repo.ts`
writes `share.expired` on the purge (`docs/handovers/share-events.md`).

## Rules

- **Same bytes in every runtime.** Crypto helpers carry test vectors computed once and checked in
  Bun (`bun test`) and in txiki.js (smoke). A vector that differs between runtimes blocks the story.
- **Tests sit beside the behavior**: `test/<module>.test.ts`. A test checks behavior, not wording.
- **Types are the contract.** Changing a shape here changes the host and the Nod in the same
  commit.

Block 2 review fixes: `CredentialHolders` and the `holders.list` method (M7, admin only) live in
`types.ts`; the reveal countdown moves no type (L5).
