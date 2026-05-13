---
title: add_memory MCP tool (LLM-digested writes to knowledge base)
milestone: M5
status: archived
archived_at: 2026-05-13T16:46:07Z
id: fr_01KRH0B3W2VFACRC113Z41NXTZ
created_at: 2026-05-13T11:30:00Z
---

## Requirement

Add a single MCP tool `add_memory({ content })` that lets the caller (Claude Code, a `/quack:remember` plugin command, or any MCP client) push free-form content into the knowledge base. Routing is **identical to hooks**: content is wrapped in a synthetic `HookEnvelope` with `kind: "explicit_add"`, validated, enqueued via the existing FR-4NY6S1 path, and processed by the same extractor → cheap-model → MERGE-templates pipeline.

**Fire-and-forget** — no status tracking, no `request_id`, no polling tool, no `:ExtractRequest` nodes, no new SQLite table. Returns 202-style `{ accepted, queued_at }` like `POST /ingest`. Member-or-admin readable; scoped by `ctx.project_id`. To verify a memory landed, the caller queries `search_memory` after a short delay — same UX contract hooks already have.

The extraction prompt is extended with a `kind: "explicit_add"` branch that frames `content` as a user-asserted fact (rather than a hook-payload session event). All other modules (queue, writer, redaction, MERGE templates, dead-letter, counters) are reused unchanged.

## Acceptance Criteria

- AC-41NXTZ.1: `add_memory({ content })` is registered as an MCP tool on `/mcp`. **Member-readable** — NOT added to the `ADMIN_TOOLS` allowlist. Member-role tokens invoke successfully; missing/revoked tokens → 401 via `AuthMiddleware` (unchanged). Non-admin-with-valid-token never sees 403 from this tool.
- AC-41NXTZ.2: Zod schema for args: `{ content: string }` with `min(1)` and `max(QUACK_ADD_MEMORY_MAX_BYTES)`. `QUACK_ADD_MEMORY_MAX_BYTES` is a new env var (Zod, default 32768). Validation failure ⇒ MCP error code `invalid_args` carrying the Zod issue path; no DB call is made.
- AC-41NXTZ.3: Server builds a synthetic envelope:
  ```ts
  { kind: "explicit_add", payload: { content }, project_slug, ts: new Date().toISOString() }
  ```
  `project_slug` is resolved from `ctx.project_id` via a cached lookup (`SELECT slug FROM projects WHERE id = ?` against `auth.sqlite`). Cache is per-process, invalidated when `delete_project` runs (existing admin tool; emit invalidation signal) — or, simpler, no cache (the SELECT is sub-ms on the primary key). Per-call query is the v1 default; cache is an optional optimization.
- AC-41NXTZ.4: The synthetic envelope is enqueued via the SAME `enqueue()` function used by `POST /ingest` (FR-4NY6S1 AC.2 / AC.3). Successful enqueue ⇒ MCP response `{ accepted: true, queued_at: ISO8601 }`. Queue full ⇒ `{ accepted: false, reason: "queue_full", queued_at: null }` — same shape as `/ingest` HTTP backpressure.
- AC-41NXTZ.5: `HookKind` Zod union (the canonical type from FR-4NY6S1 AC.1) is extended to include `"explicit_add"`. Order: `"session_start" | "stop" | "post_tool_use" | "explicit_add"`. Backward-compatible — existing hook clients are unaffected; `src/ingest/handler.ts`'s `HookEnvelope` Zod validator accepts the new kind without code changes beyond the union extension.
- AC-41NXTZ.6: Redaction pass (FR-4NY6S1 AC.5 / `src/extract/redact.ts`) runs against `payload.content` **before** the cheap-model call — same default pattern set, same `src/shared/redaction_patterns.ts` shared module. Defense-in-depth: MCP callers are inherently more trusted than arbitrary hook payloads, but the secret-shape filter still applies (an LLM agent might inadvertently include a secret in `content`).
- AC-41NXTZ.7: Extraction prompt template (`src/extract/prompt.ts`) is extended with a conditional branch on `envelope.kind === "explicit_add"`. The branch:
  - Frames `payload.content` as a user-asserted fact: *"The user explicitly asserted the following content. Extract entities, decisions, relations, files, symbols, and feedback exactly as the user stated them."*
  - Reuses the SAME output `ExtractionResult` schema (FR-4NY6S1 AC.7) — same five node types, same five relation types, same JSON shape.
  - Hook-kind branches (`session_start`, `stop`, `post_tool_use`) are unchanged.
  
  The branch is byte-localized to one section of the prompt template — easy to revise without rippling into hook ingestion paths.
- AC-41NXTZ.8: Graph writes go through the SAME `MERGE` templates from FR-4NY6S1 AC.9 (`upsert_entity`, `upsert_decision`, `upsert_file`, `upsert_symbol`, `upsert_feedback`, `upsert_relation`). NO new templates. Cross-tenant isolation: extracted nodes carry `ctx.project_id`; the writer's model-supplied-`project_id` override defense (FR-4NY6S1 AC.12) applies unchanged.
- AC-41NXTZ.9: MCP tool description (manifest text the client sees when listing tools) states verbatim: *"Enqueues content for LLM digestion into the project's memory. Fire-and-forget — returns immediately. Memories become available shortly via search_memory after server-side extraction completes. No status polling — check via search_memory after a short delay."* Claude Code reading the manifest knows the contract (no poll-after-write expected; check via search).
- AC-41NXTZ.10: Counter integration — uses the existing FR-4NY6S1 counters (`queue.accepted_total`, `queue.dropped_full_total`) which fire from the shared `enqueue()` path. Additionally, increment `errors.by_category.explicit_add_received` (info-level, info-only — not a failure category) per successful enqueue so operators can see add_memory-vs-hooks traffic in `server_status`. The new category is added to the static list documented in FR-956DT2 AC.5 (extension; non-breaking).
- AC-41NXTZ.11: Tests:
  - `src/mcp/tools/memory/add_memory.test.ts`: happy path (returns `accepted: true` + valid `queued_at`); Zod refusal on empty content; Zod refusal on oversized content (`QUACK_ADD_MEMORY_MAX_BYTES + 1`); queue-full backpressure returns `{ accepted: false, reason: "queue_full" }`; member-role caller succeeds (NOT admin-gated); non-token call fails at AuthMiddleware (401, before tool dispatch).
  - `src/extract/prompt.test.ts` extended: `kind: "explicit_add"` produces a prompt body that contains the literal canonical marker phrase (e.g., `"user-asserted fact"`); hook-kind prompts are byte-unchanged.
  - `src/mcp/tools/memory/cross_tenant.test.ts` extended: token for project A calls `add_memory`; cheap-model mocked to return a known ExtractionResult; assert nodes created in Neo4j carry project A's `project_id`, NOT project B's; assert `search_memory` invoked with project B's token never returns the content.
  - `src/extract/pipeline.test.ts` extended: full e2e — MCP HTTP client calls `add_memory({ content: "I prefer Bun over Node for this project" })`, mocked model emits a known `ExtractionResult` (one `Feedback` node + one `Entity` "Bun" + one `Entity` "Node" + one `RELATED_TO` relation), drive consumer, assert `MATCH (n {project_id: $pid}) RETURN n` returns the expected nodes.

## Technical Design

### Modules

- **New: `src/mcp/tools/memory/add_memory.ts`** — Zod schema + handler. Resolves `project_slug` from `auth.sqlite`, builds the synthetic envelope, calls `enqueueEnvelope()`, returns the 202-style response.
- **Extended: `src/ingest/types.ts`** (or wherever `HookKind` lives) — adds `"explicit_add"` to the union literal.
- **Extended: `src/extract/prompt.ts`** — adds the `explicit_add` branch as a single new template section.
- **Extended: `src/mcp/server.ts`** — registers `add_memory` alongside the four read tools (`search_memory`, `get_neighbors`, `path_between`, `recent_decisions`). Total memory-plane surface becomes 5 tools (4 read + 1 write).
- **Extended: `src/shared/env.ts`** — adds `QUACK_ADD_MEMORY_MAX_BYTES` (default 32768).
- **Extended: `src/metrics/counters.ts`** — adds `explicit_add_received` to the info-level categories enumerated in the snapshot output.

### No new infrastructure

- No new SQLite table.
- No new Neo4j node label.
- No schema migration.
- No new MERGE templates.
- No new dependencies.

The entire FR is glue + a prompt branch. The heavy lifting (extraction, redaction, graph writes, cross-tenant isolation) already exists from FR-4NY6S1.

### Out of scope

- `get_memory_status` tool, request_id tracking, `:ExtractRequest` nodes — explicitly rejected during `/brainstorm`. Fire-and-forget is the design.
- `/quack:remember <content>` plugin slash command (M4 plugin already shipped; adding a new command is a separate plugin-side FR).
- Per-tool rate limiting beyond the queue's existing backpressure.
- Content-hash dedupe before the LLM call — rely on `MERGE` idempotency at the storage layer.
- Per-project content-size policy override (single `QUACK_ADD_MEMORY_MAX_BYTES` env var for v1).

## Testing

- `src/mcp/tools/memory/add_memory.test.ts` — full per-AC coverage (AC.1 through AC.4 and AC.10).
- `src/extract/prompt.test.ts` (extended) — AC.7 verification.
- `src/mcp/tools/memory/cross_tenant.test.ts` (extended) — AC.8 isolation.
- `src/extract/pipeline.test.ts` (extended) — AC.11 e2e.
- `src/admin/tools/server_status.test.ts` (extended) — assert `explicit_add_received` category visible in the snapshot when it has been incremented.
- Manifest description assertion — a `src/mcp/server.test.ts` snapshot or string check that the tool's manifest text matches AC.9's verbatim string.

## Notes

- The user's design instinct ("we already route data through the LLM via hooks; the new MCP tool should do the same") is what makes this FR so small. The whole point of the extraction pipeline is to be the SINGLE canonical write path; `add_memory` reuses it instead of inventing a new mechanism.
- "Fire-and-forget with no status tracking" mirrors the hook contract. If a caller wants to verify a memory landed, they call `search_memory` after a short delay. This is a documented part of the tool's manifest description (AC.9) so Claude Code's planning matches the actual semantics.
- The `explicit_add_received` counter is info-level (NOT a failure category) — it shows up in `server_status.errors.by_category` purely so operators can observe write traffic split. Renaming the SQLite-`errors`-category to `events` or similar would be cleaner but is out of scope (FR-956DT2 AC.5 already cemented the shape).
- Future plugin command `/quack:remember <content>`: trivial — calls `add_memory({ content })` server-side; just a markdown file under `plugins/quack/commands/`. Defer to a small plugin-side FR after M5 ships.
- Future per-project content-size override: would add a `project.add_memory_max_bytes` column to `auth.sqlite.projects` (or a settings JSON column). v1's single env var is fine.
- Provenance / "what added this" question — explicitly out of scope. If it becomes important later, we can add a `request_id` property to extracted nodes without storing the request itself; `add_memory`'s response can include the request_id even though there's no status tool. Easy additive change.

## Implementation notes

- `no_ingest_queue` 503 defense-in-depth path in `src/mcp/server.ts` — defensive 503 return when `ingestQueue` is undefined. Unreachable in production after the AC.4 wiring fix (verified by the `mcp/server.test.ts` wiring regression test). Kept as defense-in-depth; not gate-blocking. Future reviewer: do not strip as dead code without a regression test still covering the wiring contract.
- `incrementError("explicit_add_received")` routes an info-level traffic counter through the error counter store — inflates `errors.since_boot_total` by every successful `add_memory` call. Acknowledged in the Notes section above as a deliberate compromise pinned by FR-956DT2 AC.5; a future `server_status` v2 with an `events` bucket is the clean path.
- `addMemorySchema`'s max-byte cap is fixed at module-load time via `getAddMemoryMaxBytes()`. Operators changing `QUACK_ADD_MEMORY_MAX_BYTES` at runtime won't see the new cap without restart — matches normal env-var semantics; per-call schema construction was rejected as unjustified for this property.
