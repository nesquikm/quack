# Project Brief: **Quack** (working name)

## One-liner
A personal memory layer for Claude Code: hooks stream session context to a local server, a cheap LLM extracts entities/relations into a graph database, and an MCP server exposes search/RAG back to Claude Code.

## Inspirations / prior art
- Anthropic's "dreams" pattern for managed agents (background consolidation of context by a cheap model): https://platform.claude.com/docs/en/managed-agents/dreams
- `tomasonjo/agent-memory-hooks-neo4j` — proof that the hooks→graph shape works: https://github.com/tomasonjo/agent-memory-hooks-neo4j
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks

## Architecture
```
Claude Code (hooks: SessionStart / PostToolUse / Stop / etc.)
        │  fire-and-forget POST  (bearer token)
        ▼
Ingest server  ──►  cheap model (OpenAI-compatible API, e.g. Haiku / gpt-4o-mini)
        │                 │
        │           extracts: entities, relations, summaries
        ▼                 ▼
   Graph DB  ◄────────────┘
        ▲
        │  MCP tools (search_memory, recall_entity, related_to, …)
        ▼
Claude Code  ◄── bearer token
```

## Design constraints (already decided)
- **Hooks must be fire-and-forget.** They block the session — never wait on the cheap model. Queue locally or background the request.
- **Auth: single bearer token** for both the ingest endpoint and the MCP server. Env var. No user accounts in v1.
- **Network surface:** bind MCP to localhost (or Tailscale/SSH) unless explicitly exposed.
- **Prompt-injection laundering is the main risk.** Tool output stored as "facts" can later be re-injected into Claude as trusted memory. On retrieval, wrap recalled content in `<memory>…</memory>` tags and treat it as untrusted text, not system context.
- **Start narrow.** v1 = one hook (`Stop` or `SessionEnd`), one extraction schema, one MCP tool (`search_memory`). Decide on hybrid vector+graph only after v1 retrieval quality is measured.

## Open questions to brainstorm
1. Which hooks to listen to, and what payload shape per hook?
2. Extraction schema — minimal node/edge types for v1 (Entity, Decision, File, Symbol, Feedback, …?).
3. Graph DB choice: Neo4j vs. Memgraph vs. Kùzu (embedded) vs. SQLite-with-edges. Embedded is tempting for a personal tool.
4. Should v1 already include vector embeddings (hybrid retrieval), or strictly graph?
5. Redaction at hook layer — how to avoid sending secrets / `.env` / API responses to the cheap model.
6. Multi-project boundaries: one graph per repo, or one global graph with `project` labels?
7. Consolidation / deduplication strategy (the "dreams" loop: periodic merge pass).
8. Decay / TTL — do stale memories age out, or stay forever and rely on retrieval ranking?
9. MCP surface beyond `search_memory`: `recall_entity(name)`, `related_to(node, hops=2)`, `recent_decisions(topic)`?
10. How to bootstrap the schema — hand-written prompts vs. let the cheap model infer types.

## Name candidates
Leading: **Quack** (pure-joy funny, pairs with existing `rubber-duck` MCP) or **Imprint** (smart-funny — Lorenz's duckling imprinting is literally memory formation).
Runners-up: **Mallard** (sounds serious, secretly a duck), **Decoy** (passive listener metaphor), **Pond** (calm storage metaphor).
