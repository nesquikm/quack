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
