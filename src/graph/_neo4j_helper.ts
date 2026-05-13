import { connect as netConnect } from "node:net";
import neo4j from "neo4j-driver";

// Helper for integration tests that need a real Neo4j. Spawns a temporary
// neo4j:5-community container with `docker run`; auto-skip helpers let
// individual tests bail when docker is unreachable.

export interface SpawnedNeo4j {
  url: string;
  user: string;
  password: string;
  containerId: string;
  stop(): Promise<void>;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function tcpReady(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const p = s.port!;
  s.stop(true);
  return p;
}

export async function spawnNeo4j(opts: { password?: string; readyTimeoutMs?: number } = {}): Promise<SpawnedNeo4j> {
  const password = opts.password ?? "quack-test-pw";
  const readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
  const port = await freePort();
  const run = Bun.spawn(
    [
      "docker",
      "run",
      "-d",
      "--rm",
      "-p",
      `127.0.0.1:${port}:7687`,
      "-e",
      `NEO4J_AUTH=neo4j/${password}`,
      "-e",
      "NEO4J_server_memory_heap_max__size=512m",
      "neo4j:5-community",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await run.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(run.stderr).text();
    throw new Error(`docker run failed (exit ${exitCode}): ${stderr}`);
  }
  const containerId = (await new Response(run.stdout).text()).trim();

  const start = Date.now();
  // Phase 1 — wait for TCP listener.
  let tcpOk = false;
  while (Date.now() - start < readyTimeoutMs) {
    if (await tcpReady("127.0.0.1", port, 1000)) {
      tcpOk = true;
      break;
    }
    await Bun.sleep(500);
  }
  if (!tcpOk) {
    await stopContainer(containerId);
    throw new Error(`neo4j TCP port did not open within ${readyTimeoutMs}ms`);
  }
  // Phase 2 — actually verify auth + query plane. The Bolt port can accept
  // TCP for several seconds before the auth subsystem is up.
  const url = `bolt://127.0.0.1:${port}`;
  let queryOk = false;
  while (Date.now() - start < readyTimeoutMs) {
    const probe = neo4j.driver(url, neo4j.auth.basic("neo4j", password), {
      connectionAcquisitionTimeout: 2000,
    });
    try {
      const session = probe.session({ database: "neo4j" });
      try {
        await session.run("RETURN 1 AS one");
        queryOk = true;
      } finally {
        await session.close();
      }
    } catch {
      // not ready yet
    } finally {
      await probe.close();
    }
    if (queryOk) break;
    await Bun.sleep(1000);
  }
  if (!queryOk) {
    await stopContainer(containerId);
    throw new Error(`neo4j query plane not ready within ${readyTimeoutMs}ms`);
  }

  return {
    url: `bolt://127.0.0.1:${port}`,
    user: "neo4j",
    password,
    containerId,
    async stop() {
      await stopContainer(containerId);
    },
  };
}

async function stopContainer(id: string): Promise<void> {
  const proc = Bun.spawn(["docker", "stop", id], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}
