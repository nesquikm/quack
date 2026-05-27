// Planned-mode "ask" tool (FR-WB3N9H). The handler validates input, requires a
// configured model client (the same QUACK_MODEL_* condition that gates the
// extractor), runs the planned ask loop over the read primitives, and returns
// a <memory>-wrapped answer plus the per-item-wrapped results and the planned
// meta envelope. When no client is wired the tool fails closed with
// `model_unavailable` before touching the graph.

import { z } from "zod";
import type { GraphAdapter } from "../../../graph/adapter";
import { MemoryToolError } from "../../errors";
import { createRedactor } from "../../../extract/redact";
import { runAskLoop, type AskClient, type AskTurn, type AskLoopResult } from "./ask_loop";
import { subProjectsSchema, type AuthContext } from "./_shared";
import { getAskMaxIterations, getAskMaxToolCalls } from "../../../shared/env";

export type { AskClient, AskTurn };

export const askMemorySchema = z.object({
  question: z.string().min(1),
  sub_projects: subProjectsSchema,
});

export type AskMemoryArgs = z.infer<typeof askMemorySchema>;

export interface AskMemoryDeps {
  client: AskClient | undefined;
}

export async function askMemory(
  args: AskMemoryArgs,
  ctx: AuthContext,
  graph: GraphAdapter | undefined,
  { client }: AskMemoryDeps,
): Promise<{ answer: string; results: AskLoopResult["results"]; meta: AskLoopResult["meta"] }> {
  if (!client) {
    throw new MemoryToolError(
      "model_unavailable",
      "ask_memory requires QUACK_MODEL_API_KEY and QUACK_MODEL_BASE_URL to be configured.",
    );
  }

  const loopOut = await runAskLoop({ question: args.question }, ctx, {
    client,
    graph,
    redactor: createRedactor(),
    maxIterations: getAskMaxIterations(),
    maxToolCalls: getAskMaxToolCalls(),
  });

  return {
    answer: `<memory kind="Answer">\n${loopOut.answer}\n</memory>`,
    results: loopOut.results,
    meta: loopOut.meta,
  };
}
