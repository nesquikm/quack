import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../server/index";
import { createMcpHandler } from "../../mcp/server";
import { registerUser } from "./register_user";
import { resetCountersForTests } from "../../metrics/counters";

const BOOTSTRAP = "integration-token";

async function startTestServer() {
  const dir = mkdtempSync(join(tmpdir(), "quack-status-"));
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

describe("server_status integration (401 + 403 + status)", () => {
  beforeEach(() => resetCountersForTests());

  test("auth_401 + admin_403 visible via server_status", async () => {
    const { server, db } = await startTestServer();
    try {
      // trigger 401: missing auth header
      const unauth = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        body: JSON.stringify({ tool: "list_users" }),
      });
      expect(unauth.status).toBe(401);

      // create a non-admin user; registerUser returns a one-time plaintext token bound to (user, _control_)
      const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };
      const { token: memberToken } = registerUser({ username: "memberA" }, adminCtx, db);

      // trigger 403: non-admin invokes admin-only register_user
      const forbidden = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "register_user", args: { username: "another" } }),
      });
      expect(forbidden.status).toBe(403);

      // read server_status as the admin
      const status = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOOTSTRAP}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "server_status" }),
      });
      expect(status.status).toBe(200);
      const body = (await status.json()) as {
        errors: { by_category: Record<string, number>; since_boot_total: number };
        version: string;
      };
      expect(body.version).toBe("v1");
      expect(body.errors.by_category["auth_401"]).toBeGreaterThanOrEqual(1);
      expect(body.errors.by_category["admin_403"]).toBeGreaterThanOrEqual(1);
      expect(body.errors.since_boot_total).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
      db.close();
    }
  });
});
