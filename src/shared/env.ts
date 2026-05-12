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
