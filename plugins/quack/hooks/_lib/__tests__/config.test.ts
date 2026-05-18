import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config";

// AC-55S220.5 — `config.ts` is reworked to locate, parse, and extract
// configuration from a project-scoped `.mcp.json` instead of `process.env`.
//
// AC-55S220.8 — this (reworked) test covers the `.mcp.json` reader: valid
// file, absent file, no `quack` entry, malformed JSON ⇒ silent no-op
// (null). The `resolveConfig` reader is exercised via a directory seam
// (`startDir`) that points at a temp workspace tree so the walk-up logic
// is testable hermetically.

interface McpServerEntry {
  type: string;
  url: string;
  headers: Record<string, string>;
}

function writeMcpJson(dir: string, servers: Record<string, McpServerEntry>): void {
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
}

const QUACK_ENTRY: McpServerEntry = {
  type: "http",
  url: "https://memory.test:7474/mcp",
  headers: {
    Authorization: "Bearer wstoken-abc123",
    "X-Quack-Sub-Project": "my-sub",
  },
};

describe("resolveConfig — reads .mcp.json (AC-55S220.5)", () => {
  test("valid .mcp.json yields server URL (/mcp stripped), token (Bearer stripped), sub-project", () => {
    const root = mkdtempSync(join(tmpdir(), "quack-mcpcfg-"));
    writeMcpJson(root, { quack: QUACK_ENTRY });
    const cfg = resolveConfig({ startDir: root });
    expect(cfg).not.toBeNull();
    // url value with a trailing /mcp stripped → the ingest base URL.
    expect(cfg!.serverUrl).toBe("https://memory.test:7474");
    // headers.Authorization minus the "Bearer " prefix.
    expect(cfg!.token).toBe("wstoken-abc123");
    // headers["X-Quack-Sub-Project"] → the sub-project tag.
    expect(cfg!.subProject).toBe("my-sub");
  });

  test("walks up from startDir to the workspace root to find .mcp.json", () => {
    const root = mkdtempSync(join(tmpdir(), "quack-mcpcfg-"));
    writeMcpJson(root, { quack: QUACK_ENTRY });
    const nested = join(root, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });
    const cfg = resolveConfig({ startDir: nested });
    expect(cfg).not.toBeNull();
    expect(cfg!.token).toBe("wstoken-abc123");
    expect(cfg!.subProject).toBe("my-sub");
  });

  test("absent .mcp.json ⇒ null (silent disable)", () => {
    const root = mkdtempSync(join(tmpdir(), "quack-mcpcfg-"));
    expect(resolveConfig({ startDir: root })).toBeNull();
  });

  test("no `quack` entry in mcpServers ⇒ null (silent disable)", () => {
    const root = mkdtempSync(join(tmpdir(), "quack-mcpcfg-"));
    writeMcpJson(root, {
      other: { type: "http", url: "https://other.test/mcp", headers: {} },
    });
    expect(resolveConfig({ startDir: root })).toBeNull();
  });

  test("malformed JSON ⇒ null (silent disable, no throw)", () => {
    const root = mkdtempSync(join(tmpdir(), "quack-mcpcfg-"));
    writeFileSync(join(root, ".mcp.json"), "{ this is not json", "utf8");
    let cfg: ReturnType<typeof resolveConfig>;
    expect(() => {
      cfg = resolveConfig({ startDir: root });
    }).not.toThrow();
    expect(cfg!).toBeNull();
  });

  test("does not surface project_slug — the server resolves project from the token", () => {
    const root = mkdtempSync(join(tmpdir(), "quack-mcpcfg-"));
    writeMcpJson(root, { quack: QUACK_ENTRY });
    const cfg = resolveConfig({ startDir: root }) as Record<string, unknown>;
    expect(cfg).not.toBeNull();
    // AC-55S220.5 — the hook omits project_slug entirely.
    expect(cfg["projectSlug"]).toBeUndefined();
  });

  test("malformed X-Quack-Sub-Project slug ⇒ subProject dropped, config still resolves", () => {
    const root = mkdtempSync(join(tmpdir(), "quack-mcpcfg-"));
    writeMcpJson(root, {
      quack: {
        type: "http",
        url: "https://memory.test:7474/mcp",
        headers: {
          Authorization: "Bearer wstoken-abc123",
          "X-Quack-Sub-Project": "Bad Slug!",
        },
      },
    });
    const cfg = resolveConfig({ startDir: root });
    expect(cfg).not.toBeNull();
    expect(cfg!.token).toBe("wstoken-abc123");
    // Defense-in-depth — a non-conforming slug is dropped (treated as absent)
    // rather than stamped onto every envelope and 400-rejected by the server.
    expect(cfg!.subProject).toBeUndefined();
  });
});
