import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// FR-55S220 — `/quack:install` is a markdown command file (no unit-testable
// code). Its shape is pinned by this presence/structure test: the `.mcp.json`
// writer steps, the adaptive token-minting branch, the sub-project derivation,
// the merge / non-overwrite behaviour, the removed `.envrc` path, and the
// committed-literal-token tradeoff note.
//
// Covers AC-55S220.1, .2, .3, .6 (install-path side), .7, .8 (shape pinning).

const REPO_ROOT = join(import.meta.dir, "..");
const INSTALL_MD = join(REPO_ROOT, "plugins/quack/commands/install.md");

function body(): string {
  return readFileSync(INSTALL_MD, "utf8");
}

describe("AC-55S220.1 — install.md documents the .mcp.json writer", () => {
  test("references .mcp.json (not .envrc) as the config artifact it writes", () => {
    const md = body();
    expect(md).toContain(".mcp.json");
  });

  test("resolves the workspace root via git rev-parse --show-toplevel with a $PWD fallback", () => {
    const md = body();
    expect(md).toContain("git rev-parse --show-toplevel");
    expect(md).toMatch(/\$PWD/);
  });

  test("documents the mcpServers.quack entry shape — http transport, /mcp url suffix", () => {
    const md = body();
    expect(md).toContain("mcpServers");
    expect(md).toContain('"quack"');
    expect(md).toContain('"type": "http"');
    expect(md).toMatch(/\/mcp/);
  });

  test("documents the Authorization Bearer and X-Quack-Sub-Project headers", () => {
    const md = body();
    expect(md).toContain("Authorization");
    expect(md).toContain("Bearer");
    expect(md).toContain("X-Quack-Sub-Project");
  });

  test("documents merge-into-existing-mcpServers without disturbing siblings", () => {
    const md = body();
    expect(md.toLowerCase()).toContain("merge");
    // The merge must preserve sibling MCP servers already in the file.
    expect(md.toLowerCase()).toMatch(/sibling|other server|existing server/);
  });

  test("refuses to overwrite an existing `quack` entry and prints a manual-merge snippet", () => {
    const md = body();
    expect(md.toLowerCase()).toMatch(/refus|do not overwrite|don't overwrite/);
  });
});

describe("AC-55S220.2 — install.md is adaptive on token minting", () => {
  test("documents the admin-token-available branch — mint via the admin MCP flow", () => {
    const md = body();
    expect(md).toContain("QUACK_ADMIN_TOKEN");
    // The idempotent admin-MCP minting sequence.
    expect(md).toContain("create_project");
    expect(md).toContain("register_user");
    expect(md).toContain("add_member");
  });

  test("documents the no-admin-token branch — prompt the operator to paste a token", () => {
    const md = body();
    // Adaptive: when no admin token is available, the operator pastes an
    // already-issued per-workspace token.
    expect(md.toLowerCase()).toMatch(/paste|already-issued|already issued/);
  });
});

describe("AC-55S220.3 — install.md derives + confirms a sub-project slug", () => {
  test("derives a suggestion from git remote get-url origin", () => {
    const md = body();
    expect(md).toContain("git remote get-url origin");
  });

  test("falls back to the workspace directory basename when there is no remote", () => {
    const md = body();
    expect(md.toLowerCase()).toMatch(/basename|directory name|no remote/);
  });

  test("accepts a --sub <name> argument that skips the prompt", () => {
    const md = body();
    expect(md).toContain("--sub");
  });

  test("validates the final sub-project against the slug regex", () => {
    const md = body();
    expect(md).toContain("^[a-z0-9][a-z0-9_-]{0,62}$");
  });

  test("interactively presents the suggestion for accept-or-override", () => {
    const md = body();
    expect(md).toContain("Sub-project");
  });
});

describe("AC-55S220.4 — install.md drops the stale mcp-servers/quack.json reference", () => {
  test("does not claim the MCP server is declared in mcp-servers/quack.json", () => {
    // FR-55S220 deletes the plugin-declared `mcp-servers/quack.json`. The
    // command file must not still point at it — the server is declared only
    // by the project-scoped `.mcp.json`.
    const md = body();
    expect(md).not.toContain("mcp-servers/quack.json");
  });
});

describe("AC-55S220.6 — install.md drops the .envrc / direnv path", () => {
  test("no longer writes .envrc", () => {
    const md = body();
    expect(md).not.toContain(".envrc");
  });

  test("no longer instructs `direnv allow`", () => {
    const md = body();
    expect(md).not.toContain("direnv allow");
  });

  test("does not instruct `unset QUACK_ADMIN_TOKEN` as a direnv-era step", () => {
    const md = body();
    expect(md).not.toContain("unset QUACK_ADMIN_TOKEN");
  });
});

describe("AC-55S220.7 — install.md closing output documents the committed-token tradeoff", () => {
  test("states .mcp.json holds a literal non-admin single-project token", () => {
    const md = body().toLowerCase();
    expect(md).toContain("literal");
    expect(md).toContain("non-admin");
  });

  test("states .mcp.json is committed by default for the MVP", () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/committed by default|commit .* by default/);
  });

  test("names the post-MVP path — ${QUACK_TOKEN} substitution + .gitignore", () => {
    const md = body();
    expect(md).toContain("${QUACK_TOKEN}");
    expect(md).toContain(".gitignore");
  });
});
