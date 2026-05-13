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
}

export function buildFetch(opts: BuildAppOptions): (request: Request) => Promise<Response> {
  const { db, mcpHandler, graphDriver } = opts;

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
  // Test seam: opt out of touching Neo4j (driver creation + migrations).
  // Production startServer always wires the graph; bind/server tests that
  // don't need it set this to true so `/health` reports `graphdb: "down"`
  // without crashing on a missing Neo4j.
  skipGraph?: boolean;
}

export function startServer(options: StartServerOptions = {}): { server: AnyServer; db: Database; logger: Logger; graphDriver: Neo4jDriver | null } {
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
  if (!options.skipGraph) {
    // Lazy-connecting driver; doesn't actually open a socket until first
    // session call. validateTemplateRegistry runs synchronously so a broken
    // template id fails startup, not a request.
    validateTemplateRegistry();
    graphDriver = getDriver(env);
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
  }

  const fetch = buildFetch({ db, logger, mcpHandler: options.mcpHandler, graphDriver });

  const server = Bun.serve({
    hostname: env.QUACK_BIND_HOST,
    port: env.PORT,
    fetch,
  });

  logger.info("server.started", { port: env.PORT, host: env.QUACK_BIND_HOST, version: SERVER_VERSION });
  return { server, db, logger, graphDriver };
}
