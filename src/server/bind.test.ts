import { test, expect } from "bun:test";
import { startServer } from "./index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("startServer binds to 127.0.0.1 only (non-loopback request refused at bind level)", async () => {
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

  expect(server.hostname).toBe("127.0.0.1");
  expect(server.port).toBeGreaterThan(0);

  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  expect(res.status).toBe(200);

  server.stop(true);
  db.close();
});
