import { z } from "zod";
import type { GraphAdapter } from "../../../graph/adapter";
import { nodeToMemoryItem, type MemoryItem, type NodeKind } from "../../memory/dto";
import { parseTimeWindow, TimeWindowError } from "../../memory/time_window";
import { MemoryToolError } from "../../errors";
import { assertGraph, buildEnvelope, checkMode, modeSchema, subProjectsSchema, type AuthContext, type MemoryEnvelope } from "./_shared";

export const searchMemorySchema = z.object({
  entities: z.array(z.string().min(1)).min(1),
  types: z.array(z.string()).optional(),
  time_range: z.union([z.string(), z.object({ from: z.string(), to: z.string().optional() })]).optional(),
  limit: z.number().int().positive().max(100).optional().default(20),
  sub_projects: subProjectsSchema,
  mode: modeSchema,
});

export type SearchMemoryArgs = z.infer<typeof searchMemorySchema>;

const KNOWN_LABELS = new Set<NodeKind>(["Entity", "Decision", "File", "Symbol", "Feedback"]);

// Builds the Lucene-style query string for the full-text index: a disjunction
// of escaped entity names. Returns null when the input would produce an empty
// query (the tool short-circuits to `no_full_text_match`).
function buildFtsQuery(entities: string[]): string | null {
  const tokens = entities.map((e) => e.trim()).filter((e) => e.length > 0);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/["\\]/g, "")}"`).join(" OR ");
}

export async function searchMemory(
  args: SearchMemoryArgs,
  ctx: AuthContext,
  graph: GraphAdapter | undefined,
): Promise<MemoryEnvelope<MemoryItem>> {
  assertGraph(graph);
  checkMode(args.mode);

  if (args.time_range !== undefined) {
    try {
      parseTimeWindow(args.time_range);
    } catch (err) {
      if (err instanceof TimeWindowError) {
        throw new MemoryToolError("invalid_args", err.message, { field: "time_range" });
      }
      throw err;
    }
  }

  const query = buildFtsQuery(args.entities);
  if (!query) {
    return buildEnvelope<MemoryItem>([], { matched_entities: 0, traversals: 0, truncated: false }, ["no_full_text_match"]);
  }

  const subProjects = args.sub_projects ?? [];

  const fts = await graph.run<
    { query: string; limit: number; sub_projects: string[] },
    { label: NodeKind; props: Record<string, unknown>; score: number; neighbor: boolean }
  >("memory.search", { query, limit: args.limit, sub_projects: subProjects }, ctx);

  if (fts.rows.length === 0) {
    return buildEnvelope<MemoryItem>(
      [],
      { matched_entities: 0, traversals: 0, truncated: false },
      ["no_full_text_match"],
    );
  }

  const anchors = fts.rows.filter((r) => KNOWN_LABELS.has(r.label));
  let neighbors: typeof anchors = [];
  let traversals = 0;
  if (args.types && args.types.length > 0) {
    const anchor_ids = anchors
      .map((r) => r.props["id"])
      .filter((v): v is string => typeof v === "string");
    if (anchor_ids.length > 0) {
      const expand = await graph.run<
        { anchor_ids: string[]; types: string[]; limit: number; sub_projects: string[] },
        { label: NodeKind; props: Record<string, unknown>; score: number; neighbor: boolean }
      >(
        "memory.search.expand",
        { anchor_ids, types: args.types, limit: args.limit, sub_projects: subProjects },
        ctx,
      );
      neighbors = expand.rows.filter((r) => KNOWN_LABELS.has(r.label));
      traversals = neighbors.length;
    }
  }

  const all = [...anchors, ...neighbors];
  const results: MemoryItem[] = all.slice(0, args.limit).map((r) => nodeToMemoryItem(r.label, r.props));
  const truncated = all.length >= args.limit;

  return buildEnvelope<MemoryItem>(
    results,
    { matched_entities: anchors.length, traversals, truncated },
    [],
  );
}
