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

  // AC-41NXTZ.5 — HookKind union is extended with "explicit_add".
  test("AC-41NXTZ.5: HookEnvelopeSchema accepts kind: 'explicit_add' (M5 extension)", () => {
    const parsed = HookEnvelopeSchema.safeParse({
      kind: "explicit_add",
      payload: { content: "remember this" },
    });
    expect(parsed.success).toBe(true);
  });

  test("AC-41NXTZ.5: M3 hook kinds remain accepted after M5 union extension (backward-compat)", () => {
    // Ordering guarantee from the AC: "session_start | stop | post_tool_use | explicit_add".
    // The existing three kinds must NOT regress.
    for (const kind of ["session_start", "stop", "post_tool_use", "explicit_add"]) {
      const parsed = HookEnvelopeSchema.safeParse({ kind, payload: {} });
      expect(parsed.success).toBe(true);
    }
  });

  // AC-A9BN0M.1 — sub_project flows through the ingest handler. Absent is
  // valid; a slug-shaped value is accepted; a malformed value ⇒ 400
  // invalid_envelope with path ["sub_project"].
  test("AC-A9BN0M.1: absent sub_project → 202 accepted", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(postRequest({ kind: "stop", payload: {} }), adminCtx, { queue, db });
    expect(res.status).toBe(202);
  });

  test("AC-A9BN0M.1: slug-shaped sub_project → 202 accepted", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(
      postRequest({ kind: "stop", payload: {}, sub_project: "backend-api" }),
      adminCtx,
      { queue, db },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
  });

  test("AC-A9BN0M.1: malformed sub_project → 400 invalid_envelope path ['sub_project']", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const res = await handleIngest(
      postRequest({ kind: "stop", payload: {}, sub_project: "Bad Slug!" }),
      adminCtx,
      { queue, db },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_envelope");
    expect(body.path).toContain("sub_project");
    // Malformed envelope must not enqueue.
    expect(queue.getDepth()).toBe(0);
  });

  test("AC-A9BN0M.1: HookEnvelopeSchema accepts an optional sub_project", () => {
    expect(HookEnvelopeSchema.safeParse({ kind: "stop", payload: {}, sub_project: "frontend" }).success).toBe(true);
    expect(HookEnvelopeSchema.safeParse({ kind: "stop", payload: {}, sub_project: "UPPER" }).success).toBe(false);
  });
});
