# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src

FROM oven/bun:1.3-alpine
WORKDIR /app

# create non-root user (uid/gid 1000) and a data directory we can write to
RUN addgroup -g 1000 -S quack \
 && adduser  -u 1000 -S quack -G quack \
 && mkdir -p /data \
 && chown -R quack:quack /data /app

COPY --from=builder --chown=quack:quack /app/node_modules ./node_modules
COPY --from=builder --chown=quack:quack /app/src ./src
COPY --chown=quack:quack package.json bun.lock tsconfig.json ./

ENV QUACK_DATA_DIR=/data \
    PORT=7474
EXPOSE 7474
USER quack
CMD ["bun", "run", "src/index.ts"]
