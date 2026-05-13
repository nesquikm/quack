import { describe, test, expect } from "bun:test";
import { buildEnvelope } from "./coverage";

describe("buildEnvelope", () => {
  test("includes mode_used: 'templates'", () => {
    const env = buildEnvelope([], { matched_entities: 0, traversals: 0, truncated: false });
    expect(env.meta.mode_used).toBe("templates");
  });

  test("truncated flag flows through", () => {
    const env = buildEnvelope(
      ["x", "y"],
      { matched_entities: 5, traversals: 10, truncated: true },
    );
    expect(env.meta.coverage.truncated).toBe(true);
    expect(env.results.length).toBe(2);
  });

  test("warnings are preserved in order", () => {
    const env = buildEnvelope(
      [],
      { matched_entities: 0, traversals: 0, truncated: false },
      ["no_full_text_match", "depth_3_blowup_likely"],
    );
    expect(env.meta.warnings).toEqual(["no_full_text_match", "depth_3_blowup_likely"]);
  });

  test("explain is optional and omitted when not provided", () => {
    const env = buildEnvelope([], { matched_entities: 0, traversals: 0, truncated: false });
    expect(env.meta.explain).toBeUndefined();
  });

  test("explain is propagated when provided", () => {
    const env = buildEnvelope(
      [],
      { matched_entities: 0, traversals: 0, truncated: false },
      [],
      { template_ids: ["memory.search"], ranking_factors: { fts_score: 0.8 } },
    );
    expect(env.meta.explain).toEqual({
      template_ids: ["memory.search"],
      ranking_factors: { fts_score: 0.8 },
    });
  });
});
