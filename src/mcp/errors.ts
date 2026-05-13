// MCP tool error codes surfaced as isError: true CallToolResult bodies. The
// admin tools use AdminToolError; memory tools use these for their non-admin
// failure surface (planner-mode-not-yet, no-adapter-wired, etc.).

export class MemoryToolError extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message?: string, extra: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = "MemoryToolError";
    this.code = code;
    this.extra = extra;
  }
}

export const ERR_NOT_IMPLEMENTED_YET = "not_implemented_yet";
export const ERR_NO_GRAPH_ADAPTER = "no_graph_adapter";
