# The host image (SP07 §1). Build from the repo root — `host/` imports `shared/`:
#
#   docker build -f host/Dockerfile -t nod-host .
#
# `host/package.json` holds the host's only dependency (Elysia, exact beta), so the Nod app's
# dependencies never enter the image.

# `--filter ./host` from SP07 §1 needs the repo root to be a workspace root declaring `host`; it is
# not (root package.json has no "workspaces"), and a filtered install there matches no package. The
# fallback is the package's own lockfile, `host/bun.lock`: the install happens in `host/`.
FROM oven/bun:1.4.3 AS deps
WORKDIR /app/host
COPY host/package.json host/bun.lock ./
RUN bun install --frozen-lockfile --production

# E04/RF-73: the portal's page, built from `web/` into `host/public` — the directory the host serves
# while `WEB_UI` is on. The root's devDependencies are what the build needs (vite, typescript), so
# this stage installs them with the repo's own lockfile and writes only the bundle onward.
FROM oven/bun:1.4.3 AS web
WORKDIR /app
COPY package.json bun.lock ./
COPY web ./web
COPY shared ./shared
RUN bun install --frozen-lockfile && bun run web:build

FROM oven/bun:1.4.3-slim
WORKDIR /app
COPY --from=deps /app/host/node_modules ./host/node_modules
COPY --from=web /app/host/public ./host/public
COPY shared ./shared
COPY host ./host
ENV NODE_ENV=production NOD_DATA=/data PORT=8080
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080
CMD ["bun", "host/main.ts"]
