# backend/ — the Bond's system side

The txiki.js process behind every Bond window: SQLite, keychain, tool windows, the login cascade,
and (from block 1) the host client and sync. Module by module, with signatures:
`docs/arquitetura.md` §4. Runtime facts: `docs/tinyjs.md`.

## What it owns

- The local database (`repo.ts`, `tjs:sqlite`), and the only path to the OS keychain (`vault.ts`,
  `session.ts`).
- Every network call the Bond makes. The page never talks to the network (`docs/tinyjs.md` §10).
- The RPC gate in `main.ts`: which window and which session may call which method
  (`docs/arquitetura.md` §2).
- Tool windows, popups, shortcuts and the login adapter (`tool-windows.ts`, `login-adapter.ts`).

## Changes planned (blocks 1–2)

| Module | Change | Story |
| --- | --- | --- |
| `host-client.ts` (new) | Discovery, bearer, signature check, error mapping | B1 |
| `sync.ts` (new) | Timer, outbox, event push, snapshot apply, stale state | B4, B5, B7, B10 |
| `repo.ts` | `user_version = 3`: host, outbox, event sent state, vault origin, password V2, tool scope | B1–B4, B9 |
| `session.ts` | `PasswordHashV2`, keys in memory while unlocked, `vaultKey` behind biometrics | B3, V1 |
| `vault.ts` | Fill only on the saved origin; `bv1.` encryption; keys for E02 | B9, V1, K1 |
| `main.ts` | `host.*`, `personal.*`, `favorites.*` methods; admin methods routed to the host | B2, B6, B7 |

Contracts: `docs/specs/SP02-auth-and-keys.md`, `SP04-sync.md`, `SP05-bond-connected.md`,
`SP06-credential-sharing.md`.

## Rules

- The page never receives `authKey`, `vaultKey`, the host token or a private key; at most a
  revealed credential, after the gate (E02 §5).
- `host.activate`, `host.signIn` and `session.*` carry the password in params, so `TINYJS_DEBUG=1`
  must never run with real credentials (`AGENTS.md`).
- Backend timers, not page timers, for anything periodic. The page is throttled when hidden
  (`docs/tinyjs.md` §3).
- Check capabilities with `!== false` before using biometrics, tray or global shortcuts
  (`docs/tinyjs.md` §6).
- Tests: pure parts go to `shared/` and run under `bun test`; runtime-bound parts are proved by
  the smoke (`test/smoke/`).
