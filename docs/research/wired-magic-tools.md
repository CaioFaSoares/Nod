# wired-magic-tools: future integration with Nod

Research date: 2026-11-19. **Research only; no integration decision or implementation.**

## 1. Recommendation and evidence boundary

Start, if the owner approves a PoC, with **an ordinary catalog entry for an independently deployed wired-magic control panel**, or an existing web tool reached over a separately operated mesh. Keep enrollment, routing, privileged processes, extensions and mesh administration outside Nod. Consider read-only node metadata later, only against an approved requirement and a concrete access-control contract.

This preserves the [Nod canon's thin-shell/data-not-code principles and explicit VPN/tunnel non-goal](../../docs/canonico.md#1-visão-e-princípios). Embedding the Rust agent, installing its privileged helper, or implementing a Nod plugin would cross those boundaries. Nothing in this research authorizes changing the canon.

**Methods:**

- **Execution, discovery only:** `pwd`, Git remote/HEAD/status inspection, `gh auth status`, authenticated GitHub repository search, repository/tree/commit/tag/release/license API queries, and an existing-issue search. GitHub authentication was available; no credential values are reproduced here.
- **Reading (`leitura`):** pinned upstream documentation and Rust/manifests downloaded through `gh api`, plus Nod's canon, runtime notes, backend responsibilities and vocabulary. Statements about upstream behavior below are source/documentation findings, **not runtime verification**.
- **Not executed:** `wm`, installers, hooks, enrollment, privileged authorization, network changes, builds, dependency audits, service calls against a deployed control, or Nod real-surface tests. Upstream test reports are upstream claims, not our execution proof.
- Environment discovery found `wm` on PATH at `/opt/homebrew/bin/wm`; it was **not invoked**. Its installed version, installation ownership, active profiles, daemon state and connectivity were deliberately not inspected.

## 2. Official source and reproducible snapshot

The exact-name GitHub search found the owner's public [CaioFaSoares/wired-magic-tools repository][repo]; the authenticated owner's repository list independently confirmed it. This is the investigated upstream, not a similarly named third-party product. No production endpoint was discovered or invented.

| Evidence | Observation (execution of GitHub API queries) |
| --- | --- |
| [Repository metadata][repo-api] | Public, unarchived, default branch `main`; no homepage; GitHub `license` field is null. |
| [Pinned commit][commit] | `23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8`, the observed `main` HEAD. All upstream source links below use this commit. |
| [Release v0.1.8][release] and [annotated tag object][tag-api] | Tag resolves to that commit. Published 2026-11-19; assets include macOS arm64/x86_64 archives, `SHA256SUMS` and a Homebrew formula. No Linux/Windows binary was listed in this release response. |
| [Complete recursive tree][tree-api] and [license endpoint][license-api] | No LICENSE/COPYING/NOTICE file found in the tree; license endpoint returned HTTP 404. This is a missing license-text finding, not a missing-repository finding. |

The [README][readme] describes the product as **alpha** even though GitHub marks v0.1.8 as a non-prerelease. Do not substitute that release flag for a maturity or security claim.

## 3. What upstream actually provides

| Surface | Reading evidence and limits |
| --- | --- |
| Private mesh | [Architecture][architecture]: Rust control plane, SQLite, relay/STUN, userspace WireGuard (`boringtun`), TUN/utun, UDP direct path and WSS relay fallback. Default overlay is `10.66.0.0/24`; this is not an endpoint to copy into a Nod catalog. |
| Operator interfaces | [README][readme]: CLI/TUI and an optional React control panel. [Control-panel documentation][panel] describes a separately installed, digest-approved, admin-activated package; a headless control deployment does not imply that a usable panel exists. |
| Local member GUI | [Shares documentation][shares], “GUI local”: loopback-only HTTP GUI, per-process private capability in a URL fragment, then stored in the tab session; Host/Origin checks. This is different from the remote admin panel and from the agent's Unix-socket API. Do not put its capability-bearing URL into a saved/synced catalog. |
| Read-only integration API | [Handlers][integration], [route/auth extractors][routes] and [API documentation][api]: `GET /api/v1/integration/nodes`, `/nodes/{name}`, `/health`; Bearer service token with `integration:nodes:read`. Not an admin API, share directory or SSO interface. |
| Shares/service discovery | [Shares contract][shares]: named TCP/UDP/web/game services; agents resolve `wm://name` from their map. Web shares resolve to `http://<overlay-ip>:<port>/`. **`wm://` is not registered as an OS URL scheme**, and there is no system DNS integration ([architecture][architecture]). |
| Local IPC | [Agent local API][local]: newline-delimited JSON over a Unix socket, with both reads (`status`, `peers`, `shares`, `share_resolve`) and mutations/lifecycle operations. Socket access is authority, not merely discovery permission. |
| Human identity | [Security model][security]: separate admin/user accounts, Argon2id passwords, 12-hour HttpOnly/SameSite=Lax sessions and CSRF for mutations. No supported Nod identity federation contract was established. The docs list SSO/2FA as hardening considerations, not included features. |
| Platform coverage | [README][readme]: native macOS/Linux; no native Windows client, WSL2 experimental. [macOS desktop boundary][macos] is incremental: already-enrolled root node, one approved root/UID, explicit native authorization; no guarantee of Touch ID, reboot persistence, notarization or transactional helper upgrades. |

### Exact metadata contract useful for a later PoC

The [implementation][integration] requires `integration:nodes:read` on all three routes. The list includes **active nodes only**, with optional `tag` and `online` filters. Each record contains `id`, `name`, `hostname`, `overlay_ip`, `tags`, `labels`, `online`, `last_seen`; the list also includes `server_time`. Lookup by name returns 404 for missing/inactive nodes. Health returns `ok`, `nodes_total`, `nodes_online`, `server_time`; its `nodes_total` counts all stored rows, unlike the active-only list.

`online` combines recent contact and relay presence ([architecture][architecture]); it does **not** demonstrate that a particular web tool is reachable or authenticated. A node record has no general tool URL, protocol or service-port contract. Labels are data, not executable instructions, role grants, or a trustworthy basis for arbitrary URL construction. The [Seance integration example][seance] illustrates a product-specific port label; it is not a Nod contract and must not be copied as one.

No read-only service-token share-list endpoint was found in the inspected [route definitions][routes] and [API contract][api]. Shares are exposed through node/admin/map/local surfaces with different authority. Do not acquire a node/admin token merely to fill that gap. No OpenAPI is served; the API document points to the protocol crate as the contract and records no nodes pagination ([API limits][api]).

## 4. Nod requirements and security boundaries

These are references to the existing requirements, not new requirements or claims of acceptance:

| Existing source | Integration consequence |
| --- | --- |
| [Canon §§1–2](../../docs/canonico.md#1-visão-e-princípios) | A tool is catalog data; no plugins/downloaded scripts inside Nod; VPN/tunneling remains outside v1. Existing mesh connectivity may be an external prerequisite, never a bundled second runtime. |
| [RF-01–06, RF-11, RF-34–37](../../docs/canonico.md#14-requisitos-funcionais) | Ordinary catalog/grant/sync behavior is the first seam. Discovery must not auto-publish entries or treat all mesh nodes as visible tools. |
| [Canon §8 and RF-38/RF-68](../../docs/canonico.md#8-catálogo) | Remote tools cannot gain general backend RPC, filesystem, vault or process authority. Preserve exact-origin login binding; no wildcard origin exceptions, iframe embedding, or privileged API bridge for the panel. |
| [Canon §10](../../docs/canonico.md#10-papéis-concessões-e-visibilidade) | Nod grants control visibility only; they do not configure the mesh ACL or replace service authentication. A person may still reach an allowed address outside Nod. |
| [Canon §11](../../docs/canonico.md#11-cofre-e-credenciais), [runtime state](../../docs/electrobun.md#4-state) | Current Electrobun vault values are encrypted in the local database; the key is in memory after password unlock and biometric/keychain access is off. Do not rely on historical per-secret-keychain wording. Any future service token needs an owner-approved secret-storage/lifecycle design; never plaintext in catalog, seed, preferences, issue, event or log. |
| [RF-30/RF-60; RNF-03–05/RNF-10](../../docs/canonico.md#14-requisitos-funcionais) | No automatic mesh polling in offline/local mode; no metadata transfer without explicit opt-in. Failure must not block unlock, catalog, vault or ordinary tools. HTTPS is mandatory outside loopback—even for a private WireGuard address. |
| [Runtime window/platform limits](../../docs/electrobun.md#5-windows-tabs-and-dialogs); [RNF-01/02/06/08](../../docs/canonico.md#15-requisitos-não-funcionais) | Electrobun remains the only desktop runtime; macOS docking and Windows/Linux tool-window fallback differ. Native mesh parity is absent on Windows. Measure footprint/performance before considering any helper; no unapproved dependency/build-network assumptions. Future Nod-owned UI and documentation must be English. |
| [Backend responsibilities](../../backend/context.md#what-it-owns); [canon §13](../../docs/canonico.md#13-auditoria) | Nod-owned network/secret operations belong in the backend, not the main-page frontend. Audit deliberate user actions with redacted outcomes, never bearer tokens, capability URLs, login scripts or private node state. |

The [runtime facts](../../docs/electrobun.md) supersede older tinyjs descriptions in the canon. No custom runtime capability, keychain availability or cross-platform docking is inferred from historical text.

## 5. Integration options (all proposals)

| Option | Benefit and prerequisite | Boundary/cost | Assessment |
| --- | --- | --- | --- |
| **A. Catalog the external control panel** | Owner supplies a real HTTPS endpoint; operators separately deploy/enable the optional panel. Add it through the ordinary administrator flow with suitable grants. | Separate wired-magic login/CSRF and network admin rights remain upstream. Confirm page behavior, session persistence, logout and origin restrictions on Nod's real runtime. No claim that autofill already works. | **Recommended first PoC**; potentially no Nod product-code change. |
| **B. Catalog existing HTTPS tools over external mesh connectivity** | OS mesh agent is independently installed/enrolled/operated; owner supplies exact service URLs/certificates. Nod opens tools as usual. | A connected node is not a tool; labels do not identify approved URLs. Default HTTP web-share addresses conflict with RNF-04; arrange trusted HTTPS externally or stop. Native Windows is a declared gap. | Good separation of concerns, contingent on approved HTTPS endpoints and platform policy. |
| **C. Read-only metadata client** | After a new approved requirement, Nod backend (per-person token) or a separate host-side adapter (server-held token) calls only the three integration reads. | Service token exposes mesh-wide node metadata; filters are not authorization. Decide per-guild/person visibility, explicit opt-in, secret lifecycle, limits, cache and authorization. A host adapter needs its own contract; it must not proxy arbitrary destinations. Do not overload Nod's existing signed catalog snapshot. | Later option; more scope than A/B. |
| **D. Local discovery bridge** | Backend talks to an independently authorized local IPC projection, or a tightly allowlisted CLI with fixed arguments. Could resolve shares without central admin credentials. | Existing socket has mutating authority; Unix-only permissions and the macOS root/UID helper do not constitute a supported cross-platform Nod SDK. Need an explicit read-only delegation surface, bounded messages/timeouts and proof of peer identity. Do not save private GUI capability URLs or scrape private state. | Defer until a safe contract exists; not needed for A. |
| **E. Bundle/manage agent, extensions or control** | Would offer enrollment/network management within Nod. | Privileged TUN/routes, daemon lifecycle, executable supply chain, root hooks, unsupported Windows client, footprint/release burden and conflicts with v1 scope. | **Not recommended under current canon.** Requires an explicit future scope/security decision; no implementation here. |

No option grants Nod roles equivalent wired-magic admin roles, performs automatic enrollment, installs extensions, exposes loopback ports, or turns the Nod host into a network proxy.

## 6. License, dependencies and distribution

**Declared license vs. redistribution evidence:** the [workspace manifest][cargo] declares MIT and the [README][readme] says MIT. However, the [repository metadata][repo-api] has `license: null`, the [tree][tree-api] has no license/copyright-notice file, and the [license endpoint][license-api] returned 404. This is **declared MIT with missing license-text/copyright evidence**, not a completed redistribution clearance. Request the actual license/notice before copying code or shipping binaries; confirm dependency notices independently.

- **Rust build:** [workspace manifest][cargo] version 0.1.8, edition 2024, Rust minimum 1.94. Six workspace crates cover protocol, control, core, extensions, TUI and CLI. Relevant direct dependencies include `boringtun`, `tun`, `axum`, `tokio`, `sqlx`/SQLite, `rustls`, `reqwest`, `argon2`, `ed25519-dalek` and `ratatui`. The [Cargo lockfile][cargo-lock] pins the resolved graph; manifest ranges are not a full SBOM or license audit.
- **Optional web panel:** [package manifest][web-package] specifies Node >=20.19, pnpm 10.34.9, React 19, React Query, React Router, YAML, Vite 7, TypeScript and Tailwind. A [pnpm lockfile][web-lock] exists. These are upstream build/runtime dependencies, **not dependencies to add to Nod**. The headless control does not require the panel's Node build ([panel][panel]).
- **Privileged/network prerequisites:** external agent needs TUN/routes/root; the [Coolify deployment guide][deploy] requires `/dev/net/tun` plus `NET_ADMIN` in its container, with separately configured TLS, UDP and backup. Its default bridge deployment does not automatically give the VPS or adjacent containers access to the overlay.
- **Extra executables:** [security notes][security] describe unsandboxed extension hooks; [shares documentation][shares] describes the optional `cloudflared` adapter. None is necessary for A/C. Audit any separately selected extension/helper binary and its license, provenance, version and updates; do not assume the workspace MIT declaration licenses all external artifacts.
- **Supply chain:** v0.1.8 lists archives plus checksums, not proof here of signed publisher provenance. No binary was downloaded or verified. Review release workflows, Homebrew formula, attestation/signature policy, updater behavior, SBOM and transitive licenses before redistribution. The [README][readme] documents TUI background auto-update and its opt-out; the [desktop helper document][macos] explicitly does not promise signed/notarized transactional helper upgrades.
- No `cargo deny`, `cargo audit`, `pnpm audit` or build was run. No dependency is being declared vulnerability-free or license-cleared.

## 7. Risks and proposed controls

All controls below are proposals, not evidence that the risk has been eliminated.

| Risk evidenced upstream | Proposed boundary/control |
| --- | --- |
| Empty ACL defaults to allow; shares have no independent per-share ACL ([security][security]). | Before a network PoC, require explicit restrictive source/destination/port rules and test negative paths. Nod grants never substitute for them. |
| Node `online` is presence, not app health; control is central; offline peers may retain stale policy and revocation has no global deadline ([security][security], [architecture][architecture]). | Show unavailable/stale separately from offline; test real tool reachability without claiming instant revocation. Preserve ordinary Nod offline behavior. |
| Service token reveals names/IPs/hostnames/labels; no metadata-read audit; tag filters are applied after node listing ([security][security], [integration][integration]). | Keep token backend/server-side, minimize returned fields, add explicit visibility checks, redact logs, define rotation/revocation and minimize retention. Do not expose global inventory to every guild member. |
| Default web share is HTTP; loopback exposure can widen access; optional cloudflared can publish public URLs ([shares][shares]). | No HTTP exception for overlay addresses, no auto-expose/publication, no automatic trust of `public_url` or arbitrary labels. Approve service/auth/TLS separately. |
| Local socket/API includes mutations; root hooks are unsandboxed; optional panel is trusted same-origin JS ([local][local], [security][security], [panel][panel]). | Do not load upstream code as Nod code or broaden the origin bridge. No node/admin token escalation to obtain metadata. Keep shell/scripts/root authorization out of the first PoC. |
| Imported URLs, redirects, node labels or names can be attacker-controlled data. | Explicit endpoint and port allowlists, URL parsing and bounded payloads; block unexpected redirects/credentials/schemes and arbitrary backend fetches. Validate before catalog changes; do not execute command strings. These are proposed integration controls, not verified upstream protections. |
| macOS/Linux-only native mesh; privileged helper has constrained enrollment/lifecycle ([readme][readme], [macos][macos]). | Gate optional behavior by real capability; no Windows parity promise or silent WSL fallback. Keep catalog usable without a mesh agent. |
| Missing full license text and unaudited dependency/artifact provenance (§6). | Prefer external operation over bundling; make redistribution a separate legal/supply-chain gate. |

Use disposable identities/secrets in any future PoC, with Nod runtime trace disabled. Do not run installer snippets from the README, request root, alter routing or use existing real credentials as part of this research.

## 8. Proposed PoC acceptance criteria

Owner approval of the chosen option and any new requirement is the first gate. A read-only review of this document is not approval to run a privileged test.

### Stage A — no new product code

1. Owner identifies the actual wired-magic environment, intended people/roles and one HTTPS panel or tool URL; independently confirm trusted TLS, enabled panel where applicable and non-production test accounts. No guessed hostnames or production credentials.
2. Manually register the address through Nod's normal catalog flow with a limited test grant. On the **real Electrobun app**, record build/platform, exact steps and redacted evidence of open/focus, login/session persistence, logout, navigation and failures; no iframe or origin-gate exemption.
3. Use an ungranted Nod person to check catalog/palette/restore exclusion; separately demonstrate that mesh ACL/service auth—not Nod UI visibility—controls actual network access.
4. From the tool origin attempt a harmless forbidden backend method; confirm rejection. Do not invoke destructive vault/process methods. Confirm no autofill on another origin or an ad-hoc tab; no secret in logs/events/catalog/export.
5. Stop mesh/control connectivity in an isolated, owner-authorized fixture, not an existing production daemon. Nod unlock/catalog/vault stay usable; the remote page reports failure without hanging the shell. A baseline offline/local session performs no background integration calls.
6. Exercise macOS and the Windows/Linux runtime fallback for an externally reachable HTTPS panel, or explicitly record untested platforms. A native-Windows mesh case stays unsupported, not silently passed via WSL. Record observations, not “verified” claims from source reading.
7. Remove the test catalog entry and disposable accounts/secrets. No residual helper, routes, hooks, downloads, release or canon changes.

### Stage C — only if separately approved

1. Against an isolated control with synthetic nodes, verify missing/invalid/revoked token denial; missing-scope denial with a test fixture; service token cannot access admin, enrollment authority, node shares, mutations or relay authority. Obtain only `integration:nodes:read`.
2. Compare active/pending/disabled nodes, tag/online filters, name lookup 404, exact schema and health count semantics against the pinned contract. Demonstrate that “online” is not “service ready”. Do not derive an unknown tool URL from a node name/IP.
3. Enforce explicit opt-in, target allowlist, timeouts, bounded response bytes/node counts and schema validation; test bad TLS, redirects, malformed/oversized JSON, 401/403/404/429/5xx, slow/unreachable controls and stale snapshots. Handle an unpaginated node list without unbounded memory or UI work.
4. Decide and test per-person/guild visibility before rendering any record. Global token access plus `?tag=` is insufficient authorization. No token/global inventory in the web frontend or synced catalog.
5. Proposed initial polling/cache interval: 15 seconds, subject to owner approval and load measurement, active only during an explicitly enabled connected session; bounded retry/backoff and cancellation on lock/sign-out. Keep data separate from Nod's existing host-sync contract until an approved specification exists.
6. Measure startup, idle CPU/RAM, network cadence and catalog latency against RNF targets and a no-integration baseline. Log only redacted outcome/timing/count; document token replacement/revocation and cleanup. Stop if safety, platform or license prerequisites remain unresolved.

## 9. Open questions for the owner/upstream

- Is the intended experience panel access, access to existing mesh-hosted web tools, node presence, or share discovery? Which outcome warrants an approved Nod requirement?
- Which real control/panel URLs, deployment owner, trust roots and test environment should be used? Is the optional panel actually installed and enabled?
- Which Nod people may learn which mesh nodes/hostnames/IPs? Should a future upstream service token support node/tag-scoped authorization rather than only global node-read scope?
- Does metadata belong per-person in the desktop backend or in a separately specified host adapter? Who provisions, stores, rotates and revokes its token? What happens at lock, guild change and account removal?
- Is a supported **read-only shares/discovery** API planned? Can it return explicitly approved HTTPS tool endpoints without node/admin credentials? What versioning/pagination/compatibility commitment exists?
- How will mesh identity map to catalog identity? Prefer stable node IDs over mutable names; no automatic equivalence between mesh admin, Nod admin, tags and roles.
- How will default-HTTP shares get trusted HTTPS and independent authentication? Are addresses stable across reenrollment/profile changes? Who owns ACL changes and conflict resolution with other VPN routes?
- What is the supported Windows story? Is metadata/panel-only access sufficient while native mesh is unavailable?
- What revocation delay and metadata retention are acceptable during partitions? Is read-access audit needed upstream?
- Can upstream add an actual MIT license/copyright notice and provide release provenance, dependency-license inventory and advisory policy before any redistribution?
- If a later local bridge is wanted, can upstream expose a versioned read-only capability without sharing the mutating socket or installing another privileged helper? What explicit uninstall/upgrade/reboot guarantees would be required?

## 10. Tracking and next action

[GitHub issue #82](https://github.com/CaioFaSoares/Nod/issues/82) is the place for discussion and PoC selection; this document is the evidence/options record, not a new status registry. The next action is **owner review and choice of scope**, not implementation. The canon, UI and release files were not modified by this research.

[repo]: https://github.com/CaioFaSoares/wired-magic-tools
[repo-api]: https://api.github.com/repos/CaioFaSoares/wired-magic-tools
[commit]: https://github.com/CaioFaSoares/wired-magic-tools/commit/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8
[release]: https://github.com/CaioFaSoares/wired-magic-tools/releases/tag/v0.1.8
[tag-api]: https://api.github.com/repos/CaioFaSoares/wired-magic-tools/git/tags/430d6528b88f4951438402e300d07bf80939aaff
[tree-api]: https://api.github.com/repos/CaioFaSoares/wired-magic-tools/git/trees/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8?recursive=1
[license-api]: https://api.github.com/repos/CaioFaSoares/wired-magic-tools/license
[readme]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/README.md
[architecture]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/ARCHITECTURE.md
[security]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/SECURITY.md
[api]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/API.md
[integration]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/crates/wm-control/src/api/integration.rs
[routes]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/crates/wm-control/src/api/mod.rs
[local]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/crates/wm-core/src/local.rs
[shares]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/SHARES.md
[seance]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/INTEGRATION-SEANCE.md
[macos]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/MACOS-DESKTOP.md
[panel]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/control-panel.md
[deploy]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/docs/DEPLOY-COOLIFY.md
[cargo]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/Cargo.toml
[cargo-lock]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/Cargo.lock
[web-package]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/web/package.json
[web-lock]: https://github.com/CaioFaSoares/wired-magic-tools/blob/23495c0d66ba9117e19dcd898ddf3fe4ce95d5b8/web/pnpm-lock.yaml
