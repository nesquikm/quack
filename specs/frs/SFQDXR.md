---
title: GraphAdapter interface + Neo4j Community wiring
milestone: M3
status: active
archived_at: null
id: fr_01KRFZE18CHWNRXHQCYJSFQDXR
created_at: 2026-05-13T10:00:00Z
---

## Requirement

Wire Neo4j Community 5.x as the `graphdb` Compose service and ship the `GraphAdapter` interface that is the **only** way to issue Cypher from application code. The adapter exposes `run(templateId, params, ctx)` — no raw `session.run` is reachable from caller code. Bootstrap runs schema migrations (the index DDL in `specs/technical-spec.md` §2). `/health` reports graphdb connectivity. Templates and the lint enforcing them are the security boundary that makes property-filter tenancy safe (per `specs/requirements.md` § Security/Abuse — `NL→Cypher escape from tenancy` mitigation).

No application templates ship in this FR beyond what migrations need; the memory-plane tool templates land in FR-DPY5GQ, the extraction-write templates in FR-4NY6S1, the cleanup templates in FR-EDXH3X. FR-SFQDXR is purely the foundation.

## Acceptance Criteria

- AC-SFQDXR.1: `compose.yml` declares `services.graphdb` (image `neo4j:5-community`, env `NEO4J_AUTH=neo4j/${QUACK_NEO4J_PASSWORD}`, volume `quack-graph-data:/data`, healthcheck `cypher-shell -u neo4j -p $$QUACK_NEO4J_PASSWORD "RETURN 1"`, interval 10 s, restart `unless-stopped`). The service is **no longer behind a profile** — it's a required service from M3 forward; the `daemon-graph` profile placeholder from FR-BKPM28 is removed. `quack` service `depends_on: graphdb: condition: service_healthy`.
- AC-SFQDXR.2: `src/shared/env.ts` is extended with `QUACK_NEO4J_URL` (default `bolt://graphdb:7687`), `QUACK_NEO4J_USER` (default `neo4j`), `QUACK_NEO4J_PASSWORD` (required — Zod refusal on absence). `.env.example` documents all three with example values.
- AC-SFQDXR.3: `src/graph/driver.ts` exports `getDriver()` (singleton factory) using `neo4j-driver` with the env-provided URL / auth. Driver lifecycle is process-bound; closed on `SIGTERM` / `SIGINT`. Connection-pool size capped via `maxConnectionPoolSize: 50` — personal scale.
- AC-SFQDXR.4: `src/graph/adapter.ts` exports a TypeScript interface `GraphAdapter` with **one** public method: `run<T extends TemplateId>(templateId: T, params: TemplateParams<T>, ctx: AuthContext): Promise<QueryResult<T>>`. The `Neo4jGraphAdapter` implementation binds `params.project_id = ctx.project_id` (overriding any caller-supplied `project_id` — defense-in-depth) before calling `session.run`. Each call uses a fresh session scoped to the `neo4j` database with the template's declared access mode (`READ` for read templates, `WRITE` for writes).
- AC-SFQDXR.5: `src/graph/templates/` contains one file per template; each file exports `{ id, cypher, paramSchema (zod), accessMode }`. Templates are registered in a static `TEMPLATE_REGISTRY` object exported from `src/graph/templates/index.ts`. At startup, `validateTemplateRegistry()` is called: every template's `cypher` source MUST contain the substring `$project_id` OR the template carries the explicit flag `{ tenancyExempt: true }` (only the migration set may be exempt, and `tenancyExempt: true` triggers a separate audit). Startup throws `TemplateRegistryError` on violation. The error message names the offending template id.
- AC-SFQDXR.6: `src/graph/migrations/` contains the v1 index DDL — 5 `(label, project_id)` composite indexes + `entity_name_fts` full-text + per-label `id` indexes where needed (matches `specs/technical-spec.md` §2 exactly). `runMigrations(driver)` is called once at startup, after the connection check. Migrations use `IF NOT EXISTS` and are idempotent. Re-running on an existing graph adds no indexes.
- AC-SFQDXR.7: `GET /health` is extended to return `{ ok, version, graphdb: "ok" | "down" }`. `graphdb` is computed by running a 1-second-timeout `MATCH (n) RETURN count(n) LIMIT 0` against the driver on each healthcheck. `ok` is `false` when `graphdb === "down"`; the Docker healthcheck on `quack` container then transitions to unhealthy.
- AC-SFQDXR.8: A repo-level lint refuses any import of `neo4j-driver` outside `src/graph/`. `tests/graph-import-fence.test.ts` greps the source tree (`src/**/*.ts`, excluding `src/graph/**`) and fails when violated. This is the structural enforcement that keeps `GraphAdapter` the only Cypher entry point.
- AC-SFQDXR.9: Integration tests in `src/graph/adapter.test.ts` exercise `run()` against a real ephemeral Neo4j (spawned via `docker run` helper, same pattern as FR-BKPM28 ops tests). Skipped automatically when `docker` is not on `$PATH`. Covers: happy path; `project_id` override defense (caller passes `project_id: 'other'` → `ctx.project_id` wins); unknown `templateId` ⇒ `UnknownTemplateError`; query against the wrong project returns empty.
- AC-SFQDXR.10: `src/admin/tools/server_status.ts` is extended: `queue` block stays `null` (still no extractor); a new field `counts.graphdb` is added with `{ status: "ok" | "down", indexes: number }`. The error category `db_error` becomes active in `errors.by_category` whenever `GraphAdapter.run` throws (caught at the adapter boundary, counter incremented, error rethrown).

## Technical Design

### Modules

- **`src/graph/driver.ts`** — `getDriver()` singleton factory; closes on process shutdown signals.
- **`src/graph/adapter.ts`** — `GraphAdapter` interface + `Neo4jGraphAdapter` implementation. Single public method `run(templateId, params, ctx)`.
- **`src/graph/templates/`** — one file per template; `index.ts` exports `TEMPLATE_REGISTRY` and `validateTemplateRegistry`.
- **`src/graph/migrations.ts`** — index DDL runner; idempotent; called once after connection check.
- **`src/graph/types.ts`** — `TemplateId` string-literal union, `TemplateParams<T>` mapped type, `QueryResult<T>`, `AuthContext` re-export.
- **`src/graph/errors.ts`** — `UnknownTemplateError`, `TemplateRegistryError`, `GraphConnectionError`.
- **`src/shared/env.ts`** — extended with the three `QUACK_NEO4J_*` env vars.
- **`src/server/index.ts`** — `/health` extended; bootstrap wiring calls `getDriver()` → `runMigrations()` → optionally aborts on failure.
- **`src/admin/tools/server_status.ts`** — `counts.graphdb` field added.

### Compose

`compose.yml`:

```yaml
services:
  quack:
    depends_on:
      graphdb:
        condition: service_healthy
    # … existing config …

  graphdb:
    image: neo4j:5-community
    environment:
      NEO4J_AUTH: neo4j/${QUACK_NEO4J_PASSWORD:?password required}
      NEO4J_server_memory_heap_initial__size: 256m
      NEO4J_server_memory_heap_max__size: 1g
    volumes:
      - quack-graph-data:/data
    healthcheck:
      test: ["CMD-SHELL", "cypher-shell -u neo4j -p $$QUACK_NEO4J_PASSWORD 'RETURN 1' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 30s
    restart: unless-stopped

volumes:
  quack-data:
  quack-graph-data:
```

The `daemon-graph` profile gate from FR-BKPM28 is removed; graphdb is required from M3 onward.

### Dependencies added
- `neo4j-driver` (`^5.x`, runtime).

### Out of scope here
- Application Cypher templates beyond the migration set (land in FR-DPY5GQ / FR-4NY6S1 / FR-EDXH3X).
- Extraction loop, MCP memory-plane tools, project-delete cleanup — separate FRs.
- Neo4j auth rotation (restart-based; no in-place rotation in v1).

## Testing

- `src/graph/driver.test.ts` — singleton identity across calls; env-var-driven URL/auth; close on signal.
- `src/graph/adapter.test.ts` — integration vs. real Neo4j (Docker spawn helper, auto-skip when `docker` absent); happy path; `project_id` override defense; unknown template id; cross-project query returns empty.
- `src/graph/templates/index.test.ts` — `validateTemplateRegistry` accepts compliant template; rejects template without `$project_id` and no `tenancyExempt`; rejects empty registry; lists the failing template id in the error message.
- `src/graph/migrations.test.ts` — first run creates indexes; second run is a no-op; integration test counts `SHOW INDEXES` rows before and after.
- `tests/graph-import-fence.test.ts` — greps `src/**/*.ts` outside `src/graph/`; fails on any `import .* neo4j-driver` match.
- `src/server/index.test.ts` — `/health` returns `graphdb: "ok"` when connection succeeds, `graphdb: "down"` when driver throws or timeout exceeded; integration extends the existing test.
- `src/admin/tools/server_status.test.ts` — `counts.graphdb` field present in v1 response; `db_error` category increments on `GraphAdapter.run` throw.

## Notes

- The lint test (AC-SFQDXR.8) is a runtime grep rather than a custom ESLint rule because the latter ships with more maintenance burden for a single rule. A 10-line grep in a Bun test gives byte-checkable enforcement with zero plugin dependency.
- `maxConnectionPoolSize: 50` is loose for personal scale — a tighter value (e.g. 20) is fine; pick the smallest that doesn't bottleneck the four memory-plane tools running concurrently.
- The graphdb healthcheck uses `cypher-shell` which ships with the Neo4j image. The `$$` is Compose's literal-`$` escape so the env-var lookup happens inside the container, not at Compose-file parsing time.
- `MATCH (n) RETURN count(n) LIMIT 0` is the cheapest possible Neo4j health query — it returns immediately without scanning. The 1-second timeout on `/health` keeps the endpoint snappy.
- `tenancyExempt: true` is gated behind an audit log line at registry validation — operators can grep for it to enumerate exempt templates. Only migration / DDL templates should ever use it.
