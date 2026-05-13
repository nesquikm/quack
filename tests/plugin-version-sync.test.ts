import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// AC-ZSN2GG.10 — plugin.json is the single source of truth for the plugin
// version; marketplace.json mirrors it. This test fails the gate if the
// two strings ever drift.

const REPO_ROOT = join(import.meta.dir, "..");

describe("plugin / marketplace version sync", () => {
  test("plugin.json version matches marketplace.json plugins[0].version", () => {
    const plugin = JSON.parse(
      readFileSync(join(REPO_ROOT, "plugins/quack/.claude-plugin/plugin.json"), "utf8"),
    ) as { version: string };
    const marketplace = JSON.parse(
      readFileSync(join(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"),
    ) as { plugins: Array<{ name: string; version: string }> };

    const quackEntry = marketplace.plugins.find((p) => p.name === "quack");
    expect(quackEntry, "marketplace.json must declare a plugin named 'quack'").toBeDefined();
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.length).toBeGreaterThan(0);
    expect(quackEntry!.version).toBe(plugin.version);
  });
});
