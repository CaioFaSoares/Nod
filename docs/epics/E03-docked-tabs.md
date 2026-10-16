---
id: E03
frente: bond
titulo: Docked view, tabs and quick links — tools in the main window's center panel, several tabs per tool, detachable without reload, open and save any link
status: proposto
tipo: epico
origem: dono
aberta_em: 2026-10-16
bloqueada_por: B05
---

# E03 — Docked view, tabs and quick links

Owner, 2026-10-16:

> gostaria de ter a visualização central, painel que não é o lateral, sendo a visualização da aba
> aberta como opcao, e podendo desacoplar do resto do bond a aba aberta, alem de poder abrir mais de
> uma aba para navegar entre eles (digamos, ver uma tabela em um projeto ou dois chats da claude)

Proposal waiting for the owner's reading (`AGENTS.md`). Evidence: `leitura` of
`backend/tiny.d.ts`, `backend/tool-windows.ts`, the handovers and `docs/tinyjs.md`. Nothing here was
executed.

## 1. What the owner gets

- **Docked mode, the default** (owner, 2026-10-16: "padrão é docked view"). The main window keeps the
  sidebar on the left. The center panel shows the open tab instead of Home or Settings, and a **tab
  strip** across its top lists the open tabs. The intended use: work happens in tabs, and the person
  keeps switching between them, following tasks spread across different tools and managing it all
  from one place.
- **Several tabs per tool.** ⌘T or "New tab" on a tool opens another tab of the same tool: two
  Claude chats, a project table next to a board. Each tab can point at its own address or view.
- **Detach.** Any tab can come out into its own window and later dock back, **without losing
  progress**: no reload, the page keeps its state (owner, 2026-10-16: "quero que deatachar nao perca
  o progresso").
- **Quick links.** A link clicked inside a tool opens as a tab right next to it; any link can also
  be opened by hand, and any tab saved to the sidebar in one step (§5).
- Every tool in its own window stays available as the other mode (setting: **Docked**, the default,
  or **Windows**).

## 2. The constraint

A web page can't host a third-party site:

- iframes are out, because the tools send `X-Frame-Options`/CSP and the origin stamp is frame-blind
  on Linux (`docs/canonico.md` §7, `docs/tinyjs.md` §9);
- the runtime has **one webview per window** and no native tabs (`docs/tinyjs.md` §3, §10.6).

So the center panel can't *contain* the tool. It can only look as if it does: each tab is still its
own tool window, **frameless and laid exactly over the center panel**, with the tab strip drawn by
the main page above it. This is the "anchored stages" idea of v1 coming back as an option. It was
dropped in v2 after problems observed by execution: the frame was sized wrong and the launcher
ignored `x`/`size` (`docs/canonico.md` §7). Those problems decide this epic, so it starts with
spikes.

## 3. How it would work

```mermaid
flowchart TB
    subgraph Main["Main window (native frame)"]
        SB["Sidebar"]
        subgraph Center["Center panel"]
            TS["Tab strip (HTML): Claude · Claude 2 · Kanban ×"]
            SLOT["Slot rect (HTML, empty)"]
        end
    end
    TW1["tool_claude_1: frameless, no parent, placed on slot rect (shown)"]
    TW2["tool_claude_2: same rect (hidden)"]
    TW3["tool_kanban_1: same rect (hidden)"]
    SLOT -. "ResizeObserver → slot rect in screen coords → backend" .-> TW1
```

- **Tab = tool window** with id `tool_<entry>_<n>`. Today's single id per entry
  (`backend/tool-windows.ts`) becomes a list per entry. Cookies are shared app-wide
  (`docs/tinyjs.md` §3), so two Claude tabs share the same account.
- **Docked tab**: a frameless tool window **without `parent`**, placed with `x`/`y`/`size` at open
  (applied before the first paint).
  - `parent` would give native "stays above `main`, minimizes with it, moves with it on macOS", but
    it can only be set when the window opens (`backend/tiny.d.ts`, `TinyOpenWindowOptions.parent`).
    Detaching a child would mean reopening it and losing the page, so the Nod does those three
    things itself.
- **Switching tabs**: `hide({ app: false })` on the current tab, `show` on the next. The hidden page
  stays alive with its state (`docs/tinyjs.md` §3), so switching never reloads; this is the same
  mechanism RNF-09 relies on.
- **Following the main window** (done by the Nod on every OS):
  - resize: the main page watches the slot with `ResizeObserver` and sends its screen rect to the
    backend, which calls `setPosition`/`setSize` on the visible tab;
  - move: the runtime reports no move event (`onState` covers only fullscreen, maximize, minimize
    and focus — `backend/tiny.d.ts`), so the backend polls `getState()` of `main` while it's
    focused and moves the visible tab. Some lag during the drag is expected; S2 measures it;
  - stacking: when `main` gains focus, the backend re-shows the visible tab without activating it
    (`show({ activate: false })`), so it never ends up behind `main`;
  - minimize/hide: on `main`'s `minimized`/hidden state (`onState`), the docked tabs hide; they come
    back with it;
  - Wayland ignores `setPosition` (`canPosition: false`): there, docked mode isn't offered.
- **Detach — decided: no reload.** The tab stops following the slot, gets its frame back with
  `setChrome({ frame: true })`, and is placed a step off the panel. It's the same window with the
  same page, so drafts, scroll and in-page state survive.
- **Dock back**: `setChrome({ frame: false })` and snap to the slot; again the same window.
- Whether `setChrome` can toggle the frame of a live window on every OS is the first thing S1
  checks. If an OS can't, detaching there opens the tab in a window that was framed from the start
  (tabs opened framed and visually trimmed), never through a reload.
- **Keyboard**: shortcuts that work while a tool is focused stay global hotkeys registered only
  while a Nod window has focus, as today (`docs/canonico.md` §7). New: ⌘T new tab, ⌘W close tab,
  ⌃Tab next tab, ⌘⇧D detach.
- **Restore**: open tabs, their order, addresses and docked/detached state are remembered with the
  window list (`store.json`, no secrets) and reopened on the next unlock (`docs/canonico.md` §7,
  "Restauração").

## 4. Spikes first

| Spike | Question | Done when |
| --- | --- | --- |
| **S0 — fix B05** | Tool windows open with the main window's bounds; `setPosition`/`setSize` don't land (`docs/issues/B05-geometria-janelas-ferramenta.md`) | Two tools open at the requested rects; cause written in B05 |
| **S1 — frame toggle** | Frameless window + `x`/`y`/`size` lands on the slot? `setChrome({ frame: true/false })` on a live window, with page state kept? | Recorded per OS; draft text survives detach and dock |
| **S2 — follow** | Resize via `ResizeObserver` and move polling on every OS: visible gap or lag during drag/resize | Video or measured px/ms per OS; acceptable or not |
| **S3 — focus** | Clicking the tab strip in `main` must not drop the docked tab behind `main` (`show({ activate: false })` on focus) | Focus order holds on all three OSes |
| **S4 — popup adoption** (§5) | A `target=_blank` link from a chat tool and an OAuth popup, each adopted as a tab | The link opens next to its source tab; the OAuth flow completes and closes itself; on each OS |

If S1/S2 fail on an OS, docked mode is offered only where it passes, and the Windows mode stays the
default there.

## 5. Quick links

Owner, 2026-10-16: "quero também ter uma opção de abrir link no bond e/ou salvar link novo na barra
lateral mais rápido". The use he described: checking a reference a client sent in a chat, or a
documentation link on a card. In other words, **links that come out of a tool**, opened for a moment
next to the work, and sometimes kept.

This lifts a v1 non-goal: "Ser navegador: não há barra de endereço livre" (`docs/canonico.md` §2).
The Nod still isn't a browser — no history, no bookmarks bar, no extensions. Addresses outside the
catalog only open in tabs, and can become sidebar items in one step.

- **Links clicked inside a tool — the main path.** Today `"popups": "window"` turns every
  `window.open`/`target=_blank` into a real window, and `onWindowOpen` (`backend/main.ts`,
  `backend/tool-windows.ts` `onPopup`) only tracks it so the lock closes it. In docked mode the Nod
  **adopts that window as an ad-hoc tab** placed right after the tab it came from. The `open` event
  carries `opener` and the new window id (`TinyPopupEvent`, `backend/tiny.d.ts`); the Nod drops its
  frame and puts it on the slot.
  - Because it's the same window the site opened, `window.opener` still works, and OAuth-style
    popups (Discord, `docs/canonico.md` §8) finish and close themselves as before.
  - A popup the site meant to be small (a sign-in dialog) would then fill the panel. The runtime
    doesn't report the requested size, so S4 checks how the usual auth popups look as tabs. If they
    look wrong, the origins of known identity providers stay floating popups.
  - Plain links that navigate the same tab to another origin stay in that tab, as today
    (`onNavigate`).
- **Ad-hoc tabs are temporary.** They're marked "not saved". Closing one forgets it, and they are not
  restored after a lock unless saved.
- **Open link by hand**: from the palette (⌘L or ⌘K → "Open link…", paste or type) and from a deep
  link `bond://open?url=…`. The app already declares `urlScheme: bond` with single instance
  (`docs/tinyjs.md` §8), so another app or a script can hand a URL to the Nod. It opens as an
  ad-hoc tab after the current one.
- **Save to sidebar**: one button on any tab (⌘D):
  - **Same origin as a tool you already have** (for example a specific Claude chat or a project
    table): saved as a **personal view** of that tool, so it shows under the tool, not as a new icon.
  - **New origin**: saved as a **personal tool**. Title and icon come from the probe the assisted
    registration already uses (`docs/canonico.md` §8, RF-29); the person only confirms.
  - Connected mode: personal tools and views follow the person through the host
    (`docs/epics/E01-connected-mode.md` §6). Local mode: stored locally.
  - An admin can promote a personal tool to an org tool (and then grant it to roles).
- **Safety of ad-hoc tabs**:
  - the `api.origins` gate gives an unlisted origin no backend method (`docs/tinyjs.md` §9);
  - the login adapter never runs outside the origin a credential was saved for
    (`docs/epics/E01-connected-mode.md` §8);
  - only `http(s)` is accepted; anything else goes to the system browser, as navigation already does
    today.

## 6. Requirements (proposal)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| RF-49 | In docked mode, the open tab fills the center panel and follows the main window's size and position. | Resize and move `main`: the tab stays on the panel without a visible gap at rest. |
| RF-50 | A tool can have several tabs; switching tabs never reloads. | Two Claude tabs, a draft typed in one; switch away and back: the draft is still there. |
| RF-51 | A tab detaches into its own window and docks back without reloading. | Type a draft in a Claude tab, detach, move it to another screen, dock it back: the draft is still there and the page never reloaded. |
| RF-52 | Docked or Windows is a setting; Windows mode behaves exactly as today. | Switching the setting changes how the next tool opens; RF-19 still passes in Windows mode. |
| RF-55 | Any `http(s)` link opens in the Nod: links clicked inside a tool open as a tab next to it; the palette and `bond://open?url=` open one by hand. | A documentation link on a Kanban card opens as a tab right after the Kanban tab; pasting a URL in "Open link" or calling `bond://open` does the same. |
| RF-56 | Any tab is saved to the sidebar in one step: a personal view when its origin is already a tool, otherwise a personal tool with probed title and icon. | Save a Claude chat URL: it appears under Claude; save a new site: it appears as a new icon with its title and icon, no typing. |
| RF-57 | An ad-hoc tab gets no backend methods and no autofill. | Calling `tiny.api.call` from an ad-hoc origin is refused; no credential is filled there. |

## 7. Open questions

1. ~~Detach~~ — decided 2026-10-16: no reload (§3).
2. ~~Default mode~~ — decided 2026-10-16: Docked.
3. Views with `mode: window` (`docs/canonico.md` §7) open as a new tab in docked mode, and views
   with `mode: navigate` navigate the tool's current tab (proposal, following the tab-centered use).
