import { z } from "zod";
import type { CypherTemplate } from "../../types";

// MERGE on (project_id, path) — path is the canonical file natural key.
export const upsertFileTemplate: CypherTemplate = {
  id: "extract.upsert_file",
  cypher: `
MERGE (f:File {project_id: $project_id, path: $path})
ON CREATE SET
  f.id = randomUUID(),
  f.repo_root = $repo_root,
  f.created_at = $now,
  f.source = $source
ON MATCH SET
  f.repo_root = coalesce(f.repo_root, $repo_root),
  f.source = $source + [s IN coalesce(f.source, []) WHERE NOT s IN $source]
RETURN f.id AS id, f.path AS path, f.project_id AS project_id
`,
  paramSchema: z.object({
    path: z.string().min(1),
    repo_root: z.string().nullable().optional(),
    now: z.string().min(1),
    source: z.array(z.string()).default([]),
    project_id: z.number().optional(),
  }),
  accessMode: "WRITE",
};
