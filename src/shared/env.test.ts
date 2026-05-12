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
    });
    expect(env.PORT).toBe(8080);
    expect(env.QUACK_BOOTSTRAP_TOKEN).toBe("bootstrap-abc");
    expect(env.QUACK_DATA_DIR).toBe("/custom/data");
    expect(env.QUACK_MODEL_API_KEY).toBe("sk-test");
    expect(env.QUACK_MODEL_BASE_URL).toBe("https://api.anthropic.com/v1");
  });

  test("defaults apply when vars are absent", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(7474);
    expect(env.QUACK_DATA_DIR).toBe("./data");
    expect(env.QUACK_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(env.QUACK_MODEL_API_KEY).toBeUndefined();
    expect(env.QUACK_MODEL_BASE_URL).toBeUndefined();
  });

  test("missing-var case 1: invalid PORT (non-numeric) throws", () => {
    expect(() => parseEnv({ PORT: "not-a-number" })).toThrow(EnvError);
  });

  test("missing-var case 2: invalid PORT (negative) throws", () => {
    expect(() => parseEnv({ PORT: "-1" })).toThrow(EnvError);
  });

  test("missing-var case 3: empty QUACK_DATA_DIR throws", () => {
    expect(() => parseEnv({ QUACK_DATA_DIR: "" })).toThrow(EnvError);
  });

  test("optional-empty case 1: empty QUACK_MODEL_API_KEY treated as absent", () => {
    const env = parseEnv({ QUACK_MODEL_API_KEY: "" });
    expect(env.QUACK_MODEL_API_KEY).toBeUndefined();
  });

  test("optional-empty case 2: empty QUACK_MODEL_BASE_URL treated as absent", () => {
    const env = parseEnv({ QUACK_MODEL_BASE_URL: "" });
    expect(env.QUACK_MODEL_BASE_URL).toBeUndefined();
  });
});
