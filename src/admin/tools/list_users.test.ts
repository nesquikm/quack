import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { registerUser } from "./register_user";
import { listUsers } from "./list_users";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("listUsers", () => {
  test("returns all users with DTO shape (no token data)", () => {
    const db = seededDb();
    registerUser({ username: "alice" }, adminCtx, db);
    const { users } = listUsers({}, adminCtx, db);
    expect(users.length).toBe(2);
    for (const u of users) {
      expect((u as unknown as Record<string, unknown>).token_hash).toBeUndefined();
    }
  });
});
