import type { z } from "zod";
import type { Driver } from "neo4j-driver";
import type { AuthContext } from "../auth/middleware";

// Re-export `Driver` so callers outside src/graph/ never need to import
// `neo4j-driver` directly (the import-fence lint, AC-SFQDXR.8, refuses).
export type Neo4jDriver = Driver;

export type AccessMode = "READ" | "WRITE";

export interface CypherTemplate<TParams = unknown, TResult = unknown> {
  readonly id: string;
  readonly cypher: string;
  readonly paramSchema: z.ZodType<TParams>;
  readonly accessMode: AccessMode;
  // Only DDL / cleanup templates may be exempt from the $project_id-presence lint.
  // Opt-in flag; defaults false; audited at registry validation time.
  readonly tenancyExempt?: boolean;
  // Optional row mapper applied to each Neo4j record's `.toObject()` output.
  readonly mapRow?: (row: Record<string, unknown>) => TResult;
}

export type TemplateRegistry = Record<string, CypherTemplate>;

export interface QueryResult<TRow = unknown> {
  rows: TRow[];
}

export type { AuthContext };
