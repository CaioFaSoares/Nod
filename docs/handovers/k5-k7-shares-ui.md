# Slice K4–K7 (page side) — vault inbox, gate with countdown, scope, holders

Authorizing issues: **#32** (K4, send/accept/decline and the vault inbox), **#33** (K5, gate on
reveal/copy/accept/send and the reveal countdown), **#34** (K6, scope role/blocked/org), **#35** (K7,
holders list) — page side only; the copies read are `/tmp/nod/issue-32.md` … `/tmp/nod/issue-35.md`.
Epic #3 (E02 — credential sharing), Block 2 ("Mine and shared"). Requirements: RF-44, RF-46, RF-53,
RF-54, RF-55 out of scope.

Contracts followed: the phase contract fixed between the two agents of this phase (the block-2
`shared/types.ts` additions and the RPC signatures, agreed with SharesCore in writing);
`docs/specs/SP06-credential-sharing.md` §4 (the flows, the gate, the update that needs none, the
holders and rotation rows), §5 (the three scopes and what the host accepts); `SP02-auth-and-keys.md`
§9 (the gate, `app.authenticate`, the password where biometrics are missing); `SP04-sync.md` §2 (the
snapshot's holders and `incomingShares`); `canonico.md` §11 (the ten-second reveal), RNF-07 (keyboard
first), RNF-08 (English everywhere); `docs/arquitetura.md` §5 (the page talks to the backend only);
`AGENTS.md`, `src/context.md`, `shared/context.md`, `backend/context.md`.

Nothing secret reaches the page: the only secret it ever holds is a revealed value, on screen for
the ten seconds of its countdown. `vault.copy` answers `true`, so a copy never enters the DOM, a
variable, a log or the store. No `innerHTML` was used: every string goes in as a text node through
`src/ui.ts`'s `el()`.

## Files touched

| File | What changed |
| --- | --- |
| `src/settings.ts` | The Vault tab rebuilt around the sharing of block 2. **State**: `gate` (`GateWait` — the action waiting for the password), `inbox`, `sendFor`, `recipients`, `sendTo`, and `revealed` gained `left` (the countdown's seconds). **Gate (K5)**: `gate(wait, run)` — with `session.biometric` the call goes straight through and the backend asks for the biometrics itself; without it the card shows `gatePrompt()` (a password field, Confirm, Cancel, Enter submits), the password travels in the params and the field is emptied the moment it is read; Cancel and a failed gate leave the action undone and show one English line. **Reveal (K5)**: `showRevealed()`/`hideRevealed()`/`reveal()` — the secret sits beside a `role="timer"` counter that goes 10 → 0; each second rewrites only that counter's text (a full render would drop the focus of a half-typed field), and at zero the state, the countdown handle and — with the render — the DOM node all go. The tab change, a lock, a removal and `destroy()` clear it immediately. `REVEAL_MS` became `REVEAL_SECONDS = 10`. **Copy (K5)**: `copySecret()` calls `vault.copy` and keeps nothing. **Scope (K6)**: `scopeRow()` — the select Role/Org/Blocked with `SCOPE_HINT` under it, drawn only for the credential's owner (`isOwner`); any other holder sees the scope and "set by the owner" as text; `setScope()` writes through `vault.setScope`. **Send (K4/K6)**: `openSend()`/`sendCredential()`/`closeSend()` and `sendDialog()` — `shares.recipients` listed with name, fingerprint, the `key changed — confirm in Account` warning, a disabled checkbox and the `reason` when `allowed` is false, and the Send button sending the ticked ids; the button is absent, not disabled, when the scope is `blocked`. **Holders (K7)**: `holdersCard()` — one row per holder with name, `owner` chip, `Scope · since <date>` and a `revoked` chip for a row with `removedAt`. **Rotation (K9)**: the `rotation pending` chip on a credential whose item says so. **Inbox (K4)**: `inboxCard()`/`inboxRow()`/`acceptShare()`/`declineShare()` — from, tool, kind, scope and expiry with Accept/Decline; Accept behind the gate except for `kind: 'update'`; the section carries `id="vault-inbox"` and `tabindex="-1"`. The inbox is read with the tab (`load()`) and again on the `host` push. |
| `src/app.ts` | **Badge (K4)**: `inboxCount` and `loadInboxCount()` — `shares.inbox` read after an unlock and on every `host` push (no timer), and `sidebarAction()` gained an optional count drawn as a badge on the Settings action whose title spells the number out; the count resets on a lock, and a locked window never reads the route. **Palette (K4)**: `openPalette` is handed `openInbox`, which opens Settings → Vault and focuses the inbox. |
| `src/palette.ts` | The `openInbox` context member and the `Vault inbox` item, offered while a guild answers (RNF-07). |
| `src/style.css` | A "vault and sharing (K4–K7)" section: `.reveal`/`.secret`/`.reveal-count` (tabular figures), `.gate`, `.holders-list`/`.holder`, `.send-dialog`/`.recipient`, `.inbox-row`; plus `.sidebar-action-badge` and `position: relative` on `.sidebar-action` so the count sits on the action instead of under its label. |
| `docs/handovers/k5-k7-shares-ui.md` | This file. |

**Not edited on purpose**: `shared/types.ts` — the block-2 contract was added there by the other
agent of the phase (SharesCore) and read from it; the file was re-read before each use. `backend/**`
(the Nod's half of K4–K7), `host/**`, `test/**` and `docs/specs/**`: other owners.

## Acceptance — how each item is met

`execucao` = run and observed; `leitura` = read from the code and the specs. The page was **not**
exercised in a window: see "What could not be done".

### #32 — K4 (page side)

| Item | How | Evidence |
| --- | --- | --- |
| The shares addressed to me are listed in an inbox | `src/settings.ts` `inboxCard()` reads `state.inbox`, which `load()` fills from `shares.inbox` for the Vault tab; a row shows title, kind, sender, scope and expiry | `leitura` (the card, the call, the state field) |
| Accept and Decline are offered and do their thing | `inboxRow()`: Accept → `shares.accept` (behind the gate), then `vault.list` + `shares.inbox` are read again and the new credential is on the tab; Decline → `shares.decline` and the inbox again | `leitura` |
| A new share shows up without a refresh of the person's own | the `host` push handler reads the tab's data again when the Vault tab is open (`on('host', …) => load()`), and the sidebar badge reads `shares.inbox` on the same push | `leitura` |
| No sealed blob and no secret on the page | `InboxShare` (the contract's shape) carries metadata only; the page never asks for the sealed copy and passes no secret to any call | `leitura` |

### #33 — K5 (page side)

| Item | How | Evidence |
| --- | --- | --- |
| Each gated action asks for the password where biometrics are missing | `state.session.biometric` false → `gatePrompt()` on the card, and the typed password travels in `password` of `vault.reveal` / `vault.copy` / `shares.send` / `shares.accept`; with biometrics true the page passes nothing and the backend asks `app.authenticate` itself | `leitura` |
| Cancelling shows / copies / accepts / sends nothing | Cancel clears `state.gate`, shows `Nothing was shown \| copied \| sent \| accepted` and runs nothing; a failed gate (empty password, a refused or cancelled authentication) only puts the backend's English error on the status line, and `state.gate` is already cleared before the call | `leitura` |
| A revealed secret counts ten seconds down and is cleared at zero | `showRevealed()` starts a one-second interval; the counter shows `hides in N s` and at zero `hideRevealed()` drops the state and the interval and `render()` replaces the card, so the secret leaves the DOM. Leaving the tab (`selectTab`), a lock (`updateSession`), a removal and `destroy()` clear it at once | `leitura` |
| The password is not kept | the field is read once and set to `''` before the call; the prompt itself is gone with the next render (`state.gate = null`) | `leitura` |

### #34 — K6 (page side)

| Item | How | Evidence |
| --- | --- | --- |
| A `blocked` credential has no send action | `vaultItem()` appends the Send button only when `item.scope !== 'blocked'`; the scope select writes `vault.setScope` and the tab redraws from the answered item, so choosing `Blocked` takes the button away | `leitura` |
| The scope is the owner's to set | `scopeRow()` draws the select only when `isOwner(item)`; a holder sees the scope as text with "set by the owner" | `leitura` |
| `role` / `org` reach whom the scope allows | the dialog lists what `shares.recipients` answers — the backend applies §5 — and a person the scope leaves out is a disabled checkbox with the reason | `leitura` |

### #35 — K7 (page side)

| Item | How | Evidence |
| --- | --- | --- |
| Holders are listed per credential with date and scope | `holdersCard()` draws one row per `VaultItem.holders` entry: name, the `owner` chip on the owner, `<Scope> · since <YYYY-MM-DD>`, and a `revoked` chip when the row has `removedAt` | `leitura` |
| Both sides see the same names | the rows come from the host's snapshot (`Snapshot.holders`), which both sides read; the page adds nothing of its own | `leitura` |
| …and the admin sees every org credential's holders | the host answers that set to an admin; the page draws what it is given, with no filter of its own | `leitura` |

## Commands run and observed results

1. **A transpile parse of this slice's four files**, on the final tree:
   `bun build --no-bundle src/settings.ts src/app.ts src/palette.ts src/ui.ts --target=browser
   --outdir=/tmp/nod-ui-parse3` → `Transpiled file in 39ms`, four chunks written, no diagnostic
   (`settings.js 86.52 KB`, `app.js 28.49 KB`, `palette.js 6.78 KB`, `ui.js 2.19 KB`). This is a
   **parse and transpile only**: it proves the files are syntactically valid TypeScript, and it is
   *not* a type check and *not* the project's gate.
2. **Not run**: `bun run typecheck`, the repo-wide `bun test`, `bun test <file>` (this slice has no
   test file — see the finding on the DOM harness), the smoke of `test/smoke/**`, any formatter or
   linter, and the app itself.

## What could not be done

**The page paths were not exercised on the real surface, and this is the honest limit of this
slice's evidence.** Two reasons, both outside this slice:

1. The methods the page now calls — `vault.setScope`, `vault.copy`, `shares.recipients`,
   `shares.send`, `shares.inbox`, `shares.accept`, `shares.decline`, and the `password` param of
   `vault.reveal` — have **no backend handler yet in the working tree at the time of writing**
   (`backend/shares.ts` does not exist; the `shared/types.ts` contract is in place). A run now would
   reach the runtime's unknown-method error on the first click, which proves nothing about the page.
2. The repo has no DOM harness (`jsdom`/`happy-dom` are not dependencies, and `test/` has no test
   for `src/`), and running the app needs the tinyjs host with an account, a guild and a second
   instance. Driving that is `test/smoke/connected.ts`'s job, which this slice does not run.

So every page item above is `leitura`, and the acceptance of #32–#35 on the real surface is owed to
whoever runs the smoke (or the coordinator) once SharesCore's backend half is in the tree.

## Decisions and findings for the coordinator

1. **`isOwner` treats a credential with no `owner` holder row as this person's own.** A credential
   that was never shared has no holder rows at all (`holders: []`), so the scope select has to be
   shown there; the rule is "no row marked `owner` → mine, otherwise the marked row's person". If
   the backend ever marks ownership differently (or answers rows for a local-only credential),
   this is the line to revisit.
2. **Send is offered to any holder, not only the owner.** The slice's text fixed the scope select as
   owner-only and said nothing about Send; SP06 §4/§5 says a receiver may re-send with the scope
   stored in the payload (never a wider one), and SharesCore confirmed `shares.recipients` works for
   any credential the person holds. So the page hides Send only for `blocked` and without a guild.
3. **An `update` share is accepted without the inline password prompt** (SP06 §4: nothing is shown,
   so there is no gate to pass). The backend stays the judge — if it answers `authentication
   required`, the status line shows it. Every other kind goes through the prompt where biometrics
   are missing.
4. **The countdown rewrites one text node, it does not re-render.** A ten-second rebuild every second
   would take the focus and the half-typed content of any field on the tab with it. The DOM node and
   `state.revealed` are cleared at zero, on a tab change, on a lock, on removal and on destroy.
5. **The badge reads `shares.inbox` on the unlock and on every `host` push, never on a timer**, and
   only while a guild answers and the session is unlocked (a locked window cannot read the route).
   One extra call per host push — the same cadence `host.presence` already runs on.
6. **`test/smoke/connected.html` calls `vault.reveal` with `{ toolId }` and no `password`**
   (line 335). Once K5's gate is live on the backend, that step fails on a machine without biometrics
   unless the smoke passes a password (`{ toolId, password }`) or enables biometrics. Not this
   slice's file: reported to its owner.
7. **The scope select and the holders list are drawn only when a guild answers**
   (`connected` or `stale`). Without a host the scope means nothing and `holders` is `[]`; the card
   then says so in words instead of offering a control that cannot do anything. A `stale` host still
   shows the last snapshot's holders, which is what the person last saw.
8. **`SCOPE_LABEL`/`SCOPE_ORDER`/`SCOPE_HINT`/`KIND_LABEL` live at module level in `src/settings.ts`**
   and are the page's only spelling of the three scopes and the three kinds; a new scope added to
   `host-api.ts` would have to be added here too (the `Record<ShareScope, …>` makes that a type error
   rather than a silent blank).

## What was left out

- **The backend half of K4–K7** (`backend/shares.ts`, the `vault.setScope`/`vault.copy` and
  `shares.*` handlers, the local migration for `vault_item.credential_id`/`scope`): SharesCore's,
  in flight in the same phase.
- **K8** (the admin's assignment prompt from the missing-copies list) and **K9** (the re-seal that
  clears `rotationPending`): the chip that K9 drives is drawn; the flow is not this slice's.
- **The `share.*` audit events** of E02 §6: the backend's.
- **A test for these screens**: the repo has no DOM harness, and adding a dependency is a scope
  decision, not this slice's.
- **The `handovers` entry points in `docs/specs/SP01/SP06`, any spec or `docs/canonico.md` change**,
  and the issue bodies: the coordinator's and the owners'.
- **`bun run typecheck`, the repo-wide `bun test`, the smoke, any formatter**: the coordinator's.

## For other owners

- **SharesCore**: the page codes against exactly the RPCs and types you confirmed (`vault.setScope`,
  `vault.copy`, `shares.recipients`/`send`/`inbox`/`accept`/`decline`, `password?` on the gated
  ones; `VaultItem.holders` always present). `shares.accept` must answer the landed `VaultItem`
  (used as the item the vault tab re-reads) and `shares.inbox` must stay metadata-only. If any of
  these moves, tell me: the page is the first caller.
- **The smoke's owner**: finding 6 above (`vault.reveal` without a password).
- **The coordinator**: findings 1–3 and 7 are the page's own readings of SP06 where the slice's text
  was silent; 6 is a real breakage to schedule once K5's backend lands.

## Where the evidence lands

This file, per `docs/handovers/README.md`: the files touched, the acceptance and how it was met, the
command and the observation (`execucao` for the transpile only, `leitura` for the rest), and what
was left out. The state of the slice is not declared here; the coordinator's handover carries it.

---

## Review fixes

Owner: **UIAdmin** (the page and the admin's holders list). Findings closed: **M7** and **L5** of
`docs/handovers/block2-review.md`. Contracts followed: `docs/specs/SP06-credential-sharing.md` §4
(the holders, RF-54), `docs/specs/SP02-auth-and-keys.md` §9 (the ten-second reveal), SP05 §4 (the
Vault screen), `docs/arquitetura.md` §5 (the page talks to the backend only), `AGENTS.md`,
`src/context.md`; the coordination contract that fixed `holders.list` and
`CredentialHolders`. Nothing here carries a secret: the only secret the page holds is the revealed
value, and the countdown now takes it off the screen by a wall-clock deadline.

### M7 — the admin could not see the holders of credentials they do not hold

**Cause.** The host already put `holders` for every credential of the guild inside an admin's signed
snapshot (`host/snapshot.ts`, `heldCredentials(me.id, me.admin)`), but the only readers were
`backend/shares.ts`'s `decorate`/`holdersOf` over the admin's own vault items. No RPC and no view
existed for the rest.

**Fix.**
- `backend/holders.ts` (new, pure): `buildCredentialHolders` turns the verified snapshot's `holders`
  map into `CredentialHolders[]` — one row per credential, the display names taken from
  `Snapshot.people` (a name the roster does not carry stays as the host sent it), the holders ordered
  owner first, live next, revoked last (each group in the host's own order), and the tool resolved
  through two injected lookups. Rows that are not `Holder`s are dropped, and a credential left with
  no valid row is dropped whole.
- `backend/main.ts`: `'holders.list'` (in `ADMIN_ONLY`, not a `HOST_WRITES` method — it is a read),
  and `credentialHolders()`, which assembles the two lookups from what this Nod knows: the person's
  vault rows (`vault_item.credential_id → tool_id`), `Snapshot.incomingShares`, and
  `shares.missing()`; the title comes from `catalogEntryOf` (the effective catalog). A credential
  none of those names is still listed, under its own id with `toolTitle: null`, so no holder row is
  lost.
- `shared/types.ts`: `CredentialHolders` and the `'holders.list': [void, CredentialHolders[]]`
  contract line.
- `src/settings.ts`: state `credentialHolders`, read with the Vault tab for an admin while a guild
  answers; a "Credential holders" card (`role="region"`, heading, one group per credential: title
  or credential id, then each holder `Name` · `owner` chip · `Scope · since YYYY-MM-DD` · `revoked`
  chip). Read-only, every value a text node, no `innerHTML`, no keyboard-only interaction. The card
  refreshes on the `host` push through the Vault tab's existing `load()`.
- `test/holders.test.ts` (new, 8 tests): one row per credential with roster names and catalog titles;
  fallback to the host-sent name; owner-first/live/revoked ordering with date and scope; the
  credential-id fallback with `toolTitle: null`; a tool the catalog does not carry; no snapshot /
  no holders / empty rows; malformed rows and a credential left empty; two credentials of one tool.

**Test (`execucao`).**

```
$ bun test test/holders.test.ts
 8 pass
 0 fail
 17 expect() calls
Ran 8 tests across 1 file. [79.00ms]
```

**Dependency for another owner.** The signed body names a credential but not its tool (`Holder`
carries no `toolId`, and the contract fixed `Snapshot.holders` as it is; NodShares confirmed it).
The Nod therefore names the tool for the credentials it holds, saw in `incomingShares`, or that
appear in `assignments.missing`; a member-to-member credential is listed under its own id with
`toolTitle: null`. A host that adds `credential_holders.tool_id` to `holdersOf`/`Holder` would make
every title real without a change to the builder — the fallback is the one line in
`credentialHolders()`.

### L5 — the reveal countdown was page-timer based

**Cause.** `src/settings.ts` stored `left: 10` and decremented it once per `setInterval` tick. A
hidden window's timers are throttled (`backend/context.md`, `docs/tinyjs.md` §3), so the secret
could stay in the DOM well past ten seconds.

**Fix.** `state.revealed` now carries `expiresAt: Date.now() + 10_000`; each tick compares the wall
clock against it, clears at `remaining <= 0`, and rewrites only the counter with
`Math.ceil(remaining / 1000)`; the first render's text derives from the same deadline. A
`visibilitychange` listener clears the revealed secret (and re-renders) the moment the page becomes
`hidden`, and is removed on `destroy()`. `hideRevealed()` still stops the timer and nulls the state,
so the secret is out of the DOM and out of the page's variables at zero, on hide, on a lock, and on
leaving the tab.

No DOM harness exists for `src/` (same limitation as the original slice); the fix is `leitura` and
was not executed in a browser. The math and the event wiring are the whole change; the smoke's
reveal step, run by the coordinator, is the surface check.

### Files touched

- `backend/holders.ts` — new pure builder.
- `backend/main.ts` — `CredentialHolders`/`Snapshot` imports, `snapshotBody()`,
  `credentialHolders()`, the `holders.list` handler and its `ADMIN_ONLY` row.
- `shared/types.ts` — `CredentialHolders`; `holders.list` in `ApiContract`.
- `src/settings.ts` — the holders state and card; the deadline-based countdown and the
  `visibilitychange` listener.
- `test/holders.test.ts` — new.
- `docs/specs/SP06-credential-sharing.md` §4 and §6, `docs/specs/SP02-auth-and-keys.md` §9,
  `docs/specs/SP05-nod-connected.md` §4 — the spec lines the two behaviors moved.
- `docs/handovers/k5-k7-shares-ui.md` — this section.

Not touched: `backend/shares.ts`, `backend/host-client.ts`, `host/**`, `test/shares.test.ts`,
`test/rotation.test.ts`, `test/assign.test.ts` (NodShares/ShareAuthz). The whole suite, the
typecheck, the formatter and the smoke were not run (coordinator's).

