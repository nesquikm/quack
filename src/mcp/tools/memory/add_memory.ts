import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../../auth/middleware";
import type { BoundedQueue } from "../../../extract/queue";
import type { QueuedEnvelope } from "../../../extract/consumer";
import { incrementError, queueIncrement } from "../../../metrics/counters";
import { getAddMemoryMaxBytes } from "../../../shared/env";

// Schema's max-byte cap is read once at module-load from
// QUACK_ADD_MEMORY_MAX_BYTES via a narrow env reader (Bun.env is set before
// any module imports in production startup). The narrow reader avoids
// requiring a fully-populated env at import time, which would otherwise force
// every unit test to set QUACK_NEO4J_PASSWORD just to import this file.
export const addMemorySchema = z.object({
  content: z.string().min(1).max(getAddMemoryMaxBytes()),
});

export type AddMemoryArgs = z.infer<typeof addMemorySchema>;

export interface AddMemoryDeps {
  queue: BoundedQueue<QueuedEnvelope>;
  db: Database;
  // AC-A9BN0M.7: the sub-project the MCP request path resolved from the
  // X-Quack-Sub-Project header (already validated). Absent ⇒ envelope omits it.
  sub_project?: string;
}

export interface AddMemoryResult {
  accepted: boolean;
  queued_at: string | null;
  reason?: string;
}

export async function addMemory(
  args: AddMemoryArgs,
  ctx: AuthContext,
  deps: AddMemoryDeps,
): Promise<AddMemoryResult> {
  // AC-41NXTZ.3: resolve project_slug from auth.sqlite by ctx.project_id.
  const row = deps.db
    .query<{ slug: string }, [number]>("SELECT slug FROM projects WHERE id = ?")
    .get(ctx.project_id);
  const projectSlug = row?.slug;

  const queuedAt = new Date().toISOString();
  // Mirror HookEnvelope (FR-4NY6S1 AC.1): expose project_slug both on the
  // payload (so the model branch in src/extract/prompt.ts sees it) and on the
  // envelope top-level (declared on QueuedEnvelope for symmetric typing).
  const envelope: QueuedEnvelope = {
    kind: "explicit_add",
    payload: { content: args.content, project_slug: projectSlug },
    ctx,
    queued_at: queuedAt,
    project_slug: projectSlug,
    // AC-A9BN0M.7: stamp the resolved sub-project; omitted when deps carry none.
    ...(deps.sub_project !== undefined ? { sub_project: deps.sub_project } : {}),
  };

  const ok = deps.queue.enqueue(envelope);
  if (!ok) {
    incrementError("queue_full");
    queueIncrement("dropped_full_total");
    return { accepted: false, reason: "queue_full", queued_at: null };
  }
  queueIncrement("accepted_total");
  // AC-41NXTZ.10: info-level counter for explicit_add traffic.
  incrementError("explicit_add_received");
  return { accepted: true, queued_at: queuedAt };
}
