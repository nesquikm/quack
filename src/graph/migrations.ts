import type { Driver } from "neo4j-driver";

// v1 index DDL — single, immutable, idempotent set. Each statement uses
// `IF NOT EXISTS`. Re-running on an existing graph is a no-op (`SHOW INDEXES`
// count unchanged).
export const V1_INDEX_DDL: readonly string[] = [
  // (label, project_id) composite indexes for fast project-scoped scans:
  "CREATE INDEX entity_project_id   IF NOT EXISTS FOR (n:Entity)   ON (n.project_id)",
  "CREATE INDEX decision_project_id IF NOT EXISTS FOR (n:Decision) ON (n.project_id)",
  "CREATE INDEX file_project_id     IF NOT EXISTS FOR (n:File)     ON (n.project_id)",
  "CREATE INDEX symbol_project_id   IF NOT EXISTS FOR (n:Symbol)   ON (n.project_id)",
  "CREATE INDEX feedback_project_id IF NOT EXISTS FOR (n:Feedback) ON (n.project_id)",
  // id indexes (per-label id lookup):
  "CREATE INDEX entity_id   IF NOT EXISTS FOR (n:Entity)   ON (n.id)",
  "CREATE INDEX decision_id IF NOT EXISTS FOR (n:Decision) ON (n.id)",
  "CREATE INDEX file_id     IF NOT EXISTS FOR (n:File)     ON (n.id)",
  "CREATE INDEX symbol_id   IF NOT EXISTS FOR (n:Symbol)   ON (n.id)",
  "CREATE INDEX feedback_id IF NOT EXISTS FOR (n:Feedback) ON (n.id)",
  // entity name full-text index:
  "CREATE FULLTEXT INDEX entity_name_fts IF NOT EXISTS FOR (n:Entity) ON EACH [n.name]",
];

export async function runMigrations(driver: Driver): Promise<void> {
  const session = driver.session({ database: "neo4j" });
  try {
    for (const ddl of V1_INDEX_DDL) {
      await session.run(ddl);
    }
  } finally {
    await session.close();
  }
}

export async function countIndexes(driver: Driver): Promise<number> {
  const session = driver.session({ database: "neo4j" });
  try {
    const res = await session.run("SHOW INDEXES YIELD name RETURN count(*) AS c");
    const rec = res.records[0];
    if (!rec) return 0;
    const c = rec.get("c");
    return typeof c === "number" ? c : Number(c);
  } finally {
    await session.close();
  }
}
