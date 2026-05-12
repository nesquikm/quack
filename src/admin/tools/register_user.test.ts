import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { registerUser } from "./register_user";
import { BASE64URL_TOKEN_PATTERN, hashToken, constantTimeEqual } from "../../auth/tokens";
import { AdminToolError } from "../errors";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("registerUser", () => {
  test("happy path: returns user DTO + 43-char base64url plaintext token", () => {
    const db = seededDb();
    const result = registerUser({ username: "alice" }, adminCtx, db);
    expect(result.user.username).toBe("alice");
    expect(result.user.role).toBe("member");
    expect(result.token.length).toBe(43);
    expect(BASE64URL_TOKEN_PATTERN.test(result.token)).toBe(true);
  });

  test("creates token row whose hash matches plaintext", () => {
    const db = seededDb();
    const { token } = registerUser({ username: "bob" }, adminCtx, db);
    const row = db
      .query<{ token_hash: Uint8Array }, [string]>(
        "SELECT t.token_hash FROM tokens t JOIN users u ON u.id = t.user_id WHERE u.username = ?",
      )
      .get("bob");
    expect(constantTimeEqual(new Uint8Array(row!.token_hash), hashToken(token))).toBe(true);
  });

  test("creates user with _control_ membership", () => {
    const db = seededDb();
    registerUser({ username: "carol" }, adminCtx, db);
    const member = db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) as c FROM project_members m
         JOIN users u ON u.id = m.user_id
         JOIN projects p ON p.id = m.project_id
         WHERE u.username = 'carol' AND p.slug = '_control_'`,
      )
      .get();
    expect(member?.c).toBe(1);
  });

  test("duplicate username throws user_exists", () => {
    const db = seededDb();
    registerUser({ username: "dup" }, adminCtx, db);
    expect(() => registerUser({ username: "dup" }, adminCtx, db)).toThrow(AdminToolError);
  });
});
