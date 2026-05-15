# Quack — Claude Code memory plugin

Quack is a self-hosted memory layer for Claude Code:

- **Hooks** stream session context (`SessionStart`, `PostToolUse`, `Stop`)
  to a local ingest server.
- A **cheap LLM extractor** turns that context into entities and
  relations and writes them into Neo4j.
- A **Memory MCP server** exposes the graph back to Claude Code via
  search / recall tools.

This plugin is the **client surface only**. The server (Bun + SQLite +
Neo4j) lives in the same repository under `src/` + `compose.yml` and runs
locally via `docker compose`. The marketplace install **never** copies the
server into your `~/.claude/plugins/quack/` install — only the files in
this directory.

## Prerequisites

- **Bun** ([https://bun.sh](https://bun.sh)) on PATH — the only host
  prerequisite. The plugin's hook shims execute their TS sources via
  `bunx --bun` (no precompile, no binary, no PATH plumbing).
- **Docker Compose v2** — to run the Quack server stack.
- **direnv** (optional but recommended) — to auto-load per-workspace
  env vars written by `/quack:install`.

## Install — three steps

### Step 1. Clone the Quack repo and bring the server up

```bash
git clone https://github.com/nesquikm/quack.git
cd quack
cp .env.example .env
echo "QUACK_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)" >> .env
echo "QUACK_NEO4J_PASSWORD=$(openssl rand -base64 32)"  >> .env
docker compose up -d
curl -fsS http://127.0.0.1:7474/health
```

The bootstrap token is consumed on first boot only — the server logs the
initial admin token. Capture it; you will need it in step 3.

### Step 2. Install the plugin from the local marketplace

From the cloned `quack/` repo root:

```bash
claude plugin marketplace add ./
claude plugin install quack@quack
```

This copies `plugins/quack/` (this directory) into your Claude Code plugin
install root (`~/.claude/plugins/cache/quack/quack/<version>/`). Verify
with `claude plugin list` — you should see `quack@quack` enabled.

The shipped hook wrappers `exec bunx --bun
"${CLAUDE_PLUGIN_ROOT}/hooks/_lib/entry/<name>.ts"`. If `bunx` is not on
PATH the wrappers exit `0` silently and print one stderr line — broken
installs never break Claude Code sessions.

### Step 3. Per-workspace: bind a project and let direnv load it

In each workspace where you want Quack memory:

```bash
cd <your-workspace>
export QUACK_ADMIN_TOKEN=<the admin token from step 1>
/quack:install <slug>      # in a Claude Code session inside this workspace
direnv allow
```

`/quack:install <slug>` (this plugin) mints a per-workspace `(user,
project)` token via the admin MCP tools and writes a `.envrc`. After
`direnv allow` every Claude Code session opened in this workspace picks
up `QUACK_TOKEN` + `QUACK_SERVER_URL` + `QUACK_PROJECT_SLUG` from the
environment.

## What this plugin ships

```
plugins/quack/
├── .claude-plugin/plugin.json     # plugin manifest (single source of truth for version)
├── hooks/
│   ├── hooks.json                 # event → command mapping (literal ${CLAUDE_PLUGIN_ROOT})
│   ├── session_start.sh           # 2-line bunx wrapper → _lib/entry/session_start.ts
│   ├── stop.sh                    # 2-line bunx wrapper → _lib/entry/stop.ts
│   ├── post_tool_use.sh           # 2-line bunx wrapper → _lib/entry/post_tool_use.ts
│   └── _lib/                      # canonical TS hook sources (dispatch/redact/post/config/payload + entries)
├── mcp-servers/quack.json         # Quack memory MCP server (HTTP + Bearer)
├── commands/quack-install.md      # /quack:install <slug>
└── README.md                      # this file
```

## Environment

The MCP server config reads two variables — set them per-workspace via
`.envrc` (recommended) or globally in your shell profile.

| Variable           | Default                     | Notes                                       |
|--------------------|-----------------------------|---------------------------------------------|
| `QUACK_SERVER_URL` | `http://127.0.0.1:7474`     | Loopback default for `docker compose up`.   |
| `QUACK_TOKEN`      | *(no default)*              | Per-workspace token. Absence = no connect.  |

Hooks read the same two variables plus an optional `QUACK_PROJECT_SLUG`.

> **`QUACK_TOKEN` has no default — intentionally.** When unset, Claude
> Code's MCP layer substitutes the variable with an empty string and the
> `Authorization: Bearer ` header reaches the server with no credential
> attached; the server rejects the request with `401` and Claude Code
> surfaces a one-time "MCP server failed to connect" error. That is the
> intended UX — it prompts the user to run `/quack:install <slug>` for the
> workspace. **If you see that error**, run `/quack:install` first, then
> restart your Claude Code session (so direnv re-exports the new env).

## Why an admin token?

`/quack:install` mints workspace tokens by calling the server's admin MCP
tools (`create_project`, `register_user`, `add_member`). That is a
**privileged** operation — we keep it gated behind a separately-held
`QUACK_ADMIN_TOKEN` env var rather than baking it into the plugin config.
Per-workspace tokens are non-admin and safe to drop into `.envrc`.

## Manual smoke (AC-ZSN2GG.11)

After installing the plugin in a workspace (`claude plugin marketplace
add <quack-repo> && claude plugin install quack@quack`):

1. Confirm the server is up: `curl -fsS http://127.0.0.1:7474/health`.
2. Open a fresh Claude Code session in the workspace.
3. Have a short conversation that produces a clear decision (e.g.
   "let's name this project Quack"). Stop the session.
4. From a **different** workspace / session, check Neo4j:

   ```bash
   docker compose exec graphdb cypher-shell -u neo4j -p "$QUACK_NEO4J_PASSWORD" \
     'MATCH (d:Decision) RETURN d LIMIT 5'
   ```

   You should see at least one `Decision` node with the conversation
   summary.
5. From another fresh Claude Code session in the same workspace, ask the
   Quack MCP server: `Call the search_memory tool with query "name"`. The
   prior decision should surface in the results.

## Troubleshooting

- **`claude plugin install quack@quack` fails** — check `claude plugin
  marketplace list` shows the local marketplace; re-run
  `claude plugin marketplace add ./` from the Quack repo root.
- **`[quack-hook plugin] bunx not found`** stderr line — install Bun
  ([https://bun.sh](https://bun.sh)) so per-workspace memory hooks can
  fire.
- **MCP server fails to connect after `claude plugin install`** — usually means
  `QUACK_TOKEN` is unset. `/quack:install <slug>` mints one.
- **Hooks fire but nothing lands in Neo4j** — tail
  `docker compose logs -f quack` for `ingest_envelope_rejected` lines. The
  most common cause is a stale `QUACK_TOKEN` after a token rotation.

## See also

- Repo-root [README](../../README.md) — server deployment + the rest of
  the operator surface.
- The canonical hook TS sources live under `plugins/quack/hooks/_lib/`
  inside the plugin tree. The plugin depends on the three hook kinds
  (`session_start`, `stop`, `post_tool_use`) wired through `hooks.json`.
