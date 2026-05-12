import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { registerUser } from "./register_user";
import { removeUser } from "./remove_user";
import { AdminToolError } from "../errors";

// Note: the dispatch gate (src/mcp/gate.ts) enforces ctx.role === 'admin' before
// the handler runs. These tests pass an admin ctx directly to exercise the
// handler's internal refusal paths.

function adminCtxFromDb(db: Database) {
  const row = db.query<{ id: number; project_id: number }, []>(
    "SELECT u.id as id, m.project_id as project_id FROM users u JOIN project_members m ON m.user_id = u.id WHERE u.role = 'admin' LIMIT 1",
  ).get()!;
  return { user_id: row.id, project_id: row.project_id, role: "admin" as const };
}

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("removeUser", () => {
  test("cascades to project_members and tokens", () => {
    const db = seededDb();
    const ctx = adminCtxFromDb(db);
    registerUser({ username: "eve" }, ctx, db);
    const eve = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='eve'").get()!;

    removeUser({ username: "eve" }, ctx, db);

    const userRow = db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM users WHERE username = ?").get("eve");
    expect(userRow?.c).toBe(0);
    const memberCount = db.query<{ c: number }, [number]>("SELECT COUNT(*) as c FROM project_members WHERE user_id = ?").get(eve.id);
    expect(memberCount?.c).toBe(0);
    const tokenCount = db.query<{ c: number }, [number]>("SELECT COUNT(*) as c FROM tokens WHERE user_id = ?").get(eve.id);
    expect(tokenCount?.c).toBe(0);
  });

  test("refuses to remove the last admin (different caller than target)", () => {
    const db = seededDb();
    // Caller is admin role but a different user_id than the bootstrap admin.
    // The handler's self-check is `user.id === ctx.user_id`, so a different
    // caller_id bypasses cannot_remove_self and exposes the cannot_remove_last_admin
    // refusal — the bootstrap admin is the sole admin row.
    const otherAdminCtx = { user_id: 9999, project_id: 1, role: "admin" as const };
    let err: unknown;
    try { removeUser({ username: "admin" }, otherAdminCtx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("cannot_remove_last_admin");
  });

  test("refuses to remove self", () => {
    const db = seededDb();
    const ctx = adminCtxFromDb(db);
    let err: unknown;
    try { removeUser({ username: "admin" }, ctx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("cannot_remove_self");
  });

  test("not_found for unknown user", () => {
    const db = seededDb();
    const ctx = adminCtxFromDb(db);
    let err: unknown;
    try { removeUser({ username: "ghost" }, ctx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("not_found");
  });
});
