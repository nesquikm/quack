// Client-side redaction — same default pattern set as the server (FR-4NY6S1).
// Operators set QUACK_HOOK_REDACTION_PATTERNS for client-only extras.
import { createRedactor } from "../extract/redact";
import { parseExtraPatternsFromEnv } from "../shared/redaction_patterns";

export function buildHookRedactor(env: Record<string, string | undefined> = Bun.env): ReturnType<typeof createRedactor> {
  const extras = parseExtraPatternsFromEnv(env.QUACK_HOOK_REDACTION_PATTERNS);
  return createRedactor(extras);
}
