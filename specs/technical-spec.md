# Technical Specification

## 1. Architecture

### System Overview

Quack is a single-Bun-process server packaged as a Docker Compose stack. The process hosts three responsibilities in one runtime:

1. **HTTP `/ingest`** — POST endpoint accepting Claude Code hook payloads (bearer-authenticated, returns 202 on enqueue).
2. **HTTP `/mcp`** — streamable HTTP MCP transport exposing memory + admin tools (bearer-authenticated).
3. **Async extractor** — in-process queue consumer that drains hook payloads to the cheap-model API and writes typed entities/relations into the graph DB.

All three share an `AuthMiddleware` that performs a single SQLite point query against `auth.sqlite` to resolve `Authorization: Bearer <token>` to a `(user_id, project_id, role)` tuple. Memory writes/reads are scoped to `project_id`; admin MCP tools additionally check `role = 'admin'`. The graph DB is either embedded (Kùzu, SQLite-with-edges — same container, same volume) or daemon-style (Neo4j, Memgraph — second Compose service); the choice is deferred to a follow-up brainstorm but the boundary (a `GraphAdapter` interface) is fixed here.

### Directory Structure

Current (M1, scaffolding-only):

```
src/
├── index.ts                    # entry stub
└── .placeholder.test.ts        # Bun zero-match workaround (delete on first real test)
```

Target (fills in across M2):

```
src/
├── server/                 # HTTP + MCP entry, route binding, graceful shutdown
├── auth/
│   ├── middleware.ts       # AuthMiddleware: token → (user_id, project_id, role)
│   ├── tokens.ts           # generate / hash / verify (32-byte random base64url, SHA-256 hash)
│   └── sqlite/             # auth.sqlite schema, migrations, prepared queries
├── admin/                  # admin-only MCP tools (register_user, create_project, …)
├── ingest/                 # POST /ingest handler + enqueue to extractor
├── extract/                # in-process queue consumer + cheap-model client
├── graph/                  # GraphAdapter interface + per-driver implementations
├── mcp/                    # search_memory + future read-side tools; <memory> wrapping
└── shared/                 # types, env config, logger (strips Authorization on write)
```

### Plugin packaging (M4+)

The repo doubles as a Claude Code plugin marketplace. Layout addition:

```
.claude-plugin/
└── marketplace.json        # declares the Quack plugin; source: ./plugins/quack/
plugins/
└── quack/
    ├── .claude-plugin/
    │   └── plugin.json     # plugin manifest (name, version, description, etc.)
    ├── hooks/
    │   ├── session_start.sh    # thin bunx shell wrappers around the in-plugin TS hook logic
    │   ├── stop.sh
    │   └── post_tool_use.sh
    ├── commands/
    │   └── quack-install.md   # /quack:install <slug> slash command
    └── README.md
```

When a user installs the plugin from the marketplace, **only `plugins/quack/` is downloaded** — the rest of the repo (`src/`, `compose.yml`, `Dockerfile`, `specs/`, `tests/`, `package.json`, etc.) stays out of the install. The plugin is a packaging convenience; the server is the source of truth.

Hooks are **thin shell scripts that `bunx`-run the in-plugin TypeScript hook logic** (FR-44QGKH — no compiled binary, no PATH install). The plugin doesn't ship a binary — keeps the install tiny and avoids platform-specific binary packaging. The hooks read per-workspace configuration from `.mcp.json` (FR-55S220); when `.mcp.json` is absent, has no `quack` entry, or is malformed, the hook silently no-ops and exits 0.

Per-workspace configuration lives in a single project-scoped `.mcp.json` at the workspace root, written by `/quack:install` (FR-55S220). It is the **one** config artifact: it declares the Quack MCP server with a literal non-admin single-project token plus the server URL, and carries an `X-Quack-Sub-Project` header. Claude Code reads `.mcp.json` natively on session start; the hooks read the same `mcpServers.quack` object for server URL + token + sub-project. No env-var plumbing. A workspace that has not run `/quack:install` has no Quack MCP server and no token.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Bun | ESM-native, single binary, fast for hot-path hook handlers and MCP servers; pairs with existing rubber-duck MCP stack |
| Tracker mode | `none` | Personal/small-team tool; ACs stay in `specs/requirements.md` + `specs/frs/<id>.md` |
| Auth model | Multi-tenant; one token = one (user, project) pair | Matches `/brainstorm` decision; shared projects via project_members ACL |
| Process model | Single Bun process (ingest + MCP + extractor) | Shared auth + DB clients; splitting duplicates code paths. Extractor moves out later if cost concurrency demands |
| Deployment | Docker Compose | One-command install (`docker compose up`); embedded vs. daemon graph DB is just a second service or not |
| MCP transport | HTTP (streamable) with Bearer auth | Multi-tenant tokens require per-connection identity; stdio has none |
| Control plane store | `auth.sqlite` (bun:sqlite, built-in) | Small, structured, relational; sub-ms indexed point queries; no extra dep |
| Token format | 32 bytes random, base64url; SHA-256 hash at rest | Full entropy → no argon2 needed; hash for breach safety; plaintext shown once at issuance |
| Bootstrap admin | `QUACK_BOOTSTRAP_TOKEN` env var on first boot only | Postgres-style pattern; restart-based rotation in v1 |
| v1 retrieval | Graph-only | Defer hybrid vector+graph until retrieval quality measured |
| Graph DB | Neo4j Community 5.x (daemon) | Largest Cypher ecosystem; mature Bolt driver; fallback options available behind `GraphAdapter`. Embedded considered but daemon is appropriate for multi-tenant + memory headroom |
| Graph-DB driver | `neo4j-driver` (Bolt protocol) | Official driver; pure JS; Bun-compatible |
| Cross-tenant isolation | Per-project graph partitioning + middleware-resolved `project_id` + parameterized-template-only `GraphAdapter` | Three layers of defense — middleware resolves `project_id` from the token; `GraphAdapter.run(templateId, params, ctx)` is the only Cypher entry point; `project_id` is a non-negotiable bind parameter in every template (never string-concatenated) |
| Read-path synthesis split | Four primitives return structured DTOs (+ `<memory>` wrap + mandatory `meta` envelope); Claude Code synthesizes. **`ask_memory` (M9, FR-WB3N9H) is the sole synthesis exception** — server-side agentic loop with defense-in-depth | Avoid duplicating LLM capabilities for the primitives; smallest prompt-injection-laundering surface; preserves caller as planner. `ask_memory` adds an opt-in synthesized answer for callers who want one round-trip, gated by redaction + untrusted framing + `<memory>` wrap, and uses only the existing templates (no NL→Cypher) |
| Config artifact | `.mcp.json` at the workspace root, holding a literal non-admin single-project token; committed by default for MVP | Claude Code reads `.mcp.json` natively on session start — no env-var plumbing. The token cannot mint/revoke other tokens and is scoped to one project, so its blast radius is small enough to commit. Post-MVP path: `${QUACK_TOKEN}` substitution reference + `.gitignore` so the secret leaves source control |

## 2. Data Model

### auth.sqlite (control plane)

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,          -- canonical name; used as graph-partition key
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_members (
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE tokens (
  id          INTEGER PRIMARY KEY,
  token_hash  BLOB NOT NULL UNIQUE,           -- SHA-256 of the 32-byte random secret; 32 bytes
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

CREATE INDEX idx_tokens_hash_active ON tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE pending_cleanup (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,                  -- e.g., 'project_graph_partition'
  ref         TEXT NOT NULL,                  -- payload (e.g., project_slug)
  queued_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Graph DB (memory plane) — Neo4j Community 5.x

Single shared logical database (`neo4j` + `system`). Per-project tenancy via the `project_id` property on every node. The `GraphAdapter` is the only entry point for Cypher; it exposes a `run(templateId, params, ctx)` method whose `ctx` carries `project_id` (resolved from the auth middleware). Every template's parameter map binds `project_id` non-negotiably; raw-Cypher pass-through is intentionally absent from the adapter surface — calling code that needs a new query shape adds a new template, not a free-form string.

#### v1 graph schema

**Node labels (5):**

| Label | Required properties | Notes |
|---|---|---|
| `Entity` | `id, project_id, name, kind, created_at` | Generic "thing" — a concept, person, tool, library name; `kind` carries free-form sub-type ("library", "person", "config", …). |
| `Decision` | `id, project_id, summary, decided_at, source_excerpt` | A choice the user / Claude Code made; `source_excerpt` is the original snippet (trimmed) for traceability. |
| `File` | `id, project_id, path, repo_root?, created_at` | A filesystem path observed in a session. |
| `Symbol` | `id, project_id, name, file_id, kind, created_at` | A function / class / variable name; `kind` ∈ `{function, class, type, variable, const}`; `file_id` references the owning `File`. |
| `Feedback` | `id, project_id, body, sentiment?, observed_at` | User correction / preference statement; pairs with `auto memory` from CLAUDE.md guidance. |

**Relationship types (5):**

| Type | From → To | Semantics |
|---|---|---|
| `MENTIONS` | `Entity → Entity \| File \| Symbol \| Decision` | Cross-reference observed in the session. |
| `DECIDED_BY` | `Decision → Entity` | Who/what made the decision (usually `kind=person`). |
| `RELATED_TO` | `Entity ↔ Entity` | Generic semantic adjacency the extractor emits when nothing more specific fits. |
| `MODIFIES` | `Symbol → File`, `File → File` | Code-shape edge: a symbol modifies a file's behavior, or a file modifies another file's content. |
| `FOLLOWS` | `Decision → Decision`, `Entity → Entity` | Temporal / causal ordering. |

All node `id`s are application-minted ULIDs (so `(project_id, id)` is globally unique within the namespace). Relationships carry `{ created_at, source_excerpt? }`.

**Indexes (created in FR-SFQDXR §1 migration):**

```cypher
CREATE INDEX entity_project_id   IF NOT EXISTS FOR (n:Entity)   ON (n.project_id);
CREATE INDEX decision_project_id IF NOT EXISTS FOR (n:Decision) ON (n.project_id);
CREATE INDEX file_project_id     IF NOT EXISTS FOR (n:File)     ON (n.project_id);
CREATE INDEX symbol_project_id   IF NOT EXISTS FOR (n:Symbol)   ON (n.project_id);
CREATE INDEX feedback_project_id IF NOT EXISTS FOR (n:Feedback) ON (n.project_id);
CREATE INDEX entity_id           IF NOT EXISTS FOR (n:Entity)   ON (n.id);
CREATE FULLTEXT INDEX entity_name_fts IF NOT EXISTS FOR (n:Entity) ON EACH [n.name];
```

(Additional id indexes for `Decision`/`File`/`Symbol`/`Feedback` on demand; composite `(project_id, id)` indexes added when query plans show they're needed.)

**Extension labels are out of scope for v1** — the cheap-model is prompted to conform to this fixed taxonomy. Anything that doesn't fit gets coerced to `Entity` with an appropriate `kind`. Adding extension labels is a future FR.

## 3. API / Interface Design

### HTTP endpoints

```
POST /ingest        Bearer-auth; body = hook envelope { kind, payload }; returns 202 { accepted: true }
POST /mcp           Bearer-auth; MCP streamable HTTP transport
GET  /health        No auth; returns 200 { ok: true, version }
```

### MCP tools (v1)

**Memory plane (member or admin token) — four primitives, structured DTOs only, never prose:**

Every memory-plane tool returns the canonical envelope:

```ts
{
  results: MemoryItem[],          // each item: { kind, id, project_id, ...node-specific fields, _memory_wrapped: string }
  meta: {
    mode_used: "templates",       // reserved enum: "templates" | "planned" (planned reserved for future bounded plan catalog)
    coverage: {
      matched_entities: number,
      traversals: number,
      truncated: boolean
    },
    warnings: string[],
    explain?: {
      template_ids: string[],
      ranking_factors: object
    }
  }
}
```

`_memory_wrapped` on each item is the `<memory>…</memory>`-wrapped serialization of the node's user-visible fields (per `requirements.md` prompt-injection-laundering defense). The structured fields are also present in the item; the caller chooses whether to feed the wrapped or unwrapped form to its own LLM.

- `search_memory({ entities[], types[]?, time_range?, mode?: "templates" })` — full-text match on `Entity.name` (and aliases when present) + 1-hop expansion. Returns ranked entities and their immediate neighbors of the requested `types[]`. Most common entry point.
- `get_neighbors({ node_id, depth?: 1, edge_types[]? })` — bounded local expansion from a known node. `depth` capped at 3 in v1; caller composes deeper walks via repeated calls. `edge_types[]` filters by relationship type.
- `path_between({ node_a, node_b, max_hops?: 5 })` — uses Cypher `shortestPath` / variable-length match scoped by `project_id`. Returns the path(s) as ordered node + relationship lists. Result-size capped (see FR-DPY5GQ).
- `recent_decisions({ time_window, limit?: 20 })` — timestamp-indexed query against `Decision` nodes in the caller's project. Reserved for high-signal recall when the user asks "what did we decide recently?"
- `add_memory({ content })` (M5+) — **write-side, fire-and-forget**. Wraps `content` (≤ `QUACK_ADD_MEMORY_MAX_BYTES`, default 32 KB) in a synthetic `HookEnvelope { kind: "explicit_add", payload: { content }, project_slug, ts }` and enqueues via the same FR-4NY6S1 path that `POST /ingest` uses. Returns `{ accepted, queued_at }` (or `{ accepted: false, reason: "queue_full" }` on backpressure). No status tool; caller verifies via `search_memory`. Member-readable. The extraction prompt has a `kind: "explicit_add"` branch that frames content as a user-asserted fact; otherwise the path is byte-identical to hook ingestion (same redaction, same MERGE templates, same cross-tenant project_id binding).

- `ask_memory({ question, sub_projects? })` (M9, FR-WB3N9H) — **the one synthesis tool.** A bounded server-side agentic loop (cheap model over `QUACK_MODEL_*`, reusing the `src/extract/client.ts` client shape) plans retrieval by calling the four primitives internally, follows a few hops, and returns `{ answer, results, meta }` where `answer` is a `<memory>`-wrapped synthesized natural-language answer and `meta.mode_used` is `"planned"` (realizing the reserved enum). Bounded by `QUACK_ASK_MAX_ITERATIONS` (default 3) + `QUACK_ASK_MAX_TOOL_CALLS` (default 8). Member-readable. Returns MCP error `model_unavailable` when `QUACK_MODEL_*` is unset. Defense-in-depth: redaction before re-prompting, untrusted-data framing, only the `project_id`-scoped read primitives exposed to the model.

Reserved request field on the four primitives: `mode: "templates" | "planned"`. They honor only `"templates"`. The `"planned"` enum is *realized* by `ask_memory` (M9), whose `meta.mode_used` is `"planned"`; the future bounded-plan-catalog form on the primitives themselves (NOT arbitrary NL→Cypher) remains gated behind a future security milestone.

**Control plane (admin token only — 403 otherwise):**
- `register_user(username: string)` — creates user with role `member`; returns one-time plaintext token bound to an implicit "default" or specified project.
- `remove_user(username: string)` — cascades to `project_members` and `tokens`.
- `create_project(slug: string, display_name: string)`
- `delete_project(slug: string)` — cascades to `project_members`, `tokens`, and queues graph-partition deletion via `pending_cleanup`.
- `add_member(username: string, project_slug: string, role: 'admin' | 'member')` — returns one-time token for that (user, project) pair.
- `remove_member(username: string, project_slug: string)` — revokes tokens for that pair.
- `revoke_token(token_id: number)` — sets `revoked_at`.
- `list_projects()` — admin sees all; member sees own (membership-filtered).
- `list_users()` — admin only.

### MCP tools (post-v1, additive)
- `recall_entity(name)` — when entity-name full-text needs a typed shortcut beyond `search_memory`.
- Plan catalog tools (e.g. `list_plans`) once `mode: "planned"` is implemented in a future milestone.

## 4. Key Patterns

### AuthMiddleware
Intercepts every `/ingest` and `/mcp` request. Single query:

```sql
SELECT t.user_id, t.project_id, u.role
FROM tokens t JOIN users u ON u.id = t.user_id
WHERE t.token_hash = ? AND t.revoked_at IS NULL
LIMIT 1
```

Hashes the bearer token, runs the query, sets `request.context = { user_id, project_id, role }`. No DB writes on the hot path. Miss ⇒ HTTP 401 with a generic body (no token-existence oracle).

### Admin-tool gate
MCP tool dispatcher checks `request.context.role === 'admin'` against a **static list** of management tool names before invoking. Never inferred from tool-name patterns — explicit allowlist keeps the boundary auditable.

### GraphAdapter parameterized templates
The `GraphAdapter` interface exposes exactly one Cypher entry point: `run(templateId: TemplateId, params: TemplateParams<typeof templateId>, ctx: AuthContext): Promise<QueryResult>`. `TemplateId` is a string-literal union of registered template IDs (TypeScript-checked at compile time); `params` is typed per template via a per-template parameter type. The adapter binds `project_id` from `ctx` into every template's parameter map — non-negotiable; templates that omit `$project_id` from their `WHERE` / `MERGE` clauses fail an internal lint at startup. Raw `session.run(rawString)` is intentionally absent from `GraphAdapter`'s public surface; a lint rule in CI forbids importing the underlying driver outside the `src/graph/` module so callers can't bypass the gate. The mechanism is documented in `requirements.md` § Security/Abuse — `NL→Cypher escape from tenancy` mitigation.

### Read-path synthesis split
The four memory-plane **primitives** return structured DTOs only — never prose, never server-side LLM synthesis. The caller (Claude Code) is itself a SOTA LLM and handles synthesis. The `meta` envelope on every response carries coverage signals + warnings so the caller can detect weak retrievals instead of confidently synthesizing junk.

**Exception — `ask_memory` (M9, FR-WB3N9H).** One read tool reverses the split deliberately: a bounded server-side agentic loop (cheap model over `QUACK_MODEL_*`) plans retrieval by calling the four primitives internally and returns a synthesized `answer`. This is *not* an NL→Cypher feature — the loop's only tools are the existing `project_id`-scoped parameterized templates, so per-project tenancy isolation is untouched and the deferred isolation re-architecture is not a prerequisite. The accepted residual risk (prompt-injection via stored memory steering the answer) is bounded by defense-in-depth: retrieved content is redacted (`src/extract/redact.ts`) before re-prompting, the system prompt frames memory as untrusted data, no graph-write/token/Cypher tool is ever exposed to the model, and the returned `answer` is `<memory>`-wrapped as untrusted text. Server-side NL→Cypher (dynamic query generation) remains out-of-scope in `requirements.md` § Out of Scope, gated behind the future security milestone.

### Cross-store transactions
`delete_project` runs:
1. `BEGIN` in `auth.sqlite`; delete from `projects` (cascades to `project_members`, `tokens`); insert `pending_cleanup(kind='project_graph_partition', ref=<slug>)`; `COMMIT`.
2. Delete the project's graph partition via `GraphAdapter.dropProject(slug)`.
3. Delete the corresponding `pending_cleanup` row on success.

A crash between step 1 and 2 leaves a `pending_cleanup` row that a daily reconciliation sweep drains. The graph partition is the slower operation; making it post-commit keeps the SQLite transaction short.

### Secrets handling

Secrets currently in scope:

- `QUACK_BOOTSTRAP_TOKEN` — consumed once at first bootstrap (FR-HA2WTQ §4); ignored on subsequent boots.
- `QUACK_MODEL_API_KEY` — consumed by the extractor on every cheap-model call (M3+). Optional in M2.
- `QUACK_MODEL_BASE_URL` — configuration (not a secret), but treated identically by `src/shared/env.ts`. Optional in M2.

All read once at startup via `src/shared/env.ts` (Zod schema; throws on violation). The logger's redaction pass (FR-HA2WTQ §6) MUST strip both the `Authorization:` header value AND any log line containing the literal parsed `QUACK_MODEL_API_KEY` value — same mechanism, two redaction sources. Rotation = restart with new env value (no in-place rotation in v1).

### State Management
In-process queue for extraction: a bounded async ring buffer (capacity ~10k entries) drained by a single consumer task that calls the cheap-model API and writes via `GraphAdapter`. Backpressure ⇒ `POST /ingest` returns 202 with `{ accepted: false, reason: 'queue_full' }` after a soft cap; never blocks the hook handler. Concrete capacity tuned during M2 implementation.

### Error Handling
- Hook client: best-effort POST; network/timeout errors logged and swallowed (never propagated to Claude Code's hook pipeline, which would block the session).
- Ingest server: 202 on enqueue; 401 on missing/invalid bearer; 403 on admin-tool by non-admin; 5xx on persistence failure.
- Extractor: failed extractions are dead-lettered in a local file, not retried indefinitely.
- MCP server: retrieval failures surface as empty result sets, not exceptions; only auth failures emit non-200 status.

### Testing Strategy
See `specs/testing-spec.md`. Boundary modules (auth middleware, `<memory>` wrap, admin-tool gate) are non-negotiable test targets per `requirements.md` § Security/Abuse Cases.

## 5. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| typescript | ^5.6.0 | Type checker (devDep; runtime is Bun's transpiler) |
| @types/bun | latest | `bun:test` + Bun runtime types |
| bun:sqlite | (built-in) | `auth.sqlite` access (no extra dep) |
| @modelcontextprotocol/sdk | latest | MCP server (HTTP streamable transport) |
| zod | latest | Schema validation on tool args + hook payloads |
| neo4j-driver | ^5.x | Bolt protocol client for Neo4j Community (FR-SFQDXR; M3) |
| openai | ^4.x or ^5.x | OpenAI-compatible client used by the extractor with `QUACK_MODEL_BASE_URL` + `QUACK_MODEL_API_KEY` (FR-4NY6S1; M3) |

## 6. Risks & Considerations

- **Prompt-injection laundering** (top risk per BRIEF.md): tool output stored as a "fact" and later surfaced via `search_memory` becomes Claude-trusted unless wrapped at the MCP boundary. Tests for this boundary are non-negotiable.
- **Cross-store consistency:** `auth.sqlite` and graph DB are two stores. `delete_project` is multi-step; a crash mid-delete leaves orphan graph data. Mitigation: `pending_cleanup` table + daily reconciliation sweep. Acceptable for v1 personal/team scale; revisit if scale grows.
- **Bootstrap token leakage:** `QUACK_BOOTSTRAP_TOKEN` sits in `.env`. Ops must `.gitignore` it (already in M1) and use `docker secrets` or equivalent in production. Documented in deployment README.
- **HTTP MCP transport maturity:** streamable HTTP MCP is newer than stdio. Pin SDK version; integration-test against the Claude Code MCP client in CI.
- **Graph DB lock-in:** resolved — Neo4j Community 5.x. The `GraphAdapter` interface keeps the bet reversible if Cypher/Bolt ever becomes a constraint (per `/brainstorm` decision).
- **Cypher template inventory creep:** every new query shape needs a new template; templates can sprawl over time. Mitigation: each template lives in `src/graph/templates/` with a sibling test; PR review enforces "no raw `session.run`" via lint.
- **NL→Cypher / dynamic Cypher temptation:** the obvious "smarter retrieval" feature is also the failure mode that breaks tenancy. Code-level prohibition (lint + type system); documented security milestone in `requirements.md`; never ship without isolation re-architecture.
- **Read-path retrieval quality:** templates are semantic-blind on long-tail queries (per duck-council review during `/brainstorm`). Mitigation: aggressive entity normalization at ingest (aliases / canonical names in FR-4NY6S1), coverage signals in `meta` envelope so the caller can detect weak retrievals.
- **Hook handler blocking:** if the enqueue path acquires any lock or does sync IO it degrades the Claude Code session. Budget < 200 ms hard.
- **Cheap-model cost drift:** extraction over a busy session runs continuously; cap concurrency and/or batch.
- **Token-existence oracle:** 401 response body must be uniform across "missing token" / "invalid token" / "revoked token" — otherwise an attacker can enumerate.

## Architecture Decision Records

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Auth state location | Graph DB (Approach 1), Split SQLite + graph DB (Approach 2), Stateless JWT (Approach 3) | Split planes (Approach 2) | Fast indexed point-query; clean control/data-plane boundary; revocation effective immediately; graph-DB choice stays independent. `/brainstorm` decision. |
| MCP transport | stdio, HTTP streamable, both | HTTP streamable | Multi-tenant tokens need per-connection identity, which stdio cannot express. |
| Process layout | One process, 2 services, 3 services | One Bun process | Shared auth + DB; minimum deploy surface; extractor extractable later. |
| Graph DB | Kùzu / Neo4j / Memgraph / SQLite-edges | Neo4j Community 5.x (daemon) | Largest Cypher ecosystem; mature Bolt driver; fallback options available behind `GraphAdapter` interface. `/brainstorm` decision after M2 ship. |
| Tenancy mechanism in Neo4j Community | (A) property filter + index, (B) label prefixing per project, (C) project root + `IN_PROJECT` edges | (A) property filter + index | Bullet-proof query rewriter (parameterized templates only) makes (A) safe; (B) sprawls labels and breaks on slug renames; (C) pays a per-read tax forever and fights the 5+ hop ambition. `/brainstorm` decision with duck-council second opinion. |
| Read-path synthesis split | Dumb server (caller synthesizes) / NL→Cypher only / full RAG / hybrid | Dumb server **for the four primitives** | Caller is a SOTA LLM already; avoid duplicating; smallest prompt-injection-laundering surface. Primitives stay prose-free. (Partially revised by the `ask_memory` ADR below.) |
| Server-side answer synthesis (`ask_memory`, M9) | (A) Dumb-server-forever / (B) synthesis via existing templates + defense-in-depth / (C) full NL→Cypher RAG | (B) synthesis over existing templates with defense-in-depth | A one-tool exception delivers a synthesized answer (one round-trip; useful for non-Claude callers) without the tenancy hazard of (C): the agentic loop calls only the existing `project_id`-scoped parameterized templates, never generates Cypher, so the deferred isolation re-architecture is not a prerequisite. Residual prompt-injection risk is bounded by redaction + untrusted-data framing + `<memory>`-wrapped output + read-only tool surface. Reverses the "Read-path synthesis split → Dumb server" decision *for this one tool only*; the NL→Cypher prohibition stands. `/brainstorm` decision (Approach 2, defense-in-depth). |
| Memory MCP shape | Single `search_memory(query)` + `hint` / four primitive tools (`search_memory`, `get_neighbors`, `path_between`, `recent_decisions`) | Four primitives | Templates can't handle expressive multi-hop queries; the caller composes walks via primitives. Mandatory `meta` envelope on every response. Decided post duck-council review during `/brainstorm`. |
| v1 graph schema | Hand-written fixed taxonomy / cheap-model-inferred / hybrid with `:Extension` namespace | Hand-written fixed (5 nodes, 5 relations) | Predictable graph shape; templates can rely on stable labels; extension labels are a future FR. |
| Plugin distribution (M4) | Ship-only-binary (no plugin) / plugin-with-binary-included / plugin-with-thin-shells-around-binary / hosted-SaaS | Plugin-with-thin-shells | Marketplace is a packaging convenience; the binary stays the canonical client logic; platform-portable; smallest plugin footprint (~3-line shell scripts); the binary install remains a one-time per-machine step the README documents. |
| MCP server session model | Stateful (persistent McpServer + transport, `sessionIdGenerator` set) vs Stateless (fresh McpServer + transport per request) | Stateless | The `WebStandardStreamableHTTPServerTransport` refuses to be reused across requests in stateless mode by design; per-request rebuild keeps the surface trivially correct under Bun's request-per-handler model. McpServer build is just closure registration (microseconds); SQLite work dominates request latency. Revisit if SDK adds reusable stateless transports OR if p95 latency under load grows uncomfortable. |
| MCP arg validation | SDK `inputSchema` (yields JSON-RPC -32602 InvalidParams) vs hand-rolled zod inside the handler (yields MCP tool-error `invalid_args` with full issue path) | Hand-rolled in handler | AC-WSFVNP.10 literally mandates `invalid_args` as the error code surface. Calling `schema.safeParse(args)` inside `wrap()` lets us emit the contract-specified shape AND guarantees no DB call happens on validation failure. |
| Bind address (dev vs Docker) | Always `127.0.0.1` (matches AC-HA2WTQ.5 literally; breaks Docker because the container's port mapping cannot forward to the container's loopback) vs configurable via `QUACK_BIND_HOST` env, default `127.0.0.1`, Docker image sets `0.0.0.0` | Configurable env, allowlisted to `{127.0.0.1, 0.0.0.0}` | The loopback-only intent of AC-HA2WTQ.5 (no LAN exposure) is satisfied two different ways depending on runtime: in dev the in-process bind is loopback; in Docker the bind is any-interface inside the container, and the loopback-only guarantee is enforced by compose.yml's `127.0.0.1:7474:7474` host-side mapping (AC-BKPM28.4). The allowlist prevents accidental LAN exposure via a typo. Discovered during M2 docker-compose smoke; documented here as the canonical resolution of the two ACs. |
