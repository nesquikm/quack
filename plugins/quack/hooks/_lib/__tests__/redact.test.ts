import { describe, test, expect } from "bun:test";
import { buildHookRedactor } from "../redact";

describe("buildHookRedactor", () => {
  test("default patterns active", () => {
    const r = buildHookRedactor({});
    const { value, matchCount } = r.redact({ secret: "sk-abcdefghijklmnopqrstuvwx" });
    expect(matchCount).toBe(1);
    expect((value as { secret: string }).secret).toContain("«REDACTED»");
  });

  test("QUACK_HOOK_REDACTION_PATTERNS extras append to defaults", () => {
    const r = buildHookRedactor({ QUACK_HOOK_REDACTION_PATTERNS: "internal-\\d{4}" });
    const { matchCount } = r.redact("internal-1234 and sk-abcdefghijklmnopqrstuvwx");
    expect(matchCount).toBe(2);
  });
});
