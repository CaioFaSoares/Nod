# src/ — Nod's page

The single page of the main window: sign-in, sidebar, Home, palette and Settings. Module by module:
`docs/arquitetura.md` §5; window model: `docs/canonico.md` §7.

## Rules

- **Talks only to the backend**, through `call` and `on` in `api.ts`. The only other runtime surface
  is `tiny.dialog` for choosing export/import files (`docs/arquitetura.md` §2). No network, no
  storage, no `innerHTML`.
- **No secret held in the page** beyond the moment of typing a password, or a revealed credential
  during its countdown (E02 §5). The page clears both right after.
- **English everywhere**: text, identifiers, messages (`docs/canonico.md` RNF-08).
- **Keyboard first**: every action reachable from the palette (`docs/canonico.md` RNF-07).

## Screens (block 1 landed; block 2 in progress)

| Screen | Change | Story | Spec |
| --- | --- | --- | --- |
| First run | Third path: "Join a guild"; a `nod://join` invite opens it | B2 | SP05 §4 |
| Settings → Hosts (new) | Add (address → guild + fingerprint → email + code), activate, sign in, status, sync now, remove; the signed-out notice; a "Keep your local tools" step listing the join's leftovers, all checked, "Keep as personal tools" (B8b) | B2, B8a, B8b | SP05 §4 |
| People/Tools/Roles/Activity | Same screens; data from the host when connected; "New access code"; Activity's sent vs pending; People: one person's devices with Revoke (O1) | B6, B10, O1 | SP05 §4 |
| Sidebar | Order favorites → org → personal; "offline" badge; the count of shares waiting in the inbox on the Settings action | B4, K4 | SP05 §4 |
| Main window | New-version notice with Install (admin), Details and dismiss; the O2 banner while this Nod is older than the guild's `minAppVersion` (persistent, no dismiss) | u1, O2 | RF-55, SP03 §3, `docs/distribuicao.md` §8 |
| Home / sidebar | Favorite toggle; "Add personal tool" (a dialog, and a palette action); the personal card and the tool window of a tool that did not come from the org carry the canonico §22 warning | B7 | SP05 §3–§4, canonico §22 |
| Settings → Vault | Inbox (`shares.inbox`) with Accept/Decline, read again on the `host` push; per credential: the scope select (Role/Org/Blocked, owner only), Reveal behind the gate with a 10 s countdown, Copy behind the gate (the secret never reaches the page), Send (hidden when `blocked`) with the recipients dialog and its `key changed — confirm in Account` warning, holders with date and scope, and the `rotation pending` chip | K4–K7 landed, K8–K9 pending | SP06 §4–§5, SP02 §9 |
| Palette | "Vault inbox" opens Settings → Vault on the inbox | K4 | RNF-07 |
| Settings → Account | Devices (sessions) list and revoke — hidden without a host (O1); "Your key fingerprint" (own pair, K1); the Colleagues list with each pinned fingerprint, the `key changed — confirm` warning and its Confirm (K2) — both hidden without a host | O1, K1–K2 | SP03, SP06 §2 |

The docked view and tabs (`docs/epics/E03-docked-tabs.md`) are not in these blocks.
