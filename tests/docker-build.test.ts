import { test, expect, describe } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

async function dockerAvailable(): Promise<boolean> {
  // The daemon must be reachable, not just the CLI installed.
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

describe("docker build", () => {
  test("`docker build` succeeds and produces an image < 200 MB", async () => {
    if (!(await dockerAvailable())) {
      console.warn("docker not on PATH — skipping docker-build integration test");
      return;
    }
    const tag = "quack-test:m2";
    const build = Bun.spawn(["docker", "build", "-t", tag, REPO_ROOT], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await build.exited;
    expect(code).toBe(0);

    const inspect = Bun.spawn(["docker", "image", "inspect", tag, "--format", "{{.Size}}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(inspect.stdout).text();
    expect(await inspect.exited).toBe(0);
    const bytes = Number(out.trim());
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(200 * 1024 * 1024);
  }, 600_000);
});
