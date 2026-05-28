---
name: smoke-test
description: Full-stack end-to-end smoke test for Quack — brings up the real Compose stack (server + Neo4j), exercises every MCP tool, the admin gate, the add_memory→extraction→search pipeline, ask_memory (real cheap-model), and a real hook→/ingest round-trip, then tears the stack down. Use to validate the whole system against a live server + model, beyond `bun test`. Triggers: "smoke test", "smoke-test everything", "run the e2e", "does the whole stack actually work".
---

# Quack full-stack smoke test

This skill validates Quack **end-to-end against a live deployment** — the real
Docker Compose stack (Bun server + Neo4j) reading `.env`, with a real
cheap-model endpoint — covering paths that `bun test` cannot: the on-the-wire
MCP transport, real Gemini/OpenAI extraction + `ask_memory`, and real hook →
`/ingest` round-trips. It is a maintainer tool, not part of the shipped plugin.

## When to use

- Before a release, or after touching the server / MCP / hooks / extractor /
  `ask_memory`, to confirm the whole stack still works against a live model.
- When `bun test` is green but you want proof the real wire paths work.

## Cost & side effects (tell the user before running)

- Runs `docker compose up -d --build` (builds the image, starts Neo4j + server,
  creates volumes) and **`docker compose down -v` on exit** (removes the test
  volumes — the smoke data is disposable).
- Spends a small amount of **cheap-model tokens** (extraction + `ask_memory`)
  when `QUACK_MODEL_*` is configured in `.env`.
- Requires Docker reachable and a populated `.env`
  (`QUACK_BOOTSTRAP_TOKEN`, `QUACK_NEO4J_PASSWORD`; plus `QUACK_MODEL_API_KEY` +
  `QUACK_MODEL_BASE_URL` to exercise the model-backed paths). Skips cleanly if
  Docker is unreachable.

## Procedure

1. Confirm Docker is running and `.env` exists with the required keys (the
   script enforces this and skips/fails loudly otherwise). If `QUACK_MODEL_*`
   is unset, warn the user that `ask_memory` + extraction will be validated only
   via the `model_unavailable` gate, not a real answer.

2. Run the deterministic driver and stream its output:

   ```bash
   bash scripts/smoke-test.sh
   ```

   It performs, against the live stack:
   - **Admin plane** (bootstrap token): `server_status`, `list_users`,
     `list_projects`, `cleanup_status`, `run_cleanup_now`, `create_project`,
     `register_user`, `add_member` (mints a member token — the same admin-MCP
     mint `/quack:install` performs server-side).
   - **Client `.mcp.json`** written in the exact shape `/quack:install` produces.
   - **Memory plane** (member token): `search_memory`, `get_neighbors`,
     `path_between`, `recent_decisions` + the **admin gate** (member token →
     `forbidden` on an admin tool).
   - **`add_memory` → extraction → `search_memory`** — confirms the real model
     digested content into the graph.
   - **`ask_memory`** — confirms a grounded, `<memory>`-wrapped answer
     (`mode_used: "planned"`) when a model is configured, else the
     `model_unavailable` gate.
   - **Hook → `/ingest`** — pipes a `PostToolUse` payload to the real hook entry
     (`plugins/quack/hooks/_lib/entry/post_tool_use.ts`) from the client dir and
     asserts the server's `accepted_total` counter advanced.

3. Read the final `==== SMOKE TEST: <P> passed, <F> failed ====` line. Report
   the pass/fail tally and surface any `❌` lines with the captured response.
   Non-zero exit ⇒ a real failure; investigate with `docker compose logs quack`.

4. The script tears the stack down on exit and removes its temp client dir — no
   manual cleanup needed. Teardown runs `docker compose down -v --rmi local`
   (drops the compose-built quack image + volumes) plus `docker builder prune -f`,
   so repeated runs don't accumulate Docker cruft. The pulled `neo4j:5-community`
   image is left cached (re-pulling it is slow).

## Optional — exercise the real `/quack:install` command

The script mints the member token via the admin MCP directly (server-side parity
with the install command). To additionally exercise the **plugin command** path
end-to-end, run it headlessly in a throwaway project with the admin MCP wired via
`--mcp-config` (never `--dangerously-skip-permissions` — scope with
`--allowedTools`):

```bash
TMP=$(mktemp -d); (cd "$TMP" && git init -q)
printf '{"mcpServers":{"quack":{"type":"http","url":"http://127.0.0.1:7474/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$QUACK_BOOTSTRAP_TOKEN" > /tmp/quack-admin-mcp.json
( cd "$TMP" && QUACK_ADMIN_TOKEN="$QUACK_BOOTSTRAP_TOKEN" QUACK_SERVER_URL=http://127.0.0.1:7474 \
  claude -p "/quack:install demo --sub demo" --mcp-config /tmp/quack-admin-mcp.json \
  --allowedTools "mcp__quack__create_project" "mcp__quack__register_user" "mcp__quack__add_member" "Write" "Read" \
  --output-format text )
# expect: .mcp.json written at $TMP with a member token + X-Quack-Sub-Project
```

## Rules

- Always confirm the cost/side-effects with the user before the first run in a
  session (Docker build + model tokens + volume teardown).
- Never pass `--dangerously-skip-permissions` to a nested `claude -p`; scope with
  `--allowedTools`.
- The smoke test is disposable: it always tears its stack + volumes down. Do not
  point it at a stack holding real data.
