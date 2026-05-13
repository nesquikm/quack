import { describe, test, expect } from "bun:test";
import { getNeighbors, getNeighborsSchema } from "./get_neighbors";
import type { GraphAdapter } from "../../../graph/adapter";

const memberCtx = { user_id: 1, project_id: 10, role: "member" as const };

function mockAdapter(rows: unknown[]): GraphAdapter {
  return {
    async run() {
      return { rows };
    },
  } as GraphAdapter;
}

describe("getNeighbors", () => {
  test("happy path returns MemoryItems with hops bounded by depth", async () => {
    const adapter = mockAdapter([
      { label: "Entity", props: { id: "e1", project_id: 10, name: "x" }, hops: 1 },
      { label: "Decision", props: { id: "d1", project_id: 10, summary: "y" }, hops: 1 },
    ]);
    const out = await getNeighbors(
      { node_id: "root", depth: 1, edge_types: [], limit: 50, mode: "templates" },
      memberCtx,
      adapter,
    );
    expect(out.results.length).toBe(2);
    expect(out.meta.coverage.traversals).toBe(2);
  });

  test("depth: 4 rejected by Zod", () => {
    const parsed = getNeighborsSchema.safeParse({ node_id: "x", depth: 4 });
    expect(parsed.success).toBe(false);
  });

  test("depth=3 with results at limit → depth_3_blowup_likely warning", async () => {
    const rows = Array.from({ length: 50 }).map((_, i) => ({
      label: "Entity",
      props: { id: `e${i}`, project_id: 10, name: `n${i}` },
      hops: 3,
    }));
    const adapter = mockAdapter(rows);
    const out = await getNeighbors(
      { node_id: "root", depth: 3, edge_types: [], limit: 50, mode: "templates" },
      memberCtx,
      adapter,
    );
    expect(out.meta.warnings).toContain("depth_3_blowup_likely");
    expect(out.meta.coverage.truncated).toBe(true);
  });

  test("mode: 'planned' rejected", async () => {
    await expect(
      getNeighbors(
        { node_id: "x", depth: 1, edge_types: [], limit: 50, mode: "planned" },
        memberCtx,
        mockAdapter([]),
      ),
    ).rejects.toMatchObject({ code: "not_implemented_yet" });
  });
});
