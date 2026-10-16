# shared/ — pure logic used by every side

Code that runs unchanged in the Nod page, the Nod backend (txiki.js), the host (Bun) and the tests
(Bun). Module by module: `docs/arquitetura.md` §3.

## Rule that defines the folder

No `tjs`, no `tiny`, no DOM, no `bun:*`, no Node built-ins. Only the language, `crypto.subtle` and
`crypto.getRandomValues`, and type-only imports. If a module needs the system, it belongs in
`backend/` or `host/`, and receives what it needs as a parameter.

This rule is what lets the host and the Nod share one definition of every contract
(`docs/epics/E01-connected-mode.md` §11).

## Modules (block 1 landed; block 2 pending)

| Module | State | Story | Spec |
| --- | --- | --- | --- |
| `auth.ts` | `deriveKeys`, `PasswordHashV2` and its verify/migrate, invite helpers | H3, B3 | SP02 §1, §6 |
| `encoding.ts` (new) | `toBase64url`/`fromBase64url`, `toHex`/`fromHex`, `sha256Hex` | C1 | specs README shared rules |
| `host-api.ts` (new) | Discovery, Snapshot and every block 1 body; **the code helpers** (`generateCode`, `formatCode`, `normalizeCode`, `validateCode`, `CODE_*`) and `normalizeEmail` — they live here, not in `auth.ts` (c1) | C1, H4 | SP03, SP04, SP02 §3 |
| `host-merge.ts` (new) | snapshot → rows, the 14-day org window, sidebar order, outbox verdicts, `clearOrgData` | B5, B10 | SP04 §3–§5, SP05 |
| `seal.ts` (new) | key pairs, `seal`/`open`, HKDF over HMAC | S0 | SP06 §1–§3 |
| `types.ts` | `Entry.scope/ownerId`, `View.id/scope/ownerId`, `HostState`, the `ApiContract` methods | C1, B2 | SP04 §2, SP05 §3 |

Block 2 still to come: the person fingerprint beside `generateX25519KeyPair` (K1–K4) and the rest of
SP06.

## Rules

- **Same bytes in every runtime.** Crypto helpers carry test vectors computed once and checked in
  Bun (`bun test`) and in txiki.js (smoke). A vector that differs between runtimes blocks the story.
- **Tests sit beside the behavior**: `test/<module>.test.ts`. A test checks behavior, not wording.
- **Types are the contract.** Changing a shape here changes the host and the Nod in the same
  commit.
