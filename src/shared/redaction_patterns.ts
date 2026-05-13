// Single source of truth for the default redaction pattern set. Used by:
//  - src/extract/redact.ts  (server-side, FR-4NY6S1 AC.5)
//  - src/hooks/redact.ts    (client-side, FR-S2D0Z5 AC.6 — same defaults)
// Operators extending the list set QUACK_REDACTION_PATTERNS (server) or
// QUACK_HOOK_REDACTION_PATTERNS (client) — appended to these defaults.

export const DEFAULT_REDACTION_PATTERNS: readonly string[] = [
  // OpenAI key shape (sk-…)
  "sk-[A-Za-z0-9]{20,}",
  // GitHub PATs
  "ghp_[A-Za-z0-9]{36,}",
  "gho_[A-Za-z0-9]{36,}",
  "ghs_[A-Za-z0-9]{36,}",
  // Slack tokens
  "xox[abp]-[A-Za-z0-9-]{10,}",
  // Generic bearer
  "Bearer\\s+[\\w._-]{20,}",
  // JWT (three base64url chunks separated by dots, leading eyJ)
  "eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}",
  // .env-style assignments with KEY/TOKEN/SECRET/PASSWORD suffixes
  "(?:[A-Z][A-Z0-9_]+_(?:KEY|TOKEN|SECRET|PASSWORD))=[^\\s]+",
];

export const REDACTION_REPLACEMENT = "«REDACTED»";

export function compilePatterns(extras: readonly string[] = []): RegExp[] {
  const all = [...DEFAULT_REDACTION_PATTERNS, ...extras];
  return all.map((p) => new RegExp(p, "g"));
}

export function parseExtraPatternsFromEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
