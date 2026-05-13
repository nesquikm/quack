import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import neo4j, { type Driver } from "neo4j-driver";
import { dockerAvailable, spawnNeo4j, type SpawnedNeo4j } from "../graph/_neo4j_helper";
import { Neo4jGraphAdapter } from "../graph/adapter";
import { runMigrations } from "../graph/migrations";
import { runMigrations as runSqliteMigrations } from "../auth/sqlite/schema";
import { registerExtractTemplates } from "../graph/templates/extract/index";
import { writeExtraction } from "./writer";
import { createRedactor } from "./redact";
import { BoundedQueue } from "./queue";
import { startConsumer, type QueuedEnvelope } from "./consumer";
import { addMemory } from "../mcp/tools/memory/add_memory";
import type { ExtractionClient } from "./client";
import type { DeadLetterWriter } from "./dead_letter";
import type { AuthContext } from "../auth/middleware";
import type { ExtractionResult } from "./client";

const ctxA: AuthContext = { user_id: 1, project_id: 7001, role: "admin" };

let spawned: SpawnedNeo4j | null = null;
let driver: Driver | null = null;
let dockerOk = false;

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  if (!dockerOk) return;
  try {
    spawned = await spawnNeo4j();
  } catch (err) {
    console.warn(`neo4j spawn failed — pipeline e2e will skip: ${String(err)}`);
    dockerOk = false;
    return;
  }
  driver = neo4j.driver(spawned!.url, neo4j.auth.basic(spawned!.user, spawned!.password), {
    maxConnectionPoolSize: 5,
  });
  await runMigrations(driver);
  registerExtractTemplates();
}, 180_000);

afterAll(async () => {
  if (driver) await driver.close();
  if (spawned) await spawned.stop();
});

describe("extraction pipeline e2e (integration)", () => {
  test("skips cleanly when docker is unreachable", () => {
    if (!dockerOk) {
      console.warn("docker daemon unreachable — pipeline e2e skipped");
      expect(true).toBe(true);
      return;
    }
    expect(driver).not.toBeNull();
  });

  test("seeded ExtractionResult lands in graph (entity + decision + MENTIONS)", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);

    // Demonstrate redaction by carrying a fake secret through the redactor
    // before "extraction" — the cheap-model would never see it.
    const redactor = createRedactor();
    const { value: redactedPayload, matchCount } = redactor.redact({
      transcript: "key=sk-abcdefghijklmnopqrstuvwx and a normal sentence",
    });
    expect(matchCount).toBeGreaterThanOrEqual(1);
    // redactedPayload would be the actual cheap-model input; we use it here
    // purely to assert the pipeline contract.
    expect(JSON.stringify(redactedPayload)).toContain("«REDACTED»");

    const result: ExtractionResult = {
      entities: [
        { name: "graph-db", kind: "library" },
        { name: "neo4j", kind: "library", aliases: ["Neo4j"] },
      ],
      decisions: [
        { summary: "use Neo4j Community for M3", source_excerpt: "from /brainstorm" },
      ],
      files: [],
      symbols: [],
      feedbacks: [],
      relations: [
        { type: "MENTIONS", from: { kind: "Decision", name: "use Neo4j Community for M3" }, to: { kind: "Entity", name: "neo4j" } },
      ],
    };
    const counts = await writeExtraction(adapter, ctxA, result, new Date().toISOString());
    expect(counts.entities).toBe(2);
    expect(counts.decisions).toBe(1);
    expect(counts.relations).toBe(1);

    // Verify via direct session (test-only).
    const session = driver.session({ database: "neo4j" });
    try {
      const out = await session.run(
        `
        MATCH (d:Decision {project_id: $pid, summary: $summary})-[:MENTIONS]->(e:Entity {project_id: $pid, name: 'neo4j'})
        RETURN count(*) AS c
        `,
        { pid: neo4j.int(ctxA.project_id), summary: "use Neo4j Community for M3" },
      );
      const c = out.records[0]?.get("c");
      expect(typeof c === "number" ? c : c.toNumber()).toBeGreaterThanOrEqual(1);
    } finally {
      await session.close();
    }
  });

  test("idempotent MERGE: re-running same ExtractionResult yields same node count", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);
    const result: ExtractionResult = {
      entities: [{ name: "idempo", kind: "tag" }],
      decisions: [],
      files: [],
      symbols: [],
      feedbacks: [],
      relations: [],
    };
    await writeExtraction(adapter, ctxA, result, new Date().toISOString());
    await writeExtraction(adapter, ctxA, result, new Date().toISOString());
    const session = driver.session({ database: "neo4j" });
    try {
      const out = await session.run(
        `MATCH (e:Entity {project_id: $pid, name: 'idempo'}) RETURN count(*) AS c`,
        { pid: neo4j.int(ctxA.project_id) },
      );
      const c = out.records[0]?.get("c");
      expect(typeof c === "number" ? c : c.toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("cross-tenant defense: model-supplied project_id is overridden by ctx.project_id", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);
    // Even if the model emits a project_id key, the adapter clobbers it with
    // ctx.project_id before passing to the template (AC-4NY6S1.12). We don't
    // include project_id in the schema at all — the writer never passes it —
    // but the adapter's defense is what holds when callers misuse params.
    const otherCtx: AuthContext = { user_id: 2, project_id: 9999, role: "admin" };
    await writeExtraction(
      adapter,
      otherCtx,
      {
        entities: [{ name: "tenancy-marker", kind: "test" }],
        decisions: [],
        files: [],
        symbols: [],
        feedbacks: [],
        relations: [],
      },
      new Date().toISOString(),
    );
    // Lookup must find it only via project_id=9999, never via 7001.
    const session = driver.session({ database: "neo4j" });
    try {
      const out = await session.run(
        `MATCH (e:Entity {project_id: 9999, name: 'tenancy-marker'}) RETURN count(*) AS c`,
      );
      const c = out.records[0]?.get("c");
      expect(typeof c === "number" ? c : c.toNumber()).toBeGreaterThanOrEqual(1);

      const wrong = await session.run(
        `MATCH (e:Entity {project_id: 7001, name: 'tenancy-marker'}) RETURN count(*) AS c`,
      );
      const wc = wrong.records[0]?.get("c");
      expect(typeof wc === "number" ? wc : wc.toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });

  // AC-41NXTZ.11 — full e2e for add_memory: addMemory → queue → consumer →
  // mocked model emits known ExtractionResult → writer lands nodes scoped to
  // ctx.project_id. Mirrors the existing pipeline pattern; the MCP HTTP path
  // is exercised in add_memory.test.ts.
  test("AC-41NXTZ.11: add_memory e2e — Bun + Node entities and Feedback land scoped to caller's project", async () => {
    if (!dockerOk || !driver) return;
    const adapter = new Neo4jGraphAdapter(driver);
    const ctxAddMem: AuthContext = { user_id: 9, project_id: 81234, role: "member" };

    // SQLite stub so addMemory's slug lookup succeeds.
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.run(
      "INSERT INTO projects(id, slug, display_name) VALUES (81234, 'proj-e2e', 'Proj E2E')",
    );

    const queue = new BoundedQueue<QueuedEnvelope>(10);

    // Mock the cheap-model client: any envelope (must be kind=explicit_add)
    // emits the canonical ExtractionResult the AC describes.
    const mockedResult: ExtractionResult = {
      entities: [
        { name: "Bun", kind: "runtime" },
        { name: "Node", kind: "runtime" },
      ],
      decisions: [],
      files: [],
      symbols: [],
      feedbacks: [{ body: "I prefer Bun over Node for this project", sentiment: "positive" }],
      relations: [
        { type: "RELATED_TO", from: { kind: "Entity", name: "Bun" }, to: { kind: "Entity", name: "Node" } },
      ],
    };
    const observed: { kind: string | null } = { kind: null };
    const client: ExtractionClient = {
      async extract(payload: unknown) {
        observed.kind = (payload as { kind?: string } | undefined)?.kind ?? null;
        return mockedResult;
      },
    };
    const deadLetter: DeadLetterWriter = { append() {} };

    const consumer = startConsumer({
      queue,
      adapter,
      redactor: createRedactor(),
      client,
      deadLetter,
      concurrency: 1,
      pollMs: 10,
    });

    try {
      // Caller (MCP) invokes add_memory.
      const out = await addMemory(
        { content: "I prefer Bun over Node for this project" },
        ctxAddMem,
        { queue, db },
      );
      expect(out.accepted).toBe(true);

      // Drive the consumer to drain.
      await consumer.drainOnce();

      // The model received an envelope whose kind is "explicit_add".
      expect(observed.kind).toBe("explicit_add");

      // The graph now contains the seeded nodes scoped to ctx.project_id.
      const session = driver.session({ database: "neo4j" });
      try {
        const bun = await session.run(
          `MATCH (e:Entity {project_id: $pid, name: 'bun'}) RETURN count(*) AS c`,
          { pid: neo4j.int(ctxAddMem.project_id) },
        );
        const node = await session.run(
          `MATCH (e:Entity {project_id: $pid, name: 'node'}) RETURN count(*) AS c`,
          { pid: neo4j.int(ctxAddMem.project_id) },
        );
        const fb = await session.run(
          `MATCH (f:Feedback {project_id: $pid}) WHERE f.body CONTAINS 'Bun' RETURN count(*) AS c`,
          { pid: neo4j.int(ctxAddMem.project_id) },
        );
        const rel = await session.run(
          `MATCH (a:Entity {project_id: $pid, name: 'bun'})-[r:RELATED_TO]->(b:Entity {project_id: $pid, name: 'node'}) RETURN count(*) AS c`,
          { pid: neo4j.int(ctxAddMem.project_id) },
        );
        const getC = (rec: { records: Array<{ get(k: string): unknown }> }) => {
          const v = rec.records[0]?.get("c");
          return typeof v === "number" ? v : (v as { toNumber(): number }).toNumber();
        };
        expect(getC(bun)).toBeGreaterThanOrEqual(1);
        expect(getC(node)).toBeGreaterThanOrEqual(1);
        expect(getC(fb)).toBeGreaterThanOrEqual(1);
        expect(getC(rel)).toBeGreaterThanOrEqual(1);

        // Cross-tenant defense: another project's MATCH returns 0.
        const otherPid = 99999;
        const otherBun = await session.run(
          `MATCH (e:Entity {project_id: $pid, name: 'bun'}) RETURN count(*) AS c`,
          { pid: neo4j.int(otherPid) },
        );
        expect(getC(otherBun)).toBe(0);
      } finally {
        await session.close();
      }
    } finally {
      await consumer.stop("test");
      db.close();
    }
  });
});
