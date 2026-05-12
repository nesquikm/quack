# Quack

A personal memory layer for Claude Code.

<!-- BEGIN: quack-deployment-section -->
## Deployment

Quack ships as a Docker Compose stack. Compose v2 (the `docker compose` CLI
plugin) is required — Compose v1 (`docker-compose` binary) is not supported.

### Quickstart

```bash
# 1. Generate a bootstrap token and put it in .env (gitignored).
echo "QUACK_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)" >> .env

# 2. Bring the stack up.
docker compose up -d

# 3. Sanity-check the loopback-only health endpoint.
curl -fsS http://127.0.0.1:7474/health
```

`QUACK_BOOTSTRAP_TOKEN` is consumed **only on the first boot** (when the `users`
table is empty); it mints the initial admin user/project/membership/token and is
ignored on every subsequent start. Rotation = revoke the token via the
`revoke_token` MCP tool and re-issue from another admin.

### Enabling the graph-DB daemon profile

A second (optional) `graphdb` service sits behind the `daemon-graph` Compose
profile. The graph-DB engine is **TBD** (the profile is a placeholder until the
choice resolves in a follow-up `/brainstorm`):

```bash
docker compose --profile daemon-graph up -d
```

Once a concrete engine is pinned, the profile name stays the same — existing
`docker compose --profile daemon-graph up` commands keep working.

### Backup

`auth.sqlite` and, for embedded graph engines, the graph data files live on the
named `quack-data` volume.

```bash
docker run --rm -v quack-data:/data alpine tar cz /data > quack-backup.tgz
```
<!-- END: quack-deployment-section -->
