import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../auth/sqlite/schema";
import { createSweeper } from "./cleanup_sweeper";
import { resetCountersForTests, getSnapshot } from "../metrics/counters";
import type { GraphAdapter } from "../graph/adapter";
import type { AuthContext } from "../auth/middleware";

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  // Insert a project so FK constraints don't kill us; project_id=1 is the
  // bootstrap project. We use 1000+ for cleanup test rows so we don't
  // collide with admin tooling assumptions.
  db.run(
    `INSERT INTO projects(id, slug, display_name) VALUES (1000, 'cleanup-A', 'A'), (2000, 'cleanup-B', 'B')`,
  );
  return db;
}

function fakeAdapter(
  perCallDeleted: number[],
  log: Array<{ project_id: number; batch: number }>,
): GraphAdapter {
  let i = 0;
  return {
    async run(_id: string, params: unknown, ctx: AuthContext) {
      const deleted = perCallDeleted[i++] ?? 0;
      log.push({ project_id: ctx.project_id, batch: (params as { batch: number }).batch });
      return { rows: [{ deleted }] };
    },
  } as GraphAdapter;
}

function failingAdapter(): GraphAdapter {
  return {
    async run() {
      throw new Error("graph is unhappy");
    },
  } as GraphAdapter;
}

describe("createSweeper.runOnce", () => {
  beforeEach(() => resetCountersForTests());

  test("batch loop drains until deleted=0; row removed on success", async () => {
    const db = seededDb();
    db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      ["1000"],
    );
    const log: Array<{ project_id: number; batch: number }> = [];
    const adapter = fakeAdapter([1000, 500, 0], log);
    const sweeper = createSweeper({ db, adapter, batchSize: 1000, manualMode: true });
    const out = await sweeper.runOnce();
    expect(out.rows_processed).toBe(1);
    expect(out.nodes_deleted).toBe(1500);
    expect(out.errors).toBe(0);
    // Adapter called 3x (1000 + 500 + 0); each time with project_id=1000.
    expect(log.length).toBe(3);
    expect(log.every((c) => c.project_id === 1000)).toBe(true);
    // Row gone from the pending table.
    const remaining = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM pending_cleanup")
      .get();
    expect(remaining?.c).toBe(0);
  });

  test("Neo4j error → fail_count++; row stays; cleanup_failed counter increments", async () => {
    const db = seededDb();
    db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      ["1000"],
    );
    const sweeper = createSweeper({ db, adapter: failingAdapter(), manualMode: true });
    const out = await sweeper.runOnce();
    expect(out.errors).toBe(1);
    const row = db
      .query<{ fail_count: number }, []>("SELECT fail_count FROM pending_cleanup WHERE id = 1")
      .get();
    expect(row?.fail_count).toBe(1);
    expect(getSnapshot().errors.by_category["cleanup_failed"]).toBe(1);
  });

  test("single-flight: a concurrent runOnce throws sweep_in_progress", async () => {
    const db = seededDb();
    db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      ["1000"],
    );
    // Adapter that pauses, so the first run is in-flight while we trigger
    // a second runOnce.
    const adapter: GraphAdapter = {
      async run() {
        await Bun.sleep(60);
        return { rows: [{ deleted: 0 }] };
      },
    } as GraphAdapter;
    const sweeper = createSweeper({ db, adapter, manualMode: true });
    const first = sweeper.runOnce();
    // Yield so the lock takes effect.
    await Bun.sleep(10);
    await expect(sweeper.runOnce()).rejects.toThrow("sweep_in_progress");
    await first;
  });

  test("stuck rows (fail_count >= 3) are skipped + visible via stuckRowCount", async () => {
    const db = seededDb();
    db.run(
      "INSERT INTO pending_cleanup(kind, ref, fail_count) VALUES ('project_graph_partition', ?, 3)",
      ["1000"],
    );
    const sweeper = createSweeper({ db, adapter: failingAdapter(), manualMode: true });
    expect(sweeper.stuckRowCount()).toBe(1);
    const out = await sweeper.runOnce();
    expect(out.rows_processed).toBe(0);
    expect(out.errors).toBe(0);
  });

  test("non-numeric ref increments fail_count + cleanup_failed", async () => {
    const db = seededDb();
    db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      ["not-a-number"],
    );
    const sweeper = createSweeper({ db, adapter: failingAdapter(), manualMode: true });
    const out = await sweeper.runOnce();
    expect(out.errors).toBe(1);
    const row = db
      .query<{ fail_count: number }, []>("SELECT fail_count FROM pending_cleanup WHERE id = 1")
      .get();
    expect(row?.fail_count).toBe(1);
  });

  test("state() reflects last_run + last_run_at + currently_running", async () => {
    const db = seededDb();
    db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      ["1000"],
    );
    const adapter = fakeAdapter([0], []);
    const sweeper = createSweeper({ db, adapter, manualMode: true });
    expect(sweeper.state().last_run_at).toBeNull();
    await sweeper.runOnce();
    expect(sweeper.state().last_run_at).not.toBeNull();
    expect(sweeper.state().last_run).not.toBeNull();
    expect(sweeper.state().currently_running).toBe(false);
  });
});
