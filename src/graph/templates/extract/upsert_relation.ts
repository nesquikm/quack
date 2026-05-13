import { z } from "zod";
import type { CypherTemplate } from "../../types";

// Relationship types are NOT parameterizable in Cypher. We dispatch via
// FOREACH(_ IN CASE WHEN $type = '...' THEN [1] ELSE [] END | MERGE ...).
// Whitelist (5 values per specs/technical-spec.md §2) makes this safe; an
// unrecognized type falls through and no relation is created (idempotent).
//
// from_id / to_id are resolved by the writer beforehand via per-label upsert
// templates; this template only wires the relation.

const branch = (relType: string) => `
FOREACH (_ IN CASE WHEN $type = '${relType}' THEN [1] ELSE [] END |
  MERGE (a)-[r:${relType}]->(b)
  ON CREATE SET r.created_at = $now, r.source_excerpt = $source_excerpt
  ON MATCH SET r.source_excerpt = coalesce(r.source_excerpt, $source_excerpt)
)`;

export const upsertRelationTemplate: CypherTemplate = {
  id: "extract.upsert_relation",
  cypher: `
MATCH (a {project_id: $project_id, id: $from_id})
MATCH (b {project_id: $project_id, id: $to_id})
${branch("MENTIONS")}
${branch("DECIDED_BY")}
${branch("RELATED_TO")}
${branch("MODIFIES")}
${branch("FOLLOWS")}
RETURN $type AS rel_type
`,
  paramSchema: z.object({
    type: z.enum(["MENTIONS", "DECIDED_BY", "RELATED_TO", "MODIFIES", "FOLLOWS"]),
    from_id: z.string().min(1),
    to_id: z.string().min(1),
    source_excerpt: z.string().default(""),
    now: z.string().min(1),
    project_id: z.number().optional(),
  }),
  accessMode: "WRITE",
};
