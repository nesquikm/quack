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

async function awaitHealth(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return true;
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }
  return false;
}

describe("docker run / compose smoke", () => {
  test("`docker run` boots quack and `id -u` returns 1000", async () => {
    if (!(await dockerAvailable())) {
      console.warn("docker not on PATH — skipping docker-run test");
      return;
    }
    const tag = "quack-test:m2";
    const build = Bun.spawn(["docker", "build", "-t", tag, REPO_ROOT], { stdout: "pipe", stderr: "pipe" });
    expect(await build.exited).toBe(0);

    const idProc = Bun.spawn(["docker", "run", "--rm", tag, "id", "-u"], { stdout: "pipe", stderr: "pipe" });
    const idOut = (await new Response(idProc.stdout).text()).trim();
    expect(await idProc.exited).toBe(0);
    expect(idOut).toBe("1000");
  }, 600_000);

  test("`docker compose up` reaches healthy state within 30 s", async () => {
    if (!(await dockerAvailable())) {
      console.warn("docker not on PATH — skipping compose smoke test");
      return;
    }
    const env = { ...process.env, QUACK_BOOTSTRAP_TOKEN: "compose-smoke-token" };
    const up = Bun.spawn(["docker", "compose", "up", "-d", "--build"], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const upCode = await up.exited;
    expect(upCode).toBe(0);

    try {
      const ok = await awaitHealth("http://127.0.0.1:7474/health", 30_000);
      expect(ok).toBe(true);
    } finally {
      const down = Bun.spawn(["docker", "compose", "down", "--volumes"], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      await down.exited;
    }
  }, 120_000);
});
