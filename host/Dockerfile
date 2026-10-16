# The host image (SP07 §1). Build from the repo root — `host/` imports `shared/`:
#
#   docker build -f host/Dockerfile -t bond-host .
#
# `host/package.json` holds the host's only dependency (Elysia, exact beta), so the Bond app's
# dependencies never enter the image.

# `--filter ./host` from SP07 §1 needs the repo root to be a workspace root declaring `host`; it is
# not (root package.json has no "workspaces"), and a filtered install there matches no package. The
# fallback is the package's own lockfile, `host/bun.lock`: the install happens in `host/`.
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
