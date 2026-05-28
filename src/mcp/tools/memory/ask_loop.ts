// Planned-mode "ask" loop (FR-WB3N9H). On a configured server the model is
// handed the question plus a tool interface over the four read primitives. Each
// iteration it may issue one or more primitive calls; the loop executes them
// via GraphAdapter.run(..., ctx), feeds the (redacted) observations back, and
// repeats until the model emits a final answer or the budget caps force a
// single synthesis turn.

import type { GraphAdapter } from "../../../graph/adapter";
import type { Redactor } from "../../../extract/redact";
import type { MemoryItem } from "../../memory/dto";
import type { AuthContext, MemoryEnvelope } from "./_shared";
import { searchMemory } from "./search_memory";
import { getNeighbors } from "./get_neighbors";
import { pathBetween } from "./path_between";
import { recentDecisions } from "./recent_decisions";

export type AskTurn =
  | { type: "tool_calls"; calls: { tool: string; args: unknown }[] }
  | { type: "answer"; text: string };

export interface AskClient {
  next(input: unknown): Promise<AskTurn>;
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

// Dispatch table from the model-facing tool name to the read primitive. Each
// primitive takes (args, ctx, graph) and returns a MemoryEnvelope<MemoryItem>.
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
  // Cumulative observations across every iteration — the model needs to see what
  // earlier hops retrieved when it plans the next hop and when it synthesizes the
  // final answer, not just the latest hop's results.
  const allObservations: unknown[] = [];

  let iteration = 0;
  let toolCallsUsed = 0;
  let input: unknown = { question };

  let answer = "";
  let budgetExhausted = false;

  while (true) {
    const turn = await client.next(input);

    if (turn.type === "answer") {
      answer = turn.text;
      break;
    }

    iteration += 1;
    const observations: unknown[] = [];

    for (const call of turn.calls) {
      // Stop dispatching once the cumulative tool-call cap is reached; the
      // remaining scripted calls in this turn are dropped and the loop forces a
      // single synthesis turn below.
      if (toolCallsUsed >= maxToolCalls) {
        budgetExhausted = true;
        break;
      }

      const primitive = PRIMITIVES[call.tool];
      if (!primitive) {
        warnings.push(`unknown_tool:${call.tool}`);
        continue;
      }

      toolCallsUsed += 1;
      toolCallExplain.push({ tool: call.tool, iteration });

      // Enforce the caller's sub_projects scope on every internal primitive
      // call: when ask_memory was given sub_projects, it overrides whatever the
      // model put in the call args — the model cannot widen recall past it.
      const baseArgs =
        call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
      const callArgs =
        sub_projects && sub_projects.length > 0 ? { ...baseArgs, sub_projects } : call.args;

      const env = await primitive(callArgs as never, ctx, graph);

      coverage.matched_entities += env.meta.coverage.matched_entities;
      coverage.traversals += env.meta.coverage.traversals;
      if (env.meta.coverage.truncated) coverage.truncated = true;
      for (const w of env.meta.warnings) warnings.push(w);

      for (const item of env.results) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        results.push(item);
      }

      observations.push({ tool: call.tool, results: env.results, meta: env.meta });
    }

    allObservations.push(...observations);
    const redacted = redactor ? redactor.redact(allObservations).value : allObservations;
    input = { question, observations: redacted };

    // Either cap forces the loop to stop issuing tool calls. Ask the model once
    // more to synthesize from what was already retrieved, and record the warning.
    if (budgetExhausted || iteration >= maxIterations || toolCallsUsed >= maxToolCalls) {
      warnings.push("budget_exhausted");
      const synth = await client.next(input);
      // The forced-synthesis turn is the model's last chance to answer. If it
      // still asks for tool calls instead of answering, fall back to an explicit
      // message rather than returning an empty <memory>-wrapped string.
      answer =
        synth.type === "answer"
          ? synth.text
          : "Unable to synthesize an answer within the retrieval budget.";
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
