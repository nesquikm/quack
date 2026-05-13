# Quack

A personal memory layer for Claude Code.

<!-- BEGIN: quack-deployment-section -->
## Deployment

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

### Backup

`auth.sqlite` lives on the `quack-data` volume; graph data lives on
`quack-graph-data`.

```bash
docker run --rm -v quack-data:/data alpine tar cz /data > quack-auth-backup.tgz
docker run --rm -v quack-graph-data:/data alpine tar cz /data > quack-graph-backup.tgz
```
<!-- END: quack-deployment-section -->
