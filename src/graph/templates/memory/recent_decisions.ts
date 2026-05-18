import { z } from "zod";
import type { CypherTemplate } from "../../types";

// recent_decisions — Decision nodes filtered by time window, newest first.

export const recentDecisionsTemplate: CypherTemplate = {
  id: "memory.recent_decisions",
  cypher: `
MATCH (d:Decision {project_id: $project_id})
WHERE d.decided_at IS NOT NULL
  AND d.decided_at >= $from
  AND d.decided_at <= $to
  AND ($sub_projects = [] OR d.source IS NULL OR ANY(s IN $sub_projects WHERE s IN d.source))
RETURN
  labels(d)[0]      AS label,
  properties(d)     AS props
ORDER BY d.decided_at DESC
LIMIT $limit
`,
  paramSchema: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    limit: z.number().int().positive().max(100).default(20),
    project_id: z.number().optional(),
    sub_projects: z.array(z.string()).default([]),
  }),
  accessMode: "READ",
};
