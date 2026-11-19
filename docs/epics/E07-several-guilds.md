---
id: E07
frente: nod
titulo: Several guilds — a Nod that holds and enters more than one node
status: proposto
tipo: epico
origem: dono
aberta_em: 2026-11-19
depende_de: E01
---

# E07 — Several guilds

Owner, 2026-11-19:

> configure o compose para ser lançado em um servidor onde eu possa configurar a porta que ele binda,
> além do gerenciamento do lado do usuário de poder acessar mais de um nó.

The first half is done: the compose port is a deployment value — `NOD_PORT` sets the container's
`PORT`, the published host port and the `expose`, with the healthcheck reading the container's own
`PORT` back (`docs/specs/SP07-host-deployment.md` §2, `docs/canonico.md` §22 "Host bind port").
Verified by execution on 2026-11-19: `docker compose config` for both files with and without
`NOD_PORT`, and the healthcheck command probed against a live host on `:8177` (exit 0) and a dead
port (exit 1).

The second half is this epic: **a Nod that holds several guilds ("nós") and enters each without a
remove-and-rejoin.** The requirement is decided — RF-71, `docs/canonico.md` §22 "Several guilds at
once", superseding the one-guild-at-a-time half of "Guilds per install". Everything below about
*how* is a proposal waiting for the owner's reading (`AGENTS.md`); the forks of §3 are what block
code.

Evidence: `leitura` of `backend/repo.ts`, `backend/session.ts`, `backend/main.ts`, `backend/sync.ts`,
`backend/host-client.ts`, `shared/types.ts`, `src/entry.ts`, `docs/specs/SP02-auth-and-keys.md`,
SP04, SP05, and of the smoke named in §5. Nothing of the several-guilds half was executed.

## 1. What exists today (leitura)

- **One `host` row, enforced by the schema**: `host.id INTEGER PRIMARY KEY CHECK (id = 1)`
  (`backend/repo.ts`), and `saveHostRecord` replaces it whole — "adding a host over an existing one
  replaces it whole — including the snapshot and the last error, which belong to the host that is
  going away" (`backend/repo.ts`). Joining a second guild today silently drops the first.
- **The rail already carries the ground** (owner, 2026-10-17: "no futuro um offline pode acessar
  varias guilds, hoje vamos só preparar o terreno pra isso"):
  - `EntryProfiles.guilds` is an array (`shared/types.ts`), a tile's `id` is the pinned address, and
    a remembered tile of a removed guild preselects nothing (`backend/main.ts` `entryProfiles`);
  - `src/entry.ts` already draws one tile per item of `profiles.guilds` and opens a pane per tile;
  - the unlock takes the target: `session.unlock`/`unlockBiometric` answer the one
    `invalid credentials` unless the `host` row matches the tile and its person
    (`backend/session.ts` `entryAllowed`).
- **A guild account is a local person row** whose id is the host's person id, with the V2 verifier
  over that host's salt (`backend/repo.ts` `createConnectedPerson`); `person.email` is
  `UNIQUE COLLATE NOCASE` (`backend/repo.ts`).
- **What is already per guild without change**: the sealed bearer is keyed
  `nod.host.<kid>.<personId>` (`backend/host-client.ts` `hostTokenKey`) — two guilds are two kids
  and two persons, so two sealed items; the snapshot body is verified against that guild's pinned
  key and names that guild's person (`backend/connected-catalog.ts` `readBody`); the vault items,
  the E02 pair and the events hang on the person row.
- **Every reader of "the" host row can take the row of the unlocked person instead**: the row
  carries `person_id`, so while a session is unlocked as person P, "the active guild" is the row
  whose `person_id = P` — no new session state. Today's readers:
  `repo.hostRecord()` in `backend/sync.ts` (4 call sites), `backend/main.ts`'s catalog/status
  plumbing, and `entryAllowed`.
- **The outbox is not per guild**: `host_outbox` has no host column (`backend/repo.ts`), and
  `removeHost` deletes "the row and the pending writes in one transaction" (`backend/repo.ts`).

## 2. Proposal

- **`host` becomes one row per guild, keyed by `address`** (the tile id already is the address, so
  `EntryTarget` needs no change). Migration: rebuild the table without the `CHECK (id = 1)`, copy the
  one row, re-key `host_outbox` rows with their guild's address.
- **The active guild is derived, never stored**: the readers above ask for the row of the current
  person. Locked, there is no active guild — only tiles.
- **Joining a guild never drops another**: `saveHostRecord` upserts by address; the offer of local
  tools as personal tools (RF-40) runs per join.
- **The entry screen lists every guild held** — already what `src/entry.ts` draws; the Offline tile
  keeps its own account (RF-60).
- **Settings → Hosts lists every guild** with per-guild status, last sync, sync-now and remove
  (`HostState` becomes a per-guild answer; the tab lists them).
- **Sync, the admin screens, presence and shares follow the active guild**: the 5-minute timer and
  "Sync now" sync the entered guild only; the admin of two guilds edits the guild they entered.
- **Switching is the entry screen**: lock, choose the other tile. One session enters one guild at a
  time — several are *held*, one is *entered*.

## 3. Open questions for the owner (the forks)

1. **The same email in two guilds** — gates the schema, nothing builds before it is answered.
   **Answered by the owner on 2026-11-19** (this conversation): *per-guild accounts* — the same
   email may exist in two guilds, each guild keeps its own person row keyed by its host's person id,
   the one-email constraint of the local `person` table goes, and lookups resolve through the entry
   target. The rest of this item stands as the shape of (a).
2. **The Offline tile when one email is held twice** (follows from the answer above): the offline
   unlock picks the person by email; with two rows sharing it, the tile answers the one
   `invalid credentials` and the person enters through a guild tile, which names the exact row.
   (Proposed; needed by the answer above.)
3. **The vault of each guild**: each guild account derives its own `vaultKey` from its host's salt
   (SP02 §8), so the same tool credential in two guilds is saved once per guild — the same as two
   machines today. No shared vault across guilds. (Proposed; a cross-guild copy would be a new
   mechanism, out of scope.)
4. **Shares stay within one guild** (E02): a share is between two persons of one host; nothing
   crosses guilds. `peer_keys` are the host's persons. (Proposed.)
5. **`nod://join` while already in guilds**: the `+` tile's flow stays; joining a guild this Nod
   already holds answers the re-add of that same host — today's key-pinning refusal rule (RF-31)
   extends per address. (Proposed.)

## 4. What changes where (proposal, for the build)

| Piece | Change |
| --- | --- |
| `backend/repo.ts` | `host` multi-row keyed by address (schema migration, one version up); `hostRecord()` → `hostRecords()`, `hostRecordByAddress()`, `hostRecordFor(personId)`; `saveHostRecord` upserts; `removeHost(address)` drops one guild's row and outbox; outbox rows carry the address |
| `backend/session.ts` | `entryAllowed` by address; nothing else — the target already names the guild |
| `backend/main.ts` | `entryProfiles` lists all rows; the catalog, `host.state` and the admin plumbing read the row of the current person |
| `backend/sync.ts` | the row of the current person at each of the 4 `hostRecord()` sites |
| `src/settings.ts` | the Hosts tab lists every guild; per-guild status and remove |
| `shared/types.ts` | `HostState` per guild (a list in Settings); `EntryProfiles` unchanged — the array was the ground |
| `docs/specs/SP05-nod-connected.md`, SP04 | amended by the build, as SP07 was today |

## 5. Milestones and proof

| Milestone | Scope | Proof |
| --- | --- | --- |
| M1 — schema and repo | multi-row `host`, per-guild outbox, upsert by address, per-person derivation | `bun test test/ host/` with new repo tests; an existing database migrates with its one row intact |
| M2 — session and entry | tiles per guild, `entryAllowed` by address, join keeps held guilds | the unit tests of `session.test.ts`/`main` plus a second-guild case |
| M3 — sync and Hosts | active-guild sync, per-guild status/remove in Settings | the connected smoke gains a second guild: join B with A held, enter A, enter B, remove B — A still enters (RF-71's acceptance) |

The two-instance smoke of connected mode (`test/smoke/connected.ts`, 111 steps at 0.5.2,
`docs/canonico.md` §21) runs a second app id against one host; M3's second-guild steps need a
second *host* instance on another port — which `NOD_PORT` now makes a one-line launch (SP07 §2).

## 6. What does not change

- **Tenancy**: one host serves one guild (`docs/canonico.md` §22 "Host tenancy"); several nodes are
  several containers, each with its own port and volume (SP07 §2). Nothing here multiplexes a host.
- **One entered guild per session**: entering is the tile; the session is one guild at a time.
- **The offline half**: the Offline tile, the seed import and the local catalog are untouched
  (RF-60, RF-61).
- **Trust per guild**: pinning, the signed snapshot and the origin-bound vault (RF-31, RF-38, RF-42)
  are per host row exactly as today — a second row is a second pin, never a shared trust.

## 7. Built (2026-11-19)

The owner answered §3 q1 on 2026-11-19 — **one account per guild** — and asked for the build to go
ahead. What landed, against §4:

- `backend/repo.ts` — schema **`user_version = 9`**: `host` keyed by `address` with no single-row
  constraint (`rebuildHost`), `host_outbox.address` (column by presence + `backfillOutboxAddress`),
  `person.email` with no `UNIQUE` (`rebuildPerson`). `hostRecords()`, `hostRecordByAddress(address)`,
  `hostRecordForPerson(personId)`, `hostRowClaimsPerson(personId)`, `saveHost` upserting by address,
  `saveHostSnapshot(address, …)`, `saveHostError(address, …)`, `saveHostSalt(personId, …)`,
  `removeHost(address)`, `enqueueOutbox({ address, … })`, `listOutbox(address)`,
  `personsAuthByEmail(email)` and `personAuthById(id)`.
- `backend/session.ts` — `unlockCandidate(email, target)`: a guild tile resolves its row through the
  `host` row (`personAuthById`), the Offline tile accepts an email only when exactly one row holds it
  (§3 q2, as proposed — the ambiguous case answers the one `invalid credentials`). `entryAllowed`
  matches by address; `changePassword` and `enableBiometric` read the row by person id;
  `saveHostSalt` moves that person's guild only.
- `backend/sync.ts` — `activeRow()` dependency: a run syncs the guild the unlocked person's account
  belongs to; per-guild outbox; `states()` / `stateOf(address)` / `primeFingerprints()` for
  `host.list`.
- `backend/main.ts` — `activeHostRow()` behind every reader of "the host"; `entryProfiles` builds one
  tile per row; `host.activate` keeps the guilds already held (only a re-add of the same address is
  refused); `host.signIn` finds its row among the held ones; `host.remove { address }`;
  `host.list`; the bearer of every guild a person holds is sealed by `sealedExtras`.
- `backend/shares.ts`, `backend/keys.ts`, `backend/personal.ts` — the snapshot, the roster and the
  outbox of the entered guild.
- `src/settings.ts` — Settings → Hosts lists one card per guild (the entered one first, with "Sync
  now"), syncs only the entered guild, removes the one asked for, and offers "Join another guild".
- `shared/types.ts` — `host.list`, `host.remove { address, keepPersonal }`.

Proof by execution, 2026-11-19: `bun run typecheck` (app + backend + host); `bun test test/` —
**1121 pass, 0 fail**, including new cases — repo: two guilds, upsert by address, per-guild outbox,
the same email in two guilds, `hostRecordForPerson`, and a `v8 → v9` migration that keeps the one
guild, its people and its outbox; session: two guilds with one email opening their own accounts, the
ambiguous Offline unlock, and a removal leaving the other tile enterable; entry: one tile per guild
with its own account and state. `host/` suite unchanged and green (198 pass). The real-surface UI
(locked rail with two guilds) is **not** in that proof: it needs a machine with two hosts.
