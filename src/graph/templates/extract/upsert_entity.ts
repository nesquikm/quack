import { z } from "zod";
import type { CypherTemplate } from "../../types";

// MERGE on (project_id, name) — natural key. Aliases extend via union of
// existing list + new list, kept distinct. No APOC fallback — uses native
// list comprehension + DISTINCT-via-COLLECT.

export const upsertEntityTemplate: CypherTemplate = {
  id: "extract.upsert_entity",
  cypher: `
MERGE (e:Entity {project_id: $project_id, name: $name})
ON CREATE SET
  e.id = randomUUID(),
  e.kind = $kind,
  e.created_at = $now,
  e.aliases = $aliases,
  e.source = $source
ON MATCH SET
  e.kind = coalesce(e.kind, $kind),
  e.aliases = $aliases + [a IN coalesce(e.aliases, []) WHERE NOT a IN $aliases],
  e.source = $source + [s IN coalesce(e.source, []) WHERE NOT s IN $source]
RETURN e.id AS id, e.name AS name, e.project_id AS project_id, e.aliases AS aliases
`,
  paramSchema: z.object({
    name: z.string().min(1),
    kind: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    now: z.string().min(1),
    source: z.array(z.string()).default([]),
    project_id: z.number().optional(),
  }),
  accessMode: "WRITE",
};
