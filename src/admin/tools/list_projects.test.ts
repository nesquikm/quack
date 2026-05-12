import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { registerUser } from "./register_user";
import { createProject } from "./create_project";
import { addMember } from "./add_member";
import { listProjects } from "./list_projects";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  createProject({ slug: "alpha", display_name: "Alpha" }, adminCtx, db);
  createProject({ slug: "beta", display_name: "Beta" }, adminCtx, db);
  return db;
}

describe("listProjects", () => {
  test("admin sees all projects", () => {
    const db = seededDb();
    const { projects } = listProjects({}, adminCtx, db);
    const slugs = projects.map((p) => p.slug);
    expect(slugs).toContain("_control_");
    expect(slugs).toContain("alpha");
    expect(slugs).toContain("beta");
  });

  test("member sees only their projects", () => {
    const db = seededDb();
    registerUser({ username: "u" }, adminCtx, db);
    addMember({ username: "u", project_slug: "alpha", role: "member" }, adminCtx, db);
    const uRow = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='u'").get()!;
    const memberCtx = { user_id: uRow.id, project_id: 1, role: "member" as const };
    const { projects } = listProjects({}, memberCtx, db);
    const slugs = projects.map((p) => p.slug).sort();
    expect(slugs).toContain("_control_");
    expect(slugs).toContain("alpha");
    expect(slugs).not.toContain("beta");
  });

  test("project DTO has no token data", () => {
    const db = seededDb();
    const { projects } = listProjects({}, adminCtx, db);
    for (const p of projects) {
      expect((p as unknown as Record<string, unknown>).token_hash).toBeUndefined();
      expect((p as unknown as Record<string, unknown>).revoked_at).toBeUndefined();
    }
  });
});
