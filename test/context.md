# test/ — proof

**All of it at once:** `bun run validate` runs typecheck (every tsconfig), the unit tests of `test/`
and `host/`, and the page build, then prints one summary and exits non-zero on any failure;
`bun run validate --smoke` adds the four real-surface smokes below on Electrobun (skipped, with a
line saying so, when `.hutch/devkit` is missing). The smokes open real windows for
a few minutes and each moves `resources/seed.json` aside and restores it (`scripts/validate.ts`).

Two kinds of proof, matching `AGENTS.md`'s rule that nothing is "verified" without execution:

| Kind | Where | Runs | Proves |
| --- | --- | --- | --- |
| Unit | `test/*.test.ts`, `host/**/*.test.ts` (block 1 on) | `bun test` | Pure logic in `shared/` and the host against a real temp SQLite |
| Smoke, local | `test/smoke/` (`run.ts`, `smoke.html`, `tools.ts`) | `bun test/smoke/run.ts` | The real Nod app under Electrobun, with local fake tools, a throwaway app id (`NOD_APP_ID`), a free dev port and a page file named after the launch's nonce, and its own data dir |
| Smoke, connected | `test/smoke/` (`connected.ts`, `connected.html`, `tools.ts`) | `bun test/smoke/connected.ts [--force]` | The real Nod under four app ids beside a real host process: SP05 §5 steps 2–5 and block 2's sharing (SP06 §4–§6, B7, K1–K9), no external network, no container |
| Smoke, real page | `test/smoke/` (`ui.ts`, `ui-driver.ts`, `tools.ts`) | `bun test/smoke/ui.ts [--force]` | The real `index.html` entry (`src/app.ts` + `src/settings.ts`) inside Electrobun, driven through its own DOM: block 2's screens (#24, #25, #27–#35), beside a real host process, no external network, no container. The runner points `NOD_MAIN_URL` at the dev server's copy of itself (`test/smoke/.gerado/ui/`), so the window is the real `http://` page with the runtime bridge — not a re-written test page |
| Smoke, docked tabs | `test/smoke/` (`tabs.ts`, `tabs-driver.ts`, `tools.ts`, `winlist.swift`) | `bun test/smoke/tabs.ts [--force]` | E03 on the real surface (RF-49…RF-52, RF-66…RF-68, T6): a local account, two org tools and real tool windows per tab, with three reporting tool pages (`startTabTools`) that measure themselves. No host process. The real frame of every window comes from `CGWindowListCopyWindowInfo` (`winlist.swift`), because a webview reports `window.screenX/screenY` as `0,1490` and `window.outerWidth/outerHeight` as `0x0`, and a tool page cannot call `tiny.win.getState()` (api-gated). A step whose subject needs the panel's slot is reported **blocked** — never passed — when the page is hidden (a locked screen), which `src/tabs.ts` answers with an empty slot by design |

Every smoke runner launches Electrobun (`test/smoke/tools.ts`). `--runtime=tinyjs` fails loudly:
the runtime was removed in 0.8.0. `docs/handovers/e06-parity-smoke.md` and `e06-parity-matrix.md`
carry the historical parity rounds.

`test/helpers/sqlite-bun.ts` adapts `bun:sqlite` to the backend's `SqlDb`, so `backend/repo.ts` runs
under Bun.

## Rules

- **Behavior, not wording.** Tests assert outcomes, boundaries and errors, not message text or
  source shape.
- **Smoke never uses real credentials**, and never runs with a runtime trace and a real account
  (`AGENTS.md`).
- **The smoke refuses to run when `resources/seed.json` exists**, unless given `--force` (it writes
  its own seed).

## Added by blocks 1–2

| Proof | Story |
| --- | --- |
| Key-derivation vectors in Bun, and the same vectors in txiki.js through the smoke | H3 |
| Seal/open vectors across both runtimes | S0 |
| Person fingerprint vectors, the pin decision, the sealed key pairs and the pin table against in-memory SQLite (`test/keys.test.ts`) | K1–K2 |
| The scope decision, the sealed payload and every `invalid share` path, plus a send/accept/decline end to end against the real host app (`test/shares.test.ts`) | K4, K6, K7 |
| The admin's assignment to a role and to one person, the missing-copy list and its seal behind the gate, end to end against the real host app (`test/assign.test.ts`) | K8 |
| The owner's update fan-out to the holders, the revoked holder staying `rotation pending` until a new secret is saved, and the no-gate apply of an incoming update (`test/rotation.test.ts`) | K9 |
| The gate's factor (SP02 §9): a password the call carries wins over the machine's biometrics (`test/gate.test.ts`) | K5 |
| Host route groups against a temp data dir | H4–H8 |
| Two-instance smoke: a host process plus two Nod app ids (admin and person) | B11 |
| The same smoke over four app ids: the personal half across machines, send/accept/assign/update/revoke and the no-plaintext dump of `host.db` | K10 |

## The connected smoke (`test/smoke/connected.ts`)

`bun test/smoke/connected.ts` refuses while `resources/seed.json` exists, exactly like the local
smoke; `--force` moves it to `test/smoke/.gerado/seed.json.bak` and restores it at the end.

What it starts, all on loopback, with no external network and no container:

| Piece | How |
| --- | --- |
| Host | `bun host/main.ts` on a free loopback port: `NOD_DATA` in `test/smoke/.gerado/connected/host-data`, `NOD_DEV=1`, `NOD_PUBLIC_URL=http://127.0.0.1:<port>`, `NOD_GUILD_NAME=Smoke Guild` (SP04 §1 allows plain `http://` only in dev) |
| Setup code | `bun host/cli/setup-code.ts` over the same environment; it stays in the runner's memory (never printed, never written to a file) |
| Tools | `test/smoke/tools.ts` (A, B and C), the same fake servers the local smoke uses; Tool C's origin is the personal tool's address (it is not in any seed) |
| Nods | four app ids — `copland.nod.smoke-admin`, `...smoke-person`, `...smoke-person2` and `...smoke-admin2` — launched one at a time the way `run.ts` launches one: temporary seed, `gen-electrobun-config` with that app id, **a free dev port of its own per launch**, a page file named after the launch's nonce loaded through `NOD_MAIN_URL`, and the result channel through `<app data>/store.json` |

The page drives SP05 §5 and block 2's sharing in fourteen phases, in this order — the two icon
phases need P's syncs, the sharing needs both members before `people.revoke`, and the revocation of
P is last because a revoked person cannot push later:

| Phase | Spec | What it drives |
| --- | --- | --- |
| `admin-publish` | SP05 §5.2, §6, B7, K1 | the setup code, `host.bootstrap`, role `team`, a guild invite for each member (`guildInvites.create`), both grants, the admin joining `team` (a `role` share needs a role in common), a personal tool and its favorite, the guild PNG |
| `person-join` | SP05 §5.3, §5.5, §6, B7, K1 | P activates, the granted tool appears, no personal half of another person arrives, the vault fills on its origin; host stopped and started again; the guild icon shows |
| `person2-join` | SP05 §5.3 | Q, the second member of `team`, activates the same way |
| `admin-clear` | SP05 §6 | the admin removes the guild icon |
| `person-cleared` | SP05 §6 | P's next sync deletes the file and drops the option |
| `admin-share` | K2, K4, K6, K8 | both members pinned with the fingerprints they reported, the personal tool and the favorite read out of the snapshot, one credential scoped `role` and sent to both, a second one assigned to `team` |
| `person-share` | K4, K5, K7 | the inbox holds the send and the assign; the send is accepted behind the gate, `vault.reveal`/`vault.copy` pass it, the holders list both people |
| `person2-accept` | K4, K8 | Q accepts the same two shares and reveals the same value |
| `admin-update` | K8, K9 | three holders per credential; the owner saves a new secret, which fans an update out; the missing list is empty |
| `person-update` | K9 | the sync applies the update with no gate, the vault moves, the host purged the share |
| `admin-rotate` | K9/RF-48 | `shares.removeHolder` on P → `rotationPending`, then the save that reaches Q and clears it |
| `admin-second-machine` | SP05 §5.3, B7, K1 | the same person's second machine signs in, ends with the pair of the first one (canonico §22) and finds the personal tool and its favorite in the snapshot |
| `admin-revoke` | SP05 §5.4 | `people.revoke` on P |
| `person-signed-out` | SP05 §5.4 | P's next sync is `signed-out` and the org tools are gone |

No code goes through a file: the pages fetch the setup code and each member's invite code from a
loopback endpoint the runner serves ("the desk"), and the admin page hands the codes back the same
way. The desk is also what stops and starts the host process, and what carries one machine's own key
fingerprint (a public digest) to another. Every gated call carries the password: on a machine with
biometrics the backend would otherwise open the operating system's prompt (SP02 §9's fallback).

The runner reads the host's own SQLite afterwards — people, roles, org entries, grants, the personal
entries and favorites, the shares and holders, the assignments, and P's events — and asks **every
text column of every table** for the username and the secrets the run wrote (SP06 §6/RF-44): it
prints the counts of tables, columns and hits, and never a value. It also reads P's `nod.db` (the
accepted item's origin, credential and scope) and the second machine's (which must hold no local
`tool` row for the personal tool). Nothing printed is ever a code, a token, a password, a secret or
a sealed blob — step names, statuses, counts and public digests only.

## The real-page UI smoke (`test/smoke/ui.ts`)

The two smokes above drive the API from a purpose-written page. This one renders the product: the
generated page imports `/src/app.ts` exactly as `index.html` does and then `test/smoke/ui-driver.ts`;
the runner points `NOD_MAIN_URL` at that file, so the Electrobun main window loads the real `http://` page (the
real entry, the real stylesheet, the injected `tiny` bridge) instead of a test page. The driver sets
the world up over `src/api.ts` and then asserts what the screens show, clicking and typing on the
real DOM of `src/app.ts` and `src/settings.ts`.

`ui.ts` refuses while `resources/seed.json` exists and moves it to `test/smoke/.gerado/seed.json.bak`
with `--force`, like the others. One host process and four app ids: the admin (three launches), the
person P (two), a third person who joins through the entry screen's invite link (#37), and a fresh
machine that imports a seed at first run (#38). The second member Q and P's second machine have no
screen under test, so they are
headless (`test/smoke/headless.ts`): Bun calls to the host with the shared routes, key derivation and
key generation. Q joins with the admin's invite beside P's launch and accepts the share beside P's
inbox launch, and P's re-key by a reissued access code runs alone before the admin's last launch. The
desk carries the setup code and each code the admin hands over; the O2 step restarts the host with
`NOD_MIN_APP_VERSION` above the app version. No password, code or credential value ever reaches a
file, a log or `store.json`.

| Step | Story | What the DOM shows |
| --- | --- | --- |
| `#24` add personal tool, sidebar order, favorite, warning | B7/SP05 §3–§4 | the dialog creates the tool, the sidebar lists it after the org tools and first once favorited, and its card carries the canonico §22 warning |
| `#25` keep local tools | B8b/RF-40 | the Hosts tab lists the join's leftovers, all checked; `Keep as personal tools` turns them into personal tools, which Home shows with the warning |
| `#27` devices | O1 | Account lists this machine's devices with Revoke; the admin's People tab opens one person's devices |
| `#28` update-required banner | O2/SP04 §1 | after the host raises its minimum, `Sync now` shows the persistent notice naming the version and saying the guild is disconnected, the guild's own tool leaves the sidebar (the local catalog takes over, the snapshot's personal tool with it), and Settings → Hosts keeps the guild's card with the reason |
| `#29` key fingerprint | K1 | Account shows `XXXX-XXXX-XXXX-XXXX` and the status of this machine's pair |
| `#30` changed colleague key | K2/RF-45 | a second machine re-keys P; the Colleagues list shows `key changed — confirm`, and Confirm clears it |
| `#32`/`#33` inbox, reveal, copy | K4/K5 | Accept moves the share into the vault behind the dev-run password prompt; Reveal shows the value with its countdown and the DOM is clean at zero; Copy never renders it |
| `#34` blocked and role send | K6/SP06 §5 | a Blocked credential has no Send; a Role one opens the dialog listing the recipients |
| `#35` holders | K7/RF-54 | both accepting people appear in the credential's holders with date and scope, and in the admin's Credential holders card |

The driver's only RPC use is setup (account, host join, publish, people and codes, credentials,
scope, send, Q's accept, the second machine, P's new code); every acceptance above reads the DOM.
`docs/handovers/ui-smoke.md` carries the last run's step lines.

## The docked-tabs smoke (`test/smoke/tabs.ts`)

E03's own surface, and the smallest of the three: no host process, no headless work, one launch.
`bun test/smoke/tabs.ts` refuses while `resources/seed.json` exists and moves it to
`test/smoke/.gerado/seed.json.bak` with `--force`, like the others. The generated page imports
`/src/app.ts` and then `test/smoke/tabs-driver.ts`; the account is local (`session.createAccount`
with no code, RF-60) and the temporary seed names two org tools on two reporting servers
(`startTabTools`, `test/smoke/tools.ts`).

What makes the geometry checkable at all, all measured on this machine:

| Fact | What it means for the smoke |
| --- | --- |
| `window.screenX/screenY` are `0,1490` and `window.outerWidth/outerHeight` are `0x0` in a WKWebView (`backend/tiny.d.ts`, `TinyWinState.outer`) | a page cannot report where its own window is |
| a tool page's `tiny.win.getState()` is refused — `"win.getState" is not allowed from this window` (the runtime gate gives a tool view only `login.report`) | the reported page box (`innerWidth/innerHeight`), `performance.timeOrigin` and its draft are what a tool page brings |
| `CGWindowListCopyWindowInfo` (`test/smoke/winlist.swift`) gives the real frame of every window | the on-screen truth, and the runner hands it to the driver over the desk |
| that list is in the window server's units, not the app's points (a 1100 pt window is `990` of them, with an offset) | the map is read at every measurement from the main window itself — its real frame against its own `getState()` — and applied to the tool window |
| a hidden page reports no slot (`src/tabs.ts` `currentRect`), and a **locked screen** hides every window | the placement steps say **blocked** with their numbers instead of pretending |

| Step | Story | Surface |
| --- | --- | --- |
| RF-52 default mode | RF-52 | `tools.state()`: `mode=docked` (the mode is machine-derived: docked wherever the runtime can position windows), no strip with no tab |
| RF-49 the docked tab lands on the slot | RF-49 | the slot's screen rect (`getState()` of main + the slot's `getBoundingClientRect()`) against the tool window's real frame |
| RF-49 it follows a resize | RF-49 | `tiny.win.setSize` on the main window; the tab's frame lands on the new slot within 1 s |
| RF-50 a second tab, RF-50 switching | RF-50 | the strip's `+`, three strip clicks, the page's `timeOrigin` and draft kept, one load |
| RF-51 detach, RF-51 dock back | RF-51 | the OS frame that comes back and leaves; the same window both ways |
| RF-66 a popup, RF-66 Open link… | RF-66 | a link a tool opens lands right after its tab; the dialog's own field and Enter |
| RF-68 no API for an ad-hoc tab | RF-68 | the same `login.report` on a tool tab (`ok`) and on two ad-hoc tabs (refused) |
| RF-67 a view, RF-67 a tool | RF-67 | `catalog.list` gains a view of Tool B and a personal tool with its probed title |
| T6 | T6 | lock from the sidebar, enter through the Offline tile: the tabs reopen in order, ad-hoc ones do not |
| 0.6.0b Open tabs from Home | 0.6.0b | Home's `Open tabs` button: its badge is the open count, it shows the strip, and it is disabled with no tab |

Not in the list, removed with the product (owner decision §22 "Seamless tabs: always inside, detach on
demand"): the RF-52 **Windows mode** switch (no `tabs.setMode`, no Account card — the mode is derived
`docked` on macOS because the runtime can position windows), **RF-19** (its "second `tools.open`
focuses, never reloads" was driven from that Windows mode, so it has no subject here), the six RF-69
**embedded (iframe) tab** steps, the 0.6.0b embedded **Sign in copy** step and the two 0.6.0c
login-cookie steps. The fake tools D (XFO) and E (strict cookie) went with them; `startTabTools`
serves A, B and C only.

On Electrobun a docked tab is a **native view inside the main window**, not an OS window: the slot
steps prove it with the tool page's own `innerWidth/innerHeight` equal to the slot box **and** the
on-screen window list showing no extra tool window; only a detached tab has a carrier window, which
the detach step requires to appear (framed) and the dock-back step requires to disappear. The tiling
WM can therefore only hold the main and carrier windows, so only a tiled tool/carrier window blocks a
placement step (a tiled main window does not: the view still fills the slot).

A run prints its steps as they land, each `ok`, `FAILED` or `blocked`; `blocked` is for a step whose
subject the session made unobservable (a locked screen hides the page, and `src/tabs.ts` then reports
no slot by design; a tiling WM that owns the run's window is the same answer with its numbers) — it is
never counted as a pass, and the runner keeps going. The list is **16 steps** after the seamless-tabs
change; the last full run before it was 27 steps (`docs/handovers/e03-smoke.md` carries those step
lines and numbers). With OmniWM active and the smoke floating its own windows, RF-49's landing and
resize-follow and RF-50's second slot are measured against `CGWindowList` frames; when the tiler holds
a window instead, those steps (and the RF-66 placement) are `blocked` with the tile frames and the
slot box.
