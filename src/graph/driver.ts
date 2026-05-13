import neo4j, { type Driver } from "neo4j-driver";
import type { Env } from "../shared/env";

// Singleton driver state. neo4j-driver's `driver(...)` returns a lazy-connecting
// client — first session() call materializes the connection. close() on
// SIGTERM/SIGINT releases the pool.

let cached: Driver | null = null;
let installedSignals = false;

export interface DriverConfig {
  url: string;
  user: string;
  password: string;
  maxConnectionPoolSize?: number;
}

export function getDriver(config: DriverConfig | Env): Driver {
  if (cached) return cached;
  const cfg = ("QUACK_NEO4J_URL" in config)
    ? { url: config.QUACK_NEO4J_URL, user: config.QUACK_NEO4J_USER, password: config.QUACK_NEO4J_PASSWORD }
    : config;
  const d = neo4j.driver(
    cfg.url,
    neo4j.auth.basic(cfg.user, cfg.password),
    { maxConnectionPoolSize: cfg.maxConnectionPoolSize ?? 50 },
  );
  cached = d;
  if (!installedSignals) {
    installedSignals = true;
    const shutdown = async () => {
      try {
        const d = cached;
        cached = null;
        if (d) await d.close();
      } catch {
        // best effort
      }
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
  return d;
}

export async function closeDriver(): Promise<void> {
  const d = cached;
  cached = null;
  if (d) await d.close();
}

export function resetDriverForTests(): void {
  cached = null;
}

export async function probeGraphdb(driver: Driver, timeoutMs: number = 1000): Promise<boolean> {
  const session = driver.session({ database: "neo4j", defaultAccessMode: neo4j.session.READ });
  try {
    const probe = session.run("MATCH (n) RETURN count(n) LIMIT 0");
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("graphdb probe timeout")), timeoutMs),
    );
    await Promise.race([probe, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      await session.close();
    } catch {
      // best effort
    }
  }
}
