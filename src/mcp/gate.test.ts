import { describe, test, expect, beforeEach } from "bun:test";
import { applyAdminGate, ForbiddenError } from "./gate";
import { ADMIN_TOOLS } from "../admin/index";
import { resetCountersForTests, getSnapshot } from "../metrics/counters";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };
const memberCtx = { user_id: 2, project_id: 1, role: "member" as const };

describe("applyAdminGate", () => {
  beforeEach(() => resetCountersForTests());

  test("non-admin invoking every admin tool throws ForbiddenError", () => {
    for (const toolName of ADMIN_TOOLS) {
      let err: unknown;
      try { applyAdminGate(toolName, memberCtx); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ForbiddenError);
    }
  });

  test("admin passes every admin tool gate", () => {
    for (const toolName of ADMIN_TOOLS) {
      expect(() => applyAdminGate(toolName, adminCtx)).not.toThrow();
    }
  });

  test("member passes non-admin tool gate (list_projects)", () => {
    expect(() => applyAdminGate("list_projects", memberCtx)).not.toThrow();
  });

  test("each forbidden call increments admin_403 once", () => {
    resetCountersForTests();
    try { applyAdminGate("register_user", memberCtx); } catch { /* expected */ }
    try { applyAdminGate("remove_user", memberCtx); } catch { /* expected */ }
    expect(getSnapshot().errors.by_category["admin_403"]).toBe(2);
  });

  test("admin invocation does NOT increment admin_403", () => {
    resetCountersForTests();
    applyAdminGate("register_user", adminCtx);
    expect(getSnapshot().errors.by_category["admin_403"]).toBeUndefined();
  });
});
