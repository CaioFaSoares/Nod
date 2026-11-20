# src/ — Nod's page

The single page of the main window: the entry screen, sidebar, Home, the tab view of docked mode
(0.6.0), palette and Settings. Module by module: `docs/arquitetura.md` §5; window model:
`docs/canonico.md` §7.

## Rules

- **Talks only to the backend**, through `call` and `on` in `api.ts`. The only other runtime surface
  is `tiny.dialog` for choosing export/import files (`docs/arquitetura.md` §2). No network, no
  storage, no `innerHTML`.
- **No secret held in the page** beyond the moment of typing a password, or a revealed credential
  during its countdown (E02 §5). The page clears both right after.
- **English everywhere**: text, identifiers, messages (`docs/canonico.md` RNF-08).
- **Keyboard first**: every action reachable from the palette (`docs/canonico.md` RNF-07).
- **Atrius skin (2026-11-19)**: `style.css` follows the Atrius design system — its tokens (`ink-100…1000`,
  `brand`, `state-*`, 4px spaces, 24px cells), square corners, 1px rules, hard shadows only on floating
  layers, state as glyph + word (`▸ ✓ ◆ × ! ·`), never colour alone. The text stays English (RNF-08):
  only the visual language comes from Atrius. Home is a list (one row per tool, columns shared through
  `subgrid`), the rail is Atrius' 48px `shell-rail`. The supplied UI contained no Obel Mono font
  binaries, so no missing font URLs are shipped: the family prefers a locally installed Obel Mono,
  then falls back to the system monospace. Bundling fonts requires their files and license.
- **Row acts are icons (2026-11-19)**: a list row's acts (Home, Settings → Tools) are `iconButton`s in
  fixed slots (`ui.ts`); the words stay the button's text, label and tooltip, so a slot that does not
  apply is an `iconSlot` and every act keeps its column. Forms keep worded buttons.
- **The style toggle (2026-11-19, RF-72)**: the window wears one of two skins — Atrius or Nod Sober —
  in Automatic/Light/Dark, with custom colours per theme; Settings → Account → Appearance edits it
  and `src/appearance.ts` applies it (RF-72 for the requirement, the decision row in `docs/canonico.md` §22, the tokens in `src/style.css`).
  The page draws every screen from the same DOM: `style.css` keeps four token blocks and the rules
  below them read only the internal tokens, so a skin change re-dresses the open window with no
  re-render. The state lives in `store.json` (`nod.info` answers it, `nod.setAppearance` writes it);
  nothing is read from or written to browser storage, and no colour or skin ever travels to a guild.
  Rubik (Sober's face) ships in `src/fonts/` with its SIL OFL license — no network font.
- **The person's own sidebar (2026-11-19)**: `sidebar.layout` (`shared/sidebar-layout.ts`) is drawn by
  `customRows`/`sidebarFolder` in `app.ts`; edits go through the pure helpers and `commitLayout`, which
  sends the whole layout back. Drag (pointer events, 4 px threshold), ⌥↑/⌥↓, the item's menu (right
  click, menu key, ⇧F10) and the palette's "Sidebar: …" rows reach the same edits. The rail's `+` is
  the personal-tool dialog with an optional folder. §22 "The person's own sidebar".
- **0.5.0, RF-60 — the entry screen**: while locked, `app.ts` mounts the rail of tiles in
  `entry.ts` (`session.profiles` answers the tiles; nothing there is a secret). Offline is this
  machine's own profile, a guild tile is a guild this Nod joined, and `+` is the join flow of
  `join.ts` — the same dialog Settings → Guild connection mounts, which is why `mountJoinFlow` left
  `settings.ts`. Every unlock carries its `target`, and the backend keeps the mode for the session:
  an **offline session** (`session.mode === 'offline'`, `host.offlineSession`) reads nothing of the
  guild, exactly as O2 disconnects it, and the window says so in a banner.
- **0.5.0, RF-61 — the seed is an optional import**: the Offline tile of a machine with no account
  offers "Import setup file" (`session.importSeed`); a release without `resources/seed.json` starts
  empty, and gate origins stay those of the embedded seed.
- **O2 (owner decision 2026-10-17)**: while this Nod is older than the guild's `minAppVersion` the
  guild is disconnected. The banner says so at the top of the window; `hasHost()` and `sharing()`
  (`settings.ts`) are the page's half of the rule, so every screen that would read the guild — the
  org tools, the devices, the colleagues, the inbox, the holders, the leftovers — shows the
  local-mode one instead, and Settings → Guild connection keeps the guild's card with the reason on it. The
  backend answers empty or refuses the calls that would reach the host (`backend/context.md`).

## Task-based interface (0.9.0)

The approved stories and simplification request are in `docs/canonico.md` §22; this is the page's
implementation map, not an additional requirement or an execution report.

- `settings-navigation.ts` owns labels, groups, stable destination IDs, admin visibility and searchable
  aliases. Settings and the palette consume it; old words such as “vault”, “hosts” and “roles” remain
  searchable without defining the primary copy. Backend names and permissions do not change.
- Home offers Search tools and Add personal tool. An admin's empty Home can open the new team-tool
  editor directly. The rail's Saved logins action carries the pending-share badge; Settings opens Account.
- Settings groups personal work, guild work and Advanced. Only admins see Advanced (Activity/setup
  files). Disclosures retain expansion only for the mounted screen; no browser storage is used.
- Saved logins puts pending shares first, then the login list. Add/edit is an explicit disclosure
  (open for an empty vault or an edit); holders and encrypted backup/restore are secondary. Missing
  copies have a visible count and their report opens automatically while any are pending. Credential
  cards retain scope, default-autofill, sharing, revocation, rotation warnings, gates and reveal cleanup.
- The team-tool editor leads with address, name, category and access. ID/order, icon, saved links and
  autofill opt-out stay available under More options. Probe is labelled Get details / Refresh details;
  it still uses the same backend operation. Origin/next-release warnings remain outside the disclosure.
- Account leads with password, updates and devices. Key verification is secondary but automatically
  opens for changed peer keys or pending/unavailable own keys; its summary names the problem. App
  icon is secondary. Closing a disclosure clears password inputs; leaving/locking destroys the screen.
- Entry says Unlock instead of implying that a locked guild account is signed in. Join leads with an
  invite link; Use a code reaches the existing invite/access/setup-code detection, and Sign in / Set up
  a guild remain secondary actions. Trust preview, fingerprint, expiry and role checks stay unchanged.
- Saved-password copy describes device encryption, not a per-secret OS-keychain item (RF-63). Personal
  tool copy distinguishes guild-device sync from this device's offline profile.

## 1.0.0 (RF-79, the library and its two fields)

- Home is the library: a search field and three labeled view buttons (Cards, List, Org chart) ride
  the content header (`libraryToolbar`, `src/app.ts`). Models live in `shared/library.ts`; responsive
  geometry lives in `shared/library.css`. Categories are collapsible groups (a machine-local choice
  in `localStorage`), with featured cards only when the library has room. List uses one native button
  per tool; filtering keeps each view's wrapper intact. The org chart draws the guild's roles
  (`roster.list` and `roles.list`, fetched when the view needs them). Cards retain their six actions,
  tags and org account (RF-77/RF-78), without fixed title tracks. The UI cleanup removes the isometric
  view; an old `blocks` preference reads as Cards without writing on boot (RF-79, `docs/canonico.md`).
- The tool editor (Settings → Tools) carries Tags (comma-separated; the validator trims, drops
  empties, keeps twelve) and the Guild account label beside the category — org tools only, exactly
  like the category's own rule.
- The tab strip nests: a tab another one opened renders indented under its opener
  (`.tab-child`), drags among its siblings (the pointer preview, Alt/Option + ↑/↓ for the
  keyboard) and commits through `tabs.move`; a parent's close takes its children with it.

## Screens (block 1 and block 2 landed)

| Screen | Change | Story | Spec |
| --- | --- | --- | --- |
| Entry screen (0.5.0) | The locked screen is the rail of tiles in `entry.ts`: Offline (this machine, "Import setup file" while no account exists — RF-61), the guild (icon or initials, a status dot, its account and password, "Sign in again" when signed out), and `+`, the join dialog of `join.ts` (invite link → card → create account; sign in, access code and "Set up a guild" beside it). The `nod://join` push opens `+` with the invite already looked up; a lock re-reads the tiles | RF-59, RF-60, RF-61 | SP05 §4 |
| Settings → Guild connection | Add (address → guild + fingerprint → email + code), activate, sign in, status, sync now, remove; the signed-out notice; a "Keep your local tools" step listing the join's leftovers, all checked, "Keep as personal tools" (B8b). The dialog is `join.ts`, the same one the entry screen mounts | B2, B8a, B8b, RF-59 | SP05 §4 |
| People/Tools/Roles/Activity | Same screens; data from the host when connected; Tools: the org tools grouped by category the same way Home draws them (RF-62's `groupByCategory` — a heading per category, "Other tools" for the unfiled, the person's own tools under "Personal tools"), each editor keeping its category field, sent on save; People (connected): the Invites card — roles, max uses, expiry, "Create invite" answering the link and the code once, the list with status and Revoke (RF-59), or the reason in place of the form when the host predates 0.5.0 — and per person "New access code"; Activity's sent vs pending; People: one person's devices with Revoke (O1); the guild owner (an "Owner" chip) also edits a person's name and email and deletes anybody but themselves (RF-64) | B6, B10, O1, RF-59, RF-62, RF-64 | SP05 §4 |
| Sidebar | Order favorites → org → personal; the org half grouped by category with a divider per group (RF-62's `shared/catalog.ts` `groupByCategory`, through `sidebarOrder`), the digits ⌘1…⌘9 following that visual order; "offline" badge; the count of shares waiting on the direct Saved logins action; the top mark is the guild's icon (or its initials) while a guild is the session's, and the Offline glyph in an offline session (RF-60); docked mode's "Open tabs" button sits under that mark with the count of open tabs, disabled while the strip is empty, `aria-current` on the tab view, and enters the tab view with no backend call (the path of a tool click after its answer, E03) — absent in Windows mode | B4, K4, RF-49, RF-60, RF-62 | SP05 §4 |
| Main window | New-version notice with Install (admin), Details and dismiss; the O2 banner while this Nod is older than the guild's `minAppVersion` (persistent, no dismiss); the offline-session banner with "Switch to <guild>" (RF-60) | u1, O2, RF-60 | RF-55, SP03 §3, `docs/distribuicao.md` §8 |
| Home / sidebar | Cards in the sidebar's order: favorites, one section per category with an `h2` and "Other tools" for the unfiled org tools (RF-62), then the personal tools — one grid as before while no tool carries a category; favorite toggle; "Add personal tool" (a dialog, and a palette action); the personal card and the tool window of a tool that did not come from the org carry the canonico §22 warning | B7, RF-62 | SP05 §3–§4, canonico §22 |
| Saved logins | Inbox (`shares.inbox`) with Accept/Decline, read again on the `host` push; the list groups the credentials by tool under the tool's heading, and every credential of a tool is its own card (its `id`, label, username, a `Default` chip on the one autofill uses and a "Use for autofill" button on the others → `vault.setDefault`), so all of the following acts on one credential named by `itemId`: the scope select (Role/Org/Blocked, owner only), Reveal behind the gate with a 10 s countdown, Copy behind the gate (the secret never reaches the page), Send (hidden when `blocked`) with the recipients dialog and its `key changed — confirm in Account` warning, holders with date and scope and a `Remove` for a live holder (owner or admin, K9), the `rotation pending` chip (title "save a new secret to rotate") and `Edit` (replaces that credential through `vault.save` with its `itemId`); the save form adds a new credential to the chosen tool (label placeholder "e.g. admin account"); the send and assign dialogs title the credential by label + tool; saving a shared credential shows the update warning and the save itself fans the update out; for an admin, an `Assign` dialog per credential (to a role or to one person, with `Remove assignment`) and the "Members missing a copy" list with each member's key state and one gated "Send copies" | K4–K9, RF-65 | SP06 §4–§5, SP02 §9 |
| Palette | "Review shared logins" opens Saved logins on the inbox | K4 | RNF-07 |
| Settings → Account | Devices (sessions) list and revoke — hidden without a host (O1); "Your key fingerprint" (K1), whose `keys.mine` answer is `MineKeys` — `ok`/`pending`/`unavailable` and the sentence to show; the Colleagues list with each pinned fingerprint, the `key changed — confirm` warning and its Confirm (K2) — both hidden without a host | O1, K1–K2 | SP03, SP06 §2 |
| Tab view (0.6.0) | Docked mode's center panel, in `tabs.ts` (mounted by `app.ts` as `view === 'tab'`): the strip (the tool's icon, the title, "not saved" on an ad-hoc tab, ↗ on a detached one, loading/failure, × to close, ⤓ on a detached tab to dock it back, and `+` for another tab of the tool), the toolbar (Detach/Dock, Save to sidebar, Open link…), and the slot under them; the page reports the slot — `tabs.slot({ rect })` from the slot's box, with `null` for Home/Settings, a detached or absent active tab, an overlay, a hidden page — and `null` once in Windows mode (Wayland) | RF-49…RF-51 | E03 §6, canonico §7 |
| Open link (0.6.0) | Any `http(s)` address by hand — ⌘L, the toolbar, the palette and the push of the same global shortcut — as an ad-hoc tab (`tabs.openLink`): not saved, no autofill, no backend method (RF-68); the dialog is `app.ts`, beside the personal-tool one | RF-66, RF-68 | E03 §6 |

Block 2 review fixes: the Vault tab carries a "Credential holders" card for an admin (M7)
— every guild credential from `holders.list`, with its holders, date, scope and revoked marker — and
the reveal countdown is a wall-clock deadline that the page clears on `visibilitychange` (L5).
