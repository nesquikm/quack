// META_TOOLS — the centralized set of agent tool-search / tool-discovery
// introspection tools whose `PostToolUse` activity is the agent's own meta
// chatter, NOT project signal. The client hook drops these envelopes before
// egress so introspection noise (e.g. "Search for mcp__quack__search_memory
// tool") never reaches `/ingest` or the cheap model (FR-Z1W6ED AC.1).
//
// Single source of truth — referenced by the dispatch drop and documentable in
// the plugin README. Extend this set as new tool-discovery surfaces appear.
export const META_TOOLS: ReadonlySet<string> = new Set<string>([
  "ToolSearch",
]);

// True when `toolName` is a meta/tool-search tool whose activity must be dropped
// before egress. Non-string / unknown tool names are never meta.
export function isMetaTool(toolName: unknown): boolean {
  return typeof toolName === "string" && META_TOOLS.has(toolName);
}
