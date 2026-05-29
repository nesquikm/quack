import { describe, test, expect } from "bun:test";
import { writeExtraction } from "./writer";
import type { GraphAdapter } from "../graph/adapter";
import type { AuthContext } from "../auth/middleware";
import type { ExtractionResult } from "./client";

// AC-Z1W6ED.4 — every minted node records its originating envelope `kind`
// (session_start | stop | post_tool_use | explicit_add) as provenance, folded
// into the node `source` set ahead of the sub-project. This lets pre-existing
// and future noise be audited and selectively cleaned by its originating kind,
// while keeping the sub_projects recall filter unaffected (a kind is never a
// valid sub-project slug).

const ctxA: AuthContext = { user_id: 1, project_id: 100, role: "admin" };

interface Call {
  templateId: string;
  params: Record<string, unknown>;
}

function fakeAdapter(): { adapter: GraphAdapter; calls: Call[] } {
  const calls: Call[] = [];
  const adapter = {
    async run(templateId: string, params: unknown) {
      calls.push({ templateId, params: params as Record<string, unknown> });
      const p = params as { name?: string; path?: string };
      return { rows: [{ id: `${templateId}-${calls.length}`, name: p.name, path: p.path }] };
    },
  } as unknown as GraphAdapter;
  return { adapter, calls };
}

function makeResult(partial: Partial<ExtractionResult>): ExtractionResult {
  return {
    entities: [],
    decisions: [],
    files: [],
    symbols: [],
    feedbacks: [],
    relations: [],
    ...partial,
  } as ExtractionResult;
}

const NODE_TEMPLATES = [
  "extract.upsert_entity",
  "extract.upsert_decision",
  "extract.upsert_file",
  "extract.upsert_symbol",
  "extract.upsert_feedback",
];

describe("AC-Z1W6ED.4 — envelope kind folded into node source provenance", () => {
  test("every node-upsert records the kind first in source, sub_project second", async () => {
    const { adapter, calls } = fakeAdapter();
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({
        entities: [{ name: "auth", kind: "library" }],
        files: [{ path: "src/x.ts" }],
        decisions: [{ summary: "use Bun", source_excerpt: "" }],
      }),
      "2026-05-13T00:00:00Z",
      { kind: "stop", sub_project: "backend" },
    );
    const nodeCalls = calls.filter((c) => NODE_TEMPLATES.includes(c.templateId));
    expect(nodeCalls.length).toBeGreaterThanOrEqual(3);
    for (const c of nodeCalls) {
      expect(c.params["source"], `${c.templateId} must carry [kind, sub_project]`).toEqual([
        "stop",
        "backend",
      ]);
    }
  });

  test("an explicit_add envelope with no sub_project ⇒ source is ['explicit_add']", async () => {
    const { adapter, calls } = fakeAdapter();
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({ entities: [{ name: "auth", kind: "library" }] }),
      "2026-05-13T00:00:00Z",
      { kind: "explicit_add" },
    );
    const entityCall = calls.find((c) => c.templateId === "extract.upsert_entity");
    expect(entityCall!.params["source"]).toEqual(["explicit_add"]);
  });

  test("a stop envelope with no sub_project ⇒ source is ['stop']", async () => {
    const { adapter, calls } = fakeAdapter();
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({ entities: [{ name: "auth", kind: "library" }] }),
      "2026-05-13T00:00:00Z",
      { kind: "stop" },
    );
    const entityCall = calls.find((c) => c.templateId === "extract.upsert_entity");
    expect(entityCall!.params["source"]).toEqual(["stop"]);
  });

  test("an unknown/malformed kind is dropped (defense-in-depth) ⇒ source []", async () => {
    const { adapter, calls } = fakeAdapter();
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({ entities: [{ name: "auth", kind: "library" }] }),
      "2026-05-13T00:00:00Z",
      { kind: "bogus_kind" },
    );
    const entityCall = calls.find((c) => c.templateId === "extract.upsert_entity");
    expect(entityCall!.params["source"]).toEqual([]);
  });

  test("relation calls never carry a source param (kind included)", async () => {
    const { adapter, calls } = fakeAdapter();
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({
        entities: [{ name: "auth", kind: "library" }],
        files: [{ path: "src/x.ts" }],
        relations: [
          { type: "MENTIONS", from: { kind: "Entity", name: "auth" }, to: { kind: "File", name: "src/x.ts" } },
        ],
      }),
      "2026-05-13T00:00:00Z",
      { kind: "stop" },
    );
    const relCall = calls.find((c) => c.templateId === "extract.upsert_relation");
    expect(relCall).toBeDefined();
    expect(relCall!.params["source"]).toBeUndefined();
  });
});
