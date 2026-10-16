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
ENV NODE_ENV=production BOND_DATA=/data PORT=8080
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080
CMD ["bun", "host/main.ts"]
```

- The install happens **inside `host/`**, from `host/bun.lock` — not through a workspace filter. The
  root `package.json` declares no `workspaces`, so `bun install --filter ./host` at the root matches
  no package and installs nothing (`docs/handovers/h1.md`, measured). The property this bullet keeps
  is the one that matters: `host/package.json` holds only the host's dependency, so the Bond app's
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
      BOND_PUBLIC_URL: ${BOND_PUBLIC_URL}        # https address Coolify exposes; used in discovery and links
      BOND_GUILD_NAME: ${BOND_GUILD_NAME}
      BOND_MIN_APP_VERSION: ${BOND_MIN_APP_VERSION:-0.3.0}
      BOND_BACKUP_EVERY_HOURS: ${BOND_BACKUP_EVERY_HOURS:-24}
      BOND_BACKUP_KEEP: ${BOND_BACKUP_KEEP:-14}
    volumes:
      - bond-data:/data
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1))"]
      interval: 30s
    restart: unless-stopped
volumes:
  bond-data:
```

- One replica only: SQLite has a single writer (SP01).
- TLS ends at Coolify's proxy; the container serves plain HTTP on 8080 inside its network.
- The host refuses to start when `BOND_PUBLIC_URL` isn't `https://`, except in dev.

## 3. Commands

| Command | What |
| --- | --- |
| `bun run setup-code` (in the container) | Prints a setup code (SP02 §3) to the terminal only; refuses if an admin exists |
| `bun run backup-now` | Runs §4 once |
| `bun run restore <file>` | Stops serving, checks `PRAGMA integrity_check` on the file, swaps it in, restarts |

They're scripts in `host/package.json`, run through Coolify's terminal.

## 4. Backup

- Every `BOND_BACKUP_EVERY_HOURS`: `VACUUM INTO '/data/backups/host-<ISO>.db'`.
- Keep the newest `BOND_BACKUP_KEEP` files.
- The key files (`signing-key.json`, `host-secret`) are copied beside each backup. A restore without
  them makes every pinned Bond refuse the host (SP04 §1).
- Copying off the VPS is the owner's choice (E01 question 7); until then, Coolify's volume backup or
  a manual copy.

## 5. Deploy on Coolify, and the acceptance of H9

### 5.1 First deploy

Coolify builds the compose from the repository. The address is set in Coolify's environment and never
written into a file (`AGENTS.md`; `docs/canonico.md` §14 "Host address").

1. **Resource** — New Resource → Docker Compose → the repository (`CaioFaSoares/Bond`, `main`) with the
   compose location `host/compose.yaml`: the build context `..` inside that file resolves within the
   repository, and the Dockerfile builds from the repo root (§1). `[INFERENCE]` the Coolify field
   names; the substance is the compose file, not the UI.
2. **Environment** — in Coolify's variables, not in a committed `.env`:
   - `BOND_PUBLIC_URL=https://<the address the proxy exposes>` — required and without a default; the
     host refuses to start when it is missing, and refuses a non-`https://` value outside dev (§2).
   - `BOND_GUILD_NAME=<guild name>`, `BOND_MIN_APP_VERSION` (default `0.3.0`).
   - `BOND_BACKUP_EVERY_HOURS` (default `24`) and `BOND_BACKUP_KEEP` (default `14`) — §4.
   - `BOND_BIND=0.0.0.0` so the proxy, which is outside the compose network, reaches `8080`; the
     service still runs one replica only (SP01 §1).
3. **Domain and TLS** — point the domain at the published port; TLS ends at Coolify's proxy and the
   container speaks plain HTTP (§2). The value of the domain is exactly `BOND_PUBLIC_URL`: it is what
   discovery returns and what the Bond pins (SP03 §3, SP04 §1).
4. **Volume** — the named volume `bond-data` at `/data` holds `host.db`, both key files and
   `backups/`. Coolify keeps named volumes across redeploys; no bind mount is required.
5. **Health** — `GET /health` answers `ok`; the compose healthcheck probes
   `http://127.0.0.1:8080/health` every 30 s (§2).
6. **First admin** — in the service terminal, `cd /app/host && bun run setup-code` prints the one-time
   setup code to that terminal only and refuses once an admin exists (SP02 §3). The container starts
   the service from `/app`, so the scripts of `host/package.json` are run from `/app/host`.
7. **Backups** — the scheduled pass starts with the process (`BOND_BACKUP_EVERY_HOURS`, §4); a fresh
   deploy has no backup until the first interval, so run `cd /app/host && bun run backup-now` once.
8. **Restore** — keep the backup triple outside the data dir first (Coolify's volume backup, or
   `docker cp` out of the container): the `.db` file and both key files must travel together. Stop the
   service, then `cd /app/host && BOND_DATA=/data bun run restore <path to the .db file>` and start the
   service again. The target must be empty — a fresh volume, or the previous one moved aside — because
   the command refuses to write over a data dir that still holds anything; a backup that is still
   inside the volume being replaced is copied to `/tmp` inside the container first. The restored dir
   (`host.db`, `signing-key.json`, `host-secret`) is the whole state.

### 5.2 Acceptance (H9)

- Deploy on Coolify from the repo; `GET /health` is green through the public address.
- Redeploy: data and key files survive.
- `bun run backup-now`, then `bun run restore` of that file into a fresh volume: the same people
  sign in, and a pinned Bond accepts the host.
