import { z } from "zod";
import type { CypherTemplate } from "../../types";

// Symbol is keyed by (project_id, file_id, name). file_id is supplied by the
// caller (writer) AFTER it has resolved/created the owning File. Caller
// passes `file_id`, NOT `file_path`.
export const upsertSymbolTemplate: CypherTemplate = {
  id: "extract.upsert_symbol",
  cypher: `
MATCH (f:File {project_id: $project_id, id: $file_id})
MERGE (s:Symbol {project_id: $project_id, name: $name, file_id: $file_id})
ON CREATE SET
  s.id = randomUUID(),
  s.kind = $kind,
  s.created_at = $now
ON MATCH SET
  s.kind = coalesce(s.kind, $kind)
RETURN s.id AS id, s.name AS name, s.file_id AS file_id, s.project_id AS project_id
`,
  paramSchema: z.object({
    name: z.string().min(1),
    file_id: z.string().min(1),
    kind: z.string().min(1),
    now: z.string().min(1),
    project_id: z.number().optional(),
  }),
  accessMode: "WRITE",
};
