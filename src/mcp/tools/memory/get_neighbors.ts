import { z } from "zod";
import type { GraphAdapter } from "../../../graph/adapter";
import { nodeToMemoryItem, type MemoryItem, type NodeKind } from "../../memory/dto";
import { assertGraph, buildEnvelope, checkMode, modeSchema, subProjectsSchema, type AuthContext, type MemoryEnvelope } from "./_shared";

export const getNeighborsSchema = z.object({
  node_id: z.string().min(1),
  depth: z.number().int().positive().max(3).optional().default(1),
  edge_types: z.array(z.string()).optional().default([]),
  limit: z.number().int().positive().max(200).optional().default(50),
  sub_projects: subProjectsSchema,
  mode: modeSchema,
});

export type GetNeighborsArgs = z.infer<typeof getNeighborsSchema>;

const KNOWN_LABELS = new Set<NodeKind>(["Entity", "Decision", "File", "Symbol", "Feedback"]);

export async function getNeighbors(
  args: GetNeighborsArgs,
  ctx: AuthContext,
  graph: GraphAdapter | undefined,
): Promise<MemoryEnvelope<MemoryItem>> {
  assertGraph(graph);
  checkMode(args.mode);

  const res = await graph.run<
    { node_id: string; depth: number; edge_types: string[]; limit: number; sub_projects: string[] },
    { label: NodeKind; props: Record<string, unknown>; hops: number }
  >(
    "memory.neighbors",
    {
      node_id: args.node_id,
      depth: args.depth,
      edge_types: args.edge_types,
      limit: args.limit,
      sub_projects: args.sub_projects ?? [],
    },
    ctx,
  );

  const filtered = res.rows.filter((r) => KNOWN_LABELS.has(r.label));
  const results: MemoryItem[] = filtered.map((r) => nodeToMemoryItem(r.label, r.props));
  const truncated = filtered.length >= args.limit;
  const warnings: string[] = [];
  if (args.depth === 3 && truncated) warnings.push("depth_3_blowup_likely");

  return buildEnvelope<MemoryItem>(
    results,
    { matched_entities: filtered.length, traversals: filtered.length, truncated },
    warnings,
  );
}
