---
name: smoke-test
description: Full-stack end-to-end smoke test for Quack — brings up the real Compose stack (server + Neo4j) and runs comprehensive per-tool POSITIVE round-trips proving each MCP tool and each hook actually stores and retrieves correct data end-to-end through the real cheap model. The bash script keeps the Compose lifecycle + MODEL gate + teardown and delegates the assertions to the bun driver `scripts/smoke-assertions.ts`: discover→traverse memory reads (search→neighbors→path→decisions→ask), hook round-trips proven by content + the META_TOOLS denoise negative check, and admin data-effect assertions with the destructive lifecycle last. Use to validate the whole system against a live server + model, beyond `bun test`. Triggers: "smoke test", "smoke-test everything", "run the e2e", "does the whole stack actually work".
---

# Quack full-stack smoke test

This skill validates Quack **end-to-end against a live deployment** — the real
Docker Compose stack (Bun server + Neo4j) reading `.env`, with a real
cheap-model endpoint — covering paths that `bun test` cannot: the on-the-wire
MCP transport, real Gemini/OpenAI extraction + `ask_memory`, and real hook →
`/ingest` round-trips. It is a maintainer tool, not part of the shipped plugin.

**Hybrid structure.** `scripts/smoke-test.sh` owns the Compose lifecycle, the
`MODEL` gate, token minting, and teardown. The comprehensive **positive**
per-tool round-trips live in a separate bun driver,
`scripts/smoke-assertions.ts`, which the bash script invokes as
`bun scripts/smoke-assertions.ts <url> <admin-token> <member-token> <slug>` when
a model is configured; a non-zero driver exit fails the smoke. Because the
extractor is non-deterministic, the driver's assertions are **tolerant/semantic
with bounded retry/poll**, and the read tools use a **discover-then-traverse**
chain (seed via `add_memory`, poll `search_memory` for a real node id, then feed
that id to `get_neighbors` / `path_between`). The driver's decision logic is
factored into pure helpers unit-tested by `scripts/smoke-assertions.test.ts`
(`bun test`, no live stack); the live round-trips are proven by this smoke run.

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
   is unset, warn the user that the **comprehensive per-tool round-trips are
   skipped** (the script prints a `SKIP` line and still exits 0) — they require
   real-model extraction. Only the bring-up, admin-plane, and admin-gate checks
   run in that case.

2. Run the smoke and stream its output:

   ```bash
   bash scripts/smoke-test.sh
   ```

   The bash script keeps the Compose lifecycle, the `MODEL` gate, token minting,
   and teardown. When `QUACK_MODEL_*` is set it derives the member token's row id
   from the container's `auth.sqlite` (for the `revoke_token` round-trip) and
   invokes the bun driver `scripts/smoke-assertions.ts <url> <admin> <member>
   <slug>`, propagating its exit code (a non-zero driver exit fails the smoke).

   The bash script itself performs, against the live stack:
   - **Bring-up**: `/health` `graphdb:ok`, MCP `initialize` handshake.
   - **Admin plane** (bootstrap token): `server_status`, `list_users`,
     `list_projects`, `cleanup_status`, `run_cleanup_now`, `create_project`,
     `register_user`, `add_member` (mints a member token — the same admin-MCP
     mint `/quack:install` performs server-side).
   - **Client `.mcp.json`** written in the exact shape `/quack:install` produces.
   - **Admin gate**: a member token gets `forbidden` on an admin tool.

   The **bun driver** (`scripts/smoke-assertions.ts`, model-gated) then proves the
   comprehensive **positive** round-trips — each with tolerant matching + bounded
   poll to absorb model non-determinism:
   - **Memory read round-trip (discover→traverse)** — `add_memory` seeds an
     interconnected scenario; `search_memory` returns the seeded entities; a node
     id discovered from the search feeds `get_neighbors` (≥1 related node) and
     `path_between` (a real path, not `no_path_found`); `recent_decisions` returns
     the seeded decision; `ask_memory` returns a grounded `<memory>`-wrapped
     answer (`mode_used: "planned"`).
   - **Hook round-trips by content** — `session_start` / `post_tool_use` / `stop`
     fired with known content surface via `search_memory`, **and** a `META_TOOLS`
     (`ToolSearch`) `post_tool_use` fired through the **real hook entry** is
     dropped client-side (no `/ingest`, no `Decision`) — the end-to-end check of
     the M10 / FR-Z1W6ED denoise.
   - **Admin data-effect + destructive lifecycle (last)** — `list_users` /
     `list_projects` contain the created entities, `server_status` counts reflect
     activity, the admin gate blocks a member token, then `revoke_token` /
     `remove_member` → the member token is subsequently rejected and
     `delete_project` → the project is gone.

   The driver's decision logic (matchers, node-id discovery, sentinels, exit
   aggregation) is factored into pure helpers covered by
   `scripts/smoke-assertions.test.ts` under `bun test` (no live stack); this smoke
   run is what proves the live round-trips.

3. Read the final `==== SMOKE TEST: <P> passed, <F> failed ====` line (and the
   driver's own `==== SMOKE ASSERTIONS: ... ====` tally). Report the pass/fail
   tally and surface any `❌` lines with the captured response. Non-zero exit ⇒ a
   real failure; investigate with `docker compose logs quack`.

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
