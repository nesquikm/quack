import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { AdminToolError } from "../errors";
import { getSweeper } from "./_cleanup_holder";

export const runCleanupNowSchema = z.object({}).strict();

export interface RunCleanupNowResult {
  rows_processed: number;
  nodes_deleted: number;
  errors: number;
  took_ms: number;
}

export async function runCleanupNow(
  _args: unknown,
  _ctx: AuthContext,
  _db: Database,
): Promise<RunCleanupNowResult> {
  const sweeper = getSweeper();
  if (!sweeper) throw new AdminToolError("sweeper_not_wired");
  try {
    return await sweeper.runOnce();
  } catch (err) {
    if (err instanceof Error && err.message === "sweep_in_progress") {
      throw new AdminToolError("sweep_in_progress");
    }
    throw err;
  }
}
