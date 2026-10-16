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
2026-10-16). Documents written from that date name it Nod. Some internal identifiers still carry the
old name on purpose — the app id, the keychain keys under `bond.*`, the `BOND_*` environment
variables, `bond://` links, the database file and the `/.well-known/bond` discovery path — because
changing them would lose data or break already-installed apps and deployed hosts. The rename
decision and plan are in `docs/canonico.md` §22 and `docs/rename-nod.md`.

## Features

- One main window to manage and switch tools; each tool in its own native window, sessions kept
  across restarts.
- Login cascade: existing session, form fill from the vault, or the site's own provider, with a
  visible manual fallback.
- Vault in the system keychain, bound to the origin each credential was saved for.
- Roles, grants and a local, exportable audit log.
- Private releases with an embedded seed (catalog, roles, grants) kept out of git.
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
bun run app:build       # release (requires resources/seed.json)
bun test/smoke/run.ts   # smoke test on the real app (opens it)
```

The seed format is in `resources/seed.example.json`. Distribution steps are in
`docs/distribuicao.md`.
