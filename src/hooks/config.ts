import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Configuration resolution order:
//   1) Explicit env vars (QUACK_SERVER_URL, QUACK_TOKEN, QUACK_PROJECT_SLUG)
//   2) Per-project env file ~/.quack/projects/${QUACK_PROJECT_SLUG}.env
//   3) Token still unresolved ⇒ return null (silent disable — the script
//      should exit 0 without making a request).

export interface HookConfig {
  serverUrl: string;
  token: string;
  projectSlug?: string;
}

export interface ConfigEnv {
  QUACK_SERVER_URL?: string;
  QUACK_TOKEN?: string;
  QUACK_PROJECT_SLUG?: string;
  HOME?: string;
}

const DEFAULT_SERVER_URL = "http://127.0.0.1:7474";

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function resolveConfig(env: ConfigEnv = Bun.env as ConfigEnv): HookConfig | null {
  let serverUrl = env.QUACK_SERVER_URL;
  let token = env.QUACK_TOKEN;
  let projectSlug = env.QUACK_PROJECT_SLUG;

  if (!token && projectSlug) {
    const home = env.HOME ?? homedir();
    const file = join(home, ".quack", "projects", `${projectSlug}.env`);
    if (existsSync(file)) {
      try {
        const text = readFileSync(file, "utf8");
        const parsed = parseDotenv(text);
        serverUrl = serverUrl ?? parsed["QUACK_SERVER_URL"];
        token = token ?? parsed["QUACK_TOKEN"];
        projectSlug = projectSlug ?? parsed["QUACK_PROJECT_SLUG"];
      } catch {
        // best effort; silent disable on read failure.
      }
    }
  }

  if (!token) return null;
  return {
    serverUrl: serverUrl ?? DEFAULT_SERVER_URL,
    token,
    projectSlug,
  };
}
