import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./sqlite/schema";
import { bootstrapAdmin } from "./bootstrap";
import { authenticate, unauthorizedResponse, UNAUTHORIZED_BODY } from "./middleware";
import { resetCountersForTests, getSnapshot } from "../metrics/counters";

const BOOTSTRAP_TOKEN = "test-bootstrap-token-abc";

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
  return db;
}

function authHeaderRequest(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("authorization", value);
  return new Request("http://127.0.0.1/mcp", { method: "POST", headers });
}

describe("authenticate", () => {
  beforeEach(() => resetCountersForTests());

  test("happy path: valid bearer resolves to AuthContext", () => {
    const db = seededDb();
    const req = authHeaderRequest(`Bearer ${BOOTSTRAP_TOKEN}`);
    const ctx = authenticate(req, db);
    expect(ctx).not.toBeNull();
    expect(ctx?.role).toBe("admin");
    expect(typeof ctx?.user_id).toBe("number");
    expect(typeof ctx?.project_id).toBe("number");
  });

  test("missing Authorization header returns null", () => {
    const db = seededDb();
    expect(authenticate(authHeaderRequest(null), db)).toBeNull();
  });

  test("malformed Authorization (no Bearer prefix) returns null", () => {
    const db = seededDb();
    expect(authenticate(authHeaderRequest(BOOTSTRAP_TOKEN), db)).toBeNull();
    expect(authenticate(authHeaderRequest("Basic dXNlcjpwYXNz"), db)).toBeNull();
  });

  test("unknown token returns null", () => {
    const db = seededDb();
    expect(authenticate(authHeaderRequest("Bearer not-a-real-token"), db)).toBeNull();
  });

  test("revoked token returns null", () => {
    const db = seededDb();
    db.run("UPDATE tokens SET revoked_at = datetime('now')");
    expect(authenticate(authHeaderRequest(`Bearer ${BOOTSTRAP_TOKEN}`), db)).toBeNull();
  });

  test("401 body is byte-identical across all failure modes", async () => {
    const db = seededDb();

    const bodies: string[] = [];
    for (const header of [null, BOOTSTRAP_TOKEN, "Bearer wrong-token"]) {
      if (authenticate(authHeaderRequest(header), db) === null) {
        bodies.push(await unauthorizedResponse().text());
      }
    }
    db.run("UPDATE tokens SET revoked_at = datetime('now')");
    if (authenticate(authHeaderRequest(`Bearer ${BOOTSTRAP_TOKEN}`), db) === null) {
      bodies.push(await unauthorizedResponse().text());
    }

    expect(bodies.length).toBe(4);
    for (const body of bodies) {
      expect(body).toBe(UNAUTHORIZED_BODY);
    }
  });

  test("each 401 path increments auth_401 counter", () => {
    const db = seededDb();
    resetCountersForTests();
    authenticate(authHeaderRequest(null), db);
    authenticate(authHeaderRequest("Bearer wrong"), db);
    const snap = getSnapshot();
    expect(snap.errors.by_category["auth_401"]).toBe(2);
  });
});
