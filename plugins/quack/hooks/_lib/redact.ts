// Client-side redaction — same default pattern set as the server (FR-4NY6S1).
// Operators set QUACK_HOOK_REDACTION_PATTERNS for client-only extras.
//
// The walker implementation lives in `./shared/redactor.ts` so the server and
// the plugin tree share one definition. This file owns only the env-var seam
// that compiles the operator's extra-patterns list into the Redactor.

import { createRedactor, type Redactor } from "./shared/redactor";
import { parseExtraPatternsFromEnv } from "./shared/redaction_patterns";

export { createRedactor, type Redactor };

export function buildHookRedactor(env: Record<string, string | undefined> = Bun.env): Redactor {
  const extras = parseExtraPatternsFromEnv(env["QUACK_HOOK_REDACTION_PATTERNS"]);
  return createRedactor(extras);
}
