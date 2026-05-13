import { compilePatterns, REDACTION_REPLACEMENT } from "../shared/redaction_patterns";

// Deep-walk redaction. Applied to the hook payload BEFORE the outbound model
// POST. Patterns compile once at construction; no per-request recompilation.
//
// Replacement count is reported back so the caller can increment the
// `redaction_match` info-level counter (visible in errors.by_category).

export interface Redactor {
  redact<T>(value: T): { value: T; matchCount: number };
}

export function createRedactor(extras: readonly string[] = []): Redactor {
  const patterns = compilePatterns(extras);

  function redactString(s: string, counter: { n: number }): string {
    let out = s;
    for (const re of patterns) {
      re.lastIndex = 0;
      out = out.replace(re, () => {
        counter.n += 1;
        return REDACTION_REPLACEMENT;
      });
    }
    return out;
  }

  function walk(v: unknown, counter: { n: number }): unknown {
    if (typeof v === "string") return redactString(v, counter);
    if (Array.isArray(v)) return v.map((x) => walk(x, counter));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, counter);
      }
      return out;
    }
    return v;
  }

  return {
    redact<T>(value: T): { value: T; matchCount: number } {
      const counter = { n: 0 };
      const v = walk(value, counter) as T;
      return { value: v, matchCount: counter.n };
    },
  };
}
