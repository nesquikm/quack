# Requirements

## 1. Overview

**Project:** Quack — a memory layer for Claude Code, deployable as a Docker Compose stack and shared across multiple users and multiple projects.

Hooks running on a developer's machine POST session context to a Quack server's HTTP `/ingest` endpoint. A cheap LLM (Haiku / `gpt-4o-mini`-class) extracts entities, relations, and summaries into a graph database, partitioned per project. An MCP server (HTTP transport, same Bun process) exposes search/RAG tools back to Claude Code. Both endpoints sit behind shared bearer-token auth: each token authenticates exactly one `(user, project)` pair.

The server bootstraps an admin from `QUACK_BOOTSTRAP_TOKEN` on first start; admins manage users and projects via admin-only MCP tools (no web UI in v1). Per-project graph partitioning prevents cross-tenant data access at the API boundary. See `BRIEF.md` for the original design rationale and the `/dev-process-toolkit:brainstorm` output for the auth + multi-tenancy decisions.

## 2. Functional Requirements (cross-cutting only)

<!-- Per-FR detail lives in `specs/frs/<id>.md`. Cross-cutting only here. -->

- **Auth scheme:** Both external surfaces (HTTP `POST /ingest`, HTTP MCP at `/mcp`) authenticate via `Authorization: Bearer <token>`. Each token is opaque (32 random bytes, base64url-encoded) and bound to exactly one `(user_id, project_id)` pair. Tokens are stored hashed (SHA-256) at rest; the plaintext is shown to the operator exactly once at issuance and never retrievable thereafter. Missing or invalid token ⇒ HTTP 401 from both endpoints uniformly.
- **Bootstrap admin:** Server reads `QUACK_BOOTSTRAP_TOKEN` on startup. On first boot with an empty `users` table, that token mints an admin row (role = `admin`) with an implicit "control plane" project membership that grants access to management tools. Subsequent boots ignore the env var when an admin already exists. Absence of `QUACK_BOOTSTRAP_TOKEN` on first boot ⇒ refuse to start.
- **Tenancy model:** Multi-tenant. Every memory write and read is scoped by the `project_id` resolved from the request's token; the graph DB is partitioned per project. A token for `(user_a, project_x)` MUST NOT read or write any data in `project_y`. Cross-project queries are not exposed at the API or MCP boundary in v1.
- **Project membership:** A project can have multiple users; a user can belong to multiple projects. Membership is tracked in `auth.sqlite` `project_members(user_id, project_id, role)`. Admin-only MCP tools (`add_member`, `remove_member`) manage the table. Removing a member revokes their token(s) for that project but does not affect their access to other projects.
- **Management surface:** User and project lifecycle is managed via MCP tools, not a web UI or separate REST endpoints. The tools (`register_user`, `remove_user`, `create_project`, `delete_project`, `add_member`, `remove_member`, `revoke_token`, `list_projects`, `list_users`) are exposed by the same MCP server, gated to admin tokens. Non-admin tokens calling a management tool ⇒ HTTP 403.
- **Network surface:** Both endpoints bind to `127.0.0.1` inside the container by default. Exposure beyond localhost is an explicit per-deployment opt-in via Compose port mapping (Tailscale, reverse proxy, etc.). The bootstrap admin token MUST NOT be logged.
- **Deployment surface:** Quack ships as a Docker Compose stack. One required service (`quack`, the Bun runtime hosting ingest + MCP + extractor in one process); zero or one optional graph-DB service depending on the eventual graph-DB choice (embedded ⇒ omitted; daemon ⇒ included). A named volume holds `auth.sqlite` and any embedded graph data. `docker compose up` from a clone is the canonical install path.
- **Fire-and-forget hook contract:** Every Claude Code hook handler returns within < 200 ms and never blocks on the cheap-model extractor. Hooks enqueue locally and acknowledge; extraction runs asynchronously inside the `quack` process.
- **Prompt-injection laundering defense:** Content retrieved from memory (via MCP tools) MUST be wrapped in `<memory>…</memory>` tags at the MCP-server boundary and surfaced as untrusted text, never as trusted system context. Stored "facts" originating from arbitrary tool output are not promoted to trusted memory.
- **Redaction at hook layer:** Hook payloads SHOULD be scrubbed of obvious secrets (`.env` contents, API responses with auth headers, anything matching a configured deny-pattern) before they leave the developer machine for the Quack server.

## 3. Non-Functional Requirements

### NFR-1: Performance
- Hook handler latency budget: < 200 ms for the fire-and-forget enqueue path.
- MCP `search_memory` p95 latency: target < 500 ms on a personal-scale graph.
- Auth check p95: < 5 ms (single indexed SQLite point query on `token_hash`).

### NFR-2: Security
- Bearer token never logged (explicit Authorization-stripping middleware).
- Bootstrap admin token loaded once at startup; never persisted in logs. Rotation = edit env var + restart (no in-place rotation in v1).
- Recalled memory content treated as untrusted (per cross-cutting FR above).
- Redaction policy applied to outbound hook payloads.
- Tokens hashed at rest (SHA-256); plaintext shown once at issuance only.

### NFR-3: Availability
- Personal/team-tool scope — no formal SLO. The system MUST fail open from Claude Code's perspective: ingest server unreachable ⇒ hooks drop silently, never block.

### NFR-4: Deployability
- `docker compose up` from a fresh clone with a valid `.env` (containing `QUACK_BOOTSTRAP_TOKEN`) brings the stack to ready state in < 30 s on a developer laptop.
- Single named volume holds all persistent state — backup = volume snapshot.

## 4. Edge Cases

<!-- Populate as discovered during /spec-write FR drafting or implementation. -->

## Security / Abuse Cases

| Attacker Goal | Attack Vector | Mitigation |
|--------------|---------------|------------|
| Inject malicious instructions into Claude via stored memory | Prompt-injection in tool output that later surfaces via `search_memory` | Wrap recalled content in `<memory>` tags; treat as untrusted text, not system context |
| Exfiltrate secrets via cheap-model API | Hook payload contains `.env` / auth headers | Redaction at hook layer; deny-pattern list applied before outbound POST |
| Cross-tenant data exfiltration | Stolen token for project A used to query project B | Token → `(user_id, project_id)` lookup at middleware; all DB queries scoped by `project_id`; no cross-project read API exists |
| Privilege escalation to admin | Non-admin token calls `register_user` / `create_project` | MCP middleware checks `role = 'admin'` before dispatching management tools; 403 otherwise |
| Token theft from logs | Server logs `Authorization` header verbatim | Bearer-stripping middleware on log writer; explicit unit test that no log line contains the token |
| Server reachable from untrusted network | Misconfigured port mapping exposes container externally | Default bind to `127.0.0.1`; documented as opt-in to expose; ops responsibility for reverse-proxy hardening |

## 5. Out of Scope (v1)

- Hybrid vector + graph retrieval (graph only; revisit after retrieval quality measured)
- Consolidation / "dreams" loop (periodic merge pass)
- Decay / TTL on stored memories
- MCP tools beyond `search_memory` for memory retrieval (`recall_entity`, `related_to`, `recent_decisions` — additive after v1)
- Web UI for user/project management (CLI-via-MCP is the only surface in v1)
- Token rotation flow (revoke + reissue is the only path in v1)
- OAuth / OIDC / external identity provider integration
- In-place admin token rotation (restart-based only in v1)

## 6. Traceability Matrix

<!-- Populated by /spec-write / /implement as FRs ship -->

| Requirement | Implementation | Tests |
|-------------|---------------|-------|
