# B7 — personal tools, personal views, favorites (issue #24)

Slice: Block 2, `em-curso` authorization (`/tmp/nod/issue-24.md`). Everything below is `leitura`
unless a line says `execucao`.

## Files touched

| File | What changed |
| --- | --- |
| `shared/types.ts` | `PersonalToolDraft` and `PersonalViewDraft` (the page's shape) and six `ApiContract` members: `personal.saveTool`, `personal.removeTool`, `personal.saveView`, `personal.removeView`, `favorites.list`, `favorites.set` |
| `shared/host-merge.ts` | New `attachPersonalViews` (a person's views hung under their entry, deduped by view id), `OutboxOp`/`PersonalRows`, `applyOutbox` (SP05 §2's overlay of the pending writes over the snapshot's personal half) |
| `backend/connected-catalog.ts` | `refresh(row, outbox?)` takes the outbox as its third input; `build` applies `applyOutbox` and uses `attachPersonalViews` (its private copy is gone); `EffectiveCatalog` gains `favorites` |
| `backend/personal.ts` (new) | The layer: `generatePersonalToolId`, `saveTool`, `removeTool`, `saveView`, `removeView`, `setFavorites`, `localFavorites`, `localCatalog`, `adoptSnapshot` |
| `backend/repo.ts` | `ToolRow`/`buildEntry`/`saveEntry` carry `scope`/`owner_id` (a row's own by presence, so an admin edit cannot make a personal tool into a catalog entry) |
| `backend/main.ts` | `createPersonal` wiring; `visibleEntriesOf`'s local branch is the personal layer's order; `catalogEntryOf` reads the local catalog first (so a personal tool answers with its views); `refreshConnectedCatalog` hands in `listOutbox()`; the six handlers; `host.remove` keeps or drops the personal half |
| `backend/tool-windows.ts` | `warningScript()`, the `foreign` flag of a window, the `Not from your org — …` window title and the injected banner on every load of an entry origin |
| `src/app.ts` | `favorites` state (`favorites.list` on unlock and on every catalog push), the star on each Home card, the personal card's warning line and its Remove button, the personal mark in the sidebar's tooltip, the "Add personal tool" dialog |
| `src/palette.ts` | The `Add personal tool` action (the palette's ctx gains `addPersonalTool`) |
| `src/style.css` | The star, the warning line, the personal card/sidebar marks, the dialog box |
| `test/personal.test.ts` (new) | 20 tests: the overlay, `attachPersonalViews`, the id format, the local layer (rows, owner, order, views, removal) and the connected layer (one outbox row per write, its method/route/body), `adoptSnapshot` |
| `backend/context.md`, `shared/context.md`, `src/context.md` | The B7 rows of each folder |

## Acceptance

| Item | How it is met |
| --- | --- |
| Add personal tool + favorite toggle in the UI; sidebar order favorites → org → personal | `src/app.ts`: the Home header's "Add personal tool" (also a palette action) opens a title+address dialog that calls `personal.saveTool`; every card carries the star (`favorites.set`). The order is the backend's: `shared/host-merge.ts`'s `sidebarOrder` over the effective catalog — connected already, local now through `personal.localCatalog` (`visibleEntriesOf`), so the sidebar (which iterates `tools.state`, built from the same list) and Home both show it |
| Offline edits queue in `host_outbox` and reach the host when back online | `personal.saveTool`/`removeTool`/`saveView`/`removeView`/`setFavorites` each append exactly one `host_outbox` row while a `host` row exists (`method`, SP03 §2 path with the id, body with the Nod's `updatedAt`), then `onWrite` re-derives the catalog and asks the sync loop for a run. `backend/sync.ts`'s `flushOutbox` (B4) already replays them in `id` order with SP04 §4's verdicts (2xx deletes, 409 drops, other 4xx drops + `sync.rejected`, 5xx/network stops) — nothing in that loop had to change, and `test/personal.test.ts` pins the row each write produces |
| A personal tool added on machine A appears on B after the sync | The host's `personalTools` half of the signed snapshot is the only carrier (SP04 §2); `backend/connected-catalog.ts` shows it, and `applyOutbox` overlays the writes this machine has not yet flushed. `test/personal.test.ts` drives the local cache from a snapshot body |
| Not-from-org warning and no auto camera/mic for personal tools | See "Camera and microphone" below |

### Camera and microphone (canonico §22, the owner's added acceptance)

- **The warning.** `backend/tool-windows.ts` marks a window `foreign` when its entry is
  `scope === 'personal'` or when the view it opened is. The window's title becomes
  `Not from your org — …`, and on every load that lands back on the entry origin the backend injects
  the banner (`warningScript`, top frame only, nothing read from the page, under `try`), which is the
  same restriction `eval` already has everywhere else (D3). `src/app.ts` adds the line to the Home
  card and the mark to the sidebar icon. Org tools (seed or host) are `scope === 'org'` and never get
  any of it.
- **No auto camera/mic.** There is no runtime call that grants media: the grant is `tinyjs.json`'s
  origin gate, `api.origins[<origin>] = ['login.report', 'media.camera', 'media.microphone']`, built
  by `scripts/gen-config.ts` from the origins of the **seed's** entries only, and
  `backend/seed.ts`'s `gateOrigins` mirrors it for `AppInfo.gateOrigins`. A personal tool is never in
  a release seed: it is a snapshot/outbox row while connected and a local `tool` row otherwise, and
  the one export path that could carry one (`catalog.exportToFile` → `exportSeed` →
  `validateSeed` → `validateEntry`) is the one that strips `scope`/`ownerId` (`shared/catalog.ts`).
  So a personal tool's origin is simply not a key of the gate: it keeps the engine's own prompt — the
  behaviour the owner asked for, by construction and not by a new branch. `backend/tool-windows.ts`
  and `scripts/gen-config.ts` needed no permission code; no runtime API grants or checks per window
  (`app.permissions.check/request` only reads and prompts).
- **Evidence.** `leitura`: `scripts/gen-config.ts` (`TOOL_METHODS`, the `for (const origin of tools)`
  loop), `shared/catalog.ts` (`validateEntry`, `validateSeed`), `backend/seed.ts` (`gateOrigins`),
  `backend/tiny.d.ts` (`permissions`). Not observed on the real surface: no smoke step opens a
  personal tool and captures media — that is a finding for the phase's smoke (below).

## Decisions

1. **The overlay, not a rewritten snapshot.** SP05 §2 says the personal half "lives in the snapshot
   plus the outbox overlay", so a write never touches `host.snapshot` (whose bytes the host signed and
   whose `version` guards the `304`). `applyOutbox` is pure and applies, in `id` order, exactly the
   three SP03 §2 personal routes; anything else is ignored, so a future outbox row of another kind
   cannot corrupt the catalog.
2. **`favorites.list` is an addition.** SP05 §3 lists the write alone (`favorites.set`), but the
   acceptance needs the UI to *know* the current list to draw the toggle's state; there is no other
   method that carries it (`catalog.list` is `Entry[]`). One read, `{ ids }`-ordered, answered from the
   effective catalog while connected (the snapshot's list with the pending writes applied) and from
   the local store otherwise. **Reported as a divergence**: SP05 §3 should gain the row.
3. **Local storage of the favorites and the personal views is `meta`, not a new table.** B7 was
   allowed one `user_version` bump to `4`; it did not need it, so the version stays **3**. A personal
   *tool* is a `tool` row (`scope`, `owner_id` — the columns B1 already added) because tool windows,
   icons, the vault and `catalog.get` all address rows; a favorite and a personal view have no row
   shape in this schema (the local `tool_view` has no person dimension), so they live as one JSON list
   per person under `favorites:<personId>` and `personal_views:<personId>`. No secret is stored.
4. **The id is the backend's.** `p-` + ten lowercase characters of SP02 §3's Crockford alphabet, from
   seven random bytes. `PERSONAL_TOOL_ID` mirrors the host's route pattern
   (`host/routes/person.ts`); a draft that names an id is an edit, and only of a tool this person
   already owns.
5. **The body of a tool write is the whole `PersonalTool`.** The host's `personalToolBody` requires
   every `Entry` field plus `updatedAt`, so the Nod fills the defaults the dialog does not ask for.
   `scope`/`ownerId` travel too — Elysia 2 strips what its schema does not declare (probed:
   `t.Object({id,title})` answers `{id,title}` for a body with two extra keys), so the host ignores
   them, and this side's overlay keeps them, which is what lets the page mark the entry before the
   host has answered.
6. **`host.remove(keepPersonal)` is implemented here.** The handler's own comment deferred it to
   block 2. Keeping the personal half materializes the snapshot's `personalTools` as local rows
   (owner = the snapshot's `me.id`, which is the local person's id, SP05 §2), its `personalViews` and
   its `favorites` into the local store; dropping it removes exactly the rows of that body and clears
   the store. `clearHost` still clears the outbox.
7. **A removed local personal tool takes its credential** (`backend/vault.ts`'s `removeAllForTool`),
   the rule `catalog.remove` follows (A6). While connected it does not: the tool is the host's and the
   local vault rows are this machine's own (B6's reading of the same case).

## What was left out

- **The icon of an adopted tool** (`host.remove` with `keepPersonal`): `adoptSnapshot` writes the
  entry, its views and the favorites, but not the icon. A connected entry's icon is a data URI inside
  the snapshot, and the local store is addressed by a hash (`<data>/icons/<sha256>.<type>`); wiring
  `Icons.save` needs a data-URI → `RawIcon` helper that does not exist yet (`backend/icons.ts` has
  `bytesToBase64`/`typeOfMime`, `backend/main.ts` has the other direction). The tool keeps its title,
  address, views and favorites and shows without an icon.
- **RF-40's "Add host" migration** (local tools offered as personal tools, "no local tool
  disappears"): it belongs to the join flow (`host.activate`/`host.signIn` in `backend/main.ts`), and
  it is not in this issue's acceptance. Not touched.
- **No UI for personal views** (`personal.saveView`/`removeView` are wired and replayed, and the
  connected catalog already opens them through `tools.openView`): the issue's UI list is the tool
  dialog, the star and the removal. A person cannot create a personal view from the page yet.
- **No smoke step**: the local/connected smokes (`test/smoke/`) were not extended. The B7 acceptance
  items that need the real surface — a personal tool window showing the banner, two machines
  exchanging a personal tool — are `leitura` + unit here, not `execucao`.
- **The host routes** (`PUT/DELETE /v1/personal/tools/:id`, `/v1/personal/views/:id`,
  `PUT /v1/favorites`) are another agent's slice (`host/routes/person.ts`); this side codes against
  SP03 §2 and `shared/host-api.ts` only.
- **The camera/mic acceptance on the real surface**: no capture is performed anywhere in this
  repository's tests, and the gate is build-time; the argument is in the section above.

## For other owners

- **Coordinator — `docs/specs/SP05-nod-connected.md` §3** should name the read beside the write:
  `favorites.list` → `Id[]` (decision 2).
- **Coordinator — `scripts/gen-config.ts` / `backend/seed.ts`**: if a future path ever lets a
  `scope: 'personal'` entry reach a release seed, both origin lists (`toolOrigins`, `gateOrigins`)
  must filter it out; today `validateSeed` strips the field first, so the filters would be dead code
  and were not added (decision in the camera section above).
- **V1 (`backend/vault.ts`)**: `personal.removeTool` calls `removeAllForTool`; a `bv1.` credential of
  a personal tool follows the same path as `catalog.remove`.

## Verification run here

- `bun test test/personal.test.ts` → `20 pass, 0 fail` (`execucao`): the overlay, `attachPersonalViews`,
  the id format, the local layer and the connected layer's one outbox row per write.
- `bun test test/tool-windows.test.ts` → `53 pass, 4 fail`; the three tests added under "the warning of
  a tool that did not come from the org (canonico §22)" pass, and the four failures are the login
  cascade's, all of them `the vault is locked — unlock with your password first` from
  `backend/vault.ts:85` (`requireVaultKey`) — V1's in-flight `bv1.` work in another slice, untouched
  here (`execucao`).
- `npx tsc --noEmit -p tsconfig.json` → only `backend/session.ts:521` and `shared/vault-crypto.ts:99`
  remain, both in other slices' files, none in the files above (`execucao`). The full gates are the
  orchestrator's.
