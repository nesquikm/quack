# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
# Server-side imports the canonical HookEnvelope + redaction_patterns from the
# plugin tree (post-FR-44QGKH AC.10). Only the `shared/` subdir is needed at
# runtime; the rest of the plugin (hook entries, shims, README, tests) stays
# excluded by .dockerignore + this scoped copy.
COPY plugins/quack/hooks/_lib/shared ./plugins/quack/hooks/_lib/shared

FROM oven/bun:1.3-alpine
WORKDIR /app

# The `oven/bun:alpine` base image already provides a non-root `bun` user with
# uid/gid 1000 — reuse it (AC-BKPM28.8 mandates uid 1000, not a specific name).
# Trying to `adduser -u 1000` here would collide with the pre-existing entry.
RUN mkdir -p /data && chown -R bun:bun /data /app

COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/src ./src
COPY --from=builder --chown=bun:bun /app/plugins ./plugins
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./

ENV QUACK_DATA_DIR=/data \
    PORT=7474 \
    QUACK_BIND_HOST=0.0.0.0
EXPOSE 7474
USER bun
CMD ["bun", "run", "src/index.ts"]
