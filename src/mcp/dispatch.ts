import { ADMIN_TOOLS } from "../admin/index";
import { AdminToolError } from "../admin/errors";
import { incrementError } from "../metrics/counters";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../auth/middleware";

export interface ToolDef {
  name: string;
  schema: { parse: (v: unknown) => unknown };
  handler: (args: unknown, ctx: AuthContext, db: Database) => unknown;
  description?: string;
}

export interface DispatchResult {
  ok: boolean;
  status?: number;
  body: unknown;
}

export function dispatchTool(
  tools: Map<string, ToolDef>,
  toolName: string,
  rawArgs: unknown,
  ctx: AuthContext,
  db: Database,
): DispatchResult {
  if (ADMIN_TOOLS.has(toolName) && ctx.role !== "admin") {
    incrementError("admin_403");
    return { ok: false, status: 403, body: { error: "forbidden" } };
  }
  const tool = tools.get(toolName);
  if (!tool) {
    return { ok: false, status: 404, body: { error: "unknown_tool", tool: toolName } };
  }
  let args: unknown;
  try {
    args = tool.schema.parse(rawArgs);
  } catch (err: unknown) {
    const issues = (err as { issues?: unknown } | undefined)?.issues;
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_args", issues: issues ?? String(err) },
    };
  }
  try {
    const result = tool.handler(args, ctx, db);
    return { ok: true, body: result };
  } catch (err: unknown) {
    if (err instanceof AdminToolError) {
      return { ok: false, status: 400, body: { error: err.code } };
    }
    throw err;
  }
}
