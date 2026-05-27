import { describe, test, expect } from "bun:test";
import { runAskLoop, type AskClient, type AskTurn } from "./ask_loop";
import { createRedactor } from "../../../extract/redact";
import type { GraphAdapter } from "../../../graph/adapter";
import type { AuthContext } from "../../../auth/middleware";

const ctx: AuthContext = { user_id: 1, project_id: 10, role: "member" };

// A scripted fake AskClient. Each call to next() returns the next turn in the
// queue; the loop drives it until it emits an { type: "answer" } turn or the
// caps are hit. Captures every turn input so tests can assert what the loop
// fed back to the model (e.g. redacted content).
function scriptedClient(turns: AskTurn[]): AskClient & { inputs: unknown[] } {
  const queue = [...turns];
  const inputs: unknown[] = [];
  return {
    inputs,
    async next(input: unknown): Promise<AskTurn> {
      inputs.push(input);
      const turn = queue.shift();
      if (!turn) throw new Error("scripted client exhausted — loop asked for more turns than scripted");
      return turn;
    },
  };
}

// Mock GraphAdapter that returns canned rows keyed by template id.
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

describe("runAskLoop", () => {
  // AC-WB3N9H.3 — single-pass: one round of primitive calls, then a final answer.
  test("AC-WB3N9H.3: single-pass — one search call then a final answer", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["auth"] } }] },
      { type: "answer", text: "auth is a library" },
    ]);

    const out = await runAskLoop(
      { question: "what is auth?" },
      ctx,
      { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 },
    );

    expect(out.answer).toBe("auth is a library");
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.id).toBe("e1");
    expect(out.meta.mode_used).toBe("planned");
    expect(adapter.calls).toContain("memory.search");
  });

  // AC-WB3N9H.5 — envelope shape: explain.tool_calls is the ordered
  // [{tool, iteration}] sequence; coverage aggregated across internal calls.
  test("AC-WB3N9H.5: meta.explain.tool_calls is the ordered {tool,iteration} sequence", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
      "memory.neighbors": [{ label: "Decision", props: { id: "d1", project_id: 10, summary: "use jwt" }, hops: 1 }],
    });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["auth"] } }] },
      { type: "tool_calls", calls: [{ tool: "get_neighbors", args: { node_id: "e1" } }] },
      { type: "answer", text: "auth uses jwt" },
    ]);

    const out = await runAskLoop(
      { question: "how does auth work?" },
      ctx,
      { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 },
    );

    expect(out.meta.explain.tool_calls).toEqual([
      { tool: "search_memory", iteration: 1 },
      { tool: "get_neighbors", iteration: 2 },
    ]);
    // coverage aggregated across both internal calls.
    expect(out.meta.coverage.matched_entities).toBeGreaterThanOrEqual(1);
    expect(out.results.map((r) => r.id).sort()).toEqual(["d1", "e1"]);
  });

  // AC-WB3N9H.5 — multi-hop: ≥2 iterations, deduped results.
  test("AC-WB3N9H.5: multi-hop dedupes a node retrieved twice", async () => {
    const dupRow = { label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false };
    const adapter = mockAdapter({
      "memory.search": [dupRow],
      "memory.neighbors": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, hops: 1 }],
    });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["auth"] } }] },
      { type: "tool_calls", calls: [{ tool: "get_neighbors", args: { node_id: "e1" } }] },
      { type: "answer", text: "auth" },
    ]);

    const out = await runAskLoop(
      { question: "auth?" },
      ctx,
      { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 },
    );

    expect(out.results.filter((r) => r.id === "e1").length).toBe(1);
  });

  // AC-WB3N9H.4 / AC-WB3N9H.10 — budget exhausted: model never answers; caps
  // force a single synthesis turn and meta.warnings includes budget_exhausted.
  test("AC-WB3N9H.4: max-iterations cap → forced synthesis + budget_exhausted", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    // Model keeps asking for tool calls and never emits an answer on its own.
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["auth"] } }] },
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["auth"] } }] },
      // Forced-synthesis turn after the cap is hit.
      { type: "answer", text: "best effort answer" },
    ]);

    const out = await runAskLoop(
      { question: "auth?" },
      ctx,
      { client, graph: adapter, maxIterations: 2, maxToolCalls: 8 },
    );

    expect(out.meta.warnings).toContain("budget_exhausted");
    expect(out.answer).toBe("best effort answer");
  });

  test("AC-WB3N9H.4: max-tool-calls cap → budget_exhausted", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    // Each iteration issues 2 tool calls; cap of 2 is hit in the first iteration.
    const client = scriptedClient([
      {
        type: "tool_calls",
        calls: [
          { tool: "search_memory", args: { entities: ["a"] } },
          { tool: "search_memory", args: { entities: ["b"] } },
          { tool: "search_memory", args: { entities: ["c"] } },
        ],
      },
      { type: "answer", text: "forced" },
    ]);

    const out = await runAskLoop(
      { question: "q?" },
      ctx,
      { client, graph: adapter, maxIterations: 5, maxToolCalls: 2 },
    );

    expect(out.meta.warnings).toContain("budget_exhausted");
  });

  // AC-WB3N9H.6 — empty retrieval: no rows ⇒ results [], no_full_text_match
  // warning propagated, and answer states nothing was found.
  test("AC-WB3N9H.6: empty retrieval → results [], no_full_text_match warning", async () => {
    const adapter = mockAdapter({ "memory.search": [] });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["nope"] } }] },
      { type: "answer", text: "No relevant memory was found." },
    ]);

    const out = await runAskLoop(
      { question: "anything?" },
      ctx,
      { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 },
    );

    expect(out.results).toEqual([]);
    expect(out.meta.warnings).toContain("no_full_text_match");
  });

  // AC-WB3N9H.10 — unknown-tool skip: a model-named tool that isn't one of the
  // four primitives is skipped (never executed against the graph) and recorded
  // as a warning.
  test("AC-WB3N9H.10: unknown tool is skipped + recorded as a warning, never executed", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "exec_cypher", args: { q: "MATCH (n) RETURN n" } }] },
      { type: "answer", text: "done" },
    ]);

    const out = await runAskLoop(
      { question: "q?" },
      ctx,
      { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 },
    );

    // No template was ever run for the bogus tool.
    expect(adapter.calls.length).toBe(0);
    expect(out.meta.warnings.some((w) => w.includes("unknown_tool"))).toBe(true);
  });

  // AC-WB3N9H.7 — redaction: retrieved content with a secret is redacted before
  // being fed back to the model on the next turn.
  test("AC-WB3N9H.7: retrieved content is redacted before re-prompting the model", async () => {
    const adapter = mockAdapter({
      "memory.search": [
        {
          label: "Decision",
          props: { id: "d1", project_id: 10, summary: "deploy key sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
          score: 1,
          neighbor: false,
        },
      ],
    });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["deploy"] } }] },
      { type: "answer", text: "ok" },
    ]);

    await runAskLoop(
      { question: "deploy key?" },
      ctx,
      { client, graph: adapter, redactor: createRedactor(), maxIterations: 3, maxToolCalls: 8 },
    );

    // The second turn input (the observation fed back after the tool call) must
    // not contain the raw secret.
    const reprompt = JSON.stringify(client.inputs[client.inputs.length - 1]);
    expect(reprompt).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(reprompt).toContain("«REDACTED»");
  });

  // AC-WB3N9H.3 — the synthesis turn sees cumulative observations from every
  // hop, not just the latest, so the model can ground its answer in all of them.
  test("AC-WB3N9H.3: final-turn input carries observations from every prior hop", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
      "memory.neighbors": [{ label: "Decision", props: { id: "d1", project_id: 10, summary: "use jwt" }, hops: 1 }],
    });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["auth"] } }] },
      { type: "tool_calls", calls: [{ tool: "get_neighbors", args: { node_id: "e1" } }] },
      { type: "answer", text: "auth uses jwt" },
    ]);

    await runAskLoop(
      { question: "how does auth work?" },
      ctx,
      { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 },
    );

    // The last input (fed before the answer turn) must reference both hops' nodes.
    const lastInput = JSON.stringify(client.inputs[client.inputs.length - 1]);
    expect(lastInput).toContain("e1");
    expect(lastInput).toContain("d1");
  });

  // AC-WB3N9H.5 — coverage.truncated true if any internal call truncated.
  test("AC-WB3N9H.5: coverage.truncated true when an internal call truncated", async () => {
    const rows = Array.from({ length: 20 }).map((_, i) => ({
      label: "Entity",
      props: { id: `e${i}`, project_id: 10, name: `n${i}` },
      score: 1,
      neighbor: false,
    }));
    const adapter = mockAdapter({ "memory.search": rows });
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["x"], limit: 20 } }] },
      { type: "answer", text: "many" },
    ]);

    const out = await runAskLoop(
      { question: "x?" },
      ctx,
      { client, graph: adapter, maxIterations: 3, maxToolCalls: 8 },
    );

    expect(out.meta.coverage.truncated).toBe(true);
  });
});
