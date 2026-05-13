import { z } from "zod";
import type { CypherTemplate } from "../../types";

// Deletes up to $batch nodes (with their relationships) from one project's
// graph partition. NOT tenancyExempt — `$project_id` IS the tenancy guard
// (validateTemplateRegistry from FR-SFQDXR sees the marker and passes).
//
// Returns the count of nodes deleted in this batch so the sweeper can loop
// until the count is 0.
export const dropProjectBatchTemplate: CypherTemplate = {
  id: "cleanup.drop_project_batch",
  cypher: `
MATCH (n {project_id: $project_id})
WITH n LIMIT $batch
DETACH DELETE n
RETURN count(n) AS deleted
`,
  paramSchema: z.object({
    batch: z.number().int().positive().max(50_000).default(1000),
    project_id: z.number().optional(),
  }),
  accessMode: "WRITE",
};
