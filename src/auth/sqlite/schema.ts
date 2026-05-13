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
    // v2 (FR-EDXH3X): add fail_count column to pending_cleanup; translate
    // pre-M3 slug-based refs into project_id (numeric); drop orphan rows
    // whose project no longer exists. Idempotent — guarded by _migrations.
    const v2 = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM _migrations WHERE version = 2")
      .get();
    if ((v2?.c ?? 0) === 0) {
      // ADD COLUMN — SQLite tolerates a redundant attempt only if we guard
      // with PRAGMA table_info; check first.
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(pending_cleanup)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "fail_count")) {
        db.run("ALTER TABLE pending_cleanup ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0");
      }
      // Translate non-numeric refs (slugs) → project_id where the project
      // still exists. The slug index keeps the lookup cheap.
      db.run(
        `UPDATE pending_cleanup
         SET ref = (SELECT CAST(p.id AS TEXT) FROM projects p WHERE p.slug = pending_cleanup.ref)
         WHERE kind = 'project_graph_partition'
           AND ref NOT GLOB '[0-9]*'
           AND ref IN (SELECT slug FROM projects)`,
      );
      // Drop refs that didn't resolve — the project is gone, the graph data
      // is orphaned beyond rescue, and the row would block the sweeper.
      db.run(
        `DELETE FROM pending_cleanup
         WHERE kind = 'project_graph_partition' AND ref NOT GLOB '[0-9]*'`,
      );
      db.run("INSERT INTO _migrations(version) VALUES (2)");
    }
  })();
}

export function openAuthDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}
