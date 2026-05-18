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

  // AC-A9BN0M.5 / .6 — optional slug-shaped `sub_projects` filter, threaded
  // into the memory.neighbors template params.
  test("AC-A9BN0M.5: schema accepts an absent and a slug-shaped sub_projects", () => {
    expect(getNeighborsSchema.safeParse({ node_id: "x" }).success).toBe(true);
    expect(getNeighborsSchema.safeParse({ node_id: "x", sub_projects: ["backend"] }).success).toBe(true);
  });

  test("AC-A9BN0M.6: a malformed sub_projects element is rejected by Zod", () => {
    const parsed = getNeighborsSchema.safeParse({ node_id: "x", sub_projects: ["Bad Slug!"] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toContain("sub_projects");
    }
  });

  test("AC-A9BN0M.5: sub_projects is threaded into the memory.neighbors template params", async () => {
    const calls: Array<{ templateId: string; params: Record<string, unknown> }> = [];
    const adapter = {
      async run(templateId: string, params: unknown) {
        calls.push({ templateId, params: (params ?? {}) as Record<string, unknown> });
        return { rows: [] };
      },
    } as GraphAdapter;
    await getNeighbors(
      { node_id: "root", depth: 1, edge_types: [], limit: 50, mode: "templates", sub_projects: ["backend"] },
      memberCtx,
      adapter,
    );
    const call = calls.find((c) => c.templateId === "memory.neighbors");
    expect(call).toBeDefined();
    expect(call!.params["sub_projects"]).toEqual(["backend"]);
  });
});
