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
- **Graph engine (M3+):** Neo4j Community Edition 5.x runs as a separate `graphdb` Compose service. Per-project tenancy is implemented via an indexed `project_id` property on every memory-plane node. `GraphAdapter` exposes **only strictly parameterized template runners** (`run(templateId, params, ctx)`) — `project_id` is a non-negotiable bind parameter in every template; no raw-Cypher pass-through; no string-built `WHERE` injection. Templates are the security boundary, not just a product surface.
- **Memory-plane MCP surface (M3+):** Retrieval is exposed as **four primitive MCP tools**, all member-or-admin readable, all returning **structured DTOs only — never prose**: `search_memory`, `get_neighbors`, `path_between`, `recent_decisions`. Every response carries a mandatory `meta` envelope (`{ mode_used, coverage, warnings, explain? }`) so the caller can detect weak retrievals. The query-planning role lives with the caller (Claude Code); Quack is the dumb-server end of the split. Results are wrapped in `<memory>…</memory>` at the MCP boundary and surfaced as untrusted text.
- **Project membership:** A project can have multiple users; a user can belong to multiple projects. Membership is tracked in `auth.sqlite` `project_members(user_id, project_id, role)`. Admin-only MCP tools (`add_member`, `remove_member`) manage the table. Removing a member revokes their token(s) for that project but does not affect their access to other projects.
- **Management surface:** User and project lifecycle is managed via MCP tools, not a web UI or separate REST endpoints. The tools (`register_user`, `remove_user`, `create_project`, `delete_project`, `add_member`, `remove_member`, `revoke_token`, `list_projects`, `list_users`) are exposed by the same MCP server, gated to admin tokens. Non-admin tokens calling a management tool ⇒ HTTP 403.
- **Cheap-model API access:** The server reads `QUACK_MODEL_API_KEY` (secret bearer for the OpenAI-compatible endpoint) and `QUACK_MODEL_BASE_URL` (e.g., `https://api.anthropic.com/v1`, `https://api.openai.com/v1`, `http://localhost:11434/v1`) at startup. These are **server-wide** — all projects share the same model account / billing. The key is read from environment only, never persisted to `auth.sqlite` and never written to logs. Both vars are *optional in M2* (extractor is not yet wired) and *required from M3* (first extractor call). Per-project override is out of scope in v1 and may be added additively later.
- **Network surface:** Both endpoints bind to `127.0.0.1` inside the container by default. Exposure beyond localhost is an explicit per-deployment opt-in via Compose port mapping (Tailscale, reverse proxy, etc.). The bootstrap admin token MUST NOT be logged.
- **Deployment surface:** Quack ships as a Docker Compose stack. One required service (`quack`, the Bun runtime hosting ingest + MCP + extractor in one process); zero or one optional graph-DB service depending on the eventual graph-DB choice (embedded ⇒ omitted; daemon ⇒ included). A named volume holds `auth.sqlite` and any embedded graph data. `docker compose up` from a clone is the canonical install path.
- **Delivery model (M4+):** Quack ships as **two complementary artifacts in one repo**: (a) a self-hosted server (Docker Compose stack at the repo root) — the source of truth; (b) a Claude Code marketplace plugin (`plugins/quack/`) for client-side hooks + MCP config + setup command. The plugin is a packaging convenience that wraps the M3 `quack-hook` binary in thin shell scripts and declares the MCP server with env-var-driven config (`${QUACK_TOKEN}` + `${QUACK_SERVER_URL}`). **Self-hosted only — no SaaS instance.** When a user installs the plugin from the marketplace, only `plugins/quack/` is downloaded; server code, Compose stack, specs, and other repo internals stay out of the install path.
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
- `QUACK_MODEL_API_KEY` never logged; redacted by the same logger pass that strips `Authorization:` headers. Rotation = restart with new env value.
- Dynamic Cypher / NL→Cypher is reserved for a future **security milestone** (not a v1 retrieval upgrade). It MUST NOT ship until per-project isolation is re-architected (separate Neo4j databases on Enterprise, or hard query sandboxing on Community). Templates are the v1 isolation mechanism; bypassing them bypasses tenancy.

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
| Model API key leakage | `QUACK_MODEL_API_KEY` echoed in logs or error responses | Same logger redaction pass strips the parsed env value; never include in error bodies; documented `docker secrets` for prod deployments |
| Server reachable from untrusted network | Misconfigured port mapping exposes container externally | Default bind to `127.0.0.1`; documented as opt-in to expose; ops responsibility for reverse-proxy hardening |
| NL→Cypher escape from tenancy | Future LLM-generated Cypher emits a query that bypasses the `project_id` filter | No dynamic Cypher in v1 — `GraphAdapter` exposes only bounded server-owned parameterized templates; raw `session.run()` is forbidden at the type / lint level. Dynamic Cypher gated behind a future security milestone (separate DBs or hard sandboxing). |

## 5. Out of Scope (v1)

- Hybrid vector + graph retrieval (graph only; revisit after retrieval quality measured)
- Consolidation / "dreams" loop (periodic merge pass)
- Decay / TTL on stored memories
- Server-side natural-language answer synthesis — Quack returns structured DTOs only; Claude Code (the caller) synthesizes. No `mode: "llm"` ever returns prose from MCP tools.
- Dynamic Cypher / NL→Cypher in the read path — security milestone; reserved until per-project isolation is re-architected.
- Web UI for user/project management (CLI-via-MCP is the only surface in v1)
- Token rotation flow (revoke + reissue is the only path in v1)
- OAuth / OIDC / external identity provider integration
- In-place admin token rotation (restart-based only in v1)
- Per-project cheap-model API keys (server-wide key only in v1)

## 6. Traceability Matrix

<!-- Populated by /spec-write / /implement as FRs ship -->

| Requirement | Implementation | Tests |
|-------------|---------------|-------|
| AC-HA2WTQ.1 (auth.sqlite schema + idempotent migrations) | `src/auth/sqlite/schema.ts` | `src/auth/sqlite/schema.test.ts` |
| AC-HA2WTQ.2 (token primitives) | `src/auth/tokens.ts` | `src/auth/tokens.test.ts` |
| AC-HA2WTQ.3 (bootstrap admin) | `src/auth/bootstrap.ts` | `src/auth/bootstrap.test.ts` |
| AC-HA2WTQ.4 (AuthMiddleware + uniform 401) | `src/auth/middleware.ts` | `src/auth/middleware.test.ts` |
| AC-HA2WTQ.5 (HTTP routes + 127.0.0.1 bind) | `src/server/index.ts` | `src/server/index.test.ts`, `src/server/bind.test.ts` |
| AC-HA2WTQ.6 + AC-HA2WTQ.8 (logger redaction) | `src/shared/logger.ts` | `src/shared/logger.test.ts` |
| AC-HA2WTQ.7 (auth p95 < 5 ms) | `src/auth/middleware.ts` | `src/auth/middleware.bench.test.ts` |
| AC-HA2WTQ.8 (env schema) | `src/shared/env.ts` | `src/shared/env.test.ts` |
| AC-WSFVNP.1 (MCP mount + admin gate) | `src/mcp/server.ts`, `src/mcp/dispatch.ts` | `src/mcp/server.test.ts`, `src/mcp/dispatch.test.ts` |
| AC-WSFVNP.2 (register_user) | `src/admin/tools/register_user.ts` | `src/admin/tools/register_user.test.ts` |
| AC-WSFVNP.3 (remove_user) | `src/admin/tools/remove_user.ts` | `src/admin/tools/remove_user.test.ts` |
| AC-WSFVNP.4 + AC-WSFVNP.5 (create/delete project) | `src/admin/tools/create_project.ts`, `src/admin/tools/delete_project.ts` | `src/admin/tools/create_project.test.ts`, `src/admin/tools/delete_project.test.ts` |
| AC-WSFVNP.6 + AC-WSFVNP.7 (add/remove member) | `src/admin/tools/add_member.ts`, `src/admin/tools/remove_member.ts` | `src/admin/tools/add_member.test.ts`, `src/admin/tools/remove_member.test.ts` |
| AC-WSFVNP.8 (revoke_token) | `src/admin/tools/revoke_token.ts` | `src/admin/tools/revoke_token.test.ts` |
| AC-WSFVNP.9 (list_projects / list_users) | `src/admin/tools/list_projects.ts`, `src/admin/tools/list_users.ts` | `src/admin/tools/list_projects.test.ts`, `src/admin/tools/list_users.test.ts` |
| AC-WSFVNP.10 + AC-WSFVNP.11 (zod schemas + DTO mappers) | `src/admin/dto.ts`, per-tool zod schemas | per-tool tests + `src/mcp/dispatch.test.ts` |
| AC-956DT2.1–6 (server_status shape, admin-only, null queue) | `src/admin/tools/server_status.ts`, `src/admin/index.ts` | `src/admin/tools/server_status.test.ts` |
| AC-956DT2.7 + AC-956DT2.8 (counters + 401/403 wiring) | `src/metrics/counters.ts`, `src/auth/middleware.ts`, `src/mcp/dispatch.ts` | `src/metrics/counters.test.ts`, `src/admin/tools/server_status.integration.test.ts` |
| AC-956DT2.9 (server_status p95 < 50 ms) | `src/admin/tools/server_status.ts` | `src/admin/tools/server_status.bench.test.ts` |
| AC-BKPM28.1, 7, 8 (Dockerfile, non-root, < 200 MB) | `Dockerfile`, `.dockerignore` | `tests/docker-build.test.ts`, `tests/docker-run.test.ts`, `tests/compose-config.test.ts` |
| AC-BKPM28.2, 4 (compose.yml + loopback) | `compose.yml` | `tests/compose-config.test.ts` |
| AC-BKPM28.3 (.env.example) | `.env.example` | `tests/compose-config.test.ts` |
| AC-BKPM28.5 (README deployment) | `README.md` | `tests/compose-config.test.ts` |
| AC-BKPM28.6 (`docker compose up` healthy in 30 s) | `Dockerfile`, `compose.yml` | `tests/docker-run.test.ts` (skipped when daemon absent) |
