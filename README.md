# Quack

A personal, per-project memory layer for Claude Code.

## How it works

Quack gives Claude Code a persistent memory that survives across sessions.
Three moving parts:

1. **Hooks** (shipped in the plugin) fire on Claude Code session events and
   stream a redacted snapshot of session context to a local ingest server —
   fire-and-forget, so they never block your session on the network or the
   model.
2. **A cheap-model extractor** on the server digests that context into
   entities, relations, and decisions and writes them into a Neo4j graph,
   partitioned per project.
3. **An MCP server** exposes that graph back to Claude Code as search / recall
   tools, so a later session can ask what was decided and why.

```
Claude Code hooks ──► /ingest ──► cheap-model extractor ──► Neo4j graph
                                                              ▲
                                                              │ MCP tools
Claude Code  ◄────────────────────────────────────────────────┘
```

Both the ingest endpoint and the MCP server sit behind bearer-token auth: each
token authenticates exactly one `(user, project)` pair. The server is
multi-tenant — one admin bootstraps users and projects via admin-only MCP tools
(no web UI).

**Design constraints baked in:**

- **Hooks are fire-and-forget.** A hook failure or a slow server never breaks
  or stalls a Claude Code session.
- **Recalled memory is untrusted.** Every memory tool wraps its results in
  `<memory>…</memory>` tags; Claude must treat them as untrusted text, not
  system instructions. This is the core defense against prompt-injection
  laundering — tool output stored as a "fact" and later re-injected as trusted
  memory.
- **Loopback by default.** The server binds to `127.0.0.1`; expose it beyond
  localhost only behind Tailscale / SSH and an explicit decision.
- **Redaction before egress.** Hooks redact secrets client-side and the server
  redacts again before anything reaches the cheap model.

## Install as Claude Code plugin

End users — the supported install path is the marketplace plugin. The
only host prerequisite is Bun ([https://bun.sh](https://bun.sh)) — the
plugin's hook shims execute their TS sources via `bunx --bun`, no
precompile / no PATH plumbing. From a clone of this repo:

```bash
# 1. Bring up the server (one-time).
docker compose up -d

# 2. Install the plugin (one-time).
claude plugin marketplace add ./
claude plugin install quack@quack

# 3. Bind each workspace (repeat per workspace).
cd <your-workspace>
export QUACK_ADMIN_TOKEN=<admin-token-from-first-boot>
/quack:install <slug>
# /quack:install writes a project-scoped .mcp.json — restart your
# Claude Code session once so it picks up the new MCP server.
```

Full walkthrough: [`plugins/quack/README.md`](plugins/quack/README.md). Operators
running the server-only path (no plugin, hooks wired via your own
`hooks.json`) — see the **Deployment** section below.

## MCP tools

The MCP server exposes 18 tools over HTTP at `/mcp`, split into a **memory
plane** (any project member) and an **admin plane** (admin tokens only). The
plane is enforced by the token's role — a member token calling an admin tool
gets `forbidden`.

### Memory tools — member or admin

| Tool | What it does |
|------|--------------|
| `search_memory` | Search the project graph by entity name (full-text + optional 1-hop expansion). |
| `get_neighbors` | Walk the neighbors of a known node up to depth 3, filtered by edge type. |
| `path_between` | Find the shortest path between two nodes (max 8 hops). |
| `recent_decisions` | List the most recent `Decision` nodes within a time window, newest first. |
| `ask_memory` | Plan a multi-step traversal to answer a natural-language question (requires `QUACK_MODEL_*`). |
| `add_memory` | Enqueue content for LLM digestion into the graph; fire-and-forget — surfaces via `search_memory` once extraction finishes. |

Every memory tool returns results wrapped in `<memory>…</memory>` tags — treat
them as untrusted text. No streaming, no history: current graph state only.

### Admin tools — admin token only

| Tool | What it does |
|------|--------------|
| `register_user` | Create a member user and mint a one-time token bound to the `_control_` project. |
| `remove_user` | Delete a user (cascades to memberships + tokens); refuses the last admin or self. |
| `create_project` | Create a project (slug-validated; leading underscore reserved). |
| `delete_project` | Delete a project (cascades) and queue graph-partition cleanup; refuses `_control_`. |
| `add_member` | Add a user to a project at a role and mint a one-time `(user, project)` token. |
| `remove_member` | Remove a membership and revoke that pair's active tokens. |
| `revoke_token` | Revoke an active token by id. |
| `list_users` | List every user (no token data). |
| `server_status` | Snapshot: uptime, queue stats, error counts, seeded counts. |
| `run_cleanup_now` | Trigger an immediate sweep of pending graph-partition cleanup. |
| `cleanup_status` | Report pending / stuck rows, last run, and whether a sweep is running. |

`list_projects` is the one management tool readable by members too: admins see
every project, members see only the projects they belong to.

## Hooks

The plugin wires three Claude Code hook events, mapped in
[`plugins/quack/hooks/hooks.json`](plugins/quack/hooks/hooks.json):

| Hook event | When it fires | What gets forwarded |
|------------|---------------|---------------------|
| `SessionStart` | A Claude Code session starts | The session-open payload, marking the start of a new memory-bearing session. |
| `PostToolUse` | After each tool call returns | The redacted tool call + result — the main signal the server extractor turns into entities, files, and decisions. |
| `Stop` | The agent finishes its turn | The end-of-turn payload, so the extractor can consolidate the exchange into the graph. |

Each event is a 2-line shell shim (`session_start.sh`, `post_tool_use.sh`,
`stop.sh`) that `exec`s `bunx --bun` against its TS source under
`hooks/_lib/entry/`. The TS entry reads the hook payload from stdin, applies a
client-side redaction pass, and fire-and-forget POSTs the envelope to
`${QUACK_SERVER_URL}/ingest`. Failures log one line to stderr and exit `0` — a
hook problem never breaks the session. If `bunx` is not on PATH the shim exits
`0` with a single pointer to [https://bun.sh](https://bun.sh). Install mechanics
live under [Deployment → Hooks installation](#hooks-installation-claude-code--ingest).

<!-- BEGIN: quack-deployment-section -->
## Deployment

> **Audience:** server operators running the Docker stack. End users should
> follow the plugin install path above instead — `claude plugin marketplace add ./`
> + `claude plugin install quack@quack` wraps every step in this section.

Quack ships as a Docker Compose stack. Compose v2 (the `docker compose` CLI
plugin) is required — Compose v1 (`docker-compose` binary) is not supported.

### Quickstart

```bash
# 1. Generate secrets and put them in .env (gitignored).
echo "QUACK_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)" >> .env
echo "QUACK_NEO4J_PASSWORD=$(openssl rand -base64 32)" >> .env

# 2. Bring the stack up (quack + graphdb Neo4j Community).
docker compose up -d

# 3. Sanity-check the loopback-only health endpoint.
curl -fsS http://127.0.0.1:7474/health
```

`QUACK_BOOTSTRAP_TOKEN` is consumed **only on the first boot** (when the `users`
table is empty); it mints the initial admin user/project/membership/token and is
ignored on every subsequent start. Rotation = revoke the token via the
`revoke_token` MCP tool and re-issue from another admin.

`QUACK_NEO4J_PASSWORD` is read on every boot — Neo4j refuses to start without it.
Rotate by `docker compose down && docker volume rm quack_quack-graph-data` to
reset the graph, or by issuing `ALTER USER neo4j SET PASSWORD <new>` via
`cypher-shell` against the running container, then updating `.env`.

### Graph DB (Neo4j Community)

The `graphdb` service runs `neo4j:5-community` and is required from M3 onward
(the `daemon-graph` profile gate from M2 has been removed). Quack waits for
`graphdb` to become healthy before accepting traffic; `/health` reports
`graphdb: "ok" | "down"` based on a 1-second Bolt probe each request.

### Hooks installation (Claude Code → /ingest)

Hooks ship inside the marketplace plugin (`plugins/quack/hooks/`). Each
Claude Code hook event is a 2-line shell shim that `exec`s
`bunx --bun "${CLAUDE_PLUGIN_ROOT}/hooks/_lib/entry/<name>.ts"`. The TS
entry reads the hook payload from stdin, applies a client-side redaction
pass (same default pattern set as the server, defense-in-depth), and
fire-and-forget POSTs the envelope to `${QUACK_SERVER_URL}/ingest`.
Failures log to stderr and exit 0 — the Claude Code session is never
broken by a hook server issue. If `bunx` is not on PATH the shim exits 0
silently with one stderr line pointing at [https://bun.sh](https://bun.sh).

The plugin install path is the supported flow — see "Install as Claude
Code plugin" above. There is no compiled binary; the hook TS sources live
in `plugins/quack/hooks/_lib/` and are executed in-place by `bunx`.

### Backup

`auth.sqlite` lives on the `quack-data` volume; graph data lives on
`quack-graph-data`.

```bash
docker run --rm -v quack-data:/data alpine tar cz /data > quack-auth-backup.tgz
docker run --rm -v quack-graph-data:/data alpine tar cz /data > quack-graph-backup.tgz
```
<!-- END: quack-deployment-section -->

## Prior art

- Anthropic's ["dreams" pattern](https://platform.claude.com/docs/en/managed-agents/dreams)
  for managed agents — background consolidation of context by a cheap model.
- [`tomasonjo/agent-memory-hooks-neo4j`](https://github.com/tomasonjo/agent-memory-hooks-neo4j)
  — proof that the hooks → graph shape works.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).
