import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index";
import { createMcpHandler, listTools } from "./server";

const BOOTSTRAP = "mcp-srv-test-tk";

async function startTestServer() {
  const dir = mkdtempSync(join(tmpdir(), "quack-mcp-"));
  const handler = createMcpHandler();
  return startServer({
    env: {
      PORT: 0,
      QUACK_BOOTSTRAP_TOKEN: BOOTSTRAP,
      QUACK_DATA_DIR: dir,
      QUACK_MODEL_API_KEY: undefined,
      QUACK_MODEL_BASE_URL: undefined,
      QUACK_BIND_HOST: "127.0.0.1",
      QUACK_NEO4J_URL: "bolt://graphdb:7687",
      QUACK_NEO4J_USER: "neo4j",
      QUACK_NEO4J_PASSWORD: "mcp-test-pw",
    },
    mcpHandler: handler,
    skipGraph: true,
  });
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let rpcId = 1;
function rpc(method: string, params?: unknown): { body: string } {
  return {
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} }),
  };
}

async function initialize(port: number, token: string): Promise<void> {
  // MCP requires an initialize handshake before tools/* calls.
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

describe("MCP server integration (SDK + streamable HTTP transport)", () => {
  test("auth headers are required for /mcp", async () => {
    const { server, db } = await startTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: rpc("tools/list").body,
      });
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("admin can list tools via JSON-RPC", async () => {
    const { server, db } = await startTestServer();
    try {
      await initialize(server.port!, BOOTSTRAP);
      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: rpc("tools/list").body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const tools = (body.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
      const expected = listTools();
      expect(tools).toEqual(expected);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("admin can call list_users via tools/call", async () => {
    const { server, db } = await startTestServer();
    try {
      await initialize(server.port!, BOOTSTRAP);
      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: rpc("tools/call", { name: "list_users", arguments: {} }).body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const result = body.result as { content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(result.content[0]!.text) as { users: Array<{ username: string }> };
      expect(payload.users.length).toBeGreaterThanOrEqual(1);
      expect(payload.users[0]).toHaveProperty("username");
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("invalid args surface as MCP tool-error `invalid_args` with Zod path; no DB call made", async () => {
    const { server, db } = await startTestServer();
    try {
      await initialize(server.port!, BOOTSTRAP);
      const before = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM users").get();
      const usersBefore = before?.c ?? 0;

      const res = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: rpc("tools/call", { name: "register_user", arguments: { username: "" } }).body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text) as { error: string; issues: Array<{ path: unknown[]; message: string }> };
      expect(payload.error).toBe("invalid_args");
      expect(Array.isArray(payload.issues)).toBe(true);
      expect(payload.issues.length).toBeGreaterThanOrEqual(1);
      expect(payload.issues[0]!.path).toContain("username");

      const after = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM users").get();
      expect(after?.c ?? 0).toBe(usersBefore);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("tool registry exposes the expected v1 surface", () => {
    const names = listTools();
    expect(names).toContain("register_user");
    expect(names).toContain("remove_user");
    expect(names).toContain("create_project");
    expect(names).toContain("delete_project");
    expect(names).toContain("add_member");
    expect(names).toContain("remove_member");
    expect(names).toContain("revoke_token");
    expect(names).toContain("list_projects");
    expect(names).toContain("list_users");
    expect(names).toContain("server_status");
  });
});
