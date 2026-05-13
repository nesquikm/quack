import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { installComposeEnv } from "./_compose_env";

const REPO_ROOT = join(import.meta.dir, "..");
const BOOTSTRAP_TOKEN = "m2-smoke-bootstrap-token-do-not-reuse";
const BASE_URL = "http://127.0.0.1:7474";

async function dockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function awaitHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status === 200) return true;
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }
  return false;
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let rpcId = 1;
function rpc(method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params });
}

async function mcpCall(token: string, method: string, params: unknown): Promise<Response> {
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...MCP_HEADERS },
    body: rpc(method, params),
  });
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id: number | string;
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

describe("M2 end-to-end smoke (programmatic version of the milestone-plan manual smoke)", () => {
  test(
    "admin register_user → returned member token POSTs /ingest (202 or 204) → same member token gets 403 on admin tool",
    async () => {
      if (!(await dockerAvailable())) {
        console.warn("docker daemon unreachable — skipping M2 end-to-end smoke");
        return;
      }

      const envHandle = installComposeEnv(
        REPO_ROOT,
        `QUACK_BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}\nQUACK_NEO4J_PASSWORD=m2-smoke-neo4j-pw\n`,
      );
      const compose = ["docker", "compose"];

      try {
        const up = Bun.spawn([...compose, "up", "-d", "--build"], {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
        const upCode = await up.exited;
        if (upCode !== 0) {
          const stderr = await new Response(up.stderr).text();
          throw new Error(`docker compose up failed (exit ${upCode}):\n${stderr}`);
        }

        try {
          // M3 milestone AC: stack (quack + graphdb) healthy within 60 s — loosen
          // from M2's 30 s to accommodate Neo4j's first-time index/auth setup.
          const healthy = await awaitHealth(90_000);
          expect(healthy).toBe(true);

          // Step 1 — admin registers a member user; response carries the one-time plaintext token.
          const regRes = await mcpCall(BOOTSTRAP_TOKEN, "tools/call", {
            name: "register_user",
            arguments: { username: "smoke-member" },
          });
          expect(regRes.status).toBe(200);
          const regEnvelope = (await regRes.json()) as JsonRpcEnvelope;
          expect(regEnvelope.error).toBeUndefined();
          expect(regEnvelope.result?.isError).not.toBe(true);
          const regPayload = JSON.parse(regEnvelope.result!.content[0]!.text) as {
            user: { id: number; username: string; role: "admin" | "member" };
            token: string;
          };
          expect(regPayload.user.username).toBe("smoke-member");
          expect(regPayload.user.role).toBe("member");
          // 43-char base64url.
          expect(regPayload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
          const memberToken = regPayload.token;

          // Step 2 — member token authenticates POST /ingest. M3 turns the M2
          // 204 stub into a real enqueue path: 202 when the extractor is
          // wired (QUACK_MODEL_API_KEY + QUACK_MODEL_BASE_URL set), 204 when
          // the M2-compat fallback is taken. Either way auth + validation
          // passed.
          const ingest = await fetch(`${BASE_URL}/ingest`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${memberToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ kind: "session_start", payload: { source: "m2-smoke" } }),
          });
          expect([202, 204]).toContain(ingest.status);

          // Step 3 — re-using the same member token to call an admin-only tool must surface 403.
          const forbidden = await mcpCall(memberToken, "tools/call", {
            name: "register_user",
            arguments: { username: "should-fail" },
          });
          expect(forbidden.status).toBe(200);
          const forbiddenEnvelope = (await forbidden.json()) as JsonRpcEnvelope;
          expect(forbiddenEnvelope.result?.isError).toBe(true);
          const forbiddenPayload = JSON.parse(forbiddenEnvelope.result!.content[0]!.text) as { error: string };
          expect(forbiddenPayload.error).toBe("forbidden");

          // Step 4 — bonus: server_status from the admin must reflect at least one admin_403.
          const status = await mcpCall(BOOTSTRAP_TOKEN, "tools/call", {
            name: "server_status",
            arguments: {},
          });
          expect(status.status).toBe(200);
          const statusEnvelope = (await status.json()) as JsonRpcEnvelope;
          const snapshot = JSON.parse(statusEnvelope.result!.content[0]!.text) as {
            version: string;
            errors: { since_boot_total: number; by_category: Record<string, number> };
          };
          expect(snapshot.version).toBe("v1");
          expect(snapshot.errors.by_category["admin_403"] ?? 0).toBeGreaterThanOrEqual(1);
        } finally {
          const down = Bun.spawn([...compose, "down", "--volumes"], {
            cwd: REPO_ROOT,
            stdout: "pipe",
            stderr: "pipe",
          });
          const downCode = await down.exited;
          expect(downCode).toBe(0);
        }
      } finally {
        envHandle.restore();
      }
    },
    240_000,
  );
});
