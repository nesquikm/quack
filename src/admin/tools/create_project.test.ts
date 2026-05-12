import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { createProject, createProjectSchema } from "./create_project";
import { AdminToolError } from "../errors";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("createProject", () => {
  test("happy path: returns ProjectDto without token data", () => {
    const db = seededDb();
    const { project } = createProject({ slug: "alpha", display_name: "Alpha" }, adminCtx, db);
    expect(project.slug).toBe("alpha");
    expect(project.display_name).toBe("Alpha");
    expect((project as unknown as Record<string, unknown>).token_hash).toBeUndefined();
  });

  test("duplicate slug throws project_exists", () => {
    const db = seededDb();
    createProject({ slug: "dup", display_name: "Dup" }, adminCtx, db);
    let err: unknown;
    try { createProject({ slug: "dup", display_name: "Dup2" }, adminCtx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("project_exists");
  });

  test("reserved slug starting with _ throws reserved_slug (handler-level)", () => {
    const db = seededDb();
    // Schema regex doesn't allow leading `_`, so the handler must also defend.
    let err: unknown;
    try {
      createProject({ slug: "_secret", display_name: "x" }, adminCtx, db);
    } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("reserved_slug");
  });

  test("invalid slug regex fails at schema parse", () => {
    expect(() => createProjectSchema.parse({ slug: "Bad-Slug", display_name: "x" })).toThrow();
    expect(() => createProjectSchema.parse({ slug: "-bad", display_name: "x" })).toThrow();
    expect(() => createProjectSchema.parse({ slug: "a".repeat(64), display_name: "x" })).toThrow();
  });
});
