---
description: Bind the current workspace to a Quack memory project. Mints a per-workspace token via admin MCP tools and writes a `.envrc` for direnv to load.
argument-hint: <slug> [--user <name>]
---

# /quack:install

Bind the current workspace to a Quack memory project. The argument is a project
**slug** (e.g. `demo`, `acme-prod`) plus an optional `--user <name>` override
that defaults to the slug. The slash command mints a per-workspace `(user,
project)` token via Quack's admin MCP tools and writes it into `.envrc` so
`direnv` exposes it to each Claude Code session in this workspace.

Argument: `$ARGUMENTS`

## Behavior

You are running inside a Claude Code workspace. The user invoked
`/quack:install $ARGUMENTS`. Follow these steps **exactly** — do not skip,
reorder, or extend.

### 1. Parse and validate the slug

Read the first whitespace-delimited token of `$ARGUMENTS` as `<slug>`. The
slug **must** match the regex `^[a-z0-9][a-z0-9_-]{0,62}$` (lowercase
alphanumerics plus `-` and `_`, must start with alphanumeric, max 63 chars —
same shape as the `create_project` MCP tool enforces server-side). If it
does not match, refuse with:

```
/quack:install: invalid slug '<slug>'. Slugs must match /^[a-z0-9][a-z0-9_-]{0,62}$/ (lowercase alphanumeric, '-' or '_', start alphanumeric, ≤ 63 chars).
```

Then read the rest of `$ARGUMENTS` for an optional `--user <name>` flag.
Default `<name>` to `<slug>`.

### 2. Probe environment

Read `QUACK_ADMIN_TOKEN` and `QUACK_SERVER_URL` (default
`http://127.0.0.1:7474`) from the environment. If `QUACK_ADMIN_TOKEN` is
unset or empty, refuse with:

```
/quack:install: QUACK_ADMIN_TOKEN is not set. Token minting is a privileged
operation. Export your admin token first:

  export QUACK_ADMIN_TOKEN=<admin-token>

If you don't have one, see plugins/quack/README.md for how to retrieve the
initial admin token from the server's first-boot output.
```

### 3. Call Quack admin MCP tools

Using the Quack MCP server (already declared in the plugin's
`mcp-servers/quack.json` and authenticated with `QUACK_ADMIN_TOKEN`):

1. **Create project** — call `create_project({ slug: "<slug>", display_name: "<slug>" })`.
   - On `project_exists` ⇒ treat as success and continue.
2. **Register user** — call `register_user({ username: "<name>" })`.
   - On `user_exists` ⇒ treat as success and continue.
3. **Add member** — call `add_member({ username: "<name>", project_slug: "<slug>", role: "member" })`.
   - On `already_member` ⇒ call `revoke_token({ username: "<name>", project_slug: "<slug>" })`, then call `add_member` again with `force: true` (or skip the revoke + add if a fresh `add_member` call returns a token directly).

The final call returns a plaintext `(user, project)` token. **Capture this
string verbatim** — the server never re-issues it.

### 4. Write `.envrc`

Find the workspace root via `git rev-parse --show-toplevel` (fall back to
`$PWD` if not inside a git repo). Look at the workspace `.envrc`:

- If `.envrc` already contains a `QUACK_TOKEN=` line, **do not overwrite**.
  Print the snippet to stdout and instruct the user to merge it manually:

  ```
  /quack:install: .envrc already binds QUACK_TOKEN — refusing to overwrite. Merge this snippet manually if you want to switch projects:

  # quack: per-workspace memory bindings
  export QUACK_TOKEN="<plaintext>"
  export QUACK_SERVER_URL="<server-url-as-resolved>"
  export QUACK_PROJECT_SLUG="<slug>"
  ```

- Otherwise, append (or create) `.envrc` with:

  ```
  # quack: per-workspace memory bindings
  export QUACK_TOKEN="<plaintext>"
  export QUACK_SERVER_URL="<server-url-as-resolved>"
  export QUACK_PROJECT_SLUG="<slug>"
  ```

  (Use the same `QUACK_SERVER_URL` value resolved in step 2 — either the
  user's explicit env or the `http://127.0.0.1:7474` default.)

  **After writing, run `chmod 600 .envrc`** so the per-workspace token is
  readable only by the current user. On shared / multi-user machines this
  is the difference between "secret in your home dir" and "secret world-
  readable". If `.envrc` already existed with a tighter mode, `chmod 600`
  is a no-op and safe to run unconditionally.

### 5. Print follow-up instructions

After writing `.envrc`, print exactly:

```
/quack:install: bound this workspace to project '<slug>' as user '<name>'.

Next steps:
  1. unset QUACK_ADMIN_TOKEN           # drop the privileged token from your shell env
  2. direnv allow                      # (or: source .envrc)
  3. Restart your Claude Code session in this workspace.
  4. Verify the Quack MCP server connects (it appears in /mcp list and
     responds to `server_status`).
  5. Trigger a hook (e.g. SessionStart fires automatically; or run any
     tool to fire post_tool_use) and tail the Quack server logs:
       docker compose logs -f quack
     You should see `ingest_envelope_accepted` rows.
```

## Notes

- The slash command is **idempotent** — running it again with the same
  `<slug>` returns the existing project, reuses the existing user when the
  name matches, and only revokes / re-issues the token when needed.
- The admin-token requirement is deliberate: minting per-workspace tokens
  is a privileged operation and must not be reachable from a per-workspace
  Claude Code session. See the plugin README's "Why admin token?" note.
- Storing the plaintext token in `.envrc` is the v1 trade-off. Treat
  `.envrc` like any other secret file — `git add .envrc` only when your
  repo policy expects it; otherwise add to `.gitignore`.
