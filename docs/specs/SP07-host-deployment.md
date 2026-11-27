# SP07 — Host deployment

Why: `docs/epics/E01-connected-mode.md` §10. One compose on the owner's Coolify, one service, one
volume. No address is named here (`AGENTS.md`); the owner sets it in Coolify.

## 1. Image

`host/Dockerfile` (built from the repo root, because `shared/` is imported by both sides):

```dockerfile
FROM oven/bun:1.4.3 AS deps
WORKDIR /app/host
COPY host/package.json host/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3-slim
WORKDIR /app
COPY --from=deps /app/host/node_modules ./host/node_modules
COPY shared ./shared
COPY host ./host
ENV NODE_ENV=production NOD_DATA=/data PORT=8080
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080
CMD ["bun", "host/main.ts"]
```

- The install happens **inside `host/`**, from `host/bun.lock` — not through a workspace filter. The
  root `package.json` declares no `workspaces`, so `bun install --filter ./host` at the root matches
  no package and installs nothing (`docs/handovers/h1.md`, measured). The property this bullet keeps
  is the one that matters: `host/package.json` holds only the host's dependency, so the Nod app's
  dependencies never enter the image. A filtered root install would need the root `package.json` to
  declare `"workspaces": ["host"]` and one root lockfile — a decision for that file's owner.
- The Bun version is pinned to the one the repo pins (`.github/workflows/release.yml`), and Elysia to
  the exact beta in `host/bun.lock` (E01 §11). Both `oven/bun:1.4.3` and `oven/bun:1.4.3-slim` exist
  (`docker manifest inspect`, `docs/handovers/h1.md`).
- `/data` is created and owned by `bun`, the unprivileged user the container runs as: it writes
  `host.db`, the key files and `backups/` there (SP01 §1, §4).
- The image's `PORT=8080` is the container's *default*: the compose files pass
  `${NOD_PORT:-8080}` over it, and `host/config.ts` reads whatever `PORT` it is given (§2).

## 2. Compose

`host/compose.yaml`:

```yaml
services:
  host:
    build:
      context: ..
      dockerfile: host/Dockerfile
    environment:
      NOD_PUBLIC_URL: ${NOD_PUBLIC_URL}        # https address Coolify exposes; used in discovery and links
      NOD_GUILD_NAME: ${NOD_GUILD_NAME}
      NOD_MIN_APP_VERSION: ${NOD_MIN_APP_VERSION:-0.3.0}
      NOD_BACKUP_EVERY_HOURS: ${NOD_BACKUP_EVERY_HOURS:-24}
      NOD_BACKUP_KEEP: ${NOD_BACKUP_KEEP:-14}
      PORT: ${NOD_PORT:-8080}                  # the port the process binds and the one published
    ports:
      - "${NOD_BIND:-127.0.0.1}:${NOD_PORT:-8080}:${NOD_PORT:-8080}"
    volumes:
      - nod-data:/data
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? '8080') + '/health').then(r => process.exit(r.ok ? 0 : 1))"]
      interval: 30s
    restart: unless-stopped
volumes:
  nod-data:
```

- One replica only: SQLite has a single writer (SP01).
- TLS ends at Coolify's proxy; the container serves plain HTTP on `NOD_PORT` (8080 by default)
  inside its network.
- **The bind port is a deployment value** (owner, 2026-11-19: "configure o compose para ser lançado
  em um servidor onde eu possa configurar a porta que ele binda"). `NOD_PORT` sets the port the
  process binds (`host/config.ts` reads `PORT`, default `DEFAULT_PORT` 8080), the port published on
  the host (`compose.yaml`) and the `expose` of `compose.coolify.yaml`; the healthcheck reads the
  container's own `PORT` back, so it follows whichever value a deploy gives — nothing stays pinned
  to 8080. `NOD_BIND` picks the interface of the published port: loopback by default,
  `0.0.0.0` where the proxy lives outside the compose network.
- The host refuses to start when `NOD_PUBLIC_URL` isn't `https://`, except in dev.
- `GET /.well-known/nod` serves `guild` = `NOD_GUILD_NAME` (may be empty when the deployment
  leaves it unset) and `minAppVersion`; `GET /v1/meta/app` (SP03 §3) serves the same `minAppVersion`
  plus `update.url`. Both values come from the environment, read once at boot (`host/config.ts`,
  `loadAppMeta`), so the two documents cannot disagree.
  - `NOD_MIN_APP_VERSION`: the compose file passes `${NOD_MIN_APP_VERSION:-0.3.0}`, so a deployment
    through it serves `0.3.0` unless overridden; the code's own default when the variable is unset is
    `0.0.0` ("older than every Nod", `DEFAULT_MIN_APP_VERSION`). The two disagree only because the
    compose variable is always set (packaging's and this spec's to settle,
    `docs/handovers/h7-o1-o2-host.md` decision 1). The boot refuses a value that is not a semver
    (`invalid NOD_MIN_APP_VERSION: …`, one line, exit 1).
  - `NOD_UPDATE_URL`: neither compose file sets it, so `update` is `null`; when set it must be an
    `https://` address or the boot refuses it (`NOD_UPDATE_URL must be https://: …`, exit 1). It is
    served for the deployment's tooling, not fetched by the running Nod (SP03 §3, O2's limit).
  - `meta.guild_name` (SP01 §2) still has no writer; the moment boot writes that row the route should
    read it instead (h6).

## 3. Commands

| Command | What |
| --- | --- |
| `bun run setup-code` (in the container) | Prints a setup code (SP02 §3) to the terminal only; refuses if an admin exists |
| `bun run backup-now` | Runs §4 once |
| `bun run restore <file>` | Refuses a target data dir that already holds anything (the acceptance is a fresh volume), checks `PRAGMA integrity_check` on the file, copies it and the backup's key files in, restarts (h9) |

They're scripts in `host/package.json`, run through Coolify's terminal.

## 4. Backup

- Every `NOD_BACKUP_EVERY_HOURS`: `VACUUM INTO '/data/backups/host-<ISO>.db'`.
- Keep the newest `NOD_BACKUP_KEEP` files.
- The key files (`signing-key.json`, `host-secret`) are copied beside each backup under the backup's
  own timestamp stem: `<host-<ISO>>.signing-key.json` and `<host-<ISO>>.host-secret`, so a pass never
  overwrites another's pair and rotation removes the triple together; `restore <file>` finds them
  from the file name (h9). A restore without them makes every pinned Nod refuse the host (SP04 §1).
- Copying off the VPS is the owner's choice (E01 question 7); until then, Coolify's volume backup or
  a manual copy.

## 5. Deploy on Coolify, and the acceptance of H9

### 5.1 First deploy

Coolify builds the compose from the repository. The address is set in Coolify's environment and never
written into a file (`AGENTS.md`; `docs/canonico.md` §14 "Host address").

1. **Resource** — New Resource → Docker Compose → the repository (`CaioFaSoares/Nod`, `main`) with the
   compose location `host/compose.yaml`: the build context `..` inside that file resolves within the
   repository, and the Dockerfile builds from the repo root (§1). `[INFERENCE]` the Coolify field
   names; the substance is the compose file, not the UI.
2. **Environment** — in Coolify's variables, not in a committed `.env`:
   - `NOD_PUBLIC_URL=https://<the address the proxy exposes>` — required and without a default; the
     host refuses to start when it is missing, and refuses a non-`https://` value outside dev (§2).
   - `NOD_GUILD_NAME=<guild name>`, `NOD_MIN_APP_VERSION` (default `0.3.0`).
   - `NOD_PORT=<port>` — the port the process binds and the compose publishes; default `8080` (§2).
   - `WEB_UI=<true|false>` — 1.0.0 (RF-73, `docs/epics/E04-web-nod.md` §9): whether this deployment
     serves the browser portal on that same port. The compose files default it to `true` — the
     same address the app syncs through, one origin, the cookie first-party; a deployment that
     wants the host API-only sets `false` and `GET /` answers the host's own 404.
   - `NOD_BACKUP_EVERY_HOURS` (default `24`) and `NOD_BACKUP_KEEP` (default `14`) — §4.
   - `NOD_BIND=0.0.0.0` so the proxy, which is outside the compose network, reaches the published
     port; the service still runs one replica only (SP01 §1).
3. **Domain and TLS** — point the domain at the published port; TLS ends at Coolify's proxy and the
   container speaks plain HTTP (§2). The value of the domain is exactly `NOD_PUBLIC_URL`: it is what
   discovery returns and what the Nod pins (SP03 §3, SP04 §1).
4. **Volume** — the named volume `nod-data` at `/data` holds `host.db`, both key files and
   `backups/`. Coolify keeps named volumes across redeploys; no bind mount is required.
5. **Health** — `GET /health` answers `ok`; the compose healthcheck probes
   `http://127.0.0.1:8080/health` every 30 s (§2).
6. **First admin** — in the service terminal, `cd /app/host && bun run setup-code` prints the one-time
   setup code to that terminal only and refuses once an admin exists (SP02 §3). The container starts
   the service from `/app`, so the scripts of `host/package.json` are run from `/app/host`.
7. **Backups** — the scheduled pass starts with the process (`NOD_BACKUP_EVERY_HOURS`, §4); a fresh
   deploy has no backup until the first interval, so run `cd /app/host && bun run backup-now` once.
8. **Restore** — keep the backup triple outside the data dir first (Coolify's volume backup, or
   `docker cp` out of the container): the `.db` file and both key files must travel together. Stop the
   service, then `cd /app/host && NOD_DATA=/data bun run restore <path to the .db file>` and start the
   service again. The target must be empty — a fresh volume, or the previous one moved aside — because
   the command refuses to write over a data dir that still holds anything; a backup that is still
   inside the volume being replaced is copied to `/tmp` inside the container first. The restored dir
   (`host.db`, `signing-key.json`, `host-secret`) is the whole state.

### 5.2 Acceptance (H9)

- Deploy on Coolify from the repo; `GET /health` is green through the public address.
- Redeploy: data and key files survive.
- `bun run backup-now`, then `bun run restore` of that file into a fresh volume: the same people
  sign in, and a pinned Nod accepts the host.

## 6. Deploy on a server with only a port range open (DuckDNS + Caddy)

For a server whose network allows only a range of ports (owner's case, 2026-11-27: `12000–12032`
open, ports 80 and 443 taken by other services), where the Coolify proxy's 80/443 domain is
unreachable and a domain-less `http://` address is refused: the Nod app pins only `https://` outside
loopback (`shared/catalog.ts`), and the host refuses a non-`https://` `NOD_PUBLIC_URL` outside dev
(`host/config.ts`, §2). So TLS has to end **on the allowed port itself**.

Evidence: the files below were read; the deploy was run by the owner, who reported it working
(`execução`, owner-reported — not reproduced by the author of this section).

### 6.1 What it is

`host/compose.duckdns.yaml` runs two services:

| Service | Role |
| --- | --- |
| `host` | The Nod host, plain HTTP on `NOD_PORT` (8080), `expose` only — no published port |
| `caddy` | Terminates TLS on `NOD_HTTPS_PORT` and proxies to `host:NOD_PORT`; the only published port |

- The certificate is a real Let's Encrypt one, issued by **DNS-01** through the DuckDNS API
  (`host/Dockerfile.caddy-duckdns`, built with `xcaddy` and `github.com/caddy-dns/duckdns`), so it
  needs neither 80 nor 443 open. `host/Caddyfile.duckdns` sets `auto_https disable_redirects`, so
  Caddy never tries to bind 80.
- DuckDNS only provides the name; the client picks the port. **The link must carry the port**
  (`https://<name>.duckdns.org:<port>`). The same name without the port goes to 443 — on the owner's
  network, another service's page (a captive/login page of the machine's network).

### 6.2 Steps

1. **DuckDNS** — at [duckdns.org](https://www.duckdns.org) create a subdomain pointing at the
   server's public IP, and copy the account token.
2. **Pick the port** — a free one inside the allowed range. Check on the server that nothing else
   holds it (`ss -tlnp | grep <port>`; Coolify does not warn about host-port conflicts with other
   projects on the same machine).
3. **Coolify resource** — New Resource → Docker Compose → the repository.
   - Base Directory: `/`
   - Docker Compose Location: `/host/compose.duckdns.yaml`
   - **Domains: leave empty** for both services. A domain there goes through Coolify's proxy on
     80/443, which is not reachable. Do not use "Generate Domain".
   - Why the base directory matters: this file's paths (`context: .`, `./host/Caddyfile.duckdns`) are
     relative to the **repo root** — Coolify runs compose with `--project-directory` on the root. Run
     by hand from another directory, pass the same flag (§6.4). `compose.yaml` is different: its
     `context: ..` is relative to `host/`.
4. **Environment** (Coolify variables, never a committed file):

   ```env
   NOD_DOMAIN=<name>.duckdns.org
   NOD_HTTPS_PORT=<port>
   NOD_PUBLIC_URL=https://<name>.duckdns.org:<port>
   NOD_GUILD_NAME=<guild name>
   DUCKDNS_TOKEN=<token>
   ```

   - `NOD_HTTPS_PORT` has a default of **8443**. Left empty, nothing answers on the open port.
   - `NOD_PUBLIC_URL` must equal, character for character, the address people use, **including
     `:<port>`**: it is what discovery returns and what the Nod pins (SP04 §1).
   - `NOD_PORT` stays at 8080: it is only the internal hop between Caddy and the host.
   - Everything else (`WEB_UI`, `NOD_MIN_APP_VERSION`, backups) is as in §5.1.
5. **Deploy.** The first build is slow — `xcaddy` compiles Caddy with the DNS module. The certificate
   is issued once the DuckDNS name resolves to the server.
6. **Check** — `https://<name>.duckdns.org:<port>/health` answers `ok`. If it doesn't: the `caddy`
   service's logs show `certificate obtained successfully`, or the DuckDNS error (wrong token, or the
   subdomain not yet pointing at the server's IP).
7. **First admin and backups** — as in §5.1 steps 6–7, on the `host` service's terminal.

### 6.3 Failure modes seen or expected

| Symptom | Cause |
| --- | --- |
| The page that comes up is another service's (login/captive page) | The URL has no `:<port>`, so it reached 443 |
| Nothing answers on the open port | `NOD_HTTPS_PORT` left at the 8443 default, or the port is held by another project |
| Browser shows a certificate error | Certificate not issued yet; read the `caddy` logs |
| The Nod app refuses the address | `NOD_PUBLIC_URL` without `https://`, or without the port people actually use |
| App signs in, the browser portal answers `origin refused` (403) | Fixed in `host/routes/web.ts`: the check compared `Origin` with the request's own `http://`, while the browser sends the proxy's `https://` address. Now `NOD_PUBLIC_URL`'s origin is accepted too — so it must equal the address in the browser's bar, port included. Needs a redeploy of the image |
| Build fails with `host/Dockerfile` not found | Compose run without `--project-directory` on the repo root (§6.2 step 3) |

### 6.4 Replicating for another project

The recipe is the same for any HTTP service behind a restricted port range; only three things change.

1. **Reuse** `host/Dockerfile.caddy-duckdns` and `host/Caddyfile.duckdns` as they are — they know
   nothing about the Nod: the Caddyfile is `{$NOD_DOMAIN}:{$NOD_HTTPS_PORT}` → `reverse_proxy
   host:{$NOD_PORT}`.
2. **In the new project's compose**, add the `caddy` service as in `host/compose.duckdns.yaml` and make
   the app service `expose` its port (no `ports`). The Caddyfile reaches the app by the **service name
   `host`** — name the new service `host`, or change that name in the Caddyfile.
3. **New DuckDNS subdomain per project**, and a **distinct `NOD_HTTPS_PORT` per project** from the
   allowed range (one Caddy per port; two projects cannot share one).
4. Keep the rule: **app address = `https://<name>.duckdns.org:<port>`**, with the port, everywhere
   it is configured or shared.

Local check of the file, from the repo root (`docker compose config` only validates; it does not
build):

```bash
NOD_DOMAIN=x.duckdns.org NOD_HTTPS_PORT=12027 NOD_PUBLIC_URL=https://x.duckdns.org:12027 \
NOD_GUILD_NAME=Test DUCKDNS_TOKEN=example \
docker compose --project-directory . -f host/compose.duckdns.yaml config
```

Limits: DuckDNS is a third-party service (a dependency of certificate issuance and renewal, not of
requests); the port in the link is unavoidable without 443.
