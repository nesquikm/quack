import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./schema";

function freshDb(): Database {
  return new Database(":memory:");
}

describe("runMigrations", () => {
  test("creates v1 schema on a fresh DB", () => {
    const db = freshDb();
    runMigrations(db);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("projects");
    expect(tables).toContain("project_members");
    expect(tables).toContain("tokens");
    expect(tables).toContain("pending_cleanup");
    expect(tables).toContain("_migrations");
  });

  test("idempotent: re-running adds no rows", () => {
    const db = freshDb();
    runMigrations(db);
    const before = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM _migrations").get()?.c ?? 0;
    runMigrations(db);
    const after = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM _migrations").get()?.c ?? 0;
    expect(after).toBe(before);
  });

  test("creates idx_tokens_hash_active partial index", () => {
    const db = freshDb();
    runMigrations(db);
    const idx = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tokens_hash_active'")
      .get();
    expect(idx?.name).toBe("idx_tokens_hash_active");
  });

  test("foreign keys are on", () => {
    const db = freshDb();
    runMigrations(db);
    const row = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
    expect(row?.foreign_keys).toBe(1);
  });
});

describe("runMigrations — v2 (FR-EDXH3X)", () => {
  test("adds fail_count column with default 0", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(pending_cleanup)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "fail_count")).toBe(true);
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', '42')");
    const row = db
      .query<{ fail_count: number }, []>("SELECT fail_count FROM pending_cleanup")
      .get();
    expect(row?.fail_count).toBe(0);
  });

  test("translates pre-M3 slug-based refs into project_id", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO projects(id, slug, display_name) VALUES (777, 'preexisting', 'P')");
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', 'preexisting')");
    // Force replay of v2.
    db.run("DELETE FROM _migrations WHERE version = 2");
    runMigrations(db);
    const row = db
      .query<{ ref: string }, []>("SELECT ref FROM pending_cleanup WHERE kind = 'project_graph_partition'")
      .get();
    expect(row?.ref).toBe("777");
  });

  test("drops orphan slug rows whose project is gone", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', 'long-gone-project')");
    db.run("DELETE FROM _migrations WHERE version = 2");
    runMigrations(db);
    const row = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM pending_cleanup WHERE kind = 'project_graph_partition'",
      )
      .get();
    expect(row?.c).toBe(0);
  });

  test("numeric-ref rows untouched (idempotency)", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO projects(id, slug, display_name) VALUES (888, 'eight-eight', '8')");
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', '888')");
    runMigrations(db);
    const row = db
      .query<{ ref: string }, []>("SELECT ref FROM pending_cleanup WHERE kind = 'project_graph_partition'")
      .get();
    expect(row?.ref).toBe("888");
  });
});
