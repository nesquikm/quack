import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import neo4j, { type Driver } from "neo4j-driver";
import { dockerAvailable, spawnNeo4j, type SpawnedNeo4j } from "../../_neo4j_helper";
import { Neo4jGraphAdapter } from "../../adapter";
import { runMigrations } from "../../migrations";
import { registerExtractTemplates } from "./index";
import { upsertEntityTemplate } from "./upsert_entity";
import { upsertDecisionTemplate } from "./upsert_decision";
import { upsertFileTemplate } from "./upsert_file";
import { upsertSymbolTemplate } from "./upsert_symbol";
import { upsertFeedbackTemplate } from "./upsert_feedback";
import { upsertRelationTemplate } from "./upsert_relation";
import type { CypherTemplate } from "../../types";
import type { AuthContext } from "../../../auth/middleware";

// AC-A9BN0M.2 / .3 — the five node-upsert templates gain a `$source`
// parameter (list<string>); each SETs `source` to the set-union of its
// current value and `$source`. `$source` is never a MERGE natural key.
// `upsert_relation` is unchanged.

const NODE_TEMPLATES: ReadonlyArray<[string, CypherTemplate]> = [
  ["upsert_entity", upsertEntityTemplate],
  ["upsert_decision", upsertDecisionTemplate],
  ["upsert_file", upsertFileTemplate],
  ["upsert_symbol", upsertSymbolTemplate],
  ["upsert_feedback", upsertFeedbackTemplate],
];

describe("AC-A9BN0M.3 — node-upsert templates accept $source (schema/cypher)", () => {
  for (const [name, tpl] of NODE_TEMPLATES) {
    test(`${name}: paramSchema accepts an empty source list`, () => {
      const base = baseParamsFor(name);
      const parsed = tpl.paramSchema.safeParse({ ...base, source: [] });
      expect(parsed.success).toBe(true);
    });

    test(`${name}: paramSchema accepts a one-element source list`, () => {
      const base = baseParamsFor(name);
      const parsed = tpl.paramSchema.safeParse({ ...base, source: ["backend"] });
      expect(parsed.success).toBe(true);
    });

    test(`${name}: cypher references the $source parameter`, () => {
      expect(tpl.cypher).toContain("$source");
    });

    test(`${name}: $source is NOT part of the MERGE natural key`, () => {
      // The MERGE clause must not key on source — only ON CREATE/ON MATCH SET.
      const mergeLine = tpl.cypher.split("\n").find((l) => l.includes("MERGE ("));
      expect(mergeLine).toBeDefined();
      expect(mergeLine!).not.toContain("source");
    });
  }

  test("upsert_relation is unchanged — no $source parameter", () => {
    // Word-boundary match — a bare `$source` token, NOT the substring inside
    // the pre-existing `$source_excerpt` parameter that upsert_relation has
    // always carried.
    expect(upsertRelationTemplate.cypher).not.toMatch(/\$source\b/);
  });
});

describe("AC-A9BN0M.3 — $source set-union vs. real Neo4j (integration)", () => {
  let spawned: SpawnedNeo4j | null = null;
  let driver: Driver | null = null;
  let dockerOk = false;
  let adapter: Neo4jGraphAdapter | null = null;
  const ctx: AuthContext = { user_id: 1, project_id: 55001, role: "admin" };

  beforeAll(async () => {
    dockerOk = await dockerAvailable();
    if (!dockerOk) return;
    try {
      spawned = await spawnNeo4j();
    } catch (err) {
      console.warn(`neo4j spawn failed — upsert_source integration tests will skip: ${String(err)}`);
      dockerOk = false;
      return;
    }
    driver = neo4j.driver(spawned!.url, neo4j.auth.basic(spawned!.user, spawned!.password), {
      maxConnectionPoolSize: 5,
    });
    await runMigrations(driver);
    registerExtractTemplates();
    adapter = new Neo4jGraphAdapter(driver);
  }, 180_000);

  afterAll(async () => {
    if (driver) await driver.close();
    if (spawned) await spawned.stop();
  });

  test("skips cleanly when docker is unreachable", () => {
    if (!dockerOk) {
      console.warn("docker daemon unreachable — upsert_source integration tests skipped");
      expect(true).toBe(true);
      return;
    }
    expect(adapter).not.toBeNull();
  });

  test("upsert_entity: re-running with the same source leaves a one-element source", async () => {
    if (!dockerOk || !adapter || !driver) return;
    const now = new Date().toISOString();
    await adapter.run(
      "extract.upsert_entity",
      { name: "src-idem", kind: "library", aliases: [], now, source: ["backend"] },
      ctx,
    );
    await adapter.run(
      "extract.upsert_entity",
      { name: "src-idem", kind: "library", aliases: [], now, source: ["backend"] },
      ctx,
    );
    const source = await readSource(driver, "Entity", ctx.project_id, "name", "src-idem");
    expect([...source].sort()).toEqual(["backend"]);
  });

  test("upsert_entity: a second sub-project unions to a two-element source", async () => {
    if (!dockerOk || !adapter || !driver) return;
    const now = new Date().toISOString();
    await adapter.run(
      "extract.upsert_entity",
      { name: "src-union", kind: "library", aliases: [], now, source: ["backend"] },
      ctx,
    );
    await adapter.run(
      "extract.upsert_entity",
      { name: "src-union", kind: "library", aliases: [], now, source: ["frontend"] },
      ctx,
    );
    const source = await readSource(driver, "Entity", ctx.project_id, "name", "src-union");
    expect([...source].sort()).toEqual(["backend", "frontend"]);
  });

  test("upsert_entity: an empty $source is a no-op union (leaves source unchanged)", async () => {
    if (!dockerOk || !adapter || !driver) return;
    const now = new Date().toISOString();
    await adapter.run(
      "extract.upsert_entity",
      { name: "src-noop", kind: "library", aliases: [], now, source: ["backend"] },
      ctx,
    );
    await adapter.run(
      "extract.upsert_entity",
      { name: "src-noop", kind: "library", aliases: [], now, source: [] },
      ctx,
    );
    const source = await readSource(driver, "Entity", ctx.project_id, "name", "src-noop");
    expect([...source].sort()).toEqual(["backend"]);
  });

  test("upsert_decision: source set-union accumulates across two sub-projects", async () => {
    if (!dockerOk || !adapter || !driver) return;
    const now = new Date().toISOString();
    await adapter.run(
      "extract.upsert_decision",
      { summary: "src decision", decided_at: null, source_excerpt: "x", now, source: ["backend"] },
      ctx,
    );
    await adapter.run(
      "extract.upsert_decision",
      { summary: "src decision", decided_at: null, source_excerpt: "x", now, source: ["frontend"] },
      ctx,
    );
    const source = await readSource(driver, "Decision", ctx.project_id, "summary", "src decision");
    expect([...source].sort()).toEqual(["backend", "frontend"]);
  });

  test("upsert_feedback: source set-union accumulates across two sub-projects", async () => {
    if (!dockerOk || !adapter || !driver) return;
    const now = new Date().toISOString();
    await adapter.run(
      "extract.upsert_feedback",
      { body: "src feedback", sentiment: null, now, source: ["backend"] },
      ctx,
    );
    await adapter.run(
      "extract.upsert_feedback",
      { body: "src feedback", sentiment: null, now, source: ["frontend"] },
      ctx,
    );
    const source = await readSource(driver, "Feedback", ctx.project_id, "body", "src feedback");
    expect([...source].sort()).toEqual(["backend", "frontend"]);
  });

  test("upsert_file: source set-union accumulates across two sub-projects", async () => {
    if (!dockerOk || !adapter || !driver) return;
    const now = new Date().toISOString();
    await adapter.run(
      "extract.upsert_file",
      { path: "src/src-file.ts", repo_root: null, now, source: ["backend"] },
      ctx,
    );
    await adapter.run(
      "extract.upsert_file",
      { path: "src/src-file.ts", repo_root: null, now, source: ["frontend"] },
      ctx,
    );
    const source = await readSource(driver, "File", ctx.project_id, "path", "src/src-file.ts");
    expect([...source].sort()).toEqual(["backend", "frontend"]);
  });

  test("upsert_symbol: source set-union accumulates across two sub-projects", async () => {
    if (!dockerOk || !adapter || !driver) return;
    const now = new Date().toISOString();
    // Symbol upsert MATCHes its owning File first — create the File, capture
    // its id, then upsert the same symbol twice with two distinct sources.
    const fileOut = await adapter.run<
      { path: string; repo_root: string | null; now: string; source: string[] },
      { id: string }
    >("extract.upsert_file", { path: "src/sym-host.ts", repo_root: null, now, source: ["backend"] }, ctx);
    const fileId = fileOut.rows[0]?.id;
    expect(typeof fileId).toBe("string");
    await adapter.run(
      "extract.upsert_symbol",
      { name: "srcSym", file_id: fileId, kind: "function", now, source: ["backend"] },
      ctx,
    );
    await adapter.run(
      "extract.upsert_symbol",
      { name: "srcSym", file_id: fileId, kind: "function", now, source: ["frontend"] },
      ctx,
    );
    const source = await readSource(driver, "Symbol", ctx.project_id, "name", "srcSym");
    expect([...source].sort()).toEqual(["backend", "frontend"]);
  });
});

function baseParamsFor(name: string): Record<string, unknown> {
  const now = "2026-05-18T00:00:00Z";
  switch (name) {
    case "upsert_entity":
      return { name: "n", kind: "library", aliases: [], now };
    case "upsert_decision":
      return { summary: "s", decided_at: null, source_excerpt: "", now };
    case "upsert_file":
      return { path: "src/x.ts", repo_root: null, now };
    case "upsert_symbol":
      return { name: "sym", file_id: "f1", kind: "function", now };
    case "upsert_feedback":
      return { body: "b", sentiment: null, now };
    default:
      throw new Error(`no base params for ${name}`);
  }
}

// Test-only readback helper. `label` and `keyProp` are interpolated into the
// Cypher because node labels and property keys are NOT parameterizable in
// Cypher (`MATCH (n:$label)` is a syntax error) — only data *values* can be
// $params, and `projectId`/`keyValue` are passed as such. Every caller passes
// a hardcoded literal (`"Entity"`, `"name"`, …) so there is no injection
// surface; this is the necessary structural-identifier exception, not a
// pattern for production templates (which interpolate nothing).
async function readSource(
  driver: Driver,
  label: string,
  projectId: number,
  keyProp: string,
  keyValue: string,
): Promise<string[]> {
  const session = driver.session({ database: "neo4j" });
  try {
    const out = await session.run(
      `MATCH (n:${label} {project_id: $pid}) WHERE n.${keyProp} = $val RETURN n.source AS source`,
      { pid: neo4j.int(projectId), val: keyValue },
    );
    const raw = out.records[0]?.get("source");
    return Array.isArray(raw) ? (raw as string[]) : [];
  } finally {
    await session.close();
  }
}
