---
title: Pending-cleanup reconciliation sweep + delete_project graph cleanup
milestone: M3
status: archived
archived_at: 2026-05-13T10:19:36Z
id: fr_01KRFZE18FMDWXRTJV5PEDXH3X
created_at: 2026-05-13T10:00:00Z
---

## Requirement

Drain the `pending_cleanup` table that M2 introduced (FR-WSFVNP §5). When `delete_project` runs, the auth-plane row is deleted immediately (with FK cascade for members/tokens) and a `pending_cleanup(kind='project_graph_partition', ref=<project_id>)` row is inserted. This FR adds an in-process sweeper that periodically reads pending rows, runs `MATCH (n {project_id: $project_id}) DETACH DELETE n` in batches against Neo4j, and removes the pending row on success. Plus two admin MCP tools (`run_cleanup_now`, `cleanup_status`) for manual control + observability.

Also fixes one cross-FR inconsistency carried from M2: `delete_project` currently writes `pending_cleanup.ref = <slug>`, but the graph partition key is `project_id` (the integer FK from `auth.sqlite`), and the slug can't be looked up after the FK cascade deletes the project row. This FR amends `delete_project` to write `ref = String(project.id)`.

## Acceptance Criteria

- AC-EDXH3X.1: Amend `src/admin/tools/delete_project.ts` (M2 code): the inserted `pending_cleanup.ref` value changes from `<slug>` to `String(project.id)`. A startup migration runs once: `UPDATE pending_cleanup SET ref = (SELECT id FROM projects WHERE slug = pending_cleanup.ref) WHERE kind = 'project_graph_partition' AND ref NOT GLOB '[0-9]*';`. The migration is idempotent — it only acts on non-numeric refs, which only exist for projects deleted before M3 ships. Rows whose slug lookup misses (project genuinely gone, no surviving record) are dropped: `DELETE FROM pending_cleanup WHERE kind = 'project_graph_partition' AND ref NOT GLOB '[0-9]*';` (the graph data is orphaned and unreachable since `project_id` was the only handle).
- AC-EDXH3X.2: In-process sweeper started at server startup. First run after `QUACK_CLEANUP_INITIAL_DELAY_SECONDS` (Zod env, default 60). Recurring interval `QUACK_CLEANUP_INTERVAL_SECONDS` (Zod env, default 86400 = 24h). Sweeper is single-flight (in-process mutex; two concurrent sweeps are forbidden — second attempt is a no-op log line). Sweeper exits cleanly on `SIGTERM`/`SIGINT`: finishes the current batch then stops; abandons the rest of the queue (re-processed on next startup).
- AC-EDXH3X.3: Sweep reads pending rows: `SELECT id, ref, fail_count FROM pending_cleanup WHERE kind = 'project_graph_partition' AND fail_count < 3 ORDER BY queued_at ASC`. For each row, runs `MATCH (n {project_id: $project_id}) WITH n LIMIT $batch DETACH DELETE n RETURN count(n) AS deleted` repeatedly until `deleted` is 0. Batch size `QUACK_CLEANUP_BATCH_SIZE` (Zod env, default 1000).
- AC-EDXH3X.4: On successful drain of one project's graph data ⇒ `DELETE FROM pending_cleanup WHERE id = ?`. On Neo4j error ⇒ `UPDATE pending_cleanup SET fail_count = fail_count + 1 WHERE id = ?`, leave row in place, log `cleanup_failed project_id=<…> err=<…>`, increment `errors.by_category.cleanup_failed`.
- AC-EDXH3X.5: New admin MCP tool `run_cleanup_now()` — admin-only (added to `ADMIN_TOOLS`). Triggers an immediate sweep. Returns `{ rows_processed: number, nodes_deleted: number, errors: number, took_ms: number }`. Refuses with MCP error `sweep_in_progress` if a sweep is already running.
- AC-EDXH3X.6: New admin MCP tool `cleanup_status()` — admin-only. Returns `{ pending_rows: number, stuck_rows: number, last_run_at: ISO8601 | null, last_run: { rows_processed, nodes_deleted, errors, took_ms } | null, currently_running: boolean }`. `stuck_rows` counts pending rows with `fail_count >= 3` (the backoff-stuck set requiring operator intervention).
- AC-EDXH3X.7: Counter integration — `src/metrics/counters.ts` extended with:
  - `cleanup.last_run_at: ISO8601 | null` (gauge — set after every sweep, regardless of outcome)
  - `cleanup.runs_total: number` (incremented per sweep, success or fail)
  - `cleanup.nodes_deleted_total: number` (cumulative across all sweeps)
  - `errors.by_category.cleanup_failed` (already an active category lifecycle from FR-SFQDXR's `db_error` peer — increments per failed row, not per sweep run)

  `server_status` (FR-956DT2) is extended: a new top-level `cleanup` block in the response envelope reports `{ last_run_at, pending_rows, currently_running }` (reads `cleanup.last_run_at` + `SELECT COUNT(*) FROM pending_cleanup WHERE kind='project_graph_partition'` + the sweeper's mutex state).

- AC-EDXH3X.8: Project ID re-use is not a concern: graph nodes carry `project_id` from the deleted project's integer key. SQLite `INTEGER PRIMARY KEY` is monotonic — old IDs aren't reused. A new project with the same slug gets a fresh `project_id`; the pending sweep targets only the old graph data via its old integer.
- AC-EDXH3X.9: End-to-end test in `src/extract/cleanup.test.ts`: seed a project with 100 nodes via `GraphAdapter`, call `delete_project` (queues a pending_cleanup row), assert auth.sqlite `projects` row gone immediately, assert graph nodes still present, run `run_cleanup_now`, assert graph nodes gone + pending_cleanup row gone.
- AC-EDXH3X.10: Cross-tenant safety: the cleanup template uses `MATCH (n {project_id: $project_id})` — it can ONLY delete nodes carrying that exact `project_id`. Adversarial test in `src/extract/cleanup_cross_tenant.test.ts`: seed two projects; queue a `pending_cleanup` row for project A only; sweep; assert A's nodes deleted, B's nodes untouched (count unchanged).
- AC-EDXH3X.11: Stuck-row backoff: a `pending_cleanup` row with `fail_count >= 3` is skipped on subsequent sweeps (`AC-EDXH3X.3` `WHERE fail_count < 3` filter), logged at `error` level once at startup naming the stuck rows, and surfaced via `cleanup_status().stuck_rows`. Schema migration adds the column once: `ALTER TABLE pending_cleanup ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`. SQLite tolerates redundant re-add via a "column already exists" catch (or check `PRAGMA table_info` first).

## Technical Design

### Modules

- **`src/extract/cleanup_sweeper.ts`** — scheduler + sweep logic + single-flight mutex. Exports `startSweeper(adapter, db)`, `stopSweeper()` (idempotent), `runOnce(adapter, db): SweepResult`.
- **`src/graph/templates/cleanup/drop_project_batch.ts`** — `MATCH (n {project_id: $project_id}) WITH n LIMIT $batch DETACH DELETE n RETURN count(n) AS deleted`. Declares `accessMode: 'WRITE'`. NOT `tenancyExempt: true` — `$project_id` IS the tenancy guard; `validateTemplateRegistry` (FR-SFQDXR AC.5) sees it and passes.
- **`src/admin/tools/run_cleanup_now.ts`** — admin MCP tool; delegates to `sweeper.runOnce()`.
- **`src/admin/tools/cleanup_status.ts`** — admin MCP tool; reads sweeper state + pending row counts.
- **`src/admin/index.ts`** — `ADMIN_TOOLS` extended with `"run_cleanup_now"` and `"cleanup_status"`.
- **`src/auth/sqlite/migrations.ts`** — adds the `fail_count` column migration; runs at startup (idempotent).
- **`src/admin/tools/delete_project.ts`** (amended) — `pending_cleanup.ref = String(project.id)`. Slug-to-project_id startup-migration helper in a new module `src/auth/sqlite/migrations/pending_cleanup_ref_fix.ts`.
- **`src/metrics/counters.ts`** — extended with the cleanup counters.
- **`src/admin/tools/server_status.ts`** — extended with `cleanup` block in the response envelope.
- **`src/server/index.ts`** — startup wires `startSweeper(adapter, db)`; `SIGTERM` calls `stopSweeper()`.

### Dependencies added

None. All work uses existing `bun:sqlite`, `neo4j-driver` (via `GraphAdapter`), and `@modelcontextprotocol/sdk`.

### Out of scope here

- Per-row exponential backoff between sweep attempts (currently flat 3-strike then skip).
- Dead-letter replay tool for extraction failures (FR-4NY6S1 territory).
- Manual operator path to clear a stuck row (workaround: `bun -e 'db.exec("UPDATE pending_cleanup SET fail_count=0 WHERE id=?")', ...'`; documented in operator notes).
- Background reconciliation of "orphan" graph nodes (nodes whose `project_id` doesn't match any `auth.sqlite.projects.id`) — not the same as `pending_cleanup` drain.

## Testing

- `src/extract/cleanup_sweeper.test.ts` — first-run-delay; interval scheduling; single-flight mutex (second concurrent call is no-op); graceful drain on `SIGTERM`; abandoned-batch behavior.
- `src/extract/cleanup_sweeper.runOnce.test.ts` — batch loop drains until `deleted === 0`; row removed on success; `fail_count` incremented on Neo4j error; row left in place on error.
- `src/extract/cleanup.test.ts` — e2e delete-then-sweep (AC-EDXH3X.9).
- `src/extract/cleanup_cross_tenant.test.ts` — adversarial isolation (AC-EDXH3X.10).
- `src/admin/tools/run_cleanup_now.test.ts` — happy path; `sweep_in_progress` when concurrent.
- `src/admin/tools/cleanup_status.test.ts` — pending_rows accuracy; stuck_rows accuracy; currently_running reflects mutex state.
- `src/admin/tools/delete_project.test.ts` — extended: assert `pending_cleanup.ref` is the project_id (numeric string).
- `src/auth/sqlite/migrations/pending_cleanup_ref_fix.test.ts` — slug-row gets translated; orphan-slug row gets dropped; numeric-row left alone; idempotency.
- `src/admin/tools/server_status.test.ts` — extended: `cleanup` block in envelope.

## Notes

- The 24h default interval is conservative — for personal scale, a deletion can wait. Operators can override via `QUACK_CLEANUP_INTERVAL_SECONDS=3600` (hourly) or trigger manually via `run_cleanup_now()`. A typical use is: admin runs `delete_project(slug)`, then `run_cleanup_now()` to make the graph reflect the change immediately rather than waiting for the next scheduled sweep.
- The slug-to-project_id migration (AC.1) is one-shot. After M3 ships and the migration runs once on startup, all pending rows carry numeric project_id; pre-existing slug rows have been translated or dropped.
- The graph delete template (`drop_project_batch`) is NOT `tenancyExempt: true` — it's project-scoped, and `$project_id` IS the tenancy guard. `validateTemplateRegistry` (FR-SFQDXR AC.5) sees `$project_id` in the cypher and passes.
- Stuck rows (`fail_count >= 3`) require operator intervention; the clearest signal is `cleanup_status().stuck_rows > 0`. Recovery: investigate the underlying Neo4j error, fix it, then either reset `fail_count` (manual SQL) or let the next deploy carry it forward if the underlying issue resolves.
- The `currently_running` flag in `cleanup_status()` is observable but transient — by the time the response is built, the sweep may have finished. Useful primarily for "I just triggered run_cleanup_now and want to know it's progressing".
- The sweeper does NOT race the extractor consumer (FR-4NY6S1): the extractor writes new nodes for active projects only (where `project_id` matches a row in `projects`), and the sweeper deletes nodes only for projects whose row is GONE. The two operate on disjoint `project_id` sets at all times under the SQLite transactional ordering.
