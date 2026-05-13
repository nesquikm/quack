import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { cleanupStatus } from "./cleanup_status";
import { setSweeper, resetSweeperForTests } from "./_cleanup_holder";
import type { Sweeper } from "../../extract/cleanup_sweeper";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  db.run(`INSERT INTO projects(id, slug, display_name) VALUES (1000, 'x', 'X')`);
  return db;
}

const okSweeper: Sweeper = {
  async runOnce() {
    return { rows_processed: 0, nodes_deleted: 0, errors: 0, took_ms: 0 };
  },
  state() {
    return {
      last_run_at: "2026-05-13T10:00:00Z",
      last_run: { rows_processed: 1, nodes_deleted: 10, errors: 0, took_ms: 5 },
      currently_running: false,
    };
  },
  pendingRowCount() {
    return 0;
  },
  stuckRowCount() {
    return 0;
  },
  async stop() {},
};

describe("cleanupStatus", () => {
  beforeEach(() => resetSweeperForTests());

  test("pending_rows accuracy", () => {
    const db = seededDb();
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', '1000')");
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', '2000')");
    setSweeper(okSweeper);
    const out = cleanupStatus({}, adminCtx, db);
    expect(out.pending_rows).toBe(2);
  });

  test("stuck_rows reflects fail_count >= 3 only", () => {
    const db = seededDb();
    db.run("INSERT INTO pending_cleanup(kind, ref, fail_count) VALUES ('project_graph_partition', '1000', 0)");
    db.run("INSERT INTO pending_cleanup(kind, ref, fail_count) VALUES ('project_graph_partition', '2000', 3)");
    db.run("INSERT INTO pending_cleanup(kind, ref, fail_count) VALUES ('project_graph_partition', '3000', 5)");
    setSweeper(okSweeper);
    const out = cleanupStatus({}, adminCtx, db);
    expect(out.stuck_rows).toBe(2);
    expect(out.pending_rows).toBe(3);
  });

  test("reports sweeper state when wired", () => {
    const db = seededDb();
    setSweeper(okSweeper);
    const out = cleanupStatus({}, adminCtx, db);
    expect(out.last_run_at).toBe("2026-05-13T10:00:00Z");
    expect(out.last_run?.nodes_deleted).toBe(10);
    expect(out.currently_running).toBe(false);
  });

  test("zero state when sweeper not wired", () => {
    const db = seededDb();
    const out = cleanupStatus({}, adminCtx, db);
    expect(out.last_run_at).toBeNull();
    expect(out.last_run).toBeNull();
    expect(out.currently_running).toBe(false);
  });
});
