---
title: Ambient ingestion denoise — decision-worthiness gate + meta-activity filter
milestone: M10
status: archived
archived_at: 2026-05-29T11:54:11Z
id: fr_01KSS9GV9MPX7Z8NQ5DBZ1W6ED
created_at: 2026-05-29T07:17:32Z
---

## Requirement

Keep Quack's ambient auto-capture, but stop noise from becoming `Decision` nodes.

Today the digester ingests the **entire session transcript** — every hook envelope
(`session_start`, `stop`, `post_tool_use`) flows to the extractor, which mints
`Decision` and `Entity` nodes from all of it. The result (`/private/tmp/quack-memory-findings.md`
Finding 3): a casual gaming opinion became a formal "SteamOS decision," and the
agent's own tool-search activity became Decisions (`"Search for mcp__quack__search_memory tool"`).
The noise is structurally indistinguishable from the one real decision (SQLite /
Greg) — a project that never decided anything about SteamOS now has a "SteamOS
decision" in its graph.

The product direction (approved via `/brainstorm`) is **ambient capture stays;
denoise the signal** — a hybrid of structural and semantic filtering:

1. **Structural (client hook).** The hook drops the agent's own meta/tool-search
   activity before egress, so obvious chatter never reaches `/ingest` or the model.
   This **absorbs and supersedes** what was FR-ATBKZV concern B (narrowed to concern
   A in the same spec-write run).
2. **Semantic (extractor gate).** The extractor gains a decision-worthiness gate:
   the cheap model, guided by a rubric + negative examples, withholds `Decision`
   status from casual conversation / opinions / tool chatter — while still
   extracting entities. This catches the conversational noise (the gaming opinion)
   that structural-by-kind filtering cannot.
3. **Provenance.** Every minted node records its originating envelope `kind` as
   `source`, so pre-existing and future noise is auditable and selectively cleanable.

This leverages the existing `kind` discriminator (`explicit_add` vs the passive
hook kinds, `plugins/quack/hooks/_lib/shared/envelope.ts`) and the writer's existing
`source` field (`src/extract/writer.ts`).

## Acceptance Criteria

- AC-Z1W6ED.1: The client hook does not forward `PostToolUse` envelopes whose `tool_name` is in a centralized `META_TOOLS` set (tool-search / tool-discovery introspection); they are dropped before the POST to `/ingest` (fire-and-forget, exit 0). `SessionStart`, `Stop`, and non-meta `PostToolUse` are unaffected. (Verify: a `META_TOOLS` payload produces no outbound POST; a non-meta tool still posts; `META_TOOLS` is a single exported const and membership is asserted.)
- AC-Z1W6ED.2: The extractor applies a decision-worthiness gate before minting a `Decision` node: content the model classifies as casual conversation, opinion, or tool/meta activity yields **no** `Decision`. Driven by a rubric + negative examples (the gaming opinion; tool-search chatter). (Verify: extraction over the gaming-opinion payload yields zero `Decision` nodes; over the SQLite/Greg payload yields exactly one.)
- AC-Z1W6ED.3: Entity extraction is preserved for passive content — denoise removes Decisions, not the ambient entity graph. A passive conversational envelope may still yield `Entity`/`File` nodes even when it yields no `Decision`. (Verify: a passive payload carrying real entities but no decision → entities written, zero `Decision` nodes.)
- AC-Z1W6ED.4: Every minted node records its `source` provenance — the originating envelope `kind` (`session_start` | `stop` | `post_tool_use` | `explicit_add`) — so noise can be audited and selectively cleaned later. (Verify: a node written from an `explicit_add` envelope carries `source` `explicit_add`; one from a `stop` envelope carries `stop`.)
- AC-Z1W6ED.5: `explicit_add` (the `add_memory` path) is never down-graded by the gate — deliberate user-submitted content always remains eligible to mint a `Decision`, even if phrased casually. (Verify: an `explicit_add` decision payload yields a `Decision` regardless of casual phrasing.)

## Technical Design

### Modules

- **`plugins/quack/hooks/_lib/`** — add a `META_TOOLS` skip in the dispatch/redact path: if a `PostToolUse` `tool_name` ∈ `META_TOOLS`, return before building/POSTing the envelope (fire-and-forget, exit 0). `META_TOOLS` is a single exported const in `_lib/shared/`, referenced by the hook drop and documentable in the plugin README. This is the structural slice formerly scoped as FR-ATBKZV concern B, now owned here.
- **`src/extract/prompt.ts` + `src/extract/consumer.ts`** — extend the extractor system prompt with the decision-worthiness gate: a rubric distinguishing a deliberate, project-relevant decision from casual conversation / opinion / tool-meta activity, plus negative few-shot examples (the SteamOS opinion, the `ToolSearch` chatter). The gate governs `Decision` minting **only**; `Entity`/`File`/`Symbol` extraction is unchanged (AC-Z1W6ED.3).
- **`src/extract/writer.ts`** — record the originating envelope `kind` as the node `source` (AC-Z1W6ED.4). `resolveSource(envelope)` already maps an envelope to a `$source` list; formalize that the envelope `kind` is captured and add coverage. `explicit_add` provenance is also what the gate uses to never down-grade deliberate content (AC-Z1W6ED.5).

### Data model

No new node kinds, no Neo4j migration. `source` is an existing array property on
nodes; this FR ensures it carries the envelope `kind` consistently.

### Out of scope

- Changing the capture **scope** — ambient auto-capture stays; this FR denoises, it does not switch to opt-in.
- Retroactive cleanup of noise nodes already in the graph — the `source` provenance (AC-Z1W6ED.4) is the enabler for that, but the sweep itself is a separate task.
- Secret redaction — orthogonal; secrets are already stripped client- and server-side and are untouched here.

## Testing

- `plugins/quack/hooks/_lib/__tests__/` — a `META_TOOLS` payload produces no outbound POST (spy on `post`); a non-meta tool still posts; `META_TOOLS` membership asserted.
- `src/extract/*.test.ts` — the gaming-opinion payload → zero `Decision` nodes; the SQLite/Greg payload → exactly one; a passive payload with entities but no decision → entities written + zero `Decision`s (AC-Z1W6ED.3 over-filtering guard); an `explicit_add` casually-phrased decision → a `Decision` (AC-Z1W6ED.5); provenance test asserts node `source` reflects the originating envelope `kind` (AC-Z1W6ED.4).
- Gate: `bunx tsc --noEmit && bun run test`.

## Notes

- **Supersedes FR-ATBKZV concern B.** ATBKZV is narrowed to concern A (the `search_memory` typed-`inputSchema` fix) in the same `/spec-write` run; the META_TOOLS hook drop and the extractor denoise both live here.
- Product intent (per `/brainstorm`): keep ambient capture; denoise via a structural pre-filter + a semantic decision-worthiness gate. This consciously accepts an ongoing precision effort — LLM judgment is fuzzy — backstopped by the deterministic hook drop and pinned negative-example tests.
- Source: `/private/tmp/quack-memory-findings.md` Finding 3 (over-eager ingestion), recorded during the M-series install smoke on a live cmux session.
- The `source` provenance (AC-Z1W6ED.4) is deliberately specified now so a future retroactive-cleanup sweep of pre-existing noise nodes has the metadata it needs.
