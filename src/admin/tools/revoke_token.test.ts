import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { registerUser } from "./register_user";
import { revokeToken } from "./revoke_token";
import { AdminToolError } from "../errors";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("revokeToken", () => {
  test("revokes an active token", () => {
    const db = seededDb();
    registerUser({ username: "h" }, adminCtx, db);
    const row = db.query<{ id: number }, []>("SELECT id FROM tokens WHERE id != 1").get()!;
    const res = revokeToken({ token_id: row.id }, adminCtx, db);
    expect(res.revoked).toBe(true);
    const after = db.query<{ revoked_at: string | null }, [number]>("SELECT revoked_at FROM tokens WHERE id = ?").get(row.id);
    expect(after?.revoked_at).not.toBeNull();
  });

  test("unknown token id → not_found", () => {
    const db = seededDb();
    let err: unknown;
    try { revokeToken({ token_id: 99999 }, adminCtx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("not_found");
  });

  test("already-revoked → not_found (uniform anti-oracle)", () => {
    const db = seededDb();
    registerUser({ username: "h" }, adminCtx, db);
    const row = db.query<{ id: number }, []>("SELECT id FROM tokens WHERE id != 1").get()!;
    revokeToken({ token_id: row.id }, adminCtx, db);
    let err: unknown;
    try { revokeToken({ token_id: row.id }, adminCtx, db); } catch (e) { err = e; }
    expect((err as AdminToolError).code).toBe("not_found");
  });
});
