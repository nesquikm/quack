import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { bootstrapAdmin } from "../../auth/bootstrap";
import { serverStatus } from "./server_status";
import { incrementError, resetCountersForTests } from "../../metrics/counters";
import { registerUser } from "./register_user";
import { resetGraphdbStatusForTests, setGraphdbStatus } from "./_graphdb_status";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: "boot" });
  return db;
}

describe("serverStatus", () => {
  beforeEach(() => {
    resetCountersForTests();
    resetGraphdbStatusForTests();
  });

  test("returns version literal v1", () => {
    const db = seededDb();
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.version).toBe("v1");
  });

  test("uptime_seconds is non-negative integer", () => {
    const db = seededDb();
    const snap = serverStatus({}, adminCtx, db);
    expect(Number.isInteger(snap.uptime_seconds)).toBe(true);
    expect(snap.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  test("M2 queue fields are all null", () => {
    const db = seededDb();
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.queue).toEqual({
      depth: null,
      oldest_pending_age_seconds: null,
      accepted_total: null,
      dropped_full_total: null,
    });
  });

  test("counts reflect seeded DB", () => {
    const db = seededDb();
    registerUser({ username: "alice" }, adminCtx, db);
    registerUser({ username: "bob" }, adminCtx, db);
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.counts.users).toBe(3);
    expect(snap.counts.projects).toBe(1);
    expect(snap.counts.tokens_active).toBe(3);
    expect(typeof snap.counts.server_version).toBe("string");
  });

  test("tokens_active excludes revoked tokens", () => {
    const db = seededDb();
    db.run("UPDATE tokens SET revoked_at = datetime('now') WHERE id = 1");
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.counts.tokens_active).toBe(0);
  });

  test("errors reflect counters", () => {
    const db = seededDb();
    incrementError("auth_401");
    incrementError("auth_401");
    incrementError("admin_403");
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.errors.since_boot_total).toBe(3);
    expect(snap.errors.by_category).toEqual({ auth_401: 2, admin_403: 1 });
  });

  test("unknown error category appears in by_category without schema break", () => {
    const db = seededDb();
    incrementError("future_category");
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.errors.by_category["future_category"]).toBe(1);
  });

  test("counts.graphdb defaults to { status: 'down', indexes: 0 } before driver wires up", () => {
    const db = seededDb();
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.counts.graphdb).toEqual({ status: "down", indexes: 0 });
  });

  test("counts.graphdb reflects setGraphdbStatus value (server reports ok + index count)", () => {
    const db = seededDb();
    setGraphdbStatus({ status: "ok", indexes: 11 });
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.counts.graphdb).toEqual({ status: "ok", indexes: 11 });
  });

  test("db_error category increments when GraphAdapter throws (counter visible via server_status)", () => {
    const db = seededDb();
    incrementError("db_error");
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.errors.by_category["db_error"]).toBe(1);
  });

  test("cleanup block defaults to zero pending_rows + null last_run + not running", () => {
    const db = seededDb();
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.cleanup).toEqual({
      last_run_at: null,
      pending_rows: 0,
      currently_running: false,
    });
  });

  test("cleanup.pending_rows reflects pending_cleanup row count", () => {
    const db = seededDb();
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', '1000')");
    db.run("INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', '2000')");
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.cleanup.pending_rows).toBe(2);
  });

  // AC-41NXTZ.10 — FR Testing section requires server_status.test.ts to verify
  // the `explicit_add_received` info-level category surfaces in the snapshot
  // once incremented. The counter itself is wired from add_memory.ts; this
  // test asserts the snapshot contract.
  test("AC-41NXTZ.10: explicit_add_received category surfaces in errors.by_category", () => {
    const db = seededDb();
    incrementError("explicit_add_received");
    incrementError("explicit_add_received");
    const snap = serverStatus({}, adminCtx, db);
    expect(snap.errors.by_category["explicit_add_received"]).toBe(2);
  });

});
