import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// AC-44QGKH.2 — `plugins/quack/hooks/_lib/entry/{session_start,stop,post_tool_use}.ts`
// exist; each is a thin entry of the shape:
//   parseHookPayload(await stdin) → dispatchHook(kind, payload) → exit 0
// Errors swallowed to stderr + exit 0 (silent-disable invariant).
// Total ≤ 30 LOC each.

const ENTRY_DIR = join(import.meta.dir, "..", "entry");

const ENTRIES: ReadonlyArray<[string, string]> = [
  ["session_start.ts", "session_start"],
  ["stop.ts", "stop"],
  ["post_tool_use.ts", "post_tool_use"],
];

describe("AC-44QGKH.2 — _lib/entry/<name>.ts thin entry files", () => {
  for (const [filename, kind] of ENTRIES) {
    const path = join(ENTRY_DIR, filename);

    test(`${filename} exists`, () => {
      expect(existsSync(path), `missing entry: ${path}`).toBe(true);
    });

    test(`${filename} is ≤ 30 lines of code`, () => {
      const body = readFileSync(path, "utf8");
      // Count non-blank, non-comment-only lines to honour the "thin entry"
      // contract (FR notes the cap is on actual LOC, not raw line count).
      const loc = body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
      expect(loc.length, `${filename} has ${loc.length} LOC > 30`).toBeLessThanOrEqual(30);
    });

    test(`${filename} routes through parseHookPayload + dispatchHook(${kind})`, () => {
      const body = readFileSync(path, "utf8");
      expect(body, `${filename} must call parseHookPayload`).toContain("parseHookPayload");
      expect(body, `${filename} must call dispatchHook`).toContain("dispatchHook");
      // The entry file pins the hook kind literally — the harness invokes
      // the matching shim, so the kind string is fixed per file.
      expect(body, `${filename} must reference kind "${kind}"`).toContain(`"${kind}"`);
    });
  }
});
