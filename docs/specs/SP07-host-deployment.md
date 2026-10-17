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
    volumes:
      - nod-data:/data
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1))"]
      interval: 30s
    restart: unless-stopped
volumes:
  nod-data:
```

- One replica only: SQLite has a single writer (SP01).
- TLS ends at Coolify's proxy; the container serves plain HTTP on 8080 inside its network.
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
   - `NOD_BACKUP_EVERY_HOURS` (default `24`) and `NOD_BACKUP_KEEP` (default `14`) — §4.
   - `NOD_BIND=0.0.0.0` so the proxy, which is outside the compose network, reaches `8080`; the
     service still runs one replica only (SP01 §1).
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
