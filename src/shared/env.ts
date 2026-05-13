import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(7474),
  QUACK_BOOTSTRAP_TOKEN: z
    .string()
    .min(1)
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  QUACK_DATA_DIR: z.string().min(1).default("./data"),
  QUACK_MODEL_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  QUACK_MODEL_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  // Bind address for the Bun HTTP server.
  // - Dev (default): `127.0.0.1` — loopback-only on the developer machine.
  // - Docker: the Dockerfile sets `0.0.0.0`. The loopback-only guarantee is
  //   then enforced by compose.yml's `127.0.0.1:7474:7474` host-side port
  //   mapping (AC-BKPM28.4), not by the in-container bind.
  // Only `127.0.0.1` and `0.0.0.0` are accepted to make misconfiguration
  // a startup error rather than an LAN exposure.
  QUACK_BIND_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  // Neo4j connection (FR-SFQDXR). Password is required — Zod refuses on absence.
  QUACK_NEO4J_URL: z.string().min(1).default("bolt://graphdb:7687"),
  QUACK_NEO4J_USER: z.string().min(1).default("neo4j"),
  QUACK_NEO4J_PASSWORD: z.string().min(1),

  // Extraction loop (FR-4NY6S1).
  QUACK_QUEUE_CAPACITY: z.coerce.number().int().positive().default(10000),
  QUACK_EXTRACTOR_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // Comma-separated extended-regex strings appended to the default redaction
  // pattern set. Empty value = use defaults only.
  QUACK_REDACTION_PATTERNS: z
    .string()
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : v)),
  QUACK_MODEL_NAME: z.string().min(1).default("gpt-4o-mini"),
  QUACK_DEAD_LETTER_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),

  // add_memory MCP tool (FR-41NXTZ). Caps `content` byte length.
  QUACK_ADD_MEMORY_MAX_BYTES: z.coerce.number().int().positive().default(32768),
});

export type Env = z.infer<typeof envSchema>;

type Issue = { path: PropertyKey[]; message: string };

export class EnvError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(`invalid environment: ${issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

export function parseEnv(source: Record<string, string | undefined> = Bun.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues);
  }
  return result.data;
}

// Narrow reader for QUACK_ADD_MEMORY_MAX_BYTES — used by add_memory.ts at
// module load. Reads only this one var so the import-time schema-build doesn't
// require a fully-populated env (e.g., unit tests that don't set
// QUACK_NEO4J_PASSWORD). Same default + coercion semantics as the full schema.
const addMemoryMaxBytesSchema = z.coerce.number().int().positive().default(32768);
export function getAddMemoryMaxBytes(
  source: Record<string, string | undefined> = Bun.env,
): number {
  return addMemoryMaxBytesSchema.parse(source.QUACK_ADD_MEMORY_MAX_BYTES);
}
