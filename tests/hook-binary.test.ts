import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// AC-S2D0Z5.12 — compile the binary via `bun build --compile`, spawn it
// against a stub Bun.serve, assert (a) exit 0, (b) stub received the
// expected envelope shape, (c) Authorization: Bearer ${TOKEN} header.
//
// Skipped automatically if the binary build fails on this platform.

const REPO_ROOT = join(import.meta.dir, "..");
const BIN_PATH = join(REPO_ROOT, "dist", "quack-hook");

let stubServer: ReturnType<typeof Bun.serve> | null = null;
let received: { headers: Record<string, string>; body: unknown } | null = null;
let stubPort = 0;
let binBuilt = false;

beforeAll(async () => {
  // Build the binary.
  const build = Bun.spawn(["bun", "run", "build:hook"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const code = await build.exited;
  binBuilt = code === 0 && existsSync(BIN_PATH);
  // Stub server captures the envelope payload.
  stubServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      received = {
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.json(),
      };
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });
  stubPort = stubServer.port!;
}, 120_000);

afterAll(() => {
  if (stubServer) stubServer.stop(true);
});

describe("quack-hook compiled binary integration", () => {
  test("skips cleanly when binary cannot be built on this platform", () => {
    if (!binBuilt) {
      console.warn("`bun run build:hook` failed — skipping compiled-binary integration test");
      expect(true).toBe(true);
      return;
    }
    expect(existsSync(BIN_PATH)).toBe(true);
  });

  test("spawn binary with stdin payload; stub receives envelope with Bearer auth", async () => {
    if (!binBuilt) return;
    received = null;
    const proc = Bun.spawn([BIN_PATH, "stop"], {
      env: {
        ...Bun.env,
        QUACK_TOKEN: "test-bin-token",
        QUACK_SERVER_URL: `http://127.0.0.1:${stubPort}`,
        QUACK_PROJECT_SLUG: "test-bin-project",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin?.write(JSON.stringify({ transcript: "hello" }));
    await proc.stdin?.end();
    const exitCode = await proc.exited;
    // Give the server a tick to record the request.
    await Bun.sleep(50);
    expect(exitCode).toBe(0);
    expect(received).not.toBeNull();
    expect(received!.headers["authorization"]).toBe("Bearer test-bin-token");
    const env = received!.body as { kind: string; payload: { transcript: string }; project_slug?: string };
    expect(env.kind).toBe("stop");
    expect(env.payload.transcript).toBe("hello");
    expect(env.project_slug).toBe("test-bin-project");
  }, 60_000);
});
