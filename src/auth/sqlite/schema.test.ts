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
    runMigrations(db);
    const row = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM _migrations").get();
    expect(row?.c).toBe(1);
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
