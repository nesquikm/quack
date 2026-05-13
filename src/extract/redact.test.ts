import { describe, test, expect } from "bun:test";
import { createRedactor } from "./redact";

describe("createRedactor — default patterns", () => {
  const r = createRedactor();

  test("OpenAI key shape", () => {
    const { value, matchCount } = r.redact("token: sk-abcdefghijklmnopqrstuvwx");
    expect(value).toContain("«REDACTED»");
    expect(matchCount).toBe(1);
  });

  test("GitHub PAT shapes", () => {
    expect(r.redact("ghp_" + "x".repeat(36)).matchCount).toBe(1);
    expect(r.redact("gho_" + "x".repeat(36)).matchCount).toBe(1);
    expect(r.redact("ghs_" + "x".repeat(36)).matchCount).toBe(1);
  });

  test("Slack token", () => {
    expect(r.redact("xoxb-abcde1234567").matchCount).toBe(1);
    expect(r.redact("xoxa-abcde1234567").matchCount).toBe(1);
  });

  test("Generic Bearer", () => {
    expect(r.redact("Authorization: Bearer my-token-1234567890abc").matchCount).toBe(1);
  });

  test("JWT", () => {
    const jwt =
      "eyJ" + "a".repeat(30) + "." + "b".repeat(30) + "." + "c".repeat(30);
    expect(r.redact(jwt).matchCount).toBe(1);
  });

  test(".env-style assignment", () => {
    expect(r.redact("MY_API_KEY=secret-value-123").matchCount).toBe(1);
    expect(r.redact("MY_SECRET=value").matchCount).toBe(1);
    expect(r.redact("MY_TOKEN=value").matchCount).toBe(1);
    expect(r.redact("MY_PASSWORD=value").matchCount).toBe(1);
  });

  test("negative cases (no false positives)", () => {
    expect(r.redact("a normal string").matchCount).toBe(0);
    expect(r.redact("Hello world").matchCount).toBe(0);
    expect(r.redact("sk-short").matchCount).toBe(0); // too short
  });

  test("deep-walk: nested objects + arrays + strings", () => {
    const out = r.redact({
      a: "ok",
      b: ["sk-" + "y".repeat(20)],
      c: { d: { e: "Bearer my-token-1234567890ab" } },
    });
    expect(out.matchCount).toBe(2);
    const nested = out.value as { c: { d: { e: string } } };
    expect(nested.c.d.e).toContain("«REDACTED»");
  });

  test("non-string scalars pass through unchanged", () => {
    const out = r.redact({ count: 42, ok: true, none: null });
    expect(out.matchCount).toBe(0);
    expect(out.value).toEqual({ count: 42, ok: true, none: null });
  });
});

describe("createRedactor — custom extra patterns", () => {
  test("extra patterns append to defaults", () => {
    const r = createRedactor(["foobar-\\d{6}"]);
    expect(r.redact("foobar-123456").matchCount).toBe(1);
    expect(r.redact("sk-abcdefghijklmnopqrstuvwx").matchCount).toBe(1);
  });
});
