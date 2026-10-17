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

## Screens (block 1 landed; block 2 pending)

| Screen | Change | Story | Spec |
| --- | --- | --- | --- |
| First run | Third path: "Join a guild"; a `nod://join` invite opens it | B2 | SP05 §4 |
| Settings → Hosts (new) | Add (address → guild + fingerprint → email + code), activate, sign in, status, sync now, remove; the signed-out notice | B2 | SP05 §4 |
| Settings → People/Tools/Roles/Activity | Same screens; data from the host when connected; "New access code"; Activity's sent vs pending | B6, B10 | SP05 §4 |
| Sidebar | Order favorites → org → personal; "offline" badge | B4 | SP05 §4 |
| Main window | New-version notice with Install (admin), Details and dismiss | u1 | RF-55, `docs/distribuicao.md` §8 |
| Home / sidebar | Favorite toggle; "Add personal tool" | B7 (block 2) | SP05 §3 |
| Settings → Vault | Gate on reveal/copy with countdown; inbox; holders; scope; rotation pending | K4–K9 (block 2) | SP06 |
| Settings → Account | Devices (sessions) list and revoke; own key fingerprint | O1, K2 (block 2) | SP03, SP06 §2 |

The docked view and tabs (`docs/epics/E03-docked-tabs.md`) are not in these blocks.
