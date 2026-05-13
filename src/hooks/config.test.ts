import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, parseDotenv } from "./config";

describe("parseDotenv", () => {
  test("KEY=value lines", () => {
    const r = parseDotenv("FOO=bar\nBAZ=qux\n");
    expect(r["FOO"]).toBe("bar");
    expect(r["BAZ"]).toBe("qux");
  });

  test("ignores comments and blank lines", () => {
    const r = parseDotenv("# top comment\n\nFOO=bar\n# inline-style comment\n");
    expect(r["FOO"]).toBe("bar");
    expect(Object.keys(r).length).toBe(1);
  });

  test("strips matching surrounding quotes", () => {
    const r = parseDotenv(`FOO="bar baz"\nBAZ='qux'\n`);
    expect(r["FOO"]).toBe("bar baz");
    expect(r["BAZ"]).toBe("qux");
  });
});

describe("resolveConfig", () => {
  test("env vars win when present", () => {
    const cfg = resolveConfig({ QUACK_TOKEN: "tk", QUACK_SERVER_URL: "https://x.test", QUACK_PROJECT_SLUG: "p" });
    expect(cfg).toEqual({ token: "tk", serverUrl: "https://x.test", projectSlug: "p" });
  });

  test("defaults to loopback when QUACK_SERVER_URL absent", () => {
    const cfg = resolveConfig({ QUACK_TOKEN: "tk" });
    expect(cfg?.serverUrl).toBe("http://127.0.0.1:7474");
  });

  test("dotenv file fallback when token unset but slug + file present", () => {
    const home = mkdtempSync(join(tmpdir(), "quack-hook-cfg-"));
    mkdirSync(join(home, ".quack", "projects"), { recursive: true });
    writeFileSync(
      join(home, ".quack", "projects", "myproj.env"),
      "QUACK_TOKEN=secret\nQUACK_SERVER_URL=http://override:9999\n",
      "utf8",
    );
    const cfg = resolveConfig({ QUACK_PROJECT_SLUG: "myproj", HOME: home });
    expect(cfg?.token).toBe("secret");
    expect(cfg?.serverUrl).toBe("http://override:9999");
  });

  test("missing token returns null (silent disable)", () => {
    expect(resolveConfig({})).toBeNull();
  });

  test("dotenv with no token still returns null", () => {
    const home = mkdtempSync(join(tmpdir(), "quack-hook-cfg-"));
    mkdirSync(join(home, ".quack", "projects"), { recursive: true });
    writeFileSync(join(home, ".quack", "projects", "myproj.env"), "QUACK_SERVER_URL=http://x\n", "utf8");
    const cfg = resolveConfig({ QUACK_PROJECT_SLUG: "myproj", HOME: home });
    expect(cfg).toBeNull();
  });
});
