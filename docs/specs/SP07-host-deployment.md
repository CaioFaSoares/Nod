# SP07 — Host deployment

Why: `docs/epics/E01-connected-mode.md` §10. One compose on the owner's Coolify, one service, one
volume. No address is named here (`AGENTS.md`); the owner sets it in Coolify.

## 1. Image

`host/Dockerfile`:

```dockerfile
FROM oven/bun:<pinned version> AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY host/package.json host/
RUN bun install --frozen-lockfile --production --filter ./host

FROM oven/bun:<pinned version>-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY shared ./shared
COPY host ./host
ENV NODE_ENV=production BOND_DATA=/data PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "host/main.ts"]
```

- The Bun version is pinned to the one the repo uses, and Elysia to the exact beta in `bun.lock`
  (E01 §11).
- The build context is the repo root, because `shared/` is imported by both sides.
- `host/package.json` holds only the host's dependencies (Elysia), so the Bond app's dependencies
  never enter the image.
- `[INFERENCE]` that the `-slim` tag and the `--filter` install shape exist for the pinned Bun
  version; H1 confirms them, or falls back to the full image.

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

## 5. Acceptance (H9)

- Deploy on Coolify from the repo; `GET /health` is green through the public address.
- Redeploy: data and key files survive.
- `bun run backup-now`, then `bun run restore` of that file into a fresh volume: the same people
  sign in, and a pinned Bond accepts the host.
