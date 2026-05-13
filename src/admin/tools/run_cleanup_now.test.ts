import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { runCleanupNow } from "./run_cleanup_now";
import { setSweeper, resetSweeperForTests } from "./_cleanup_holder";
import type { Sweeper } from "../../extract/cleanup_sweeper";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function fakeSweeper(opts: { result?: { rows_processed: number; nodes_deleted: number; errors: number; took_ms: number }; throwsInProgress?: boolean }): Sweeper {
  return {
    async runOnce() {
      if (opts.throwsInProgress) throw new Error("sweep_in_progress");
      return opts.result ?? { rows_processed: 0, nodes_deleted: 0, errors: 0, took_ms: 0 };
    },
    state() {
      return { last_run_at: null, last_run: null, currently_running: false };
    },
    pendingRowCount() {
      return 0;
    },
    stuckRowCount() {
      return 0;
    },
    async stop() {},
  };
}

describe("runCleanupNow", () => {
  beforeEach(() => resetSweeperForTests());

  test("happy path returns SweepResult", async () => {
    const db = seededDb();
    setSweeper(fakeSweeper({ result: { rows_processed: 2, nodes_deleted: 1500, errors: 0, took_ms: 42 } }));
    const out = await runCleanupNow({}, adminCtx, db);
    expect(out.rows_processed).toBe(2);
    expect(out.nodes_deleted).toBe(1500);
  });

  test("sweep_in_progress → AdminToolError('sweep_in_progress')", async () => {
    const db = seededDb();
    setSweeper(fakeSweeper({ throwsInProgress: true }));
    await expect(runCleanupNow({}, adminCtx, db)).rejects.toMatchObject({ code: "sweep_in_progress" });
  });

  test("sweeper not wired → AdminToolError('sweeper_not_wired')", async () => {
    const db = seededDb();
    await expect(runCleanupNow({}, adminCtx, db)).rejects.toMatchObject({ code: "sweeper_not_wired" });
  });
});
