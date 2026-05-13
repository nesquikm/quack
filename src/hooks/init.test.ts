import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSubcommand } from "./init";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "quack-init-"));
}

describe("initSubcommand", () => {
  test("fresh init writes env file + prints snippet + exit 0", () => {
    const home = tmpHome();
    const outLines: string[] = [];
    const res = initSubcommand("alpha", { home, stdout: (s) => outLines.push(s), stderr: () => {} });
    expect(res.exitCode).toBe(0);
    expect(existsSync(res.envFilePath)).toBe(true);
    const text = readFileSync(res.envFilePath, "utf8");
    expect(text).toContain("QUACK_TOKEN=");
    expect(text).toContain("QUACK_PROJECT_SLUG=alpha");
    const snippet = outLines.join("");
    expect(snippet).toContain("hooks:");
    expect(snippet).toContain("session_start");
    expect(snippet).toContain("stop");
    expect(snippet).toContain("post_tool_use");
    expect(snippet).toContain(res.envFilePath);
  });

  test("pre-existing file → exit 1 + does NOT overwrite", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".quack", "projects"), { recursive: true });
    const path = join(home, ".quack", "projects", "alpha.env");
    writeFileSync(path, "preexisting\n", "utf8");
    const errLines: string[] = [];
    const outLines: string[] = [];
    const res = initSubcommand("alpha", {
      home,
      stdout: (s) => outLines.push(s),
      stderr: (s) => errLines.push(s),
    });
    expect(res.exitCode).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("preexisting\n");
    expect(errLines.join("")).toContain("already exists");
    expect(outLines.length).toBe(0);
  });
});
