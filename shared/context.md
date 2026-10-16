# shared/ — pure logic used by every side

Code that runs unchanged in the Bond page, the Bond backend (txiki.js), the host (Bun) and the tests
(Bun). Module by module: `docs/arquitetura.md` §3.

## Rule that defines the folder

No `tjs`, no `tiny`, no DOM, no `bun:*`, no Node built-ins. Only the language, `crypto.subtle` and
`crypto.getRandomValues`, and type-only imports. If a module needs the system, it belongs in
`backend/` or `host/`, and receives what it needs as a parameter.

This rule is what lets the host and the Bond share one definition of every contract
(`docs/epics/E01-connected-mode.md` §11).

## Changes planned (blocks 1–2)

| Module | Change | Story | Spec |
| --- | --- | --- | --- |
| `auth.ts` | `deriveKeys`, `PasswordHashV2`, access-code normalize/format | H3, H4, B3 | SP02 |
| `types.ts` | `Entry.scope/ownerId`, `View.id/scope/ownerId`, new `ApiContract` methods | H2, B2, B7 | SP04 §2, SP05 §3 |
| `host-api.ts` (new) | Discovery, Snapshot, request/response bodies of the host API | H5, H6 | SP03, SP04 |
| `host-merge.ts` (new) | Snapshot → local view; sidebar order; outbox decisions | B5, B7 | SP05 |
| `seal.ts` (new) | HKDF over HMAC, seal/open, fingerprints | S0, K1–K4 | SP06 |

## Rules

- **Same bytes in every runtime.** Crypto helpers carry test vectors computed once and checked in
  Bun (`bun test`) and in txiki.js (smoke). A vector that differs between runtimes blocks the story.
- **Tests sit beside the behavior**: `test/<module>.test.ts`. A test checks behavior, not wording.
- **Types are the contract.** Changing a shape here changes the host and the Bond in the same
  commit.
