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
import packageJson from "../../package.json" with { type: "json" };

export const SERVER_VERSION = (packageJson as { version: string }).version;
const LOOPBACK_HOST = "127.0.0.1";

export type McpHandlerFn = (
  request: Request,
  ctx: { user_id: number; project_id: number; role: "admin" | "member" },
  db: Database,
) => Promise<Response> | Response;

export interface BuildAppOptions {
  db: Database;
  logger?: Logger;
  mcpHandler?: McpHandlerFn;
}

export function buildFetch(opts: BuildAppOptions): (request: Request) => Promise<Response> {
  const { db, mcpHandler } = opts;

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, version: SERVER_VERSION }), {
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
}

export function startServer(options: StartServerOptions = {}): { server: AnyServer; db: Database; logger: Logger } {
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
  const fetch = buildFetch({ db, logger, mcpHandler: options.mcpHandler });

  const server = Bun.serve({
    hostname: LOOPBACK_HOST,
    port: env.PORT,
    fetch,
  });

  logger.info("server.started", { port: env.PORT, host: LOOPBACK_HOST, version: SERVER_VERSION });
  return { server, db, logger };
}
