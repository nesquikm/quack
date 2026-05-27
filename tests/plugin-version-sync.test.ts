import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// AC-ZSN2GG.10 (original) — plugin.json is the single source of truth for the
// plugin version; marketplace.json mirrors it. This test fails the gate if the
// two strings ever drift.
//
// AC-9MMXZP.1 + AC-9MMXZP.2 (M7) — extend the parity contract to three-way:
// package.json.version === plugin.json.version === marketplace.plugins[?(name==quack)].version.
// Pre-fix repo shape (0.4.0 / 0.2.0 / 0.2.0) MUST fail this gate; post-fix
// shape (0.4.1 / 0.4.1 / 0.4.1) MUST pass.
//
// AC-9MMXZP.3 (M7) — CLAUDE.md ## Release Files block must declare the
// plugin.json (json/field=version) and marketplace.json (regex anchored on
// "name": "quack") entries so /ship-milestone bumps them on every future
// release.

const REPO_ROOT = join(import.meta.dir, "..");

function readPackageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version?: string };
  if (!pkg.version) {
    throw new Error("package.json must declare a 'version' field");
  }
  return pkg.version;
}

function readPluginVersion(): string {
  const plugin = JSON.parse(
    readFileSync(join(REPO_ROOT, "plugins/quack/.claude-plugin/plugin.json"), "utf8"),
  ) as { version?: string };
  if (!plugin.version) {
    throw new Error("plugins/quack/.claude-plugin/plugin.json must declare a 'version' field");
  }
  return plugin.version;
}

function readMarketplaceQuackVersion(): string {
  const marketplace = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"),
  ) as { plugins: Array<{ name: string; version: string }> };
  const quackEntry = marketplace.plugins.find((p) => p.name === "quack");
  if (!quackEntry) {
    throw new Error("marketplace.json must declare a plugin named 'quack'");
  }
  return quackEntry.version;
}

function readClaudeMdReleaseFilesBlock(): string {
  const claudeMd = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  // Capture the first ```yaml fenced block following the "## Release Files" heading.
  const releaseHeader = claudeMd.indexOf("## Release Files");
  if (releaseHeader < 0) {
    throw new Error("CLAUDE.md is missing a '## Release Files' section");
  }
  const after = claudeMd.slice(releaseHeader);
  const fenceStart = after.indexOf("```yaml");
  const fenceEnd = after.indexOf("```", fenceStart + "```yaml".length);
  if (fenceStart < 0 || fenceEnd < 0) {
    throw new Error("CLAUDE.md '## Release Files' block is not a closed ```yaml fence");
  }
  return after.slice(fenceStart, fenceEnd);
}

describe("plugin / marketplace version sync", () => {
  test("plugin.json version matches marketplace.json plugins[?(name==quack)].version", () => {
    expect(readMarketplaceQuackVersion()).toBe(readPluginVersion());
  });

  test("package.json, plugin.json, and marketplace.json quack entry share one version string (AC-9MMXZP.2)", () => {
    const pkgVersion = readPackageVersion();
    const pluginVersion = readPluginVersion();
    const marketplaceVersion = readMarketplaceQuackVersion();

    // Pairwise equality gives sharp diagnostics on which file drifted.
    expect(pluginVersion).toBe(pkgVersion);
    expect(marketplaceVersion).toBe(pkgVersion);
    expect(marketplaceVersion).toBe(pluginVersion);
  });

  // The three-way version-sync invariant is enforced structurally by the
  // pairwise-equality test above (AC-9MMXZP.2). A hard-coded version literal
  // here was an M7-release artifact (AC-9MMXZP.1) that broke on every release
  // — /ship-milestone bumps the version files but not the test literal — so it
  // was removed. Sync is the contract; the specific number is not.
});

describe("CLAUDE.md ## Release Files declares plugin metadata bumps (AC-9MMXZP.3)", () => {
  test("declares a json entry for plugins/quack/.claude-plugin/plugin.json with field: version", () => {
    const block = readClaudeMdReleaseFilesBlock();

    // The entry must reference the plugin.json path, kind json, and field version.
    expect(block).toContain("plugins/quack/.claude-plugin/plugin.json");

    // Slice the YAML around the plugin.json path so we can sanity-check it's
    // a `kind: json` entry with `field: version`, not e.g. a regex hit.
    const pathIdx = block.indexOf("plugins/quack/.claude-plugin/plugin.json");
    // Inspect ~200 chars around the match (yaml entries are ~3-4 lines).
    const window = block.slice(Math.max(0, pathIdx - 80), pathIdx + 200);
    expect(window).toMatch(/kind:\s*json/);
    expect(window).toMatch(/field:\s*version/);
  });

  test("declares a regex entry for .claude-plugin/marketplace.json anchored on the quack plugin", () => {
    const block = readClaudeMdReleaseFilesBlock();

    expect(block).toContain(".claude-plugin/marketplace.json");

    const pathIdx = block.indexOf(".claude-plugin/marketplace.json");
    const window = block.slice(Math.max(0, pathIdx - 80), pathIdx + 400);

    // Must be a regex-kind entry...
    expect(window).toMatch(/kind:\s*regex/);
    // ...with a pattern anchored on the quack plugin name + a SemVer version capture.
    expect(window).toMatch(/pattern:\s*['"].*"name":\s*"quack".*\(\?<version>/s);
    // ...and a replace string that preserves the "name": "quack" anchor and
    // interpolates {version}.
    expect(window).toMatch(/replace:\s*['"].*"name":\s*"quack".*\{version\}/s);
  });
});
