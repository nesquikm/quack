# Technical Specification

## 1. Architecture

### System Overview

Quack is a three-process personal-scale memory pipeline. Claude Code hooks fire-and-forget POST session events to a local **ingest server**, which enqueues them for a **cheap-model extractor** that emits typed entities/relations into a **graph DB**. An **MCP server** exposes retrieval tools back to Claude Code; recalled content is wrapped in `<memory>…</memory>` at the boundary.

All four roles (hook client / ingest / extractor / MCP) may live in one process or be split — the split is TBD and lives in M2 spec-write.

### Directory Structure

```
src/
├── index.ts                    # entry stub (M1)
└── .placeholder.test.ts        # Bun zero-match workaround (delete on first real test)
```

Target layout (fills in across M2+):

```
src/
├── ingest/                     # HTTP server accepting hook payloads
├── hooks/                      # Claude Code hook handler scripts
├── extract/                    # cheap-model extraction (entities, relations, summaries)
├── graph/                      # graph-DB adapter (TBD: Kùzu / Neo4j / SQLite-edges)
├── mcp/                        # MCP server exposing search_memory et al.
└── shared/                     # auth, redaction, types
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Bun | ESM-native, single binary, fast for hot-path hook handlers and MCP servers; pairs with existing rubber-duck MCP stack |
| Tracker mode | `none` | Personal tool; ACs stay in `specs/requirements.md` + `specs/frs/<id>.md` |
| Auth | Single bearer token (env var) | v1 is single-user; defer accounts |
| v1 retrieval | Graph-only | BRIEF.md §"Start narrow" — decide hybrid vector+graph after measuring retrieval quality |
| Graph DB | TBD | Kùzu embedded vs Neo4j vs Memgraph vs SQLite-with-edges — resolve in /brainstorm before M2 |
| Hook scope (v1) | One hook + one extraction schema + one MCP tool | BRIEF.md §"Start narrow" |

## 2. Data Model

TBD — minimal node/edge types resolved during /brainstorm. Candidates from BRIEF.md §2: `Entity`, `Decision`, `File`, `Symbol`, `Feedback`. Schema bootstrap strategy (hand-written prompts vs. let the cheap model infer types) is itself an open question (BRIEF.md §10).

## 3. API / Interface Design

### Ingest endpoint
- `POST /ingest` — bearer-authenticated. Body = hook payload envelope (event kind + payload). Returns 202 immediately; extraction is async.

### MCP tools (v1)
- `search_memory(query, k=10)` — returns top-k recalled facts, each wrapped in `<memory>` tags.

### MCP tools (post-v1, additive)
- `recall_entity(name)`
- `related_to(node, hops=2)`
- `recent_decisions(topic)`

## 4. Key Patterns

### State Management
TBD — extraction queue (in-memory ring buffer vs. SQLite-backed durable queue) decided during /brainstorm.

### Error Handling
- Hook client: best-effort; network/timeout errors are swallowed locally and logged. Never propagated to Claude Code's hook pipeline (which would block the session).
- Ingest server: returns 202 on enqueue; 401 on missing/invalid bearer; 5xx on persistence failure.
- Extractor: failed extractions are dead-lettered locally, not retried indefinitely.
- MCP server: retrieval failures surface as empty result sets, not exceptions.

### Testing Strategy
See `specs/testing-spec.md`. Co-located `*.test.ts` per Bun toolkit default. Mocks via `mock()` / `spyOn()` from `bun:test`.

## 5. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| typescript | ^5.6.0 | Type checker (devDep; runtime is Bun's transpiler) |
| @types/bun | latest | `bun:test` + Bun runtime types |

Runtime deps (graph driver, MCP SDK, schema validator, cheap-model SDK) are added as each subsystem lands — kept out of the M1 scaffold per "start narrow."

## 6. Risks & Considerations

- **Prompt-injection laundering** (BRIEF.md): the highest-risk failure mode. Tool output stored as a "fact" and later surfaced via `search_memory` becomes Claude-trusted unless wrapped at the MCP boundary. Tests for this boundary are non-negotiable.
- **Graph DB lock-in:** the four candidates have very different query models. Defer the choice but encapsulate it behind a thin adapter so the bet is reversible.
- **Hook handler blocking:** if the enqueue path acquires any lock or does sync IO it'll degrade the Claude Code session experience. Budget under 200 ms hard.
- **Cheap-model cost drift:** extraction over a busy session can run continuously; cap concurrency and/or batch.
- **Redaction completeness:** deny-pattern lists are easy to leak past. Treat redaction as defense-in-depth, not the only barrier — never store the raw `.env` text in the queue.

## Architecture Decision Records

<!-- ADRs land here as /brainstorm and /spec-write resolve open questions -->

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| <!-- e.g., Graph DB --> | <!-- Kùzu / Neo4j / Memgraph / SQLite-edges --> | <!-- TBD --> | <!-- TBD --> |
