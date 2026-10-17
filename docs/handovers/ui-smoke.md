# Real-page UI smoke — block 2's screens on the product page (issues #24, #25, #27–#35)

Slice: a new smoke that renders the real Nod page inside tinyjs and drives its own DOM. The
repository is `Bond` (branch `nod-0.3.5`). Rules read: `AGENTS.md`, `test/context.md`,
`src/context.md`. No gate beyond the smokes ran: no typecheck, no formatter, no full `bun test`.

## Files touched

| File | What changed |
| --- | --- |
| `test/smoke/ui.ts` (new) | The runner: refuses while `resources/seed.json` exists, moves it to `.gerado/seed.json.bak` with `--force` and restores it; starts the fake tools and one host process (`host/main.ts`, temp data dir, `NOD_GUILD_NAME=UI Smoke Guild`); issues the setup code; runs eight phases over four app ids (`copland.nod.ui-admin`, `...ui-person`, `...ui-person2`, `...ui-person3`). Each launch runs `gen-config`, writes the generated page under `.gerado/ui/`, points `frontend.devUrl` at it, spawns `tinyjs dev` without `TINYJS_HTML` and without `TINYJS_DEBUG`, and reads `ui_smoke_result` from the app's `store.json`. |
| `test/smoke/ui-driver.ts` (new) | The driver, loaded by the generated page after `src/app.ts`. Registers `phase → {setup, checks}` and drives the real DOM: clicks the sidebar and the Settings tabs, types in the dialog and the gate prompt, reads the cards, the sidebar order, the countdown and the notices. RPC (`src/api.ts`) is setup only; every acceptance reads the DOM. |
| `test/smoke/tools.ts` | The shared process plumbing both smokes had copies of: `appDataDir`, `generateDevConfig`, `killProcessTree`, `waitForStoredResult`, `startHostControl` (with an `extraEnv` for the O2 minimum) and `issueSetupCode`. `freePort`/`startTools` unchanged. |
| `test/smoke/connected.ts` | Uses the shared helpers instead of its own copies (`dataDir`, `runGenConfig`, `alive`, `killTree`, `waitForResult`, `hostControl`, `issueSetupCode`); its phase list and assertions are unchanged. |
| `test/smoke/run.ts` | Same: its `dataDir`, `runGenConfig`, `alive`, `killTree` and `waitForResult` gave way to the shared helpers. |
| `src/settings.ts` | Product fix (#29): `keyFingerprintCard` now shows the status of this machine's pair as a `chip.key-status` (`on this guild` / `not on this guild yet` / `unavailable`). Before it, the `MineKeys.status` the contract carries was visible only when it was `pending`. |
| `test/context.md` | New "Smoke, real page" row and the section describing it. |
| `docs/handovers/ui-smoke.md` | This file. |

## Acceptance criterion — how each item was met

`execucao`: the table below is the last `bun test/smoke/ui.ts --force` run (exit 0, 8 phases). Every
line is a DOM assertion made on the real screens; the RPC calls that create the world are marked
`setup`.

| Step | Where it came from | Result (verbatim) |
| --- | --- | --- |
| `#24` dialog | the real `#personal-tool-dialog`, typed and submitted | `ok     #24 add personal tool dialog (104 ms) the dialog added the tool` |
| `#24` order, favorite, warning | the real sidebar buttons and the Home card | `ok     #24 sidebar order and favorite (101 ms) sidebar order: favorite p-gd9prjqmpy first, org tools next; personal card warns` |
| `#25` leftovers | Settings → Hosts, the checked boxes and `Keep as personal tools` | `ok     #25 keep local tools (205 ms) 2 kept tools are personal and warn they are not from the org` |
| `#27` person devices | Settings → Account, the Devices card | `ok     #27 account devices (104 ms) 1 device row(s), each with Revoke` |
| `#29` fingerprint | Settings → Account, `Your key fingerprint` | `ok     #29 key fingerprint (3 ms) fingerprint FM9K-…-WXJE with status "on this guild"` |
| `#34` blocked/Role | Settings → Vault, the two credentials | `ok     #34 blocked and role send (635 ms) blocked credential has no Send; the Role dialog lists 2 recipients` |
| `#32` accept | Settings → Vault, the inbox row, the Accept button and the gate prompt | `ok     #32 accept the incoming share (507 ms) the share is accepted and the credential is in the vault` |
| `#33` reveal/copy | the Reveal/Copy buttons, the gate, the countdown | `ok     #33 reveal countdown and copy (8431 ms) revealed with a countdown, cleared at zero; Copy never rendered the value` |
| `#35` holders | the credential's holders list and the admin's `Credential holders` card | `ok     #35 holders list and admin card (104 ms) both people hold Tool A with date and scope; the admin card lists it` |
| `#30` changed key | Settings → Account, the Colleagues warning and Confirm | `ok     #30 changed colleague key (103 ms) the changed key is shown, Confirmed and the warning clears` |
| `#27` admin devices | Settings → People, one person's Devices | `ok     #27 admin sees the person devices (102 ms) 1 device row(s) with Revoke` |
| `#28` banner | Settings → Hosts, `Sync now` after the host restarted with `NOD_MIN_APP_VERSION=9.9.9` | `ok     #28 update-required banner (279 ms) banner: UI Smoke Guild needs a newer Nod (9.9.9 or newer). Update to reconnect — the guild stays disconnected until then.Check for updates; sidebar 4 → 2 tool(s), guild tool gone` |

`setup` steps (world, not acceptance): `admin-setup` (activate + bootstrap + roles + people + codes),
`person2-join` (Q), `other-accept` (Q accepts the share by RPC, so the holder rows #35 needs exist),
`person-second-machine` (P re-keyed through a new access code).

## Exact commands and observed result

```
bun test/smoke/ui.ts --force          # exit 0, 8 phases, 32.27 s
bun test/smoke/connected.ts --force   # exit 0
bun test/smoke/run.ts --force         # exit 0
```

`connected.ts` (unchanged behaviour, now on the shared helpers) closed with:

```
connected smoke ok: 14 phases, 111 steps, admin-publish:26 person-join:20 person2-join:6 admin-clear:2 person-cleared:3 admin-share:11 person-share:9 person2-accept:7 admin-update:5 person-update:4 admin-rotate:4 admin-second-machine:3 admin-revoke:7 person-signed-out:4
private seed restored
tinyjs.json regenerated in dev
```

`run.ts` (same) closed with:

```
export: ok 14 event(s), no secret
kdf vectors: ok 3 vectors matched in 430 ms (/Users/caio/.tinyjs/bin/tjs)
seal vectors: ok 2 vectors matched, 6 tampered refused in 16 ms (/Users/caio/.tinyjs/bin/tjs)
smoke ok: 14 steps
private seed restored
tinyjs.json regenerated in dev
```

The last UI run's closing lines:

```
phase admin-final (app id copland.nod.ui-admin)
ok     #35 holders list and admin card (104 ms) both people hold Tool A with date and scope; the admin card lists it
ok     #30 changed colleague key (103 ms) the changed key is shown, Confirmed and the warning clears
ok     #27 admin sees the person devices (102 ms) 1 device row(s) with Revoke
ok     #28 update-required banner (279 ms) banner: UI Smoke Guild needs a newer Nod (9.9.9 or newer). Update to reconnect — the guild stays disconnected until then.Check for updates; sidebar 4 → 2 tool(s), guild tool gone

ui smoke: ok (8 phase(s))

Wall time: 32.27 seconds
```

Limitations declared: the runner was exercised on macOS only (arm64, tinyjs 0.57.2). `resources/seed.json`
is restored on every exit path (`finally`, plus SIGINT/SIGTERM). No secret, code, password or
credential value is printed, written to a file, or put in `store.json`: the codes travel through the
desk in memory, and the runner removes every app data dir and the temp host data at the end.

## Findings

1. **`src/settings.ts` `keyFingerprintCard` did not show `MineKeys.status` when it was `ok`.** The
   card showed the fingerprint and, only for `pending`, the sentence; the story check #29 asks for the
   value *and* a status. Fixed by appending the `chip.key-status`. Small and additive; no contract
   change.
