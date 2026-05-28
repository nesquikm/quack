import { describe, test, expect } from "bun:test";
import {
  runAskLoop,
  ASK_TOOL_SPECS,
  type AskClient,
  type AskCompletion,
  type AskMessage,
  type AskToolSpec,
} from "./ask_loop";
import { createRedactor } from "../../../extract/redact";
import type { GraphAdapter } from "../../../graph/adapter";
import type { AuthContext } from "../../../auth/middleware";

const ctx: AuthContext = { user_id: 1, project_id: 10, role: "member" };

// Native-tool-calling fake. Each call to complete() returns the next scripted
// completion; captures the full messages array it was handed so tests can assert
// what the loop fed back to the model (e.g. redacted tool results).
function scriptedClient(turns: AskCompletion[]): AskClient & { calls: AskMessage[][] } {
  const queue = [...turns];
  const calls: AskMessage[][] = [];
  return {
    calls,
    async complete(messages: AskMessage[], _tools: AskToolSpec[]): Promise<AskCompletion> {
      calls.push(messages.map((m) => ({ ...m })));
      const t = queue.shift();
      if (!t) throw new Error("scripted client exhausted — loop asked for more turns than scripted");
      return t;
    },
  };
}

function toolCalls(...calls: { id: string; name: string; args: unknown }[]): AskCompletion {
  return { content: null, toolCalls: calls };
}
function answer(text: string): AskCompletion {
  return { content: text, toolCalls: [] };
}

// Mock GraphAdapter returning canned rows keyed by template id; records calls.
function mockAdapter(rowsByTemplate: Record<string, unknown[]>): GraphAdapter & { calls: string[] } {
  const calls: string[] = [];
  const adapter = {
    calls,
    async run(templateId: string) {
      calls.push(templateId);
      return { rows: rowsByTemplate[templateId] ?? [] };
    },
  };
  return adapter as unknown as GraphAdapter & { calls: string[] };
}

describe("ASK_TOOL_SPECS", () => {
  test("AC-WB3N9H.8: exposes exactly the four read primitives with arg schemas, no write/cypher tool", () => {
    const names = ASK_TOOL_SPECS.map((t) => t.name).sort();
    expect(names).toEqual(["get_neighbors", "path_between", "recent_decisions", "search_memory"]);
    // search_memory advertises its real required arg so the model forms valid calls.
    const search = ASK_TOOL_SPECS.find((t) => t.name === "search_memory")!;
    expect((search.parameters as any).required).toContain("entities");
    // No write / token / cypher tool is ever offered.
    const blob = JSON.stringify(ASK_TOOL_SPECS).toLowerCase();
    expect(blob).not.toContain("cypher");
    expect(blob).not.toContain("add_memory");
    expect(blob).not.toContain("revoke");
  });
});

describe("runAskLoop", () => {
  // AC-WB3N9H.3 — single-pass: one tool call then a final answer.
  test("AC-WB3N9H.3: single-pass — one search call then a final answer", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["auth"] } }),
      answer("auth is a library"),
    ]);

    const out = await runAskLoop({ question: "what is auth?" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });

    expect(out.answer).toBe("auth is a library");
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.id).toBe("e1");
    expect(out.meta.mode_used).toBe("planned");
    expect(adapter.calls).toContain("memory.search");
  });

  // AC-WB3N9H.5 — explain.tool_calls is the ordered {tool, iteration} sequence.
  test("AC-WB3N9H.5: meta.explain.tool_calls is the ordered {tool,iteration} sequence", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
      "memory.neighbors": [{ label: "Decision", props: { id: "d1", project_id: 10, summary: "use jwt" }, hops: 1 }],
    });
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["auth"] } }),
      toolCalls({ id: "c2", name: "get_neighbors", args: { node_id: "e1" } }),
      answer("auth uses jwt"),
    ]);

    const out = await runAskLoop({ question: "how does auth work?" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });

    expect(out.meta.explain.tool_calls).toEqual([
      { tool: "search_memory", iteration: 1 },
      { tool: "get_neighbors", iteration: 2 },
    ]);
    expect(out.meta.coverage.matched_entities).toBeGreaterThanOrEqual(1);
    expect(out.results.map((r) => r.id).sort()).toEqual(["d1", "e1"]);
  });

  // AC-WB3N9H.5 — multi-hop dedupes a node retrieved twice.
  test("AC-WB3N9H.5: multi-hop dedupes a node retrieved twice", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
      "memory.neighbors": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, hops: 1 }],
    });
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["auth"] } }),
      toolCalls({ id: "c2", name: "get_neighbors", args: { node_id: "e1" } }),
      answer("auth"),
    ]);

    const out = await runAskLoop({ question: "auth?" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });
    expect(out.results.filter((r) => r.id === "e1").length).toBe(1);
  });

  // AC-WB3N9H.4 / AC-WB3N9H.10 — max-iterations cap forces a final synthesis turn.
  test("AC-WB3N9H.4: max-iterations cap → forced synthesis + budget_exhausted", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["auth"] } }),
      toolCalls({ id: "c2", name: "search_memory", args: { entities: ["auth"] } }),
      answer("best effort answer"), // forced-synthesis turn (no tools)
    ]);

    const out = await runAskLoop({ question: "auth?" }, ctx, { client, graph: adapter, maxIterations: 2, maxToolCalls: 8 });

    expect(out.meta.warnings).toContain("budget_exhausted");
    expect(out.answer).toBe("best effort answer");
  });

  test("AC-WB3N9H.4: max-tool-calls cap → budget_exhausted", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    const client = scriptedClient([
      toolCalls(
        { id: "c1", name: "search_memory", args: { entities: ["a"] } },
        { id: "c2", name: "search_memory", args: { entities: ["b"] } },
        { id: "c3", name: "search_memory", args: { entities: ["c"] } },
      ),
      answer("forced"),
    ]);

    const out = await runAskLoop({ question: "q?" }, ctx, { client, graph: adapter, maxIterations: 5, maxToolCalls: 2 });
    expect(out.meta.warnings).toContain("budget_exhausted");
  });

  // AC-WB3N9H.6 — empty retrieval propagates no_full_text_match, results [].
  test("AC-WB3N9H.6: empty retrieval → results [], no_full_text_match warning", async () => {
    const adapter = mockAdapter({ "memory.search": [] });
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["nope"] } }),
      answer("No relevant memory was found."),
    ]);

    const out = await runAskLoop({ question: "anything?" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });
    expect(out.results).toEqual([]);
    expect(out.meta.warnings).toContain("no_full_text_match");
  });

  // AC-WB3N9H.10 — unknown tool is skipped + warned, never executed.
  test("AC-WB3N9H.10: unknown tool is skipped + recorded as a warning, never executed", async () => {
    const adapter = mockAdapter({});
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "exec_cypher", args: { q: "MATCH (n) RETURN n" } }),
      answer("done"),
    ]);

    const out = await runAskLoop({ question: "q?" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });
    expect(adapter.calls.length).toBe(0);
    expect(out.meta.warnings.some((w) => w.includes("unknown_tool"))).toBe(true);
    expect(out.answer).toBe("done");
  });

  // AC-WB3N9H.10 — malformed tool args are validated, skipped + warned, never
  // passed raw to the primitive (the live-smoke regression: search w/o entities).
  test("AC-WB3N9H.10: invalid tool args are skipped + warned, never crash the primitive", async () => {
    const adapter = mockAdapter({});
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { not_entities: "oops" } }),
      answer("done"),
    ]);

    const out = await runAskLoop({ question: "q?" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });
    expect(adapter.calls.length).toBe(0);
    expect(out.meta.warnings.some((w) => w.includes("invalid_tool_args"))).toBe(true);
    expect(out.answer).toBe("done");
  });

  // AC-WB3N9H.7 — retrieved content is redacted before re-prompting the model.
  test("AC-WB3N9H.7: tool results are redacted before they re-enter the prompt", async () => {
    const adapter = mockAdapter({
      "memory.search": [
        { label: "Decision", props: { id: "d1", project_id: 10, summary: "deploy key sk-ABCDEFGHIJKLMNOPQRSTUVWX" }, score: 1, neighbor: false },
      ],
    });
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["deploy"] } }),
      answer("ok"),
    ]);

    await runAskLoop({ question: "deploy key?" }, ctx, { client, graph: adapter, redactor: createRedactor(), maxIterations: 3, maxToolCalls: 8 });

    // The 2nd complete() call carries the tool-result message fed back to the model.
    const secondTurnMessages = client.calls[client.calls.length - 1]!;
    const toolMsg = secondTurnMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(toolMsg!.content).toContain("«REDACTED»");
  });

  // AC-WB3N9H.5 — coverage.truncated true when an internal call truncated.
  test("AC-WB3N9H.5: coverage.truncated true when an internal call truncated", async () => {
    const rows = Array.from({ length: 20 }).map((_, i) => ({
      label: "Entity",
      props: { id: `e${i}`, project_id: 10, name: `n${i}` },
      score: 1,
      neighbor: false,
    }));
    const adapter = mockAdapter({ "memory.search": rows });
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["x"], limit: 20 } }),
      answer("many"),
    ]);

    const out = await runAskLoop({ question: "x?" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });
    expect(out.meta.coverage.truncated).toBe(true);
  });

  // AC-WB3N9H.3 — the raw assistant message is replayed VERBATIM on the next
  // turn so provider fields (e.g. Gemini's thought_signature) survive; a
  // reconstructed message would drop them and the follow-up request would 400.
  test("AC-WB3N9H.3: provider raw assistant message is replayed unchanged on the next turn", async () => {
    const adapter = mockAdapter({ "memory.search": [] });
    const rawAssistant = {
      role: "assistant" as const,
      content: null,
      tool_calls: [{ id: "c1", type: "function" as const, function: { name: "search_memory", arguments: '{"entities":["x"]}' } }],
      // provider-specific field the loop must NOT drop:
      extra_content: { google: { thought_signature: "SIG-123" } },
    };
    const client = scriptedClient([
      { content: null, toolCalls: [{ id: "c1", name: "search_memory", args: { entities: ["x"] } }], raw: rawAssistant as unknown as AskMessage },
      answer("ok"),
    ]);

    await runAskLoop({ question: "q" }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });

    // The 2nd turn's messages must contain the raw assistant message verbatim.
    const secondTurn = client.calls[client.calls.length - 1]!;
    const replayed = secondTurn.find((m) => m.role === "assistant");
    expect(JSON.stringify(replayed)).toContain("thought_signature");
    expect(JSON.stringify(replayed)).toContain("SIG-123");
  });

  // AC-WB3N9H.1 — the caller's sub_projects scope is forced onto every call.
  test("AC-WB3N9H.1: caller sub_projects is threaded into every primitive call", async () => {
    const captured: unknown[] = [];
    const adapter = {
      async run(_templateId: string, params: unknown) {
        captured.push(params);
        return { rows: [] };
      },
    } as unknown as GraphAdapter;
    const client = scriptedClient([
      toolCalls({ id: "c1", name: "search_memory", args: { entities: ["auth"] } }),
      answer("ok"),
    ]);

    await runAskLoop({ question: "q", sub_projects: ["backend"] }, ctx, { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 });
    expect(captured.some((p) => JSON.stringify(p).includes("backend"))).toBe(true);
  });
});
