# Renaming Bond to Nod

Decided by the owner on 2026-10-16: the project and the repository are **Nod** (GitHub
`CaioFaSoares/Nod`, renamed on GitHub on 2026-10-16). This file records the decision and the plan for
the parts of the rename that are still open. `docs/canonico.md` §22 carries the decision; documents
written from that date name the project Nod.

The old name still appears in identifiers on purpose. Identifiers come in three kinds, and they cost
different amounts to change.

| Kind | Examples | Cost of changing |
| --- | --- | --- |
| **Cosmetic** | window title, UI text, docs, README, package `name`, release asset names | None: change at will |
| **Wire contract** | `GET /.well-known/bond`, RPC names `bond.*`, host env `BOND_*`, `bond://` deep links | Host and app must change together; old invite links and deployed hosts break |
| **Persisted on the person's machine** | the app id in `tinyjs.base.json`, keychain keys under `bond.*`, database `bond.db`, `store.json` keys | Without a migration, an update looks like a fresh install: account, catalog, vault and tool sessions are lost |

## What this rename changes

Name only, in docs, the README and the repository: **Nod**. No identifier below the wire or on disk
changes in this step. The naming surfaces (README, `CONTEXT.md`, `AGENTS.md`, `docs/canonico.md`,
`docs/arquitetura.md`, the specs and the epics) now say Nod; the internal identifiers they quote stay
exactly as they are.

## What it deliberately does not change yet

- The app id, the `bond.*` keychain keys and `bond.db`: changing them is a full rename with a
  migration (below). Until then an installed app keeps its data and a deployed host keeps working.
- `/.well-known/bond`, the `bond.*` RPC names, the `BOND_*` environment variables and `bond://`:
  these are wire contracts between the app and the host.

## Later, if the internal names are renamed (full rename with migration)

1. **New identifiers.** App id (reverse-DNS under a domain the owner controls), `urlScheme` `nod`,
   keychain prefixes `nod.*`, database `nod.db`, RPC prefix `nod.*`, discovery `/.well-known/nod`,
   env `NOD_*`, package `name`.
2. **Host compatibility window.** Serve both `/.well-known/bond` and `/.well-known/nod`; read `NOD_*`
   first, then `BOND_*`, for one release. No permanent alias.
3. **App migration on first run**, in `backend/main.ts`, before opening the database: copy the old
   database (with its WAL files) and `store.json` when the new data dir is empty; rewrite each
   `bond.cred.*` / `bond.bio.*` keychain item under the new prefix; record one migration event, with
   no value in it. Whether the new id can read the old keychain items must be proved on macOS,
   Windows and Linux first.
4. **Tool sessions are lost** either way: the browser profile belongs to the old id.
5. **Deep links**: invite links using `bond://` stop opening the app; re-issue them after the switch.
6. **Smoke and tests**: the smoke app ids, `test/gen-config.test.ts` and the host tests that read
   `BOND_*`.
7. **Specs**: rename `docs/specs/SP05-bond-connected.md` and update every reference.

## When

The name (docs and repository) is done. The identifier rename waits for the owner; when it happens it
is one commit, with `bun run typecheck`, `bun test test/ host/` and the smoke green afterwards.
