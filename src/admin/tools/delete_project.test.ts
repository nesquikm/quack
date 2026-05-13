import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { createProject } from "./create_project";
import { deleteProject } from "./delete_project";
import { AdminToolError } from "../errors";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("deleteProject", () => {
  test("happy path: deletes project and queues pending_cleanup with numeric ref (project_id)", () => {
    const db = seededDb();
    const created = createProject({ slug: "tempproj", display_name: "Temp" }, adminCtx, db);
    const res = deleteProject({ slug: "tempproj" }, adminCtx, db);
    expect(res.deleted).toBe(true);
    expect(typeof res.cleanup_queued).toBe("number");

    const projectRow = db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM projects WHERE slug = ?").get("tempproj");
    expect(projectRow?.c).toBe(0);
    const cleanup = db.query<{ kind: string; ref: string; fail_count: number }, []>(
      "SELECT kind, ref, fail_count FROM pending_cleanup",
    ).get();
    expect(cleanup?.kind).toBe("project_graph_partition");
    // FR-EDXH3X AC.1: ref is the integer project_id as a string.
    expect(cleanup?.ref).toBe(String(created.project.id));
    expect(/^[0-9]+$/.test(cleanup?.ref ?? "")).toBe(true);
    expect(cleanup?.fail_count).toBe(0);
  });

  test("refuses to delete _control_", () => {
    const db = seededDb();
    let err: unknown;
    try { deleteProject({ slug: "_control_" }, adminCtx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("reserved_project");
  });

  test("not_found for unknown slug", () => {
    const db = seededDb();
    let err: unknown;
    try { deleteProject({ slug: "nope" }, adminCtx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("not_found");
  });
});
