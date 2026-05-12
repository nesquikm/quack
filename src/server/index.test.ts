import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../auth/sqlite/schema";
import { bootstrapAdmin } from "../auth/bootstrap";
import { buildFetch, SERVER_VERSION } from "./index";

const BOOTSTRAP_TOKEN = "server-test-bootstrap";

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  bootstrapAdmin(db, { QUACK_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
  return db;
}

function get(path: string): Request {
  return new Request(`http://127.0.0.1${path}`, { method: "GET" });
}
function post(path: string, token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://127.0.0.1${path}`, { method: "POST", headers });
}

describe("HTTP server fetch handler", () => {
  test("GET /health returns 200 without auth", async () => {
    const fetch = buildFetch({ db: seededDb() });
    const res = await fetch(get("/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, version: SERVER_VERSION });
  });

  test("POST /ingest without token returns 401", async () => {
    const fetch = buildFetch({ db: seededDb() });
    const res = await fetch(post("/ingest"));
    expect(res.status).toBe(401);
  });

  test("POST /ingest with valid token returns 204", async () => {
    const fetch = buildFetch({ db: seededDb() });
    const res = await fetch(post("/ingest", BOOTSTRAP_TOKEN));
    expect(res.status).toBe(204);
  });

  test("POST /mcp without token returns 401", async () => {
    const fetch = buildFetch({ db: seededDb() });
    const res = await fetch(post("/mcp"));
    expect(res.status).toBe(401);
  });

  test("POST /mcp with valid token (no handler) returns 204", async () => {
    const fetch = buildFetch({ db: seededDb() });
    const res = await fetch(post("/mcp", BOOTSTRAP_TOKEN));
    expect(res.status).toBe(204);
  });

  test("POST /mcp with revoked token returns 401", async () => {
    const db = seededDb();
    db.run("UPDATE tokens SET revoked_at = datetime('now')");
    const fetch = buildFetch({ db });
    const res = await fetch(post("/mcp", BOOTSTRAP_TOKEN));
    expect(res.status).toBe(401);
  });

  test("unknown route returns 404", async () => {
    const fetch = buildFetch({ db: seededDb() });
    const res = await fetch(new Request("http://127.0.0.1/nope", { method: "POST", headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` } }));
    expect(res.status).toBe(404);
  });
});

