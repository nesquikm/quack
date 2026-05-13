import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// compose.yml declares `env_file: .env` (required), so a fresh repo without
// .env makes every docker-compose test fail with "env file not found". Tests
// own their .env lifecycle: back up the user's real .env (if present),
// install a test-owned one with the test's bootstrap token, and restore
// on teardown so the developer's working tree is untouched.

export interface EnvHandle {
  envPath: string;
  /** Restores (or removes) .env to its pre-test state. Idempotent. */
  restore(): void;
}

export function installComposeEnv(repoRoot: string, contents: string): EnvHandle {
  const envPath = join(repoRoot, ".env");
  const backup = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  writeFileSync(envPath, contents.endsWith("\n") ? contents : contents + "\n", "utf8");
  let restored = false;
  return {
    envPath,
    restore() {
      if (restored) return;
      restored = true;
      if (backup === null) {
        try {
          unlinkSync(envPath);
        } catch {
          // best effort
        }
      } else {
        writeFileSync(envPath, backup, "utf8");
      }
    },
  };
}
