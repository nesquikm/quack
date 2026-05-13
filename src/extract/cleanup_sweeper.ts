import type { Database } from "bun:sqlite";
import type { GraphAdapter } from "../graph/adapter";
import { incrementError } from "../metrics/counters";

// Single-flight sweeper. Reads pending_cleanup rows with fail_count < 3 (the
// stuck-row backoff cap) and runs DETACH DELETE batches per row until the
// project's graph data is drained. Failure increments fail_count + the
// cleanup_failed error counter; success deletes the pending row.

export interface SweepResult {
  rows_processed: number;
  nodes_deleted: number;
  errors: number;
  took_ms: number;
}

export interface SweeperState {
  last_run_at: string | null;
  last_run: SweepResult | null;
  currently_running: boolean;
}

export interface Sweeper {
  runOnce(): Promise<SweepResult>;
  stop(): Promise<void>;
  state(): SweeperState;
  pendingRowCount(): number;
  stuckRowCount(): number;
}

export interface SweeperOptions {
  db: Database;
  adapter: GraphAdapter;
  // Default 1000.
  batchSize?: number;
  // Default 60 (first run delay).
  initialDelaySeconds?: number;
  // Default 86400 (24h).
  intervalSeconds?: number;
  // If true, do NOT spawn the scheduler — only manual runOnce(). Useful for
  // tests.
  manualMode?: boolean;
}

// Synthetic admin context to drive the adapter's project_id bind. The
// project_id is per-row in this case — we override ctx.project_id per call.
function adminCtxFor(projectId: number) {
  return { user_id: 0, project_id: projectId, role: "admin" as const };
}

export function createSweeper(opts: SweeperOptions): Sweeper {
  const batchSize = opts.batchSize ?? 1000;
  const initialDelay = (opts.initialDelaySeconds ?? 60) * 1000;
  const interval = (opts.intervalSeconds ?? 86400) * 1000;

  let running = false;
  let stopped = false;
  let lastRunAt: string | null = null;
  let lastRun: SweepResult | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runOnce(): Promise<SweepResult> {
    if (running) {
      // Single-flight: refuse a concurrent invocation. The caller's response
      // shape distinguishes (run_cleanup_now surfaces sweep_in_progress).
      throw new Error("sweep_in_progress");
    }
    running = true;
    const startedAt = Date.now();
    let rowsProcessed = 0;
    let nodesDeleted = 0;
    let errors = 0;
    try {
      const rows = opts.db
        .query<{ id: number; ref: string }, []>(
          `SELECT id, ref FROM pending_cleanup
           WHERE kind = 'project_graph_partition' AND fail_count < 3
           ORDER BY queued_at ASC`,
        )
        .all() as Array<{ id: number; ref: string }>;
      for (const row of rows) {
        const projectId = Number(row.ref);
        if (!Number.isFinite(projectId)) {
          opts.db.run(
            "UPDATE pending_cleanup SET fail_count = fail_count + 1 WHERE id = ?",
            [row.id],
          );
          errors += 1;
          incrementError("cleanup_failed");
          continue;
        }
        try {
          // Drain by repeated batched delete until 0 returned.
          while (true) {
            const out = await opts.adapter.run<
              { batch: number; project_id?: number },
              { deleted: number }
            >("cleanup.drop_project_batch", { batch: batchSize }, adminCtxFor(projectId));
            const deleted = Number(out.rows[0]?.deleted ?? 0);
            nodesDeleted += deleted;
            if (deleted === 0) break;
          }
          opts.db.run("DELETE FROM pending_cleanup WHERE id = ?", [row.id]);
          rowsProcessed += 1;
        } catch (err) {
          errors += 1;
          incrementError("cleanup_failed");
          opts.db.run(
            "UPDATE pending_cleanup SET fail_count = fail_count + 1 WHERE id = ?",
            [row.id],
          );
          console.error(`cleanup_failed project_id=${projectId} err=${String(err)}`);
        }
      }
    } finally {
      running = false;
    }
    const took = Date.now() - startedAt;
    const result: SweepResult = {
      rows_processed: rowsProcessed,
      nodes_deleted: nodesDeleted,
      errors,
      took_ms: took,
    };
    lastRun = result;
    lastRunAt = new Date().toISOString();
    return result;
  }

  function pendingRowCount(): number {
    const row = opts.db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) as c FROM pending_cleanup WHERE kind = 'project_graph_partition'`,
      )
      .get();
    return row?.c ?? 0;
  }

  function stuckRowCount(): number {
    const row = opts.db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) as c FROM pending_cleanup WHERE kind = 'project_graph_partition' AND fail_count >= 3`,
      )
      .get();
    return row?.c ?? 0;
  }

  // Stuck-row startup log (AC.11) — emit once on construction if any present.
  const stuck = stuckRowCount();
  if (stuck > 0) {
    console.error(`cleanup_stuck_rows count=${stuck}`);
  }

  if (!opts.manualMode) {
    const scheduleNext = (delayMs: number) => {
      if (stopped) return;
      timer = setTimeout(async () => {
        try {
          await runOnce();
        } catch {
          // single-flight collision is fine; log? swallow.
        }
        scheduleNext(interval);
      }, delayMs);
    };
    scheduleNext(initialDelay);
  }

  return {
    runOnce,
    state(): SweeperState {
      return { last_run_at: lastRunAt, last_run: lastRun, currently_running: running };
    },
    pendingRowCount,
    stuckRowCount,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      while (running) {
        await Bun.sleep(20);
      }
    },
  };
}
