---
id: B05
frente: nod
titulo: janelas de ferramenta abrem com o tamanho e a posição da janela principal
status: aberta
tipo: bug
origem: derivado
bloqueada_por: —
destino: —
aberta_em: 2026-10-16
---

`docs/arquitetura.md` §4 (`backend/tool-windows.ts`) pede 1280×800 limitado a 90% da área útil da tela
da janela `main`, em cascata (+28 px), aplicando `setPosition`/`setSize` no handle logo depois do
`win.open`.

Observado por execução (2026-10-16, instância de captura com `copland.nod.ui`, bounds lidos
por `CGWindowListCopyWindowInfo`): `Nod`, `Kanban` e `Affine` com bounds idênticos —
`X 4853, Y -1350, 1235×1312` (segunda tela). As ferramentas funcionam, mas abrem exatamente por cima
da janela principal.

Causa não fechada. Próximo passo: trace com `TINYJS_DEBUG=1` **sem credenciais salvas** (o trace imprime
o EVAL do adaptador — `AGENTS.md`), conferindo se os comandos `SIZE`/`WINOP pos` saem para as janelas
`tool_*` e com quais valores.

## 2026-10-19 — cause closed by `execucao`: a window manager overrides the geometry

Written from `execucao` (spikes S0/S1/S2/S7 of `docs/epics/E03-docked-tabs.md` §4; the full handover is
`docs/handovers/e03-spikes.md`). Method: a throwaway app outside the repository,
`/tmp/nod-e03-spike/`, id `copland.spike.e03` (the repo's `tinyjs.json`, `.build/` and the
`copland.nod*` data were never touched), tinyjs 0.57.2 (txiki.js 26.6.0) on macOS 27.0.0 arm64, one
display 2294×1490 (usable area 2294×1382 at y=49); real windows read with
`CGWindowListCopyWindowInfo` (Swift helper) and the window manager with `omniwmctl`.

**The Nod's code is not the cause.** Every command this file assumed lost does arrive and hold:

- `app.win.open(id, { page, title, x, y, size })` places the window exactly at the requested rect —
  the `getState()` right after returns identical `x/y/width/height` (read at +39 ms; `open` itself
  returns in ≤1 ms), on a `file://` page and on an `http` page, framed and frameless, and while the
  page is still loading.
- `app.window(id).setPosition(...)` + `.setSize(...)` in the same tick as `open` hold: exact readback
  at +4.8 ms, the two calls costing 0.13–0.36 ms; after the load they hold too; with
  `chrome: {frame:false}` `outer` equals the page box, as the runtime promises.
- `app.win.open` with no geometry at all does **not** fall back to the main window's bounds: tinyjs
  uses its default 600×400 page at its default position (measured `847,287 600×400`). So a
  `geometry()` returning `null` does not explain the main window's bounds.
- `app.win.open` with exactly this file's numbers (`main.x+28`, `main.y+28`, 1280×800 capped at 90 % of
  the usable area) opens at `625,235 1280×800`, exact at once and 300 ms later.

**The cause is OmniWM, this machine's tiling window manager.** It is running
(`/Applications/Nix Apps/OmniWM.app`, 0.7.4, config in `~/.config/omniwm/settings.toml`) and it
manages **every** window of the app:

```
$ omniwmctl query windows --app "E03 Spike" --fields title,frame,mode,layout-reason,is-visible --format json
… every window: "mode": "tiling", "layoutReason": "standard",
   and every one of them with the SAME frame 1102×1303 at x=0,y=97 when queried …
```

That is literally the reported symptom: `Nod`, `Kanban` and `Affine` with identical bounds — the tile
the manager hands out, not the position the Nod asked for. In an active session (`execucao`,
2026-10-19, spike S0) the requested rect holds for the first ~62 ms and the manager re-hands the
window to its own tile **within ≲200 ms** (the same window read as 80,129 640×440 at +62 ms and as
1102×1271 at +738 ms; S1's overlay read 637,299 500×340 at +200 ms and 1160,90 1102×1303 later). With
the manager inert (locked session, same spikes) every requested rect landed and held — including
through new-window creation (60 samples over 1.6 s, always exactly 100,500 560×380).

A side finding that breaks any future check: **under an external manager, `getState()` is no longer
the on-screen truth.** In the run with the manager inert the same window answered
`120,160 560×380` from `getState()` and `222,218 505×372` from `CGWindowList`, and two consecutive
`setPosition`/`setSize` did not move the real frame. Anything verifying geometry has to read the real
frame (the manager, or `CGWindowList`), never `getState()`.

**What works (`execucao`).** Outside a manager that is managing the app, the recipe this file already
describes — `x`/`y`/`size` at `open` plus `setPosition`/`setSize` right after — is exact and stable,
and **nothing needs to change in `backend/tool-windows.ts`**; tracing `SIZE`/`WINOP pos` is no longer
the next step. While OmniWM is handling the app's windows no `setPosition` from the Nod wins: the lever
is the manager's side — float the app's windows (in OmniWM:
`omniwmctl command toggle-focused-window-floating`, or an app rule in
`~/.config/omniwm/settings.toml`). That was **not** executed: it would change the owner's environment
configuration. For E03 the safe path is to detect the case (a coarse probe: `setPosition` does not move
the real frame) and not offer docked mode where it cannot hold — the same rule the epic already
provides for an OS where S1/S2 fail; there, Windows mode.
