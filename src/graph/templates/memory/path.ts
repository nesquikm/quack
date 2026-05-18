import { z } from "zod";
import type { CypherTemplate } from "../../types";

// path_between template — shortestPath scoped by project_id on BOTH endpoints
// (cross-tenant guard). Hard literal cap of 8 in the variable-length pattern;
// server-side WHERE filter narrows to the caller-requested max_hops.
//
// We unwind path nodes/relationships into arrays so the row-mapper can
// produce ordered node+relationship lists per path.

export const pathBetweenTemplate: CypherTemplate = {
  id: "memory.path",
  cypher: `
MATCH (a {project_id: $project_id, id: $node_a})
MATCH (b {project_id: $project_id, id: $node_b})
MATCH p = shortestPath((a)-[*..8]-(b))
WHERE length(p) <= $max_hops
  AND all(n IN nodes(p) WHERE $sub_projects = [] OR n.source IS NULL OR ANY(s IN $sub_projects WHERE s IN n.source))
WITH p, length(p) AS hops
LIMIT $limit
RETURN
  hops                                                                AS hops,
  [n IN nodes(p) | { label: labels(n)[0], props: properties(n) }]     AS nodes_seq,
  [r IN relationships(p) | { type: type(r), props: properties(r) }]   AS rels_seq
`,
  paramSchema: z.object({
    node_a: z.string().min(1),
    node_b: z.string().min(1),
    max_hops: z.number().int().positive().max(8).default(5),
    limit: z.number().int().positive().max(100).default(25),
    project_id: z.number().optional(),
    sub_projects: z.array(z.string()).default([]),
  }),
  accessMode: "READ",
};
