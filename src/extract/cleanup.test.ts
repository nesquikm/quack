import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import neo4j, { type Driver } from "neo4j-driver";
import { Database } from "bun:sqlite";
import { dockerAvailable, spawnNeo4j, type SpawnedNeo4j } from "../graph/_neo4j_helper";
import { Neo4jGraphAdapter } from "../graph/adapter";
import { runMigrations as runAuthMigrations } from "../auth/sqlite/schema";
import { runMigrations as runGraphMigrations } from "../graph/migrations";
import { registerCleanupTemplates } from "../graph/templates/cleanup/index";
import { createSweeper } from "./cleanup_sweeper";
import type { AuthContext } from "../auth/middleware";

const PROJECT_A = 3001;
const PROJECT_B = 3002;
const ctxA: AuthContext = { user_id: 0, project_id: PROJECT_A, role: "admin" };

let spawned: SpawnedNeo4j | null = null;
let driver: Driver | null = null;
let adapter: Neo4jGraphAdapter | null = null;
let dockerOk = false;

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  if (!dockerOk) return;
  try {
    spawned = await spawnNeo4j();
  } catch (err) {
    console.warn(`neo4j spawn failed — cleanup e2e will skip: ${String(err)}`);
    dockerOk = false;
    return;
  }
  driver = neo4j.driver(spawned!.url, neo4j.auth.basic(spawned!.user, spawned!.password), {
    maxConnectionPoolSize: 5,
  });
  await runGraphMigrations(driver);
  registerCleanupTemplates();
  adapter = new Neo4jGraphAdapter(driver);
}, 180_000);

afterAll(async () => {
  if (driver) await driver.close();
  if (spawned) await spawned.stop();
});

async function seedNodes(projectId: number, count: number): Promise<void> {
  if (!driver) return;
  const session = driver.session({ database: "neo4j" });
  try {
    await session.run(
      `UNWIND range(1, $count) AS i CREATE (e:Entity {project_id: $pid, id: toString(i), name: 'n' + toString(i)})`,
      { pid: neo4j.int(projectId), count: neo4j.int(count) },
    );
  } finally {
    await session.close();
  }
}

async function countNodes(projectId: number): Promise<number> {
  if (!driver) return 0;
  const session = driver.session({ database: "neo4j" });
  try {
    const out = await session.run(`MATCH (n {project_id: $pid}) RETURN count(n) AS c`, {
      pid: neo4j.int(projectId),
    });
    const c = out.records[0]?.get("c");
    return typeof c === "number" ? c : Number(c?.toNumber?.() ?? 0);
  } finally {
    await session.close();
  }
}

function seededAuthDb(): Database {
  const db = new Database(":memory:");
  runAuthMigrations(db);
  return db;
}

describe("cleanup sweep e2e (integration)", () => {
  test("skips cleanly when docker is unreachable", () => {
    if (!dockerOk) {
      console.warn("docker daemon unreachable — cleanup e2e skipped");
      expect(true).toBe(true);
      return;
    }
    expect(adapter).not.toBeNull();
  });

  test("delete project A's graph data: 100 nodes seeded, sweeper drains, row removed", async () => {
    if (!dockerOk || !adapter) return;
    const db = seededAuthDb();
    await seedNodes(PROJECT_A, 100);
    expect(await countNodes(PROJECT_A)).toBe(100);

    db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      [String(PROJECT_A)],
    );
    const sweeper = createSweeper({ db, adapter, batchSize: 25, manualMode: true });
    const out = await sweeper.runOnce();
    expect(out.rows_processed).toBe(1);
    expect(out.nodes_deleted).toBe(100);
    expect(await countNodes(PROJECT_A)).toBe(0);
    const remaining = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM pending_cleanup")
      .get();
    expect(remaining?.c).toBe(0);
  });

  test("cross-tenant safety: cleanup of A leaves B's nodes untouched", async () => {
    if (!dockerOk || !adapter) return;
    const db = seededAuthDb();
    await seedNodes(PROJECT_A, 50);
    await seedNodes(PROJECT_B, 30);
    const beforeA = await countNodes(PROJECT_A);
    const beforeB = await countNodes(PROJECT_B);
    expect(beforeA).toBeGreaterThanOrEqual(50);
    expect(beforeB).toBeGreaterThanOrEqual(30);

    db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      [String(PROJECT_A)],
    );
    const sweeper = createSweeper({ db, adapter, batchSize: 1000, manualMode: true });
    await sweeper.runOnce();
    expect(await countNodes(PROJECT_A)).toBe(0);
    expect(await countNodes(PROJECT_B)).toBe(beforeB);
  });

  // Suppress unused-binding warning while keeping the lint-quiet ctx in scope.
  test("auth context type-check (no-op)", () => {
    expect(ctxA.project_id).toBe(PROJECT_A);
  });
});
