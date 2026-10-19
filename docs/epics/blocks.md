# Effort blocks — E01, E02 and E03

How the epics (`docs/epics/E01-connected-mode.md`, `docs/epics/E02-credential-sharing.md`,
`docs/epics/E03-docked-tabs.md`) split into stories, how big each one is, and in which effort block
it lands. E04 and E05 (later phases, `Proposto`) have trackers (#69, #70) but no stories yet.

Evidence: sizes are judgement from `leitura` of the epics, the code and the past handovers. Nothing
was executed, and no velocity exists yet.

## 1. Method

Taken from the two references the owner chose:

- **Relative, not hours.** Points measure effort, complexity and uncertainty compared to a known
  story, never time (Atlassian, `https://www.atlassian.com/agile/project-management/estimation`;
  Kashyap, `https://kashyapsandeep.medium.com/how-to-actually-estimate-story-points-b9062bc53b64`).
- **Fibonacci scale** 1, 2, 3, 5, 8, 13, so nobody argues 7 against 7.5 (Kashyap).
- **Anchor stories** from this repo's own history, so "a 3" means the same thing every time
  (Kashyap: "start with an anchor story"). The handovers in `docs/handovers/` describe each one:

  | Points | Anchor | Why |
  | --- | --- | --- |
  | 2 | `v2-auth` — `shared/auth.ts` renamed to the v2 API with its tests | pure module, known shape |
  | 3 | `v2-session-vault` — `backend/vault.ts` and keychain session, 12 tests | known runtime API, some edges |
  | 5 | `v2-repo` — `backend/repo.ts` schema and queries | broad, a real migration surprise found in it |
  | 8 | `v2-tool-windows` — `backend/tool-windows.ts` | runtime integration; B05 surfaced in it afterwards |

- **Split above 8.** Atlassian sets a ceiling (16 hours, or a points cap) above which items are
  broken down. Here the cap is 8: nothing is 13; anything that felt like 13 was split.
- **Uncertainty called out apart from complexity** (Kashyap). Each story has both columns. High
  uncertainty goes first in its block.
- **Velocity is a learning signal** (both). After block 1, compare points to what happened and
  recalibrate the anchors before starting block 2. Points are never converted to days.
- Estimation is meant as a team conversation. Here it's a first proposal for the owner to challenge
  story by story.

## 2. Blocks

| Block | Delivers | Points | Stories |
| --- | --- | --- | --- |
| **1 — One guild, synced** | Host on Coolify; people activated with access codes; org tools, roles and grants managed on the host and synced to every Nod; offline cache; events; vault bound to origin; the crypto risk of both epics retired | 67 | 19 |
| **2 — Mine and shared** | Personal tools, views and favorites; vault encrypted with `vaultKey`; device sessions and update manifest; credential send, assign and share with scope, holders and gate | 56 | 16 |

E01 totals 85 points; E02 totals 38.

Why this cut:

- Each block ends with something the owner can use on two machines, not half of a feature.
- Block 1 front-loads the two high-uncertainty stories (H3, S0): same-bytes crypto in two runtimes
  is the assumption both epics stand on.
- Block 1 limit: until block 2, adding a host shows only org tools. The first admin can publish
  their local tools to an empty host (B8a), but other people's local tools only come back as
  personal tools in B8b. With a single admin bootstrapping, that's acceptable.

## 3. Block 1 — One guild, synced (67 points)

| ID | Issue | Epic | Story | Points | Complexity | Uncertainty | After |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | #4 | E01 | Host skeleton: host/, Elysia 2 beta pinned, bun:sqlite + migrations, /health, env config, Dockerfile + compose with /data volume | 3 | low | med | — |
| H2 | #5 | E01 | Schema + repo: people, sessions, access codes, roles, person_role, entries/views with scope+owner, grants, favorites, events, meta | 5 | med | low | H1 |
| H3 | #6 | E01 | Shared key derivation in shared/auth.ts (master/authKey/vaultKey), same bytes in Bun and txiki.js, PBKDF2 cost measured in the Nod runtime | 5 | med | high | — |
| S0 | #7 | E02 | Spike: X25519 + HKDF + AES-GCM seal and Ed25519 sign/verify, same bytes in txiki.js and Bun, cost measured | 3 | med | high | H3 |
| H4 | #8 | E01 | Setup code, access-code activation, salt + login, argon2id(authKey), fake salt, single error, rate limit, revocable sessions | 5 | med | med | H2,H3 |
| H5 | #9 | E01 | Admin API: people (create, reissue code, revoke), roles, grants, org tools and views; Elysia schemas from shared types | 5 | med | med | H4 |
| H6 | #10 | E01 | Signing key on first boot, /.well-known/nod with fingerprint, signed per-person /v1/state with ETag | 3 | med | low | H5 |
| H8 | #11 | E01 | Events ingest: batches, client ids, idempotent, ack | 2 | low | low | H4 |
| H9 | #12 | E01 | Backup (VACUUM INTO on a schedule) + restore check + first deploy on Coolify | 3 | low | med | H6 |
| B1 | #13 | E01 | Nod host client: backend fetch, token in keychain, pinned key, Ed25519 snapshot verification in txiki.js | 3 | med | med | H6 |
| B2 | #14 | E01 | Settings → Hosts: add (address, fingerprint), activate with access code, set password, sign in, status, last sync, sync now, remove | 5 | med | low | B1,H4 |
| B3 | #15 | E01 | One password: local password = host password, offline local verifier, online password change (old + new authKey) | 3 | med | med | B2,H3 |
| B4 | #16 | E01 | Sync loop: unlock / timer / sync now, cache, stale state, offline behaviour | 5 | med | med | B1 |
| B5 | #17 | E01 | Catalog, roles and grants read from the snapshot in connected mode | 3 | med | low | B4 |
| B6 | #18 | E01 | Admin screens (Tools, Roles, People) write to the host API when connected | 5 | med | low | B5,H5 |
| B8a | #19 | E01 | Empty host: its first admin publishes the local tools as org tools, once | 2 | low | low | B6 |
| B9 | #20 | E01 | Vault fills only on the origin a credential was saved for | 2 | low | low | — |
| B10 | #21 | E01 | Event push in batches + 'what was sent' view | 2 | low | low | B4,H8 |
| B11 | #22 | E01 | Two-machine smoke for E01 outcomes 1–5 and 8 + docs update | 3 | low | med | all |

## 4. Block 2 — Mine and shared (56 points)

| ID | Issue | Epic | Story | Points | Complexity | Uncertainty | After |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H7 | #23 | E01 | Personal tools, personal views, favorites API: owner-filtered, last-write-wins by updatedAt | 3 | low | low | H6 |
| B7 | #24 | E01 | Personal tools, personal views, favorites in the Nod: outbox, sidebar order | 5 | med | low | B5,H7 |
| B8b | #25 | E01 | Add host offers the remaining local tools as personal tools; remove host keeps personal tools as local | 3 | med | med | B7 |
| V1 | #26 | E01 | Vault values encrypted with vaultKey before the keychain; migrate existing items; biometric unlock keeps vaultKey; reset wipes | 5 | med | med | B3 |
| O1 | #27 | E01 | Device sessions list and revoke (person and admin) | 2 | low | low | H4,B2 |
| O2 | #28 | E01 | Minimum app version + auto-update manifest served by the host | 3 | med | med | H6 |
| K1 | #29 | E02 | Key pairs at activation, private keys under vaultKey, public keys on the host, regenerated on reset | 3 | med | low | S0,V1 |
| K2 | #30 | E02 | Colleague key pinning, fingerprint in Settings, key-change warning | 3 | med | low | K1 |
| K3 | #31 | E02 | Host: shares table and routes, expiry, events without content | 3 | low | low | K1 |
| K4 | #32 | E02 | Send / accept / decline + vault inbox | 5 | med | med | K2,K3 |
| K5 | #33 | E02 | Gate on reveal, copy, accept, send; reveal countdown | 3 | low | med | K4 |
| K6 | #34 | E02 | Sharing scope role / blocked / org, enforced by Nod and host | 3 | med | low | K4 |
| K7 | #35 | E02 | Holders list per credential | 2 | low | low | K4 |
| K8 | #36 | E02 | Assign to a person or a role; members-missing-a-copy list sealed by the admin's Nod | 5 | med | med | K4,K6 |
| K9 | #37 | E02 | Share with updates: re-seal on rotation; rotation pending on revoke | 5 | med | med | K8 |
| K10 | #38 | E02 | Two-machine smoke for block 2 (E01 outcomes 6–7, E02) + docs update | 3 | low | low | all |

## 5. Block 3 — Docked tabs and quick links (56 points)

E03 alone: 14 points of spikes, 42 of stories. Sized against the same anchors (§1), with the
`v2-tool-windows` 8 as the reference for runtime window work. The spikes go first: each answers a
question the runtime decides (`docs/tinyjs.md` §3, §10), and if D1 or D2 fails on an OS, docked mode
is offered only where it passes.

| ID | Issue | Story | Points | Complexity | Uncertainty | After |
| --- | --- | --- | --- | --- | --- | --- |
| G3 | #51 | Gate: E03 requirements into `docs/canonico.md` §14 | — | — | — | — |
| D0 | #52 | Spike S0: fix B05, tool windows land at the requested rect | 3 | med | high | — |
| D1 | #53 | Spike S1: frameless window on the slot; `setChrome` frame toggle keeps the page | 3 | med | high | D0 |
| D2 | #54 | Spike S2: follow `main` (ResizeObserver, move polling), gap and lag per OS | 3 | med | high | D1 |
| D3 | #55 | Spike S3: focus order, the docked tab never drops behind `main` | 2 | low | high | D1 |
| D4 | #56 | Spike S4: `target=_blank` and OAuth popups adopted as tabs | 3 | med | high | D1 |
| T1 | #57 | Tab model: several windows per tool, switch without reload | 5 | med | med | D0, G3 |
| T2 | #58 | Docked slot: the visible tab lies on the center panel and follows `main` | 8 | high | med | T1, D1–D3 |
| T3 | #59 | Tab strip, ⌘T/⌘W/⌃Tab, views as tabs | 5 | med | low | T1 |
| T4 | #60 | Detach and dock back without reload | 3 | med | low | T2, D1 |
| T5 | #61 | Docked / Windows setting; Windows mode unchanged | 2 | low | low | T2 |
| T6 | #62 | Restore tabs, order, addresses, docked/detached state | 3 | low | low | T3, T4 |
| Q1 | #63 | Links clicked inside a tool open as an ad-hoc tab next to it | 5 | med | med | D4, T3 |
| Q2 | #64 | Open link by hand: palette (⌘L) and `nod://open?url=` | 3 | low | low | T3 |
| Q3 | #65 | Save any tab to the sidebar in one step (⌘D) | 3 | low | low | Q1, Q2 |
| Q4 | #66 | Ad-hoc tabs get no backend methods and no autofill | 2 | low | low | Q1 |
| X1 | #67 | Block 3 real-page smoke + docs | 3 | low | med | all |

The spikes may run before G3 closes: they measure and ship no product code. RF-55…RF-57 of the
epic's first draft were renumbered RF-66…RF-68 (those numbers were spent on shipped work).

## 6. Issues

Each story is a GitHub issue in `CaioFaSoares/Nod`, labelled `epic:*`, `area:*`, `sp:<points>`
and `type:story` or `type:spike`, in milestone "Block 1 — One guild, synced", "Block 2 — Mine and
shared" or "Block 3 — Docked tabs and quick links". The epic trackers are #2 (E01), #3 (E02),
#68 (E03), #69 (E04) and #70 (E05); they stay open.

Gate #1 comes first: under `AGENTS.md` no product code starts until the owner moves
the epics' requirements into `docs/canonico.md` §14. The issues hold the status; this file never
does.
