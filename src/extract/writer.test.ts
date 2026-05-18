import { describe, test, expect } from "bun:test";
import { writeExtraction } from "./writer";
import type { GraphAdapter } from "../graph/adapter";
import type { AuthContext } from "../auth/middleware";
import type { ExtractionResult } from "./client";

const ctxA: AuthContext = { user_id: 1, project_id: 100, role: "admin" };

interface Call { templateId: string; params: Record<string, unknown> }

function fakeAdapter(idStreams: Record<string, string[]>): { adapter: GraphAdapter; calls: Call[] } {
  const calls: Call[] = [];
  let counters = Object.fromEntries(Object.keys(idStreams).map((k) => [k, 0])) as Record<string, number>;
  const adapter = {
    async run(templateId: string, params: unknown) {
      calls.push({ templateId, params: params as Record<string, unknown> });
      const ids = idStreams[templateId] ?? [];
      const idx = counters[templateId] ?? 0;
      counters[templateId] = idx + 1;
      const id = ids[idx] ?? `${templateId}-${idx}`;
      return { rows: [{ id, name: (params as { name?: string }).name, path: (params as { path?: string }).path }] };
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

describe("writeExtraction", () => {
  test("entity-first ordering: entities before files/symbols, all before relations", async () => {
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({
        entities: [{ name: "auth", kind: "library" }],
        files: [{ path: "src/x.ts" }],
        symbols: [{ name: "foo", file_path: "src/x.ts", kind: "function" }],
        relations: [{ type: "MENTIONS", from: { kind: "Entity", name: "auth" }, to: { kind: "File", name: "src/x.ts" } }],
      }),
      "2026-05-13T00:00:00Z",
    );
    const order = calls.map((c) => c.templateId);
    expect(order.indexOf("extract.upsert_entity")).toBeLessThan(order.indexOf("extract.upsert_file"));
    expect(order.indexOf("extract.upsert_file")).toBeLessThan(order.indexOf("extract.upsert_symbol"));
    expect(order.indexOf("extract.upsert_relation")).toBeGreaterThan(order.lastIndexOf("extract.upsert_entity"));
  });

  test("relation endpoint resolves via canonicalized entity name", async () => {
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({
        entities: [{ name: "Auth-MW", kind: "library" }],
        files: [{ path: "src/x.ts" }],
        relations: [
          { type: "MENTIONS", from: { kind: "Entity", name: "Auth-MW" }, to: { kind: "File", name: "src/x.ts" } },
        ],
      }),
      "2026-05-13T00:00:00Z",
    );
    const relCall = calls.find((c) => c.templateId === "extract.upsert_relation");
    expect(relCall).toBeDefined();
    expect(typeof relCall!.params["from_id"]).toBe("string");
    expect(typeof relCall!.params["to_id"]).toBe("string");
  });

  test("symbol references a file the model didn't list — materialized on the fly", async () => {
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({
        symbols: [{ name: "ghost", file_path: "src/ghost.ts", kind: "function" }],
      }),
      "2026-05-13T00:00:00Z",
    );
    const fileCalls = calls.filter((c) => c.templateId === "extract.upsert_file");
    expect(fileCalls.length).toBe(1);
    expect(fileCalls[0]?.params["path"]).toBe("src/ghost.ts");
  });

  test("dedupes aliases and drops empties; canonicalizes entity name", async () => {
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({
        entities: [{ name: "AuthMW", kind: "library", aliases: ["AuthMW", "authmw", "Auth-MW", "!!!"] }],
      }),
      "2026-05-13T00:00:00Z",
    );
    const entityCall = calls.find((c) => c.templateId === "extract.upsert_entity");
    expect(entityCall!.params["name"]).toBe("authmw");
    expect(entityCall!.params["aliases"]).toEqual(["auth-mw"]);
  });

  // AC-A9BN0M.4 — the writer resolves the sub-project and threads it as
  // `$source` (a single-element array, or [] when absent) into every
  // node-upsert GraphAdapter.run call.
  const NODE_TEMPLATES = [
    "extract.upsert_entity",
    "extract.upsert_decision",
    "extract.upsert_file",
    "extract.upsert_symbol",
    "extract.upsert_feedback",
  ];

  test("AC-A9BN0M.4: every node-upsert call receives source: [sub_project]", async () => {
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({
        entities: [{ name: "auth", kind: "library" }],
        files: [{ path: "src/x.ts" }],
        symbols: [{ name: "foo", file_path: "src/x.ts", kind: "function" }],
        decisions: [{ summary: "use Bun", source_excerpt: "" }],
        feedbacks: [{ body: "I like it" }],
      }),
      "2026-05-13T00:00:00Z",
      { sub_project: "backend" },
    );
    const nodeCalls = calls.filter((c) => NODE_TEMPLATES.includes(c.templateId));
    expect(nodeCalls.length).toBeGreaterThanOrEqual(5);
    for (const c of nodeCalls) {
      expect(c.params["source"], `${c.templateId} must carry source`).toEqual(["backend"]);
    }
  });

  test("AC-A9BN0M.4: absent sub_project ⇒ node-upsert calls carry source: []", async () => {
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({ entities: [{ name: "auth", kind: "library" }] }),
      "2026-05-13T00:00:00Z",
    );
    const entityCall = calls.find((c) => c.templateId === "extract.upsert_entity");
    expect(entityCall!.params["source"]).toEqual([]);
  });

  test("AC-A9BN0M.4: a non-conforming sub_project is dropped to source: []", async () => {
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({ entities: [{ name: "auth", kind: "library" }] }),
      "2026-05-13T00:00:00Z",
      { sub_project: "Bad Slug!" },
    );
    const entityCall = calls.find((c) => c.templateId === "extract.upsert_entity");
    // Writer re-validates against the slug regex; a malformed value ⇒ [].
    expect(entityCall!.params["source"]).toEqual([]);
  });

  test("AC-A9BN0M.4: relation calls never carry a source param", async () => {
    const { adapter, calls } = fakeAdapter({});
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
      { sub_project: "backend" },
    );
    const relCall = calls.find((c) => c.templateId === "extract.upsert_relation");
    expect(relCall).toBeDefined();
    expect(relCall!.params["source"]).toBeUndefined();
  });

  test("AC-A9BN0M.4: set-union idempotency — same sub-project twice keeps source single-valued", async () => {
    const { adapter, calls } = fakeAdapter({});
    const result = makeResult({ entities: [{ name: "auth", kind: "library" }] });
    await writeExtraction(adapter, ctxA, result, "2026-05-13T00:00:00Z", { sub_project: "backend" });
    await writeExtraction(adapter, ctxA, result, "2026-05-13T00:00:00Z", { sub_project: "backend" });
    const entityCalls = calls.filter((c) => c.templateId === "extract.upsert_entity");
    expect(entityCalls.length).toBe(2);
    // Both calls thread the same single-element source array — the graph-side
    // set-union (tested against Neo4j in upsert_source.test.ts) collapses them.
    for (const c of entityCalls) {
      expect(c.params["source"]).toEqual(["backend"]);
    }
  });

  test("AC-A9BN0M.4: sub_project is NOT routed through the project_id override path", async () => {
    // The sub-project is a distinct trusted-input field; the writer never
    // passes a model-supplied project_id. project_id stays absent from the
    // params the writer hands the adapter (the adapter clobbers it from ctx).
    const { adapter, calls } = fakeAdapter({});
    await writeExtraction(
      adapter,
      ctxA,
      makeResult({ entities: [{ name: "auth", kind: "library" }] }),
      "2026-05-13T00:00:00Z",
      { sub_project: "backend" },
    );
    const entityCall = calls.find((c) => c.templateId === "extract.upsert_entity");
    expect(entityCall!.params["source"]).toEqual(["backend"]);
    expect(entityCall!.params["project_id"]).toBeUndefined();
  });
});
