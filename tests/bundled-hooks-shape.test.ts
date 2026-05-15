import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// AC-44QGKH.6 — byte-checkable bundled-hooks-shape contract gate.
//
// Pins:
//   (a) plugins/quack/hooks/hooks.json parses;
//   (b) keys are exactly SessionStart / Stop / PostToolUse;
//   (c) every `command` field uses the literal `${CLAUDE_PLUGIN_ROOT}` token
//       (no env-substitution drift);
//   (d) every referenced .sh shim exists on disk;
//   (e) every shim references a corresponding `_lib/entry/<name>.ts` that
//       exists on disk.
//
// Runs always — does NOT skip.

const REPO_ROOT = join(import.meta.dir, "..");
const PLUGIN_DIR = join(REPO_ROOT, "plugins/quack");
const HOOKS_JSON = join(PLUGIN_DIR, "hooks/hooks.json");

interface HooksConfig {
  description?: string;
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
}

const EVENT_TO_SCRIPT: ReadonlyArray<[string, string, string]> = [
  // [hooks.json event key, expected .sh filename, expected entry TS basename]
  ["SessionStart", "session_start.sh", "session_start.ts"],
  ["Stop", "stop.sh", "stop.ts"],
  ["PostToolUse", "post_tool_use.sh", "post_tool_use.ts"],
];

describe("AC-44QGKH.6 — bundled-hooks-shape contract", () => {
  test("(a) plugins/quack/hooks/hooks.json parses as JSON", () => {
    expect(existsSync(HOOKS_JSON)).toBe(true);
    const raw = readFileSync(HOOKS_JSON, "utf8");
    expect(() => JSON.parse(raw) as HooksConfig).not.toThrow();
  });

  test("(b) hooks.json declares exactly SessionStart / Stop / PostToolUse — no other keys", () => {
    const cfg = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as HooksConfig;
    const keys = Object.keys(cfg.hooks).sort();
    expect(keys).toEqual(["PostToolUse", "SessionStart", "Stop"]);
  });

  test("(c) every command field uses the literal `${CLAUDE_PLUGIN_ROOT}` token", () => {
    const cfg = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as HooksConfig;
    for (const [event] of EVENT_TO_SCRIPT) {
      const cmd = cfg.hooks[event]?.[0]?.hooks?.[0]?.command;
      expect(cmd, `event ${event} missing command`).toBeDefined();
      // The literal token string must appear verbatim — env-expansion at
      // bundle time would silently drift the value.
      expect(cmd!.includes("${CLAUDE_PLUGIN_ROOT}"), `event ${event} command lost \${CLAUDE_PLUGIN_ROOT}: ${cmd}`).toBe(true);
    }
  });

  test("(d) every referenced .sh shim exists on disk", () => {
    for (const [_event, sh] of EVENT_TO_SCRIPT) {
      const path = join(PLUGIN_DIR, "hooks", sh);
      expect(existsSync(path), `missing shim: ${path}`).toBe(true);
    }
  });

  test("(e) every shim references a corresponding _lib/entry/<name>.ts that exists on disk", () => {
    for (const [_event, sh, ts] of EVENT_TO_SCRIPT) {
      const shPath = join(PLUGIN_DIR, "hooks", sh);
      const tsPath = join(PLUGIN_DIR, "hooks/_lib/entry", ts);
      const shBody = readFileSync(shPath, "utf8");
      // The shim is expected to be a thin bunx wrapper that names the entry
      // file path under _lib/entry/. Pin both the *reference* and the
      // file's *on-disk presence*.
      expect(shBody.includes(`hooks/_lib/entry/${ts}`), `shim ${sh} does not reference _lib/entry/${ts}`).toBe(true);
      expect(existsSync(tsPath), `entry file missing: ${tsPath}`).toBe(true);
    }
  });
});
