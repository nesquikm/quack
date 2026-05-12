import type { Database, Statement } from "bun:sqlite";
import { hashToken } from "./tokens";
import { incrementError } from "../metrics/counters";

export interface AuthContext {
  user_id: number;
  project_id: number;
  role: "admin" | "member";
}

export const UNAUTHORIZED_BODY = JSON.stringify({ error: "unauthorized" });

interface Row {
  user_id: number;
  project_id: number;
  role: "admin" | "member";
}

const stmtCache = new WeakMap<Database, Statement<Row, [Uint8Array]>>();

function getStmt(db: Database): Statement<Row, [Uint8Array]> {
  let stmt = stmtCache.get(db);
  if (!stmt) {
    stmt = db.query<Row, [Uint8Array]>(
      `SELECT t.user_id as user_id, t.project_id as project_id, u.role as role
       FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL
       LIMIT 1`,
    );
    stmtCache.set(db, stmt);
  }
  return stmt;
}

function parseBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(\S+)$/);
  return m ? m[1]! : null;
}

export function authenticate(request: Request, db: Database): AuthContext | null {
  const plaintext = parseBearer(request.headers.get("authorization"));
  if (!plaintext) {
    incrementError("auth_401");
    return null;
  }
  const hash = hashToken(plaintext);
  const row = getStmt(db).get(hash);
  if (!row) {
    incrementError("auth_401");
    return null;
  }
  return { user_id: row.user_id, project_id: row.project_id, role: row.role };
}

export function unauthorizedResponse(): Response {
  return new Response(UNAUTHORIZED_BODY, {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
