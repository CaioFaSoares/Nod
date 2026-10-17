# Slice I2h — Host side of the guild icon

Owner: the implementation track's **host** slice of the guild icon (the Nod side is I2b's, the
packaging side I1's). Authorized by the coordinator's assignment in this session, on the same footing
`docs/handovers/h2.md`, `c1.md` and `h6.md` recorded: this repository has no `em-curso` label
(`gh` shows milestones, not that vocabulary), and there is **no guild-icon issue** among #1–#38 —
the request is the owner's of 2026-10-16 ("builds customizadas com ícones diferentes … trocar o ícone
por um custom por guild e escolher"). **Finding for the coordinator**: if this work needs a
permanent record, it needs an issue; nothing here can create one.

Contracts followed: `docs/specs/SP03-host-api.md` §1 (the status table of 400/401/403/404/413, the
`{ error }` shape with a static message, the auth levels, the body-limit exceptions) and §2;
`docs/specs/SP04-sync.md` §2 (`Snapshot` and its signature — `guildIcon` travels inside the signed
bytes); `docs/specs/SP01-host-data-model.md` §1 (`meta`, one SQLite file) and §4–§5
(`meta.schema_version`, the unreleased block 1 at `1`); `docs/specs/README.md` (base64url without
padding, lowercase hex for digests, ISO 8601 UTC); `host/context.md` (the guard rule `personAuth`
before `adminAuth`, `repo.ts` as the only `bun:sqlite` module, the body limit decided in `app.ts`).
Rules: `AGENTS.md`, `host/context.md`, `shared/context.md` ("types are the contract").

No project gate was run: not `bun run typecheck`, not the repo-wide `bun test`, not the smoke, not a
formatter. What ran is the acceptance's own command (`bun test host/`), this slice's test file, and
one scratch `tsc` probe of this slice's six files (below, item 3 — a probe, not the gate).

## Files touched

| File | What changed |
| --- | --- |
| `shared/host-api.ts` | `HOST_ROUTES.guildIcon` (`/v1/guild/icon`) and `HOST_ROUTES.adminGuildIcon` (`/v1/admin/guild/icon`); the new `GuildIconRequest { png }` / `GuildIconResponse { sha256 }`; `PNG_SIGNATURE` and the pure `isPng(bytes)`; `Snapshot.guildIcon: string \| null`, documented as inside the signed bytes. Nothing else in the file moved. |
| `host/repo.ts` | The `GuildIcon { sha256, bytes }` row type, the two keys `GUILD_ICON_HASH_KEY` / `GUILD_ICON_BYTES_KEY`, and four `Repo` members — `guildIconHash()` (the digest alone: it is the read of every `GET /v1/state`), `guildIcon()` (bytes + digest, the read of `GET /v1/guild/icon`), `setGuildIcon(icon)` (both rows in one transaction), `clearGuildIcon()` (both rows, answers whether there was one). The `SELECT`/`INSERT` pair of `meta` was extracted once as `readMeta`/`writeMeta`, and the interface's `meta`/`setMeta` delegate to them — same behavior, same `schema_version` refusal inside `setMeta`, one query shape. |
| `host/snapshot.ts` | `SnapshotSource.guildIcon` and its read (`repo.guildIconHash()`); `snapshotDocument` writes it into the body, so it is covered by the Ed25519 signature and by the `version` digest — a changed icon changes the version. No other line. |
| `host/routes/guild.ts` | **New.** `guildRoutes`: one route, `GET /v1/guild/icon`, behind `.use(personAuth)`. It answers `new Response(icon.bytes)` with `content-type: image/png` and `ETag: "<sha256>"` (`etagOf`, the one quoting rule of `host/snapshot.ts`), or throws `NotFoundError('unknown guild icon')` → SP03 §1's 404. It owns the HTTP surface only: no digest, no key, no storage. |
| `host/routes/admin.ts` | The `guildIconBody` schema (base64url alphabet + `minLength 1`) and SP03 §2's two admin routes: `PUT /v1/admin/guild/icon` (decode, refuse a non-PNG with 400, hash, store, answer `{ sha256 }`) and `DELETE /v1/admin/guild/icon` (`204`, idempotent, `clearGuildIcon`). Both sit inside the existing `personAuth` + `adminAuth` group. |
| `host/app.ts` | `bodyLimitFor` gained `path === HOST_ROUTES.adminGuildIcon` (the icon exception of SP03 §1, 512 KB), its doc comment widened to "an `entry.icon` data URI or the guild PNG"; `createApp` mounts `.use(guildRoutes)` and its comment names the group. |
| `host/guild-icon.test.ts` | **New.** 12 tests on the real app over a temp data dir (below). |
| `host/context.md` | The status paragraph names `routes/guild.ts` and the icon's storage; the layout table gains `routes/guild.ts` and `guild-icon.test.ts`, and the `snapshot.ts` row names `guildIcon`; the rules gain the icon's two `meta` rows and the widened body-limit bullet. |
| `docs/specs/SP03-host-api.md` | §1's body-limit bullet (the third path, and the encoded/decoded asymmetry); §2's person table (`GET /v1/guild/icon`) and admin table (`PUT`/`DELETE /v1/admin/guild/icon`) plus one paragraph on where the bytes and the digest live. |
| `docs/specs/SP04-sync.md` | §2's `Snapshot` gains `guildIcon: string \| null` with a paragraph (what the field is, that it is signed, what the Nod must do with it), and §6 gains the matching acceptance line. |
| `docs/handovers/i2h-guild-icon-host.md` | This file. |

**Not edited on purpose**: `host/migrations.ts` (finding 1 below), `host/state.test.ts` (its snapshot
assertions are about `me`'s keys, the version formula and the `304` — none of them touches the new
field, so nothing needed adjusting; the file passes unchanged), and `shared/host-merge.ts` +
`test/*` (not this slice's files; see "For other owners").

## Acceptance criterion — how each item was met

All twelve tests are on the real Elysia app (`createApp` over a `bootHost` temp data dir), through
`app.handle(new Request(...))`, with the people and their sessions seeded through the real repo — no
mock of the app, the repo or the database (`execucao`, `bun test host/guild-icon.test.ts`).

| Item | How it was met | Evidence |
| --- | --- | --- |
| Admin `PUT` stores and answers the sha256 | `PUT /v1/admin/guild/icon` decodes the base64url body, checks the PNG signature, hashes with `shared/encoding.ts`'s `sha256Hex` and stores bytes + digest in the two `meta` rows **inside one transaction**. The test asserts the answer `{ sha256 }` equals `sha256Hex(bytes)`, that `GET` then returns those exact bytes with that digest as the `ETag`, and that a **second boot over the same data dir** answers the same bytes and the same `ETag` (the icon is data of SP01 §1's file, not of the process). | `execucao` |
| Non-PNG is 400 | `isPng` (the first eight bytes of ISO/IEC 15948 §5.2) refuses a text file with `400 {"error":"invalid body: png must be a PNG"}`; a second test sends `'not base64url!'`, `'AAAA='` and `''` and gets the schema's 400 naming the field. Both tests assert the repo is still empty afterwards, and that the person route answers 404. | `execucao` |
| Over 512 KB is 413 | `host/app.ts`'s `bodyLimitFor` puts this path in the icon exception, so a body over 512 KB is the `413 {"error":"body too large"}` of SP03 §1 — the test sends a 512 KB + 1 byte PNG (≈ 683 KB of base64url body) and asserts exactly that, plus the repo is empty. A fourth test sends a 300 KB PNG and asserts `200`, which proves the path really is in the exception (the 256 KB default would have refused it). | `execucao` |
| Member `PUT` is 403 | The routes sit inside the group's `.use(personAuth).use(adminAuth)`, so a live non-admin member gets `403 {"error":"admin only"}` and a tokenless caller `401 {"error":"invalid credentials"}` — the app's error mapping, not the route's. | `execucao` |
| `GET` returns the exact bytes with the `ETag`, 404 when there is none | `new Response(icon.bytes, { 'content-type': 'image/png', ETag: "\"<sha256>\"" })`: the test compares the returned bytes element by element with the uploaded PNG, and the header with the digest. Without an icon it is `404 {"error":"unknown guild icon"}`; without a live session, `401`. | `execucao` |
| `DELETE` clears | `repo.clearGuildIcon()` removes both rows in one transaction; the route answers `204` with an empty body. The test asserts `204`, the repo empty, the next `GET` a 404, a second `DELETE` still `204` (idempotent) and a member's `DELETE` a `403`. | `execucao` |
| The snapshot carries `guildIcon` matching the sha256 of the `GET` bytes, and its version moves when the icon changes | `snapshotDocument` emits `source.guildIcon` (the repo's digest), so the field is inside both the `version` digest and the Ed25519 signature. The test walks the whole story for a member: `null` before, then the digest of exactly the bytes `GET /v1/guild/icon` returns, then a replacement, then `null` after the delete — asserting the `version` moved at each step (and that a rewrite of identical bytes leaves both `version` and `issuedAt` untouched). | `execucao` |
| The signature still verifies | The same test imports the discovery's raw Ed25519 key with `crypto.subtle` and verifies the `Nod-Signature` over the bytes **as received**: `true`, and `false` after flipping one byte. | `execucao` |
| `bun test host/` green | `120 pass, 0 fail, 1081 expect() calls, 8 files` — this slice's 12 tests included, and `host/state.test.ts` unchanged. | `execucao` |

## Commands run and observed results

1. **The acceptance's own command**, on the final tree:

   ```
   $ bun test host/
   120 pass
   0 fail
   1081 expect() calls
   Ran 120 tests across 8 files. [8.03s]
   ```

2. **This slice's file** (12 tests: 7 for the admin's write, 2 for the person's read, 1 for the
   delete, 2 for the snapshot):

   ```
   $ bun test host/guild-icon.test.ts
   12 pass
   0 fail
   65 expect() calls
   Ran 12 tests across 1 file. [377.00ms]
   ```

3. **A scratch `tsc` probe of this slice's six files** (not the project gate; it mirrors
   `host/tsconfig.json`'s options and lists only these files, the way `h6` disclosed its own):

   ```
   $ ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2023 --module esnext \
       --moduleResolution bundler --lib es2023,dom --types bun --typeRoots ./host/node_modules/@types \
       --skipLibCheck --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax \
       --erasableSyntaxOnly --noFallthroughCasesInSwitch \
       host/app.ts host/repo.ts host/snapshot.ts host/routes/admin.ts host/routes/guild.ts \
       host/guild-icon.test.ts
   (no diagnostics)  exit=0
   ```

   It found four real errors while I worked and all four are fixed: the test's two response-byte
   helpers were annotated `Uint8Array` (bare), which `sha256Hex` and `crypto.subtle` reject as
   `ArrayBufferLike`-backed (they now say `Uint8Array<ArrayBuffer>`, the rule of
   `shared/encoding.ts`). **The repo-wide `bun run typecheck` was not run** — it is the coordinator's,
   and at the moment this slice landed it was being unblocked by two other owners (see below).

4. **Not run**: `bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter.

## Decisions and findings for the coordinator

1. **No migration: the icon is two `meta` rows.** The mandate offered "meta rows or a small table".
   A table needs migration **2**, and `host/health.test.ts:73` and `host/repo.test.ts:145` both pin
   `schema_version = '1'` — files that are not this slice's, in the middle of a block 1 that SP01 §5
   deliberately keeps at `1` while unreleased. So the bytes travel base64url in
   `meta.guild_icon_bytes` and the digest in `meta.guild_icon_sha256` (SP01 §2's key/value table, the
   same file as everything else). **Finding for the owner of SP01 §2**: its list of `meta` keys
   (`schema_version`, `guild_name`, `created_at`) should name these two; `docs/specs/SP01-*.md` is not
   this slice's file.
2. **The 512 KB of SP03 §2 is the *encoded* body's, not the icon's — the usable PNG is ≈ 393 KB.**
   `PUT` carries the PNG base64url, which is a third larger than the bytes: a 512 KB body can only
   hold ≈ 393 KB of PNG. The mandate says the route joins the icon body-limit exception (512 KB) and
   that the decoded icon is ≤ 512 KB; with both, the body limit is the strictly binding one, and
   **both** refuse with the same `413 body too large`, so the acceptance ("over 512 KB → 413") holds
   either way. Because a decoded check at 512 KB would be unreachable code (a body that could hold it
   is already refused), the route does not restate it; the ceiling lives in `bodyLimitFor`, and
   `docs/specs/SP03-host-api.md` §1 now says so. **Decision for the coordinator**: if the owner wants
   a real 512 KB PNG accepted, `bodyLimitFor` needs its own constant for this path (≈ 700 KB, the
   base64url of 512 KB + the JSON envelope) — a one-line change, and the decoded check would then be
   the binding one.
3. **The PNG test is the signature alone.** Eight bytes of ISO/IEC 15948 §5.2 (`shared/host-api.ts`'s
   `PNG_SIGNATURE`/`isPng`). The host decodes no image: that would be a dependency, and SP03 §2 asks
   only for "must start with the PNG signature".
4. **The `GET` has no `304`.** SP03 §2 fixes `200` / `404` for it; the `ETag` is there so the Nod can
   tell a tampered download from the signed digest (`Snapshot.guildIcon`), not for a conditional
   request. `host/snapshot.ts`'s `etagMatches` already exists if the app wants a `304` later.
5. **Two 400s, one of them route-built.** A character outside base64url fails the schema, so the 400
   is `app.ts`'s and names the field; padding, a length without whole bytes and non-zero trailing bits
   are `shared/encoding.ts`'s `fromBase64url` refusal, which the route answers with
   `invalid body: png is not base64url` — the precedent `routes/admin.ts` already set with
   `invalid body: id must match the path id`. Both messages are static and echo nothing (SP03 §1).
6. **The `ETag` reuses `etagOf`** from `host/snapshot.ts` instead of a second `"…"` quoting in
   `routes/guild.ts`: SP04 §2 names the shape and one function owns it.
7. **`Snapshot.guildIcon` is required, and that broke four literals outside this slice.**
   `shared/host-merge.ts`'s `clearOrgData` (R2App's, fixed: the `cleared` body carries the snapshot's
   own value, never `null` — a 401 must not delete a guild icon that still exists) and the test
   builders in `test/sync.test.ts`, `test/connected-catalog.test.ts` and `test/host-merge.test.ts`
   (R3TestsConfig's, fixed). The field is required on purpose: an optional field would let a producer
   silently drop the icon from the signed bytes.
8. **The digest is read per snapshot, the bytes are not.** `snapshotSource` calls `guildIconHash()`
   only, so a poll (`GET /v1/state`) never decodes the base64url of up to 512 KB; only
   `GET /v1/guild/icon` does, once per download.

## What was left out

- **The Nod side** (Settings → App icon, the preference, `app.icon(pngPath)`, the file under
  `<app data dir>/guild-icon.png`, `nod.appIcon` / `nod.setAppIcon` / `host.setGuildIcon` /
  `host.clearGuildIcon`): I2b's slice. This side is the storage, the two routes and the signed digest.
- **The custom build's icon** (the bundle icon a build ships with): I1's slice; this slice does not
  touch `scripts/`, `package.json` or the release workflow.
- **`host/migrations.ts`**: untouched, on purpose (decision 1).
- **Any image validation beyond the signature**, any resize, any re-encode: not in the contract, and
  both would be a dependency.
- **`bun run typecheck` and the repo-wide `bun test`**: the coordinator's, not run.

## For other owners

- **Coordinator — the two `meta` keys** (decision 1): `docs/specs/SP01-*.md` §2 should list
  `guild_icon_sha256` and `guild_icon_bytes` next to `schema_version`/`guild_name`/`created_at`, or
  move the icon to a table with migration 2 — the latter also needs `health.test.ts:73` and
  `repo.test.ts:145` updated by their owner, which is why this slice did not choose it.
- **Coordinator — the body-limit arithmetic** (decision 2): one line in `host/app.ts` if a 512 KB PNG
  must be uploadable.
- **Coordinator — an authorizing issue**: this feature has none among #1–#38; the mandate's own rule
  ("it does not touch code without an `em-curso` issue") was met the way `h2`/`c1`/`h6` met it, with
  the coordinator's assignment. Worth an issue for the record.
- **I2b (Nod side)**: the names are as you coded against — `HOST_ROUTES.guildIcon`,
  `HOST_ROUTES.adminGuildIcon`, `GuildIconRequest`/`GuildIconResponse`, `isPng`,
  `Snapshot.guildIcon`. Practical ceiling ≈ 393 KB of PNG (decision 2), so your "choose a file"
  filter should refuse bigger ones before uploading rather than surfacing the 413. The
  `ETag` is `"<hex sha256>"` with the quotes, and the bytes must hash to the snapshot's value
  exactly.
- **R2App**: `clearOrgData` carrying the body's value is right; no further change needed for this
  slice.
- **R3TestsConfig**: nothing outstanding — the three literals are fixed and `test/` compiles.
- **I1 (packaging)**: `shared/host-merge.ts` landed, so `bun run app:build` should compile; nothing in
  this slice touches your files.

## Where the evidence lands

This file, per `docs/handovers/README.md` (one file per slice, written only by its owner: the files
touched, the acceptance and how it was met, the command and the observation, and what was left out).
The state of the work is not declared here; the coordinator's handover for the front carries it.
