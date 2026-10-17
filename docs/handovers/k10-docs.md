# K10 (docs) — block 2 docs updated to what was built (issue #38)

Owner: the **docs** half of #38 (K10), "Docs updated to what was built", under the coordinator's
assignment in this session. Everything here is `leitura` of the eleven block 2 handovers
(`h7-o1-o2-host.md`, `k3-host-shares.md`, `v1-vault.md`, `b7-personal.md`, `o1-o2-nod.md`, `b8b.md`,
`k1-k2-keys.md` incl. the key-sync section, `k4-k6-shares-core.md`, `k5-k7-shares-ui.md`,
`k8-assign.md`, `k9-rotation.md`) and of the code each claim points at, checked with `grep`/`read`.
No test, no gate, no formatter was run — the docs half has none to run, and the smokes are SmokeK10's
and the gates Main's. The private seed was never read, printed or touched.

KeyFixes' in-flight change (`keys.mine` → `MineKeys`, and `reset: true` on every access-code
activation) arrived by message while this file was being written and is reflected in
`backend/context.md`, `shared/context.md`, `src/context.md` and SP05 §3.

## Files touched and the handover finding each edit reflects

| File | Edit | Finding |
| --- | --- | --- |
| `docs/specs/SP01-host-data-model.md` | §2's `meta` key list now names `guild_icon_sha256`/`guild_icon_bytes` and records that `guild_name`/`created_at` have no writer; §5's acceptance now reports `schema_version = 3` (migrations 1–3) | k3 finding 1; key sync (migration 3); i2h finding |
| `docs/specs/SP02-auth-and-keys.md` | §9: the password still unlocks where biometrics exist (the entry screen keeps its field beside the biometrics button); the action gate keeps its own rule | H7/K5 reading of `src/app.ts` `renderUnlock` |
| `docs/specs/SP03-host-api.md` | §1: `/v1/personal/tools*` added to the 512 KB icon exception; `409` row gains `recipient has no keys` and `the owner cannot be removed`; `404` row rewritten (unknown id → 404, another's → 403). §2: the stale "did not land in block 1 / 404 until they land" paragraph replaced; a note that no current-device marker is derivable. §3: the missing list excludes clients; `update.url` is served but not fetched by the running Nod | H7 findings 5/6, decisions; k3 finding 3; K8; o1-o2-nod finding 1 |
| `docs/specs/SP04-sync.md` | §3 gains the O2 version gate: the run reads `/v1/meta/app` first and pushes nothing while this Nod is older | o1-o2-nod findings 1–2, O2 |
| `docs/specs/SP05-nod-connected.md` | §1: `shared/seal.ts`, `shared/version.ts`, `shared/vault-crypto.ts`, `backend/keys.ts`, `backend/shares.ts`, `backend/personal.ts` added; `repo.ts` row now `user_version = 5`. §2: heading `user_version = 5`, the `peer_keys` DDL and the two `vault_item` columns added, the `user_version` guard fixed. §3: the block 2 RPCs added (`favorites.list`, `session.disableBiometric`, `people.sessions`/`revokeSession`, `host.localLeftovers`/`adoptLocalAsPersonal`, `keys.mine` → `MineKeys`/`peers.list`/`peers.confirm`, `vault.copy`/`vault.setScope`, `shares.*`, `assignments.*`) and the K5 gate sentence. §4: the Vault sharing screen and Account's device/key cards | B7, V1, B8b, O1, K1–K2, K4–K9 |
| `docs/specs/SP06-credential-sharing.md` | §2: `peer_keys` gains the four `pending_*` columns. §4: the owner's save is not gated a second time, the fan-out is best effort, and an `update` is applied on sync with no gate. §5: the `assign` scope rule (membership of an assigned role, not a role in common) and the client exclusion | k1 finding 1; K9 decisions 1/3/4; K8; k3 finding 2 |
| `docs/specs/SP07-host-deployment.md` | §2: `NOD_MIN_APP_VERSION` (compose default `0.3.0`, code default `0.0.0`, semver-validated at boot) and `NOD_UPDATE_URL` (unset by compose, `https://` required) documented; the `update.url` limit cross-referenced | H7 decision 1; o1-o2-nod finding 1 |
| `docs/arquitetura.md` | §3 `host-api.ts` description and `HOST_ROUTES`/type listing updated to block 2; new `shared/version.ts` entry. §4: `migrate`'s `user_version` comment fixed; new `backend/keys.ts`, `backend/shares.ts`, `backend/personal.ts`, `backend/guild-icon.ts` entries; `session.ts`, `vault.ts`, `repo.ts`, `host-client.ts`, `sync.ts` and `main.ts` listings updated. §5: the `settings.ts` row | s0's finding (`seal.ts`/`keys.ts` absent), plus every module the block added |
| `docs/canonico.md` | §21: a "Block 2 — mine and shared (2026-10-17)" roadmap row beside the Block 1 one, with its RF range and proof; no decision status changed, no requirement marked done | task target |
| `docs/epics/E01-connected-mode.md` | §7: the PBKDF2 cost is measured (390 ms median, `docs/tinyjs.md` §5), no longer "still to be measured" | H3 |
| `docs/epics/E02-credential-sharing.md` | §5: the reveal countdown is the shipped 10 s, no longer a proposal | K5, canonico §22 |
| `host/context.md` | Status line: **block 2 complete**; handover list gains `k8-assign.md` and `k1-k2-keys.md` | — |
| `backend/context.md` | Heading → "block 1 and block 2 landed"; the status paragraph rewritten (block 2 landed, the `share.*` events of E02 §6 included after ShareEvents landed them); `keys.ts` row documents `mine` → `MineKeys`; `main.ts` row documents `MineKeys` and `reset: true` | Main's message; ShareEvents; K10 evidence |
| `shared/context.md` | Heading → "block 1 and block 2 landed"; the block 2 paragraph rewritten (the `share.*` events included); `types.ts` row documents `MineKeys` and the four `share.*` EventType kinds | Main's message; ShareEvents |
| `src/context.md` | Heading → "block 1 and block 2 landed"; Account row documents `MineKeys` | Main's message |
| `test/context.md` | A K9 row (`test/rotation.test.ts`) added to the blocks 1–2 table | K9 |
| `docs/handovers/k10-docs.md` | This file | — |

## What was deliberately not touched

- **Other slices' handovers** — read only.
- **`docs/canonico.md` beyond §21** — no decision status moved, no RF marked done, §14/§15/§22/§23
  as they were (`AGENTS.md`: state is derived; only the owner decides).
- **`shared/host-api.ts`** — its scope comment and `HOST_ROUTES` were already corrected by K3/H7;
  this slice edits docs, not code.
- **`docs/specs/SP05` §5** (the block 1 smoke acceptance) and **`test/context.md`'s connected-smoke
  phases** — the block 2 smoke is SmokeK10's to land and describe.
- **A stale-claim sweep of the epics at large**: only the two "to come that landed" lines above were
  in scope; the milestone tables (M2/M3 in E01, M1–M3 in E02) are the plan, not a status.

## Open findings for the coordinator

1. **The `share.*` event family of E02 §6 landed after this file's first draft** (ShareEvents, while
   this slice ran): `backend/shares.ts` raises the content-free `share.sent`/`accepted`/`declined`,
   `host/repo.ts` writes `share.expired` on the purge, `host/routes/events.ts` admits the four kinds
   and `docs/handovers/share-events.md` is that slice's. Every "not built" sentence this slice had
   written for it was corrected (`backend/context.md`, `shared/context.md`); the epic/canonico lines
   ShareEvents owns were not touched.
2. **SP01 §3's `shares.scope` comment** still spells `'role' | 'blocked' | 'org'` for a column the
   host keeps on the holder rows; the code's `ShareScope` agrees, so nothing changed — noted only
   because k4's finding on the `'blocked'` union that never travels stands.
3. **`test/context.md`'s connected-smoke section** describes four phases and will need SmokeK10's
   block 2 phases added; left to that slice to avoid describing a runner mid-flight.
