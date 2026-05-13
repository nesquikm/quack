import { z } from "zod";
import type { CypherTemplate } from "../../types";

// Feedback is keyed by (project_id, body). Duplicate "I prefer X" entries
// would otherwise stack up over time; matching on body collapses them.
export const upsertFeedbackTemplate: CypherTemplate = {
  id: "extract.upsert_feedback",
  cypher: `
MERGE (fb:Feedback {project_id: $project_id, body: $body})
ON CREATE SET
  fb.id = randomUUID(),
  fb.sentiment = $sentiment,
  fb.observed_at = $now
ON MATCH SET
  fb.sentiment = coalesce(fb.sentiment, $sentiment)
RETURN fb.id AS id, fb.body AS body, fb.project_id AS project_id
`,
  paramSchema: z.object({
    body: z.string().min(1),
    sentiment: z.string().nullable().optional(),
    now: z.string().min(1),
    project_id: z.number().optional(),
  }),
  accessMode: "WRITE",
};
