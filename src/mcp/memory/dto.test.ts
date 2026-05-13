import { describe, test, expect } from "bun:test";
import { nodeToMemoryItem, extractMemoryWrap, buildMemoryWrap } from "./dto";

describe("nodeToMemoryItem", () => {
  test("Entity maps name/kind/aliases/created_at and excludes internal id from wrap", () => {
    const item = nodeToMemoryItem("Entity", {
      id: "ent-1",
      project_id: 10,
      name: "auth-middleware",
      kind: "library",
      aliases: ["auth-mw", "AuthMW"],
      created_at: "2026-05-10T00:00:00Z",
    });
    expect(item.kind).toBe("Entity");
    expect(item.id).toBe("ent-1");
    expect(item.project_id).toBe(10);
    expect(item._memory_wrapped).toContain("<memory kind=\"Entity\">");
    expect(item._memory_wrapped).toContain("name: auth-middleware");
    expect(item._memory_wrapped).toContain("entity_kind: library");
    expect(item._memory_wrapped).toContain("aliases: auth-mw, AuthMW");
    // Internal fields excluded from wrap:
    expect(item._memory_wrapped).not.toContain("ent-1");
    expect(item._memory_wrapped).not.toContain("project_id");
  });

  test("Decision serializes summary/decided_at/source_excerpt", () => {
    const item = nodeToMemoryItem("Decision", {
      id: "dec-1",
      project_id: 10,
      summary: "Picked Neo4j Community",
      decided_at: "2026-05-13T10:00:00Z",
      source_excerpt: "/brainstorm note: largest Cypher ecosystem",
    });
    expect(item.kind).toBe("Decision");
    expect(item._memory_wrapped).toContain("summary: Picked Neo4j Community");
    expect(item._memory_wrapped).toContain("source_excerpt: /brainstorm note: largest Cypher ecosystem");
  });

  test("File serializes path/repo_root/created_at", () => {
    const item = nodeToMemoryItem("File", {
      id: "f-1",
      project_id: 10,
      path: "src/auth/middleware.ts",
      repo_root: "github.com/x/y",
    });
    if (item.kind !== "File") throw new Error("expected File");
    expect(item.path).toBe("src/auth/middleware.ts");
    expect(item._memory_wrapped).toContain("path: src/auth/middleware.ts");
  });

  test("Symbol carries file_id and serializes name/symbol_kind", () => {
    const item = nodeToMemoryItem("Symbol", {
      id: "s-1",
      project_id: 10,
      name: "AuthMiddleware",
      kind: "class",
      file_id: "f-1",
      created_at: "2026-05-13T10:00:00Z",
    });
    if (item.kind !== "Symbol") throw new Error("expected Symbol");
    expect(item.file_id).toBe("f-1");
    expect(item._memory_wrapped).toContain("name: AuthMiddleware");
    expect(item._memory_wrapped).toContain("symbol_kind: class");
  });

  test("Feedback narrows sentiment to known literals", () => {
    const item = nodeToMemoryItem("Feedback", {
      id: "fb-1",
      project_id: 10,
      body: "Prefer integration tests",
      sentiment: "positive",
      observed_at: "2026-05-13T10:00:00Z",
    });
    if (item.kind !== "Feedback") throw new Error("expected Feedback");
    expect(item.sentiment).toBe("positive");
    const bad = nodeToMemoryItem("Feedback", { id: "fb-2", project_id: 10, body: "x", sentiment: "weird" });
    if (bad.kind !== "Feedback") throw new Error("expected Feedback");
    expect(bad.sentiment).toBeUndefined();
  });
});

describe("buildMemoryWrap + extractMemoryWrap round trip", () => {
  test("wrap is syntactically parseable", () => {
    const wrap = buildMemoryWrap("Entity", { name: "x", entity_kind: "y" });
    const parsed = extractMemoryWrap(wrap);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("Entity");
    expect(parsed!.body).toContain("name: x");
  });

  test("returns null for non-memory text", () => {
    expect(extractMemoryWrap("just a string")).toBeNull();
  });

  test("empty fields are omitted, not rendered as empty lines", () => {
    const wrap = buildMemoryWrap("Decision", { summary: "ok", decided_at: undefined, source_excerpt: null });
    expect(wrap).toContain("summary: ok");
    expect(wrap).not.toContain("decided_at:");
    expect(wrap).not.toContain("source_excerpt:");
  });
});
