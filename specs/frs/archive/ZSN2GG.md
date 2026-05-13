---
title: Quack plugin packaging (marketplace + hooks + MCP config + /quack:install)
milestone: M4
status: archived
archived_at: 2026-05-13T10:56:30Z
id: fr_01KRG9F0C6GKZB5YZ34CZSN2GG
created_at: 2026-05-13T11:00:00Z
---

## Requirement

Ship Quack as a Claude Code marketplace plugin in the same repo as the server. Add `.claude-plugin/marketplace.json` at the repo root declaring `./plugins/quack/` as the single plugin source. Inside `plugins/quack/`: plugin manifest (`plugin.json`), three thin-shell hook wrappers under `hooks/` that exec the M3-shipped `quack-hook` binary, one MCP server declaration (`mcp-servers/quack.json`) using `${QUACK_SERVER_URL}` + `${QUACK_TOKEN}` env substitution, one `/quack:install <slug>` slash command, and a plugin README.

Server-side code (`src/`, `compose.yml`, `Dockerfile`, `specs/`, `tests/`) lives outside the plugin source path and is **NOT** included when a user installs the plugin from the marketplace. Plugin stays self-hosted-only — the MCP config + hooks point at whatever URL the user sets in their env; no SaaS endpoint is baked in.

## Acceptance Criteria

- AC-ZSN2GG.1: `.claude-plugin/marketplace.json` at repo root with canonical shape: `{ name: "quack", owner: { name: "<owner>" }, metadata: { description }, plugins: [{ name: "quack", version: "<sync with plugin.json>", source: "./plugins/quack/", description, category: "memory", tags: ["mcp", "memory", "hooks", "graph"] }] }`. Schema mirrors the `dev-process-toolkit` reference at `~/workspace/dev-process-toolkit/.claude-plugin/marketplace.json`.
- AC-ZSN2GG.2: `plugins/quack/.claude-plugin/plugin.json` with `{ name: "quack", version, description, author, repository, license, keywords }`. **Single source of truth for plugin version is `plugin.json`**; `marketplace.json` mirrors it; `tests/plugin-version-sync.test.ts` (AC.10) asserts parity at gate time.
- AC-ZSN2GG.3: `plugins/quack/hooks/` contains three executable POSIX shell scripts:
  - `session_start.sh`: `#!/usr/bin/env sh\nexec quack-hook session_start "$@"`
  - `stop.sh`: same pattern with `stop`.
  - `post_tool_use.sh`: same pattern with `post_tool_use`.
  
  All three are `chmod +x`. Scripts pass stdin / stdout / argv through to the binary. If `quack-hook` is not on PATH (`command -v quack-hook` returns non-zero), the script exits 0 silently AND writes one stderr line `[quack-hook plugin] binary not found; run \`bun run build:hook\` in the Quack repo and add dist/quack-hook to PATH` — consistent with FR-S2D0Z5's silent-disable pattern (broken installs never break Claude Code sessions).
- AC-ZSN2GG.4: `plugins/quack/mcp-servers/quack.json` declares the Quack MCP server in Claude Code's plugin MCP schema (verified at impl time against the reference `~/workspace/dev-process-toolkit/plugins/dev-process-toolkit/` + Claude Code docs):
  ```json
  {
    "type": "http",
    "url": "${QUACK_SERVER_URL:-http://127.0.0.1:7474}/mcp",
    "headers": { "Authorization": "Bearer ${QUACK_TOKEN}" }
  }
  ```
  Env substitution syntax follows Claude Code's plugin runtime conventions. `${QUACK_SERVER_URL:-http://127.0.0.1:7474}` provides a sensible default (local docker compose); `${QUACK_TOKEN}` has **no default** — absence makes Claude Code's MCP layer fail to connect, surfacing as a one-time error that prompts the user to `/quack:install <slug>` for the workspace.
- AC-ZSN2GG.5: `plugins/quack/commands/quack-install.md` implements the `/quack:install <slug>` slash command. Behavior:
  1. Validates `<slug>` matches `/^[a-z0-9][a-z0-9_-]{0,62}$/` (same regex as FR-WSFVNP create_project AC.4). Invalid ⇒ error message + abort.
  2. Reads `QUACK_ADMIN_TOKEN` + `QUACK_SERVER_URL` (default `http://127.0.0.1:7474`) from env. Missing admin token ⇒ refuse with explicit instructions for setting it.
  3. Calls Quack's admin MCP tools (using the admin token over the configured server URL): `create_project({ slug, display_name: slug })` (handle `project_exists` gracefully → continue with the existing project); `register_user({ username: slug })` OR accept a `--user <name>` flag (handle `user_exists` gracefully → continue); `add_member({ username, project_slug: slug, role: "member" })` (handle `already_member` → call `revoke_token` then re-add or skip); receive the fresh `(user, project)` plaintext token.
  4. Writes (or appends to) a `.envrc` file in the current workspace root (detected via `$PWD` or `git rev-parse --show-toplevel` if inside a git repo):
     ```
     # quack: per-workspace memory bindings
     export QUACK_TOKEN="<plaintext>"
     export QUACK_SERVER_URL="${QUACK_SERVER_URL:-http://127.0.0.1:7474}"
     export QUACK_PROJECT_SLUG="<slug>"
     ```
     If `.envrc` already contains a `QUACK_TOKEN=` line, refuse to overwrite — print the snippet to stdout instead with a "merge manually" hint.
  5. Prints follow-up instructions: `direnv allow` (or `source .envrc`), restart Claude Code in the workspace, verify by observing the MCP server connect successfully.
- AC-ZSN2GG.6: `plugins/quack/README.md` documents the full install flow:
  1. Clone the Quack repo + `cp .env.example .env` + set required env vars + `docker compose up`.
  2. `bun install` + `bun run build:hook` + copy `dist/quack-hook` to PATH (`~/.local/bin/`).
  3. `claude marketplace add <repo-or-path>` + `/plugin install quack`.
  4. Per-workspace: `cd <workspace> && /quack:install <slug> && direnv allow`.
  Each step explains what it accomplishes and how to verify.
- AC-ZSN2GG.7: Repo-root `README.md` is updated with a new top-level **"Install as Claude Code plugin"** section linking to `plugins/quack/README.md`. The existing **"Deployment"** section (from FR-BKPM28 AC.5) is amended to note the plugin path as the recommended install for end users; the server stays an operator-level concern.
- AC-ZSN2GG.8: `.dockerignore` is extended to exclude `plugins/` (plugin files are not server runtime concerns; keeps the Docker image small). The existing `dist/` exclusion (from FR-BKPM28 AC.7) already covers `dist/quack-hook`.
- AC-ZSN2GG.9: `tests/plugin-install-local.test.ts` exercises the round-trip: (a) `claude marketplace add /Users/<user>/workspace/quack` succeeds (or the test's working directory equivalent); (b) `claude plugin install quack` succeeds; (c) the installed plugin under `~/.claude/plugins/quack/` (or wherever Claude Code installs to) contains `hooks/`, `mcp-servers/`, `commands/`, `README.md`, `.claude-plugin/plugin.json` and **nothing more**; (d) the installed plugin does **NOT** contain `src/`, `compose.yml`, `Dockerfile`, `specs/`, repo-root `CLAUDE.md`, or any other non-plugin file. Skips when `claude` CLI isn't on PATH.
- AC-ZSN2GG.10: `tests/plugin-version-sync.test.ts` asserts that `plugins/quack/.claude-plugin/plugin.json` `version` AND `.claude-plugin/marketplace.json` `plugins[0].version` are the **same string**. The plugin's version is decoupled from the server's `package.json` `version` (server and plugin release on independent cadences); the sync test only governs the two plugin-side files.
- AC-ZSN2GG.11: M4 closeout smoke (manual, documented in plugin README): fresh checkout → `docker compose up` (server healthy) → `bun run build:hook` → install binary on PATH → `claude marketplace add ./` → `/plugin install quack` → in a workspace, `/quack:install demo` → `direnv allow` → start a Claude Code session → observe a `Decision` node land in Neo4j → recall it via `search_memory` from a fresh session.

## Technical Design

### Files added (all marketplace-side, in `plugins/quack/` or `.claude-plugin/` except where noted)

- `.claude-plugin/marketplace.json` (repo root) — marketplace declaration.
- `plugins/quack/.claude-plugin/plugin.json` — plugin manifest.
- `plugins/quack/hooks/{session_start,stop,post_tool_use}.sh` — three thin-shell wrappers around `quack-hook` binary; `chmod +x`; silent-disable when binary absent.
- `plugins/quack/mcp-servers/quack.json` — Quack MCP server declaration with env-var substitution.
- `plugins/quack/commands/quack-install.md` — `/quack:install <slug>` slash command spec (Claude Code reads the markdown body as the command prompt).
- `plugins/quack/README.md` — full install / setup documentation.
- Repo-root `README.md` updated (new section + Deployment section amendment).
- `.dockerignore` updated.
- `tests/plugin-install-local.test.ts` + `tests/plugin-version-sync.test.ts`.

### Schema reference

Marketplace and plugin schema details follow the `dev-process-toolkit` reference at `~/workspace/dev-process-toolkit/`. At implementation time, re-verify against current Claude Code plugin docs since the schema may evolve. Discrepancies should be flagged and resolved before merge — the spec is a target, not a contract with Claude Code's plugin runtime.

### Plugin dependencies

None — pure markdown + shell + JSON files. No `node_modules`, no build step inside the plugin (the binary lives outside).

### Out of scope here

- Additional slash commands (`/quack:status`, `/quack:recall`, `/quack:register-user`) — reserved for M5+.
- Shipping the `quack-hook` binary inside the plugin (would balloon footprint + require cross-platform builds).
- Public marketplace publishing / SEO / discoverability — local-only install is the v1 distribution path.
- Plugin auto-update mechanism — `/plugin install quack` re-run is the upgrade path.
- Per-workspace MCP-config overrides without `.envrc` — direnv-style env management is the assumed UX.

## Testing

- `tests/plugin-version-sync.test.ts` — parses both JSON files; asserts versions match. Always runs.
- `tests/plugin-install-local.test.ts` — shells out to `claude` CLI; skipped automatically when CLI not on PATH or when the test runner lacks marketplace-write permissions. Asserts install round-trip + the invisible-server-files invariant.
- `tests/plugin-hooks-syntax.test.ts` (small) — `sh -n hooks/*.sh` syntax check; asserts the silent-disable stderr line exists in each script.
- Manual smoke (AC.11) documented in plugin README; not automated.

## Notes

- The plugin doesn't ship a binary — keeps the install footprint tiny (each shell script is ~5 lines) and avoids cross-platform binary packaging (Linux x86_64 / Linux ARM / macOS x86_64 / macOS ARM all need separate `bun build --compile` runs).
- The `${QUACK_SERVER_URL:-http://127.0.0.1:7474}` default keeps the most common case (local docker compose) zero-config; users running the server on a remote host (homelab, Tailscale, etc.) override it.
- `${QUACK_TOKEN}` has no default — absence is intentional. Per-workspace tokens via `.envrc` mean each workspace's Claude Code session sees a different token via direnv (or whatever shell-env mechanism the user picks).
- The `/quack:install <slug>` admin-token requirement is deliberate: token minting is a privileged operation. The alternative (storing admin token in plugin config) would be a worse security posture. Documented in the plugin README.
- Plugin version vs. server version: decoupled. The plugin is a tiny wrapper; it can ship updates more frequently than the server (or vice versa). The version-sync test (AC.10) only ties together the two plugin-side JSON files.
- Future M5+ additive commands (`/quack:status`, `/quack:recall`, `/quack:register-user`) are straightforward markdown additions under `plugins/quack/commands/`. The current v1 surface is intentionally minimum-viable.
- `claude marketplace add` against a local path (`./` or `/Users/<user>/workspace/quack`) gives a "private marketplace" install — the operator can publish to a public marketplace later by pushing to GitHub and providing the URL instead. No code changes needed for that transition.

## Implementation notes

- plugin.json registration keys (Pass 2 round 2, advisory) — review suggested adding explicit `hooks` / `mcp-servers` / `commands` registration keys to `plugins/quack/.claude-plugin/plugin.json`. Refuted by precedent: the reference plugin manifest at `~/workspace/dev-process-toolkit/plugins/dev-process-toolkit/.claude-plugin/plugin.json` ships the same minimal keys-only shape and works in production (Claude Code uses directory-based discovery for `hooks/`, `mcp-servers/`, `commands/`). Current manifest is correct as-is.
