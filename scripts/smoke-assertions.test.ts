// Unit tests for the pure helper logic of the comprehensive smoke driver
// (`scripts/smoke-assertions.ts`, FR-D17E0R). These exercise the driver's
// *decision logic* against inline fixture JSON — no network, no Docker, no
// model. The live round-trips (AC.2–.5) are proven by running the smoke itself,
// not here.
//
// Fixture shapes are grounded in the real wire envelopes:
//   - MCP result: { content: [{ type: "text", text: <JSON string> }], isError? }
//     (src/mcp/server.ts ok()/errResult())
//   - MemoryEnvelope<T>: { results: T[], meta: { mode_used, coverage, warnings } }
//     (src/mcp/memory/coverage.ts)
//   - MemoryItem: { kind, id, ... name|summary ..., _memory_wrapped }
//     (src/mcp/memory/dto.ts)
//   - list_users: { users: [{ id, username, role, created_at }] }
//   - list_projects: { projects: [{ id, slug, display_name, created_at }] }
//   - server_status: { counts: { users, projects, tokens_active, ... } }
//   - HookEnvelope: { kind, payload, sub_project?, ts? }
//     (plugins/quack/hooks/_lib/shared/envelope.ts)

import { describe, test, expect } from "bun:test";
import {
  parseMcpText,
  discoverNodeId,
  hasNeighbor,
  pathFound,
  decisionPresent,
  isGroundedAnswer,
  contentSurfaced,
  userListed,
  projectListed,
  countsReflect,
  tokenRejected,
  projectGone,
  buildHookEnvelope,
  isMetaToolEnvelope,
  summarize,
} from "./smoke-assertions";

// ---- helpers to build realistic fixtures ---------------------------------

function mcpResult(body: unknown, isError = false): unknown {
  const base = { content: [{ type: "text", text: JSON.stringify(body) }] };
  return isError ? { ...base, isError: true } : base;
}

function rpc(result: unknown): unknown {
  return { jsonrpc: "2.0", id: 1, result };
}

function envelope(
  results: unknown[],
  warnings: string[] = [],
  modeUsed: "templates" | "planned" = "templates",
): unknown {
  return {
    results,
    meta: {
      mode_used: modeUsed,
      coverage: { matched_entities: results.length, traversals: 0, truncated: false },
      warnings,
    },
  };
}

// ---- parseMcpText --------------------------------------------------------

describe("parseMcpText", () => {
  test("unwraps result.content[0].text JSON string into an object", () => {
    const env = envelope([{ kind: "Entity", id: "n1", name: "PostgreSQL" }]);
    const parsed = parseMcpText(rpc(mcpResult(env))) as {
      results: { name: string }[];
    };
    expect(parsed.results[0]!.name).toBe("PostgreSQL");
  });

  test("surfaces isError when the MCP result has isError: true", () => {
    const errBody = { error: "forbidden" };
    const parsed = parseMcpText(rpc(mcpResult(errBody, true))) as {
      isError?: boolean;
      error?: string;
    };
    expect(parsed.isError).toBe(true);
    expect(parsed.error).toBe("forbidden");
  });

  test("non-error result does not flag isError", () => {
    const parsed = parseMcpText(rpc(mcpResult(envelope([])))) as {
      isError?: boolean;
    };
    expect(parsed.isError).toBeFalsy();
  });
});

// ---- discoverNodeId ------------------------------------------------------

describe("discoverNodeId", () => {
  test("returns the first results[].id when present", () => {
    const env = envelope([
      { kind: "Entity", id: "node-42", name: "billing" },
      { kind: "Entity", id: "node-43", name: "Bob" },
    ]);
    expect(discoverNodeId(env)).toBe("node-42");
  });

  test("returns null when results is empty", () => {
    expect(discoverNodeId(envelope([]))).toBeNull();
  });

  test("returns null when results is empty with a no_full_text_match warning", () => {
    expect(discoverNodeId(envelope([], ["no_full_text_match"]))).toBeNull();
  });
});

// ---- hasNeighbor ---------------------------------------------------------

describe("hasNeighbor", () => {
  test("true when results has at least one entry", () => {
    const env = envelope([{ kind: "Entity", id: "n2", name: "Bob" }]);
    expect(hasNeighbor(env)).toBe(true);
  });

  test("false when results is empty", () => {
    expect(hasNeighbor(envelope([]))).toBe(false);
  });
});

// ---- pathFound -----------------------------------------------------------

describe("pathFound", () => {
  test("true when a path is returned and no no_path_found warning", () => {
    const env = envelope([{ kind: "Entity", id: "a" }, { kind: "Entity", id: "b" }]);
    expect(pathFound(env)).toBe(true);
  });

  test("false when meta.warnings includes no_path_found", () => {
    const env = envelope([], ["no_path_found"]);
    expect(pathFound(env)).toBe(false);
  });

  test("false when results is empty even without the warning", () => {
    expect(pathFound(envelope([]))).toBe(false);
  });
});

// ---- decisionPresent -----------------------------------------------------

describe("decisionPresent", () => {
  test("case-insensitive substring match of needle in a Decision summary", () => {
    const env = envelope([
      {
        kind: "Decision",
        id: "d1",
        summary: "We chose PostgreSQL for the billing service.",
      },
    ]);
    expect(decisionPresent(env, "postgresql")).toBe(true);
    expect(decisionPresent(env, "BILLING")).toBe(true);
  });

  test("false when no Decision summary contains the needle", () => {
    const env = envelope([
      { kind: "Decision", id: "d1", summary: "We chose Redis for caching." },
    ]);
    expect(decisionPresent(env, "postgresql")).toBe(false);
  });

  test("false when there are no Decision results at all", () => {
    const env = envelope([{ kind: "Entity", id: "e1", name: "postgresql" }]);
    expect(decisionPresent(env, "postgresql")).toBe(false);
  });
});

// ---- isGroundedAnswer ----------------------------------------------------

describe("isGroundedAnswer", () => {
  test("true when mode_used is planned, answer is <memory>-wrapped, and needle present", () => {
    const ask = {
      answer: '<memory kind="Answer">\nBob owns the billing module.\n</memory>',
      results: [],
      meta: { mode_used: "planned", coverage: {}, warnings: [] },
    };
    expect(isGroundedAnswer(ask, "Bob")).toBe(true);
    expect(isGroundedAnswer(ask, "billing")).toBe(true);
  });

  test("false when the needle is absent from the answer", () => {
    const ask = {
      answer: '<memory kind="Answer">\nBob owns the billing module.\n</memory>',
      results: [],
      meta: { mode_used: "planned", coverage: {}, warnings: [] },
    };
    expect(isGroundedAnswer(ask, "kubernetes")).toBe(false);
  });

  test("false when mode_used is not planned", () => {
    const ask = {
      answer: '<memory kind="Answer">\nBob owns billing.\n</memory>',
      results: [],
      meta: { mode_used: "templates", coverage: {}, warnings: [] },
    };
    expect(isGroundedAnswer(ask, "Bob")).toBe(false);
  });

  test("false when the answer is not <memory>-wrapped", () => {
    const ask = {
      answer: "Bob owns the billing module.",
      results: [],
      meta: { mode_used: "planned", coverage: {}, warnings: [] },
    };
    expect(isGroundedAnswer(ask, "Bob")).toBe(false);
  });
});

// ---- contentSurfaced -----------------------------------------------------

describe("contentSurfaced", () => {
  test("case-insensitive needle found in an Entity name", () => {
    const env = envelope([{ kind: "Entity", id: "e1", name: "PostgreSQL" }]);
    expect(contentSurfaced(env, "postgres")).toBe(true);
  });

  test("needle found in a Decision summary", () => {
    const env = envelope([
      { kind: "Decision", id: "d1", summary: "Adopt the gamma-protocol handshake." },
    ]);
    expect(contentSurfaced(env, "GAMMA-PROTOCOL")).toBe(true);
  });

  test("needle found anywhere in the serialized item", () => {
    const env = envelope([
      { kind: "File", id: "f1", path: "src/billing/charge.ts" },
    ]);
    expect(contentSurfaced(env, "charge.ts")).toBe(true);
  });

  test("false when needle appears nowhere in the results", () => {
    const env = envelope([{ kind: "Entity", id: "e1", name: "PostgreSQL" }]);
    expect(contentSurfaced(env, "mongodb")).toBe(false);
  });

  test("false on an empty result set", () => {
    expect(contentSurfaced(envelope([]), "anything")).toBe(false);
  });
});

// ---- userListed / projectListed -----------------------------------------

describe("userListed", () => {
  test("true when username is in users[]", () => {
    const env = {
      users: [
        { id: 1, username: "admin", role: "admin", created_at: "x" },
        { id: 2, username: "smoke-123", role: "member", created_at: "x" },
      ],
    };
    expect(userListed(env, "smoke-123")).toBe(true);
  });

  test("false when username is absent", () => {
    const env = { users: [{ id: 1, username: "admin", role: "admin", created_at: "x" }] };
    expect(userListed(env, "smoke-999")).toBe(false);
  });
});

describe("projectListed", () => {
  test("true when slug is in projects[]", () => {
    const env = {
      projects: [
        { id: 1, slug: "smoke-123", display_name: "smoke-123", created_at: "x" },
      ],
    };
    expect(projectListed(env, "smoke-123")).toBe(true);
  });

  test("false when slug is absent", () => {
    const env = { projects: [{ id: 1, slug: "other", display_name: "o", created_at: "x" }] };
    expect(projectListed(env, "smoke-123")).toBe(false);
  });
});

// ---- countsReflect -------------------------------------------------------

describe("countsReflect", () => {
  test("true when counts meet the minimums", () => {
    const env = {
      counts: { users: 5, projects: 3, tokens_active: 2, server_version: "v1" },
    };
    expect(countsReflect(env, { minUsers: 2, minProjects: 1 })).toBe(true);
  });

  test("false when users below the minimum", () => {
    const env = { counts: { users: 1, projects: 3, tokens_active: 2 } };
    expect(countsReflect(env, { minUsers: 2, minProjects: 1 })).toBe(false);
  });

  test("false when projects below the minimum", () => {
    const env = { counts: { users: 5, projects: 0, tokens_active: 2 } };
    expect(countsReflect(env, { minUsers: 2, minProjects: 1 })).toBe(false);
  });
});

// ---- tokenRejected -------------------------------------------------------

describe("tokenRejected", () => {
  test("true on an isError MCP envelope", () => {
    const parsed = { isError: true, error: "forbidden" };
    expect(tokenRejected(parsed)).toBe(true);
  });

  test("true on a forbidden error body", () => {
    expect(tokenRejected({ error: "forbidden" })).toBe(true);
  });

  test("true on an HTTP 401 unauthorized shape", () => {
    expect(tokenRejected({ status: 401, error: "unauthorized" })).toBe(true);
  });

  test("true on an HTTP 403 shape", () => {
    expect(tokenRejected({ status: 403 })).toBe(true);
  });

  test("false on a successful (non-error) response", () => {
    expect(tokenRejected({ users: [] })).toBe(false);
  });
});

// ---- projectGone ---------------------------------------------------------

describe("projectGone", () => {
  test("true when the slug is NOT present in projects[]", () => {
    const env = {
      projects: [{ id: 1, slug: "still-here", display_name: "x", created_at: "x" }],
    };
    expect(projectGone(env, "smoke-deleted")).toBe(true);
  });

  test("false when the slug is still present", () => {
    const env = {
      projects: [{ id: 1, slug: "smoke-deleted", display_name: "x", created_at: "x" }],
    };
    expect(projectGone(env, "smoke-deleted")).toBe(false);
  });
});

// ---- buildHookEnvelope ---------------------------------------------------

describe("buildHookEnvelope", () => {
  test("post_tool_use places known text in payload.tool_output and sets tool_name", () => {
    const env = buildHookEnvelope("post_tool_use", "ZEBRA-DECISION-9000") as {
      kind: string;
      payload: { tool_output?: unknown; tool_name?: unknown };
      ts?: string;
    };
    expect(env.kind).toBe("post_tool_use");
    expect(String(env.payload.tool_output)).toContain("ZEBRA-DECISION-9000");
    expect(typeof env.payload.tool_name).toBe("string");
    expect((env.payload.tool_name as string).length).toBeGreaterThan(0);
  });

  test("stop places known text in payload.transcript", () => {
    const env = buildHookEnvelope("stop", "FALCON-SUMMARY-77") as {
      kind: string;
      payload: { transcript?: unknown };
    };
    expect(env.kind).toBe("stop");
    expect(String(env.payload.transcript)).toContain("FALCON-SUMMARY-77");
  });

  test("session_start places known text in a payload text-bearing field", () => {
    const env = buildHookEnvelope("session_start", "OTTER-CONTEXT-11") as {
      kind: string;
      payload: Record<string, unknown>;
    };
    expect(env.kind).toBe("session_start");
    const serialized = JSON.stringify(env.payload);
    expect(serialized).toContain("OTTER-CONTEXT-11");
  });

  test("envelope payload is a plain Record (matches /ingest HookEnvelope shape)", () => {
    const env = buildHookEnvelope("stop", "x") as { payload: unknown };
    expect(typeof env.payload).toBe("object");
    expect(Array.isArray(env.payload)).toBe(false);
    expect(env.payload).not.toBeNull();
  });
});

// ---- isMetaToolEnvelope (denoise predicate) ------------------------------

describe("isMetaToolEnvelope", () => {
  test("true for a post_tool_use envelope with a META_TOOL tool_name (ToolSearch)", () => {
    const env = {
      kind: "post_tool_use",
      payload: { tool_name: "ToolSearch", tool_output: "searched for tools" },
    };
    expect(isMetaToolEnvelope(env)).toBe(true);
  });

  test("false for a post_tool_use envelope with a non-meta tool_name", () => {
    const env = {
      kind: "post_tool_use",
      payload: { tool_name: "Edit", tool_output: "edited a file" },
    };
    expect(isMetaToolEnvelope(env)).toBe(false);
  });

  test("false for a non-post_tool_use kind even with a meta tool_name", () => {
    const env = {
      kind: "stop",
      payload: { tool_name: "ToolSearch", transcript: "done" },
    };
    expect(isMetaToolEnvelope(env)).toBe(false);
  });

  test("false when tool_name is missing", () => {
    const env = { kind: "post_tool_use", payload: { tool_output: "x" } };
    expect(isMetaToolEnvelope(env)).toBe(false);
  });
});

// ---- summarize (run aggregator → exit code) ------------------------------

describe("summarize", () => {
  test("exit code 0 when every assertion passed", () => {
    const out = summarize([
      { name: "search round-trip", ok: true },
      { name: "neighbors", ok: true },
    ]);
    expect(out.exitCode).toBe(0);
    expect(out.passed).toBe(2);
    expect(out.failed).toBe(0);
  });

  test("non-zero exit code (1) when any assertion failed", () => {
    const out = summarize([
      { name: "search round-trip", ok: true },
      { name: "path_between", ok: false },
      { name: "neighbors", ok: true },
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.passed).toBe(2);
    expect(out.failed).toBe(1);
  });

  test("empty result set exits 0 with zero tallies", () => {
    const out = summarize([]);
    expect(out.exitCode).toBe(0);
    expect(out.passed).toBe(0);
    expect(out.failed).toBe(0);
  });
});
