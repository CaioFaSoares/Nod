# Slice E03 — iframe spike (framing, third-party storage, inject/subframe API, camera, popups, state)

Authorising decision: the owner, 2026-10-19 — "Iframe for your own tools", Claude "se possível"
(`docs/epics/E03-docked-tabs.md`; the epic's E03 tab model is a separate frameless OS window today).
This spike answers, by `execucao`, whether a *frameable* tool can live as a real `<iframe>` tab inside
the main window instead — with a persistent login, autofill and camera.

Environment: macOS 27.0.0 arm64 (Apple M4 + a second 2560×1440 display), tinyjs 0.57.2 (txiki.js
26.6.0), Bun 1.4.3, OmniWM 0.7.4 running (it tiles the app's windows; irrelevant here because every
observation is inside one window). Two regimes matter and are named per number below:

- **U** — the session was unlocked (`CGWindowList` frontmost = the spike app).
- **L** — the session was locked (`CGWindowList` carries `Display 1/2 Shield`; the app keeps running
  and rendering, but every system prompt/TCC request goes unanswered).

Nothing here touched `copland.nod*`: the spike is a throwaway app of its own id,
`copland.spike.iframe`, which was deleted at the end (§10). No credential was used, no page was
logged into, no project test suite was run.

Everything below is `execucao` on this machine unless a sentence says `leitura`.

## 1. Harness (all of it under `/tmp/`, kept for the re-run)

| Piece | What it is |
| --- | --- |
| `/tmp/nod-iframe-spike/tinyjs.json` | id `copland.spike.iframe`, `popups: "window"`, `inject: "inject.ts"`, `permissions` for camera/mic, `frontend.devUrl = http://127.0.0.1:47831`, and `api.origins` = `file://*`: all, `http://127.0.0.1:47831`: all, `http://localhost:47841`: all, `http://127.0.0.1:47842`: `["note","media.*"]`, `http://127.0.0.1:47844`: `["note"]` (**47843 deliberately absent**) |
| `/tmp/nod-iframe-spike/frontend/index.html` | the main page: a 20 pt HUD that prints the current stage (so a screenshot is self-identifying) + a `#stage` of absolutely-positioned iframes, plus the driver `window.__spike` (`mk`/`rm`/`post`/`hide`/`snapshot`/`rawcall`/`gum`/`frameInfo`) that reports every observation to the backend through `tiny.api.call('note', …)` |
| `/tmp/nod-iframe-spike/frontend/fake/frame.html` | the fixture page: sets/reads cookies (3 SameSite variants + response-header variants + `Max-Age` variants), localStorage/sessionStorage, `hasStorageAccess`/`requestStorageAccess`, `getUserMedia`, a hand-built `webkit.messageHandlers.tiny` call, `window.open`, a `target=_blank` click, `window.top.location = …`, and a 500 ms heartbeat — every result beaconed to its own server, so a third-party frame's own view is recorded even though the app page cannot read it |
| `/tmp/nod-iframe-spike/server.ts` | Bun fixtures: `:47831` the app's dev page (the shape `scripts/gen-config.ts` gives the real Nod's dev run), `:47841` **site A** on host `localhost` ("all"), `:47842` **site B** on `127.0.0.1` (`["note","media.*"]`, the shape of a seed tool origin), `:47843` **site D** (unlisted), `:47844` **site E** (`["note"]`, api yes / media no); `/deny.html` returns `X-Frame-Options: DENY`, `/csp.html` returns `Content-Security-Policy: frame-ancestors 'none'`, `/hdr` sets cookies as response headers, and every request is appended to `server.log` (the engine-side truth: the `Cookie` header actually sent) |
| `/tmp/nod-iframe-spike/backend/main.ts` | drives every phase from the backend, records into `results-<mode>-phase<N>.json` and copies `server.log` into it; also the `onNavigate`/`onWindowOpen` hooks; `SPIKE_MODE=dev|build`, `SPIKE_PHASE=1|2|3|4|5|6|8` |
| `/tmp/nod-iframe-spike/tools/{winlist2,winid,ocr,watch-shots.sh,analyze.py}` | Swift `CGWindowList` helpers (window ids), a Vision OCR of a shot, a 2 s shot watcher (`screencapture -l <windowid>` into `shots/<epochms>.png`), and the stage→OCR mapper |
| `/tmp/nod-iframe-spike-build/` | a copy of the same app whose `tinyjs.json` is the same minus `frontend.devUrl`/`dist` and minus the `http://127.0.0.1:47831` origin key, built with `tinyjs build` → `dist/Iframe Spike.app` (page served from `file://…/Contents/Resources/app/frontend/index.html`) |

Why both origins: `tinyjs.base.json` + `scripts/gen-config.ts` give the real Nod a **dev** page on
`http://127.0.0.1:5173` and a **release** page inside the built app (`file://`). The top-level origin
turns out to decide the whole storage question (§3), so every measurement was taken in both.

Commands (the exact recipe):

```sh
cd /tmp/nod-iframe-spike
bun server.ts &                                  # fixtures + the dev page
tools/watch-shots.sh Iframe 2 &                   # one window shot every 2 s
SPIKE_MODE=dev SPIKE_PHASE=1 tinyjs dev           # framing, storage, api, media, popups, keepalive
SPIKE_MODE=dev SPIKE_PHASE=4 tinyjs dev           # the subframe API path only
SPIKE_MODE=dev SPIKE_PHASE=5 tinyjs dev           # write persistent (Max-Age) cookies
SPIKE_MODE=dev SPIKE_PHASE=6 tinyjs dev           # read them after a relaunch
SPIKE_MODE=dev SPIKE_PHASE=8 tinyjs dev           # same-site vs cross-site frame, same page
cd /tmp/nod-iframe-spike-build && tinyjs build
SPIKE_MODE=build SPIKE_PHASE=3 "dist/Iframe Spike.app/Contents/MacOS/iframespike"   # framing from file://
SPIKE_MODE=build SPIKE_PHASE=1 "dist/Iframe Spike.app/Contents/MacOS/iframespike"   # everything else
SPIKE_MODE=build SPIKE_PHASE=5 … ; SPIKE_MODE=build SPIKE_PHASE=6 …                 # persistent cookies
tools/ocr shots/*.png > ocr.tsv && python3 tools/analyze.py results-<mode>-phase<N>.json ocr.tsv shots
```

The whole run of a phase is unattended: the page reports readiness, the backend runs the phase list,
writes the JSON, and quits the app (`app.quit()`).

## 2. Framing — Planka, AFFiNE and Jitsi render; Claude is refused

Protocol: one iframe at a time filling the stage, 9–11 s on screen, then probe + shot.
`load` is the `load` event of the element (`loads: 2` = the initial `about:blank` plus the target).

| Target | dev (top `http://127.0.0.1:47831`), L | built (top `file://…/index.html`), U | What the window showed (OCR of the shot) |
| --- | --- | --- | --- |
| `https://kanban.copland.studio/` (Planka) | 570 ms | 571 ms | renders — `PLANKA \| Log In \| E-mail or username \| Password \| Powered by PLANKA` |
| `https://affine.copland.studio/` | 586 ms | 507 ms | renders — `AFFiNE … Sign in to AFFiNE \| Email \| Continue with email` (a previous run showed the Demo Workspace UI instead) |
| `https://jitsi.copland.studio/` | 1000 ms | 911 ms | renders — `Jitsi Meet \| Secure and high quality meetings \| Start meeting \| Your recent list is currently empty` |
| `https://claude.ai/` | 196 ms | 201 ms | **refused** — blank (4 shots over the whole 9 s window, only the HUD is legible) |
| control `:47841/ok.html` (no headers) | 35 ms | 21 ms | renders — `fixture plain page` |
| control `:47841/deny.html` (`X-Frame-Options: DENY`) | 18 ms | 9 ms | blank |
| control `:47841/csp.html` (`frame-ancestors 'none'`) | 10 ms | 15 ms | blank |

Other runs of the same page varied with cache warmth: kanban 430–1408 ms, affine 507–1133 ms,
jitsi 737–1334 ms, claude 196–334 ms (the largest figures are the built app's first, cold run).

Claude's refusal, server side (`curl -o /dev/null -D -`, same day):

```
== https://claude.ai/
HTTP/2 403
content-security-policy: default-src 'none'; script-src 'nonce-…' 'unsafe-eval' https://challenges.cloudflare.com;
  … frame-src 'self' https://challenges.cloudflare.com blob:; child-src 'self' … ; form-action http: https:; base-uri 'self'
x-frame-options: SAMEORIGIN
```

kanban/affine/jitsi answer `HTTP/2 200` with **no** `x-frame-options` and **no**
`content-security-policy` header (re-measured; same result the owner recorded earlier). Claude answers
a Cloudflare challenge page with `X-Frame-Options: SAMEORIGIN`, so every engine refuses it.

**A probe that does NOT work** (recorded so nobody relies on it): for a *refused* frame,
`iframe.contentDocument` is not an accessible `about:blank` — WebKit loads its refusal page in the
target's origin, so `contentDocument` is `null` and `contentWindow.location.href` throws
`SecurityError`, exactly like a rendered cross-origin page. `load` also fires either way. The only
reliable discriminators here were (a) the `load` delay against a local control — a refusal is
9–18 ms, a rendered page 20–1400 ms — and (b) the screenshot OCR. The fixture beacons give a third
one for pages we control.

`onNavigate` does **not** help: no subframe navigation is reported at all (see §4).

## 3. Third-party storage — the decisive question, and it depends on the top-level origin

The fixture site A lives on `http://localhost:47841`; the app page on `http://127.0.0.1:47831` (dev)
or `file://` (built). `localhost` and `127.0.0.1` are different sites, so in dev the frame is
**third-party**; a `file://` document has no site at all.

### 3.1 Same-site vs cross-site, in the same run and the same page (dev, phase 8, L)

Two frames, each writing `c_plain` / `c_lax` (`SameSite=Lax`) / `c_none` (`SameSite=None; Secure`)
through `document.cookie` plus the same three as `Set-Cookie` response headers (`h_*`), then re-reading:

| Frame origin (top = `127.0.0.1:47831`) | `document.cookie` writes | `document.cookie` | its own `/echo` request | after a reload |
| --- | --- | --- | --- | --- |
| `http://localhost:47841` (cross-site) | all three false | `""` | no `Cookie` header | not re-read in this phase (the frame had already been replaced); the cross-site reload is `?label=A1&set=0` of §3.2 — no `Cookie` |
| `http://127.0.0.1:47842` (same-site, other port) | all three true | all six | all six | all six |

So the block is **third-party cookie blocking**, not "iframes": a same-site frame behaves like a
top-level page. Ports do not matter; the site does.

### 3.2 The cookie jar, iframe vs today's tool window

Same run as 3.1 dates, and phase 1 (dev, L). Values carry the writer's label, so every read is
attributable. What the fixture server received (`Cookie:` header of the document request):

| Request | Context | `Cookie` sent |
| --- | --- | --- |
| `?label=jar&set=1` | top-level `win.open` window (**today's tool window**) | – (empty jar) |
| `?label=A0&set=0` | **iframe**, after `jar` wrote | **none** |
| `?label=A1&set=1` | iframe, writing | none |
| `?label=A1&set=0` | iframe, reloaded read-only | **none**, although the frame itself had just written |
| `?label=jar3&set=1` | top-level window | `c_lax=jar; c_none=jar; c_plain=jar; h_lax=jar; h_none=jar; h_plain=jar` → **only the top-level writer's values**; the iframe's `…=A1` values are absent |
| `?label=jar2&set=0`, `?label=jar4&set=0` | top-level windows | `…=jar3` (the previous top-level writer) |
| `/echo` from the iframe | iframe, same-origin fetch | **no `Cookie`** |

- The frame's `document.cookie` readback was `""` at every point, and its `Set-Cookie` responses
  (`SameSite=None; Secure`, `Lax`, unset) never came back to it.
- The iframe's writes never reached the shared jar either: `jar3` carried `jar`'s values minutes
  after the iframe had written `A1`'s.
- **Persistent vs session cookies** (phases 5/6, dev, L): a `Max-Age=86400` cookie written from a
  top-level window (`pj`) survived a full relaunch (`pj3` after restart:
  `c_persist=pj; hp=pj; p_lax=pj`). A `Max-Age` cookie written from the iframe was rejected
  (`persist:false`) and after the relaunch the frame sent nothing and still read `""`.
  Session cookies (no `Max-Age`) died with the process in both contexts.

### 3.3 Storage Access API inside the frame

`document.hasStorageAccess()` → `false`; `await document.requestStorageAccess()` →
`NotAllowedError: The request is not allowed by the user agent or the platform in the current
context, possibly because the user denied permission.`; `hasStorageAccess()` after it → `false`.
Measured in dev (cross-site) and in the built app alike (2 runs each). There is no path through the
API in a bare WKWebView — Safari's prompt has no launcher delegate here.

### 3.4 localStorage / sessionStorage

- In the frame they **work** (`setItem`/`getItem`/`length` all fine, in both modes) — unlike cookies.
- They are **partitioned**: within one run, frame A1 sees keys written by frame A0
  (`lsAll = {probe-A1, ls-A1, probe-A0}`), but a top-level window of the *same origin* never sees
  them (`jar3`'s `lsAll` has `ls-jar*`/`probe-jar*` only, in both dev and built runs).
- They are **ephemeral across app launches**: after a relaunch the frame's `lsAll` holds only the
  key its current load wrote (`probe-pi2`), while top-level windows still see keys from two runs back
  (`ls-jar`, `ls-jar3`, `probe-jar2`, …).

### 3.5 The built app changes the answer (top page `file://`)

Same fixtures, app = `tinyjs build` output, top page `file://…/Resources/app/frontend/index.html`
(U):

| Request | `Cookie` sent |
| --- | --- |
| `?label=A0&set=0` (iframe, after a top-level window wrote) | `c_none=jar; c_plain=jar; h_none=jar; h_plain=jar` — **the frame gets cookies** |
| `?label=A1&set=1` (iframe writing) | `document.cookie` readback `c_none=A1; c_plain=A1; h_none=A1; h_plain=A1` (`plain:true`, `none:true`, **`lax:false`**) |
| `?label=A1&set=0` (iframe reload) | `c_none=A1; c_plain=A1; h_none=A1; h_plain=A1` — its own writes come back |
| `?label=jar3&set=1` (top-level) | the same `…=A1` values — **the iframe's writes reach the shared jar** |
| persistent cookie from the frame (`Max-Age=86400`) | `persist:true`; after a full relaunch the frame sent and read `c_persist=pi` |

So with a `file://` top page the frame is **not** treated as third-party: cookies are read, written,
shared with today's tool windows, and persistent cookies survive restarts. Two limits measured in
that regime:

- **`SameSite=Lax` cookies are dropped in the frame**: `c_lax`/`p_lax`/`h_lax` writes never took
  (`lax:false`) and a `Lax` cookie written top-level was not sent on the frame's own requests. A tool
  whose session cookie is `Lax` would therefore look logged-out inside the iframe (Django/Rails/most
  framework defaults are `Lax`).
- localStorage stays partitioned even there (`jar*` never sees `ls-A1`).

`[INFERENCE]` For the real Nod the release page is `file://` (a built app), so the built regime is
the one users would get, and `bun run dev` (`http://127.0.0.1:5173`, third-party relative to every
tool origin) is the blocked one — an iframe tab would be logged out all through development. This is
a WebKit classification detail, not a tinyjs API: it is worth re-measuring on every macOS/WebKit
major.

## 4. Inject and the subframe API

**`inject` runs in every *window*, not in any *frame*.** `inject.ts` posts to the top window and
beacons to a fixture; over the whole spike (7 app runs, all real tools + all fixtures + two controls)
the only beacons were `isTop: true` — from the dev main page, from the built main page, and from each
top-level tool window (`jar1`, `jar3`, `jar2`, `jar4`, `opened.html`, all `isTop: true`). Not one
subframe beacon, including kanban/affine/jitsi, which send no CSP that would have blocked it. Reading
agrees: the launcher injects with `WKUserScript … forMainFrameOnly:` (`strings
~/.tinyjs/native/launcher-macos`) and `~/.tinyjs/runtime/bridge.js` says subframes "never get the
shim or tiny.js".

Consequences inside a frame (`typeof` read from the frame): `tiny` → `"undefined"`, `window.__invoke`
→ absent, `window.webkit.messageHandlers.tiny` → present, `handlers` list → `[]`.

**`onNavigate` reports no subframe navigation.** In the dev phase-1 run: 28 `navigate` events, 7 with
`isMainFrame: true` (a window's own top-level policy ask), 21 with `null` (`start`/`commit`/`finish`
of those windows), **zero with `isMainFrame: false`** — while dozens of iframe loads happened. The
subframe `isMainFrame: false` branch exists in `bridge.js` (`NAVQ … main|sub`) but this launcher
never exercised it for a plain iframe load, a reload, or a `window.open`; a blocked (`XFO`/CSP) frame
produces no event either. A frame cannot be watched with `onNavigate`.

**A frame *can* reach the API on macOS — by hand-building the shim's envelope.** The page must do
`window.webkit.messageHandlers.tiny.postMessage("<numeric seq>:<json>")` (a non-numeric id is dropped;
the first attempt with `'m<ts>:'` was silently ignored, which is why the A/B below uses the shim's own
form). Phase 4:

| Caller | Origin the backend saw (`meta.origin`) | `meta.window` | Delivered |
| --- | --- | --- | --- |
| main frame, same raw `postMessage` (control) | `http://127.0.0.1:47831` | `main` | yes |
| iframe site A (`localhost:47841`, key `"all"`), method `note` | `http://localhost:47841` | `main` | **yes** |
| iframe site B (`127.0.0.1:47842`, key `["note","media.*"]`), `note` | `http://127.0.0.1:47842` | `main` | yes |
| iframe site E (`127.0.0.1:47844`, key `["note"]`), `note` | `http://127.0.0.1:47844` | `main` | yes |
| iframe site D (`127.0.0.1:47843`, **no key**) | — | — | **no** (subframe gate: an origin that no `api.origins` key names inherits nothing) |

The key-level *method* gate from a subframe is **not** in that table, deliberately: this spike's only
observable handler is `note`, and site B's key allows `note`, so a denied method would have had no
observable effect (`secrets.get` is a builtin with no side effect here — it ran or was refused
invisibly; that row would have been a guess). What *is* measured is the coarse gate: an unlisted
origin's call never arrives. The per-method half is measured for a window's own page in
`docs/handovers/e03-spikes.md` §6 ("is disabled by tinyjs.json \"api\"").

Two properties of that path: `meta.window` is the **window id** (`main`), never the frame — a handler
cannot tell which frame called except by `meta.origin`; and the frame gets **no return value** (the
launcher resolves `window.__tinyResolve` in the main frame, where that sequence is unknown), so the
call is fire-and-forget. `bridge.js` is explicit that only macOS delivers such calls at all ("Linux
drops them at the launcher (#18) and WebView2 only hands over top-level documents' messages") — those
halves were not measured here (§9).

Practical consequence for Nod: injecting a login shim or driving a tool's form through
`app.eval`/`window(id).eval` **cannot reach inside a framed tool** (both target the main frame, and no
shim is installed in the subframe). The tool would have to opt in itself with a hand-built call, and
the only per-frame control the shell has is `iframe.src`/`postMessage`.

## 5. Camera and microphone in a frame

Element attribute: `allow="camera; microphone; display-capture; fullscreen"`; call
`navigator.mediaDevices.getUserMedia` from the fixture; 5 s timeout; no prompt was ever accepted.

U regime (dev, the only run where the app's own TCC was already granted, `perm_camera: "granted"`):

| Frame origin | `api.origins` key | Result |
| --- | --- | --- |
| `localhost:47841` | `"all"` (media trust line written) | **granted, 64 ms**, `audio:MacBook Pro Microphone`, `video:MacBook Pro Camera` |
| `127.0.0.1:47842` | `["note","media.*"]` | **granted, 35 ms**, `video:MacBook Pro Camera` |
| `127.0.0.1:47843` | none | pending → timeout at 5004 ms, `Error: TIMEOUT-5s` |
| `127.0.0.1:47844` | `["note"]` (no `media.*`) | pending → timeout at 5001 ms |
| the app's own page (control) | own origin | granted, 1086 ms (first capture of the process) |

So a framed tool gets camera/mic **silently** when its origin carries `media.camera`/`media.microphone`
(the same rule the seed uses today: `["login.report","media.camera","media.microphone"]`), and an
origin without it never gets media — no dialog appeared in the window list at any point, so what the
delegate does with an untrusted origin is "never answer", not "show a prompt".

Two caveats, both measured:

- In the **L** regime every call hung, including the main page's own (runs 1 and 3): with the app's
  TCC undetermined or the session locked, the per-origin logic is not reachable at all.
- In the **built** app (`results-build-phase1.json`, U) *every* `getUserMedia` — main page included —
  stayed pending for 5 s with no dialog window on screen, while the same code under `tinyjs dev`
  granted in 35–64 ms. The built app's plist does carry the usage strings and
  `TinyjsMediaOrigins` (`camera file://`, `camera file://*`, `camera http://localhost:47841`,
  `camera http://127.0.0.1:47842` — verified with `plutil -p`). This reproduces, in a different
  form, the owner's 2026-10-16 note that the built release misbehaved on WebRTC; the release path
  needs its own test before camera in a frame is promised.

## 6. Popups, `target=_blank` and top navigation from inside the frame

`popups: "window"` throughout. From an unsandboxed frame (site A) and from a sandboxed one
(`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox
allow-downloads allow-modals"`):

| Test | Unsandboxed | Sandboxed (set above) |
| --- | --- | --- |
| `window.open(url,'_blank')` | returns a window proxy (not closed); `onWindowOpen` **policy** `{window:"popup1", opener:"main", kind:"policy", mode:"window"}`, then **open** `{window:"popup1", action:"window", kind:"open"}`; the popup *loaded the page as a top-level first-party window* (server: referer = the frame's URL, `Cookie: …=jar3`) | same (`popup2`, `opener:"main"`) |
| synthetic `a[target=_blank].click()` | no popup, no `onWindowOpen` (the click is not a user activation) | same |
| `window.top.location = "…"` | `SecurityError: The operation is insecure.` — thrown by the engine before any navigation; **no** `onNavigate` policy ask | same |

The popup arrives as an ordinary window, with `opener` = the **window** that hosts the frame (`main`),
not the frame; `app.window(id).close()` closed both (measured: `closeWin` → `windowClosed` 4 ms
later). So an OAuth-style flow started inside an iframe would open a real window — the epic's
"window" model returns for that step, and the callback has to come back into that window (or be
carried in through `window.opener.postMessage`), not into the frame.

Adding the sandbox set did not change any result above; it also did not break the fixture page
(scripts, storage and the API call all still ran), so it is a safe attribute for a tool iframe — but
it buys nothing that was measured here either (`allow-scripts allow-same-origin` together leave the
frame's own origin reachable by the frame; that is not what the sandbox is for in a cross-site
iframe).

## 7. Two iframes switched by `display:none` — the page stays alive

Fixture K1 (`hb=1`, a 500 ms `setInterval` beaconing to its own server), created, parked with
`display:none`, unparked, then left *behind* a second frame K2 (both `position:absolute; inset:0`, so
K2 paints on top — the tab-switch model):

- **No reload, ever**: `performance.timeOrigin` stayed `1792417734599` across load, the 6 s park, the
  unpark and the whole behind-K2 period; `performance.now()` kept advancing (13 → 2497 → 9875 →
  13270 → 18252 → 20912 ms). `frameInfo` shows both frames at `top:20`, same rect, both attached.
- **Timers keep running while parked**, throttled: in the L run the beacons ran at ~690 ms before
  the park and ~1000 ms while `display:none`; one earlier U run showed the exact step 500 → 1000 ms
  at the moment of the park. Either way the frame is live, not unloaded (and `rAF` is not a
  guarantee while parked — not measured).
- Nothing else is lost: localStorage/sessionStorage survived the park (in the frame's own bucket),
  and `postMessage` commands still reached the parked frame (its reads and its `getUserMedia` calls
  executed while hidden).

## 8. Verdict for E03

**Can a frameable tool be a real tab? Yes for pixels; not yet for the session or for the shell's
control of it.**

- **Rendering** (both regimes): Planka, AFFiNE and Jitsi render inside an `<iframe>` of the Nod's page
  (measured OCR text from the window shots above), with no XFO/CSP to negotiate. **Claude cannot**:
  `X-Frame-Options: SAMEORIGIN` + a CSP `frame-src 'self' …` on its challenge page, and a blank frame
  measured in dev and in the built app. No engine-side workaround exists in tinyjs.
- **Persistent login**: depends on the top-level origin, and this is the finding that decides the
  design.
  - **Built app (`file://` page)**: the frame shares the cookie jar with today's tool windows; cookies
    (including `Max-Age` ones) are written, sent and survive restarts. **Except `SameSite=Lax`**, which
    are neither written nor sent from the frame — a tool with a Lax session cookie is unusable there.
  - **`bun run dev` (`http://127.0.0.1:5173` page)**: the frame is third-party, so **no cookie is
    ever sent or stored** for it, `requestStorageAccess()` is refused, and a login inside the frame
    cannot work at all. A same-site frame works (measured), so this is the third-party rule, not
    iframes as such.
  - localStorage works in the frame but is partitioned from top-level pages *and* discarded on
    relaunch — so a tool that keeps its draft there loses it, while today's tool window keeps its.
- **Autofill / scripted login**: **impossible inside a frame** by the current mechanism. `inject` is
  installed per window main frame only (no subframe beacon in 7 runs), `tiny`/`__invoke` are absent in
  subframes, `app.eval`/`window(id).eval` reach the main frame only, and `onNavigate` does not see
  subframe loads. The frame can only *pull*: a hand-built `webkit.messageHandlers.tiny.postMessage`
  call, macOS-only, delivered only for an origin an `api.origins` key names, with `meta.window` = the
  window and no return value.
- **Camera**: works from the frame (silent, 35–64 ms) exactly when the origin has
  `media.camera`/`media.microphone` in its `api.origins` key; an origin without it never gets media.
  The built app's capture path needs its own test (all calls hung there in this run).
- **Popups / downloads / fullscreen**: `window.open` from the frame opens a real window
  (`opener` = the host window), so OAuth-style flows survive but leave the tab; `target=_blank` from a
  synthetic click opens nothing; top navigation from the frame is blocked by the engine.
- **State**: switching tabs with `display:none` keeps the page (no reload, timers throttled, state
  intact), so a tab strip is just iframes + geometry.
- **What breaks in practice** if E03 ships an iframe tab for a frameable tool: (1) it is logged out in
  dev and, in the release, logged out for any tool whose session cookie is `Lax`; (2) no autofill or
  backend-driven login in the tab; (3) the shell cannot observe or police the tool's internal
  navigation, only its initial URL; (4) OAuth still needs a real window; (5) a tool that relies on
  localStorage for drafts loses them on restart. Windows and Linux are untested and, per the
  runtime's own source, lack even the subframe API path.

## 9. Not run

- **Windows / Linux**: not measured (no machine). `~/.tinyjs/runtime/bridge.js` says subframe calls
  are macOS-only and that Linux's origin stamping is frame-blind; not exercised here.
- **Camera in a release build with the owner's real TCC**: not settled — the built app's calls hung in
  every context in this run (§5).
- **`onNavigate` for a subframe** in a launcher that does send `frame=sub` (the code path exists; this
  0.57.2 launcher never did).
- **A real tool logged into** (Planka/AFFiNE/Jitsi sessions): deliberately not attempted; all storage
  conclusions come from the fixture sites, which exercise the same engine rules with attributable
  values.
- **AutoFill** (the system password UI): a WKWebView has none, and it was not exercised.

## 10. Cleanup and re-run

Every process started for this spike was stopped (`fixtures`, the 2 s shot watcher; no `tjs`,
`launcher` or app process of id `copland.spike.iframe` left; ports 47831/47841–47844 closed), and all
of the app's data was deleted:

```sh
rm -rf ~/Library/Application\ Support/copland.spike.iframe \
       ~/Library/Caches/copland.spike.iframe \
       ~/Library/HTTPStorages/copland.spike.iframe.binarycookies \
       "$HOME/Library/WebKit/Iframe Spike" \            # dev launcher store, named after the title
       ~/Library/WebKit/copland.spike.iframe            # built app store, named after the id
```

`~/Library/Application Support/copland.nod*`, `~/Library/WebKit/Nod`, `~/Library/WebKit/copland.nod`
and `~/Library/HTTPStorages/copland.nod.binarycookies` were never written by the spike (the real Nod
was open on the machine throughout and owns those mtimes). The harness stays in
`/tmp/nod-iframe-spike/` (dev variant) and `/tmp/nod-iframe-spike-build/` (built variant, with its
`dist/Iframe Spike.app`), with every `results-*.json`, `server.log`, `*.log` and the `shots/*.png` +
`ocr-*.tsv` evidence pairs, so every number above can be re-derived with the commands of §1. The
full-screen captures taken while watching for permission dialogs were deleted.
