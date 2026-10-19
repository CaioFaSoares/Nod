---
id: E06
frente: nod
titulo: Embedded webview — real tabs for any site inside the Nod window, through a small addition carried in a tinyjs fork
status: proposto
tipo: epico
origem: dono
aberta_em: 2026-10-19
bloqueada_por: —
---

# E06 — Embedded webview

Owner, 2026-10-19:

> quero que investigue sem gerar codigo, nem publicar issues, quao complicado seria colocar isso
> dentro do tinyjs. uma possibilidade que temos é de forkar o tinyjs e adicionar só isso para uma
> versão pro nod e depois mandar de volta pro repo principal

and, the same day:

> anote tudo isso em um epico pesquisando embedded webview

This epic is the research he asked for: what it would take for the runtime to host a **webview
inside an existing window** — a real tab for any site, Claude included — and how a small fork of
tinyjs could carry that. It also records the **access revocation** research that grew out of the same
request (§8).

Evidence: `leitura` on 2026-10-19 of a shallow clone of `tarwin/tinyjsapp` at **v0.57.7** (MIT), the
repo's own docs and code, and the public docs/issues cited per paragraph. Nothing here was compiled
or run, and no issue was published. No requirements are numbered yet: it's a proposal for the
owner's reading (`AGENTS.md`).

## 1. Why

The owner wants the open tool to be a tab **inside** the Nod window, not a system-level window laid
over it. The two mechanics tried so far both fall short:

- **Iframes are refused by the sites themselves.** Claude answers `X-Frame-Options: SAMEORIGIN`, and
  any site can send the same or a `frame-ancestors` CSP. A frame also loses `SameSite=Lax|Strict`
  cookies and gets no autofill — no injected script in the frame (`docs/handovers/e03-iframe-spike.md`;
  E03 §8 recorded it, and RF-69 rests on the macOS measurement in tinyjs 0.57.2). The iframe route
  stays valid only for a frameable, first-party tool whose cookies are rewritten at the proxy.
- **A frameless OS window is still an OS window.** Docked tabs are windows the Nod keeps on the
  panel's rect; a tiling window manager re-tiles them (`docs/handovers/e03-spikes.md`, B05, measured
  with OmniWM 0.7.4). The Nod can ask the person to float its windows, but it cannot make the window
  stop being a window.

A native webview attached to the main window has neither problem: the site can't refuse it (it isn't
a frame), its cookies are the app profile's own, autofill reaches it as a normal page, and no window
manager sees it at all.

## 2. How tinyjs is built

`leitura` of the v0.57.7 clone. The runtime is deliberately small and close to the metal:

| Piece | Fact |
| --- | --- |
| Native launchers | Three single-file C++/Obj-C launchers, one per OS: `native/launcher-macos.cc` 9,495 lines, `native/launcher-win.cc` 8,746, `native/launcher-linux.cc` 7,448 |
| JS side | `runtime/bridge.js` 3,776 lines (the txiki.js backend) and `runtime/tiny.js` (the injected page object) |
| Wire protocol | Line-delimited text over a Unix socket (named pipe on Windows); `CMD@<winid>` targets a window; payloads are JSON |
| macOS window | A secondary window is an `NSWindow` with a `WKWebView` added to its `contentView` (`do_winopen`); the bridge is attached per id (`attach_tiny_bridge(cfg.userContentController, id)`), and delegates are installed by `tiny_apply_web_delegates` |
| Windows window | One WebView2 controller per HWND (`CreateCoreWebView2Controller`), sized with `put_Bounds` |
| Linux window | The main window is a `GtkBox` (menubar + webview, `gtk_box_pack_start`); secondary windows are `GtkWindow` + `WebKitWebView`, and popups use `related-view` |
| Bridge surface | About 30 window-scoped methods route through `forWin(m)`: every method that acts on a window resolves its target once and calls the per-platform implementation |
| Security core | The **origin stamp** on each `CALL` is what the `api.origins` gate trusts — the repo's `CLAUDE.md`, `TODO-site-wrapper.md` and `test/subframe-gate` are the references; the Linux stamp is frame-blind today (`docs/tinyjs.md` §9) |
| Release discipline | `TODO-verify.md` per-OS ticks, CHANGELOG + `docs/changelog.html`, config schema, a regenerated `api-map`, and CI for macOS, Windows, `linux-x86_64` and `linux-arm64` (glibc floor from `ubuntu-22.04`) |

Two consequences matter for this epic: the window model is already "one native webview per native
window", and every per-window behavior (bridge, navigation hooks, popups, focus, bounds) is already
keyed by a string id. A **view** is a natural extension of that model, not a second architecture.

## 3. The feature and what each part costs

A **view** is a webview attached to an existing window at a rectangle (x, y, width, height), with its
own id in the wire protocol. It is not a window: it has no frame, no title bar and no OS-level
identity, so a tiling WM never sees it. The main page draws the tab strip; the backend asks the
runtime for views and places them over the panel's slot, exactly where `backend/tool-windows.ts`
places docked windows today.

| Part | What it takes | Size |
| --- | --- | --- |
| **macOS** | Reuse the `WKWebView` creation path of `do_winopen`; add the view to the main window's `contentView` with an explicit frame; bridge attach, origin stamp, navigation and popup hooks keyed by the new id come almost free; the same default `WKWebsiteDataStore` means the view shares the app's cookies (the login persists across relaunch) | small |
| **Windows** | A second WebView2 controller on the same HWND, `put_Bounds` from the page rect, the same WebView2 environment; the work is focus, z-order (the controller sits above the page) and DPI/resize handling | medium |
| **Linux** | The main window's `GtkBox` becomes a `GtkOverlay`/`GtkFixed` so a `WebKitWebView` can be placed over the page; shared web context; Tauri has an open bug exactly here because a child webview becomes a separate `GtkWindow` (§4), and Wayland adds its own limits | large |
| **Bridge** | `view.create` / `view.setBounds` / `view.show` / `view.hide` / `view.destroy`; the ~30 `forWin(m)` methods plus `eval`, `onNavigate` and `onWindowOpen` accept a view id; window-only operations are refused on a view | medium |
| **Security** | The origin stamp must be per view, not per window, and the `api.origins` gate must see the view's own origin; an adversarial review on all three OSes (the Linux stamp is the weak one today) | medium |
| **Docs, CI, verification** | A new surface in `docs.html` and `tiny.d.ts`, regenerated `api-map`, CI smoke on three OSes, `TODO-verify.md` per-OS ticks, changelog | medium |

Estimate (`[INFERENCE]`, from the per-part sizes above, not measured):

- macOS only: **~3–5 days**;
- macOS + Windows: **~1.5–2 weeks**;
- all three: **~3–4+ weeks**, with Linux the long pole.

Relation to E03: the iframe embedded tab (RF-69) stays as the cheap path for frameable first-party
tools. E06 is the path that works for every site and removes the OS window entirely; if it lands,
`backend/tool-windows.ts` keeps its model — slot, polling and detach become attach, bounds updates
and detach of a view.

## 4. Prior art

- **Tauri v2 child webviews** are the closest existing design: `add_child` and
  `new Webview(…)` attach a webview to a window. In Tauri **2.12** they are still behind the
  `unstable` feature (`docs.rs/tauri` 2.12; v2.tauri.app webview reference), which says the shape is
  known but not settled.
- **Its open bugs are the warning.** `tauri-apps/tauri#15656`: on Linux/Wayland a child webview gets
  the wrong bounds because it becomes a separate `GtkWindow`. `tauri-apps/tauri#10420`: multiwebview
  positioning is broken. Both match the Linux risk in §3.
- **Upstream interest**: `tarwin/tinyjsapp#46`, where the maintainer asked whether the site should
  appear "inside your own UI, like an iframe or `<webview>`". The roadmap is the maintainer's call;
  the issue is interest, not a commitment.

## 5. What the Nod gains

- **A real tab for any site**, including Claude — no framing headers to negotiate, no proxy, no
  separate window.
- **Autofill back.** The view is a page the injected bridge reaches, so the existing login cascade
  works there; the iframe route could never do this (E03 §8).
- **No tiling WM interference.** The view is inside the window; OmniWM (or any tiler) has nothing to
  retile.
- **The existing model survives.** `backend/tool-windows.ts` keeps slot, polling and detach; they
  become attach, `setBounds` and detach of a view. Tabs per tool and switching without reload keep
  working, now without a hidden OS window per tab.

## 6. Fork risks

The owner's proposal is to fork tinyjs, add only this, ship a Nod-specific version and send it
upstream. The risks, in order:

- **Dependency on a fork until (if) it merges.** The Nod would build against a fork for as long as
  the upstream decision takes.
- **The launchers move fast.** v0.57.2 → v0.57.7 happened in two days; a fork has to be rebased
  often, and each rebase touches three large single-file launchers.
- **The Nod would ship the forked runtime.** CI already pins `TINYJS_VERSION`
  (`.github/workflows/release.yml`, v0.57.2 today); pinning a fork means owning its build and its
  signing/notarization path.
- **Upstream acceptance is uncertain.** Issue #46 shows interest; it is not a design agreement, and
  the maintainer may prefer a different model (iframe/webview in page, or nothing).

## 7. Second runtime addition worth carrying in the same fork

**Clear site data per origin.** There is no runtime API for it today (`backend/tiny.d.ts` has no
cookie or storage call), and the access-revocation work of §8 needs it.

- macOS: `WKWebsiteDataStore.removeDataOfTypes(_:modifiedSince:)` plus record matching by domain.
- Windows: WebView2 `CookieManager.DeleteCookiesWithDomainAndPath` and
  `Profile.ClearBrowsingData`.
- Linux: WebKitGTK's website data manager `remove`.

It is a small surface (one method, `siteData.clearOrigin(origin)` for example) and it rides the same
fork/release path as the view. Without it, only non-`HttpOnly` cookies and `localStorage` of the
entry origin are reachable by `eval` — which rarely ends a session.

## 8. Access revocation research

Owner, 2026-10-19:

> se eu mandasse uma credencial, ele logar, ele remove, quando ele abre dnv ele ainda ta logado.
> quero manter um controle mais fino de quem tem acesso a chaves e afins

**Today (leitura).**

- Removing a holder (`shares.removeHolder`) only sets `removed_at` on the host
  (`host/repo.ts:2516-2535`). The revoked person's next snapshot no longer lists the credential
  (`heldCredentials` filters `removed_at IS NULL`, `host/repo.ts:2499-2513`), but **nothing deletes
  their local `vault_item` or `secret`** (`backend/shares.ts`, `backend/vault.ts`). Their autofill
  keeps filling from the local copy (`backend/tool-windows.ts`).
- Removing a role or grant closes the tool's tabs at the next sync (at most `SYNC_INTERVAL_MS` = 5
  minutes, `backend/sync.ts:25`) but leaves the vault untouched.
- Revoking the person (`people.revoke`) answers `401`; the Nod drops the org half of the cache while
  the personal half stays (`backend/sync.ts:537-560`, `shared/host-merge.ts:186-208`). The vault is
  kept.
- Saving a new secret fans out `update` shares and overwrites the copy at the receiver's next sync,
  but the tool's cookie session and the old password **at the tool** stay valid.
- Cookies: one browser profile per app id (`docs/tinyjs.md` §3), and RF-03 wants sessions to survive
  a restart. No code or runtime API clears site data (`backend/tiny.d.ts`).
- Reveal and copy are **not audited**: there is no such `EventType` (`shared/types.ts:270-317`).

**Principle.** Anything the revoked person's Nod does is cooperative — a modified client can ignore
it. Only the tool's own server is a hard cut, and only if the tool offers a way to cut it.

| # | Option | What it does | Limit |
| --- | --- | --- | --- |
| 1 | **Cooperative enforcement** | Delete the received copy at the next sync; close the tabs; an optional per-entry **logout URL** the Nod opens in the background (a real server-side logout without a cookie API); an online holder check before filling a shared credential, with an owner-chosen offline grace | Works only on an unmodified Nod; the logout URL is per tool and must be catalog data |
| 2 | **Raise the bar** | A **fill-only** sharing scope (no reveal/copy for receivers; the value still reaches the page DOM); content-free reveal/copy audit events pushed to the host; "rotation pending" as a task with a link to the tool's admin | Fill-only still exposes the value to the page; audit is after the fact |
| 3 | **Local site-data clearing** | Needs §7 in the fork: clear the origin's cookies and storage on revocation | Without the runtime API, `eval` reaches only non-`HttpOnly` cookies and `localStorage`, which rarely ends a session |
| 4 | **Hard cut** | Tools authenticate through the host (OIDC/forward-auth, E01 §13 M4): disabling a person or a role cuts access at the tool's next request | Works for self-hosted tools with SSO (Planka and AFFiNE support OIDC, Jitsi JWT — to confirm in their docs), never for Claude/Discord |

**Recommended order:** (1) plus audit, then fill-only scope, then (4) for the owner's own tools, and
(3) only with the fork.

**Open questions for the owner:** should fill-only be a separate scope or the default for received
credentials; how long the offline grace is; whether the logout URL is catalog data.

## 9. Next step proposal

A **macOS-only proof in the fork**: one view over the center panel loading `claude.ai`, keeping its
login across a relaunch. That answers the only questions that can sink the idea (does a `WKWebView`
inside `contentView` behave as a page; does the bridge keyed by view id keep the origin stamp
honest; does the login stick) in days, before investing in Windows and Linux.

## 10. Open questions

1. **View model vs. tab model.** Is one view per tab enough, or should views survive their tab
   (parked hidden) as windows do today? Hidden webviews cost memory (~50 MiB per window on macOS,
   `docs/tinyjs.md` §3).
2. **Popups and OAuth.** A `target=_blank`/`window.open` from a view: open as a view next to it, or
   as a real window? E03 S4 measured the current behavior for windows, not for views.
3. **Detach.** Does detaching a view create a new native window (page reload) or reparent the
   webview? Reparenting is the hard part on every OS; a reload would break E03's "no reload" rule.
4. **Per-view zoom, find, devtools, print.** Which window-scoped features must work per view, and
   which are refused?
5. **Linux surface.** Wayland and the existing frame-blind stamp make Linux the long pole; is Linux
   in scope for the first release, or does the Nod ship macOS+Windows and keep docked windows on
   Linux?
6. **Fork shape.** A long-lived branch rebased on each release, or a minimal patch series plus a
   pinned tag? The release CI has to build and sign whatever ships.
7. **Upstream plan.** Which issue/PR carries the proposal, and does the owner want to wait for the
   maintainer's answer before shipping the fork?
8. **Revocation scope.** The four options of §8 are independent; which ones enter the same effort
   block as the view?
