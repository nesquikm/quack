import { describe, test, expect } from "bun:test";
import { searchMemory, searchMemorySchema } from "./search_memory";
import { MemoryToolError } from "../../errors";
import type { GraphAdapter } from "../../../graph/adapter";

const adminCtx = { user_id: 1, project_id: 10, role: "admin" as const };

function mockAdapter(rowsByTemplate: Record<string, unknown[]>): GraphAdapter {
  return {
    async run(templateId: string) {
      return { rows: rowsByTemplate[templateId] ?? [] };
    },
  } as GraphAdapter;
}

// Records the params each template was called with, so tests can assert that
// `sub_projects` is threaded through to the Cypher layer.
function recordingAdapter(rowsByTemplate: Record<string, unknown[]>): {
  adapter: GraphAdapter;
  calls: Array<{ templateId: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ templateId: string; params: Record<string, unknown> }> = [];
  const adapter = {
    async run(templateId: string, params: unknown) {
      calls.push({ templateId, params: (params ?? {}) as Record<string, unknown> });
      return { rows: rowsByTemplate[templateId] ?? [] };
    },
  } as GraphAdapter;
  return { adapter, calls };
}

describe("searchMemory", () => {
  test("zero FTS hits → warnings includes no_full_text_match", async () => {
    const adapter = mockAdapter({ "memory.search": [] });
    const out = await searchMemory({ entities: ["nope"], mode: "templates", limit: 20 }, adminCtx, adapter);
    expect(out.results.length).toBe(0);
    expect(out.meta.warnings).toContain("no_full_text_match");
  });

  test("happy path returns MemoryItems wrapped with <memory>", async () => {
    const adapter = mockAdapter({
      "memory.search": [
        {
          label: "Entity",
          props: { id: "e1", project_id: 10, name: "auth", kind: "library", created_at: "2026-05-10" },
          score: 0.9,
          neighbor: false,
        },
      ],
    });
    const out = await searchMemory({ entities: ["auth"], mode: "templates", limit: 20 }, adminCtx, adapter);
    expect(out.results.length).toBe(1);
    expect(out.results[0]?._memory_wrapped).toContain("<memory kind=\"Entity\">");
    expect(out.meta.coverage.matched_entities).toBe(1);
  });

  test("limit cap triggers truncated: true", async () => {
    const fakeRows = Array.from({ length: 5 }).map((_, i) => ({
      label: "Entity",
      props: { id: `e${i}`, project_id: 10, name: `n${i}` },
      score: 1 - i * 0.1,
      neighbor: false,
    }));
    const adapter = mockAdapter({ "memory.search": fakeRows });
    const out = await searchMemory({ entities: ["x"], mode: "templates", limit: 5 }, adminCtx, adapter);
    expect(out.meta.coverage.truncated).toBe(true);
  });

  test("mode: 'planned' → not_implemented_yet", async () => {
    const adapter = mockAdapter({ "memory.search": [] });
    await expect(
      searchMemory({ entities: ["x"], mode: "planned", limit: 20 }, adminCtx, adapter),
    ).rejects.toMatchObject({ code: "not_implemented_yet" });
  });

  test("Zod invalid args (empty entities array) — caught by schema upstream", () => {
    const parsed = searchMemorySchema.safeParse({ entities: [] });
    expect(parsed.success).toBe(false);
  });

  test("Zod invalid args (limit > 100) — caught upstream", () => {
    const parsed = searchMemorySchema.safeParse({ entities: ["a"], limit: 101 });
    expect(parsed.success).toBe(false);
  });

  test("missing adapter throws MemoryToolError(no_graph_adapter)", async () => {
    await expect(
      searchMemory({ entities: ["x"], mode: "templates", limit: 20 }, adminCtx, undefined),
    ).rejects.toBeInstanceOf(MemoryToolError);
  });

  test("invalid time_range surface invalid_args from MemoryToolError", async () => {
    const adapter = mockAdapter({ "memory.search": [] });
    await expect(
      searchMemory(
        { entities: ["x"], mode: "templates", limit: 20, time_range: "garbage" },
        adminCtx,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  // AC-A9BN0M.5 — optional `sub_projects` request field, each element
  // slug-shaped. Default (absent OR empty) is byte-unchanged. A non-empty
  // value is threaded into the Cypher template params.
  test("AC-A9BN0M.5: schema accepts an absent sub_projects (whole-project default)", () => {
    const parsed = searchMemorySchema.safeParse({ entities: ["x"] });
    expect(parsed.success).toBe(true);
  });

  test("AC-A9BN0M.5: schema accepts a slug-shaped sub_projects array", () => {
    const parsed = searchMemorySchema.safeParse({ entities: ["x"], sub_projects: ["backend", "frontend"] });
    expect(parsed.success).toBe(true);
  });

  test("AC-A9BN0M.6: a malformed sub_projects element is rejected by Zod (→ invalid_args)", () => {
    const parsed = searchMemorySchema.safeParse({ entities: ["x"], sub_projects: ["Bad Slug!"] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toContain("sub_projects");
    }
  });

  test("AC-A9BN0M.5: non-empty sub_projects is threaded into the search template params", async () => {
    const { adapter, calls } = recordingAdapter({
      "memory.search": [
        { label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 0.9, neighbor: false },
      ],
    });
    await searchMemory(
      { entities: ["auth"], mode: "templates", limit: 20, sub_projects: ["backend"] },
      adminCtx,
      adapter,
    );
    const searchCall = calls.find((c) => c.templateId === "memory.search");
    expect(searchCall).toBeDefined();
    expect(searchCall!.params["sub_projects"]).toEqual(["backend"]);
  });

  test("AC-A9BN0M.5: absent sub_projects threads an empty array (whole-project recall)", async () => {
    const { adapter, calls } = recordingAdapter({
      "memory.search": [
        { label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 0.9, neighbor: false },
      ],
    });
    await searchMemory({ entities: ["auth"], mode: "templates", limit: 20 }, adminCtx, adapter);
    const searchCall = calls.find((c) => c.templateId === "memory.search");
    expect(searchCall!.params["sub_projects"]).toEqual([]);
  });

  test("AC-A9BN0M.5: sub_projects is also threaded into the memory.search.expand call", async () => {
    // Regression — neighbor-expansion rows must be narrowed by the same
    // sub_projects filter as the FTS anchors, otherwise a filtered query with
    // `types[]` leaks expansion neighbors from other sub-projects.
    const { adapter, calls } = recordingAdapter({
      "memory.search": [
        { label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 0.9, neighbor: false },
      ],
      "memory.search.expand": [
        { label: "File", props: { id: "f1", project_id: 10, path: "src/x.ts" }, score: 0, neighbor: true },
      ],
    });
    await searchMemory(
      { entities: ["auth"], mode: "templates", limit: 20, types: ["File"], sub_projects: ["backend"] },
      adminCtx,
      adapter,
    );
    const expandCall = calls.find((c) => c.templateId === "memory.search.expand");
    expect(expandCall, "expand call should fire — anchors + types present").toBeDefined();
    expect(expandCall!.params["sub_projects"]).toEqual(["backend"]);
  });
});
