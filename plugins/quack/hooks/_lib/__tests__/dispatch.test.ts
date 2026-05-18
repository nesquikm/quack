import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchHook } from "../dispatch";

// AC-55S220.5 — the plugin hooks read configuration from a project-scoped
// `.mcp.json` instead of `process.env`. `dispatchHook` resolves the hook
// config via the `.mcp.json` reader, stamps the resolved sub-project onto
// `HookEnvelope.sub_project`, and OMITS `project_slug` entirely (the server
// resolves the project from the token). This test supplies config via a
// `.mcp.json` written into a temp workspace dir — never via env vars.
//
// Test seam: `DispatchOptions.dir` names the directory to begin the
// `.mcp.json` walk-up from. The production path passes no `dir`, so the
// runtime walk starts at `CLAUDE_PROJECT_DIR` (falling back to cwd).

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

// Build a fresh temp workspace with a `.mcp.json` carrying the quack entry.
function workspaceWithQuack(): string {
  const root = mkdtempSync(join(tmpdir(), "quack-dispatch-"));
  writeMcpJson(root, { quack: QUACK_ENTRY });
  return root;
}

interface PostedEnvelope {
  kind: string;
  payload: { transcript?: string };
  sub_project?: string;
  project_slug?: string;
}

describe("dispatchHook", () => {
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  afterEach(() => {
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  });

  test("happy path: redacts + posts an envelope with sub_project from .mcp.json", async () => {
    let bodyJson: unknown = null;
    const fakeFetch: import("../post").FetchLike = async (_url, init) => {
      bodyJson = JSON.parse(String(init?.body));
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: { transcript: "secret token sk-abcdefghijklmnopqrstuvwx" },
      dir: workspaceWithQuack(),
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(true);
    const env = bodyJson as PostedEnvelope;
    expect(env.kind).toBe("stop");
    expect(env.payload.transcript).toContain("«REDACTED»");
    // AC-55S220.5 — the sub-project is stamped from the .mcp.json
    // `X-Quack-Sub-Project` header onto `HookEnvelope.sub_project`.
    expect(env.sub_project).toBe("my-sub");
  });

  test("omits project_slug — the server resolves the project from the token", async () => {
    let bodyJson: unknown = null;
    const fakeFetch: import("../post").FetchLike = async (_url, init) => {
      bodyJson = JSON.parse(String(init?.body));
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "session_start",
      payload: { hello: "world" },
      dir: workspaceWithQuack(),
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(true);
    const env = bodyJson as Record<string, unknown>;
    // AC-55S220.5 — the hook omits `project_slug` from the envelope entirely.
    expect(env).not.toHaveProperty("project_slug");
  });

  test("production wiring: resolves .mcp.json by walking up from CLAUDE_PROJECT_DIR", async () => {
    // No `dir` seam — this exercises the real runtime path. The hook must
    // locate `.mcp.json` via CLAUDE_PROJECT_DIR, NOT fall through to env vars.
    const root = workspaceWithQuack();
    process.env.CLAUDE_PROJECT_DIR = root;
    let bodyJson: unknown = null;
    const fakeFetch: import("../post").FetchLike = async (_url, init) => {
      bodyJson = JSON.parse(String(init?.body));
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "post_tool_use",
      payload: { tool: "Bash" },
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(true);
    const env = bodyJson as PostedEnvelope;
    expect(env.sub_project).toBe("my-sub");
    expect(env).not.toHaveProperty("project_slug");
  });

  test("unknown kind ⇒ no fetch", async () => {
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "garbage",
      payload: {},
      dir: workspaceWithQuack(),
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(out.reason).toBe("unknown_kind");
    expect(called).toBe(0);
  });

  test("absent .mcp.json ⇒ no fetch (silent disable)", async () => {
    // A temp dir with no `.mcp.json` at all. CLAUDE_PROJECT_DIR points here
    // so the walk-up cannot escape into a real ancestor `.mcp.json`.
    const empty = mkdtempSync(join(tmpdir(), "quack-dispatch-empty-"));
    process.env.CLAUDE_PROJECT_DIR = empty;
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: {},
      dir: empty,
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(called).toBe(0);
  });

  test("malformed .mcp.json ⇒ no fetch (silent disable)", async () => {
    const root = mkdtempSync(join(tmpdir(), "quack-dispatch-bad-"));
    writeFileSync(join(root, ".mcp.json"), "{ not valid json", "utf8");
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: {},
      dir: root,
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(called).toBe(0);
  });

  test("no `quack` entry ⇒ no fetch (silent disable)", async () => {
    const root = mkdtempSync(join(tmpdir(), "quack-dispatch-noquack-"));
    writeMcpJson(root, {
      other: { type: "http", url: "https://other.test/mcp", headers: {} },
    });
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: {},
      dir: root,
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(called).toBe(0);
  });

  test("missing payload ⇒ no fetch", async () => {
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: null,
      dir: workspaceWithQuack(),
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(called).toBe(0);
  });
});
