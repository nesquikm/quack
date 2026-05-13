import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../auth/sqlite/schema";
import { bootstrapAdmin } from "../auth/bootstrap";
import { handleIngest, HookEnvelopeSchema } from "./handler";
import { BoundedQueue } from "../extract/queue";
import { resetCountersForTests, getSnapshot, setQueueDepthSource } from "../metrics/counters";
import type { AuthContext } from "../auth/middleware";
import type { QueuedEnvelope } from "../extract/consumer";

const adminCtx: AuthContext = { user_id: 1, project_id: 1, role: "admin" };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

function postRequest(body: unknown): Request {
  return new Request("http://test/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleIngest", () => {
  beforeEach(() => {
    resetCountersForTests();
    setQueueDepthSource(null);
  });

  test("envelope validated (happy path): 202 accepted + queued_at", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(postRequest({ kind: "stop", payload: { x: 1 } }), adminCtx, { queue, db });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(typeof body.queued_at).toBe("string");
    expect(queue.getDepth()).toBe(1);
  });

  test("malformed JSON → 400 invalid_envelope", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(postRequest("not-json"), adminCtx, { queue, db });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_envelope");
  });

  test("Zod refusal (bad kind) → 400 invalid_envelope with path", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(postRequest({ kind: "garbage", payload: {} }), adminCtx, { queue, db });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_envelope");
    expect(body.path).toContain("kind");
  });

  test("queue_full → 202 accepted:false", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(1);
    queue.enqueue({ kind: "stop", payload: {}, ctx: adminCtx, queued_at: "" });
    const res = await handleIngest(postRequest({ kind: "stop", payload: {} }), adminCtx, { queue, db });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("queue_full");
    expect(body.queued_at).toBeNull();
    // queue_full counter increments.
    expect(getSnapshot().errors.by_category["queue_full"]).toBe(1);
  });

  test("project_slug mismatch → 403", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(
      postRequest({ kind: "stop", payload: {}, project_slug: "other-project" }),
      adminCtx,
      { queue, db },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("project_mismatch");
  });

  test("project_slug match → 202 accepted", async () => {
    const db = seededDb();
    const slugRow = db.query<{ slug: string }, [number]>("SELECT slug FROM projects WHERE id = ?").get(1);
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(
      postRequest({ kind: "stop", payload: {}, project_slug: slugRow!.slug }),
      adminCtx,
      { queue, db },
    );
    expect(res.status).toBe(202);
  });

  test("HookEnvelopeSchema accepts the three M3 hook kinds", () => {
    for (const kind of ["session_start", "stop", "post_tool_use"]) {
      const parsed = HookEnvelopeSchema.safeParse({ kind, payload: {} });
      expect(parsed.success).toBe(true);
    }
  });
});
