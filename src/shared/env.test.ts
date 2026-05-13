import { describe, test, expect } from "bun:test";
import { parseEnv, EnvError } from "./env";

describe("parseEnv", () => {
  test("happy path: full set of vars parses", () => {
    const env = parseEnv({
      PORT: "8080",
      QUACK_BOOTSTRAP_TOKEN: "bootstrap-abc",
      QUACK_DATA_DIR: "/custom/data",
      QUACK_MODEL_API_KEY: "sk-test",
      QUACK_MODEL_BASE_URL: "https://api.anthropic.com/v1",
      QUACK_BIND_HOST: "0.0.0.0",
      QUACK_NEO4J_URL: "bolt://localhost:7687",
      QUACK_NEO4J_USER: "neo4j",
      QUACK_NEO4J_PASSWORD: "test-password",
    });
    expect(env.PORT).toBe(8080);
    expect(env.QUACK_BOOTSTRAP_TOKEN).toBe("bootstrap-abc");
    expect(env.QUACK_DATA_DIR).toBe("/custom/data");
    expect(env.QUACK_MODEL_API_KEY).toBe("sk-test");
    expect(env.QUACK_MODEL_BASE_URL).toBe("https://api.anthropic.com/v1");
    expect(env.QUACK_BIND_HOST).toBe("0.0.0.0");
    expect(env.QUACK_NEO4J_URL).toBe("bolt://localhost:7687");
    expect(env.QUACK_NEO4J_USER).toBe("neo4j");
    expect(env.QUACK_NEO4J_PASSWORD).toBe("test-password");
  });

  test("defaults apply when vars are absent (password still required)", () => {
    const env = parseEnv({ QUACK_NEO4J_PASSWORD: "pw" });
    expect(env.PORT).toBe(7474);
    expect(env.QUACK_DATA_DIR).toBe("./data");
    expect(env.QUACK_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(env.QUACK_MODEL_API_KEY).toBeUndefined();
    expect(env.QUACK_MODEL_BASE_URL).toBeUndefined();
    expect(env.QUACK_BIND_HOST).toBe("127.0.0.1");
    expect(env.QUACK_NEO4J_URL).toBe("bolt://graphdb:7687");
    expect(env.QUACK_NEO4J_USER).toBe("neo4j");
  });

  test("QUACK_NEO4J_PASSWORD is required (Zod refuses on absence)", () => {
    expect(() => parseEnv({})).toThrow(EnvError);
  });

  test("QUACK_BIND_HOST rejects values outside the allowlist", () => {
    expect(() => parseEnv({ QUACK_BIND_HOST: "192.168.1.1", QUACK_NEO4J_PASSWORD: "pw" })).toThrow(EnvError);
    expect(() => parseEnv({ QUACK_BIND_HOST: "::1", QUACK_NEO4J_PASSWORD: "pw" })).toThrow(EnvError);
  });

  test("missing-var case 1: invalid PORT (non-numeric) throws", () => {
    expect(() => parseEnv({ PORT: "not-a-number", QUACK_NEO4J_PASSWORD: "pw" })).toThrow(EnvError);
  });

  test("missing-var case 2: invalid PORT (negative) throws", () => {
    expect(() => parseEnv({ PORT: "-1", QUACK_NEO4J_PASSWORD: "pw" })).toThrow(EnvError);
  });

  test("missing-var case 3: empty QUACK_DATA_DIR throws", () => {
    expect(() => parseEnv({ QUACK_DATA_DIR: "", QUACK_NEO4J_PASSWORD: "pw" })).toThrow(EnvError);
  });

  test("optional-empty case 1: empty QUACK_MODEL_API_KEY treated as absent", () => {
    const env = parseEnv({ QUACK_MODEL_API_KEY: "", QUACK_NEO4J_PASSWORD: "pw" });
    expect(env.QUACK_MODEL_API_KEY).toBeUndefined();
  });

  test("optional-empty case 2: empty QUACK_MODEL_BASE_URL treated as absent", () => {
    const env = parseEnv({ QUACK_MODEL_BASE_URL: "", QUACK_NEO4J_PASSWORD: "pw" });
    expect(env.QUACK_MODEL_BASE_URL).toBeUndefined();
  });

  // AC-41NXTZ.2 — QUACK_ADD_MEMORY_MAX_BYTES env var.
  test("AC-41NXTZ.2: QUACK_ADD_MEMORY_MAX_BYTES defaults to 32768", () => {
    const env = parseEnv({ QUACK_NEO4J_PASSWORD: "pw" });
    expect((env as unknown as { QUACK_ADD_MEMORY_MAX_BYTES: number }).QUACK_ADD_MEMORY_MAX_BYTES).toBe(32768);
  });

  test("AC-41NXTZ.2: QUACK_ADD_MEMORY_MAX_BYTES accepts a positive override", () => {
    const env = parseEnv({ QUACK_NEO4J_PASSWORD: "pw", QUACK_ADD_MEMORY_MAX_BYTES: "65536" });
    expect((env as unknown as { QUACK_ADD_MEMORY_MAX_BYTES: number }).QUACK_ADD_MEMORY_MAX_BYTES).toBe(65536);
  });

  test("AC-41NXTZ.2: QUACK_ADD_MEMORY_MAX_BYTES rejects non-positive values", () => {
    expect(() => parseEnv({ QUACK_NEO4J_PASSWORD: "pw", QUACK_ADD_MEMORY_MAX_BYTES: "0" })).toThrow(EnvError);
    expect(() => parseEnv({ QUACK_NEO4J_PASSWORD: "pw", QUACK_ADD_MEMORY_MAX_BYTES: "-100" })).toThrow(EnvError);
  });
});
