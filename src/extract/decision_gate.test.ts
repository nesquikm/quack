import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "./prompt";

// FR-Z1W6ED AC.2/.3/.5 — the decision-worthiness gate is a kind-aware extension
// of the extractor system prompt. The gate is fuzzy LLM judgment at runtime; the
// deterministic guarantee these tests pin is that the rubric + the specific
// negative examples are present for passive kinds, and that explicit_add is
// exempted (deliberate user content is never down-graded). End-to-end model
// behavior is validated separately by the live smoke test.
describe("FR-Z1W6ED — decision-worthiness gate (buildSystemPrompt)", () => {
  test("AC-Z1W6ED.2: a passive-kind prompt carries the gate + pinned negative examples", () => {
    const sys = buildSystemPrompt("stop");
    expect(sys).toContain("DECISION-WORTHINESS GATE");
    expect(sys).toContain("WITHHOLD");
    expect(sys).toContain("Decision");
    // pinned negative examples — the SteamOS gaming opinion + tool-search chatter
    expect(sys).toContain("SteamOS");
    expect(sys.toLowerCase()).toContain("opinion");
    expect(sys).toContain("search_memory");
    // gate is additive — base schema rules still present
    expect(sys).toContain("Schema:");
    expect(sys).toContain("Do not invent new labels");
  });

  test("AC-Z1W6ED.2: every passive hook kind (and the default) gets the gate", () => {
    for (const kind of ["session_start", "stop", "post_tool_use", undefined] as const) {
      expect(buildSystemPrompt(kind), `kind=${kind} must carry the gate`).toContain(
        "DECISION-WORTHINESS GATE",
      );
    }
  });

  test("AC-Z1W6ED.3: the gate governs Decision minting ONLY — entity extraction is preserved", () => {
    const sys = buildSystemPrompt("post_tool_use");
    expect(sys).toContain("Entity, File, Symbol, and Feedback extraction is UNCHANGED");
    expect(sys.toLowerCase()).toContain("denoise removes decisions, not the entity graph");
  });

  test("AC-Z1W6ED.5: explicit_add gets the override, NOT the withholding gate", () => {
    const sys = buildSystemPrompt("explicit_add");
    expect(sys).toContain("DELIBERATE USER CONTENT");
    expect(sys.toLowerCase()).toContain("always decision-eligible");
    // the withholding gate must not apply to deliberate user content
    expect(sys).not.toContain("DECISION-WORTHINESS GATE");
    expect(sys).not.toContain("WITHHOLD");
    // base schema rules still present
    expect(sys).toContain("Schema:");
  });
});
