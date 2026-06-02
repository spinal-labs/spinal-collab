# syntax=docker/dockerfile:1
#
# claude-collab relay — the cloud broker (no Claude, no Python, no database, no bun).
# Pure pnpm + Node: pnpm builds the workspace and `pnpm deploy` produces a
# self-contained app dir (real node_modules, no symlinks to the workspace), which
# runs on a slim Node base as a non-root user.
#
# Image is named `claude-collab-relay` so it doesn't collide with other stacks on
# the same registry/host.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm/bin:$PATH"
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# ---- build: install, compile (tsc), and deploy a self-contained relay ----
FROM base AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Self-contained dir with only the relay's prod deps (ws, zod, nanoid, protocol).
RUN pnpm --filter=@claude-collab/relay --prod deploy --legacy /prod/relay

# ---- runtime: slim Node, non-root, just the deployed app ----
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 collab
WORKDIR /app
COPY --from=build /prod/relay /app
ENV PORT=8787
EXPOSE 8787
USER collab
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/health" >/dev/null || exit 1
# --host 0.0.0.0 so the container is reachable; --port follows $PORT.
CMD ["node", "dist/index.js", "--host", "0.0.0.0"]
