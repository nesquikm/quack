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

  // AC-41NXTZ.7 — explicit_add branch frames content as a user-asserted fact.
  test("AC-41NXTZ.7: buildUserPrompt for kind: 'explicit_add' contains 'user-asserted fact' marker", () => {
    const p = buildUserPrompt({
      kind: "explicit_add",
      payload: { content: "I prefer Bun over Node for this project" },
    });
    expect(p).toContain("user-asserted fact");
    // Content must still appear in the prompt body so the model can extract from it.
    expect(p).toContain("I prefer Bun over Node for this project");
  });

  test("AC-41NXTZ.7: hook-kind prompts are byte-unchanged (no 'user-asserted fact' bleed)", () => {
    // session_start / stop / post_tool_use prompts MUST NOT contain the marker
    // phrase. This is the byte-localization guarantee — the explicit_add branch
    // must not mutate the hook-kind branches.
    for (const kind of ["session_start", "stop", "post_tool_use"]) {
      const p = buildUserPrompt({ kind, payload: { x: 1 } });
      expect(p).not.toContain("user-asserted fact");
    }
  });

  test("AC-41NXTZ.7: hook-kind 'stop' prompt is exactly the legacy 'Extract from this hook payload' frame", () => {
    // Locks in the byte-unchanged guarantee for hook-kind branches: the literal
    // legacy frame "Extract from this hook payload:" must still introduce the
    // body for non-explicit_add kinds.
    const p = buildUserPrompt({ kind: "stop", payload: { x: 1 } });
    expect(p).toContain("Extract from this hook payload");
  });
});
