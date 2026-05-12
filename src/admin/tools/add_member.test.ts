import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { registerUser } from "./register_user";
import { createProject } from "./create_project";
import { addMember } from "./add_member";
import { BASE64URL_TOKEN_PATTERN } from "../../auth/tokens";
import { AdminToolError } from "../errors";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  registerUser({ username: "fred" }, adminCtx, db);
  createProject({ slug: "team", display_name: "Team" }, adminCtx, db);
  return db;
}

describe("addMember", () => {
  test("happy path: returns plaintext token + membership", () => {
    const db = seededDb();
    const result = addMember({ username: "fred", project_slug: "team", role: "member" }, adminCtx, db);
    expect(result.membership.role).toBe("member");
    expect(result.token.length).toBe(43);
    expect(BASE64URL_TOKEN_PATTERN.test(result.token)).toBe(true);
  });

  test("duplicate membership throws already_member", () => {
    const db = seededDb();
    addMember({ username: "fred", project_slug: "team", role: "member" }, adminCtx, db);
    let err: unknown;
    try {
      addMember({ username: "fred", project_slug: "team", role: "member" }, adminCtx, db);
    } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("already_member");
  });

  test("unknown user → not_found", () => {
    const db = seededDb();
    let err: unknown;
    try {
      addMember({ username: "ghost", project_slug: "team", role: "member" }, adminCtx, db);
    } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("not_found");
  });

  test("unknown project → not_found", () => {
    const db = seededDb();
    let err: unknown;
    try {
      addMember({ username: "fred", project_slug: "nope", role: "member" }, adminCtx, db);
    } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("not_found");
  });
});
