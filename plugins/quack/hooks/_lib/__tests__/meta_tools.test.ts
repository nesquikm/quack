import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchHook } from "../dispatch";
import { META_TOOLS, isMetaTool } from "../shared/meta_tools";
import type { FetchLike } from "../post";

// AC-Z1W6ED.1 — the client hook drops the agent's own meta/tool-search activity
// (a PostToolUse for a META_TOOLS tool) before egress, so introspection chatter
// never reaches /ingest or the cheap model. Fire-and-forget: no POST, clean exit.

// A fresh temp workspace whose `.mcp.json` carries a quack entry (so dispatch
// resolves config and would post for a non-meta tool).
function workspaceWithQuack(): string {
  const root = mkdtempSync(join(tmpdir(), "quack-meta-"));
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        quack: {
          type: "http",
          url: "https://memory.test:7474/mcp",
          headers: { Authorization: "Bearer wstoken-abc123", "X-Quack-Sub-Project": "my-sub" },
        },
      },
    }),
    "utf8",
  );
  return root;
}

function countingFetch(): { fetchImpl: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetchImpl: async () => {
      n += 1;
      return new Response(null, { status: 202 });
    },
    calls: () => n,
  };
}

describe("AC-Z1W6ED.1 — META_TOOLS meta/tool-search drop", () => {
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  afterEach(() => {
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  });

  test("META_TOOLS is a single exported const containing the tool-search introspection tool", () => {
    expect(META_TOOLS instanceof Set).toBe(true);
    expect(META_TOOLS.has("ToolSearch")).toBe(true);
    // ordinary project tools are NOT meta
    expect(META_TOOLS.has("Read")).toBe(false);
    expect(isMetaTool("ToolSearch")).toBe(true);
    expect(isMetaTool("Edit")).toBe(false);
    expect(isMetaTool(undefined)).toBe(false);
    expect(isMetaTool(42)).toBe(false);
  });

  test("a META_TOOLS PostToolUse payload is dropped before egress (no POST, posted:false, exit 0)", async () => {
    const spy = countingFetch();
    const out = await dispatchHook({
      kind: "post_tool_use",
      payload: { tool_name: "ToolSearch", tool_input: { query: "mcp__quack__search_memory" } },
      dir: workspaceWithQuack(),
      fetchImpl: spy.fetchImpl,
    });
    expect(out.posted).toBe(false);
    expect(out.reason).toBe("meta_tool");
    expect(spy.calls()).toBe(0);
  });

  test("a non-meta PostToolUse tool still posts", async () => {
    const spy = countingFetch();
    const out = await dispatchHook({
      kind: "post_tool_use",
      payload: { tool_name: "Read", tool_input: { file: "x" } },
      dir: workspaceWithQuack(),
      fetchImpl: spy.fetchImpl,
    });
    expect(out.posted).toBe(true);
    expect(spy.calls()).toBe(1);
  });

  test("the drop is scoped to post_tool_use — a Stop envelope is unaffected", async () => {
    const spy = countingFetch();
    const out = await dispatchHook({
      kind: "stop",
      payload: { tool_name: "ToolSearch" },
      dir: workspaceWithQuack(),
      fetchImpl: spy.fetchImpl,
    });
    expect(out.posted).toBe(true);
    expect(spy.calls()).toBe(1);
  });
});
