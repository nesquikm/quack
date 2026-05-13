import { describe, test, expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// AC-ZSN2GG.3 — three plugin hook wrappers under plugins/quack/hooks/:
// - each is `chmod +x`
// - each passes `sh -n` syntax check
// - each carries the silent-disable stderr line so a missing binary never
//   breaks a Claude Code session.

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK_DIR = join(REPO_ROOT, "plugins/quack/hooks");
const HOOKS = ["session_start.sh", "stop.sh", "post_tool_use.sh"];
const DISABLE_MARKER = "[quack-hook plugin] binary not found";

describe("plugin hook wrappers", () => {
  for (const name of HOOKS) {
    const path = join(HOOK_DIR, name);

    test(`${name} is executable`, () => {
      const mode = statSync(path).mode;
      // POSIX exec bit anywhere (owner / group / other) is enough — we only
      // care that `chmod +x` was applied.
      expect((mode & 0o111) !== 0).toBe(true);
    });

    test(`${name} passes 'sh -n' syntax check`, async () => {
      const proc = Bun.spawn(["sh", "-n", path], { stdout: "pipe", stderr: "pipe" });
      // Drain stderr concurrently with the exit wait so a huge error
      // message can't deadlock the pipe (defense in depth; `sh -n` output
      // is tiny in practice).
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code, `sh -n failed: ${stderr}`).toBe(0);
    });

    test(`${name} carries the silent-disable stderr line`, () => {
      const body = readFileSync(path, "utf8");
      expect(body).toContain(DISABLE_MARKER);
    });
  }
});
