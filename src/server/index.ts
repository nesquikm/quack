import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
type AnyServer = Server<unknown>;
import { runMigrations, openAuthDb } from "../auth/sqlite/schema";
import { bootstrapAdmin } from "../auth/bootstrap";
import { authenticate, unauthorizedResponse } from "../auth/middleware";
import { parseEnv, type Env } from "../shared/env";
import { Logger, createBufferLogger } from "../shared/logger";
import { getDriver, probeGraphdb } from "../graph/driver";
import { runMigrations as runGraphMigrations } from "../graph/migrations";
import { validateTemplateRegistry } from "../graph/templates/index";
import { Neo4jGraphAdapter, type GraphAdapter } from "../graph/adapter";
import { registerExtractTemplates } from "../graph/templates/extract/index";
import { registerMemoryTemplates } from "../graph/templates/memory/index";
import { BoundedQueue } from "../extract/queue";
import { createRedactor } from "../extract/redact";
import { createExtractionClient } from "../extract/client";
import { createDeadLetterWriter } from "../extract/dead_letter";
import { startConsumer, type Consumer, type QueuedEnvelope } from "../extract/consumer";
import { handleIngest } from "../ingest/handler";
import { setQueueDepthSource, queueIncrement } from "../metrics/counters";
import { parseExtraPatternsFromEnv } from "../shared/redaction_patterns";
import packageJson from "../../package.json" with { type: "json" };
import type { Neo4jDriver } from "../graph/types";

export const SERVER_VERSION = (packageJson as { version: string }).version;

export type McpHandlerFn = (
  request: Request,
  ctx: { user_id: number; project_id: number; role: "admin" | "member" },
  db: Database,
) => Promise<Response> | Response;

export interface BuildAppOptions {
  db: Database;
  logger?: Logger;
  mcpHandler?: McpHandlerFn;
  graphDriver?: Neo4jDriver | null;
  ingestQueue?: BoundedQueue<QueuedEnvelope>;
}

export function buildFetch(opts: BuildAppOptions): (request: Request) => Promise<Response> {
  const { db, mcpHandler, graphDriver, ingestQueue } = opts;

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const graphdbStatus: "ok" | "down" = graphDriver
        ? (await probeGraphdb(graphDriver, 1000))
          ? "ok"
          : "down"
        : "down";
      const ok = graphdbStatus === "ok";
      return new Response(JSON.stringify({ ok, version: SERVER_VERSION, graphdb: graphdbStatus }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const ctx = authenticate(request, db);
    if (!ctx) return unauthorizedResponse();

    if (url.pathname === "/ingest" && request.method === "POST") {
      if (ingestQueue) {
        return handleIngest(request, ctx, { queue: ingestQueue, db });
      }
      // M2-compat fallback: no queue wired (extractor disabled). Still a
      // 204 so existing clients don't break; future ops monitoring should
      // catch the `queue.depth === null` signal in server_status.
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      if (mcpHandler) return mcpHandler(request, ctx, db);
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
}

export interface StartServerOptions {
  env?: Env;
  mcpHandler?: BuildAppOptions["mcpHandler"];
  // Optional factory — called with the GraphAdapter once the driver is wired,
  // returns the McpHandlerFn. Prefer this over `mcpHandler` so memory-plane
  // tools have access to the adapter without a circular construction step.
  mcpHandlerFactory?: (graph: GraphAdapter | null) => BuildAppOptions["mcpHandler"];
  // Test seam: opt out of touching Neo4j (driver creation + migrations).
  // Production startServer always wires the graph; bind/server tests that
  // don't need it set this to true so `/health` reports `graphdb: "down"`
  // without crashing on a missing Neo4j.
  skipGraph?: boolean;
}

export function startServer(options: StartServerOptions = {}): { server: AnyServer; db: Database; logger: Logger; graphDriver: Neo4jDriver | null; graph: GraphAdapter | null } {
  const env = options.env ?? parseEnv();
  mkdirSync(env.QUACK_DATA_DIR, { recursive: true });
  const dbPath = join(env.QUACK_DATA_DIR, "auth.sqlite");
  const db = openAuthDb(dbPath);
  runMigrations(db);
  bootstrapAdmin(db, env);

  // Defense-in-depth: redact both the cheap-model API key AND the bootstrap token
  // from every log line. The bootstrap token has no current log path, but a future
  // log call that interpolates env vars (e.g., a startup banner) would otherwise
  // print plaintext.
  const { logger } = createBufferLogger([env.QUACK_MODEL_API_KEY, env.QUACK_BOOTSTRAP_TOKEN]);

  let graphDriver: Neo4jDriver | null = null;
  let graph: GraphAdapter | null = null;
  let ingestQueue: BoundedQueue<QueuedEnvelope> | undefined;
  let consumer: Consumer | undefined;
  if (!options.skipGraph) {
    // Register every template the runtime needs before the validator scans.
    // Idempotent — multiple startServer calls (tests) don't double-register.
    registerMemoryTemplates();
    registerExtractTemplates();
    validateTemplateRegistry();
    graphDriver = getDriver(env);
    graph = new Neo4jGraphAdapter(graphDriver);
    // Fire-and-forget migration: index DDL is idempotent and tolerant of
    // restart-time races. A migration failure logs at error level but does
    // not crash startup — /health surfaces graphdb: "down" until Neo4j
    // recovers.
    const driver = graphDriver;
    void (async () => {
      try {
        await runGraphMigrations(driver);
        const { countIndexes } = await import("../graph/migrations");
        const indexes = await countIndexes(driver);
        const { setGraphdbStatus } = await import("../admin/tools/_graphdb_status");
        setGraphdbStatus({ status: "ok", indexes });
      } catch (err) {
        logger.error("graph.migrations.failed", { error: String(err) });
        const { setGraphdbStatus } = await import("../admin/tools/_graphdb_status");
        setGraphdbStatus({ status: "down", indexes: 0 });
      }
    })();

    // Extractor pipeline. Requires the model endpoint to be configured —
    // without it the queue stays present (counters report 0) but the
    // consumer is not started; ingest will accept and enqueue, and
    // operators see queue.depth grow as a signal to set the env vars.
    ingestQueue = new BoundedQueue<QueuedEnvelope>(env.QUACK_QUEUE_CAPACITY);
    setQueueDepthSource(() => ingestQueue!.getDepth());
    if (env.QUACK_MODEL_API_KEY && env.QUACK_MODEL_BASE_URL) {
      const extras = parseExtraPatternsFromEnv(env.QUACK_REDACTION_PATTERNS);
      const redactor = createRedactor(extras);
      const client = createExtractionClient({
        baseURL: env.QUACK_MODEL_BASE_URL,
        apiKey: env.QUACK_MODEL_API_KEY,
        modelName: env.QUACK_MODEL_NAME,
      });
      const deadLetter = createDeadLetterWriter(
        join(env.QUACK_DATA_DIR, "dead-letters.jsonl"),
        env.QUACK_DEAD_LETTER_MAX_BYTES,
      );
      consumer = startConsumer({
        queue: ingestQueue,
        adapter: graph,
        redactor,
        client,
        deadLetter,
        concurrency: env.QUACK_EXTRACTOR_CONCURRENCY,
      });
      const stopConsumer = async () => {
        if (consumer) await consumer.stop("signal");
      };
      process.once("SIGTERM", stopConsumer);
      process.once("SIGINT", stopConsumer);
    } else {
      logger.info("extractor.disabled", { reason: "QUACK_MODEL_API_KEY or QUACK_MODEL_BASE_URL unset" });
    }
  }
  // Reference queueIncrement so the import isn't a TS unused warning while
  // we wire up the ingest handler's per-request hook elsewhere.
  void queueIncrement;

  const resolvedMcpHandler = options.mcpHandlerFactory
    ? options.mcpHandlerFactory(graph)
    : options.mcpHandler;
  const fetch = buildFetch({ db, logger, mcpHandler: resolvedMcpHandler, graphDriver, ingestQueue });

  const server = Bun.serve({
    hostname: env.QUACK_BIND_HOST,
    port: env.PORT,
    fetch,
  });

  logger.info("server.started", { port: env.PORT, host: env.QUACK_BIND_HOST, version: SERVER_VERSION });
  return { server, db, logger, graphDriver, graph };
}
