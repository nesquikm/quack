---
title: Typed MCP tool inputSchema (schema-driven clients can drive array args)
milestone: M10
status: archived
archived_at: 2026-05-29T11:54:11Z
id: fr_01KSS7VW8F3AQDT7TB54ATBKZV
created_at: 2026-05-29T06:48:36Z
---

## Requirement

`src/mcp/server.ts` registers every MCP tool with an empty passthrough
`inputSchema` (`z.looseObject({})`), so the `tools/list` surface declares zero
argument properties. A schema-driven client therefore cannot encode non-string
args: array-valued args (`search_memory.entities`, `types`, `sub_projects`, …) get
serialized as strings, and the handler's strict Zod rejects them as `invalid_args`.
`search_memory` is effectively undrivable from such clients; `ask_memory` works only
because its sole arg is a string. The handler itself is correct — raw
`{entities:["x"]}` works (proven by `scripts/smoke-test.sh`); only the advertised
schema is wrong. Found during the M-series install smoke on a live schema-driven
MCP client (`/private/tmp/quack-memory-findings.md` Finding 1).

This FR advertises per-tool typed `inputSchema` derived from each tool's Zod schema
over `tools/list`, **while keeping the handler-level `safeParse` as the validation
authority** so `AC-WSFVNP.10` (`invalid_args` + Zod error path) is preserved
byte-for-byte.

The extraction-noise concern originally bundled here (a meta-activity hook filter +
an extractor decision-worthiness gate) has moved to **FR-Z1W6ED**.

## Acceptance Criteria

- AC-ATBKZV.1: Every MCP tool (memory + admin) advertises an `inputSchema` whose `properties` declare the real argument types derived from the tool's Zod schema — e.g. `search_memory` advertises `entities: {type:"array", items:{type:"string"}}`, `types`/`sub_projects` as arrays, `limit` as integer. The empty `z.looseObject({})` passthrough is removed. (Verify: `tools/list` for `search_memory` has `inputSchema.properties.entities.type === "array"`.)
- AC-ATBKZV.2: A schema-driven MCP client can call `search_memory` with an array `entities` arg; the array arrives as an array (not stringified) and dispatches to the handler. (Verify: MCP-HTTP integration test with `{entities:["x"]}` returns a normal result envelope, not `invalid_args`.)
- AC-ATBKZV.3: `AC-WSFVNP.10` preserved — args failing the tool's strict Zod schema (wrong type, missing required field, empty array) still produce the MCP tool-error `invalid_args` with the Zod issue path, **not** a raw JSON-RPC `-32602`; no DB/graph call made. The handler-level `safeParse` remains the sole validation authority. (Verify: `search_memory` with `{entities:5}` and with `{}` both yield `invalid_args`.)
- AC-ATBKZV.4: The typed-schema change is applied uniformly through the shared registration layer (`reg`/`wrap*` in `src/mcp/server.ts`); no per-tool ad-hoc duplication (a single `reg` helper, no parallel registration path). Arg-bearing tools (e.g. `search_memory`) advertise real, non-empty typed `properties`; genuinely no-arg tools (e.g. `list_users`, `list_projects`, `server_status`, `cleanup_status`) advertise a valid empty object schema (`{type:"object", properties:{}}`) — never a phantom placeholder property. The empty `z.looseObject({})` passthrough is removed for every tool. (Verify: a test enumerates `listTools()` and asserts arg-bearing tools have non-empty typed `properties`, no-arg tools advertise an empty-`properties` object schema, and no tool retains the loose passthrough.)

## Technical Design

### Modules

- **`src/mcp/server.ts`** — remove `passthroughSchema = z.looseObject({})`; route each tool's existing Zod schema through the shared `reg`/`wrap*` layer so `mcp.registerTool` receives a typed advertise schema. Two candidate mechanisms (decide at implement against the installed `@modelcontextprotocol/sdk` ^1.29):
  - **(i, preferred)** advertise a typed-but-relaxed shape (correct property types, fields `.optional()`/loose) so the SDK forwards args and emits typed JSON Schema, but never preempts the handler; the handler's strict `safeParse` stays the validation authority → `invalid_args` unchanged.
  - **(ii)** advertise the strict shape and remap the SDK's `-32602` to the `invalid_args` tool-error at the dispatch boundary.

  Preference (i): smallest behavioral change, keeps `AC-WSFVNP.10` byte-identical. Confirm the SDK emits typed JSON Schema for optional/loose fields before committing to (i).

### Data model

No schema change — no new node kinds, no Neo4j migration.

### Out of scope

- Extraction noise suppression (meta-activity hook filter + decision-worthiness gate) — moved to FR-Z1W6ED.
- Any change to the validation error contract beyond preserving `AC-WSFVNP.10`.

## Testing

- `src/mcp/server.test.ts` — assert typed `properties` in `tools/list` for `search_memory` and that every tool's `inputSchema.properties` is non-empty; integration `{entities:["x"]}` succeeds; `{entities:5}` and `{}` → `invalid_args` (not `-32602`), no DB/graph call. Reuse the existing MCP-HTTP client harness.
- Gate: `bunx tsc --noEmit && bun run test`.

## Notes

- Root cause is deliberate (`AC-WSFVNP.10`): tools were registered without `inputSchema` to control the validation error contract, and the empty passthrough was needed because the SDK drops args entirely when `inputSchema` is omitted. The unintended cost was lost type hints; this FR keeps the contract and adds the hints.
- `scripts/smoke-test.sh` already proves the handler accepts raw array args, isolating the defect to the advertised schema.
- AC-ATBKZV.4 narrowed during /implement (M10): the original "every tool's `properties` is non-empty" wording contradicted reality for genuinely no-arg admin tools (`list_users`, `list_projects`, `server_status`, `cleanup_status`), which correctly advertise an empty object schema. Forcing non-empty properties there would have meant a phantom placeholder arg — manifest noise contrary to this milestone's denoise intent. The AC now distinguishes arg-bearing (typed non-empty properties) from no-arg (valid empty object schema) tools, applied through a single shared `reg` helper. Operator-approved.
