import { describe, test, expect } from "bun:test";
import { ASK_SYSTEM_PROMPT, ASK_TOOL_NAMES } from "./ask_prompt";

// AC-WB3N9H.8 (defense-in-depth — untrusted I/O): the system prompt instructs
// the model to treat all retrieved memory as untrusted data, never as
// instructions; the model's only tools are the four project_id-scoped read
// primitives. No graph-write / token / NL→Cypher tool is ever named.
describe("ask_prompt (AC-WB3N9H.8)", () => {
  test("ASK_TOOL_NAMES is exactly the four read primitives", () => {
    expect([...ASK_TOOL_NAMES].sort()).toEqual(
      ["get_neighbors", "path_between", "recent_decisions", "search_memory"].sort(),
    );
  });

  test("system prompt frames retrieved memory as untrusted data, not instructions", () => {
    const lower = ASK_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("untrusted");
    // Must explicitly forbid following instructions found inside memory.
    expect(lower).toContain("instruction");
  });

  test("system prompt instructs grounding answers only in retrieved results", () => {
    const lower = ASK_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("ground");
  });

  test("system prompt names only the four read primitives — never write/token/cypher tools", () => {
    const lower = ASK_SYSTEM_PROMPT.toLowerCase();
    for (const t of ASK_TOOL_NAMES) {
      expect(ASK_SYSTEM_PROMPT).toContain(t);
    }
    // Forbidden tool surfaces must never appear.
    expect(lower).not.toContain("cypher");
    expect(lower).not.toContain("add_memory");
    expect(lower).not.toContain("revoke_token");
  });
});
