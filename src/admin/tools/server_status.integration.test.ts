import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../server/index";
import { createMcpHandler } from "../../mcp/server";
import { registerUser } from "./register_user";
import { resetCountersForTests } from "../../metrics/counters";

const BOOTSTRAP = "integration-token";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
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
        clientInfo: { name: "quack-status-test", version: "0.0.0" },
      },
    }),
  });
  if (res.status !== 200) {
    throw new Error(`initialize failed: HTTP ${res.status} body=${await res.text()}`);
  }
}

async function startTestServer() {
  const dir = mkdtempSync(join(tmpdir(), "quack-status-"));
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
      QUACK_NEO4J_PASSWORD: "integration-test-pw",
    },
    mcpHandler: handler,
    skipGraph: true,
  });
}

let rpcId = 100;
function jsonRpc(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params });
}

describe("server_status integration (401 + 403 + status via MCP SDK transport)", () => {
  beforeEach(() => resetCountersForTests());

  test("auth_401 + admin_403 visible via server_status", async () => {
    const { server, db } = await startTestServer();
    try {
      // trigger 401 — request lacks Authorization header, fails AuthMiddleware before MCP layer.
      const unauth = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: jsonRpc("tools/list", {}),
      });
      expect(unauth.status).toBe(401);

      await initialize(server.port!, BOOTSTRAP);

      // mint a non-admin token via registerUser (returns plaintext bound to (user, _control_))
      const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };
      const { token: memberToken } = registerUser({ username: "memberA" }, adminCtx, db);

      // trigger 403 — member calls admin-only register_user via tools/call.
      const forbidden = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}`, ...MCP_HEADERS },
        body: jsonRpc("tools/call", { name: "register_user", arguments: { username: "another" } }),
      });
      expect(forbidden.status).toBe(200);
      const fbody = (await forbidden.json()) as JsonRpcResponse;
      const fresult = fbody.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(fresult.isError).toBe(true);
      const fpayload = JSON.parse(fresult.content[0]!.text) as { error: string };
      expect(fpayload.error).toBe("forbidden");

      // read server_status as admin
      const status = await fetch(`http://127.0.0.1:${server.port!}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, ...MCP_HEADERS },
        body: jsonRpc("tools/call", { name: "server_status", arguments: {} }),
      });
      expect(status.status).toBe(200);
      const sbody = (await status.json()) as JsonRpcResponse;
      const sresult = sbody.result as { content: Array<{ text: string }> };
      const snapshot = JSON.parse(sresult.content[0]!.text) as {
        version: string;
        errors: { by_category: Record<string, number>; since_boot_total: number };
      };
      expect(snapshot.version).toBe("v1");
      expect(snapshot.errors.by_category["auth_401"]).toBeGreaterThanOrEqual(1);
      expect(snapshot.errors.by_category["admin_403"]).toBeGreaterThanOrEqual(1);
      expect(snapshot.errors.since_boot_total).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
      db.close();
    }
  });
});
