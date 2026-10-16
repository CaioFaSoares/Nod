# backend/ — Nod's system side

The txiki.js process behind every Nod window: SQLite, keychain, tool windows, the login cascade,
and (from block 1) the host client and sync. Module by module, with signatures:
`docs/arquitetura.md` §4. Runtime facts: `docs/tinyjs.md`.

## What it owns

- The local database (`repo.ts`, `tjs:sqlite`), and the only path to the OS keychain (`vault.ts`,
  `session.ts`).
- Every network call the Nod makes. The page never talks to the network (`docs/tinyjs.md` §10).
- The RPC gate in `main.ts`: which window and which session may call which method
  (`docs/arquitetura.md` §2).
- Tool windows, popups, shortcuts and the login adapter (`tool-windows.ts`, `login-adapter.ts`).

## Modules (block 1 landed; block 2 pending)

| Module | What it does now | Story |
| --- | --- | --- |
| `host-client.ts` | Discovery, bearer in the keychain, signature check, error mapping (SP04 §1–§2) | B1 |
| `sync.ts` | Timer, outbox flush, event push, snapshot apply, stale/signed-out state, backoff (SP04 §3–§5) | B4, B5, B10 |
| `connected-catalog.ts` | The effective org catalog from the verified `host.snapshot`, parsed once per change | B5 |
| `host-admin.ts` | Admin writes routed to the host routes when connected | B6, B8a |
| `repo.ts` | `user_version = 3`: `host`, `host_outbox`, `event.client_id`/`sent_at`, `vault_item.origin`, password V2, `tool.scope` | B1–B4, B9 |
| `session.ts` | `PasswordHashV2`, keys in memory while unlocked, `adoptConnectedAccount`, `wipeVault` (SP02 §6–§7) | B2, B3 |
| `vault.ts` | Fill only on the origin the credential was saved for (RF-38) | B9 |
| `main.ts` | `host.*` (`state`/`discover`/`activate`/`signIn`/`syncNow`/`remove`/`bootstrap`), `events.syncStatus`; admin methods routed to the host | B2, B6, B8a |

Block 2 still to come: the `personal.*` and `favorites.*` methods (B7), `bv1.` vault encryption (V1),
the E02 key pairs and the share flows (K1–K10).

Contracts: `docs/specs/SP02-auth-and-keys.md`, `SP04-sync.md`, `SP05-nod-connected.md`,
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
