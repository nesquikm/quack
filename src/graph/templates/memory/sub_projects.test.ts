import { describe, test, expect } from "bun:test";
import { searchMemoryTemplate, searchMemoryExpandTemplate } from "./search";
import { neighborsTemplate } from "./neighbors";
import { pathBetweenTemplate } from "./path";
import { recentDecisionsTemplate } from "./recent_decisions";
import type { CypherTemplate } from "../../types";

// AC-A9BN0M.6 — the `sub_projects` filter is applied inside the Cypher
// templates as a parameterized predicate
//   ($sub_projects = [] OR n.source IS NULL OR ANY(s IN $sub_projects WHERE s IN n.source))
// never string-concatenated; `$project_id` remains the non-negotiable bind.

const READ_TEMPLATES: ReadonlyArray<[string, CypherTemplate]> = [
  ["memory.search", searchMemoryTemplate],
  ["memory.search.expand", searchMemoryExpandTemplate],
  ["memory.neighbors", neighborsTemplate],
  ["memory.path", pathBetweenTemplate],
  ["memory.recent_decisions", recentDecisionsTemplate],
];

describe("AC-A9BN0M.6 — read templates carry a $sub_projects predicate", () => {
  for (const [id, tpl] of READ_TEMPLATES) {
    test(`${id}: paramSchema accepts an empty sub_projects list`, () => {
      const base = baseParamsFor(id);
      const parsed = tpl.paramSchema.safeParse({ ...base, sub_projects: [] });
      expect(parsed.success).toBe(true);
    });

    test(`${id}: paramSchema accepts a non-empty sub_projects list`, () => {
      const base = baseParamsFor(id);
      const parsed = tpl.paramSchema.safeParse({ ...base, sub_projects: ["backend", "frontend"] });
      expect(parsed.success).toBe(true);
    });

    test(`${id}: cypher references the $sub_projects parameter`, () => {
      expect(tpl.cypher).toContain("$sub_projects");
    });

    test(`${id}: cypher keeps the non-negotiable $project_id bind`, () => {
      expect(tpl.cypher).toContain("$project_id");
    });

    test(`${id}: the predicate covers the untagged/null-source escape hatch`, () => {
      // "Untagged matches every filter" — the node-with-no-source branch and
      // the empty-filter branch must both be present in the parameterized
      // predicate (the AC-mandated three-clause OR).
      expect(tpl.cypher).toContain("$sub_projects = []");
      expect(tpl.cypher).toContain("IS NULL");
      expect(tpl.cypher).toContain("ANY(");
    });
  }
});

function baseParamsFor(id: string): Record<string, unknown> {
  switch (id) {
    case "memory.search":
      return { query: "auth", limit: 20 };
    case "memory.search.expand":
      return { anchor_ids: ["a1"], types: [], limit: 50 };
    case "memory.neighbors":
      return { node_id: "n1", depth: 1, edge_types: [], limit: 50 };
    case "memory.path":
      return { node_a: "a", node_b: "b", max_hops: 5, limit: 25 };
    case "memory.recent_decisions":
      return { from: "2026-05-01T00:00:00Z", to: "2026-05-18T00:00:00Z", limit: 20 };
    default:
      throw new Error(`no base params for ${id}`);
  }
}
