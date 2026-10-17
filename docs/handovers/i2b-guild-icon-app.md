# Slice I2b — Nod side of the guild icon and the app-icon choice

Owner: the implementation track's **Nod/app** slice of the guild icon (the host side is I2h's,
packaging I1's). Authorized by the coordinator's assignment in this session, on the same footing
`docs/handovers/h2.md`, `c1.md` and `i2h-guild-icon-host.md` recorded: this repository has no
`em-curso` label, and there is **no guild-icon issue** among #1–#38. The request is the owner's of
2026-10-16 ("builds customizadas com ícones diferentes … trocar o ícone por um custom por guild e
escolher"). **Finding for the coordinator**: if this work needs a permanent record, it needs an
issue; nothing here can create one.

Contracts followed: `docs/specs/SP05-nod-connected.md` §2 (the `host` row's snapshot is the verified
body), §3 (`ApiContract`), §4 (screens), §6 (the section this slice added); `docs/specs/SP04-sync.md`
§2 (`Snapshot.guildIcon` is inside the signed bytes, and the client fetches the bytes back and keeps
them only when they hash to it), §3 (the triggers a snapshot is applied on), §6 (its acceptance
line); `docs/specs/SP03-host-api.md` §1 (the body-limit exception, the `{ error }` shape) and §2
(`GET /v1/guild/icon`, `PUT`/`DELETE /v1/admin/guild/icon`); `docs/specs/SP02-auth-and-keys.md` §5
(the bearer lives in the keychain and is read per call); `docs/specs/README.md` (base64url without
padding, lowercase hex for digests); `docs/tinyjs.md` §6 (capabilities list only the exceptions) and
`.agents/skills/tinyjs/references/api.md` "App surface" (and `~/.tinyjs/runtime/bridge.js`
`systemCapabilities`, which names the key `icon`). Rules: `AGENTS.md`, `backend/context.md`,
`src/context.md`, `shared/context.md`, `test/context.md`.

**No project gate was run**: not `bun run typecheck`, not the repo-wide `bun test`, not the smoke,
not a formatter. What ran is this slice's own test file and the one test file it extends, both named
below under "Acceptance criterion".

## Files touched

| File | What changed |
| --- | --- |
| `backend/guild-icon.ts` | **New.** `createGuildIcon(deps)` → `{ sync(hash), state(), setChoice(choice), reset() }` over `<data>/guild-icon.png` and the `appIcon` preference. `sync` fetches `HOST_ROUTES.guildIcon` only when the signed hash differs from the file's, writes the bytes only when their SHA-256 is exactly that hash, deletes the file on `null` and never requests anything without a connection (RF-30). `apply()` is the one caller of `app.icon` (`path` for the guild's icon, `''` for the bundle's) and is a no-op when nothing moved; `capabilities().icon === false` (Linux on Wayland) skips the call and keeps the file. The connection, `app.icon`, the file calls and `store` are injected, so the module imports no `tjs`, no `tiny` and no `bun:*`. |
| `backend/host-client.ts` | `HostConnection.getBytes(path)`: one `GET` whose answer is bytes rather than JSON, through the same `send` as every other call (the keychain bearer, the deadline, `redirect: 'error'`) with `accept: image/png`, returning the body through the existing `readBody`. Nothing else moved. |
| `backend/main.ts` | `createGuildIcon` wired in `init` (`<paths.data>/guild-icon.png`, `connectionOf()`, `app.icon`, `supported(capabilities, 'icon')`, `tjs`'s three file calls, `app.store`); `syncGuildIcon()` after every state the sync publishes and once in `afterUnlock` (the cached snapshot's icon, before the loop's first run); `host.remove` awaits `reset()`; the four RPC methods `host.setGuildIcon` / `host.clearGuildIcon` (both in `ADMIN_ONLY`, both connected-only, through `connection.request`) and `nod.appIcon` / `nod.setAppIcon`; the helpers `snapshotIconHash()`, `guildIconBody()` (`fromBase64url` + `isPng` + the encoded limit), `appIconChoice()` and `removeFile()`. |
| `shared/types.ts` | `AppIconChoice` (`'default' | 'guild'`) and `AppIconState` (`{ choice, guildIconAvailable }`), and the four `ApiContract` entries of §3, each with the sentence of SP05 §6 it answers. Nothing else moved. |
| `src/settings.ts` | Settings → Account gains the **App icon** card (Default / Guild icon, the Guild option `disabled` with a hint while the guild has none, the select showing the pack's icon when a stored `guild` choice has no icon); Settings → Hosts gains the admin's **Guild icon** card (file picker `accept="image/png"`, preview of the picked PNG, Upload, Remove); the handlers `setAppIcon`, `chooseGuildIcon`, `uploadGuildIcon`, `clearGuildIcon`; `load()` reads `nod.appIcon` for the Account tab and for the admin on Hosts; `select()` gained an optional `disabled` per option; `fileToBase64(file)` became `bytesToBase64(bytes)`, so the guild icon is encoded once for the upload (base64url) and for the preview (a data URI). |
| `src/style.css` | One rule: `.guild-icon-preview` (48 px, `object-fit: contain`), the picked PNG next to its file input. |
| `test/guild-icon.test.ts` | **New.** 13 tests over a fake connection, a fake file system, a fake `app.icon` and a fake `store` — the injection `GuildIconDeps` exists for. |
| `test/host-client.test.ts` | The loopback host answers `HOST_ROUTES.guildIcon` (200 with the bytes, 404 when it has none), `TestCall` records `accept`, and two tests cover `getBytes` (bytes verbatim with the bearer and the image accept; a 404 is the `refused` failure with the host's body unread). |
| `docs/specs/SP05-nod-connected.md` | §1's module table names `backend/guild-icon.ts` and the two new dependencies; §3's table gains the four methods; §4 names the two cards; **§6 is new** — the file, the verification, the preference, the capability gate, the screens, and the encoded-vs-decoded size finding. |
| `docs/handovers/i2b-guild-icon-app.md` | This file. |

**Not edited on purpose**: `backend/tjs.d.ts` (finding 1), `backend/context.md` / `src/context.md` /
`test/context.md` (finding 5), `shared/host-api.ts` (I2h's; its `guildIcon`, `adminGuildIcon`,
`Snapshot.guildIcon`, `GuildIconRequest`/`GuildIconResponse`, `isPng` are exactly the names this
slice codes against — confirmed by message with I2hGuildIconHost, no renaming), `shared/host-merge.ts`
(R2App's; `clearOrgData` now carries `guildIcon` instead of dropping it — finding 6),
`test/smoke/connected.ts` (finding 4).

## Acceptance criterion — how each item was met

`bun test test/guild-icon.test.ts` → `13 pass, 0 fail, 53 expect() calls` (`execucao`).
`bun test test/host-client.test.ts` → `27 pass, 0 fail, 73 expect() calls` (`execucao`).

| Item | Proof |
| --- | --- |
| The icon is fetched only when the hash changes | *"fetches the bytes of a hash it does not hold, and only that hash"*: one request for the first hash, `requests.length` still 1 after the same hash again, 2 after a moved one. *"keeps the icon it already holds across a restart without a request"*: file on disk + a snapshot naming it → `requests === []`. |
| Bytes whose SHA-256 differs from the snapshot are refused and nothing written | *"refuses bytes that do not hash to the signed value, and writes nothing"* (no file, no `app.icon`) and *"a refusal leaves the last verified file in place and the icon on the bundle one"* (the earlier file is untouched; the app icon goes back to `''`). |
| `guildIcon: null` deletes the file and resets when the choice is guild | *"null deletes the file and puts the bundle icon back"*: `file() === null`, `icons === [path, '']`. *"a null with nothing on disk is not a second reset"*: no `app.icon` call at all. |
| Choosing `guild` calls `app.icon(path)`, `default` calls `app.icon('')` | *"choosing 'guild' applies the png path, 'default' applies the bundle icon"*: `icons === [path]` then `[path, '']`, the preference written each time; *"choosing 'guild' is refused while no verified icon is on disk"*. |
| Host remove resets | *"a host removed resets the file and the icon, and keeps the preference"*: `reset()` → file gone, `icons === [path, '']`, `stored() === 'guild'`. |
| No host → no request | *"no host row: no request at all, whatever the snapshot names"*: `connected: false` → `requests === []`, no file, no icon. |

Two more tests cover the edges the same code owns: an unreachable host writes nothing and the next
sync fetches (*"an unreachable host writes nothing and the next sync tries again"*), and a machine
whose `capabilities().icon` is false is never asked for an icon (*"a machine whose system refuses an
app icon is never asked for one"* — the file is still kept). The last block asserts the preference
key and that anything but `guild` reads as `default`, with nothing written to `store`.

**Limitations of the proof (`leitura` for everything below):** the module's behavior is proven by
injection, and the *wiring* in `backend/main.ts` is not: no test drives `init`, `syncGuildIcon` or
the four RPC methods against the real runtime. The two test files were run under `bun test`; nothing
was run under txiki.js.

## How to observe it in the running app (`leitura` — I ran no app)

1. `bun scripts/gen-config.ts dev && tinyjs dev` (the owner's usual dev run), and sign in as the admin
   of a connected guild.
2. **Settings → Hosts → Guild icon**: pick a PNG (≤ 384 KiB) — the preview appears immediately, from
   the file, with **Upload** enabled. Upload: the status line reads `Guild icon stored (<12 hex>…)`,
   and `<data dir>/guild-icon.png` appears. On macOS that directory is
   `~/Library/Application Support/copland.nod/` (the same one holding `nod.db` and `store.json`).
3. **Settings → Account → App icon**: the select now offers **Guild icon**; choosing it makes the
   Dock tile (macOS), the taskbar button (Windows) or the window icon (Linux/X11) the PNG. Choosing
   **Default** puts the bundle icon back. On a Linux Wayland session the machine has nowhere to put
   an app icon (`capabilities().icon === false`, `docs/tinyjs.md` §6): the choice is stored and
   nothing visible changes — see finding 3.
4. A second Nod (another `NOD_APP_ID`, as the smoke does) on the same host: after its next sync
   (Settings → Hosts → Sync now) its **Account → App icon** offers Guild icon, and choosing it shows
   the same PNG — the bytes were fetched back and checked against the digest the signed snapshot
   carried.
5. **Remove**: Settings → Hosts → Guild icon → Remove. Every member's next sync deletes their
   `guild-icon.png` and returns to the bundle icon (`guildIcon: null` in the signed body), and the
   Guild option is disabled with the "no icon yet" hint again.
6. `store.json` in the data dir holds `appIcon: 'guild'` (or `'default'`) — a word, never a secret.
   Signing out (`401`) does not touch the file: `clearOrgData` carries `guildIcon` (finding 6).

## What could not be done, and why

1. **`tjs.remove` has no declaration.** `backend/tjs.d.ts` is described as the minimal typing file
   for the globals this backend uses and does not declare `remove`, which txiki.js has (its own
   bridge deletes its temporary files with it — `~/.tinyjs/runtime/bridge.js:154`, `:1410`). The
   file is not in this slice's list, so `backend/main.ts` carries one named cast (`removeFile`) with
   the finding; **for the coordinator**: add `remove(path: string, options?: { recursive?: boolean }):
   Promise<void>` to that file and the cast goes away. Nothing else in the slice needs it. The cast
   claims only the shape of a runtime function, and it is read late (inside `removeFile`), so no
   global is touched at module load.
2. **The 512 KB body limit has no shared home.** SP03 §2's ceiling applies to the *body*, which is
   the base64url of the bytes, so the usable PNG is at most 384 KiB (393 216 bytes); the page
   (`src/settings.ts`) and the backend (`backend/main.ts`) each keep that literal with a comment,
   because the constant's home would be `shared/host-api.ts` — I2h's file, and I2h answered that the
   limit stays in `host/app.ts` beside `bodyLimitFor` (SP03 §1 is its spec home) so a shared constant
   is a contract decision for the coordinator. **For the coordinator**: if `shared/host-api.ts` gains
   `GUILD_ICON_MAX_BODY_BYTES`, the two literals become one import.
3. **Nothing tells the person that their system cannot show an app icon.** SP05 §6 fixes
   `nod.appIcon` as `{ choice, guildIconAvailable }`, so there is no field to say "this machine has
   nowhere to put it": on Linux Wayland the choice is stored, `nod.setAppIcon` answers `ok`, and
   nothing visible happens. A third field (or an `AppInfo` flag) is a contract change for the
   coordinator, not this slice's decision.
4. **No smoke and no gate ran.** The connected smoke (`test/smoke/connected.ts`) drives two Nods
   against a real host and is the natural place to observe the icon end to end (upload on the admin,
   the PNG on the person's disk, the Dock tile); it is not in this slice's file list and was not
   touched. The wiring — `init`'s `createGuildIcon`, `syncGuildIcon` in `onState`/`afterUnlock`,
   `host.remove`'s `reset`, the four RPC methods — has no automated proof; it is `leitura` of
   `backend/main.ts`, and the steps above are how to see it.
5. **The context tables still describe a Nod without a guild icon.** `backend/context.md`'s module
   table does not name `backend/guild-icon.ts` and `src/context.md`'s screens table does not name the
   two cards; both files are outside this slice's list, so the finding is written here instead of
   there. **For the coordinator**: the rows are one line each, and SP05 §6 is the paragraph they
   point at.
6. **One cross-slice fact that matters here.** A `401` rewrites the cached body through
   `shared/host-merge.ts`'s `clearOrgData`; R2App made it carry `guildIcon` instead of dropping it,
   which is what keeps a signed-out Nod holding the guild's icon instead of deleting it. If that line
   ever changes to `null`, `snapshotIconHash()` reads `null` and this slice deletes the file and
   resets the icon of a guild that still has one — worth a test in the file that owns it.

## What another owner must do

- **Coordinator**: the `em-curso` issue (see the top of this file); the `tjs.remove` declaration
  (finding 1); the shared size constant (finding 2); the decision about a machine that cannot show an
  app icon (finding 3); the two `context.md` rows (finding 5).
- **I2h (host)**: nothing outstanding — the names in `shared/host-api.ts` are the ones this slice
  uses, and `PUT`/`DELETE /v1/admin/guild/icon` behave as SP03 §2 writes them.
- **R2App (`shared/host-merge.ts`)**: keep carrying `guildIcon` in `clearOrgData` (finding 6).
- **I1 (packaging)**: nothing — the build's icon is a separate question (`docs/handovers/i1-build-icon.md`);
  this slice only changes the icon at runtime, through `app.icon`.
