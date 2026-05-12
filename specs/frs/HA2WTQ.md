---
title: Auth middleware, auth.sqlite, and token primitives
milestone: M2
status: active
archived_at: null
id: fr_01KREG3A72V3EM5DDRP8HA2WTQ
created_at: 2026-05-12T19:30:00Z
---

## Requirement

Implement the foundation that authenticates every request reaching either the HTTP `/ingest` endpoint or the HTTP `/mcp` MCP endpoint. This FR delivers:

1. The `auth.sqlite` schema + migration runner.
2. Token primitives — 32-byte random generation, SHA-256 hashing, constant-time verification.
3. The `AuthMiddleware` that resolves a bearer token to `(user_id, project_id, role)` via a single indexed point query.
4. The bootstrap admin flow that mints the first admin from `QUACK_BOOTSTRAP_TOKEN` on first boot.
5. A minimal HTTP server skeleton (`GET /health` unauthenticated; `POST /ingest` and `POST /mcp` stubs returning 204 once auth passes) so the middleware can be exercised against a real server.

The cheap-model extractor, full ingest pipeline, MCP tool dispatch, and graph DB integration are out of scope here — they land in FR-B (`WSFVNP`) and later FRs. Docker packaging is FR-C (`BKPM28`).

## Acceptance Criteria

- AC-HA2WTQ.1: `auth.sqlite` schema is created via a migration runner on server start. Re-running migrations on an existing DB is a no-op (idempotent). Schema matches `specs/technical-spec.md` §2 exactly (`users`, `projects`, `project_members`, `tokens`, `pending_cleanup`, `idx_tokens_hash_active`).
- AC-HA2WTQ.2: `generateToken()` returns a 32-byte random secret encoded as 43-character base64url; `hashToken(plaintext)` returns a 32-byte SHA-256 digest; `verifyToken(plaintext, storedHash)` returns boolean using a constant-time comparison.
- AC-HA2WTQ.3: On first boot with an empty `users` table and `QUACK_BOOTSTRAP_TOKEN` set, the server creates one admin user (`username='admin'`, `role='admin'`), one project (`slug='_control_'`, `display_name='Control Plane'`), one membership row, and one token row whose `token_hash` equals `hashToken(QUACK_BOOTSTRAP_TOKEN)`. On subsequent boots with `users` non-empty, the env var is ignored. On first boot with `QUACK_BOOTSTRAP_TOKEN` absent, the server logs an error and exits non-zero.
- AC-HA2WTQ.4: `AuthMiddleware(request)` parses `Authorization: Bearer <token>`, hashes the token, runs the indexed query, and sets `request.context = { user_id, project_id, role }`. Missing header, malformed header, unknown hash, or revoked token (`revoked_at IS NOT NULL`) ⇒ HTTP 401 with a uniform JSON body `{ error: "unauthorized" }` — byte-identical body across the four failure modes (no token-existence oracle).
- AC-HA2WTQ.5: `GET /health` returns 200 `{ ok: true, version }` without invoking `AuthMiddleware`. `POST /ingest` and `POST /mcp` invoke `AuthMiddleware`; on success they return 204 in this FR (real handlers land later). Both endpoints bind to `127.0.0.1` only — explicit unit test confirms a request from a non-loopback origin is refused at bind time, not at request time.
- AC-HA2WTQ.6: Server logger strips any header named `authorization` (case-insensitive) from every log record. Explicit test: log a request containing a known bearer; assert no log line contains the token plaintext or its base64url-decoded form.
- AC-HA2WTQ.7: Auth-check latency at p95 is < 5 ms measured over 1000 sequential requests against a 100-user / 10-project / 50-token seeded `auth.sqlite` (benchmark test).

## Technical Design

### Modules

- **`src/auth/sqlite/schema.ts`** — DDL strings + `runMigrations(db)` wrapping execution in a single transaction. Migrations table `_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)`; v1 carries the full schema from `technical-spec.md` §2.
- **`src/auth/tokens.ts`** — `generateToken(): string` via `crypto.getRandomValues(new Uint8Array(32))` + base64url encode; `hashToken(plaintext: string): Uint8Array` via `Bun.CryptoHasher` (SHA-256); `verifyToken(plaintext, storedHash): boolean` via constant-time byte comparison.
- **`src/auth/middleware.ts`** — `AuthMiddleware(req, db): Context | null`. Single prepared statement `selectTokenByHash` cached on the DB handle. Returns `null` on miss; caller responds 401.
- **`src/auth/bootstrap.ts`** — `bootstrapAdmin(db, env): void` called once during startup, after migrations. `SELECT COUNT(*) FROM users`; if zero and env var present, runs a single transaction creating user/project/member/token rows. If zero and env var absent, throws `BootstrapError` to halt startup. If non-zero, exits silently (env var ignored).
- **`src/server/index.ts`** — Bun HTTP server. Three routes: `GET /health`, `POST /ingest`, `POST /mcp`. Both POST routes delegate to `AuthMiddleware`; 204 on success, 401 on failure. Bind to `127.0.0.1:${PORT}` (default 7474).
- **`src/shared/logger.ts`** — minimal structured logger. Authorization-stripping pass runs on every record write.
- **`src/shared/env.ts`** — Zod schema for env: `PORT` (default 7474), `QUACK_BOOTSTRAP_TOKEN` (optional; required on first boot), `QUACK_DATA_DIR` (default `/data` in container, `./data` in dev). Throws on schema violation.

### Dependencies added
- `zod` (runtime).
- `bun:sqlite` and Bun crypto are built-in — no extra deps.

### Out of scope here
- MCP server / tool dispatch (FR-B).
- Real `/ingest` body handling, extractor queue, cheap-model API (later in M2).
- Graph DB integration (later in M2; depends on follow-up brainstorm).
- Docker packaging (FR-C).

## Testing

- `src/auth/tokens.test.ts` — entropy / length / round-trip / timing-safe equality.
- `src/auth/sqlite/schema.test.ts` — migration is idempotent; re-running adds no rows; schema introspection matches the spec; `_migrations` row count is exactly 1 after first run.
- `src/auth/bootstrap.test.ts` — first-boot creates 4 rows transactionally; second boot is a no-op; missing env var on first boot throws `BootstrapError`.
- `src/auth/middleware.test.ts` — happy path; missing header; malformed header (no `Bearer ` prefix); unknown hash; revoked token (`revoked_at` set); all four failure modes return *byte-identical* 401 body (no length / no field-order leak).
- `src/server/index.test.ts` — integration: `/health` no auth; `/ingest` and `/mcp` 401 without token, 204 with valid token, 401 with revoked token; binds to `127.0.0.1` only.
- `src/shared/logger.test.ts` — log line with `Authorization: Bearer abc123` does NOT contain `abc123` (or its decoded form) in the output buffer.
- `src/auth/middleware.bench.test.ts` — seeded DB; 1000 sequential auth checks; p95 < 5 ms. Tag with a slow-runner guard.

## Notes

- Bootstrap admin's project slug is `_control_` (leading underscore signals non-user-facing). FR-B's `delete_project` MUST refuse to delete it (gate: "cannot delete the project holding the only admin").
- Token plaintext display: the bootstrap admin's plaintext IS the operator-supplied `QUACK_BOOTSTRAP_TOKEN` — no fresh issuance for it. Tokens minted via FR-B's `register_user` / `add_member` are shown once in the MCP tool response and forgotten server-side.
- Constant-time comparison matters even though lookup is by hash: prevents timing oracles on token-hash equality if an attacker can submit many tokens with controlled prefixes. Cheap insurance.
- 401 body uniformity (AC-HA2WTQ.4) is a hard test target — non-uniform bodies historically leak account existence; bake it in from day one.
- The 7474 default port is a placeholder; ops can override via `PORT` env var.
