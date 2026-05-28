// Planned-mode "ask" loop (FR-WB3N9H). On a configured server the model is
// handed the question plus a NATIVE tool interface (OpenAI function/tool calling)
// over the four read primitives. Each turn the model may issue structured
// tool_calls; the loop executes them via GraphAdapter.run(..., ctx), feeds the
// (redacted) results back as `tool` messages, and repeats until the model
// answers in plain content or the budget caps force a final synthesis turn.
//
// Native tool-calling (vs. a hand-rolled JSON-in-content protocol) gives the
// model the exact per-tool argument schema, so it forms valid calls, and the
// transport parses tool_calls structurally instead of us parsing model prose.

import type { z } from "zod";
import type { GraphAdapter } from "../../../graph/adapter";
import type { Redactor } from "../../../extract/redact";
import type { MemoryItem } from "../../memory/dto";
import type { AuthContext, MemoryEnvelope } from "./_shared";
import { ASK_SYSTEM_PROMPT } from "../../memory/ask_prompt";
import { searchMemory, searchMemorySchema } from "./search_memory";
import { getNeighbors, getNeighborsSchema } from "./get_neighbors";
import { pathBetween, pathBetweenSchema } from "./path_between";
import { recentDecisions, recentDecisionsSchema } from "./recent_decisions";

// OpenAI-shaped chat message the loop accumulates and hands to the client.
export interface AskMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

// A tool the model may call, in OpenAI tools[] shape (the `function` wrapper is
// added by the client; here we carry the inner spec).
export interface AskToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// A tool call parsed out of the model's response.
export interface AskToolCall {
  id: string;
  name: string;
  args: unknown;
}

// One model completion: a final answer (content) and/or a set of tool calls.
// `raw` is the verbatim assistant message as the provider returned it — the loop
// replays it into the conversation UNCHANGED so provider-specific fields survive
// the round-trip (e.g. Gemini 3's `extra_content.google.thought_signature`, which
// the API requires echoed back on the follow-up turn). When absent (test fakes),
// the loop reconstructs a minimal assistant message from `toolCalls`.
export interface AskCompletion {
  content: string | null;
  toolCalls: AskToolCall[];
  raw?: AskMessage;
}

// The model client: one completion over the running conversation + tool manifest.
export interface AskClient {
  complete(messages: AskMessage[], tools: AskToolSpec[]): Promise<AskCompletion>;
}

export interface AskLoopMeta {
  mode_used: "planned";
  coverage: { matched_entities: number; traversals: number; truncated: boolean };
  warnings: string[];
  explain: { tool_calls: { tool: string; iteration: number }[] };
}

export interface AskLoopResult {
  answer: string;
  results: MemoryItem[];
  meta: AskLoopMeta;
}

export interface AskLoopDeps {
  client: AskClient;
  graph: GraphAdapter | undefined;
  redactor?: Redactor;
  maxIterations: number;
  maxToolCalls: number;
}

type Primitive = (
  args: never,
  ctx: AuthContext,
  graph: GraphAdapter | undefined,
) => Promise<MemoryEnvelope<MemoryItem>>;

const PRIMITIVES: Record<string, Primitive> = {
  search_memory: searchMemory as unknown as Primitive,
  get_neighbors: getNeighbors as unknown as Primitive,
  path_between: pathBetween as unknown as Primitive,
  recent_decisions: recentDecisions as unknown as Primitive,
};

// Per-primitive arg schemas. The model's tool-call args are UNTRUSTED — the
// in-process dispatch bypasses the MCP wrapper's Zod gate, so we validate here.
// Malformed args are reported back as a tool error, never passed raw to a
// primitive (which would crash on e.g. `entities.map`).
const SCHEMAS: Record<string, z.ZodType> = {
  search_memory: searchMemorySchema,
  get_neighbors: getNeighborsSchema,
  path_between: pathBetweenSchema,
  recent_decisions: recentDecisionsSchema,
};

// The tool manifest handed to the model — the four project_id-scoped read
// primitives, with their exact argument schemas so the model forms valid calls.
// `sub_projects` and `mode` are intentionally NOT exposed: the loop forces the
// caller's sub_projects scope and runs every primitive in templates mode.
export const ASK_TOOL_SPECS: AskToolSpec[] = [
  {
    name: "search_memory",
    description:
      "Full-text search the project's memory graph by entity name; optional type filter for a 1-hop expansion. Returns matching Entity/Decision/File/Symbol/Feedback nodes.",
    parameters: {
      type: "object",
      properties: {
        entities: { type: "array", items: { type: "string" }, description: "Entity names / keywords to search for (at least one)." },
        types: { type: "array", items: { type: "string" }, description: "Optional node-type filter, e.g. [\"Decision\"]." },
        limit: { type: "integer", description: "Max results (default 20)." },
      },
      required: ["entities"],
    },
  },
  {
    name: "get_neighbors",
    description: "Walk the neighbors of a known node id (from a prior search result) up to a depth, optionally filtered by edge type.",
    parameters: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The id of a node returned by search_memory." },
        depth: { type: "integer", description: "Hop depth 1-3 (default 1)." },
        edge_types: { type: "array", items: { type: "string" }, description: "Optional relationship-type filter." },
        limit: { type: "integer" },
      },
      required: ["node_id"],
    },
  },
  {
    name: "path_between",
    description: "Find the shortest path between two known node ids in the project's memory graph.",
    parameters: {
      type: "object",
      properties: {
        node_a: { type: "string", description: "Start node id." },
        node_b: { type: "string", description: "End node id." },
        max_hops: { type: "integer", description: "Max path length 1-8 (default 5)." },
        limit: { type: "integer" },
      },
      required: ["node_a", "node_b"],
    },
  },
  {
    name: "recent_decisions",
    description: "List the most recent Decision nodes within a time window, newest first.",
    parameters: {
      type: "object",
      properties: {
        time_window: { type: "string", description: "Relative window like \"7d\", \"24h\", or \"30d\"." },
        limit: { type: "integer" },
      },
      required: ["time_window"],
    },
  },
];

function assistantMessage(c: AskCompletion): AskMessage {
  return {
    role: "assistant",
    content: c.content,
    tool_calls: c.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    })),
  };
}

export async function runAskLoop(
  { question, sub_projects }: { question: string; sub_projects?: string[] },
  ctx: AuthContext,
  deps: AskLoopDeps,
): Promise<AskLoopResult> {
  const { client, graph, redactor, maxIterations, maxToolCalls } = deps;

  const results: MemoryItem[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  const toolCallExplain: { tool: string; iteration: number }[] = [];
  const coverage = { matched_entities: 0, traversals: 0, truncated: false };

  const messages: AskMessage[] = [
    { role: "system", content: ASK_SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  let iteration = 0;
  let toolCallsUsed = 0;
  let answer = "";
  let budgetExhausted = false;

  // Redact a tool result before it re-enters the model prompt (AC-7).
  const redactResult = (payload: unknown): string => {
    const value = redactor ? redactor.redact(payload).value : payload;
    return JSON.stringify(value);
  };

  while (true) {
    const completion = await client.complete(messages, ASK_TOOL_SPECS);

    // No tool calls ⇒ the model answered in plain content.
    if (completion.toolCalls.length === 0) {
      answer = completion.content ?? "";
      break;
    }

    iteration += 1;
    // The assistant tool_calls message MUST be followed by one `tool` message
    // per call id, or the next completion is malformed — so we always append a
    // result for every tool_call (running, skipping, or erroring it). Replay the
    // provider's RAW assistant message when available so fields like Gemini's
    // thought_signature survive (reconstructing would drop them → 400).
    messages.push(completion.raw ?? assistantMessage(completion));

    for (const tc of completion.toolCalls) {
      if (toolCallsUsed >= maxToolCalls) {
        budgetExhausted = true;
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ skipped: "budget_exhausted" }) });
        continue;
      }

      const primitive = PRIMITIVES[tc.name];
      const schema = SCHEMAS[tc.name];
      if (!primitive || !schema) {
        warnings.push(`unknown_tool:${tc.name}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "unknown_tool" }) });
        continue;
      }

      toolCallsUsed += 1;
      toolCallExplain.push({ tool: tc.name, iteration });

      // Force the caller's sub_projects scope onto every call (the model cannot
      // widen recall past it), then validate the (untrusted) args.
      const baseArgs = tc.args && typeof tc.args === "object" ? (tc.args as Record<string, unknown>) : {};
      const callArgs = sub_projects && sub_projects.length > 0 ? { ...baseArgs, sub_projects } : tc.args;
      const parsed = schema.safeParse(callArgs);
      if (!parsed.success) {
        warnings.push(`invalid_tool_args:${tc.name}`);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: "invalid_tool_args", issues: parsed.error.issues.map((i) => i.path.join(".")) }),
        });
        continue;
      }

      const env = await primitive(parsed.data as never, ctx, graph);
      coverage.matched_entities += env.meta.coverage.matched_entities;
      coverage.traversals += env.meta.coverage.traversals;
      if (env.meta.coverage.truncated) coverage.truncated = true;
      for (const w of env.meta.warnings) warnings.push(w);
      for (const item of env.results) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        results.push(item);
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: redactResult({ results: env.results, meta: env.meta }),
      });
    }

    // Either cap stops the loop. Nudge the model to answer in plain text from
    // what it already retrieved, then complete WITHOUT tools. The explicit nudge
    // is load-bearing for thinking models: a bare no-tools turn after a
    // tool-calling exchange returns finish_reason=tool_calls with empty content
    // (the model still wants to call tools), so we must instruct it to answer.
    if (budgetExhausted || iteration >= maxIterations || toolCallsUsed >= maxToolCalls) {
      warnings.push("budget_exhausted");
      messages.push({
        role: "user",
        content:
          "You now have enough information. Answer the original question in plain text using only the results retrieved above. Do not call any more tools.",
      });
      const synth = await client.complete(messages, []);
      answer = synth.content ?? "Unable to synthesize an answer within the retrieval budget.";
      break;
    }
  }

  return {
    answer,
    results,
    meta: {
      mode_used: "planned",
      coverage,
      warnings,
      explain: { tool_calls: toolCallExplain },
    },
  };
}
