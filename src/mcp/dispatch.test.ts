import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../auth/sqlite/schema";
import { bootstrapAdmin } from "../auth/bootstrap";
import { buildToolRegistry } from "./registry";
import { dispatchTool } from "./dispatch";
import { ADMIN_TOOLS } from "../admin/index";
import { resetCountersForTests, getSnapshot } from "../metrics/counters";

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot-token" });
  return db;
}

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };
const memberCtx = { user_id: 2, project_id: 1, role: "member" as const };

describe("dispatchTool admin gate", () => {
  beforeEach(() => resetCountersForTests());

  test("non-admin invoking admin tool gets 403 forbidden", () => {
    const db = seededDb();
    const tools = buildToolRegistry();
    for (const toolName of ADMIN_TOOLS) {
      const res = dispatchTool(tools, toolName, {}, memberCtx, db);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "forbidden" });
    }
  });

  test("admin invoking admin tool passes gate", () => {
    const db = seededDb();
    const tools = buildToolRegistry();
    const res = dispatchTool(tools, "list_users", {}, adminCtx, db);
    expect(res.ok).toBe(true);
  });

  test("member invoking non-admin tool (list_projects) passes gate", () => {
    const db = seededDb();
    const tools = buildToolRegistry();
    const res = dispatchTool(tools, "list_projects", {}, memberCtx, db);
    expect(res.ok).toBe(true);
  });

  test("invalid args produce invalid_args error", () => {
    const db = seededDb();
    const tools = buildToolRegistry();
    const res = dispatchTool(tools, "register_user", {}, adminCtx, db);
    expect(res.ok).toBe(false);
    expect((res.body as { error: string }).error).toBe("invalid_args");
  });

  test("unknown tool returns unknown_tool", () => {
    const db = seededDb();
    const tools = buildToolRegistry();
    const res = dispatchTool(tools, "no_such_tool", {}, adminCtx, db);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  test("each 403 increments admin_403 counter", () => {
    const db = seededDb();
    const tools = buildToolRegistry();
    resetCountersForTests();
    dispatchTool(tools, "register_user", { username: "x" }, memberCtx, db);
    dispatchTool(tools, "remove_user", { username: "x" }, memberCtx, db);
    expect(getSnapshot().errors.by_category["admin_403"]).toBe(2);
  });
});
