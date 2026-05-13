import { describe, test, expect } from "bun:test";
import { SYSTEM_PROMPT, buildUserPrompt, EXTRACTION_JSON_SCHEMA, NODE_KINDS, RELATION_TYPES } from "./prompt";

describe("extraction prompt", () => {
  test("SYSTEM_PROMPT contains the v1 schema and the forbidden-label clause", () => {
    expect(SYSTEM_PROMPT).toContain("Schema:");
    expect(SYSTEM_PROMPT).toContain("Do not invent new labels");
    expect(SYSTEM_PROMPT).toContain("Entity");
    expect(SYSTEM_PROMPT).toContain("MENTIONS");
    // Regression guard: every relation type must appear.
    for (const t of RELATION_TYPES) {
      expect(SYSTEM_PROMPT).toContain(t);
    }
    for (const n of NODE_KINDS) {
      expect(SYSTEM_PROMPT).toContain(n);
    }
  });

  test("buildUserPrompt embeds the payload as JSON", () => {
    const p = buildUserPrompt({ kind: "stop", payload: { x: 1 } });
    expect(p).toContain("\"kind\":\"stop\"");
  });

  test("EXTRACTION_JSON_SCHEMA top-level shape is non-strict-empty + has 6 keys", () => {
    expect(EXTRACTION_JSON_SCHEMA.type).toBe("object");
    expect(Object.keys(EXTRACTION_JSON_SCHEMA.properties)).toEqual([
      "entities",
      "decisions",
      "files",
      "symbols",
      "feedbacks",
      "relations",
    ]);
  });
});
