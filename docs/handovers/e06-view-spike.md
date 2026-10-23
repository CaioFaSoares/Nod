# E06 — tool as an in-window view, and detach without reload: measured spike

Throwaway spike for the owner's 2026-10-22 direction ("tudo dentro da interface + poder detach"):
every tool opens as a view inside the Nod window, any tab can be detached into its own window and
docked back. This report answers three questions with measurements, not design:

1. Can a tool be a **native view laid over a page-reported rect** inside the main window, controlled
   from the main process, several at a time, one visible, switched without reload?
2. Can that **same live WKWebView be moved** into a new framed window and back **without reloading**,
   with Electrobun's bookkeeping still working?
3. Does **focus/keyboard** work for typing inside the view while the shell keeps its shortcuts, and can
   the shell's overlays (palette/dialog) cover the view?

Tags: `leitura` = read from source; `execução` = observed on this machine. Nothing executed is
called verified.

- Spike app: `/tmp/nod-view-spike/nod-view-app`, identifier `copland.spike.view`, scheme none.
  Not in the repository, not a proposal. `copland.nod*` data and `/Applications/Nod.app` untouched.
- Host: macOS 27.0.1 arm64 (Apple M4), Bun 1.4.0 inside the app, `electrobun` 2.0.4 devkit in
  `.hutch/devkit` (the setup of `e06-electrobun-spike.md` §9, copied, not re-inited).
- Native helper: `native/ViewSpike.swift` → `build-native/libViewSpike.dylib`
  (`swiftc -O -emit-library … -framework AppKit -framework WebKit`), loaded in-process with `bun:ffi`.
- Evidence: `/tmp/nod-view-spike/evidence/run.jsonl` (240 JSONL lines from the final run),
  `dev-run1..7.log`, `dev-overlay.log`, 21 screenshots `*.png`, `analyze.py`.

## 0. What the spike app is

One `BrowserWindow` (the shell) plus, per measurement, `BrowserView`s and `<electrobun-webview>`
tags. The shell page (`views://mainview/index.html`) reports its `#stage` rect over RPC and exposes
`overlay(on)`; tool pages (`http://127.0.0.1:5289/tool?id=…`) report their own state back through an
`<img>` beacon, so a **sandboxed** view (no RPC at all) can still be read from the main process.
`bun:ffi` also binds the core dylib's internal `resizeWebview`, `webviewSetHidden`,
`getWebviewPointer` (the same dylib the devkit already loaded, so the calls hit the live table).

Two things had to be discovered the hard way and are used below:

- A main-process `BrowserView` created with a `frame` **ignores it unless `autoResize: false`**
  (measured in §1). With the default it fills the window content view.
- `NSView.frame` of a core-managed webview reads a **parked origin** (`-20000, -20000`) that does not
  reflect where it is drawn (see §5). Screenshots are the authority for placement; frames are only
  reliable for views this spike re-parents itself.

## 1. Main-process `BrowserView` vs page `<electrobun-webview>`

Both were created over the same page rect (`{x:24, y:120, width:700, height:460}`) inside the shell
window, `sandbox: true`, `renderer: "native"`.

| Control | main `BrowserView` | page `<electrobun-webview>` |
| --- | --- | --- |
| create | main: `new BrowserView({windowId, url, frame, autoResize:false, sandbox:true})` — **129 ms** from constructor to the page's load beacon (execução) | page only: `document.createElement` + append; main cannot create one. **202 ms** from the view appearing in the main process (`BrowserView.on("created")`) to its load beacon (execução) |
| frame honoured at creation | yes with `autoResize:false` (`innerWidth 700`, frame `(24,691,700,460)`, screenshot `A0-autoResize-false.png`); **no** with the default — full content view (`innerWidth 1102`, screenshot `A1-created.png`) | yes: `frame (25,121,698,458)`, `innerWidth 698` (execução) |
| move / resize later | `resizeWebview(id,x,y,w,h)` — **internal symbol**, no public `BrowserView` method (`leitura`: `core/BrowserView.ts` has no frame setter). Call cost 0.12 ms, effect visible (execução, screenshot `A1-placed.png`) | CSS only, or the same internal call; a main-side resize **sticks until the page lays out again**, then the page's rect wins (320×180 → main 200×120 → forced layout 360×220, execução) |
| show / hide | `webviewSetHidden(id,bool)` — internal symbol; 0.33–1.25 ms to observed native state, `timeOrigin` unchanged, `visibilitychange` fires (execução) | `element.toggleHidden()` (public, page) **or** the same internal call from main; both flip `isHidden`, but the element's JS `hidden` flag desyncs when main does it (execução) |
| executeJavascript on the top frame | yes (`view.executeJavascript`), filled `#user/#pass` and read them back in a sandboxed view (execução) | yes, via `BrowserView.getById(tagId).executeJavascript` once the wrapper exists (execução) |
| navigation hooks | `will-navigate` / `did-navigate` / `dom-ready`, detail = URL (`will-navigate` = JSON `{url,allowed}`) (execução) | same wrapper class with `.on` present (leitura) — not separately exercised for a tag |
| popup hook | `new-window-open` with `{url,isCmdClick,modifierFlags}`; no opener id in the payload (execução) | same wrapper (leitura) |
| destroy | `view.remove()` → `BrowserView.getById` null, `getWebviewPointer` null, view gone from the tree, window alive (execução) | `element.remove()` → wrapper gone, pointer null, tree clean (execução); main can also call the wrapper's `remove()` |
| main learns the view | it created it | `BrowserView.on("created")` fires with `{id, url, hostWebviewId, sandbox}`; main-created views do **not** fire it (execução, 1 event for the tag, 0 for the others) |
| wrapper surface | full class | same prototype: `executeJavascript`, `loadURL`, `loadHTML`, `setNavigationRules`, `setSpellCheck`, `findInPage`, devtools, page zoom, `on`, host-message queue, `remove` (execução) — no `setFrame`, no `setHidden` |

**Verdict 1a — the main-process `BrowserView` is the better base for tabs.** It is created and owned
by the main process, its geometry is main-driven (`autoResize:false` + `frame`), and every operation
the Nod needs exists — except that **move/resize and show/hide are only reachable through internal
symbols**, not through the SDK's public `BrowserView` (leitura + execução). The tag route hands
geometry to the page: its `OverlaySyncController` re-pushes the CSS rect on every layout change and
overrides a main-side resize (execução). Choose tags only if tabs must be laid out by CSS.

**Verdict 1b — several views, one visible, switching without reload works.** Three sandboxed
`BrowserView`s at the same rect (`autoResize:false`), two hidden; six switches hide-then-show:
**1–2 ms per switch**, `performance.timeOrigin` identical before/after for each view, tick counters
advanced across switches, only the active page visible (screenshot `C-switched.png`). No reload
(execução).

**Verdict 1c — claude.ai renders in-window.** `https://claude.ai/` in a sandboxed view:
`will-navigate → https://claude.ai/login`, `dom-ready`, hCaptcha sub-frames, WKWebView title
`Sign in - Claude`, full login page painted (screenshot `D-claude.png`). Cookies are shared at the
page level: a sandboxed view on `http://127.0.0.1:5289` set `spike_shared=1`, and a **top-level**
window on the same origin read `spike_shared=1` (execução). Main-process cookie *reads* did not work
here: `Session.defaultSession.cookies.get({url})` and
`Session.fromPartition("persist:default").cookies.get({url})` both returned `[]` for the local origin
and 0 for `https://claude.ai` while the pages saw the cookies (execução). The earlier spike recorded
working `Session` reads/writes (`e06-electrobun-spike.md` rows 12–13), so this is a path problem, not
proof that the jar is unreadable: the main process needs its own check before the Nod depends on
cookie reads.

## 2. Detach without reload

Electrobun has **no re-parent API** (leitura: no `setWindow`, `reparent`, `attach` symbol in
`libElectrobunCore.dylib`; only `createWebview(windowId, …)`). The spike therefore moved the live
`NSView` itself, in-process:

1. `BrowserWindow` (the detach window) is created framed and becomes key.
2. `libViewSpike.dylib` resolves the view's `NSView` from the window's live content tree (by page
   URL), calls `removeFromSuperview()`, then `contentView.addSubview(view)`, then sets
   `frame = (x, contentHeight − y − height, w, h)` (**AppKit is bottom-left**) and
   `autoresizingMask = [.width,.height]`.
3. Back = the same call with the shell window's pointer and the stage rect.

Measured (execução):

| Check | Result |
| --- | --- |
| re-parent cost | **0.54–1.84 ms** (shell → detach window), **0.87–1.11 ms** back |
| same page, no reload | `performance.timeOrigin` **identical** across the move (`1792695349986`), tick counter kept advancing, `visibilityState` `visible` |
| typed draft survival | draft text `draft written before detach typed-live` (set by JS, then extended with **real keystrokes** into the focused textarea) present after the move, plus `user`/`pass` values |
| `executeJavascript` after move | works (the read-back report was written 3 ms after the move) |
| navigation/popup hooks after move | `will-navigate`/`did-navigate` still fire for that view id |
| typed RPC for that view id | a non-sandboxed view with `rpc` answered `echo:1` before and `echo:2` **after** the move into another window; its `tool.message` reached the main process after the move |
| Electrobun's own frame setter after move | `resizeWebview(id, 20, 20, 600, 400)` re-homes the view into the new window's container and places it correctly (screenshot `E-detached-resized.png`) |
| **later reposition** | after `mainWindow.setSize(900,600)` (the **old** window relayouts), the moved view is resized to the old window's content bounds (1102×1271) and re-placed at `(0,0)` of the detached window — the tool page is stretched over the detach window (screenshot `E-detached-after-old-window-resize.png`). The **new** window's own resize does the same (1102×1271). Nothing reloads; the geometry is just wrong |

**Verdict 2 — detach without reload is possible and the transport survives; the geometry does not.**
The page keeps its state, its events and its RPC across the move, but Electrobun still treats the
view as one of the old window's views: any layout pass of either window rewrites its frame to
"fill the content view". A shipping detach therefore needs (a) the re-parent primitive in the
runtime's own layer (not a Nod dylib poking the tree), and (b) an explicit re-apply of the tab rect
after every window resize of either window — or a framework fix. This is the one real blocker found.

## 3. Focus, keyboard, overlays

- **Typing into the view**: `makeFirstResponder` on the view's `WKWebView` (what a click does) plus
  real `System Events` keystrokes → the tool page logged `h,e,l,o` keydowns, the shell page logged
  **none** (execução). With the shell's `WKWebView` focused, the shell logged `a,b,c` and the tool
  page logged none.
- **Shortcuts**: with the tool view focused, `Cmd+K` fired the **application menu** item
  (`application-menu-clicked {action:"palette"}`) *and* the focused page also saw the `k` keydown
  with `metaKey: true` (execução, 2 presses, 2 menu clicks). So app-menu accelerators keep working
  while a native view has focus; the shell page's own JS shortcuts do **not** — they must be menu
  accelerators (or a global shortcut), not page keydown handlers.
- **Overlays cannot cover a native view.** With the shell's full-window overlay (`z-index: 9999`,
  translucent + palette) shown over a visible tool view: the view stays untinted and above the
  palette (screenshot `H2-overlay-on-view-visible.png`, mean RGB of the stage area **252,252,253** —
  identical to "no overlay"). With the view hidden, the same area is tinted **174,175,181** and the
  palette is fully visible (`H2-overlay-on-view-hidden.png`). The recipe is: **hide the view while
  an overlay is open.**
- **Hide/show cost**: 0.33–1.25 ms from call to observed native state (6 timed rounds in A, plus the
  overlay hide/show), no reload — `performance.timeOrigin` unchanged and the tick counter keeps
  advancing, `visibilitychange` fires (execução). Cheap enough to hide on palette open and show on
  close.

## 4. The exact recipe

1. **One** `BrowserWindow` for the Nod shell, page = the shell bundle (`views://`, RPC + tag
   support). Every tool is a `BrowserView` in that window — no per-tool window/dock setting.
2. Create each tool with
   `new BrowserView({ windowId: shell.id, url, frame: <page rect>, renderer: "native", sandbox: true, autoResize: false })`.
   `autoResize: false` is mandatory; the rect is page top-left coordinates.
   The shell reports the rect (`getBoundingClientRect`) over RPC on resize/tab change.
3. Move/resize after creation with the core's `resizeWebview(id, x, y, w, h, masks)` (internal
   symbol today; the SDK needs a `BrowserView.setFrame` for this to be shippable).
4. Show/hide with `webviewSetHidden(id, bool)` (internal symbol today; the SDK needs
   `BrowserView.setHidden`). Only one tab visible at a time; switch = hide previous + show next.
5. Autofill/login with `view.executeJavascript(js)` on the top frame (works in `sandbox: true`).
   Read results back through a page beacon or a per-view RPC channel.
6. Hooks per view: `will-navigate`, `did-navigate`, `dom-ready`, `new-window-open` (no opener id —
   identify by which view fired).
7. Overlay open → hide the active view; overlay close → show it. Do not rely on z-index.
8. Detach: create a framed `BrowserWindow`, then re-parent the live `NSView` into its content view
   with a bottom-left frame; re-apply the tab rect with `resizeWebview` after any resize of either
   window (today's framework resets it). Dock back with the same two steps.
9. Destroy with `view.remove()` (page tags: `element.remove()`).

## 5. Not measured / caveats

- **Window framing could not be measured on this machine**: every `BrowserWindow` was forced to the
  full display size (content 1102×1271) regardless of the requested frame; `window.resize` reported
  the request and then the forced size. Detached-window sizing (720×520) is therefore a request, not
  an observed result; the view-level geometry is what the numbers above describe.
- `NSView.frame` for core-managed webviews reports a parked origin (`-20000,-20000`) that does not
  match the painted position; only screenshots and page-reported `innerWidth/Height` are used for
  placement claims. Views the spike re-parents itself do report literal frames.
- `click at` through System Events failed (`-25200`) because windows sit off the visible desktop
  here; keyboard tests used `makeFirstResponder` + `keystroke`, which is what a click does.
- How an `autoResize: false` view behaves when **its own** window resizes was not measured
  separately; the detach run shows a window relayout can rewrite a view's frame to the content
  bounds, so re-applying the tab rect on shell resize is the safe rule until that is measured.
- Masks (`masks` argument of `resizeWebview`, rounded corners) and `transparent`/`passthrough` were
  not exercised.
- Cookie isolation per `partition` was not measured; main-process cookie reads returned nothing (§1c).
- One machine, one display, macOS only. Windows/Linux untouched.
- Memory/CPU of N views was not measured (the earlier spike already recorded one WebContent process
  per webview, `e06-electrobun-spike.md` §3).

## 6. Reproduce

```sh
cd /tmp/nod-view-spike/nod-view-app
swiftc -O -emit-library -o build-native/libViewSpike.dylib native/ViewSpike.swift \
  -framework AppKit -framework WebKit
npx electrobun dev --env=dev            # full harness, ~30–40 s, self-quits, writes evidence/
# overlay-only demo (config entrypoint swapped to src/bun/overlay.ts):
#   npx electrobun dev --env=dev        → H2-*.png
python3 /tmp/nod-view-spike/analyze.py  # screenshot means + step list
```

`evidence/run.jsonl` holds one line per step (`A.*` main-process view, `B.*` tag, `C.*` switching,
`D.*` claude/cookies, `E.*` detach, `F.*` RPC, `G.*` focus, `H.*` overlay); screenshots:
`A0-autoResize-false`, `A1-created`, `A1-placed`, `B-tag-created`, `C-switched`, `D-claude`,
`E-detached`, `E-detached-resized`, `E-detached-after-old-window-resize`, `E-returned`,
`H2-baseline-view-visible`, `H2-overlay-on-view-visible`, `H2-overlay-on-view-hidden`,
`H2-overlay-on-view-shown`, `H2-overlay-off`.
