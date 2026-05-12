---
title: Docker Compose deployment (Dockerfile, compose.yml, .env.example)
milestone: M2
status: archived
archived_at: 2026-05-12T17:07:13Z
id: fr_01KREG3A740JKRS25T5HBKPM28
created_at: 2026-05-12T19:30:00Z
---

## Requirement

Package Quack as a one-command Docker Compose deployment. This FR delivers:

1. A multi-stage `Dockerfile` building a minimal Bun-based image for the `quack` service.
2. `compose.yml` (the modern canonical name) declaring one required `quack` service and a named volume `quack-data` mounted at `/data`.
3. An `.env.example` documenting every env var the server reads.
4. A healthcheck wired to `GET /health` (delivered by FR-A `HA2WTQ`).
5. A "Deployment" section appended to `README.md` (created if absent) covering `docker compose up`.

The optional `graphdb` service is wired conditionally via a Compose **profile** (`--profile daemon-graph`); its image/configuration is left as a TODO until the graph-DB choice resolves in a follow-up brainstorm. CI integration (`compose up`-on-PR) is out of scope.

## Acceptance Criteria

- AC-BKPM28.1: `Dockerfile` uses a multi-stage build: stage 1 (`oven/bun:1.3-alpine as builder`) runs `bun install --production --frozen-lockfile` and copies `src/` + `tsconfig.json`; stage 2 copies only `node_modules/`, `src/`, `package.json`, `bun.lock`, `tsconfig.json` into a fresh `oven/bun:1.3-alpine` base. Final image runs as a non-root user (`uid 1000`), exposes `7474`, declares `WORKDIR /app`, and `CMD ["bun", "run", "src/index.ts"]`.
- AC-BKPM28.2: `compose.yml` declares `services.quack` (build context `.`, ports `127.0.0.1:7474:7474`, env file `.env`, volume `quack-data:/data`, healthcheck pinging `/health` via `wget --spider -q http://127.0.0.1:7474/health` with `interval: 10s`, `timeout: 3s`, `retries: 3`, `start_period: 10s`, restart `unless-stopped`). The `graphdb` service is declared under `profiles: [daemon-graph]` with a placeholder image (`# TODO: pin once graph DB chosen`).
- AC-BKPM28.3: `.env.example` includes every env var read by `src/shared/env.ts` (`PORT`, `QUACK_BOOTSTRAP_TOKEN`, `QUACK_DATA_DIR`, `QUACK_MODEL_API_KEY`, `QUACK_MODEL_BASE_URL`) with an inline comment explaining each. `QUACK_BOOTSTRAP_TOKEN` is annotated "consumed only on first boot; set before the first `docker compose up`". `QUACK_MODEL_API_KEY` is annotated "optional in M2; required from M3 when the extractor runs" with a note that it must NOT be committed (and `.env` is in `.gitignore`, already covered by M1). `QUACK_MODEL_BASE_URL` lists three example values (`https://api.anthropic.com/v1`, `https://api.openai.com/v1`, `http://localhost:11434/v1`).
- AC-BKPM28.4: Port mapping in `compose.yml` is explicitly `127.0.0.1:7474:7474` — not `7474:7474` — so the container is not reachable from non-loopback by default. An inline comment in `compose.yml` explains how to expose externally (replace with `0.0.0.0:7474:7474`, behind your own reverse proxy / Tailscale).
- AC-BKPM28.5: `README.md` (created if absent) contains a "Deployment" section with: a `docker compose up` quickstart, a one-line description of `QUACK_BOOTSTRAP_TOKEN` (generate via `openssl rand -base64 32`), how to enable the daemon-graph profile (`docker compose --profile daemon-graph up`), and an explicit note that the graph-DB choice is TBD and the profile is a placeholder. Idempotent re-runs: the section is bracketed by a marker comment so re-running FR-C writes does not duplicate it.
- AC-BKPM28.6: Build verification: `docker build -t quack-test .` succeeds from a clean clone with no manual prep. Integration verification: `QUACK_BOOTSTRAP_TOKEN=$(openssl rand -base64 32) docker compose up -d`, then `curl -fsS http://127.0.0.1:7474/health` returns 200 within 30 s of `up` (NFR-4). Stack stops cleanly with `docker compose down --volumes`.
- AC-BKPM28.7: `.dockerignore` excludes `node_modules/`, `.git/`, `specs/`, `BRIEF.md`, `CLAUDE.md`, `*.md`, `tests/`, and `.env*`. Image size with no graph-DB driver is < 200 MB.
- AC-BKPM28.8: Image runs as non-root. Explicit test: `docker run --rm quack-test id -u` returns `1000`. Mounted volume `/data` is owned by `1000:1000` (declared in Dockerfile via `chown` after `mkdir /data`).

## Technical Design

### Files added (all at repo root)

- **`Dockerfile`** — multi-stage with `as builder` and a fresh final stage. Pin Bun image to `oven/bun:1.3-alpine` (matches `bun-1.3.13` in `package.json`).
- **`compose.yml`** — modern canonical name; single required `quack` service; optional `graphdb` under `daemon-graph` profile.
- **`.env.example`** — comment-rich; lists every env var with inline rationale.
- **`.dockerignore`** — mirrors `.gitignore` plus excludes specs / `*.md`.
- **`README.md`** — Deployment section, idempotent via marker comment.

### Source code touched
None — `src/` stays as FR-A delivers it. Healthcheck pings the FR-A `/health` endpoint, which sequences FR-C strictly after FR-A in the M2 plan.

### Graphdb-profile placeholder
The `daemon-graph` profile name is generic on purpose — when a concrete graph DB is picked, the profile keeps the same name (existing `docker compose --profile daemon-graph up` commands keep working) and only the service body is updated.

## Testing

A new top-level `tests/` directory holds ops-style tests that can't be co-located with `src/` (overrides the `src/`-co-located default in `CLAUDE.md` § Testing Conventions for this FR only — note in CLAUDE.md):

- `tests/docker-build.test.ts` — shells out to `docker build`; asserts exit 0 and image size < 200 MB via `docker image inspect`.
- `tests/docker-run.test.ts` — shells out to `docker run --rm` with `QUACK_BOOTSTRAP_TOKEN`; asserts `/health` returns 200 within 30 s. **Skipped automatically when `docker` is not on `$PATH`** so local Bun-only test runs aren't broken.
- `tests/compose-config.test.ts` — parses `compose.yml` as YAML; asserts port mapping is `127.0.0.1:`-prefixed; asserts the daemon-graph service sits under a profile; asserts volume is named.
- Manual: `docker compose --profile daemon-graph config` validates the optional service declaration parses (no runtime check until a graph DB is pinned).

## Notes

- Compose v2 (`docker compose` CLI plugin) is required; v1 (`docker-compose` binary) is not supported. Documented in README.
- The `quack-data` volume holds `auth.sqlite` and, for embedded graph engines, the graph data file(s). Backup recipe: `docker run --rm -v quack-data:/data alpine tar cz /data > backup.tgz` (documented in README).
- Healthcheck uses `wget --spider` (BusyBox wget is in the alpine base) to avoid an extra `curl` install. Alternative: a tiny `bun run scripts/healthcheck.ts` would also work, but `wget` keeps the image lean.
- Non-root user (`uid 1000`) is intentional defense-in-depth — a container escape is still constrained. The data volume must be `chown`ed at image-build time so the runtime user can write to it.
- `.dockerignore` excluding `*.md` is deliberate — specs and BRIEF aren't needed in the image and would bust the layer cache on every edit. README is host-side only.
- An override of the `src/`-co-located test layout for this FR (`tests/*.test.ts` instead of `src/*.test.ts`) is documented in `CLAUDE.md` § Testing Conventions when this FR ships — see the layout-policy override branch.


## Implementation notes

No advisory notes.
