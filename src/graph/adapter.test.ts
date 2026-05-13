import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import neo4j, { type Driver } from "neo4j-driver";
import { z } from "zod";
import { Neo4jGraphAdapter } from "./adapter";
import { UnknownTemplateError } from "./errors";
import { TEMPLATE_REGISTRY, registerTemplate } from "./templates/index";
import { dockerAvailable, spawnNeo4j, type SpawnedNeo4j } from "./_neo4j_helper";
import { resetCountersForTests, getSnapshot } from "../metrics/counters";
import type { AuthContext } from "../auth/middleware";

let spawned: SpawnedNeo4j | null = null;
let driver: Driver | null = null;
let dockerOk = false;
const ctxA: AuthContext = { user_id: 1, project_id: 100, role: "admin" };
const ctxB: AuthContext = { user_id: 2, project_id: 200, role: "member" };

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  if (!dockerOk) return;
  try {
    spawned = await spawnNeo4j();
  } catch (err) {
    console.warn(`neo4j spawn failed — Neo4jGraphAdapter integration tests will skip: ${String(err)}`);
    dockerOk = false;
    return;
  }
  driver = neo4j.driver(spawned!.url, neo4j.auth.basic(spawned!.user, spawned!.password), {
    maxConnectionPoolSize: 10,
  });

  // Register a pair of test-only templates.
  if (!TEMPLATE_REGISTRY["test.upsert_entity"]) {
    registerTemplate({
      id: "test.upsert_entity",
      cypher: `MERGE (e:Entity {project_id: $project_id, name: $name})
               ON CREATE SET e.id = randomUUID(), e.kind = 'test', e.created_at = datetime()
               RETURN e.id AS id, e.name AS name, e.project_id AS project_id`,
      paramSchema: z.object({ name: z.string(), project_id: z.number().optional() }),
      accessMode: "WRITE",
    });
  }
  if (!TEMPLATE_REGISTRY["test.find_entities"]) {
    registerTemplate({
      id: "test.find_entities",
      cypher: `MATCH (e:Entity {project_id: $project_id}) RETURN e.name AS name, e.project_id AS project_id`,
      paramSchema: z.object({ project_id: z.number().optional() }),
      accessMode: "READ",
    });
  }
}, 120_000);

afterAll(async () => {
  if (driver) await driver.close();
  if (spawned) await spawned.stop();
});

describe("Neo4jGraphAdapter (integration)", () => {
  test("skips cleanly when docker is unreachable", () => {
    if (!dockerOk) {
      console.warn("docker daemon unreachable — Neo4jGraphAdapter integration tests skipped");
      expect(true).toBe(true);
      return;
    }
    expect(spawned).not.toBeNull();
  });

  test("happy path: upsert + find returns expected node", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);
    await adapter.run("test.upsert_entity", { name: "auth-A" }, ctxA);
    const out = await adapter.run<{ project_id?: number }, { name: string; project_id: number }>(
      "test.find_entities",
      {},
      ctxA,
    );
    const names = out.rows.map((r) => r.name);
    expect(names).toContain("auth-A");
    expect(out.rows.every((r) => Number(r.project_id) === 100)).toBe(true);
  });

  test("project_id override defense: caller-supplied project_id is ignored", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);
    // Caller attempts to write into project B while authenticated as A — must land in A.
    await adapter.run(
      "test.upsert_entity",
      { name: "spy-from-A", project_id: 999 },
      ctxA,
    );
    // A sees it.
    const aSees = await adapter.run<{}, { name: string }>("test.find_entities", {}, ctxA);
    expect(aSees.rows.some((r) => r.name === "spy-from-A")).toBe(true);
    // B does NOT see it (because adapter wrote into A's partition despite the param).
    const bSees = await adapter.run<{}, { name: string }>("test.find_entities", {}, ctxB);
    expect(bSees.rows.some((r) => r.name === "spy-from-A")).toBe(false);
  });

  test("unknown templateId ⇒ UnknownTemplateError", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);
    await expect(adapter.run("does.not.exist", {}, ctxA)).rejects.toBeInstanceOf(UnknownTemplateError);
  });

  test("cross-project query returns empty", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);
    // Write into A only.
    await adapter.run("test.upsert_entity", { name: "only-in-A" }, ctxA);
    const bRows = await adapter.run<{}, { name: string }>("test.find_entities", {}, ctxB);
    expect(bRows.rows.some((r) => r.name === "only-in-A")).toBe(false);
  });

  test("adapter increments db_error counter when cypher throws", async () => {
    if (!dockerOk || !driver) return;
    if (!TEMPLATE_REGISTRY["test.bad_cypher"]) {
      registerTemplate({
        id: "test.bad_cypher",
        cypher: "INVALID CYPHER FOR project_id=$project_id RETURN 1",
        paramSchema: z.object({}).loose(),
        accessMode: "READ",
      });
    }
    resetCountersForTests();
    const adapter = new Neo4jGraphAdapter(driver);
    await expect(adapter.run("test.bad_cypher", {}, ctxA)).rejects.toBeDefined();
    const snap = getSnapshot();
    expect(snap.errors.by_category["db_error"] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
