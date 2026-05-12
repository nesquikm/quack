import { Database } from "bun:sqlite";

const SCHEMA_V1_DDL = `
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_members (
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY,
  token_hash  BLOB NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tokens_hash_active ON tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pending_cleanup (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  queued_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function runMigrations(db: Database): void {
  db.run("PRAGMA foreign_keys = ON;");
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const row = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM _migrations WHERE version = 1").get();
    if ((row?.c ?? 0) === 0) {
      for (const stmt of SCHEMA_V1_DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
        db.run(stmt);
      }
      db.run("INSERT INTO _migrations(version) VALUES (1)");
    }
  })();
}

export function openAuthDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}
