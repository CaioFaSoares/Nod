# RF-58 — Online now

Owner, 2026-10-17: "quero ter algum canto para ver as pessoas online agora". Requirement RF-58 and the
"Presence" row are in `docs/canonico.md` §14 and §22. That row is `Proposto`: the design choices below
(who sees, the window, outside the snapshot) need the owner to read them.

## Files

| File | Change |
| --- | --- |
| `shared/host-api.ts` | `HOST_ROUTES.presence`, `PRESENCE_WINDOW_MS` (6 min), `PresenceEntry` |
| `host/repo.ts` | `presence(now)`: non-disabled `member`s with a live session, max `last_seen_at`, newest first |
| `host/routes/presence.ts` (new) | `GET /v1/presence` behind `personAuth`; a client gets `403`; computes `online` against the window |
| `host/app.ts` | One mount line |
| `host/presence.test.ts` (new) | 6 tests on the real app |
| `shared/types.ts` | `host.presence: [void, PresenceEntry[]]` |
| `backend/host-client.ts`, `backend/main.ts` | `presence()` call; `host.presence` RPC, unlocked; `[]` without a host |
| `src/app.ts`, `src/palette.ts`, `src/style.css` | Home "Online now" card (online with a dot; "Recently" with "last seen N min ago", cap 20; offline note when stale); refreshed on each `host` push and on opening Home, so no page timer; palette "Who's online" while connected |
| `docs/specs/SP03-host-api.md` §2, `host/context.md` | Route row; layout rows |

## Decisions taken (in the `Proposto` row)

- Online means a live session seen in the last 6 minutes. `personAuth` touches `last_seen_at` on every
  request, and the 5-min sync makes one, so there's no heartbeat and no new table.
- The route sits outside the signed snapshot. Presence would change the snapshot's `version` on every
  poll, and the `304` would never happen again (SP04 §2).
- Every member can see it. Clients can't see it and never appear in it. The response carries a name
  and an instant only.

## Evidence

- `execucao`: `bun test host/presence.test.ts` → 6 pass. `bun test test/ host/` → 772 pass, 0 fail.
- `execucao`: `bun run typecheck` reports no error in these files. The tree still had three errors
  from the KeysPinning slice's in-progress work (`keys.mine`, `peers.*`, `ensure` in
  `backend/main.ts`), which this slice didn't touch.
- **Not observed on the real surface yet.** I didn't open the card in a running Nod, because
  `backend/main.ts` was mid-edit by another slice. The two-instance smoke (K10, #38) must add a step:
  admin and P connected, each sees the other under "Online now".
