import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../auth/middleware";
import type { BoundedQueue } from "../extract/queue";
import type { QueuedEnvelope } from "../extract/consumer";
import { incrementError } from "../metrics/counters";
import { queueIncrement } from "../metrics/counters";

// HookEnvelope per AC-4NY6S1.1. HookKind is the literal-string union from
// FR-S2D0Z5 — for M3 we ship session_start / stop / post_tool_use.
// FR-41NXTZ AC.5 (M5) — extended with "explicit_add" for the add_memory MCP tool.
export const HookKindSchema = z.enum([
  "session_start",
  "stop",
  "post_tool_use",
  "explicit_add",
]);
export const HookEnvelopeSchema = z.object({
  kind: HookKindSchema,
  payload: z.record(z.string(), z.unknown()),
  project_slug: z.string().optional(),
  ts: z.string().optional(),
});

export type HookEnvelope = z.infer<typeof HookEnvelopeSchema>;

export interface IngestDeps {
  queue: BoundedQueue<QueuedEnvelope>;
  db: Database;
}

export async function handleIngest(request: Request, ctx: AuthContext, deps: IngestDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    incrementError("invalid_envelope");
    return jsonResponse(400, { error: "invalid_envelope", path: ["body"] });
  }
  const parsed = HookEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    incrementError("invalid_envelope");
    return jsonResponse(400, {
      error: "invalid_envelope",
      path: parsed.error.issues[0]?.path ?? [],
      message: parsed.error.issues[0]?.message ?? "validation failed",
    });
  }
  const env = parsed.data;

  if (env.project_slug !== undefined) {
    // Defense against a future hook client that knows multiple tokens —
    // resolve the caller's project's slug and refuse on mismatch.
    const row = deps.db
      .query<{ slug: string }, [number]>("SELECT slug FROM projects WHERE id = ?")
      .get(ctx.project_id);
    if (!row || row.slug !== env.project_slug) {
      incrementError("project_mismatch");
      return jsonResponse(403, { error: "project_mismatch" });
    }
  }

  const queuedAt = new Date().toISOString();
  const ok = deps.queue.enqueue({
    kind: env.kind,
    payload: env.payload,
    ctx,
    queued_at: queuedAt,
  });
  if (!ok) {
    incrementError("queue_full");
    return jsonResponse(202, { accepted: false, reason: "queue_full", queued_at: null });
  }
  queueIncrement("accepted_total");
  return jsonResponse(202, { accepted: true, queued_at: queuedAt });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
