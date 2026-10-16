# Slice B8a — the first admin of an empty host publishes the local tools, once

Authorizing issue: **#19** (`CaioFaSoares/Bond`, `[B8a] Bootstrap: first admin publishes local tools to
an empty host`, labels `area:backend`, `area:host`, `area:src`, `epic:E01`, `sp:2`, milestone *Block 1
— One guild, synced*), with gate #1 already closed (`docs/canonico.md` §14: RF-30…RF-55 approved
2026-10-16; RF-40 is this slice's). As the other B slices recorded, the issue carries no `em-curso`
label — the repository has no such label — so the authorization is the milestone plus the
implementation track coordinator's assignment and file list.

Contracts followed: `docs/specs/SP03-host-api.md` §2 (`POST /v1/admin/bootstrap`: `{ tools: OrgTool[],
roles: Role[] }` → `{ created }`, "only while the host has no org tools"); `docs/specs/SP05-bond-connected.md`
§4 (the offer belongs to Settings) and §5 (the smoke's step 2: "publish local tools (B8a)") and §2
("removing the host returns to the [local tables]", which the publish must not disturb);
`host/routes/admin.ts` (the route: one transaction, roles then tools) and `docs/handovers/h5.md`
decisions 11 (`{created}` counts the org tools written) and 12 (a roles-only bootstrap stays
repeatable — the window closes with the first org tool); `docs/handovers/b5.md` (the connected
catalog) and `b6.md` (the admin routing this rides on). Rules: `AGENTS.md`, `backend/context.md`,
`host/context.md`, `src/context.md`.

Everything below is in English (RNF-08). No project gate was run: not `bun run typecheck`, not the
full `bun test test/`, not the smoke, not a formatter. What ran is the slice's own test file (the
B8a cases inside `test/host-admin.test.ts`, allowed by the mandate) and a scratch `tsc` probe of the
touched files (disclosed in "Commands", not the gate).

The published payload carries no secret: local catalog rows (id, title, url, icon, order, grants,
views) and role rows. No code, token, salt or key is created, read, logged or written by anything this
slice added.

## Files touched

| File | What changed |
| --- | --- |
| `shared/types.ts` | New `ApiContract['host.bootstrap']: [void, { created: number; refused: boolean }]`, with the doc of what it publishes and of the refusal being an answer. |
| `backend/main.ts` | The `host.bootstrap` handler: admin-only (`ADMIN_ONLY`), refuses without a connection, reads the local catalog's `org` rows through `localEntriesWithIcons()` (icons as data URIs), sends them with the local roles through `host-admin.ts`, and on success records the `catalog_changed` event with result `published` and runs `afterHostWrite()` so the new guild catalog is on screen at once. `localEntriesWithIcons()` was factored out of `listedEntries()` for this read. |
| `src/settings.ts` | Settings → Hosts draws the **Publish local tools to the guild** card while the offer applies, with the one action; the outcome (created / refused / failed) is the tab's status line, and the offer is spent once. |
| `test/host-admin.test.ts` | The two B8a cases: the first bootstrap taken and the second refused (raw route `409` included), and the published tool landing in a member's Bond through the real `backend/sync.ts`. |
| `docs/handovers/b8a.md` | This file. |

`backend/host-admin.ts` carries the `bootstrap` mapping itself (a `POST /v1/admin/bootstrap` with the
bodies built field by field, the `409` turned into `refused: true`); it is described in `b6.md`'s
file table, since the module is B6's. `host/` was **not** touched: the route H5 landed is exactly the
one this slice needed.

## Acceptance criterion — how each item was met

### 1. "On an empty host, the first admin can publish local tools and roles once; the route refuses once org tools exist."

`execucao` (the test file, against the real host app on a temp data dir, served on loopback):

- *the first call writes and the second is refused* — `admin.bootstrap([jitsi granted to `team`,
  notes], [team])` answers `{ created: 2, refused: false }`; the same call again answers
  `{ created: 0, refused: true }`.
- *the route itself is the one that refuses* — `POST /v1/admin/bootstrap` with the admin's bearer
  answers **409** `{"error":"the host already has org tools"}`, read straight from the served app, so
  the refusal the Bond reports is the host's own behaviour (SP03 §2, H5 decision 12).
- *roles and grants travel with the tools* — after the bootstrap the `team` role exists in the guild
  and the published tool carries that grant: a person the admin then creates with `team` sees the tool
  in their verified snapshot (`orgTools: ['jitsi']`, `roles: ['admin','team']` — `admin` is the role
  the setup created).
- *the local catalog is the source* — `leitura` of the handler: it reads `repo.listEntries()` filtered
  to `(entry.scope ?? 'org') === 'org'` and `repo.listRoles()`, with the icons resolved through the
  icon store (`localEntriesWithIcons`), and it never reads the connected catalog (publishing the
  snapshot back to the host would be a no-op).

### 2. "Published tools appear for granted roles after sync."

`execucao`: the bootstrap publishes `jitsi` granted to `team`; a real `backend/sync.ts` is then run in
the `team` member's Bond — a real repository with the `host` row, the bearer in her own keychain and
the real `backend/host-client.ts` — and after `syncNow()` the verified body in `host.snapshot` holds
`jitsi` (`state.status === 'connected'`, `orgTools: ['jitsi']`, `me.id` hers). The real-surface
observation of the same fact (two app instances, `Sync now`) is B11's smoke, step 2 of SP05 §5.

## Commands run and observed results

1. **Allowed by the mandate** — the slice's own test file (its B8a cases are two of the eight):

   ```
   $ bun test test/host-admin.test.ts
   bun test v1.4.3 (26aa4e1a9)

    8 pass
    0 fail
    81 expect() calls
   Ran 8 tests across 1 file. [1267.00ms]
   ```

2. **Scratch compile** — the same two probes `b6.md` records, over the files this slice touched:

   ```
   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 --module es2022 \
       --moduleResolution bundler --skipLibCheck backend/tjs.d.ts backend/tiny.d.ts \
       backend/main.ts backend/host-admin.ts
   (no diagnostics)

   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2023 --module esnext \
       --moduleResolution bundler --lib es2023,dom --skipLibCheck --allowImportingTsExtensions \
       --verbatimModuleSyntax --moduleDetection force --noUnusedLocals --noUnusedParameters \
       --erasableSyntaxOnly --noFallthroughCasesInSwitch src/tiny.d.ts src/settings.ts \
       shared/types.ts src/api.ts
   (no diagnostics)
   ```

3. **Not run, by the mandate**: `bun run typecheck`, the full `bun test test/`, the smoke
   (`test/smoke/`, B11's) and any formatter. The offer's rendering was not executed either: it is
   `leitura` of `src/settings.ts` — the pages were not run under the runtime.

## Decisions and deviations for the coordinator

1. **The refusal is an answer, not a failed call.** `host-admin.ts` turns the route's `409` into
   `{ created: 0, refused: true }` instead of letting a `HostError` out. The offer must end on a
   `409` (the acceptance says so) and the client reads no failing body by design, so a thrown error
   would leave the page with a status to parse or with a generic "the host refused the request".
   Nothing of this Bond's catalog moved when it is refused, which `refused` states.
2. **The offer is the page's decision, from the snapshot.** `src/settings.ts` shows the card while:
   the owner is an admin, the host is known and not signed out, no entry of `catalog.list` is an org
   one, and the offer was not already answered in this session (reset when a host is joined or
   removed). Past RF-37's 14-day window the org half hides while the host may hold tools, so the offer
   can appear in front of a host that is not empty — the host's `409` is then the answer, and the
   message says the window is closed. The alternative (a new read that told the page the host's org
   count) would have added an RPC or a field to `HostState`, which is B4/B10's shape, for a case the
   route already answers.
3. **With no local tool, the call refuses** (`this Bond has no local tools to publish`) rather than
   writing the roles alone: H5 decision 12 makes a roles-only bootstrap repeatable, and the offer
   promises tools. The local catalog of any real Bond has at least the seed's entries, so this is a
   guard against a hollow publish, not a path the admin meets.
4. **`host.bootstrap` is admin-only** (`ADMIN_ONLY` in `backend/main.ts`, on top of the unlocked
   session every admin method needs). It writes the guild's catalog for everybody, so it sits with
   the other catalog writes.
5. **The publish copies, it does not move.** The local rows, their icons and the credentials saved for
   them stay exactly as they were (SP05 §2's "the local tables keep the local-mode catalog, untouched
   while connected"); a later edit in the Tools tab writes the host's row, not the local one. The
   filter on `scope === 'org'` keeps a local personal tool — block 2's — out of the guild's catalog
   (RF-40 offers local tools as *personal* tools; B8b, #25, is that slice).
6. **The publish is audited locally** as `catalog_changed` with result `published` and the counts in
   the detail (`tools: n, roles: m`). No code, no email, no secret; SP04 §5 pushes the row like any
   other local event.
7. **One RPC, no parameters.** The page says "publish this machine's catalog to this guild"; what
   travels is the backend's to decide from the local tables. A page that assembled the payload would
   have had to read the local catalog, which no connected read does.
8. **No new dependency, no `host/` change, no `src/style.css` edit.** The card uses the vocabulary the
   stylesheet already has.

## What could not be done

- **The offer's rendering was not run.** No `tinyjs dev`, no smoke: the runtime surface is B11's
  (`test/smoke/`, being extended in parallel), and the smoke's step 2 of SP05 §5 is where the offer's
  outcome is observed in the app. What is executed here is the RPC and the host route behind it.
- **No project gate** (`bun run typecheck`, the full `bun test test/`, the formatters) — the
  coordinator's.
- **No test of the day the 14-day window hides a non-empty host's org half.** The state exists (B5
  decision 6) and the offer's behaviour there is the host's `409` (decision 2 above); pinning it would
  need a movable clock in the test harness, which the real host does not expose.

## What another owner must do

- **Coordinator — confirm the shape**: `host.bootstrap` with no parameters answering
  `{ created: number; refused: boolean }` (B6's "What another owner must do" lists it with the other
  three widenings). `host/admin.test.ts` (H5's) already pins the route's side.
- **B11 (#22)**: the shapes are confirmed — `host.bootstrap` with `{}` answers `{created > 0,
  refused: false}` on the empty host of the smoke's step 2 (their message records it), and the
  published tools keep their local ids.
- **B8b (#25) / B7 (#24)**: the offer is the *org* half of RF-40 only. Local tools that become
  personal tools on Add host, and the "no local tool disappears" observation, are that story's; this
  slice neither writes nor removes a local row.
- **B4/B10**: nothing needed — the offer reads `catalog.list` and `host.state`, both already
  published to the page.

## Where the evidence lands

This file and `docs/handovers/b6.md`, per `docs/handovers/README.md`: one file per slice, written by
its owner, with the files touched, the acceptance and how it was met, the commands and their
observations, and what was left out. The state of the story is the GitHub issue #19's `status` — this
file decides nothing about it.
