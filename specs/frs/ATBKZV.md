---
title: Typed MCP tool inputSchema + extraction noise suppression
milestone: M10
status: active
archived_at: null
id: fr_01KSS7VW8F3AQDT7TB54ATBKZV
created_at: 2026-05-29T06:48:36Z
---

## Requirement

Two defects found during the M-series install smoke on a real schema-driven MCP
client:

**A. MCP tools advertise no argument types.** `src/mcp/server.ts` registers every
tool with an empty passthrough `inputSchema` (`z.looseObject({})`), so the
`tools/list` surface declares zero argument properties. A schema-driven client
therefore cannot encode non-string args: array-valued args
(`search_memory.entities`, `types`, `sub_projects`, …) get serialized as strings,
and the handler's strict Zod rejects them as `invalid_args`. `search_memory` is
effectively undrivable from such clients; `ask_memory` works only because its sole
arg is a string. The handler itself is correct — raw `{entities:["x"]}` works
(proven by `scripts/smoke-test.sh`); only the advertised schema is wrong.

**B. The agent's own tool-search activity becomes Decision nodes.** `PostToolUse`
forwards every tool call, including introspection/tool-search. The extractor then
mints low-value `Decision` nodes from it (observed: a
`"Search for mcp__quack__search_memory tool"` node). Non-secret, but pollutes the
graph.

This FR delivers:

1. (A) Per-tool typed `inputSchema` derived from each tool's Zod schema, advertised
   over `tools/list`, **while keeping the handler-level `safeParse` as the
   validation authority** so `AC-WSFVNP.10` (`invalid_args` + Zod error path) is
   preserved byte-for-byte.
2. (B, layered) A client-hook drop of introspection/tool-search activity before
   egress, **and** an extractor-prompt hardening so meta-activity never becomes a
   graph node.

Secret redaction is orthogonal and unchanged — secrets are already stripped
client-side (`plugins/quack/hooks/_lib/redact.ts`) and server-side (`src/extract/`).

## Acceptance Criteria

- AC-ATBKZV.1: Every MCP tool (memory + admin) advertises an `inputSchema` whose `properties` declare the real argument types derived from the tool's Zod schema — e.g. `search_memory` advertises `entities: {type:"array", items:{type:"string"}}`, `types`/`sub_projects` as arrays, `limit` as integer. The empty `z.looseObject({})` passthrough is removed. (Verify: `tools/list` for `search_memory` has `inputSchema.properties.entities.type === "array"`.)
- AC-ATBKZV.2: A schema-driven MCP client can call `search_memory` with an array `entities` arg; the array arrives as an array (not stringified) and dispatches to the handler. (Verify: MCP-HTTP integration test with `{entities:["x"]}` returns a normal result envelope, not `invalid_args`.)
- AC-ATBKZV.3: `AC-WSFVNP.10` preserved — args failing the tool's strict Zod schema (wrong type, missing required field, empty array) still produce the MCP tool-error `invalid_args` with the Zod issue path, **not** a raw JSON-RPC `-32602`; no DB/graph call made. The handler-level `safeParse` remains the sole validation authority. (Verify: `search_memory` with `{entities:5}` and with `{}` both yield `invalid_args`.)
- AC-ATBKZV.4: The typed-schema change is applied uniformly through the shared registration layer (`reg`/`wrap*` in `src/mcp/server.ts`); no per-tool ad-hoc duplication. (Verify: a test enumerates `listTools()` and asserts every advertised `inputSchema.properties` is non-empty.)
- AC-ATBKZV.5: The client hook does not forward `PostToolUse` envelopes whose `tool_name` is in a centralized `META_TOOLS` set (tool-search / tool-discovery introspection); they are dropped before the POST to `/ingest` (fire-and-forget, exit 0). `SessionStart`/`Stop` are unaffected. (Verify: a `PostToolUse` payload with a `META_TOOLS` tool name produces no outbound POST; a non-meta tool still posts.)
- AC-ATBKZV.6: The extractor system prompt instructs the cheap model never to create `Decision`/`Entity` nodes from tool-search / meta tool-activity; a tool-search-shaped payload yields zero `Decision` nodes, while a genuine decision payload still yields one. (Verify: extraction test asserts both directions — no over-filtering.)

## Technical Design

### Modules

- **`src/mcp/server.ts`** — remove `passthroughSchema = z.looseObject({})`; route each tool's existing Zod schema through the shared `reg`/`wrap*` layer so `mcp.registerTool` receives a typed advertise schema. Two candidate mechanisms (decide at implement against the installed `@modelcontextprotocol/sdk` ^1.29):
  - **(i, preferred)** advertise a typed-but-relaxed shape (correct property types, fields `.optional()`/loose) so the SDK forwards args and emits typed JSON Schema, but never preempts the handler; the handler's strict `safeParse` stays the validation authority → `invalid_args` unchanged.
  - **(ii)** advertise the strict shape and remap the SDK's `-32602` to the `invalid_args` tool-error at the dispatch boundary.

  Preference (i): smallest behavioral change, keeps `AC-WSFVNP.10` byte-identical. Confirm the SDK emits typed JSON Schema for optional/loose fields before committing to (i).
- **`plugins/quack/hooks/_lib/`** — add a `META_TOOLS` skip in the dispatch/redact path: if a `PostToolUse` `tool_name` ∈ `META_TOOLS`, return before POST. `META_TOOLS` is a single exported const in `_lib/shared/`, referenced by the hook drop and documentable in the plugin README.
- **`src/extract/`** — extend the extractor system prompt with the no-`Decision`/`Entity`-from-meta-activity rule. Secret-redaction passes unchanged.

### Data model

No schema change — no new node kinds, no Neo4j migration.

### Out of scope

- Changing the node taxonomy.
- Retroactively cleaning noise nodes already present in the graph.
- Any change to secret redaction (orthogonal — secrets are already stripped).

## Testing

- `src/mcp/server.test.ts` — assert typed `properties` in `tools/list` for `search_memory` and that every tool's `inputSchema.properties` is non-empty; integration `{entities:["x"]}` succeeds; `{entities:5}` and `{}` → `invalid_args` (not `-32602`), no DB/graph call. Reuse the existing MCP-HTTP client harness.
- `plugins/quack/hooks/_lib/__tests__/` — a `META_TOOLS` payload produces no outbound POST (spy on `post`); a non-meta tool still posts; `META_TOOLS` membership asserted.
- `src/extract/*.test.ts` — a tool-search-shaped payload yields zero `Decision` nodes; a genuine decision payload still yields one (over-filtering guard).
- Gate: `bunx tsc --noEmit && bun run test`.

## Notes

- A's root cause is deliberate (`AC-WSFVNP.10`): tools were registered without `inputSchema` to control the validation error contract, and the empty passthrough was needed because the SDK drops args entirely when `inputSchema` is omitted. The unintended cost was lost type hints; this FR keeps the contract and adds the hints.
- B is precision, not security: secrets are already redacted client- and server-side; meta-activity is non-secret noise. The layered fix (hook drop + extractor prompt) is deliberate per the design decision recorded for this FR.
- Found during the M-series install smoke on a live cmux session; `scripts/smoke-test.sh` already proves the handler accepts raw array args, isolating the defect to the advertised schema.
- Consider documenting `META_TOOLS` in the plugin README hooks section so operators understand which tool calls are intentionally not memory-bearing.
