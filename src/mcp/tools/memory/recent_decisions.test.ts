import { describe, test, expect } from "bun:test";
import { recentDecisions, recentDecisionsSchema } from "./recent_decisions";
import type { GraphAdapter } from "../../../graph/adapter";

const memberCtx = { user_id: 1, project_id: 10, role: "member" as const };

function mockAdapter(rows: unknown[]): GraphAdapter {
  return {
    async run() {
      return { rows };
    },
  } as GraphAdapter;
}

describe("recentDecisions", () => {
  test("relative-window shorthand parses; rows mapped to MemoryItems", async () => {
    const adapter = mockAdapter([
      {
        label: "Decision",
        props: {
          id: "d1",
          project_id: 10,
          summary: "picked Neo4j",
          decided_at: "2026-05-13T10:00:00Z",
        },
      },
    ]);
    const out = await recentDecisions(
      { time_window: "7d", limit: 20, mode: "templates" },
      memberCtx,
      adapter,
    );
    expect(out.results.length).toBe(1);
    if (out.results[0]?.kind !== "Decision") throw new Error("expected Decision");
    expect(out.results[0]?.summary).toBe("picked Neo4j");
  });

  test("ISO pair window accepted", async () => {
    const adapter = mockAdapter([]);
    const out = await recentDecisions(
      {
        time_window: { from: "2026-05-01T00:00:00Z", to: "2026-05-13T00:00:00Z" },
        limit: 20,
        mode: "templates",
      },
      memberCtx,
      adapter,
    );
    expect(out.results.length).toBe(0);
  });

  test("limit > 100 rejected by Zod", () => {
    const parsed = recentDecisionsSchema.safeParse({ time_window: "7d", limit: 101 });
    expect(parsed.success).toBe(false);
  });

  test("bad time_window surfaces invalid_args", async () => {
    const adapter = mockAdapter([]);
    await expect(
      recentDecisions({ time_window: "garbage", limit: 20, mode: "templates" }, memberCtx, adapter),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  test("mode: 'planned' rejected", async () => {
    await expect(
      recentDecisions({ time_window: "7d", limit: 20, mode: "planned" }, memberCtx, mockAdapter([])),
    ).rejects.toMatchObject({ code: "not_implemented_yet" });
  });
});
