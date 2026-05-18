import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Cross-AC direct coverage for files that other plugin tests reach only
// transitively. Each block here pins one AC by name.

const REPO_ROOT = join(import.meta.dir, "..");

describe("AC-ZSN2GG.3 — plugins/quack/hooks/hooks.json registers all three events", () => {
  test("hooks.json declares SessionStart / Stop / PostToolUse with bash command refs", () => {
    const raw = readFileSync(join(REPO_ROOT, "plugins/quack/hooks/hooks.json"), "utf8");
    const cfg = JSON.parse(raw) as {
      description?: string;
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    // Claude Code's plugin hook spec keys hooks by event name (CamelCase).
    // Without this manifest, the shell scripts under plugins/quack/hooks/
    // never fire — directory-based discovery is insufficient for hooks
    // (it IS sufficient for commands/ and mcp-servers/, but not hooks/).
    for (const event of ["SessionStart", "Stop", "PostToolUse"]) {
      expect(cfg.hooks[event], `hooks.json missing event registration: ${event}`).toBeDefined();
      const inner = cfg.hooks[event]![0]!.hooks[0]!;
      expect(inner.type).toBe("command");
      expect(inner.command).toContain("${CLAUDE_PLUGIN_ROOT}");
      // Each event must reference its matching .sh file by name so the
      // SessionStart hook can't accidentally point at stop.sh, etc.
      const expectedScript = event === "SessionStart" ? "session_start.sh"
        : event === "Stop" ? "stop.sh"
        : "post_tool_use.sh";
      expect(inner.command).toContain(expectedScript);
    }
  });
});

describe("AC-55S220.4 — plugins/quack/mcp-servers/quack.json is deleted", () => {
  test("the plugin no longer ships mcp-servers/quack.json", () => {
    // FR-55S220 removes the plugin-declared MCP server. The Quack MCP
    // server is declared ONLY by the project-scoped .mcp.json that
    // /quack:install writes — there is exactly one declaration.
    expect(existsSync(join(REPO_ROOT, "plugins/quack/mcp-servers/quack.json"))).toBe(false);
  });

  test("the plugin no longer ships an mcp-servers/ directory", () => {
    expect(existsSync(join(REPO_ROOT, "plugins/quack/mcp-servers"))).toBe(false);
  });

  test("plugin.json carries no reference to mcp-servers/quack.json", () => {
    const manifest = readFileSync(join(REPO_ROOT, "plugins/quack/.claude-plugin/plugin.json"), "utf8");
    expect(manifest).not.toContain("mcp-servers");
    expect(manifest).not.toContain("quack.json");
  });

  test("plugins/quack/README.md no longer references mcp-servers/quack.json", () => {
    // The "What this plugin ships" directory-tree diagram must not list the
    // removed `mcp-servers/quack.json` — the server is declared only by the
    // project-scoped `.mcp.json` that /quack:install writes.
    const body = readFileSync(join(REPO_ROOT, "plugins/quack/README.md"), "utf8");
    expect(body).not.toContain("mcp-servers/quack.json");
  });
});

describe("AC-44QGKH.12 — plugins/quack/README.md three-step install flow", () => {
  // FR-44QGKH replaces the previous FR-ZSN2GG four-step flow: the
  // `bun run build:hook` + PATH install step is gone (hooks run via
  // `bunx --bun` against the plugin-bundled TS sources). Bun is named
  // as the sole host prerequisite.
  test.each([
    "Step 1. Clone the Quack repo",
    "Step 2. Install the plugin from the local marketplace",
    "Step 3. Per-workspace",
    "https://bun.sh",
    "Manual smoke (AC-ZSN2GG.11)",
  ])("contains heading: %s", (needle) => {
    const body = readFileSync(join(REPO_ROOT, "plugins/quack/README.md"), "utf8");
    expect(body).toContain(needle);
  });
});

describe("AC-ZSN2GG.7 — repo-root README install-as-plugin section", () => {
  test("has 'Install as Claude Code plugin' section", () => {
    const body = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(body).toContain("## Install as Claude Code plugin");
  });
  test("Deployment section is amended to point operators vs end users", () => {
    const body = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(body).toContain("Audience:");
    expect(body).toContain("server operators running the Docker stack");
  });
  test("links into plugins/quack/README.md", () => {
    const body = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(body).toContain("plugins/quack/README.md");
  });
});

describe("AC-ZSN2GG.8 — .dockerignore excludes plugin source", () => {
  test("excludes plugins/", () => {
    const body = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    // Either bare-line `plugins/` or the directory pattern is fine; both
    // semantically exclude the marketplace plugin from the docker context.
    const lines = body.split("\n").map((s) => s.trim());
    expect(lines).toContain("plugins/");
  });
  test("excludes .claude-plugin/ (repo-root marketplace declaration)", () => {
    const body = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    const lines = body.split("\n").map((s) => s.trim());
    expect(lines).toContain(".claude-plugin/");
  });
});
