import type { Database } from "bun:sqlite";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../../package.json" with { type: "json" };

import type { AuthContext } from "../auth/middleware";
import { applyAdminGate, ForbiddenError } from "./gate";
import { AdminToolError } from "../admin/errors";

import { registerUser, registerUserSchema } from "../admin/tools/register_user";
import { removeUser, removeUserSchema } from "../admin/tools/remove_user";
import { createProject, createProjectSchema } from "../admin/tools/create_project";
import { deleteProject, deleteProjectSchema } from "../admin/tools/delete_project";
import { addMember, addMemberSchema } from "../admin/tools/add_member";
import { removeMember, removeMemberSchema } from "../admin/tools/remove_member";
import { revokeToken, revokeTokenSchema } from "../admin/tools/revoke_token";
import { listProjects, listProjectsSchema } from "../admin/tools/list_projects";
import { listUsers, listUsersSchema } from "../admin/tools/list_users";
import { serverStatus, serverStatusSchema } from "../admin/tools/server_status";

const SERVER_VERSION = (packageJson as { version: string }).version;

// The MCP SDK has its own inputSchema-based validation, but its failure mode is
// a JSON-RPC -32602 error with message "Invalid parameters" — which doesn't
// match AC-WSFVNP.10's literal `invalid_args` MCP tool-error contract. So we
// register tools WITHOUT inputSchema and run our own zod validation inside the
// handler, surfacing the AC-mandated `invalid_args` code with the Zod issue path.
type ToolHandler<A> = (args: A, ctx: AuthContext, db: Database) => unknown;

interface RequestContext { ctx: AuthContext; db: Database }

const CONTEXT_KEY = "quack:request";

function extractContext(extra: unknown): RequestContext {
  const ai = (extra as { authInfo?: { extra?: Record<string, unknown> } } | undefined)?.authInfo?.extra;
  const rc = ai?.[CONTEXT_KEY] as RequestContext | undefined;
  if (!rc) throw new Error("missing request context (server bug — authInfo not threaded)");
  return rc;
}

function ok(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

function errResult(error: string, status?: number): CallToolResult {
  const payload = status ? { error, status } : { error };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function wrap<A>(
  name: string,
  schema: z.ZodType<A>,
  handler: ToolHandler<A>,
): (args: unknown, extra: unknown) => CallToolResult {
  return (args, extra) => {
    const { ctx, db } = extractContext(extra);
    try {
      applyAdminGate(name, ctx);
    } catch (err) {
      if (err instanceof ForbiddenError) return errResult("forbidden", 403);
      throw err;
    }
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) {
      // AC-WSFVNP.10: validation failure ⇒ MCP tool-error `invalid_args` with the Zod error path; no DB call made.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "invalid_args",
              issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
            }),
          },
        ],
      };
    }
    try {
      return ok(handler(parsed.data, ctx, db));
    } catch (err) {
      if (err instanceof AdminToolError) return errResult(err.code, 400);
      throw err;
    }
  };
}

export function buildMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "quack", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Permissive passthrough schema: lets any object-shaped args reach the wrapper,
  // which then runs the tool's real zod schema and emits the AC-mandated
  // `invalid_args` tool error before any DB call. Required because the SDK
  // doesn't forward args at all when `inputSchema` is omitted.
  const passthroughSchema = z.looseObject({});

  const reg = (name: string, description: string, cb: (args: unknown, extra: unknown) => CallToolResult) => {
    mcp.registerTool(
      name,
      { description, inputSchema: passthroughSchema },
      cb as Parameters<typeof mcp.registerTool>[2],
    );
  };

  reg(
    "register_user",
    "Admin-only. Create a member user and mint a one-time plaintext token bound to the _control_ project.",
    wrap("register_user", registerUserSchema, registerUser as ToolHandler<{ username: string }>),
  );
  reg(
    "remove_user",
    "Admin-only. Delete a user; cascades to project_members and tokens. Refuses to remove the last admin or self.",
    wrap("remove_user", removeUserSchema, removeUser as ToolHandler<{ username: string }>),
  );
  reg(
    "create_project",
    "Admin-only. Create a new project. Slug must match /^[a-z0-9][a-z0-9_-]{0,62}$/; leading underscore is reserved.",
    wrap("create_project", createProjectSchema, createProject as ToolHandler<{ slug: string; display_name: string }>),
  );
  reg(
    "delete_project",
    "Admin-only. Delete a project (cascades) and queue graph-partition cleanup. Refuses _control_.",
    wrap("delete_project", deleteProjectSchema, deleteProject as ToolHandler<{ slug: string }>),
  );
  reg(
    "add_member",
    "Admin-only. Add a user to a project at the given role and mint a one-time plaintext token bound to that pair.",
    wrap("add_member", addMemberSchema, addMember as ToolHandler<{ username: string; project_slug: string; role: "admin" | "member" }>),
  );
  reg(
    "remove_member",
    "Admin-only. Remove a project membership and revoke that pair's active tokens. Returns revocation count.",
    wrap("remove_member", removeMemberSchema, removeMember as ToolHandler<{ username: string; project_slug: string }>),
  );
  reg(
    "revoke_token",
    "Admin-only. Revoke an active token by id. Uniform not_found for unknown / already-revoked (no oracle).",
    wrap("revoke_token", revokeTokenSchema, revokeToken as ToolHandler<{ token_id: number }>),
  );
  reg(
    "list_projects",
    "Admin sees every project; non-admin sees only projects they are a member of.",
    wrap("list_projects", listProjectsSchema, listProjects as ToolHandler<Record<string, never>>),
  );
  reg(
    "list_users",
    "Admin-only. List every user as DTO (no token data).",
    wrap("list_users", listUsersSchema, listUsers as ToolHandler<Record<string, never>>),
  );
  reg(
    "server_status",
    "Admin-only. Snapshot only — no streaming, no history. Returns uptime, queue stats (null in M2), error counts, and seeded counts.",
    wrap("server_status", serverStatusSchema, serverStatus as ToolHandler<Record<string, never>>),
  );

  return mcp;
}

export function createMcpHandler(): (request: Request, ctx: AuthContext, db: Database) => Promise<Response> {
  // Stateless streamable-HTTP transport requires a fresh transport per request
  // (SDK refuses to reuse one across requests in stateless mode). The McpServer
  // is also rebuilt per request: it's just tool-registration metadata + closures
  // and the cost is dominated by the SQLite work anyway.
  return async (request: Request, ctx: AuthContext, db: Database): Promise<Response> => {
    const mcp = buildMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    const requestCtx: RequestContext = { ctx, db };
    return transport.handleRequest(request, {
      authInfo: {
        token: "internal",
        clientId: String(ctx.user_id),
        scopes: ctx.role === "admin" ? ["admin"] : ["member"],
        extra: { [CONTEXT_KEY]: requestCtx },
      },
    });
  };
}

export function listTools(): string[] {
  return [
    "add_member",
    "create_project",
    "delete_project",
    "list_projects",
    "list_users",
    "register_user",
    "remove_member",
    "remove_user",
    "revoke_token",
    "server_status",
  ];
}
