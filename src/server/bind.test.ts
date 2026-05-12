import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { connect as netConnect } from "node:net";
import { startServer } from "./index";

function withTestServer(): { server: ReturnType<typeof startServer>["server"]; db: ReturnType<typeof startServer>["db"] } {
  const dir = mkdtempSync(join(tmpdir(), "quack-bind-"));
  const { server, db } = startServer({
    env: {
      PORT: 0,
      QUACK_BOOTSTRAP_TOKEN: "bind-test-token",
      QUACK_DATA_DIR: dir,
      QUACK_MODEL_API_KEY: undefined,
      QUACK_MODEL_BASE_URL: undefined,
    },
  });
  return { server, db };
}

function firstNonLoopbackIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function attemptConnect(host: string, port: number, timeoutMs: number): Promise<"connected" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve("refused");
    });
  });
}

describe("startServer 127.0.0.1 bind", () => {
  test("hostname is 127.0.0.1 (bind-time configuration)", () => {
    const { server, db } = withTestServer();
    try {
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("loopback request to /health succeeds", async () => {
    const { server, db } = withTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("non-loopback interface TCP connect is refused (no listener on that interface)", async () => {
    const lanIp = firstNonLoopbackIPv4();
    if (!lanIp) {
      console.warn("no non-loopback IPv4 interface available — skipping non-loopback refusal test");
      return;
    }
    const { server, db } = withTestServer();
    try {
      // Server listens on 127.0.0.1:port; the LAN IP should NOT accept TCP on that port.
      const outcome = await attemptConnect(lanIp, server.port!, 1500);
      expect(outcome).not.toBe("connected");
    } finally {
      server.stop(true);
      db.close();
    }
  });
});
