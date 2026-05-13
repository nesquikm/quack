import { describe, test, expect } from "bun:test";
import { pathBetween, pathBetweenSchema } from "./path_between";
import type { GraphAdapter } from "../../../graph/adapter";

const memberCtx = { user_id: 1, project_id: 10, role: "member" as const };

function mockAdapter(rows: unknown[]): GraphAdapter {
  return {
    async run() {
      return { rows };
    },
  } as GraphAdapter;
}

describe("pathBetween", () => {
  test("direct path: one row returned with hops + node/rel sequences", async () => {
    const adapter = mockAdapter([
      {
        hops: 2,
        nodes_seq: [
          { label: "Entity", props: { id: "a", project_id: 10, name: "alpha" } },
          { label: "File", props: { id: "f", project_id: 10, path: "x.ts" } },
          { label: "Entity", props: { id: "b", project_id: 10, name: "beta" } },
        ],
        rels_seq: [
          { type: "MENTIONS", props: {} },
          { type: "MODIFIES", props: {} },
        ],
      },
    ]);
    const out = await pathBetween(
      { node_a: "a", node_b: "b", max_hops: 5, limit: 25, mode: "templates" },
      memberCtx,
      adapter,
    );
    expect(out.results.length).toBe(1);
    expect(out.results[0]?.hops).toBe(2);
    expect(out.results[0]?.nodes_seq.length).toBe(3);
    expect(out.results[0]?.rels_seq.length).toBe(2);
  });

  test("no path → warnings include no_path_found", async () => {
    const adapter = mockAdapter([]);
    const out = await pathBetween(
      { node_a: "a", node_b: "b", max_hops: 5, limit: 25, mode: "templates" },
      memberCtx,
      adapter,
    );
    expect(out.results.length).toBe(0);
    expect(out.meta.warnings).toContain("no_path_found");
  });

  test("max_hops: 9 rejected by Zod", () => {
    const parsed = pathBetweenSchema.safeParse({ node_a: "a", node_b: "b", max_hops: 9 });
    expect(parsed.success).toBe(false);
  });

  test("mode: 'planned' rejected", async () => {
    await expect(
      pathBetween({ node_a: "a", node_b: "b", max_hops: 5, limit: 25, mode: "planned" }, memberCtx, mockAdapter([])),
    ).rejects.toMatchObject({ code: "not_implemented_yet" });
  });
});
