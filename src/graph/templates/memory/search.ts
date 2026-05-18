import { z } from "zod";
import type { CypherTemplate } from "../../types";

// search_memory template:
// (a) full-text match against the entity_name_fts index (built in FR-SFQDXR
//     migrations) over each name in `entities[]`,
// (b) optional 1-hop expansion to neighbors whose label is in `types[]`.
//
// Output rows carry: label (Neo4j primary node label), props (node property
// map), score (FTS rank — used for ranking + meta.coverage), and an optional
// `neighbor` flag (true for 1-hop expansion results).

export const searchMemoryTemplate: CypherTemplate = {
  id: "memory.search",
  cypher: `
CALL db.index.fulltext.queryNodes('entity_name_fts', $query) YIELD node, score
WITH node, score
WHERE node.project_id = $project_id
  AND ($sub_projects = [] OR node.source IS NULL OR ANY(s IN $sub_projects WHERE s IN node.source))
WITH node, score
ORDER BY score DESC, node.created_at DESC
LIMIT $limit
RETURN
  labels(node)[0]    AS label,
  properties(node)   AS props,
  score              AS score,
  false              AS neighbor
`,
  paramSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).default(20),
    project_id: z.number().optional(),
    sub_projects: z.array(z.string()).default([]),
  }),
  accessMode: "READ",
};

// Neighbor expansion is a second template — keeps the FTS step + the
// 1-hop walk independently testable.
export const searchMemoryExpandTemplate: CypherTemplate = {
  id: "memory.search.expand",
  cypher: `
MATCH (anchor {project_id: $project_id})
WHERE anchor.id IN $anchor_ids
MATCH (anchor)-[r]-(n {project_id: $project_id})
WHERE (size($types) = 0 OR any(t IN $types WHERE t IN labels(n)))
  AND ($sub_projects = [] OR n.source IS NULL OR ANY(s IN $sub_projects WHERE s IN n.source))
RETURN
  labels(n)[0]      AS label,
  properties(n)     AS props,
  0.0               AS score,
  true              AS neighbor
LIMIT $limit
`,
  paramSchema: z.object({
    anchor_ids: z.array(z.string()),
    types: z.array(z.string()).default([]),
    limit: z.number().int().positive().max(200).default(50),
    project_id: z.number().optional(),
    sub_projects: z.array(z.string()).default([]),
  }),
  accessMode: "READ",
};
