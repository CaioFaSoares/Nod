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

Relation to E03: E03's iframe embedded tab (RF-69/RF-70) was removed on 2026-10-22
(`docs/canonico.md` §22 "Seamless tabs: always inside, detach on demand"); the tab-inside-the-window
model holds on both runtimes, and E06 is what gives it a native view on every site instead of the
frameless OS window tinyjs uses. If it lands, `backend/tool-windows.ts` keeps its model — slot,
polling and detach become attach, bounds updates and detach of a view.

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

## 7. Clearing site data per origin (superseded on 0.58.0)

Written against 0.57.2, where no runtime call cleared cookies, so this was a second addition for the
fork. **tinyjs 0.58.0 ships `app.cookies`** (§11): `app.cookies.remove({ url })` deletes every cookie a
request to the origin would carry, HttpOnly included, on all three OSes — no fork needed for cookies.
What 0.58.0 does not cover is `localStorage`/IndexedDB of the origin (leitura of the 0.63.0
`tiny.d.ts`: `TinyCookies` only); a tool that keeps its session there still needs the native calls
(`WKWebsiteDataStore.removeDataOfTypes`, WebView2 `Profile.ClearBrowsingData`, WebKitGTK website data
manager) or an `eval` on its own origin.

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
  a restart. No code in the Nod clears site data; on 0.57.2 the runtime had no call for it, and
  0.58.0 added `app.cookies` (§7, §11).
- Reveal and copy are **not audited**: there is no such `EventType` (`shared/types.ts:270-317`).

**Principle.** Anything the revoked person's Nod does is cooperative — a modified client can ignore
it. Only the tool's own server is a hard cut, and only if the tool offers a way to cut it.

| # | Option | What it does | Limit |
| --- | --- | --- | --- |
| 1 | **Cooperative enforcement** | Delete the received copy at the next sync; close the tabs; an optional per-entry **logout URL** the Nod opens in the background (a real server-side logout without a cookie API); an online holder check before filling a shared credential, with an owner-chosen offline grace | Works only on an unmodified Nod; the logout URL is per tool and must be catalog data |
| 2 | **Raise the bar** | A **fill-only** sharing scope (no reveal/copy for receivers; the value still reaches the page DOM); content-free reveal/copy audit events pushed to the host; "rotation pending" as a task with a link to the tool's admin | Fill-only still exposes the value to the page; audit is after the fact |
| 3 | **Local cookie clearing** | `app.cookies.remove({ url })` (tinyjs 0.58.0+, §11) on revocation: the origin's cookies go, HttpOnly session cookies included | Needs the runtime upgrade from 0.57.2; `localStorage` sessions are not covered (§7); cooperative like (1) |
| 4 | **Hard cut** | Tools authenticate through the host (OIDC/forward-auth, E01 §13 M4): disabling a person or a role cuts access at the tool's next request | Works for self-hosted tools with SSO (Planka and AFFiNE support OIDC, Jitsi JWT — to confirm in their docs), never for Claude/Discord |

**Recommended order:** (1) plus audit and (3) once the Nod runs on tinyjs 0.58.0+, then fill-only
scope, then (4) for the owner's own tools.

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

## 11. What changed in tinyjs since 0.57.7 (review of 2026-10-22, leitura)

Owner, 2026-10-22: "quero que revise se algo mudou do lado do tinyjs para resolver isso. se nao, quero
começar a explorar quais possibilidade temos, e se for o caso podemos embeber alguma coisa em outro
stack miniscula só pra resolver esse problema mas fica como ponto de pesquisa".

Read: `CHANGELOG.md` of `tarwin/tinyjsapp` from 0.57.8 to **0.63.0** (latest, 2026-10-22), the
`template/types/tiny.d.ts` of that tag, and issue #46. Nothing compiled or run. The Nod still pins
`minTinyjsVersion` 0.57.2 and every spike and smoke ran on 0.57.2.

- **No embedded webview.** Issue #46 (the "inside your own UI, like an iframe or `<webview>`" thread)
  was **closed on 2026-10-20 by `app.cookies`**, not by a view. No release from 0.57.8 to 0.63.0 adds a
  view, a child webview, subframe injection or an embedded-tab primitive. Claude (XFO) and autofill
  inside a tab still need §3.
- **`app.cookies` (0.58.0, all three OSes)**: the backend reads and writes the app's single cookie
  jar, HttpOnly cookies included — `get({ url?, name?, domain?, path? })`, `set({ url | domain, name,
  value, path?, expires?, secure?, httpOnly?, sameSite? })` (`sameSite` defaults to `'lax'`),
  `remove({ name, domain, path? } | { url, name? })`. Backend only; pages get no cookie API.
- **0.63.0** carries security fixes the Nod benefits from (events to pages now pass the `"api"` gate,
  so tool pages stop hearing the main page's pushes; restrictive-looking `"api"` values are now
  restrictive; update redirects checked per hop) and the hotkey parser shared by the three launchers.
  **0.61.0** adds opt-in signed updates (`update.publicKey`, Ed25519). **0.63.0** also makes every
  `target=_blank rel=noopener` on macOS reach `onWindowOpen`, which RF-66 popup adoption relies on.

What `app.cookies` changes for the Nod (inferences, each needs an execução before it is a fact):

| Problem | Before | With `app.cookies` |
| --- | --- | --- |
| Revocation (§8 option 3) | needed the fork's site-data call | **no fork needed**: on a revoked credential or role the Nod can `remove({ url })` every cookie of the tool's origin, HttpOnly session cookies included — a local logout without a logout URL |
| Planka/AFFiNE embedded (RF-70) | a `Strict`/`Lax` login cookie is never stored by the frame | a "promote" path: the person signs in once in a **window** tab (top-level, the cookie is stored), then the Nod rewrites that tool's cookies to `sameSite: 'none', secure: true` and the embedded tab sends them. Needs a spike: whether the tool rewrites its cookie back to `Strict` on the next response, how long the promoted session lasts, and the CSRF tradeoff (a `None` cookie goes along on cross-site requests from any site) |
| Login persistence for embedded tabs in dev | third-party cookies blocked under `http://127.0.0.1` | unchanged (dev only) |
| Claude inside the window | XFO `SAMEORIGIN` refuses the frame | unchanged: no cookie helps a frame the site refuses |

Upgrade cost: moving `minTinyjsVersion` and the CI `TINYJS_VERSION` from 0.57.2 to 0.63.0 means
re-running `bun test test/ host/`, the three smokes and the RF-49…RF-70 surface checks, and reading
the 0.63.0 event-gate change against the Nod's `app.push` use (tool pages listed in `api.origins` now
need `event.<name>` to hear an event; the Nod pushes nothing a tool page should hear).

## 12. Other stacks, as a research point

Still the only path to a real in-window tab for any site (Claude included) with autofill is a native
webview attached inside the main window. Options besides the tinyjs fork (§3), by what they would
cost the Nod (leitura of public docs, 2026-10-22; nothing run):

| Option | What it is | Fit | Cost / risk |
| --- | --- | --- | --- |
| **Fork tinyjs** (§3) | add a view to the three launchers | keeps the whole Nod as is | macOS ~3–5 days, all OSes 3–4+ weeks (§3); fork upkeep |
| **Sidecar helper app** (tinyjs `executables/`) | a tiny native process (Swift on macOS) that hosts a `WKWebView` and is driven by the Nod's backend over a socket | no runtime change; the same small proof as §9 | macOS cannot put a view into **another process's** window: the sidecar owns its own window, so it is the 0.6.0 docked model again (positioning, focus, a tiling WM). Worth one probe only: a non-activating `NSPanel` (floating subrole) that tiling managers commonly leave floating — unmeasured with OmniWM. Inference, not measured: a separate app would most likely get its own cookie store, so logins would not be shared with the Nod's window tabs |
| **Backend FFI** (txiki.js) | call AppKit from the backend | none | the backend (`tjs`) and the webview launcher are separate processes linked by a socket (§2): FFI in the backend cannot reach the launcher's `NSWindow` |
| **Electrobun** | Bun-based desktop framework, system webview (WKWebView / WebView2 / WebKitGTK, optional CEF), with `<electrobun-webview>`: a separate native view kept aligned to an element of the host page, like an isolated iframe (framework.blackboard.sh/electrobun, "Electrobun Webview Tag") | the closest match to the Nod's need, and the Nod's backend is already TypeScript | a runtime switch: the backend (`backend/main.ts`, `tjs:sqlite`, `app.secrets`, hotkeys, tray, update, the `"api"` gate the Nod relies on) is rewritten against another API; reverses §22 "Runtime"; younger project; its Linux story to check |
| **Tauri v2** | `add_child` / `new Webview(…)` child webviews | real child webviews | still behind `unstable` in 2.12, open Linux/Wayland and positioning bugs (§4); Rust shell, full rewrite of the backend |
| **Electron** | `WebContentsView` | stable, the reference implementation | ~100 MB+ per install and Chromium's own profile; reverses the 6 MB premise (RNF-02) |
| **Wait upstream** | ask for a view on tinyjs | no work | the maintainer shipped #46 as cookies; a view is real per-launcher work and his call |

Cheapest next steps, in order, each one an execução that turns an inference into a fact:

1. **Spike `app.cookies` on 0.63.0** in a throwaway app (not the Nod): `remove({ url })` logs a tool
   out (revocation without the fork), and the "promote to `SameSite=None`" path keeps a Strict-cookie
   tool signed in inside an iframe in a built app.
2. **Probe a sidecar `NSPanel`** under OmniWM: does a non-activating floating panel stay out of the
   tiling? If yes, the docked model gets a WM-proof variant without touching tinyjs.
3. **macOS-only view in the fork** (§9), for Claude and autofill inside the window.

Electrobun stays a research point: worth a spike only if 1–3 fail, since it means rewriting the
backend on another runtime.

## 13. Electrobun parity target (2026-10-22)

Owner, 2026-10-22, after reading §12 and the spike:

> acredito que agora essa talvez seja uma boa escolha para evitar problemas no futuro, entao teria
> que acabar entrando agora mesmo sendo o e06, e ja evitamos mais retrabalho la na frente

and:

> orchestrate the development for a full parity in electronbun

The decision is recorded in `docs/canonico.md` §22 ("Electrobun parity build", Decidido; "Electrobun
replaces tinyjs as the shipped runtime", Proposto). This section is the target's contract; the
row-by-row proof against the tinyjs surface is `docs/handovers/e06-parity-matrix.md`.

### 13.1 Strategy: a facade, not a rewrite

The Electrobun target runs the **same Nod** on a second runtime. Nothing under `backend/`, `shared/`
or `src/` changed: `backend/main.ts` still calls `init(app)`, `app.win.open`, `app.push`,
`app.secrets`, `tjs`, `tjs:sqlite` and the hooks; the page still calls `tiny.api` / `tiny.dialog`.

| Layer | Where | What it does |
|---|---|---|
| Entry | `electrobun/bun/index.ts` | Installs the `tjs` shim, builds the bridge preload, wires the gate/RPC/downloads/update/native, calls `createApp`, then `backend.init(app)`, then opens the main window |
| `TinyApp` facade | `electrobun/bun/facade/app.ts` (composition), `windows.ts`, `native.ts`, `update.ts`, `store.ts`, `downloads.ts` | The ~60 members the backend actually uses (`e06-tinyjs-surface.md` A–E); the rest of `tiny.d.ts` is not implemented and the backend never reaches it |
| Origin gate | `electrobun/bun/facade/gate-core.ts` (pure policy) + `gate.ts` (registry) | Replaces tinyjs's `api.origins`: the runtime observes each view's committed origin (`did-commit-navigation`) and stamps `meta.window`/`meta.origin` itself; every non-main view is `sandbox: true` |
| Page bridge | `electrobun/view/bridge.ts` (main window, document-start preload), `electrobun/view/tool-bridge.ts` (sandboxed views) | Same `window.tiny` members the page already uses; a tool page gets `tiny.win.id` baked in and its `api.call` settles through `executeJavascript` |
| Native helper | `electrobun/native/NodNative.swift` → `libNodNative.dylib` (`bun:ffi`, in-process) | Keychain, LocalAuthentication, app icon, open/save panels, `setWindowFrame`, `setContentMinSize` (`docs/handovers/e06-native.md`); the view re-parent and the core's `resizeWebview`/`webviewSetHidden`/`listViews` are a second binding in `facade/native.ts` |
| Config | `scripts/gen-electrobun-config.ts` → gitignored `electrobun.config.ts` | Reads `tinyjs.base.json` + `resources/seed.json`; identifier, page views, resources, native library, update base URL, media usage strings via `scripts/eb-postwrap.ts` (patched into the wrapper) and `scripts/eb-postbuild.ts` (`scripts.postPackage`, repairs/asserts the packed payload; `bun run eb:verify`) |
| Publish | `scripts/eb-publish.ts`, `.github/workflows/electrobun.yml` | Artifact naming, sha256, merged `eb-manifest.json`, attach to an existing release (`docs/distribuicao.md` §10) |

Window policy stays where it was: `backend/tool-windows.ts` decides slot, dock/detach and tabs.
The target only makes the runtime obey — on Electrobun a docked tab is a **native `BrowserView`
laid over the main window** (`createEmbedded`), so a tiling window manager has nothing to retile;
detach re-parents the live view into a framed window and dock moves it back, with no reload
(`setChrome` → `detachTab`/`dockTab`).

### 13.2 Layout

```
electrobun/
  bun/index.ts              entry: preload, RPC, gate, downloads, update, native, backend.init
  bun/tjs-shim.ts           global tjs over Bun file APIs
  bun/sqlite-shim.ts        tjs:sqlite over bun:sqlite (aliased by the generated config)
  bun/facade/app.ts         TinyApp: paths/info/system/store/push/tray/hotkeys/quit/clipboard
  bun/facade/windows.ts     win.open/window/getState/screens, docked views, detach, hooks
  bun/facade/gate.ts        view registry, admission, host-message request/reply
  bun/facade/gate-core.ts   the pure per-view policy (main/tool/popup/link/embed)
  bun/facade/geometry.ts    page box <-> outer frame, slot rects, decorations
  bun/facade/downloads.ts   host-routed saves (~/Downloads, de-dup naming, onDownload audit)
  bun/facade/native.ts      bun:ffi client of libNodNative.dylib (degrades when absent)
  bun/facade/store.ts       JSON store at the data dir (atomic write)
  bun/facade/update.ts      eb-manifest.json check, sha256 staging, swap + rollback helper
  view/bridge.ts            window.tiny for the main window
  view/tool-bridge.ts       window.tiny for sandboxed tool/popup/link views + download capture
  shared-rpc.ts             the typed RPC schema between page and bun
  native/NodNative.swift    the helper source; build/ holds the compiled dylib
```

The generated `electrobun.config.ts` and `.hutch/` are gitignored. The tinyjs path (`tinyjs.json`,
`scripts/gen-config.ts`, `app:dev`/`app:build`) is untouched and still the default target.

### 13.3 How to run

```sh
bun run eb:dev      # build the native dylib, generate the dev config, start vite + electrobun dev
                    # identifier copland.nod.eb-dev, dev port 5173 (never touches copland.nod)
bun run eb:build    # dylib + build config + vite build + electrobun build --env=stable
                    # -> build/stable-macos-arm64/Nod.app, artifacts/*.tar.zst

bun test/smoke/run.ts       --runtime=electrobun --force
bun test/smoke/ui.ts        --runtime=electrobun --force
bun test/smoke/tabs.ts      --runtime=electrobun --force
bun test/smoke/connected.ts --runtime=electrobun --force
```

`--runtime=electrobun` (or `NOD_RUNTIME=electrobun`) selects the target; an unknown value throws, so
a typo never measures the other runtime. `NOD_APP_ID` and `NOD_DEV_PORT` isolate a launch; the
smokes use their own identifiers (`…-eb`). Results of the four runners: `docs/handovers/e06-parity-smoke.md`.

### 13.4 What it solves

- **Claude (and any XFO/CSP site) inside the Nod window.** A native view is not a frame: measured
  `https://claude.ai/` → login page rendered in-window, cookies shared with a top-level window
  (`e06-view-spike.md` §1c).
- **Autofill in the tab.** `BrowserView.executeJavascript` reaches the top frame of a sandboxed view
  (measured: filled `#user`/`#pass` and read them back), so the existing login cascade applies —
  the thing the iframe route could never do.
- **No tiling-WM interference for docked tabs.** A native docked view has no window, so a tiler
  cannot see it (`e06-view-spike.md` §1/§3). Note: the smoke's tabs round still reports a `Tool A`
  window frame — the carrier-window fallback — so the smoke has not yet exercised this branch
  (matrix §Gaps 13).
- **Detach/dock without reload.** Re-parenting keeps `performance.timeOrigin`, the typed draft, RPC
  and navigation hooks (`e06-view-spike.md` §2).
- **The backend model survives.** Slot, tab strip, popups-as-tabs, deep links, tray, hotkeys,
  updates and the audit trail are the same code, proven by the same smokes.
- **App-level hide and the real tray icon.** `main.hide()` now reaches `NSApp.hide` through the
  native helper (`facade/native.ts` `hideApp`), so focus returns to the previous app, while
  `{ app: false }` keeps the window-only hide; `sf:`/`emoji:` tray specs are drawn to an 18 pt png
  (`renderTrayIcon`) instead of being replaced by the bundled `tray.png` (leitura only — the final
  surface round is still pending).

### 13.5 Costs measured

| Metric | Value | Source |
|---|---|---|
| Built artifact (macos-arm64) | **21 MB** `.app` | `e06-surface-check.md` §11 |
| Installed bundle after an update | **68 MB** (`Contents/MacOS` 66 MB: Bun runtime + dylibs; `Resources` 2 MB) | same |
| Unpacked after first run | 67 MB (spike) | `e06-electrobun-spike.md` §3 |
| App data high-water during the spike | 150 MB (`updates/` 68 MB + `self-extraction/` 81 MB + DB ≈1.5 MB) | `e06-surface-check.md` §11 |
| RSS, main + one tool window | **≈23.3 MB** total (launcher 736 KB + bun 23,168 KB) | same |
| RSS, one window + embedded `claude.ai` view | 221 MB summed (one WebContent process per view) | `e06-electrobun-spike.md` §3 |

The size premise moved: tinyjs's ~6 MB (RNF-02) is not the Electrobun floor — the Bun runtime is
66 MB installed and every webview is its own WebKit content process. The owner's decision on the
size target is still `Proposto` in §22; the numbers above are the input for it.

Gaps by area, honestly listed (26 items): `docs/handovers/e06-parity-matrix.md` §Gaps. The headline
ones: no `Content-Disposition` navigation download, no `onNavigate` fail/crash,
no update signature (sha256 only), one unreproduced rollback no-op, guild app icon unreachable
offline, Windows/Linux never run, the product's docked-view/detach path not yet proven by a smoke,
and the final `tabs.ts` round after the `tiny.win.id` fix pending.
