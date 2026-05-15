import { describe, test, expect } from "bun:test";
import { parseHookPayload } from "../payload";

// AC-44QGKH.5 — parseHookPayload(input: string): { kind?: string; data: unknown }
//
// The mini-lib owns the stdin-JSON contract. Validation failure must NOT
// throw — every error path returns `{ data: null }` so the entry file can
// silent-exit 0.

describe("parseHookPayload — happy path", () => {
  test("parses a valid JSON object and exposes it under data", () => {
    const out = parseHookPayload('{"transcript":"hello","tool":"bash"}');
    expect(out.data).toEqual({ transcript: "hello", tool: "bash" });
  });

  test("parses a valid JSON object that includes an optional 'kind' field", () => {
    const out = parseHookPayload('{"kind":"stop","transcript":"goodbye"}');
    // kind is hoisted from the payload when the harness happens to surface it.
    expect(out.kind).toBe("stop");
    expect(out.data).toEqual({ kind: "stop", transcript: "goodbye" });
  });

  test("nested objects survive intact", () => {
    const out = parseHookPayload('{"a":{"b":{"c":1}},"arr":[1,2,3]}');
    expect(out.data).toEqual({ a: { b: { c: 1 } }, arr: [1, 2, 3] });
  });
});

describe("parseHookPayload — defensive paths (never throw)", () => {
  test("empty string ⇒ { data: null } (never throws)", () => {
    let threw = false;
    let result: ReturnType<typeof parseHookPayload> | null = null;
    try {
      result = parseHookPayload("");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.data).toBeNull();
  });

  test("whitespace-only input ⇒ { data: null }", () => {
    const out = parseHookPayload("   \n  \t ");
    expect(out.data).toBeNull();
  });

  test("malformed JSON ⇒ { data: null }, does not throw", () => {
    let threw = false;
    let result: ReturnType<typeof parseHookPayload> | null = null;
    try {
      result = parseHookPayload("{not json at all");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result!.data).toBeNull();
  });

  test("JSON literal `null` ⇒ { data: null }", () => {
    const out = parseHookPayload("null");
    expect(out.data).toBeNull();
  });

  test("missing fields ⇒ data is whatever was supplied; kind is undefined", () => {
    // No `kind` field present in the JSON payload — kind must be omitted /
    // undefined, but data still exposes the parsed object so the entry
    // file can forward it untouched.
    const out = parseHookPayload('{"transcript":"x"}');
    expect(out.kind).toBeUndefined();
    expect(out.data).toEqual({ transcript: "x" });
  });

  test("non-object root (string) still does not throw; data captures the value", () => {
    let threw = false;
    let result: ReturnType<typeof parseHookPayload> | null = null;
    try {
      result = parseHookPayload('"a string value"');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // The exact storage shape is implementation-defined, but the contract
    // is: no throw + a defined return object with a `data` field.
    expect(result).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, "data")).toBe(true);
  });
});
