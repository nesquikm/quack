import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import neo4j, { type Driver } from "neo4j-driver";
import { dockerAvailable, spawnNeo4j, type SpawnedNeo4j } from "../../../graph/_neo4j_helper";
import { Neo4jGraphAdapter } from "../../../graph/adapter";
import { registerMemoryTemplates } from "../../../graph/templates/memory/index";
import { runMigrations } from "../../../graph/migrations";
import { searchMemory } from "./search_memory";
import { getNeighbors } from "./get_neighbors";
import { pathBetween } from "./path_between";
import { recentDecisions } from "./recent_decisions";
import type { AuthContext } from "../../../auth/middleware";

const ctxA: AuthContext = { user_id: 1, project_id: 1001, role: "admin" };
const ctxB: AuthContext = { user_id: 2, project_id: 2002, role: "admin" };

let spawned: SpawnedNeo4j | null = null;
let driver: Driver | null = null;
let dockerOk = false;
let adapter: Neo4jGraphAdapter | null = null;

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  if (!dockerOk) return;
  try {
    spawned = await spawnNeo4j();
  } catch (err) {
    console.warn(`neo4j spawn failed — memory cross-tenant tests will skip: ${String(err)}`);
    dockerOk = false;
    return;
  }
  driver = neo4j.driver(spawned!.url, neo4j.auth.basic(spawned!.user, spawned!.password), {
    maxConnectionPoolSize: 10,
  });
  await runMigrations(driver);
  registerMemoryTemplates();
  adapter = new Neo4jGraphAdapter(driver);

  // Seed two projects with overlapping entity names + distinct decisions.
  const session = driver.session({ database: "neo4j" });
  try {
    const nowIso = new Date().toISOString();
    await session.run(
      `
      MERGE (a:Entity {project_id: 1001, name: 'auth'})
      ON CREATE SET a.id = 'a-1001', a.kind = 'library', a.created_at = datetime()
      MERGE (b:Entity {project_id: 2002, name: 'auth'})
      ON CREATE SET b.id = 'b-2002', b.kind = 'library', b.created_at = datetime()
      MERGE (na:Entity {project_id: 1001, name: 'paired-A'})
      ON CREATE SET na.id = 'na-1001', na.kind = 'concept', na.created_at = datetime()
      MERGE (nb:Entity {project_id: 2002, name: 'paired-B'})
      ON CREATE SET nb.id = 'nb-2002', nb.kind = 'concept', nb.created_at = datetime()
      MERGE (a)-[:RELATED_TO {created_at: datetime()}]->(na)
      MERGE (b)-[:RELATED_TO {created_at: datetime()}]->(nb)
      MERGE (da:Decision {project_id: 1001, id: 'da'})
      ON CREATE SET da.summary = 'A decision', da.decided_at = $now, da.source_excerpt = 'x'
      MERGE (db:Decision {project_id: 2002, id: 'db'})
      ON CREATE SET db.summary = 'B decision', db.decided_at = $now, db.source_excerpt = 'y'
    `,
      { now: nowIso },
    );
  } finally {
    await session.close();
  }
}, 180_000);

afterAll(async () => {
  if (driver) await driver.close();
  if (spawned) await spawned.stop();
});

describe("memory tools — cross-tenant isolation (integration)", () => {
  test("skips cleanly when docker is unreachable", () => {
    if (!dockerOk) {
      console.warn("docker daemon unreachable — memory cross-tenant tests skipped");
      expect(true).toBe(true);
      return;
    }
    expect(adapter).not.toBeNull();
  });

  test("search_memory: project A sees own 'auth' entity but not project B's", async () => {
    if (!dockerOk || !adapter) return;
    const a = await searchMemory(
      { entities: ["auth"], types: ["Entity"], mode: "templates", limit: 20 },
      ctxA,
      adapter,
    );
    expect(a.results.some((r) => r.kind === "Entity" && r.id === "a-1001")).toBe(true);
    expect(a.results.some((r) => r.id === "b-2002")).toBe(false);

    const b = await searchMemory(
      { entities: ["auth"], types: ["Entity"], mode: "templates", limit: 20 },
      ctxB,
      adapter,
    );
    expect(b.results.some((r) => r.id === "b-2002")).toBe(true);
    expect(b.results.some((r) => r.id === "a-1001")).toBe(false);
  });

  test("get_neighbors: A reaches paired-A but not paired-B", async () => {
    if (!dockerOk || !adapter) return;
    const a = await getNeighbors(
      { node_id: "a-1001", depth: 1, edge_types: [], limit: 50, mode: "templates" },
      ctxA,
      adapter,
    );
    const ids = a.results.map((r) => r.id);
    expect(ids).toContain("na-1001");
    expect(ids).not.toContain("nb-2002");
  });

  test("path_between: cross-tenant attempt returns empty + no_path_found warning", async () => {
    if (!dockerOk || !adapter) return;
    // From A's project, attempt to path to B's node. Both endpoints are scoped
    // by ctx.project_id at the template level, so B's node is unreachable —
    // shortestPath finds none.
    const out = await pathBetween(
      { node_a: "a-1001", node_b: "b-2002", max_hops: 5, limit: 25, mode: "templates" },
      ctxA,
      adapter,
    );
    expect(out.results.length).toBe(0);
    expect(out.meta.warnings).toContain("no_path_found");
  });

  test("recent_decisions: A sees its own decision, never B's", async () => {
    if (!dockerOk || !adapter) return;
    const a = await recentDecisions({ time_window: "7d", limit: 20, mode: "templates" }, ctxA, adapter);
    expect(a.results.some((r) => r.id === "da")).toBe(true);
    expect(a.results.some((r) => r.id === "db")).toBe(false);
  });
});
