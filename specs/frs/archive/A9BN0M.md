---
title: Sub-project memory — source tag for cross-project recall within a project
milestone: M8
status: archived
archived_at: 2026-05-18T19:08:44Z
id: fr_01KRXW6WYE86EKTCWC06A9BN0M
created_at: 2026-05-18T15:45:25Z
---

## Requirement

Add a **sub-project** dimension to the memory graph so a *connected set* of repos
(backend, frontend, shared packages) that share one Quack project can each tag its
memories with an origin repo — while recall spans the whole project by default and
can be narrowed to a chosen subset of sub-projects.

`project_id` stays the **hard tenancy boundary**, unchanged — the `GraphAdapter`'s
non-negotiable `$project_id` bind (AC-SFQDXR.4/.5) is untouched. `source` is a
**non-security provenance/filter label**, never a tenancy partition: a `sub_projects`
filter can only ever narrow *within* the caller's `project_id`, never widen across it.

Every memory-plane node label (`Entity`, `Decision`, `File`, `Symbol`, `Feedback`)
gains a `source: string[]` property that accumulates — via set-union on `MERGE`, the
same no-APOC mechanism `Entity.aliases` already uses (AC-4NY6S1.9) — every sub-project
that contributed the node. An entity mentioned in two repos stays **one** node with a
two-element `source`; the graph is never fragmented. `HookEnvelope` gains an optional
`sub_project` field that the extractor stamps onto every node it writes. The four
read-side MCP tools gain an optional `sub_projects?: string[]` filter; default
behaviour is unchanged (cross-repo recall over the whole project). `add_memory` reads
the sub-project from the `X-Quack-Sub-Project` request header.

This FR is the server-side half; the per-workspace delivery of the `sub_project`
value (`.mcp.json` + `/quack:install`) is FR-55S220.

## Acceptance Criteria

- AC-A9BN0M.1: `HookEnvelope` (`plugins/quack/hooks/_lib/shared/envelope.ts`) gains an
  optional field `sub_project?: string`, Zod-validated against the project-slug regex
  `^[a-z0-9][a-z0-9_-]{0,62}$`. The full envelope shape becomes
  `{ kind, payload, project_slug?, sub_project?, ts? }`. An absent `sub_project` is
  valid (M3/M4-era hook clients send envelopes without it). A present-but-malformed
  `sub_project` ⇒ `POST /ingest` returns HTTP 400 `{ error: "invalid_envelope",
  path: ["sub_project"] }` (the AC-4NY6S1.1 contract, extended).

- AC-A9BN0M.2: All five memory-plane node labels (`Entity`, `Decision`, `File`,
  `Symbol`, `Feedback`) carry a `source` property of type `list<string>`. `source` is
  never part of any tenancy check and never a `MERGE` natural key. Nodes written
  before this FR carry no `source`; absence is valid and is treated as the
  unscoped/default sub-project by the filter semantics in AC.5. No backfill migration.

- AC-A9BN0M.3: The five node-upsert `MERGE` templates
  (`src/graph/templates/extract/upsert_{entity,decision,file,symbol,feedback}.ts`) gain
  a `$source` parameter (`list<string>`). Each `SET`s the node's `source` to the
  **set-union** of its current value and `$source` — the no-APOC `COLLECT` + `DISTINCT`
  pattern AC-4NY6S1.9 already uses for `Entity.aliases`. `$source` is **not** added to
  any `MERGE` natural key (one node per `(project_id, name)` etc.). An empty `$source`
  is a no-op union (leaves `source` unchanged). `upsert_relation` is unchanged —
  relations carry no `source`; provenance lives on their endpoint nodes. No new
  templates are added (AC-41NXTZ.8 precedent).

- AC-A9BN0M.4: `src/extract/writer.ts` resolves the sub-project from
  `envelope.sub_project` and threads it as `$source` (a single-element array, or `[]`
  when absent) into every node-upsert `GraphAdapter.run` call. The sub-project is a
  **distinct trusted-input field** — it is NOT routed through the model-supplied-
  `project_id` override (AC-4NY6S1.12); the writer re-validates it against the slug
  regex and drops a non-conforming value to `[]` (defense-in-depth for the synthetic
  `add_memory` path).

- AC-A9BN0M.5: The four read-side memory MCP tools (`search_memory`, `get_neighbors`,
  `path_between`, `recent_decisions`) gain an optional request field
  `sub_projects?: string[]` (Zod; each element slug-shaped). Default semantics — field
  absent OR empty array — are **byte-unchanged**: recall spans the whole `project_id`.
  A non-empty `sub_projects` narrows results to nodes whose `source` array intersects
  `sub_projects` **OR** whose `source` is absent/empty (the unscoped/default
  sub-project always matches, so M3-era data and untagged repos never disappear from a
  filtered query).

- AC-A9BN0M.6: The `sub_projects` filter is applied inside the Cypher templates
  (`src/graph/templates/memory/*.ts`) as a parameterized predicate
  `($sub_projects = [] OR n.source IS NULL OR ANY(s IN $sub_projects WHERE s IN
  n.source))` — never string-concatenated; `$project_id` remains the non-negotiable
  bind (AC-SFQDXR.5). No dedicated `source` index is added: the existing per-label
  `project_id` indexes (AC-SFQDXR.6) scope the candidate set, Neo4j composite indexes
  do not usefully index `list` properties, and the `project_id`-narrowed set is small
  at personal scale. A Zod refusal on a malformed `sub_projects` element ⇒ MCP
  `invalid_args` carrying the issue path (AC-DPY5GQ.9 contract); all four tools stay
  member-readable (AC-DPY5GQ.10).

- AC-A9BN0M.7: `add_memory` (FR-41NXTZ) stamps the sub-project from the inbound
  `X-Quack-Sub-Project` HTTP request header. The MCP request path reads the header
  (case-insensitive), validates it against the slug regex, and writes it into the
  synthetic `HookEnvelope`'s `sub_project` field. Missing header OR malformed value ⇒
  `sub_project` omitted (node `source` defaults to `[]`). `add_memory`'s Zod arg schema
  (AC-41NXTZ.2: `{ content }`) is **unchanged** — no `sub_project` tool argument; the
  model never supplies the tag.

- AC-A9BN0M.8: Cross-tenant isolation re-verified. `source` filtering happens strictly
  within one `project_id`; a `sub_projects` value is an opaque string and cannot widen
  a query past the `GraphAdapter`'s `$project_id` bind. Adversarial test: a token for
  project A calling a read tool with `sub_projects` naming a project-B sub-project
  returns only project-A nodes.

- AC-A9BN0M.9: Tests.
  - `plugins/quack/hooks/_lib/__tests__/` (envelope) — `sub_project` accepted slug-
    shaped, rejected malformed, valid when absent.
  - `src/ingest/handler.test.ts` — malformed `sub_project` ⇒ 400 `invalid_envelope`
    path `["sub_project"]`.
  - `src/extract/writer.test.ts` — node-upserts receive `$source`; set-union
    idempotency (same sub-project twice ⇒ one element; second sub-project ⇒ two);
    `source` not clobbered by the `ctx.project_id` override path.
  - `src/graph/templates/extract/*.test.ts` — `$source` set-union vs. real Neo4j
    (skips without docker).
  - `src/mcp/tools/memory/*` per-tool tests — `sub_projects` narrows; absent/empty =
    whole project; untagged nodes always match; Zod refusal ⇒ `invalid_args`.
  - `src/mcp/tools/memory/cross_tenant.test.ts` — `sub_projects` cannot cross
    `project_id`.
  - `src/mcp/tools/memory/add_memory.test.ts` — `X-Quack-Sub-Project` stamped onto the
    synthetic envelope; missing/invalid header ⇒ no `sub_project`.
  - `src/extract/pipeline.test.ts` — e2e: two envelopes, two `sub_project` values;
    assert `source` arrays; assert a `sub_projects`-filtered `search_memory` narrows.

## Technical Design

### Modules touched

- `plugins/quack/hooks/_lib/shared/envelope.ts` — `sub_project?` field on
  `HookEnvelope` + `HookEnvelopeSchema`.
- `src/ingest/handler.ts` — no logic change; the extended Zod schema covers validation
  and the 400 path automatically (AC-4NY6S1.1 already routes Zod issues to the body).
- `src/extract/writer.ts` — resolve `envelope.sub_project`, re-validate, thread
  `$source` into the node-upsert calls.
- `src/graph/templates/extract/upsert_{entity,decision,file,symbol,feedback}.ts` —
  `$source` param + set-union `SET` clause.
- `src/graph/templates/memory/*.ts` — `$sub_projects` predicate on the four read
  templates.
- `src/mcp/tools/memory/{search_memory,get_neighbors,path_between,recent_decisions}.ts`
  — `sub_projects?` Zod field threaded into template params.
- `src/mcp/tools/memory/add_memory.ts` + the MCP request path — read the
  `X-Quack-Sub-Project` header, stamp the synthetic envelope.

### source cardinality

`source` is `list<string>`, accumulated by set-union on `MERGE` — chosen over a scalar
(which would either fragment the graph if part of the natural key, or lose provenance
last-write-wins if not). An entity mentioned in N repos is one node with an N-element
`source`. Direct precedent: `Entity.aliases` (AC-4NY6S1.9). `/brainstorm` decision.

### Indexing

No dedicated `source` index. The per-label `project_id` range indexes scope each query
to one project; the `source` array-membership is an in-query `ANY(...)` predicate.
Neo4j composite indexes do not usefully index `list`-typed components. If long-tail
sub-project filtering becomes a measured hotspot, a full-text index on `source` is the
future option — out of scope here. This is a deliberate deviation from the
spec-research "(label, project_id, source) index parity" suggestion, which assumed a
scalar `source`.

### Out of scope

- A `sub_projects` registry table + `create/list/delete_sub_project` admin tools +
  per-sub-project graph cleanup — the deferred "Approach 2" upgrade from `/brainstorm`;
  additive later with zero rework of this node shape.
- `source` on relationships.
- Per-workspace delivery of the `sub_project` value — FR-55S220.

## Testing

Per-AC coverage as listed in AC.9. Boundary re-tests (cross-tenant, AC.8) are
non-negotiable per `requirements.md` § Security/Abuse. Docker-gated graph tests skip
when the daemon is unreachable (testing-spec convention). The `source` set-union is
verified with a run-twice idempotency assertion mirroring the `Entity.aliases` test.

## Notes

- `project_id` is deliberately untouched — the `/brainstorm` session fixed it as the
  hard boundary and `source` as a non-security label. The three-layer tenancy defense
  (middleware / adapter / templates) is unchanged.
- "Untagged matches every filter" is intentional: a node with no `source` is
  project-wide (M3-era data, or a repo that set no sub-project), so a `sub_projects`
  filter narrows *additively* and never hides untagged memory.
- The deferred registry (Approach 2 from `/brainstorm`) is the clean upgrade path if
  typo'd sub-project tags become a curation pain. The `source[]` node shape does not
  change when it lands — `create/list/delete_sub_project` admin tools and a
  tag-filtered cleanup template are pure additions.
- `delete_project` (FR-EDXH3X) is unchanged — it deletes the whole `project_id`
  partition, which correctly removes the entire connected set. Deleting a single
  sub-project's memory is the deferred-registry feature, not part of this FR.

## Implementation notes

No advisory notes.
