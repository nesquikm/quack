import { z } from "zod";
import type { GraphAdapter } from "../../../graph/adapter";
import type { NodeKind } from "../../memory/dto";
import { assertGraph, buildEnvelope, checkMode, modeSchema, type AuthContext, type MemoryEnvelope } from "./_shared";

export const pathBetweenSchema = z.object({
  node_a: z.string().min(1),
  node_b: z.string().min(1),
  max_hops: z.number().int().positive().max(8).optional().default(5),
  limit: z.number().int().positive().max(100).optional().default(25),
  mode: modeSchema,
});

export type PathBetweenArgs = z.infer<typeof pathBetweenSchema>;

export interface PathResult {
  hops: number;
  nodes_seq: Array<{ label: NodeKind | string; props: Record<string, unknown> }>;
  rels_seq: Array<{ type: string; props: Record<string, unknown> }>;
}

export async function pathBetween(
  args: PathBetweenArgs,
  ctx: AuthContext,
  graph: GraphAdapter | undefined,
): Promise<MemoryEnvelope<PathResult>> {
  assertGraph(graph);
  checkMode(args.mode);

  const res = await graph.run<
    { node_a: string; node_b: string; max_hops: number; limit: number },
    PathResult
  >(
    "memory.path",
    { node_a: args.node_a, node_b: args.node_b, max_hops: args.max_hops, limit: args.limit },
    ctx,
  );

  const results = res.rows.map((r) => ({
    hops: typeof r.hops === "number" ? r.hops : Number(r.hops),
    nodes_seq: r.nodes_seq,
    rels_seq: r.rels_seq,
  }));
  const truncated = results.length >= args.limit;
  const traversals = results.reduce((sum, p) => sum + p.hops, 0);
  const warnings: string[] = [];
  if (results.length === 0) warnings.push("no_path_found");

  return buildEnvelope<PathResult>(
    results,
    { matched_entities: results.length === 0 ? 0 : 2, traversals, truncated },
    warnings,
  );
}
