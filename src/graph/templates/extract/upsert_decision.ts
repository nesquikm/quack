import { z } from "zod";
import type { CypherTemplate } from "../../types";

// MERGE on (project_id, summary) — summary is the load-bearing distinguisher
// because two Decisions with identical text in the same project ARE the same
// decision (the cheap-model dedupes by phrasing).
export const upsertDecisionTemplate: CypherTemplate = {
  id: "extract.upsert_decision",
  cypher: `
MERGE (d:Decision {project_id: $project_id, summary: $summary})
ON CREATE SET
  d.id = randomUUID(),
  d.decided_at = coalesce($decided_at, $now),
  d.source_excerpt = $source_excerpt,
  d.created_at = $now,
  d.source = $source
ON MATCH SET
  d.source_excerpt = coalesce(d.source_excerpt, $source_excerpt),
  d.source = $source + [s IN coalesce(d.source, []) WHERE NOT s IN $source]
RETURN d.id AS id, d.summary AS summary, d.project_id AS project_id
`,
  paramSchema: z.object({
    summary: z.string().min(1),
    decided_at: z.string().nullable().optional(),
    source_excerpt: z.string().default(""),
    now: z.string().min(1),
    source: z.array(z.string()).default([]),
    project_id: z.number().optional(),
  }),
  accessMode: "WRITE",
};
