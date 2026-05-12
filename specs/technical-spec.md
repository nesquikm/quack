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
| Graph DB | TBD | Resolve in follow-up `/brainstorm`; encapsulated behind `GraphAdapter` |
| Cross-tenant isolation | Per-project graph partitioning + middleware-resolved `project_id` | Two layers of defense — middleware constrains every query, partitioning constrains the underlying data |

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

### Graph DB (memory plane)

Per-project partitioning is mandatory (mechanism depends on the eventual graph-DB choice — per-project label set in property graphs, per-project DB file in embedded engines). Schema (entities, relations, summaries) is deferred to the graph-DB-choice brainstorm — FRs in M2 work against the `GraphAdapter` interface, not a concrete schema.

## 3. API / Interface Design

### HTTP endpoints

```
POST /ingest        Bearer-auth; body = hook envelope { kind, payload }; returns 202 { accepted: true }
POST /mcp           Bearer-auth; MCP streamable HTTP transport
GET  /health        No auth; returns 200 { ok: true, version }
```

### MCP tools (v1)

**Memory plane (member or admin token):**
- `search_memory(query: string, k?: number = 10)` — returns top-k recalled facts scoped to the caller's project, each wrapped in `<memory>` tags.

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
- `recall_entity(name)`, `related_to(node, hops=2)`, `recent_decisions(topic)`

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

### Cross-store transactions
`delete_project` runs:
1. `BEGIN` in `auth.sqlite`; delete from `projects` (cascades to `project_members`, `tokens`); insert `pending_cleanup(kind='project_graph_partition', ref=<slug>)`; `COMMIT`.
2. Delete the project's graph partition via `GraphAdapter.dropProject(slug)`.
3. Delete the corresponding `pending_cleanup` row on success.

A crash between step 1 and 2 leaves a `pending_cleanup` row that a daily reconciliation sweep drains. The graph partition is the slower operation; making it post-commit keeps the SQLite transaction short.

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

Cheap-model SDK (`@anthropic-ai/sdk` or `openai`) and graph-DB driver added per FR in M2.

## 6. Risks & Considerations

- **Prompt-injection laundering** (top risk per BRIEF.md): tool output stored as a "fact" and later surfaced via `search_memory` becomes Claude-trusted unless wrapped at the MCP boundary. Tests for this boundary are non-negotiable.
- **Cross-store consistency:** `auth.sqlite` and graph DB are two stores. `delete_project` is multi-step; a crash mid-delete leaves orphan graph data. Mitigation: `pending_cleanup` table + daily reconciliation sweep. Acceptable for v1 personal/team scale; revisit if scale grows.
- **Bootstrap token leakage:** `QUACK_BOOTSTRAP_TOKEN` sits in `.env`. Ops must `.gitignore` it (already in M1) and use `docker secrets` or equivalent in production. Documented in deployment README.
- **HTTP MCP transport maturity:** streamable HTTP MCP is newer than stdio. Pin SDK version; integration-test against the Claude Code MCP client in CI.
- **Graph DB lock-in:** the candidate engines (Kùzu, Neo4j, Memgraph, SQLite-with-edges) have very different query models. Defer the choice but encapsulate behind `GraphAdapter` so the bet is reversible.
- **Hook handler blocking:** if the enqueue path acquires any lock or does sync IO it degrades the Claude Code session. Budget < 200 ms hard.
- **Cheap-model cost drift:** extraction over a busy session runs continuously; cap concurrency and/or batch.
- **Token-existence oracle:** 401 response body must be uniform across "missing token" / "invalid token" / "revoked token" — otherwise an attacker can enumerate.

## Architecture Decision Records

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Auth state location | Graph DB (Approach 1), Split SQLite + graph DB (Approach 2), Stateless JWT (Approach 3) | Split planes (Approach 2) | Fast indexed point-query; clean control/data-plane boundary; revocation effective immediately; graph-DB choice stays independent. `/brainstorm` decision. |
| MCP transport | stdio, HTTP streamable, both | HTTP streamable | Multi-tenant tokens need per-connection identity, which stdio cannot express. |
| Process layout | One process, 2 services, 3 services | One Bun process | Shared auth + DB; minimum deploy surface; extractor extractable later. |
| Graph DB | Kùzu / Neo4j / Memgraph / SQLite-edges | TBD | Deferred to follow-up `/brainstorm`; encapsulated behind `GraphAdapter` interface. |
