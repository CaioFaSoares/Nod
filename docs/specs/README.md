# Specs

Exact contracts for building blocks 1 and 2 (`docs/epics/blocks.md`). The epics say **what and why**
(`docs/epics/E01-connected-mode.md`, `docs/epics/E02-credential-sharing.md`). The specs say **how,
to the byte**: tables, endpoints, payloads, key formats. When a spec and an epic disagree, the epic
wins on intent, and the spec is fixed.

| Spec | Contract | Stories |
| --- | --- | --- |
| `SP01-host-data-model.md` | Host SQLite schema, ids, migrations | H1, H2, H7, K3 |
| `SP02-auth-and-keys.md` | Password → keys, access and setup codes, sessions, local verifier, vault encryption | H3, H4, B3, V1, O1 |
| `SP03-host-api.md` | Every host route: auth, request, response, errors | H4–H8, O1, O2, K3 |
| `SP04-sync.md` | Discovery, key pinning, signed snapshot, outbox, events | H6, H8, B1, B4, B5, B7, B10 |
| `SP05-bond-connected.md` | Bond side: new RPC methods, local tables, modules, screens, migrations | B1–B11, H7/B7, V1, O1 |
| `SP06-credential-sharing.md` | Key pairs, seal and signature format, scope, holders, assign | S0, K1–K10 |
| `SP07-host-deployment.md` | Container, compose, env, setup-code command, backup and restore | H1, H9 |

Status: proposal, like the epics. Nothing here was executed. A value marked `[INFERENCE]` is a
guess to confirm in the story that first touches it.

Shared rules for all specs:

- Encoding: binary as **base64url without padding** on the wire and in JSON; hex only for SHA-256
  digests stored as lookup keys.
- Dates: ISO 8601 UTC with `Z`.
- Ids: tool entries keep the slug `^[a-z0-9][a-z0-9-]{0,39}$` (`docs/arquitetura.md` §2);
  everything else is `crypto.randomUUID()`.
- No secret in logs, events, error messages or `store.json` (`AGENTS.md`). This covers passwords,
  `authKey`, `vaultKey`, session tokens, access and setup codes, credential values and private keys.
