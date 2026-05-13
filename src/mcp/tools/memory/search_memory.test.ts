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
});
