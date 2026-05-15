import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// AC-ZSN2GG.9 — exercise the marketplace round-trip locally.
//
// Two-tier strategy:
//
// 1. **Source-tree invariant (always runs).** Asserts that the source
//    `plugins/quack/` directory contains *only* plugin-scoped files and
//    *zero* server / repo-level files. `claude plugin install` is a
//    directory copy — if the source is clean, the installed copy is
//    clean. This is the cheap, deterministic guard.
//
// 2. **Real CLI round-trip (opt-in via `QUACK_E2E_PLUGIN=1` + claude on
//    PATH).** Spawns `claude plugin marketplace add <repo>` then
//    `claude plugin install quack`, then locates the installed copy via
//    `claude plugin list --json` (the CLI publishes `installPath` so we
//    don't have to guess at the cache directory layout), and asserts the
//    installed tree matches the same shape. Default-off because the CLI
//    mutates the user's global Claude Code state; we don't want a
//    routine `bun test` rearranging the developer's plugin list.
//    `test.skipIf` means the runner reports a visible SKIP (not a fake
//    PASS).

const REPO_ROOT = join(import.meta.dir, "..");
const PLUGIN_DIR = join(REPO_ROOT, "plugins/quack");
const CLAUDE_ON_PATH = Bun.which("claude") !== null;
const E2E_OPT_IN = Bun.env.QUACK_E2E_PLUGIN === "1";

interface InstalledPlugin {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath: string;
}

describe("plugin install — source-tree invariants (always)", () => {
  test("plugin source contains required plugin-scoped files", () => {
    expect(existsSync(PLUGIN_DIR)).toBe(true);
    const required = [
      ".claude-plugin/plugin.json",
      "hooks/session_start.sh",
      "hooks/stop.sh",
      "hooks/post_tool_use.sh",
      "mcp-servers/quack.json",
      "commands/quack-install.md",
      "README.md",
      // AC-44QGKH.8 — _lib/ now lives inside the plugin tree (hermetic).
      "hooks/_lib/dispatch.ts",
      "hooks/_lib/redact.ts",
      "hooks/_lib/post.ts",
      "hooks/_lib/config.ts",
      "hooks/_lib/payload.ts",
      "hooks/_lib/shared/envelope.ts",
      "hooks/_lib/shared/redaction_patterns.ts",
      "hooks/_lib/entry/session_start.ts",
      "hooks/_lib/entry/stop.ts",
      "hooks/_lib/entry/post_tool_use.ts",
    ];
    for (const rel of required) {
      expect(existsSync(join(PLUGIN_DIR, rel)), `missing ${rel}`).toBe(true);
    }
  });

  test("plugin source forbids server / repo-level files", () => {
    // AC-44QGKH.8 — extend hermeticity invariants: dist/ + package.json
    // (repo-root build artifacts) must never appear in the installed tree.
    const forbiddenTop = [
      "src",
      "dist",
      "compose.yml",
      "Dockerfile",
      "specs",
      "CLAUDE.md",
      "node_modules",
      "tests",
      "package.json",
    ];
    const entries = readdirSync(PLUGIN_DIR);
    for (const f of forbiddenTop) {
      expect(entries.includes(f), `plugins/quack/ unexpectedly contains '${f}'`).toBe(false);
    }
  });

  test("plugin source top-level entries are restricted to the documented set", () => {
    const allowed = new Set([".claude-plugin", "hooks", "mcp-servers", "commands", "README.md"]);
    const entries = readdirSync(PLUGIN_DIR);
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".claude-plugin") continue;
      expect(allowed.has(entry), `unexpected entry in plugins/quack/: ${entry}`).toBe(true);
    }
  });

  test("plugin source footprint is small (< 100 KB)", () => {
    // AC-44QGKH.8 — bumped from 50 KB to 100 KB because the hook code
    // (dispatch + redact + post + config + payload + entries + ported
    // tests) now lives inside the plugin tree under hooks/_lib/.
    let total = 0;
    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else total += s.size;
      }
    }
    walk(PLUGIN_DIR);
    expect(total).toBeLessThan(100_000);
  });
});

describe("plugin install — real CLI round-trip (opt-in)", () => {
  test.skipIf(!E2E_OPT_IN || !CLAUDE_ON_PATH)(
    "claude plugin marketplace add + plugin install lands a clean tree at the installPath",
    async () => {
      const add = Bun.spawn(["claude", "plugin", "marketplace", "add", REPO_ROOT], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [addCode, addErr] = await Promise.all([add.exited, new Response(add.stderr).text()]);
      expect(addCode, `claude plugin marketplace add failed: ${addErr}`).toBe(0);

      // `quack@quack` disambiguates against any other marketplace that
      // might also publish a `quack` plugin in the user's setup.
      const inst = Bun.spawn(["claude", "plugin", "install", "quack@quack"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [instCode, instErr] = await Promise.all([inst.exited, new Response(inst.stderr).text()]);
      expect(instCode, `claude plugin install quack@quack failed: ${instErr}`).toBe(0);

      // Discover the installed location via the CLI rather than hard-
      // coding the cache layout — the CLI publishes `installPath` per
      // plugin in its JSON list output.
      const list = Bun.spawn(["claude", "plugin", "list", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [listCode, listOut] = await Promise.all([list.exited, new Response(list.stdout).text()]);
      expect(listCode).toBe(0);
      const installed = JSON.parse(listOut) as InstalledPlugin[];
      const quackEntries = installed.filter((p) => p.id === "quack@quack");
      expect(quackEntries.length, "expected at least one installed quack@quack entry").toBeGreaterThan(0);
      const installedRoot = quackEntries[0]!.installPath;
      expect(existsSync(installedRoot), `expected installed plugin at ${installedRoot}`).toBe(true);

      const requiredAtInstall = [
        ".claude-plugin/plugin.json",
        "hooks/session_start.sh",
        "hooks/stop.sh",
        "hooks/post_tool_use.sh",
        "mcp-servers/quack.json",
        "commands/quack-install.md",
        "README.md",
        // AC-44QGKH.8 — _lib/ must be installed alongside the shims.
        "hooks/_lib/dispatch.ts",
        "hooks/_lib/payload.ts",
        "hooks/_lib/entry/session_start.ts",
        "hooks/_lib/entry/stop.ts",
        "hooks/_lib/entry/post_tool_use.ts",
      ];
      for (const rel of requiredAtInstall) {
        expect(existsSync(join(installedRoot, rel)), `installed plugin missing ${rel}`).toBe(true);
      }
      const forbiddenAtInstall = [
        "src",
        "dist",
        "compose.yml",
        "Dockerfile",
        "specs",
        "CLAUDE.md",
        "node_modules",
        "tests",
        "package.json",
      ];
      for (const rel of forbiddenAtInstall) {
        expect(existsSync(join(installedRoot, rel)), `installed plugin must not contain ${rel}`).toBe(false);
      }
    },
    60_000,
  );
});
