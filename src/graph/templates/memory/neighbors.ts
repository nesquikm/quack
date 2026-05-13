import { z } from "zod";
import type { CypherTemplate } from "../../types";

// get_neighbors template — bounded variable-length walk from a known node.
// Depth caps at 3 (Zod refusal); the literal `*..3` keeps the planner happy.
// Server-side WHERE filter trims to the requested depth.
//
// edge_types filter is applied client-side on relationship type when the
// list is non-empty.

export const neighborsTemplate: CypherTemplate = {
  id: "memory.neighbors",
  cypher: `
MATCH (start {project_id: $project_id, id: $node_id})
MATCH p = (start)-[*1..3]-(n {project_id: $project_id})
WHERE length(p) <= $depth
  AND (size($edge_types) = 0 OR all(r IN relationships(p) WHERE type(r) IN $edge_types))
RETURN DISTINCT
  labels(n)[0]      AS label,
  properties(n)     AS props,
  length(p)         AS hops
ORDER BY hops ASC
LIMIT $limit
`,
  paramSchema: z.object({
    node_id: z.string().min(1),
    depth: z.number().int().positive().max(3).default(1),
    edge_types: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(200).default(50),
    project_id: z.number().optional(),
  }),
  accessMode: "READ",
};
