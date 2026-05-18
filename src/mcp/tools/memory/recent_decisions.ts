import { z } from "zod";
import type { GraphAdapter } from "../../../graph/adapter";
import { nodeToMemoryItem, type MemoryItem, type NodeKind } from "../../memory/dto";
import { parseTimeWindow, TimeWindowError } from "../../memory/time_window";
import { MemoryToolError } from "../../errors";
import { assertGraph, buildEnvelope, checkMode, modeSchema, subProjectsSchema, type AuthContext, type MemoryEnvelope } from "./_shared";

export const recentDecisionsSchema = z.object({
  time_window: z.union([z.string(), z.object({ from: z.string(), to: z.string().optional() })]),
  limit: z.number().int().positive().max(100).optional().default(20),
  sub_projects: subProjectsSchema,
  mode: modeSchema,
});

export type RecentDecisionsArgs = z.infer<typeof recentDecisionsSchema>;

export async function recentDecisions(
  args: RecentDecisionsArgs,
  ctx: AuthContext,
  graph: GraphAdapter | undefined,
): Promise<MemoryEnvelope<MemoryItem>> {
  assertGraph(graph);
  checkMode(args.mode);

  let window: { from: string; to: string };
  try {
    window = parseTimeWindow(args.time_window);
  } catch (err) {
    if (err instanceof TimeWindowError) {
      throw new MemoryToolError("invalid_args", err.message, { field: "time_window" });
    }
    throw err;
  }

  const res = await graph.run<
    { from: string; to: string; limit: number; sub_projects: string[] },
    { label: NodeKind; props: Record<string, unknown> }
  >(
    "memory.recent_decisions",
    { from: window.from, to: window.to, limit: args.limit, sub_projects: args.sub_projects ?? [] },
    ctx,
  );

  const results: MemoryItem[] = res.rows.map((r) => nodeToMemoryItem(r.label, r.props));
  const truncated = results.length >= args.limit;

  return buildEnvelope<MemoryItem>(
    results,
    { matched_entities: results.length, traversals: 0, truncated },
    [],
  );
}
