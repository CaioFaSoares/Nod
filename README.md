# Nod

Nod is a desktop app that keeps your team's web tools in one place. Open it and every tool you have
access to is a click (or a keyboard shortcut) away; each opens in its own window and stays signed in
between sessions. You add the tools that are yours, an admin decides who sees what, and passwords sit
in the system keychain behind a single local password — you never retype them into the app.

It is small and self-contained: about 6 MB, no bundled browser engine, no server required. It works
fully offline — the catalog, your credentials and the audit log all live on your own machine. When
your team runs the optional host, tools, roles and access sync to everyone connected, so an admin
adds a tool once and it shows up for the right people.

Tools are **data**, not code: addresses, names, icons and roles come from the catalog, never from the
source. No tool or organization is built in.

Under the hood Nod is thin TypeScript on [tinyjs](https://tinyjs.app): a txiki.js backend and the
system's native webview.

## Name

The project and this repository are **Nod** (GitHub `CaioFaSoares/Nod`, renamed from `Bond` on
2026-10-16). Documents written from that date name it Nod, and the internal identifiers were renamed
with them, as a clean cutover in release 0.3.5: the app id is `copland.nod`, and the keychain keys,
the environment variables, the deep links, the database file and the discovery path all use `nod`.
There is no migration and no compatibility alias — an install of 0.3.0 becomes a fresh install. Only
the cryptographic protocol labels stay as they were, on purpose, because changing them would change
every derived key. The rename decision and plan are in `docs/canonico.md` §22 and
`docs/rename-nod.md`.

## Features

- One main window to manage and switch tools; each tool in its own native window, sessions kept
  across restarts.
- Login cascade: existing session, form fill from the vault, or the site's own provider, with a
  visible manual fallback.
- Vault in the system keychain, bound to the origin each credential was saved for.
- Roles, grants and a local, exportable audit log.
- Private releases with a seed (catalog, roles, grants) kept out of git; from 0.4.5 the seed is an
  optional import at setup, so a release can start empty.
- Optional host (`host/`, Bun + Elysia): one guild per container; people, roles, grants and tools
  sync to every connected Nod. Without a host, Nod works fully offline.

## Status

Read `docs/canonico.md` (requirements and decisions) and `docs/arquitetura.md` (architecture).
Story status lives in the GitHub issues, not in the docs.

## Documents

| Document | Contents |
| --- | --- |
| `docs/canonico.md` | Requirements: scope, functional and non-functional requirements, data model, security, roadmap, decision log, open questions. |
| `docs/arquitetura.md` | Modules, contracts and data shapes. |
| `docs/tinyjs.md` | What the runtime does and forbids, with sources. |
| `docs/specs/` | Exact contracts for the host and connected mode. |
| `docs/epics/` | Epics and effort blocks. |
| `docs/distribuicao.md` | Building, releasing and installing. |
| `CONTEXT.md` | Vocabulary. |
| `AGENTS.md` | Rules for agents working here. |

## Running

```
bun install
bun run app:dev         # development (runs without the private seed)
bun test                # unit tests
bun run typecheck       # tsc for frontend and backend
bun run app:build       # release (the private seed is optional since 0.4.5)
bun test/smoke/run.ts   # smoke test on the real app (opens it)
```

The seed format is in `resources/seed.example.json`. Distribution steps are in
`docs/distribuicao.md`.
