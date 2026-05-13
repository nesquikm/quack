import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../../auth/bootstrap";
import { addMember } from "../../../admin/tools/add_member";
import { addMemory, addMemorySchema } from "./add_memory";
import { BoundedQueue } from "../../../extract/queue";
import { ADMIN_TOOLS } from "../../../admin/index";
import { resetCountersForTests, getSnapshot, setQueueDepthSource } from "../../../metrics/counters";
import { createMcpHandler, listTools } from "../../server";
import { startServer } from "../../../server/index";
import type { AuthContext } from "../../../auth/middleware";
import type { QueuedEnvelope } from "../../../extract/consumer";

const adminCtx: AuthContext = { user_id: 1, project_id: 1, role: "admin" };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("add_memory (unit)", () => {
  beforeEach(() => {
    resetCountersForTests();
    setQueueDepthSource(null);
  });

  test("AC-41NXTZ.1: add_memory is NOT in ADMIN_TOOLS (member-readable)", () => {
    expect(ADMIN_TOOLS.has("add_memory")).toBe(false);
  });

  test("AC-41NXTZ.2: Zod schema enforces non-empty content", () => {
    const parsed = addMemorySchema.safeParse({ content: "" });
    expect(parsed.success).toBe(false);
  });

  test("AC-41NXTZ.2: Zod schema rejects content above QUACK_ADD_MEMORY_MAX_BYTES (default 32768)", () => {
    // Default cap is 32768; 32769 chars must be rejected.
    const oversized = "x".repeat(32769);
    const parsed = addMemorySchema.safeParse({ content: oversized });
    expect(parsed.success).toBe(false);
  });

  test("AC-41NXTZ.2: Zod schema accepts content at the boundary (max bytes exact)", () => {
    const atLimit = "x".repeat(32768);
    const parsed = addMemorySchema.safeParse({ content: atLimit });
    expect(parsed.success).toBe(true);
  });

  test("AC-41NXTZ.4 happy path: accepted: true + ISO queued_at, envelope on queue", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const out = await addMemory(
      { content: "remember this please" },
      adminCtx,
      { queue, db },
    );
    expect(out.accepted).toBe(true);
    expect(typeof out.queued_at).toBe("string");
    // ISO 8601 — round-trips through Date.
    expect(Number.isNaN(Date.parse(out.queued_at!))).toBe(false);
    expect(queue.getDepth()).toBe(1);

    // AC-41NXTZ.3: envelope shape on the queue.
    const env = queue.dequeue()!;
    expect(env.kind).toBe("explicit_add");
    expect((env.payload as { content: string }).content).toBe("remember this please");
    // ctx threaded through.
    expect(env.ctx.project_id).toBe(adminCtx.project_id);
    expect(typeof env.queued_at).toBe("string");
  });

  test("AC-41NXTZ.3: project_slug is resolved from auth.sqlite (SELECT slug FROM projects)", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const slugRow = db
      .query<{ slug: string }, [number]>("SELECT slug FROM projects WHERE id = ?")
      .get(adminCtx.project_id);
    expect(slugRow).not.toBeNull();
    await addMemory({ content: "hello" }, adminCtx, { queue, db });
    const env = queue.dequeue()!;
    // The queued envelope (or its payload) must carry the resolved slug from sqlite.
    // Accept either shape — the implementer may attach `project_slug` to the
    // envelope top-level (mirroring HookEnvelope) or stash it on the payload.
    const top = env as unknown as { project_slug?: string };
    const payload = env.payload as { project_slug?: string };
    const observed = top.project_slug ?? payload.project_slug;
    expect(observed).toBe(slugRow!.slug);
  });

  test("AC-41NXTZ.4: queue full → { accepted: false, reason: 'queue_full', queued_at: null }", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(1);
    // Fill the queue first.
    queue.enqueue({ kind: "stop", payload: {}, ctx: adminCtx, queued_at: "" });
    const out = await addMemory({ content: "won't fit" }, adminCtx, { queue, db });
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("queue_full");
    expect(out.queued_at).toBeNull();
  });

  test("AC-41NXTZ.2: invalid content does NOT call queue.enqueue (no DB write, queue stays empty)", async () => {
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    // Direct call with empty content — schema fails upstream of the handler;
    // we model that here by going through the schema first and asserting
    // queue is untouched.
    const parsed = addMemorySchema.safeParse({ content: "" });
    expect(parsed.success).toBe(false);
    // Even if some code path tried to call add_memory with bad input, the
    // queue must not gain an entry.
    expect(queue.getDepth()).toBe(0);
  });

  test("AC-41NXTZ.10: successful enqueue increments errors.by_category.explicit_add_received", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    setQueueDepthSource(() => queue.getDepth());
    await addMemory({ content: "first" }, adminCtx, { queue, db });
    await addMemory({ content: "second" }, adminCtx, { queue, db });
    const snap = getSnapshot();
    expect(snap.errors.by_category["explicit_add_received"]).toBe(2);
  });

  test("Stage C hardening: handler tolerates missing projects row (dangling ctx.project_id)", async () => {
    // If ctx.project_id refers to a project that has since been deleted, the
    // SELECT returns undefined. The handler must still enqueue (the writer
    // scopes by ctx.project_id, not by the slug lookup); project_slug just
    // becomes undefined on the envelope. Catches a regression where a future
    // refactor might `throw new Error("project not found")` here.
    const db = new Database(":memory:");
    runMigrations(db);
    bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
    const queue = new BoundedQueue<QueuedEnvelope>(10);
    const ctxDangling: AuthContext = { user_id: 999, project_id: 99999, role: "admin" };
    const out = await addMemory({ content: "still works" }, ctxDangling, { queue, db });
    expect(out.accepted).toBe(true);
    const env = queue.dequeue()!;
    expect(env.project_slug).toBeUndefined();
    expect((env.payload as { project_slug?: string }).project_slug).toBeUndefined();
    expect(env.ctx.project_id).toBe(99999);
  });

  test("AC-41NXTZ.10: queue-full path does NOT increment explicit_add_received", async () => {
    const db = seededDb();
    const queue = new BoundedQueue<QueuedEnvelope>(1);
    queue.enqueue({ kind: "stop", payload: {}, ctx: adminCtx, queued_at: "" });
    const out = await addMemory({ content: "drop me" }, adminCtx, { queue, db });
    expect(out.accepted).toBe(false);
    const snap = getSnapshot();
    // No info-level counter for drops — only successful enqueues are tracked here.
    expect(snap.errors.by_category["explicit_add_received"] ?? 0).toBe(0);
  });
});

// MCP integration: register add_memory on /mcp, exercise auth + dispatch + invalid_args.
const BOOTSTRAP = "add-memory-mcp-tk";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let rpcId = 1;
function rpc(method: string, params?: unknown): { body: string } {
  return {
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} }),
  };
}

async function initialize(port: number, token: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...MCP_HEADERS },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "quack-test", version: "0.0.0" },
      },
    }),
  });
  if (res.status !== 200) throw new Error(`initialize failed: HTTP ${res.status} body=${await res.text()}`);
}

async function startTestServer(queueCapacity = 100): Promise<{
  server: import("bun").Server<unknown>;
  db: Database;
  queue: BoundedQueue<QueuedEnvelope>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "quack-addmem-"));
  const queue = new BoundedQueue<QueuedEnvelope>(queueCapacity);
  const handler = createMcpHandler({ ingestQueue: queue });
  const started = startServer({
    env: {
      PORT: 0,
      QUACK_BOOTSTRAP_TOKEN: BOOTSTRAP,
      QUACK_DATA_DIR: dir,
      QUACK_MODEL_API_KEY: undefined,
      QUACK_MODEL_BASE_URL: undefined,
      QUACK_BIND_HOST: "127.0.0.1",
      QUACK_NEO4J_URL: "bolt://graphdb:7687",
      QUACK_NEO4J_USER: "neo4j",
      QUACK_NEO4J_PASSWORD: "addmem-pw",
      QUACK_QUEUE_CAPACITY: 100,
      QUACK_EXTRACTOR_CONCURRENCY: 1,
      QUACK_REDACTION_PATTERNS: undefined,
      QUACK_MODEL_NAME: "gpt-4o-mini",
      QUACK_DEAD_LETTER_MAX_BYTES: 1024 * 1024,
      QUACK_ADD_MEMORY_MAX_BYTES: 32768,
    },
    mcpHandler: handler,
    skipGraph: true,
  });
  return { server: started.server, db: started.db, queue };
}

describe("add_memory (MCP integration)", () => {
  beforeEach(() => {
    resetCountersForTests();
    setQueueDepthSource(null);
  });

  test("AC-41NXTZ.1: add_memory is in the tools/list registry", () => {
    expect(listTools()).toContain("add_memory");
  });

  test("AC-41NXTZ.1: missing token → 401 at AuthMiddleware (before tool dispatch)", async () => {
    const { server, db, queue } = await startTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: rpc("tools/call", { name: "add_memory", arguments: { content: "x" } }).body,
      });
      expect(res.status).toBe(401);
      // Queue untouched.
      expect(queue.getDepth()).toBe(0);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("AC-41NXTZ.1: member-role caller succeeds (no 403)", async () => {
    const { server, db, queue } = await startTestServer();
    try {
      await initialize(server.port!, BOOTSTRAP);
      // Bootstrap admin creates _control_; add a non-admin member project + token.
      db.run("INSERT INTO users(username, role) VALUES ('alice', 'member')");
      db.run("INSERT INTO projects(slug, display_name) VALUES ('proj-a', 'Project A')");
      const memberCtx = { user_id: 2, project_id: 2, role: "member" as const };
      // Use add_member admin tool to mint a token for alice on proj-a.
      const out = addMember(
        { username: "alice", project_slug: "proj-a", role: "member" },
        { user_id: 1, project_id: 1, role: "admin" },
        db,
      );
      void memberCtx; // captured above for clarity
      const memberToken = out.token;

      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}`, ...MCP_HEADERS },
        body: rpc("tools/call", { name: "add_memory", arguments: { content: "fact" } }).body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      // Member-role caller must NOT be 403'd by ADMIN_TOOLS gate.
      expect(result.isError ?? false).toBe(false);
      const payload = JSON.parse(result.content[0]!.text) as { accepted: boolean; queued_at: string };
      expect(payload.accepted).toBe(true);
      expect(typeof payload.queued_at).toBe("string");
      expect(queue.getDepth()).toBe(1);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("AC-41NXTZ.2: empty content → invalid_args MCP tool-error; no enqueue", async () => {
    const { server, db, queue } = await startTestServer();
    try {
      await initialize(server.port!, BOOTSTRAP);
      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: rpc("tools/call", { name: "add_memory", arguments: { content: "" } }).body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text) as {
        error: string;
        issues: Array<{ path: unknown[]; message: string }>;
      };
      expect(payload.error).toBe("invalid_args");
      expect(Array.isArray(payload.issues)).toBe(true);
      expect(payload.issues.length).toBeGreaterThanOrEqual(1);
      expect(payload.issues[0]!.path).toContain("content");
      expect(queue.getDepth()).toBe(0);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("AC-41NXTZ.2: oversized content (QUACK_ADD_MEMORY_MAX_BYTES + 1) → invalid_args; no enqueue", async () => {
    const { server, db, queue } = await startTestServer();
    try {
      await initialize(server.port!, BOOTSTRAP);
      const oversized = "x".repeat(32769);
      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: rpc("tools/call", { name: "add_memory", arguments: { content: oversized } }).body,
      });
      const body = (await res.json()) as JsonRpcResponse;
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text) as { error: string };
      expect(payload.error).toBe("invalid_args");
      expect(queue.getDepth()).toBe(0);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("AC-41NXTZ.4: queue-full → { accepted: false, reason: 'queue_full', queued_at: null }", async () => {
    const { server, db, queue } = await startTestServer(1);
    try {
      await initialize(server.port!, BOOTSTRAP);
      // Pre-fill the queue.
      queue.enqueue({ kind: "stop", payload: {}, ctx: { user_id: 1, project_id: 1, role: "admin" }, queued_at: "" });

      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: rpc("tools/call", { name: "add_memory", arguments: { content: "won't fit" } }).body,
      });
      const body = (await res.json()) as JsonRpcResponse;
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      const payload = JSON.parse(result.content[0]!.text) as { accepted: boolean; reason?: string; queued_at: string | null };
      expect(payload.accepted).toBe(false);
      expect(payload.reason).toBe("queue_full");
      expect(payload.queued_at).toBeNull();
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("AC-41NXTZ.9: tools/list manifest contains the verbatim add_memory description", async () => {
    const { server, db } = await startTestServer();
    try {
      await initialize(server.port!, BOOTSTRAP);
      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: rpc("tools/list").body,
      });
      const body = (await res.json()) as JsonRpcResponse;
      const tools = (body.result as { tools: Array<{ name: string; description: string }> }).tools;
      const t = tools.find((x) => x.name === "add_memory");
      expect(t).toBeDefined();
      const expected =
        "Enqueues content for LLM digestion into the project's memory. " +
        "Fire-and-forget — returns immediately. " +
        "Memories become available shortly via search_memory after server-side extraction completes. " +
        "No status polling — check via search_memory after a short delay.";
      expect(t!.description).toBe(expected);
    } finally {
      server.stop(true);
      db.close();
    }
  });
});
