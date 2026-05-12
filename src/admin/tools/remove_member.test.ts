import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { registerUser } from "./register_user";
import { createProject } from "./create_project";
import { addMember } from "./add_member";
import { removeMember } from "./remove_member";
import { AdminToolError } from "../errors";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  registerUser({ username: "g" }, adminCtx, db);
  createProject({ slug: "team", display_name: "Team" }, adminCtx, db);
  return db;
}

describe("removeMember", () => {
  test("happy path: returns tokens_revoked count", () => {
    const db = seededDb();
    addMember({ username: "g", project_slug: "team", role: "member" }, adminCtx, db);
    const res = removeMember({ username: "g", project_slug: "team" }, adminCtx, db);
    expect(res.removed).toBe(true);
    expect(res.tokens_revoked).toBe(1);
  });

  test("removing last control admin refuses", () => {
    const db = seededDb();
    let err: unknown;
    try {
      removeMember({ username: "admin", project_slug: "_control_" }, adminCtx, db);
    } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("cannot_remove_last_control_admin");
  });

  test("not_found for unknown membership", () => {
    const db = seededDb();
    let err: unknown;
    try {
      removeMember({ username: "g", project_slug: "team" }, adminCtx, db);
    } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("not_found");
  });
});
