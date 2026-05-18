# Quack

A personal memory layer for Claude Code.

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
