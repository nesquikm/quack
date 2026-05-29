import type { GraphAdapter } from "../graph/adapter";
import type { AuthContext } from "../auth/middleware";
import type { BoundedQueue } from "./queue";
import type { Redactor } from "./redact";
import type { ExtractionClient } from "./client";
import type { DeadLetterWriter } from "./dead_letter";
import { incrementError } from "../metrics/counters";
import { writeExtraction } from "./writer";

// Hook envelope shape — kept duck-typed here so we don't take a circular dep on
// the ingest handler. `project_slug` is optional and mirrors HookEnvelope's
// top-level field (FR-4NY6S1 / FR-41NXTZ AC.3): hook clients may omit it;
// add_memory always sets it.
export interface QueuedEnvelope {
  kind: string;
  payload: unknown;
  ctx: AuthContext;
  queued_at: string;
  project_slug?: string;
  // Optional trusted-input sub-project tag. Hook clients set it from the
  // HookEnvelope; add_memory (AC-A9BN0M.7) sets it from the validated
  // X-Quack-Sub-Project request header. Absent ⇒ node `source` defaults to [].
  sub_project?: string;
}

export interface ConsumerOptions {
  queue: BoundedQueue<QueuedEnvelope>;
  adapter: GraphAdapter;
  redactor: Redactor;
  client: ExtractionClient;
  deadLetter: DeadLetterWriter;
  concurrency: number;
  // Poll interval when queue is empty.
  pollMs?: number;
}

export interface Consumer {
  stop(reason?: string): Promise<void>;
  // For tests: tickle the loop to process whatever is currently queued.
  drainOnce(): Promise<void>;
}

export function startConsumer(opts: ConsumerOptions): Consumer {
  const { queue, adapter, redactor, client, deadLetter, concurrency } = opts;
  const pollMs = opts.pollMs ?? 50;
  let stopped = false;
  let inFlight = 0;

  async function processOne(env: QueuedEnvelope): Promise<void> {
    try {
      const { value: redactedPayload, matchCount } = redactor.redact(env.payload);
      if (matchCount > 0) incrementError("redaction_match");
      const result = await client.extract({ kind: env.kind, payload: redactedPayload });
      await writeExtraction(adapter, env.ctx, result, new Date().toISOString(), {
        kind: env.kind,
        sub_project: env.sub_project,
      });
    } catch (err) {
      incrementError("extraction_failed");
      deadLetter.append({
        ts: new Date().toISOString(),
        hook_kind: env.kind,
        project_id: env.ctx.project_id,
        error: {
          kind: errorKind(err),
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      while (!stopped && inFlight < concurrency) {
        const env = queue.dequeue();
        if (!env) break;
        inFlight += 1;
        void processOne(env).finally(() => {
          inFlight -= 1;
        });
      }
      await Bun.sleep(pollMs);
    }
  }

  void loop();

  return {
    async stop(reason: string = "shutdown"): Promise<void> {
      stopped = true;
      const abandoned = queue.getDepth();
      // Wait for in-flight tasks to settle.
      while (inFlight > 0) {
        await Bun.sleep(20);
      }
      console.log(`extractor_shutdown reason=${reason} abandoned=${abandoned}`);
    },
    async drainOnce(): Promise<void> {
      while (queue.getDepth() > 0 || inFlight > 0) {
        await Bun.sleep(20);
      }
    },
  };
}

function errorKind(err: unknown): string {
  if (err && typeof err === "object") {
    const name = (err as { name?: string }).name;
    if (name && typeof name === "string") return name;
  }
  return "unknown";
}
