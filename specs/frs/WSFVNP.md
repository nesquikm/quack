---
title: Admin MCP tools surface (user, project, member, token management)
milestone: M2
status: active
archived_at: null
id: fr_01KREG3A74YT1X94NFY5WSFVNP
created_at: 2026-05-12T19:30:00Z
---

## Requirement

Implement the MCP server (HTTP streamable transport) and the admin-only management tool surface defined in `specs/technical-spec.md` §3. This FR delivers:

1. A bootable MCP server on `POST /mcp` (sharing the Bun HTTP server from FR-A `HA2WTQ`).
2. The admin-tool gate — a static allowlist of management tool names; `role === 'admin'` required to invoke any of them.
3. The nine v1 management tools: `register_user`, `remove_user`, `create_project`, `delete_project`, `add_member`, `remove_member`, `revoke_token`, `list_projects`, `list_users`.
4. Zod schemas for every tool's args + response.
5. One-time plaintext token surfacing in `register_user` / `add_member` responses.

The memory-plane MCP tool (`search_memory`) and the graph DB are out of scope here. `delete_project`'s graph-partition cleanup is wired through the `pending_cleanup` table per `specs/technical-spec.md` §4, but the actual graph deletion is a TODO until the graph-DB FR lands in a later milestone.

## Acceptance Criteria

- AC-WSFVNP.1: MCP server (`@modelcontextprotocol/sdk`, streamable HTTP transport) is mounted on `POST /mcp`. Every tool invocation passes through `AuthMiddleware` (FR-A) first; on auth failure the MCP layer is never reached. Tool dispatch checks `request.context.role === 'admin'` against a static `ADMIN_TOOLS` allowlist before invoking. Non-admin caller invoking an admin tool ⇒ HTTP 403 with body `{ error: "forbidden" }`. Non-admin calling a non-admin tool ⇒ normal dispatch.
- AC-WSFVNP.2: `register_user({ username })` — admin-only — creates a user with role `member`, then mints a token bound to `(user.id, project_id=_control_)` so the new user has a starter token even before any project membership. Response includes the **plaintext** token exactly once: `{ user: { id, username, role }, token: "<43-char base64url>" }`. Duplicate username ⇒ MCP error `user_exists` (no row created).
- AC-WSFVNP.3: `remove_user({ username })` — admin-only — `DELETE FROM users WHERE username=?`. FK cascades drop `project_members` and `tokens`. Refuses (`cannot_remove_last_admin`) if the user is the last admin row. Removing self ⇒ `cannot_remove_self`.
- AC-WSFVNP.4: `create_project({ slug, display_name })` — admin-only — inserts a row in `projects`. Slug validation: `/^[a-z0-9][a-z0-9_-]{0,62}$/` (no leading dash/underscore; bounded length). Duplicate slug ⇒ `project_exists`. Slugs starting with `_` are reserved (`reserved_slug`).
- AC-WSFVNP.5: `delete_project({ slug })` — admin-only — in a single `auth.sqlite` transaction: deletes the row from `projects` (FK cascade), inserts `pending_cleanup(kind='project_graph_partition', ref=<slug>)`. Refuses to delete `_control_` (`reserved_project`). Response: `{ deleted: true, cleanup_queued: <pending_cleanup_id> }`.
- AC-WSFVNP.6: `add_member({ username, project_slug, role })` — admin-only — inserts a `project_members` row, mints a new token bound to `(user.id, project.id)`, returns plaintext once: `{ membership: { user_id, project_id, role }, token: "<43-char base64url>" }`. Duplicate membership ⇒ `already_member`. Unknown user or project ⇒ `not_found`.
- AC-WSFVNP.7: `remove_member({ username, project_slug })` — admin-only — `DELETE FROM project_members WHERE user_id=? AND project_id=?`; also `UPDATE tokens SET revoked_at = datetime('now') WHERE user_id=? AND project_id=? AND revoked_at IS NULL`. Returns count of revoked tokens. Refuses to remove the last admin member of `_control_` (`cannot_remove_last_control_admin`).
- AC-WSFVNP.8: `revoke_token({ token_id })` — admin-only — `UPDATE tokens SET revoked_at = datetime('now') WHERE id=? AND revoked_at IS NULL`. Unknown or already-revoked ⇒ uniform `not_found` (no oracle on existence).
- AC-WSFVNP.9: `list_projects()` — admin sees all rows; member sees only projects they're in (`JOIN project_members ON user_id = ?`). `list_users()` — admin only; non-admin ⇒ 403. Both return arrays of plain DTOs (no token data).
- AC-WSFVNP.10: Every tool's args validated by Zod before dispatch. Validation failure ⇒ MCP error `invalid_args` with the Zod error path; no DB call made.
- AC-WSFVNP.11: Tool responses never include `token_hash`, `revoked_at` (except as boolean `revoked`), or any other internal field. DTO mapping is explicit (not `SELECT *`).

## Technical Design

### Modules

- **`src/mcp/server.ts`** — initializes the MCP server (`@modelcontextprotocol/sdk`), registers tools, mounts on the existing Bun HTTP server's `/mcp` route. MCP HTTP transport sits behind FR-A's `AuthMiddleware`.
- **`src/mcp/dispatch.ts`** — wraps every tool call with the admin-tool gate: `if (ADMIN_TOOLS.has(toolName) && context.role !== 'admin') return forbidden()`.
- **`src/admin/tools/<tool>.ts`** — one file per tool (`register_user.ts`, `remove_user.ts`, …). Each exports `{ name, schema, handler }`. Handlers receive `(args, ctx, db)`.
- **`src/admin/dto.ts`** — explicit DTO mappers: `userToDto`, `projectToDto`, `membershipToDto`, `tokenToDto` (returns `{ id, created_at, revoked: boolean }` — never the hash).
- **`ADMIN_TOOLS`** — static const exported from `src/admin/index.ts`:

  ```ts
  export const ADMIN_TOOLS = new Set([
    "register_user", "remove_user",
    "create_project", "delete_project",
    "add_member", "remove_member",
    "revoke_token", "list_users",
  ] as const);
  ```

  `list_projects` is intentionally **not** admin-only — members can read their own project list.

### Dependencies added
- `@modelcontextprotocol/sdk` (runtime).

### Out of scope here
- `search_memory` (memory plane — depends on graph DB; later FR).
- Graph-partition cleanup in `delete_project` — queues a `pending_cleanup` row but does not execute (no `GraphAdapter` yet).
- Reconciliation sweep for `pending_cleanup` — later FR.

## Testing

- `src/admin/tools/register_user.test.ts` — happy path returns plaintext + user DTO; plaintext is 43-char base64url; hash row created; duplicate username errors; non-admin caller forbidden.
- `src/admin/tools/remove_user.test.ts` — cascade drops members + tokens; last-admin refusal; remove-self refusal.
- `src/admin/tools/create_project.test.ts` / `delete_project.test.ts` — slug regex enforced; reserved-slug refused; cascade behavior; `_control_` cannot be deleted; `pending_cleanup` row inserted.
- `src/admin/tools/add_member.test.ts` / `remove_member.test.ts` — duplicate membership; unknown user/project; token revocation count; last-control-admin refusal.
- `src/admin/tools/revoke_token.test.ts` — uniform `not_found` for unknown / already-revoked.
- `src/admin/tools/list_projects.test.ts` / `list_users.test.ts` — admin sees all; member sees own only; tokens never appear in any list response.
- `src/mcp/dispatch.test.ts` — admin gate matrix (8 admin tools × {admin, member}); non-admin → 403; admin always through.
- `src/mcp/server.test.ts` — integration via MCP HTTP client: invoke each tool through the wire; assert auth headers required; assert tool list matches.
- FR-A's auth tests are reused unchanged.

## Notes

- `register_user` minting a `_control_`-bound token is a convenience: the new user has *something* to authenticate with before being added to a project. They have no memory access (their `_control_` membership is `member` role, not admin, and `_control_` holds no memory data). This lets an admin `add_member` them to real projects without first issuing a token over a separate channel.
- The split between `list_projects` (member-readable, filtered) and `list_users` (admin-only) is deliberate: members need to see their own project list (to map `(user, project)` tokens to graphs), but they don't need to enumerate other users.
- `revoke_token` returns `not_found` for both unknown IDs and already-revoked tokens — same anti-oracle principle as FR-A's 401 body uniformity.
- Tool responses containing plaintext tokens (`register_user`, `add_member`) carry a one-time-only contract. Document this in each tool's MCP description string so clients (Claude Code) don't cache it long-term.
