import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./sqlite/schema";
import { bootstrapAdmin, BootstrapError, CONTROL_PROJECT_SLUG } from "./bootstrap";
import { hashToken, constantTimeEqual } from "./tokens";

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("bootstrapAdmin", () => {
  test("first boot creates admin user + _control_ project + membership + token", () => {
    const db = freshDb();
    bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "secret-bootstrap-token" });

    const users = db.query<{ username: string; role: string }, []>("SELECT username, role FROM users").all();
    expect(users.length).toBe(1);
    expect(users[0]).toEqual({ username: "admin", role: "admin" });

    const projects = db
      .query<{ slug: string; display_name: string }, []>("SELECT slug, display_name FROM projects")
      .all();
    expect(projects.length).toBe(1);
    expect(projects[0]?.slug).toBe(CONTROL_PROJECT_SLUG);
    expect(projects[0]?.display_name).toBe("Control Plane");

    const members = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM project_members").get();
    expect(members?.c).toBe(1);

    const tokenRow = db.query<{ token_hash: Uint8Array }, []>("SELECT token_hash FROM tokens").get();
    expect(tokenRow).toBeDefined();
    expect(constantTimeEqual(new Uint8Array(tokenRow!.token_hash), hashToken("secret-bootstrap-token"))).toBe(true);
  });

  test("second boot is a no-op (env var ignored when users exist)", () => {
    const db = freshDb();
    bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "first-token" });
    bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "different-token" });

    const users = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM users").get();
    expect(users?.c).toBe(1);

    const tokens = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM tokens").get();
    expect(tokens?.c).toBe(1);
  });

  test("first boot with missing env var throws BootstrapError", () => {
    const db = freshDb();
    expect(() => bootstrapAdmin(db, {})).toThrow(BootstrapError);
  });
});
