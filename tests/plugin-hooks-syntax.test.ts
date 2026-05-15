import { describe, test, expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// AC-ZSN2GG.3 / AC-44QGKH.3 — three plugin hook wrappers under
// plugins/quack/hooks/:
// - each is `chmod +x`
// - each passes `sh -n` syntax check
// - each carries the new silent-disable stderr line (bunx wording per
//   AC-44QGKH.3 — references Bun + https://bun.sh, NOT the old
//   "build:hook" binary install)
// - each is a thin 2-line `bunx --bun "${CLAUDE_PLUGIN_ROOT}/..."` wrapper

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK_DIR = join(REPO_ROOT, "plugins/quack/hooks");
const HOOKS: ReadonlyArray<[string, string]> = [
  ["session_start.sh", "session_start.ts"],
  ["stop.sh", "stop.ts"],
  ["post_tool_use.sh", "post_tool_use.ts"],
];
const DISABLE_MARKER = "[quack-hook plugin] bunx not found";
const BUN_LINK = "https://bun.sh";

describe("plugin hook wrappers — base invariants", () => {
  for (const [name] of HOOKS) {
    const path = join(HOOK_DIR, name);

    test(`${name} is executable`, () => {
      const mode = statSync(path).mode;
      expect((mode & 0o111) !== 0).toBe(true);
    });

    test(`${name} passes 'sh -n' syntax check`, async () => {
      const proc = Bun.spawn(["sh", "-n", path], { stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code, `sh -n failed: ${stderr}`).toBe(0);
    });
  }
});

describe("AC-44QGKH.3 — plugin hook wrappers use bunx + silent-disable wording", () => {
  for (const [shim, ts] of HOOKS) {
    const path = join(HOOK_DIR, shim);

    test(`${shim} carries the bunx silent-disable stderr line`, () => {
      const body = readFileSync(path, "utf8");
      expect(body).toContain(DISABLE_MARKER);
      // The new wording points users at https://bun.sh — NOT at the old
      // `bun run build:hook` flow.
      expect(body).toContain(BUN_LINK);
    });

    test(`${shim} does NOT reference the deleted quack-hook binary path`, () => {
      const body = readFileSync(path, "utf8");
      // The binary is gone (AC-44QGKH.9). The shim must not exec it.
      expect(body).not.toContain("exec quack-hook");
      // And no leftover reference to the deleted build script either.
      expect(body).not.toContain("bun run build:hook");
    });

    test(`${shim} exec's bunx --bun against the matching _lib/entry/${ts}`, () => {
      const body = readFileSync(path, "utf8");
      expect(body, `${shim} must call bunx --bun`).toContain("bunx --bun");
      expect(body, `${shim} must reference _lib/entry/${ts}`).toContain(`hooks/_lib/entry/${ts}`);
      expect(body, `${shim} must use literal \${CLAUDE_PLUGIN_ROOT} token`).toContain("${CLAUDE_PLUGIN_ROOT}");
    });

    test(`${shim} silent-disables (exit 0) when bunx is absent`, async () => {
      // Spawn with an empty PATH so `command -v bunx` returns non-zero;
      // the shim must still exit 0 and print exactly one stderr line.
      const bashPath = Bun.which("bash") ?? "/bin/bash";
      const proc = Bun.spawn([bashPath, path], {
        // Pin PATH inside the child to a non-existent dir — `bash` is
        // resolved via the absolute `bashPath` above so the spawn itself
        // succeeds, but the child's `command -v bunx` must fail.
        env: { PATH: "/nonexistent" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.stdin?.end();
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code, `${shim} must exit 0 when bunx is absent (silent-disable)`).toBe(0);
      expect(stderr).toContain(DISABLE_MARKER);
    });
  }
});
