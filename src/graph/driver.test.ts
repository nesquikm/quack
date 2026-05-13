import { describe, test, expect, afterEach } from "bun:test";
import { getDriver, resetDriverForTests } from "./driver";

afterEach(() => resetDriverForTests());

describe("getDriver", () => {
  test("returns the same singleton across calls", () => {
    const d1 = getDriver({ url: "bolt://localhost:9999", user: "neo4j", password: "test-pw" });
    const d2 = getDriver({ url: "bolt://other:9999", user: "neo4j", password: "different" });
    // second call returns the cached instance (config-on-first-call wins).
    expect(d2).toBe(d1);
  });

  test("accepts the Env shape (QUACK_NEO4J_* fields)", () => {
    const d = getDriver({
      PORT: 7474,
      QUACK_DATA_DIR: "/tmp",
      QUACK_BIND_HOST: "127.0.0.1",
      QUACK_NEO4J_URL: "bolt://localhost:9999",
      QUACK_NEO4J_USER: "neo4j",
      QUACK_NEO4J_PASSWORD: "pw",
    } as Parameters<typeof getDriver>[0]);
    expect(d).toBeDefined();
  });
});
