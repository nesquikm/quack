import { describe, test, expect, beforeEach } from "bun:test";
import { BoundedQueue } from "./queue";
import { createRedactor } from "./redact";
import { startConsumer, type QueuedEnvelope } from "./consumer";
import { resetCountersForTests, getSnapshot } from "../metrics/counters";
import type { GraphAdapter } from "../graph/adapter";
import type { ExtractionClient } from "./client";
import type { DeadLetterWriter, DeadLetterEntry } from "./dead_letter";
import type { AuthContext } from "../auth/middleware";

const ctx: AuthContext = { user_id: 1, project_id: 1, role: "admin" };

function makeAdapter(): GraphAdapter {
  return { async run() { return { rows: [{ id: "x" }] }; } } as GraphAdapter;
}

function makeFakeClient(
  result: import("./client").ExtractionResult,
  callCounter: { n: number },
): ExtractionClient {
  return {
    async extract() {
      callCounter.n += 1;
      return result;
    },
  };
}

function makeFailingClient(errFn: () => Error): ExtractionClient {
  return {
    async extract() {
      throw errFn();
    },
  };
}

function makeDeadLetter(entries: DeadLetterEntry[]): DeadLetterWriter {
  return { append(e) { entries.push(e); } };
}

const EMPTY_RESULT: import("./client").ExtractionResult = {
  entities: [],
  decisions: [],
  files: [],
  symbols: [],
  feedbacks: [],
  relations: [],
};

describe("startConsumer", () => {
  beforeEach(() => resetCountersForTests());

  test("drains queue with bounded concurrency", async () => {
    const queue = new BoundedQueue<QueuedEnvelope>(100);
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ kind: "stop", payload: { i }, ctx, queued_at: "t" });
    }
    const calls = { n: 0 };
    const consumer = startConsumer({
      queue,
      adapter: makeAdapter(),
      redactor: createRedactor(),
      client: makeFakeClient(EMPTY_RESULT, calls),
      deadLetter: makeDeadLetter([]),
      concurrency: 2,
      pollMs: 10,
    });
    await consumer.drainOnce();
    await consumer.stop("test");
    expect(calls.n).toBe(5);
  });

  test("client error → dead-letter + extraction_failed counter", async () => {
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    queue.enqueue({ kind: "stop", payload: {}, ctx, queued_at: "t" });
    const dlEntries: DeadLetterEntry[] = [];
    const consumer = startConsumer({
      queue,
      adapter: makeAdapter(),
      redactor: createRedactor(),
      client: makeFailingClient(() => new Error("model is unhappy")),
      deadLetter: makeDeadLetter(dlEntries),
      concurrency: 1,
      pollMs: 10,
    });
    await consumer.drainOnce();
    await consumer.stop("test");
    expect(dlEntries.length).toBe(1);
    expect(dlEntries[0]?.error.message).toContain("model is unhappy");
    expect(getSnapshot().errors.by_category["extraction_failed"]).toBe(1);
  });

  test("redaction_match counter fires when payload had secrets", async () => {
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    queue.enqueue({
      kind: "stop",
      payload: { secret: "Authorization: Bearer my-token-1234567890ab" },
      ctx,
      queued_at: "t",
    });
    const calls = { n: 0 };
    const consumer = startConsumer({
      queue,
      adapter: makeAdapter(),
      redactor: createRedactor(),
      client: makeFakeClient(EMPTY_RESULT, calls),
      deadLetter: makeDeadLetter([]),
      concurrency: 1,
      pollMs: 10,
    });
    await consumer.drainOnce();
    await consumer.stop("test");
    expect(getSnapshot().errors.by_category["redaction_match"]).toBe(1);
  });

  // AC-41NXTZ.6: redaction pass runs against payload.content BEFORE cheap-model
  // call when kind === "explicit_add". The consumer's existing redactor walks
  // every string in env.payload, so a secret embedded inside payload.content
  // must reach client.extract redacted. This is the add_memory-specific path.
  test("AC-41NXTZ.6: explicit_add payload.content is redacted before cheap-model call", async () => {
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    queue.enqueue({
      kind: "explicit_add",
      payload: { content: "ship key=sk-abcdefghijklmnopqrstuvwx today" },
      ctx,
      queued_at: "t",
    });
    let observedPayload: unknown = undefined;
    const client: ExtractionClient = {
      async extract(arg) {
        observedPayload = (arg as { payload?: unknown } | undefined)?.payload;
        return EMPTY_RESULT;
      },
    };
    const consumer = startConsumer({
      queue,
      adapter: makeAdapter(),
      redactor: createRedactor(),
      client,
      deadLetter: makeDeadLetter([]),
      concurrency: 1,
      pollMs: 10,
    });
    await consumer.drainOnce();
    await consumer.stop("test");
    const content = (observedPayload as { content?: string } | undefined)?.content ?? "";
    expect(content).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(content).toContain("«REDACTED»");
    expect(getSnapshot().errors.by_category["redaction_match"]).toBeGreaterThanOrEqual(1);
  });
});
