# Requirements

## 1. Overview

**Project:** Quack — a personal memory layer for Claude Code.

Hooks stream session context (tool I/O, session boundaries) to a local ingest server. A cheap LLM (Haiku / `gpt-4o-mini`-class) extracts entities, relations, and summaries into a graph database. An MCP server exposes search/RAG tools (`search_memory`, eventually `recall_entity`, `related_to`, …) back to Claude Code so the assistant can recall context from prior sessions.

The system is single-user, locally hosted, and trust-bounded by a single bearer token shared between the ingest endpoint and the MCP server. See `BRIEF.md` for the full design rationale and inspiration list (Anthropic "dreams" pattern, `tomasonjo/agent-memory-hooks-neo4j`, Claude Code hooks reference).

## 2. Functional Requirements (cross-cutting only)

<!-- Per-FR detail lives in `specs/frs/<id>.md`. Cross-cutting only here. -->

- **Auth scheme:** Every external surface (ingest HTTP endpoint, MCP server) authenticates via a single shared bearer token read from an env var. No user accounts in v1. Token absence ⇒ refuse to start.
- **Network surface:** Ingest server and MCP server bind to localhost by default. Exposing either to a non-loopback interface (Tailscale, SSH tunnel, public bind) is an explicit per-process opt-in, never the default.
- **Fire-and-forget hook contract:** Every Claude Code hook handler MUST return within hook-handler latency budget (TBD; tentatively < 200 ms) and never block on the cheap-model extractor. Hooks enqueue locally and acknowledge; extraction runs asynchronously.
- **Prompt-injection laundering defense:** Content retrieved from memory (via MCP tools) MUST be wrapped in `<memory>…</memory>` tags at the MCP-server boundary and surfaced as untrusted text, never as trusted system context. Stored "facts" originating from arbitrary tool output are not promoted to trusted memory.
- **Redaction at hook layer:** Hook payloads SHOULD be scrubbed of obvious secrets (`.env` contents, API responses with auth headers, anything matching a configured deny-pattern) before they leave the developer machine for the cheap-model extractor.

## 3. Non-Functional Requirements

### NFR-1: Performance
- Hook handler latency budget: TBD (target < 200 ms for the fire-and-forget enqueue path).
- MCP `search_memory` p95 latency: TBD (target < 500 ms on a personal-scale graph).

### NFR-2: Security
- Bearer token never logged.
- Recalled memory content treated as untrusted (per cross-cutting FR above).
- Redaction policy applied to outbound hook payloads.

### NFR-3: Availability
- Personal-tool scope — no formal SLO. The system MUST fail open from Claude Code's perspective: ingest server unreachable ⇒ hooks drop silently, never block.

## 4. Edge Cases

<!-- Populate during /spec-write — discovered during implementation. -->

## Security / Abuse Cases

| Attacker Goal | Attack Vector | Mitigation |
|--------------|---------------|------------|
| Inject malicious instructions into Claude via stored memory | Prompt-injection in tool output that later surfaces via `search_memory` | Wrap recalled content in `<memory>` tags; treat as untrusted text, not system context |
| Exfiltrate secrets via cheap-model API | Hook payload contains `.env` / auth headers | Redaction at hook layer; deny-pattern list applied before outbound POST |
| Unauthorized graph access | MCP / ingest endpoint reachable from network | Bearer token required; localhost bind by default |

## 5. Out of Scope (v1)

- Multi-user / accounts / per-user graphs
- Hybrid vector + graph retrieval (graph only; revisit after retrieval quality measured)
- Consolidation / "dreams" loop (periodic merge pass)
- Decay / TTL on stored memories
- Multi-project boundaries (decide one-global vs. one-per-repo before promoting beyond v1)
- MCP tools beyond `search_memory` (`recall_entity`, `related_to`, `recent_decisions`) — additive after v1

## 6. Traceability Matrix

<!-- Populated by /spec-write / /implement as FRs ship -->

| Requirement | Implementation | Tests |
|-------------|---------------|-------|
