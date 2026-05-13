import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { getSweeper } from "./_cleanup_holder";
import type { SweepResult } from "../../extract/cleanup_sweeper";

export const cleanupStatusSchema = z.object({}).strict();

export interface CleanupStatusResult {
  pending_rows: number;
  stuck_rows: number;
  last_run_at: string | null;
  last_run: SweepResult | null;
  currently_running: boolean;
}

export function cleanupStatus(
  _args: unknown,
  _ctx: AuthContext,
  db: Database,
): CleanupStatusResult {
  const sweeper = getSweeper();
  // If the sweeper isn't wired, report static rows from SQLite and zero
  // sweeper state. This allows the tool to be useful for diagnostics even
  // when the extractor is disabled.
  const pendingRow = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) as c FROM pending_cleanup WHERE kind = 'project_graph_partition'`,
    )
    .get();
  const stuckRow = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) as c FROM pending_cleanup WHERE kind = 'project_graph_partition' AND fail_count >= 3`,
    )
    .get();
  const pending_rows = pendingRow?.c ?? 0;
  const stuck_rows = stuckRow?.c ?? 0;
  if (!sweeper) {
    return {
      pending_rows,
      stuck_rows,
      last_run_at: null,
      last_run: null,
      currently_running: false,
    };
  }
  const state = sweeper.state();
  return {
    pending_rows,
    stuck_rows,
    last_run_at: state.last_run_at,
    last_run: state.last_run,
    currently_running: state.currently_running,
  };
}
