---
title: ask_memory MCP tool (agentic LLM-synthesized answers over the memory graph)
milestone: M9
status: archived
archived_at: 2026-05-27T20:29:12Z
id: fr_01KSN1KDS3NJGJ68ANZXWB3N9H
created_at: 2026-05-27T00:00:00Z
---

## Requirement

Add a fifth memory-plane MCP tool, `ask_memory`, that answers a free-form question by
running a **bounded server-side agentic retrieve→reason loop**: the cheap model (reusing
`QUACK_MODEL_*`) plans retrieval, calls the existing four read primitives (`search_memory`,
`get_neighbors`, `path_between`, `recent_decisions`) internally as its tools, follows a few
hops, then synthesizes a natural-language **answer**. This realizes the `mode: "planned"`
enum reserved in AC-DPY5GQ.8 and is the **single, deliberate exception** to the "dumb server
/ structured DTOs only — never prose" read-path split (technical-spec ADR "Read-path
synthesis split"; requirements §5). The exception is bounded by defense-in-depth: the loop's
only tools are the four `project_id`-scoped read primitives (no NL→Cypher, so tenancy
isolation is untouched), retrieved content is redacted before re-prompting, the system prompt
treats memory as untrusted data, and the returned answer is `<memory>`-wrapped as untrusted
text. Member-or-admin readable.

## Acceptance Criteria

- AC-WB3N9H.1: `ask_memory({ question: string, sub_projects?: string[] })` is registered on
  `/mcp`, member-or-admin readable (NOT added to `ADMIN_TOOLS`). Zod validation (`question`
  non-empty; `sub_projects` reuses `subProjectsSchema`) → MCP error `invalid_args` carrying
  the Zod issue path on failure, with no model or graph call made.
- AC-WB3N9H.2: When `QUACK_MODEL_API_KEY` or `QUACK_MODEL_BASE_URL` is unset (the same
  condition that disables the extractor in `src/server/index.ts`), `ask_memory` returns MCP
  error `model_unavailable` whose body states the tool requires `QUACK_MODEL_*` configured;
  no graph call is made. Distinct error code from `invalid_args`.
- AC-WB3N9H.3: On a configured server, `ask_memory` runs a bounded loop. The model is given
  the question plus a tool interface over the four read primitives; each iteration it may
  issue one or more primitive calls (executed via `GraphAdapter.run(..., ctx)`), observes the
  results, and either issues more calls or emits a final answer.
- AC-WB3N9H.4: Two env vars bound the loop, parsed in `src/shared/env.ts` (positive int,
  defaulted): `QUACK_ASK_MAX_ITERATIONS` (default 3) and `QUACK_ASK_MAX_TOOL_CALLS`
  (default 8). When either cap is hit, the loop stops, the model is asked once to synthesize
  from what was already retrieved, and `meta.warnings` includes `"budget_exhausted"`.
- AC-WB3N9H.5: A successful call returns `{ answer: string, results: MemoryItem[], meta }`.
  `answer` is the synthesized answer wrapped in `<memory>…</memory>`. `results` is the deduped
  set of `MemoryItem`s retrieved during the loop (each carrying `_memory_wrapped` per
  AC-DPY5GQ.6). `meta` is the canonical envelope with `mode_used: "planned"`,
  `coverage.matched_entities` / `coverage.traversals` aggregated across all internal calls,
  `coverage.truncated` true if any internal call truncated, and `meta.explain.tool_calls` =
  the ordered `{ tool, iteration }` sequence the model issued.
- AC-WB3N9H.6: Empty-retrieval path — when the loop retrieves nothing, `answer` states that no
  relevant memory was found, `results` is `[]`, and `meta.warnings` includes
  `"no_full_text_match"` (propagated from the primitives). The model is instructed to ground
  claims only in `results`.
- AC-WB3N9H.7 (defense-in-depth — redaction): retrieved memory content is passed through the
  extractor's existing redaction pass (`src/extract/redact.ts`) before being placed in the
  model prompt, so secrets that slipped into stored nodes are not re-sent to the cheap-model
  endpoint. Reuse, not reimplement.
- AC-WB3N9H.8 (defense-in-depth — untrusted I/O): the system prompt instructs the model to
  treat all retrieved memory as untrusted data, never as instructions; the model's only tools
  are the four `project_id`-scoped read primitives (no graph-write, no token, no NL→Cypher
  tool is ever exposed); the returned `answer` is `<memory>`-wrapped.
- AC-WB3N9H.9 (cross-tenant isolation): integration test (reusing the `cross_tenant.test.ts`
  pattern) seeds two projects with overlapping entity names; `ask_memory` invoked with a
  project-A token never surfaces project-B nodes in `answer`, `results`, or `meta.coverage`,
  because every internal primitive call binds `ctx.project_id` from the A token.
- AC-WB3N9H.10 (termination): the loop provably terminates under the two caps. A model
  response that never emits a final answer is bounded by the caps (then forced-synthesis +
  `"budget_exhausted"`); a model response naming an unknown tool is skipped and recorded as a
  warning, never executed.
- AC-WB3N9H.11 (manifest contract): the `ask_memory` manifest description states it answers
  free-form questions by planning retrieval over the memory graph, returns a synthesized
  answer wrapped in `<memory>` (treat as untrusted), is current-state only (no
  streaming/history), and requires `QUACK_MODEL_*` configured — distinguishing it from
  `search_memory`.

## Technical Design

- **`src/mcp/tools/memory/ask_memory.ts`** — Zod schema + handler. Resolves the extraction
  client (reuse the `createExtractionClient` shape over `QUACK_MODEL_*`, injected from server
  wiring for testability via the existing `openaiCtor?` seam in `src/extract/client.ts`).
  Drives the loop; when no client is configured → `model_unavailable` (AC-2).
- **`src/mcp/tools/memory/ask_loop.ts`** — the bounded retrieve→reason driver: builds the
  tool manifest over the four primitives, runs each model turn, dispatches model-requested
  primitive calls through the **in-process** handlers (call the existing
  `searchMemory` / `getNeighbors` / `pathBetween` / `recentDecisions` functions directly with
  the same `ctx` — no network round-trip), aggregates coverage, enforces the caps from AC-4,
  redacts retrieved content (AC-7) before re-prompting.
- **`src/mcp/memory/ask_prompt.ts`** — system prompt (untrusted-data framing per AC-8) +
  answer/tool-call JSON schema for the model.
- **`src/shared/env.ts`** — add `QUACK_ASK_MAX_ITERATIONS` (default 3) and
  `QUACK_ASK_MAX_TOOL_CALLS` (default 8).
- **`src/mcp/server.ts`** — register `ask_memory` (NOT in `ADMIN_TOOLS`).
- Reuses: `GraphAdapter.run`, the `MemoryEnvelope` builder + `subProjectsSchema`
  (`src/mcp/tools/memory/_shared.ts`), `nodeToMemoryItem` (`src/mcp/memory/dto.ts`),
  `redact.ts`, and the OpenAI-compatible client shape from `src/extract/client.ts`.
- No new npm dependency (reuses `openai`).

## Testing

- Framework: `bun test`; co-located `ask_memory.test.ts` + `ask_loop.test.ts`.
- The model is mocked via an injected fake `ExtractionClient`-style client returning scripted
  tool-call sequences, so the loop is exercised deterministically (RED→GREEN per AC) without a
  network call — mirrors the `openaiCtor?` seam already in `src/extract/client.ts`.
- Cross-tenant isolation reuses the `cross_tenant.test.ts` two-project seed pattern.
- Cases: `invalid_args`; `model_unavailable` (unset env); single-pass answer; multi-hop (≥2
  iterations); `budget_exhausted` (caps hit → forced synthesis); empty-retrieval;
  unknown-tool skip; redaction applied before re-prompt; `<memory>` wrap on `answer`;
  cross-tenant isolation.
- No latency benchmark (LLM-bound, unlike the primitives' p95 targets); assert structural
  envelope shape instead.

## Notes

- Realizes `mode: "planned"` reserved in AC-DPY5GQ.8 — the "future security milestone" that FR
  named. The tenancy concern there was NL→Cypher escape; this tool sidesteps it by calling
  only the existing parameterized templates, so the deferred *per-project isolation
  re-architecture* is NOT a prerequisite. The accepted residual risk is prompt-injection via
  stored memory steering the synthesized answer, bounded by AC-7 / AC-8 (redaction + untrusted
  framing + `<memory>` wrap).
- Cross-cutting spec amendments land in the same change: `requirements.md` §1 memory-plane
  bullet + §5 Out of Scope; `technical-spec.md` Read-path-synthesis decision row + pattern +
  a new ADR row + §3 MCP-tools list. The NL→Cypher prohibition (`requirements.md` §5,
  technical-spec risk) stays unchanged — `ask_memory` does not generate Cypher.

## Implementation notes

- `runAskLoop`'s `redactor` is optional — production always supplies `createRedactor()` (`ask_memory.ts`), and the only redactor-less callers are in-process test fakes with no external endpoint, so AC-7's defense-in-depth holds in practice; the optional param is a residual footgun, not a live leak.
- Empty `tool_calls: []` model turns add latency but are cap-bounded by `QUACK_ASK_MAX_ITERATIONS` (not an infinite loop).
- Two robustness fixes beyond the AC tests: the forced-synthesis turn falls back to an explicit message if the model returns `tool_calls` instead of an answer; malformed/empty model output surfaces as a graceful `MemoryToolError("model_protocol_error")` rather than a raw `SyntaxError` escaping `wrapAsk`.
