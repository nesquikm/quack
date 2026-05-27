import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import neo4j, { type Driver } from "neo4j-driver";
import { dockerAvailable, spawnNeo4j, type SpawnedNeo4j } from "../../../graph/_neo4j_helper";
import { Neo4jGraphAdapter } from "../../../graph/adapter";
import { registerMemoryTemplates } from "../../../graph/templates/memory/index";
import { registerExtractTemplates } from "../../../graph/templates/extract/index";
import { runMigrations } from "../../../graph/migrations";
import { runMigrations as runSqliteMigrations } from "../../../auth/sqlite/schema";
import { searchMemory } from "./search_memory";
import { getNeighbors } from "./get_neighbors";
import { pathBetween } from "./path_between";
import { recentDecisions } from "./recent_decisions";
import { addMemory } from "./add_memory";
import { askMemory } from "./ask_memory";
import type { AskClient, AskTurn } from "./ask_loop";
import { BoundedQueue } from "../../../extract/queue";
import { writeExtraction } from "../../../extract/writer";
import type { ExtractionResult } from "../../../extract/client";
import type { QueuedEnvelope } from "../../../extract/consumer";
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
  registerExtractTemplates();
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

  // AC-41NXTZ.8 — add_memory writes carry ctx.project_id; cross-tenant readers can't see them.
  test("AC-41NXTZ.8: add_memory enqueues envelope under ctx.project_id; mocked extraction lands in A only", async () => {
    if (!dockerOk || !adapter) return;
    // Seed a minimal auth.sqlite with rows for ctxA's project_id (1001) and
    // ctxB's project_id (2002) so add_memory's slug lookup succeeds.
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.run("INSERT INTO projects(id, slug, display_name) VALUES (1001, 'proj-a', 'A')");
    db.run("INSERT INTO projects(id, slug, display_name) VALUES (2002, 'proj-b', 'B')");

    const queue = new BoundedQueue<QueuedEnvelope>(10);

    // ctxA calls add_memory; envelope hits the queue with kind=explicit_add + ctx.project_id=1001.
    const out = await addMemory(
      { content: "shared-name lives only in project A" },
      ctxA,
      { queue, db },
    );
    expect(out.accepted).toBe(true);

    const env = queue.dequeue()!;
    expect(env.kind).toBe("explicit_add");
    expect(env.ctx.project_id).toBe(ctxA.project_id);

    // Simulate the consumer's extraction step: write a known ExtractionResult
    // through writeExtraction with the envelope's ctx (NOT a model-supplied
    // override). This is the exact path the consumer takes.
    const result: ExtractionResult = {
      entities: [{ name: "shared-name", kind: "library" }],
      decisions: [],
      files: [],
      symbols: [],
      feedbacks: [{ body: "shared-name lives only in project A" }],
      relations: [
        { type: "RELATED_TO", from: { kind: "Feedback", name: "shared-name lives only in project A" }, to: { kind: "Entity", name: "shared-name" } },
      ],
    };
    await writeExtraction(adapter, env.ctx, result, new Date().toISOString());

    // Project A's token sees the new entity.
    const seenByA = await searchMemory(
      { entities: ["shared-name"], types: ["Entity"], mode: "templates", limit: 20 },
      ctxA,
      adapter,
    );
    expect(seenByA.results.some((r) => r.kind === "Entity")).toBe(true);

    // Project B's token must NOT see it (cross-tenant isolation).
    const seenByB = await searchMemory(
      { entities: ["shared-name"], types: ["Entity"], mode: "templates", limit: 20 },
      ctxB,
      adapter,
    );
    expect(seenByB.results.some((r) => r.kind === "Entity")).toBe(false);

    db.close();
  });

  // AC-A9BN0M.8 — `sub_projects` is an opaque non-security label. A token for
  // project A passing `sub_projects` that names a project-B sub-project still
  // returns only project-A nodes — the $project_id bind is unaffected.
  test("AC-A9BN0M.8: sub_projects filter cannot widen a query past $project_id", async () => {
    if (!dockerOk || !adapter || !driver) return;

    // Seed: project A has a tagged 'crosstag' entity (source=['a-repo']);
    // project B has a same-named entity tagged with 'b-repo'.
    const session = driver.session({ database: "neo4j" });
    try {
      await session.run(`
        MERGE (a:Entity {project_id: 1001, name: 'crosstag'})
        ON CREATE SET a.id = 'crosstag-a', a.kind = 'library', a.created_at = datetime(), a.source = ['a-repo']
        MERGE (b:Entity {project_id: 2002, name: 'crosstag'})
        ON CREATE SET b.id = 'crosstag-b', b.kind = 'library', b.created_at = datetime(), b.source = ['b-repo']
      `);
    } finally {
      await session.close();
    }

    // Project A's token names project B's sub-project tag. The result set
    // stays within project A — B's node is never reachable.
    const out = await searchMemory(
      { entities: ["crosstag"], types: ["Entity"], mode: "templates", limit: 20, sub_projects: ["b-repo"] },
      ctxA,
      adapter,
    );
    expect(out.results.every((r) => r.project_id === ctxA.project_id)).toBe(true);
    expect(out.results.some((r) => r.id === "crosstag-b")).toBe(false);

    // Project A naming its own tag finds its own node.
    const own = await searchMemory(
      { entities: ["crosstag"], types: ["Entity"], mode: "templates", limit: 20, sub_projects: ["a-repo"] },
      ctxA,
      adapter,
    );
    expect(own.results.some((r) => r.id === "crosstag-a")).toBe(true);
  });

  // AC-WB3N9H.9 — ask_memory invoked with project A's ctx must only ever surface
  // project-A nodes. The loop's internal primitive calls bind ctx.project_id, so
  // the overlapping-name 'auth' node from project B is never reachable, in
  // answer text, results, or meta.coverage.
  test("AC-WB3N9H.9: ask_memory with project-A ctx never surfaces project-B nodes", async () => {
    if (!dockerOk || !adapter) return;

    function scriptedClient(turns: AskTurn[]): AskClient {
      const queue = [...turns];
      return {
        async next(): Promise<AskTurn> {
          const t = queue.shift();
          if (!t) throw new Error("scripted client exhausted");
          return t;
        },
      };
    }

    // The model searches for the overlapping entity name then answers, echoing
    // whatever ids it observed (so a leak would show up in the answer text too).
    const client = scriptedClient([
      { type: "tool_calls", calls: [{ tool: "search_memory", args: { entities: ["auth"], types: ["Entity"], limit: 20 } }] },
      { type: "answer", text: "the auth entity for this project" },
    ]);

    const out = await askMemory({ question: "what do we know about auth?" }, ctxA, adapter, { client });

    // results: only project A's node.
    expect(out.results.some((r) => r.id === "a-1001")).toBe(true);
    expect(out.results.some((r) => r.id === "b-2002")).toBe(false);
    expect(out.results.every((r) => r.project_id === ctxA.project_id)).toBe(true);

    // answer text must not contain project B's node id.
    expect(out.answer).not.toContain("b-2002");
  });
});
