---
description: Bind the current workspace to a Quack memory project. Mints a per-workspace token via admin MCP tools and writes a project-scoped `.mcp.json`.
argument-hint: <slug> [--user <name>] [--sub <name>]
---

# /quack:install

Bind the current workspace to a Quack memory project. The argument is a project
**slug** (e.g. `demo`, `acme-prod`) plus an optional `--user <name>` override
that defaults to the slug. The slash command mints a per-workspace `(user,
project)` token via Quack's admin MCP tools and writes it into a project-scoped
`.mcp.json` that Claude Code reads natively when a session opens in this
workspace.

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

### 1b. Derive and confirm the sub-project slug

The `X-Quack-Sub-Project` header (written in step 4) needs a **sub-project
slug** identifying this specific workspace within the project. Derive a
suggestion, then confirm it:

1. **Derive a suggestion.** Run `git remote get-url origin`. If it succeeds,
   take the URL **basename** (the last path segment), strip a trailing
   `.git` suffix, and **slug-normalize** it (lowercase; replace any run of
   characters outside `[a-z0-9_-]` with a single `-`; trim leading/trailing
   `-`). When there is **no remote** (the command fails or prints nothing),
   fall back to the **workspace directory basename** — the basename of the
   workspace root resolved in step 4 — slug-normalized the same way.

2. **Confirm.** If `$ARGUMENTS` contains a `--sub <name>` flag, use that
   value directly and **skip the prompt**. Otherwise present the derived
   suggestion interactively for accept-or-override:

   ```
   Sub-project [<derived>] — accept, or type an override:
   ```

   An empty reply accepts `<derived>`; any other reply is the override.

3. **Validate.** The final sub-project value (derived, override, or `--sub`)
   **must** match the regex `^[a-z0-9][a-z0-9_-]{0,62}$`. If it does not
   match, refuse with:

   ```
   /quack:install: invalid sub-project '<value>'. Sub-projects must match /^[a-z0-9][a-z0-9_-]{0,62}$/ (lowercase alphanumeric, '-' or '_', start alphanumeric, ≤ 63 chars).
   ```

The confirmed value becomes the `X-Quack-Sub-Project` header value in
step 4.

### 2. Probe environment

Read `QUACK_ADMIN_TOKEN` and `QUACK_SERVER_URL` (default
`http://127.0.0.1:7474`) from the environment. `QUACK_ADMIN_TOKEN` is
**optional** — its presence selects which token-acquisition branch runs in
step 3. Do **not** refuse when it is unset.

### 3. Acquire the per-workspace token (adaptive)

This step is **adaptive** on whether an admin token is available. Exactly
one of the two branches below runs; both yield the literal `(user,
project)` token written into `.mcp.json` in step 5.

#### Branch A — admin token available (mint via admin MCP)

An admin token is "available" when `QUACK_ADMIN_TOKEN` is set and non-empty
in the environment, **or** the operator supplies one interactively when
prompted. If `QUACK_ADMIN_TOKEN` is unset, you **may** ask the operator
once whether they have an admin token to paste; if they do, treat it as
available and use it for the calls below.

Using the Quack admin MCP server (authenticated with the admin token), run
the existing **idempotent** admin-MCP minting flow:

1. **Create project** — call `create_project({ slug: "<slug>", display_name: "<slug>" })`.
   - On `project_exists` ⇒ treat as success and continue.
2. **Register user** — call `register_user({ username: "<name>" })`.
   - On `user_exists` ⇒ treat as success and continue.
3. **Add member** — call `add_member({ username: "<name>", project_slug: "<slug>", role: "member" })`.
   - On `already_member` ⇒ call `revoke_token({ username: "<name>", project_slug: "<slug>" })`, then call `add_member` again with `force: true` (or skip the revoke + add if a fresh `add_member` call returns a token directly).

The final call returns a plaintext `(user, project)` token. **Capture this
string verbatim** — the server never re-issues it.

#### Branch B — no admin token available (paste an issued token)

When no admin token is available (`QUACK_ADMIN_TOKEN` unset and the
operator has none to supply), do **not** call the admin MCP tools. Instead,
prompt the operator to **paste an already-issued per-workspace token** for
this `(user, project)` pair:

```
/quack:install: no admin token available — cannot mint a new token.
Paste an already-issued per-workspace token for user '<name>' / project
'<slug>' (ask your Quack admin to run /quack:install or the admin MCP flow
for you):
```

Capture the pasted string verbatim as the per-workspace token. If the
operator pastes nothing, refuse and stop.

Either branch yields the literal per-workspace token used in step 5.

### 4. Write `.mcp.json`

Find the workspace root via `git rev-parse --show-toplevel` (fall back to
`$PWD` if not inside a git repo). The slash command writes a project-scoped
`.mcp.json` at that workspace root. The `quack` entry has this shape:

```json
{ "mcpServers": { "quack": {
    "type": "http",
    "url": "<resolved server URL>/mcp",
    "headers": {
      "Authorization": "Bearer <literal per-workspace token>",
      "X-Quack-Sub-Project": "<confirmed sub-project slug>"
} } } }
```

- The `url` is the `QUACK_SERVER_URL` value resolved in step 2 (either the
  user's explicit env or the `http://127.0.0.1:7474` default) with a `/mcp`
  suffix appended.
- The `Authorization` header carries the literal per-workspace token
  acquired in step 3 (minted via Branch A or pasted via Branch B).

Handle the workspace `.mcp.json` like this:

- If `.mcp.json` does not exist, create it with just the `quack` entry
  inside `mcpServers`.

- If `.mcp.json` already exists but has **no** `quack` entry, **merge** the
  `quack` entry into the existing `mcpServers` object — leave every sibling
  server already in the file untouched. Do not disturb any other server,
  any unrelated top-level keys, or the existing formatting beyond the added
  entry.

- If `.mcp.json` already exists **with** a `quack` entry, **do not
  overwrite** it. Refuse and print the snippet to stdout so the user can
  merge it manually:

  ```
  /quack:install: .mcp.json already has a `quack` MCP server — refusing to overwrite. Merge this entry manually if you want to switch projects:

  "quack": {
    "type": "http",
    "url": "<resolved server URL>/mcp",
    "headers": {
      "Authorization": "Bearer <literal per-workspace token>",
      "X-Quack-Sub-Project": "<confirmed sub-project slug>"
    }
  }
  ```

### 5. Print follow-up instructions

After writing `.mcp.json`, print exactly:

```
/quack:install: bound this workspace to project '<slug>' as user '<name>'.

Next steps:
  1. Drop the privileged admin token from your shell env if you set it.
  2. Restart your Claude Code session in this workspace once — Claude Code
     reads the new project-scoped .mcp.json on session start.
  3. Verify the Quack MCP server connects (it appears in /mcp list and
     responds to `server_status`).
  4. Trigger a hook (e.g. SessionStart fires automatically; or run any
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
- **Committed-token tradeoff.** `.mcp.json` holds a **literal**,
  **non-admin**, single-project token in the `Authorization` header. That
  token cannot mint or revoke other tokens and is scoped to one project —
  so for the MVP `.mcp.json` is **committed by default** (checked into the
  workspace repo) to keep the install one step. The **post-MVP** path
  swaps the literal token for a `${QUACK_TOKEN}` substitution reference
  and adds `.mcp.json` to `.gitignore`, so the secret leaves source
  control entirely.
