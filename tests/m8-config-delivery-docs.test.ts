import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// FR-55S220 — doc-surface coverage. The `.mcp.json` config-delivery model
// touches the plugin README, the repo-root README, technical-spec.md, and
// requirements.md. These grep-style content tests pin the prose changes.
//
// Covers AC-55S220.6 (README install-flow rewrite), AC-55S220.7 (ADR +
// README tradeoff note), AC-55S220.9 (requirements matrix + cross-cutting
// prose corrections).

const REPO_ROOT = join(import.meta.dir, "..");
const PLUGIN_README = join(REPO_ROOT, "plugins/quack/README.md");
const ROOT_README = join(REPO_ROOT, "README.md");
const TECH_SPEC = join(REPO_ROOT, "specs/technical-spec.md");
const REQS = join(REPO_ROOT, "specs/requirements.md");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("AC-55S220.6 — plugin README drops the .envrc / direnv install flow", () => {
  test("plugin README no longer instructs `direnv allow`", () => {
    expect(read(PLUGIN_README)).not.toContain("direnv allow");
  });

  test("plugin README no longer documents writing a `.envrc`", () => {
    expect(read(PLUGIN_README)).not.toContain(".envrc");
  });

  test("plugin README drops `direnv` from the prerequisites", () => {
    // direnv is no longer a host prerequisite — config lives in .mcp.json,
    // read natively by Claude Code and by the hooks.
    expect(read(PLUGIN_README).toLowerCase()).not.toContain("direnv");
  });

  test("plugin README drops the QUACK_SERVER_URL / QUACK_TOKEN env-var table", () => {
    const body = read(PLUGIN_README);
    // The env-var configuration table is removed — config is .mcp.json now.
    expect(body).not.toContain("QUACK_SERVER_URL");
    // No *bare* QUACK_TOKEN env-var reference. The AC-55S220.7 post-MVP note
    // legitimately names the `${QUACK_TOKEN}` substitution syntax — strip that
    // token first so the two ACs are not mutually exclusive on this file.
    expect(body.replace(/\$\{QUACK_TOKEN\}/g, "")).not.toContain("QUACK_TOKEN");
  });

  test("plugin README documents the .mcp.json flow + a single session restart", () => {
    const body = read(PLUGIN_README);
    expect(body).toContain(".mcp.json");
    expect(body.toLowerCase()).toMatch(/restart .* (claude code )?session|session restart/);
  });

  test("repo-root README drops the `direnv allow` install step", () => {
    expect(read(ROOT_README)).not.toContain("direnv allow");
  });

  test("repo-root README no longer documents a `.envrc`", () => {
    expect(read(ROOT_README)).not.toContain(".envrc");
  });
});

describe("AC-55S220.7 — committed-literal-token tradeoff is documented", () => {
  test("plugin README documents the committed literal non-admin single-project token", () => {
    const body = read(PLUGIN_README).toLowerCase();
    expect(body).toContain(".mcp.json");
    expect(body).toContain("literal");
    expect(body).toContain("non-admin");
    expect(body).toMatch(/committed by default|commit .* by default/);
  });

  test("plugin README names the post-MVP path (${QUACK_TOKEN} substitution + .gitignore)", () => {
    const body = read(PLUGIN_README);
    expect(body).toContain("${QUACK_TOKEN}");
    expect(body).toContain(".gitignore");
  });

  test("technical-spec.md adds a Key Design Decision row for the .mcp.json config artifact", () => {
    const body = read(TECH_SPEC);
    expect(body).toContain(".mcp.json");
    // The new ADR / key-design-decision row records the committed-token call.
    const lower = body.toLowerCase();
    expect(lower).toContain("literal");
    expect(lower).toMatch(/committed by default|commit .* by default/);
  });
});

describe("AC-55S220.9 — requirements.md + technical-spec.md cross-cutting prose corrected", () => {
  test("requirements.md § Delivery model no longer describes env-var / .envrc config", () => {
    const body = read(REQS);
    // The Delivery-model paragraph must be corrected to the .mcp.json
    // mechanism — no env-var-driven config, no direnv.
    expect(body).not.toContain(".envrc");
    expect(body.toLowerCase()).not.toContain("direnv");
  });

  test("requirements.md documents the .mcp.json config-delivery mechanism", () => {
    expect(read(REQS)).toContain(".mcp.json");
  });

  test("technical-spec.md §1 Plugin packaging no longer references direnv / .envrc", () => {
    const body = read(TECH_SPEC);
    expect(body).not.toContain(".envrc");
    expect(body.toLowerCase()).not.toContain("direnv");
  });

  test("requirements.md traceability matrix has a row for every AC-55S220.* AC", () => {
    const body = read(REQS);
    for (let i = 1; i <= 9; i++) {
      expect(body, `missing matrix row for AC-55S220.${i}`).toContain(`AC-55S220.${i}`);
    }
  });

  test("requirements.md traceability matrix has a row for every AC-A9BN0M.* AC", () => {
    const body = read(REQS);
    for (let i = 1; i <= 9; i++) {
      expect(body, `missing matrix row for AC-A9BN0M.${i}`).toContain(`AC-A9BN0M.${i}`);
    }
  });

  test("the AC-ZSN2GG.4 matrix row no longer points at mcp-servers/quack.json", () => {
    const body = read(REQS);
    const row = body.split("\n").find((l) => l.includes("AC-ZSN2GG.4"));
    expect(row, "AC-ZSN2GG.4 row missing from matrix").toBeDefined();
    expect(row!).not.toContain("mcp-servers/quack.json");
  });

  test("the AC-ZSN2GG.5 matrix row reflects the new config-delivery shape (no .envrc)", () => {
    const body = read(REQS);
    const row = body.split("\n").find((l) => l.includes("AC-ZSN2GG.5"));
    expect(row, "AC-ZSN2GG.5 row missing from matrix").toBeDefined();
    expect(row!).not.toContain(".envrc");
  });
});
