import type { Database } from "bun:sqlite";
import type { AuthContext } from "../auth/middleware";
import { buildToolRegistry } from "./registry";
import { dispatchTool, type ToolDef } from "./dispatch";

export interface McpRequestBody {
  tool: string;
  args?: unknown;
}

export function createMcpHandler(
  tools: Map<string, ToolDef> = buildToolRegistry(),
): (request: Request, ctx: AuthContext, db: Database) => Promise<Response> {
  return async (request, ctx, db) => {
    let parsed: McpRequestBody;
    try {
      parsed = (await request.json()) as McpRequestBody;
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    if (!parsed || typeof parsed.tool !== "string") {
      return jsonResponse(400, { error: "missing_tool" });
    }

    const result = dispatchTool(tools, parsed.tool, parsed.args ?? {}, ctx, db);
    if (!result.ok) {
      return jsonResponse(result.status ?? 400, result.body);
    }
    return jsonResponse(200, result.body);
  };
}

export function listTools(tools: Map<string, ToolDef> = buildToolRegistry()): string[] {
  return [...tools.keys()].sort();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
