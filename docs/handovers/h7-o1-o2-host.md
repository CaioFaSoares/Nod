# Slice H7 + O1 (host, person side) + O2 (host) — personal tools, views and favorites; device sessions; minimum app version and update manifest

Authorizing issues: **#23** (H7, `area:host`, `sp:3`), **#27** (O1, `area:host,area:backend,area:src`,
`sp:2` — this file is its host half) and **#28** (O2, `area:host,area:backend`, `sp:3` — this file is
its host half), assigned by the implementation track coordinator with gate #1 already closed
(`docs/canonico.md` §14: RF-14, RF-35, RF-36, RF-39). The issue texts read for this slice are the
copies the coordinator handed over (`/tmp/nod/issue-23.md`, `-27.md`, `-28.md`); none of them carries
an `em-curso` label — that label does not exist in this repository's vocabulary (`docs/handovers/h2.md`,
`c1.md`, `h4.md`, `h8.md`) — so the authorization is the milestone plus the coordinator's assignment.

Contracts followed: `docs/specs/SP03-host-api.md` §1 (the status table, the auth levels, the error
shape that names the field, the body limit) §2 (the person table: `GET`/`DELETE /v1/sessions`, the
personal tool and view writes with `updatedAt`, `PUT /v1/favorites`, the `^p-[a-z0-9]{10}$` tool id)
and §3 (`GET /v1/meta/app` → `{ minAppVersion, update: { url } | null }`, public);
`docs/specs/SP01-host-data-model.md` §2 (the `entries`/`views`/`favorites`/`sessions` rows, the rules
the repo keeps out of SQL, and "favorites pruned when visibility goes away");
`docs/specs/SP04-sync.md` §1 (`minAppVersion` in the discovery) and §4 (`updatedAt` is the Nod's,
last-write-wins, `409` on a stale write); `docs/specs/SP07-host-deployment.md` §2 (the deployment
environment of discovery); `docs/specs/SP05-nod-connected.md` §3 (the RPC methods the host half of O1
serves). Rules: `AGENTS.md`, `host/context.md`.

Everything below is in English (RNF-08). No project gate was run: not `bun run typecheck`, not the
full `bun test`, not the smoke, not a formatter. What ran is what the mandate allows and what the
"real surface" rule asks for: this slice's two test files, the two peer test files whose behavior my
`host/config.ts`/`host/routes/state.ts` change touches, the **real** `host/main.ts` driven with
`curl` (its boot, both documents, the person routes on seeded rows, and the boot refusals), and one
scratch `tsc` probe of this slice's own files, which is disclosed in "Commands" and is not the gate.

## Files touched

| File | What changed |
| --- | --- |
| `host/routes/person.ts` | **New.** The person group of SP03 §2 behind `personAuth`: `GET /v1/sessions`, `DELETE /v1/sessions/:id` (own only), `PUT`/`DELETE /v1/personal/tools/:id`, `PUT`/`DELETE /v1/personal/views/:id`, `PUT /v1/favorites`. One `t.*` schema per body from the shared types (`PersonalTool` = `Entry` + `updatedAt`, `PersonalView`, `DeleteRequest`, `FavoritesRequest`), the personal-id pattern on the path, and three row→wire converters (a session row as `DeviceSession`, a tool row as `PersonalTool`, a view row as `PersonalView`). Every rule is the repo's: ownership by `owner_id`, the stale `409`, the invisible `403`, the unknown `404`; this file decides only the status and the shape. |
| `host/routes/meta.ts` | **New.** `GET /v1/meta/app` (public, O2): answers `AppMeta` — the resolved `minAppVersion` and `update: { url } | null`. No database, no caller, no body. The context cast is the folder's (`metaOf(ctx: unknown)`, as `routes/state.ts`'s `stateOf`): a plugin's own context type carries only its own decorations, so a direct cast is a `TS2352` — a peer's probe caught exactly that while this slice was in flight. |
| `host/person.test.ts` | **New.** 9 tests on the real app over a temp data dir: the own-session list (and that no token hash travels), the own revoke (the revoked device answers 401 at its next request, the other device still works, a second revoke is a no-op), another person's session `403` / an unknown one `404`, the personal tool upsert (create, stale `409`, newer wins, `400` for an id the Nod cannot generate and for a body whose `id` is not the path's, `403` for someone else's id, `404` on a delete of an unknown id, `204` + stale `409`), the personal view (`400` on an id that is not the path's, `403` for an entry the owner cannot see, `409` stale, the snapshot carrying the view under its entry, `204`/`404` on the delete) and the favorites (whole-list replace, the duplicate the repo drops, `409`, `403`), plus the ownership acceptance: the admin's snapshot and the admin's people and events answers carry no id of Bob's personal rows. |
| `host/meta.test.ts` | **New.** 8 tests: the defaults of the environment (`0.0.0`, `null`), the values read from it, the refusals (a non-semver, a non-https URL), and `GET /v1/meta/app` on the real app — the two answers, `update: null`, the public level (no token and a dead token alike, while `/v1/state` answers `401`), the discovery repeating the same `minAppVersion`, the resolved value winning over a later environment, and an app built with no resolved value reading the environment once for both documents. |
| `host/config.ts` | `MIN_APP_VERSION_ENV`, `UPDATE_URL_ENV`, `DEFAULT_MIN_APP_VERSION = '0.0.0'`, `loadAppMeta(env)` (semver and https validation, `ConfigError`), `appMetaOf(deps)`, and the `AppMeta` import from `shared/`. `loadConfig`/`HostConfig` are untouched (see decision 2). |
| `host/app.ts` | `AppDeps.appMeta?`, one `.decorate({ …, appMeta: deps.appMeta })`, the two `.use(personRoutes)`/`.use(metaRoutes)` mounts, and `/v1/personal/tools*` added to `bodyLimitFor`'s icon exception. |
| `host/main.ts` | Two lines: `loadAppMeta(process.env)` inside the existing `try` (boot validation) and `appMeta` handed to `createApp`. Not in the slice's file list — see decision 3. |
| `host/routes/state.ts` | The discovery's `minAppVersion` now comes from `appMetaOf(ctx)` instead of a second read of `process.env`, and the two constants moved to `host/config.ts` with a re-export (`MIN_APP_VERSION_ENV`, `DEFAULT_MIN_APP_VERSION`) so the imports of `host/state.test.ts` and `test/host-admin.test.ts` keep working. Not in the slice's file list — see decision 4. |
| `shared/host-api.ts` | Additive: `HOST_ROUTES.appMeta = '/v1/meta/app'` and the `AppMeta` interface beside `Discovery`; the file's scope comment no longer excludes `/v1/meta/app`. Coordinated with HostShares, who appends the block 2 sharing names to the same file. |
| `host/context.md` | The status paragraph (the person group and meta landed; every SP03 §2 route is served), the layout table (a row per new route file and per new test file, `config.ts` row extended), and one new rule for the single app-metadata value. |
| `docs/handovers/h7-o1-o2-host.md` | This file. |

`host/repo.ts`, `host/migrations.ts`, `host/snapshot.ts`, `host/routes/admin.ts` and the block 2 share
tables were **not** touched: every query these routes need already existed (`sessionsOfPerson`,
`sessionById`, `revokeOwnSession`, `savePersonalTool`, `removePersonalTool`, `savePersonalView`,
`removePersonalView`, `replaceFavorites`, `personalTool`, `listPersonalViews`), and the admin half of
O1 was already served (see acceptance item 3).

## Acceptance criterion — how each item was met

| Item | How it was met | Evidence |
| --- | --- | --- |
| #23 — "Personal routes enforce ownership (403 otherwise) and last-write-wins by `updatedAt` (409 when stale)." | Ownership is never read from a body: the person comes from the token (`callerOf`) and every repo read and write filters by `owner_id` in its SQL, so a tool or view id of someone else reaches `ForbiddenError('not yours')` → **403**, and an id no query ever sees reaches `NotFoundError` → **404**. `updatedAt` travels untouched into the repo, which throws `ConflictError('stale updatedAt')` → **409** when the stored row is newer. The route file repeats no rule. | `execucao` — `bun test host/person.test.ts` (9 tests, 0 fail) and the `curl` walkthrough: `PUT /v1/personal/tools/p-curlnotes1` by its owner → `200` with the row; the same id by the other person → `403 {"error":"not yours"}`; an older `updatedAt` → `409 {"error":"stale updatedAt"}`; a view under the other person's entry → `403 {"error":"not yours"}`; an id outside `^p-[a-z0-9]{10}$` → `400 {"error":"invalid params: id must match pattern \"^p-[a-z0-9]{10}$\""}`; `DELETE` of an unknown session id → `404 {"error":"unknown session"}`. |
| #23 — "Neither another person nor an admin receives someone's personal data in any response." | The group answers only what the repo filtered by owner, and no other group reads personal rows with a wider filter (`routes/admin.ts` reads people, sessions, the org catalog and events; `snapshotSource` reads `listPersonalTools(me.id)`). The test asserts it on the wire: Bob's snapshot carries his tool, view and favorite; the admin's snapshot carries empty `personalTools`, `personalViews` and `favorites` and none of those ids appears in its bytes; neither the admin's people list nor the admin's event list mentions them. | `execucao` — the last describe of `host/person.test.ts` ("personal data stays with its owner"), on the real app. |
| #27 — "Settings → Account lists the person's devices; revoking one signs that device out at its next sync." (host half) | `GET /v1/sessions` answers the caller's live sessions as `DeviceSession[]` — the device, the three timestamps and **no** token hash — and `DELETE /v1/sessions/:id` revokes one of the caller's own rows, after which `auth.authenticate` no longer resolves that token. | `execucao` — two test cases in `host/person.test.ts` and the `curl` walkthrough: the list of one device; `DELETE` of the own session → `204` and the same token → `401 {"error":"invalid credentials"}` while the other device's token answers `200`; a second `DELETE` of the same row → `204` (idempotent). |
| #27 — "The admin can revoke any person's session." (host half) | Already served by `routes/admin.ts` before this slice: `GET /v1/admin/people/:id/sessions` (read: lines 292–297) and `DELETE /v1/admin/sessions/:id` (lines 302–309), both behind `adminAuth`. Nothing was added or changed. | `leitura` of `host/routes/admin.ts` + `execucao`: my tests read another person's sessions through the admin route and assert that a person's refused `DELETE` left that list untouched. |
| #28 — "`minAppVersion` from discovery: an older Nod tells the person to update" (host half: the value). | The discovery's `minAppVersion` is the resolved `AppMeta.minAppVersion`, from `loadAppMeta(process.env)` — one value for the process, read once at boot, and the same value `GET /v1/meta/app` answers. | `execucao` — booted with `NOD_MIN_APP_VERSION=1.4.2`: `GET /.well-known/nod` → `"minAppVersion":"1.4.2"` and `GET /v1/meta/app` → `{"minAppVersion":"1.4.2",…}`; booted without it: both answer `"0.0.0"`. The comparison itself (the Nod refusing to write) is not the host's — see "What was left out". |
| #28 — "The host can serve the update manifest URL used by `update.check`." | `GET /v1/meta/app` (public, SP03 §3) answers `update: { url }` from `NOD_UPDATE_URL`, `null` when the deployment sets none, and the boot refuses a value that is not an `https://` URL. | `execucao` — booted with `NOD_UPDATE_URL=https://updates.example.test/manifest.json`: `{"minAppVersion":"1.4.2","update":{"url":"https://updates.example.test/manifest.json"}}`; without it: `{"minAppVersion":"0.0.0","update":null}`; with `NOD_UPDATE_URL=http://…` the process printed `NOD_UPDATE_URL must be https://: …` and exited `1`. |
| The slice's own statuses (`400`, `403`, `404`, `409`, `401`) | Each route of the group answers the table of SP03 §1: the pattern of the path/body fails as the `400` that names the field (and a `DELETE` whose body is missing or not an object is a `400` too, never a handler reading `undefined`), the repo's typed errors map unchanged (`409`/`403`/`404`), and the guard answers `401`. | `execucao` — `host/person.test.ts` covers all five on the real app (including `DELETE` with no body → `400 {"error":"invalid body: must be object"}` and with `{}` → the `400` naming `updatedAt`); the `curl` walkthrough shows `200/204/400/401/403/404/409` on the booted process. |

## Commands run and observed results

1. **This slice's own test files** (the two new ones), against the real app over temp data dirs:

   ```
   $ cd host && bun test person.test.ts meta.test.ts
   17 pass, 0 fail, 195 expect() calls — Ran 17 tests across 2 files. [2.62s]
   ```

   Nine tests are the person group (`person.test.ts`) and eight the app metadata (`meta.test.ts`).
   The final run of the four files my changes touch, in one command:

   ```
   $ cd host && bun test person.test.ts meta.test.ts state.test.ts health.test.ts
   33 pass, 0 fail, 299 expect() calls — Ran 33 tests across 4 files. [2.72s]
   ```

2. **The two peer test files my `config.ts`/`routes/state.ts` change could break** — `state.test.ts`
   (the discovery's `minAppVersion`, which it drives by setting `NOD_MIN_APP_VERSION` in the process
   environment after the app exists) and `health.test.ts` (its exact `toEqual` on `loadConfig`'s
   answer, which is why the new fields did not go into `HostConfig` — decision 2):

   ```
   $ cd host && bun test state.test.ts health.test.ts
   16 pass, 0 fail, 104 expect() calls — Ran 16 tests across 2 files. [209.00ms]
   ```

   Neither file was edited.

3. **The real surface — the repository's own boot, `host/main.ts`**, on a throwaway data dir, driven
   with `curl`. Two people with one session each were seeded straight through `createRepo` into that
   data dir (a scratch script in `/tmp`, deleted afterwards; SP02 §5's activation flow is H4's, not
   this slice's). The process printed its single boot line and nothing else through every request
   below (no request line, no body, no secret):

   ```
   $ NOD_DATA=/tmp/nod-h7-curl NOD_PUBLIC_URL=https://nod.example PORT=8099 NOD_MIN_APP_VERSION=1.4.2 bun host/main.ts
   nod host listening on :8099 (schema 2); backups every 24 h, keeping 14

   GET  /v1/sessions (bob)                        → [{"id":"s-p-curlbob","personId":"p-curlbob","device":{"name":"nod-curl","os":"macos","appVersion":"0.3.5"},"createdAt":…,"lastSeenAt":…,"expiresAt":…}]
   PUT  /v1/personal/tools/p-curlnotes1 (bob)     → {"id":"p-curlnotes1","scope":"personal","ownerId":"p-curlbob","title":"Curl notes",…,"updatedAt":"2026-10-17T10:00:00.000Z"} [200]
   PUT  the same id, older updatedAt              → 409 {"error":"stale updatedAt"}
   PUT  the same id with ada's token              → 403 {"error":"not yours"}
   PUT  /v1/personal/tools/p-curlnotes1x          → 400 {"error":"invalid params: id must match pattern \"^p-[a-z0-9]{10}$\""}
   PUT  /v1/favorites {"entries":["p-curlnotes1"]}→ 204
   GET  /v1/state (bob)                           → "favorites":["p-curlnotes1"] … "personalTools":[{"…","ownerId":"p-curlbob","…"}]
   PUT  /v1/personal/views/<uuid> under his tool  → 200 {"id":"<uuid>","label":"Board","mode":"window","scope":"personal","ownerId":"p-curlbob","entryId":"p-curlnotes1","updatedAt":"2026-10-17T10:10:00.000Z"}
   PUT  a view under ada's entry (bob)            → 403 {"error":"not yours"}
   DELETE /v1/sessions/s-p-curlada (bob)          → 403 {"error":"not yours"}
   DELETE /v1/sessions/s-p-curlbob (bob, his own) → 204, and the same token then → 401 {"error":"invalid credentials"}
   DELETE /v1/sessions/<unknown uuid> (ada)       → 404 {"error":"unknown session"}
   GET  /v1/sessions without a token              → 401
   ```

   And the O2 route on the same boot, plus the defaults and the refusals on the process:

   ```
   $ NOD_DATA=… PORT=8097 NOD_MIN_APP_VERSION=1.4.2 NOD_UPDATE_URL=https://updates.example.test/manifest.json bun host/main.ts
   GET /v1/meta/app (no token)          → 200 {"minAppVersion":"1.4.2","update":{"url":"https://updates.example.test/manifest.json"}}
   GET /v1/meta/app (dead bearer)       → 200, the same body
   GET /.well-known/nod                 → {"api":1,…,"fingerprint":"0EVN-ZWNB-BT73-0NXV","minAppVersion":"1.4.2","signIn":["access-code"]}
   GET /v1/sessions (no token)          → 401 {"error":"invalid credentials"}

   $ … PORT=8098 bun host/main.ts                  (neither variable set)
   GET /v1/meta/app                     → {"minAppVersion":"0.0.0","update":null}
   GET /.well-known/nod                 → "minAppVersion":"0.0.0"

   $ … NOD_MIN_APP_VERSION=v1.2 bun host/main.ts
   invalid NOD_MIN_APP_VERSION: v1.2                                    (one line, exit 1)
   $ … NOD_UPDATE_URL=http://updates.example.test/m.json bun host/main.ts
   NOD_UPDATE_URL must be https://: http://updates.example.test/m.json  (one line, exit 1)
   ```

   The throwaway data dirs and the scratch seeding script were deleted afterwards.

4. **A scratch `tsc` probe over this slice's files** (not the project gate, which is the
   coordinator's; the command mirrors the one H8 and HostShares disclose, and it lists only this
   slice's files plus the three the boot pulls in through `host/app.ts`):

   ```
   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2023 --module esnext \
       --moduleResolution bundler --lib es2023,dom --types bun --typeRoots ./host/node_modules/@types \
       --skipLibCheck --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax \
       --erasableSyntaxOnly --noFallthroughCasesInSwitch \
       host/routes/person.ts host/routes/meta.ts host/person.test.ts host/meta.test.ts \
       host/config.ts host/app.ts host/main.ts host/routes/state.ts
   (no output — no diagnostics)
   ```

   One diagnostic did appear while the slice was in flight, in `host/routes/meta.ts:27` (`TS2352`,
   the context cast), reported by HostShares's own probe of the shared files, and it is fixed here:
   `metaOf(ctx: unknown)` is the folder's confined cast (`host/auth.ts`'s `hostOf`, `routes/state.ts`'s
   `stateOf`). The probe above is after the fix.

## Decisions and findings for the coordinator

1. **Finding — the code default of `NOD_MIN_APP_VERSION` is `0.0.0`, and SP07 §2 plus both compose
   files still spell `0.3.0`.** This slice's mandate sets the code default to `0.0.0` ("the host
   refuses none"), which is what the boot applies; `host/compose.yaml` and `host/compose.coolify.yaml`
   pass `${NOD_MIN_APP_VERSION:-0.3.0}`, so a real deployment still serves `0.3.0` and the two agree
   only because the compose variable is always set. One of the two has to move: `host/compose.yaml`
   is packaging's (not this slice's) and SP07 §2 line 70/109 is the spec's. Note the default stopped
   being *observable* anyway: `host/state.test.ts` asserts the discovery against the constant, not
   against the literal, so it passed before and after.
2. **Decision — the app metadata did not go into `HostConfig`, and why.** Two peer test files pin
   `loadConfig`'s shape exactly (`host/health.test.ts`: `expect(config).toEqual({ dataDir, publicUrl,
   port, dev })`) and six more build a `HostConfig` literal by hand (`admin`, `auth`, `backup`,
   `events`, `guild-icon`, `state`, plus `test/host-admin.test.ts`); a new required field breaks all
   of them, and none of those files is this slice's. So the values are a second resolved object
   (`AppMeta`) that `loadAppMeta` produces in the same file, `main.ts` hands to `createApp`, and
   `AppDeps.appMeta` carries — optional, with `appMetaOf` falling back to `loadAppMeta(process.env)`
   for an app a harness built without it (which is also what keeps `host/state.test.ts`'s
   environment-driven discovery case green). Follow-up for whoever owns the harnesses: once they build
   `HostConfig` through one helper, `appMeta` can become required and the fallback deleted.
3. **`host/main.ts` was touched although it is not in the slice's file list.** "Validate at boot like
   the rest of `config.ts`" cannot be done from any listed file: `loadAppMeta(process.env)` has to run
   inside `start`'s existing `try` so a mistyped value is the one-line `exit 1` every other
   configuration error is. Two lines, no other change.
4. **`host/routes/state.ts` was touched (one line + a re-export).** The acceptance "discovery and
   `/v1/meta/app` share one config value" is exactly the discovery's `minAppVersion` line: it now
   reads `appMetaOf(ctx)` and nothing else. `MIN_APP_VERSION_ENV` and `DEFAULT_MIN_APP_VERSION` moved
   to `host/config.ts` (the module that reads the environment) and are **re-exported** from
   `routes/state.ts`, because `host/state.test.ts` and `test/host-admin.test.ts` import them from
   there; H6's proposal in `docs/handovers/h6.md` to delete those names outright would have broken
   both files, which are not mine to edit.
5. **Finding — `bodyLimitFor` gained `/v1/personal/tools*`.** SP03 §1 lists the 512 KB exception as
   "the routes whose body can carry an icon": an `entry.icon` data URI or the guild PNG, and names
   `/v1/admin/tools*`, `/v1/admin/bootstrap` and `/v1/admin/guild/icon`. A personal tool body carries
   the same `Entry.icon` (the Nod's `personal.saveTool` sends the entry, and a personal tool can be
   promoted to the org catalog on the next screen), so the path is now in the exception; without it a
   300 KB icon in a personal tool would answer `413` where the same icon in an org tool is accepted.
   The spec's list should gain the path (SP03 §1 is the owner's file, not this slice's).
6. **Decision — an unknown session id answers `404`, another person's answers `403`.** SP03 §1 reads
   "404 when the id is found and visible to the caller, otherwise 403", which a strict reading would
   apply to *any* id a person cannot see, an unknown one included. The folder's own rule
   (`host/context.md`: "`new NotFoundError('unknown person')` for an id no query ever sees") and the
   two precedents (`repo.removePersonalTool` → `404 'unknown tool'`; `routes/admin.ts`'s session
   delete → `404 'unknown session'`) decide `404` for an id that exists nowhere and `403` for a row
   that exists and belongs to someone else. My tests pin both; if the owner prefers the strict
   reading, the change is one `throw` in `host/routes/person.ts`.
7. **Finding — three converters now have two homes each.** `toDeviceSession` (`routes/admin.ts` and
   `routes/person.ts`) and the entry/view row→wire mappings (`snapshot.ts`'s `entryOf`/`viewOf`/
   `personalViewOf` and `routes/person.ts`'s three) are the same nine-to-fifteen lines written twice.
   I did not fold them: `routes/admin.ts` and `host/snapshot.ts` are not this slice's files, and both
   are being edited in this phase (HostShares appends block 2 to `snapshot.ts`). One home — an export
   from `snapshot.ts`, or a small `host/wire.ts` — is a mechanical follow-up for the coordinator.
8. **Finding — the host validates `NOD_MIN_APP_VERSION` more strictly than the Nod reads it.**
   `loadAppMeta` refuses `1.2`, `v1.2.3`, `latest` (SP04 §1 says "semver"), while
   `shared/version.ts`'s `compareVersions` treats exactly those as "no opinion" and keeps syncing
   (`test/version.test.ts`). The host failing a boot on a value the Nod would ignore is a deliberate
   strictness, and it is one regex to loosen; SP07 §2 does not say whether an unreadable value should
   stop the process or be served. Reporting, not deciding.
9. **Decision — `PUT /v1/personal/tools/:id` and `PUT /v1/personal/views/:id` require the body's `id`
   to be the path's `id`** (`400 "invalid body: id must match the path id"`), the same check
   `routes/admin.ts` makes for `PUT /v1/admin/tools/:id`. The body's `roles` and `views` are
   shape-checked and not written: a personal entry has no grants (SP01 §2), and a personal view is its
   own route and its own row. I probed Elysia 2.0.0-beta.32 on this: an undeclared property in a body
   is **dropped** from the parsed body, not refused (so a Nod sending `scope`/`ownerId` inside the
   entry is not a `400`).
10. **`shared/host-api.ts` was appended to, not restructured**: one `HOST_ROUTES` key and one
    interface, coordinated with HostShares (`agent://HostShares`), who appends the block 2 sharing
    names to the same two regions in this phase. The header's old sentence ("the routes of SP03 §2–§3
    except `/v1/meta/app`") was corrected to include it.

## What was left out

- **The admin half of O1** (`GET /v1/admin/people/:id/sessions`, `DELETE /v1/admin/sessions/:id`):
  already served by `host/routes/admin.ts` since H5, so no edit. Proved by reading the file and by
  driving that route from this slice's tests.
- **The Nod side of O1 and O2** (Settings → Account's list and revoke, the version gate, the update
  manifest fetch): `backend/host-client.ts` already declares `sessions()`, `revokeSession(id)` and
  `appMeta()` with a shape check that matches this `AppMeta` byte for byte, and `backend/sync.ts`
  reads `appMeta` without a bearer; that track's own slice owns the behavior, and this file claims
  nothing about it.
- **The comparison of `minAppVersion` against the running app** and the "read-only from cache"
  behavior of #28's first acceptance item: `shared/version.ts` (`compareVersions`) and the front's
  gate are another slice's; the host only serves the value.
- **No specification, `canonico.md`, compose, migration or dependency change**: `host/migrations.ts`
  and the block 2 share tables are HostShares's (migration 2 is already applied — the real boot above
  reports `schema 2`), `host/repo.ts` needed nothing, and `host/package.json` is untouched (no new
  dependency, no toolchain change).
- **No project gate**: `bun run typecheck`, the full `bun test`, the smoke and the formatters did not
  run here; the orchestrator runs them once at the end of the phase.

## For other owners

- **HostShares** (`shared/host-api.ts`, `host/app.ts`, `host/snapshot.ts`): my additions there are the
  two named in decision 10, plus `bodyLimitFor`'s `/v1/personal/tools*` line. Nothing of yours was
  renamed or reordered; `AppMeta` and `appMeta` are disjoint from the sharing names.
- **The front/backend slices of B7, O1 and O2**: the wire shapes the host now accepts for the personal
  writes are `shared/host-api.ts`'s — `PersonalTool` (an `Entry` + `updatedAt`, `id` equal to the
  path's), `PersonalView` (`id`, `entryId`, `label`, `url`, `mode`, `updatedAt`), `{ updatedAt }` for
  the two deletes and `{ entries, updatedAt }` for `PUT /v1/favorites`. The answers are the stored
  row (`PersonalTool`/`PersonalView`) or `204`; a stale write is `409`, an entry or id of someone else
  is `403`, an id that exists nowhere is `404`. `GET /v1/sessions` answers `DeviceSession[]` with no
  token field at all, and `DELETE /v1/sessions/:id` is `204` for the caller's own (a repeat is also
  `204`). `GET /v1/meta/app` needs **no** bearer.
- **Packaging** (`host/compose.yaml`, `host/compose.coolify.yaml`): decision 1 — the compose default
  `0.3.0` against the code default `0.0.0`.
- **The spec owner** (`docs/specs/SP03-host-api.md`): decision 5 (`/v1/personal/tools*` in §1's icon
  exception) and decision 6 (the `404`/`403` wording of §1 for an id no query sees).
- **The coordinator**: decisions 2 (the harness follow-up that would let `appMeta` become required),
  6, 7 (one home for the row→wire converters), 8 and 9.

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, written only by its owner: the files
touched, the acceptance and how it was met with how it was obtained, and what was left out). The
state of the three stories is the GitHub issues #23, #27 and #28; this file decides nothing about
them, marks none of them closed and moves no file out of `_proposto/`.
