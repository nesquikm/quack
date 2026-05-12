import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index";
import { createMcpHandler, listTools } from "./server";

const BOOTSTRAP = "mcp-srv-test-tk";

async function startTestServer() {
  const dir = mkdtempSync(join(tmpdir(), "quack-mcp-"));
  return startServer({
    env: {
      PORT: 0,
      QUACK_BOOTSTRAP_TOKEN: BOOTSTRAP,
      QUACK_DATA_DIR: dir,
      QUACK_MODEL_API_KEY: undefined,
      QUACK_MODEL_BASE_URL: undefined,
    },
    mcpHandler: createMcpHandler(),
  });
}

describe("MCP server integration", () => {
  test("auth headers are required for /mcp", async () => {
    const { server, db } = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      body: JSON.stringify({ tool: "list_users" }),
    });
    expect(res.status).toBe(401);
    server.stop(true);
    db.close();
  });

  test("admin can call list_users via the wire", async () => {
    const { server, db } = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOTSTRAP}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "list_users" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { users: Array<{ username: string }> };
    expect(body.users.length).toBeGreaterThanOrEqual(1);
    server.stop(true);
    db.close();
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
