---
title: Replace quack-hook binary with bunx-driven TS-in-plugin (+ defensive layer)
milestone: M6
status: archived
archived_at: 2026-05-15T12:39:35Z
id: fr_01KRN87PD8PXAEK7HB1Y44QGKH
created_at: 2026-05-15T00:00:00Z
---

## Requirement

Eliminate the install-side `quack-hook` binary intermediary between Claude
Code's hook harness and Quack's `/ingest` API. Move the hook TS sources
(`src/hooks/{dispatch,redact,post,config}.ts` + supporting types) into
`plugins/quack/hooks/_lib/` so the plugin tree is hermetic. Each Claude Code
hook event gets its own entry file under `plugins/quack/hooks/_lib/entry/`
that the plugin's shell wrapper executes via `bunx --bun
${CLAUDE_PLUGIN_ROOT}/hooks/_lib/entry/<name>.ts`. Delete `src/hooks/`, the
`bun run build:hook` script, and the PATH-installed binary path entirely.
Forward-only — no migration helper, no compatibility shim, no installed-user
concern (`project_no_users_yet`).

Add a defensive layer mirroring the dev-process-toolkit hook fixes that
prompted this FR (STE-289 / STE-290 upstream): a unit-tested
`parseHookPayload` mini-lib that owns the stdin-JSON contract, and
`tests/bundled-hooks-shape.test.ts` — a byte-checkable contract gate that
pins `plugins/quack/hooks/hooks.json` structure, the literal
`${CLAUDE_PLUGIN_ROOT}` token usage, and the existence of every referenced
shim + entry file. Both reduce the blast radius of future hook refactors.

## Acceptance Criteria

- AC-44QGKH.1: `plugins/quack/hooks/_lib/` contains the canonical hook
  modules `dispatch.ts`, `redact.ts`, `post.ts`, `config.ts`, `payload.ts`,
  `shared/envelope.ts` (HookEnvelope type), `shared/redaction_patterns.ts`,
  `shared/redactor.ts` (deep-walk redactor shared by server-side
  `src/extract/redact.ts` and plugin-side `redact.ts`; landed by the
  REFACTOR stage to dedupe walker logic). Each module is a TS source
  file, no precompile. `bunx tsc --noEmit` passes against the new tree.
- AC-44QGKH.2: `plugins/quack/hooks/_lib/entry/{session_start,stop,post_tool_use}.ts`
  exist; each is a thin entry: `parseHookPayload(await stdin) →
  dispatchHook(kind, payload) → exit 0`. Errors swallowed to stderr +
  exit 0 (silent-disable invariant). Total ≤ 30 LOC each.
- AC-44QGKH.3: `plugins/quack/hooks/{session_start,stop,post_tool_use}.sh`
  are minimal POSIX-sh wrappers (~10 lines: shebang + comments + bunx
  pre-flight + CLAUDE_PLUGIN_ROOT default + exec). The exec line has
  the shape `exec bunx --bun bun "${CLAUDE_PLUGIN_ROOT}/hooks/_lib/entry/<name>.ts" "$@"`.
  (The literal `bun` token between `--bun` and the entry path is a
  required workaround for Bun 1.3 — `bunx --bun <file.ts>` parses the
  path as an `@`-prefixed dep and fails; `bunx --bun bun <file.ts>`
  runs `bun <file.ts>` through bunx, preserving the `bunx --bun`
  discoverability the latency probe pins.) When `bunx` (or `bun`) is
  not on PATH (`command -v bunx` non-zero), the script exits 0
  silently AND writes one stderr line `[quack-hook plugin] bunx not
  found; install Bun (https://bun.sh) so per-workspace memory hooks
  can fire`. A `${CLAUDE_PLUGIN_ROOT:=...}` default line falls back to
  the shim's parent dir so the latency probe + local smoke can resolve
  the entry path without the Claude Code harness setting that env var.
- AC-44QGKH.4: `plugins/quack/hooks/hooks.json` is unchanged in shape;
  `bunx`-based commands still reference the same three `.sh` shims via
  literal `${CLAUDE_PLUGIN_ROOT}` token (STE-288 invariant preserved).
- AC-44QGKH.5: `plugins/quack/hooks/_lib/payload.ts` exports
  `parseHookPayload(input: string): { kind?: string; data: unknown }`. It
  treats stdin as the Claude Code hook payload JSON (a future-proof shape
  — currently the plugin forwards the whole blob; the lib exists to own
  the contract). Unit-tested in `_lib/payload.test.ts`: valid JSON, empty
  stdin, malformed JSON, missing fields. Validation failure ⇒ returns
  `{ data: null }` (never throws); the entry file maps that to silent
  exit 0.
- AC-44QGKH.6: `tests/bundled-hooks-shape.test.ts` asserts (byte-
  checkable, runs always — does not skip):
  (a) `plugins/quack/hooks/hooks.json` parses;
  (b) keys are exactly `SessionStart`, `Stop`, `PostToolUse`;
  (c) every `command` field uses the literal `${CLAUDE_PLUGIN_ROOT}` token
  (no env-substitution drift);
  (d) every referenced `.sh` shim exists on disk;
  (e) every shim references a corresponding `_lib/entry/<name>.ts` that
  exists on disk.
- AC-44QGKH.7: `tests/plugin-hook-latency.test.ts` measures cold-start
  wall-clock for each hook by spawning the shim 10× with a representative
  fixture stdin payload (sourced from `tests/fixtures/hook-payloads/`) and
  asserts p95 < 500 ms. Skips when `bunx` is not on PATH. Notes paragraph
  documents the < 500 ms looser cap vs. the requirements.md NFR-1
  < 200 ms target (the NFR governs the full enqueue path on a warm
  process; cold-start `bunx` legitimately stretches it on first fire of
  a session).
- AC-44QGKH.8: `tests/plugin-install-local.test.ts` is updated:
  invariants additionally assert that `plugins/quack/hooks/_lib/` is
  present in the installed plugin tree (with the expected files), and
  that the installed tree contains NO `src/`, `dist/`, `compose.yml`,
  `Dockerfile`, or repo-root `package.json` (hermeticity unchanged).
- AC-44QGKH.9: `src/hooks/` is deleted entirely (including
  `quack-hook.ts`, `dispatch.ts`, `redact.ts`, `post.ts`, `config.ts`,
  `init.ts` + tests). `package.json`'s `build:hook` script is removed.
  `.dockerignore`'s `dist/quack-hook` reference is removed (still
  excludes `dist/` blanket).
- AC-44QGKH.10: `HookEnvelope` type + `redaction_patterns` constant move
  to `plugins/quack/hooks/_lib/shared/`. Server-side `src/ingest/handler.ts`
  imports `HookEnvelope` from the new plugin location via a relative path
  (the canonical wire shape lives where the writer lives). Server-side
  `src/extract/redact.ts` imports `redaction_patterns` from the same
  plugin location. `bunx tsc --noEmit` passes; no duplication.
- AC-44QGKH.11: All test files previously under `src/hooks/*.test.ts`
  port into `plugins/quack/hooks/_lib/__tests__/` with paths + imports
  updated. The test matrix from AC-S2D0Z5 (happy path per kind, missing
  token, 5xx, timeout, redaction) is preserved verbatim — pure file
  move, not a rewrite — in the four ported files (`dispatch.test.ts`,
  `redact.test.ts`, `post.test.ts`, `config.test.ts`). The
  empty/malformed stdin case migrates from the old `quack-hook.test.ts`
  into `payload.test.ts` (AC.5's new lib home for the stdin contract).
  The `unknown CLI arg` case from the old binary `quack-hook.test.ts`
  has no logical home in the post-binary world (each entry file pins
  its kind via `hooks.json`, so there is no longer a runtime CLI arg
  to misroute) and is intentionally dropped. The new
  `entry.test.ts` covers AC.2 invariants for the three entry files
  (≤ 30 LOC each, silent-disable exit 0, parseHookPayload →
  dispatchHook wiring).
- AC-44QGKH.12: `plugins/quack/README.md` install flow is updated: drop
  the `bun run build:hook` + PATH steps. New install flow:
  (a) `claude marketplace add <repo-or-path>` + `/plugin install quack`;
  (b) per-workspace: `cd <workspace> && /quack:install <slug> &&
  direnv allow`. Bun is named as the only host prerequisite (linked to
  https://bun.sh). Repo-root README "Install as Claude Code plugin"
  section gets the same edit.
- AC-44QGKH.13: `specs/requirements.md` traceability matrix:
  - AC-S2D0Z5.1..13 rows are removed (the binary they reference no
    longer exists).
  - New AC-44QGKH.1..13 rows added.

## Technical Design

### Files added (under `plugins/quack/hooks/_lib/`)

- `dispatch.ts` — verbatim move from `src/hooks/dispatch.ts`.
- `redact.ts` — verbatim move from `src/hooks/redact.ts`.
- `post.ts` — verbatim move from `src/hooks/post.ts`.
- `config.ts` — verbatim move from `src/hooks/config.ts`.
- `payload.ts` — NEW. Owns the stdin-JSON contract. ~40 LOC.
- `shared/envelope.ts` — `HookEnvelope` type + `HookEnvelopeSchema`
  (Zod, re-exported by server-side `src/ingest/handler.ts`).
- `shared/redaction_patterns.ts` — moved from
  `src/shared/redaction_patterns.ts` (server imports from here).
- `shared/redactor.ts` — `createRedactor` deep-walk redactor, hoisted
  here by the REFACTOR stage so the plugin and server share one
  implementation; both `plugins/quack/hooks/_lib/redact.ts` and
  `src/extract/redact.ts` thin-wrap this module.
- `entry/session_start.ts` — `await parseHookPayload(...) →
  dispatchHook("session_start", ...) → exit 0`.
- `entry/stop.ts` — same shape, kind `stop`.
- `entry/post_tool_use.ts` — same shape, kind `post_tool_use`.
- `__tests__/` — ported test files (one per module).

### Files modified

- `plugins/quack/hooks/{session_start,stop,post_tool_use}.sh` — collapse
  to 2-line `bunx` exec wrappers with new silent-disable wording.
- `plugins/quack/hooks/hooks.json` — unchanged in structure; command
  values audited for literal `${CLAUDE_PLUGIN_ROOT}` use.
- `plugins/quack/README.md`, repo-root `README.md` — install-flow edits.
- `package.json` — drop `build:hook` script.
- `src/ingest/handler.ts` — `HookEnvelope` import moves to
  `../../plugins/quack/hooks/_lib/shared/envelope.ts`.
- `src/extract/redact.ts` — `redaction_patterns` import moves to
  `../../plugins/quack/hooks/_lib/shared/redaction_patterns.ts`.
- `.dockerignore` — drop `dist/quack-hook` line (covered by `dist/`).
- `tests/plugin-install-local.test.ts` — hermeticity invariants extended.

### Files deleted

- `src/hooks/*` (entire directory: `quack-hook.ts`, `dispatch.ts`,
  `redact.ts`, `post.ts`, `config.ts`, `init.ts` + all `*.test.ts`).
- `tests/hook-binary.test.ts` (binary no longer exists).
- `src/shared/redaction_patterns.ts` (moved into plugin).

### Out of scope

- Reintroducing a precompiled binary fallback (option 4 from brainstorm —
  rejected; bunx is the canonical path).
- Cross-OS smoke matrix beyond the developer's local machine
  (macOS/Linux variance accepted; AC-44QGKH.7's 500 ms cap is the
  contract).
- Renaming the plugin's hook script files to TS extensions directly
  in `hooks.json` (the harness reads the script as a shell command;
  keeping `.sh` shims is byte-checkable + idiomatic).
- A `/quack:remember` plugin slash command (deferred to a future FR).

## Testing

- `plugins/quack/hooks/_lib/__tests__/dispatch.test.ts` — ported.
- `plugins/quack/hooks/_lib/__tests__/redact.test.ts` — ported.
- `plugins/quack/hooks/_lib/__tests__/post.test.ts` — ported.
- `plugins/quack/hooks/_lib/__tests__/config.test.ts` — ported.
- `plugins/quack/hooks/_lib/__tests__/payload.test.ts` — NEW (AC.5).
- `plugins/quack/hooks/_lib/__tests__/entry.test.ts` — NEW (AC.2);
  asserts each entry file is ≤ 30 LOC, references `parseHookPayload`,
  `dispatchHook`, and its literal kind, and exits 0 unconditionally.
- `tests/bundled-hooks-shape.test.ts` — NEW (AC.6); byte-checkable.
- `tests/bundled-hooks-cleanup.test.ts` — NEW (AC.9 + .12 + .13);
  asserts deletions, README install-flow edits, and traceability-matrix
  refresh land together.
- `tests/bundled-hooks-shared-fence.test.ts` — NEW (AC.10);
  pins the plugin-shared import fence so server-side files keep
  importing HookEnvelope + redaction_patterns from the plugin tree.
- `tests/plugin-hook-latency.test.ts` — NEW (AC.7); skips when bunx
  absent; 10× spawn × 3 hooks; p95 < 500 ms.
- `tests/plugin-install-local.test.ts` — extended (AC.8).
- `tests/plugin-version-sync.test.ts` — unchanged.
- `tests/plugin-hooks-syntax.test.ts` — updated for the new
  silent-disable stderr wording.

## Notes

- Latency cap rationale: requirements.md NFR-1 sets < 200 ms for the
  fire-and-forget enqueue path. That contract still governs the *warm*
  path (process already loaded, network POST). Cold-start `bunx --bun`
  legitimately adds 80–150 ms on macOS + ~40 ms on Linux; the 500 ms
  CI cap absorbs that without weakening the warm-path NFR. If the cap
  fires regularly in practice, the brainstorm's option 4 (precompiled
  binary fallback) is the documented exit ramp.
- `parseHookPayload` is a partial defensive measure today: quack's hooks
  currently forward the whole stdin payload as-is and don't try to read
  a transcript file. The mini-lib exists so that if a future FR needs
  to extract specific harness-payload fields (e.g., `transcript_path`,
  `cwd`, `session_id`), there's a single unit-tested contract point —
  exactly the structure dev-process-toolkit STE-290 retrofitted after
  the fact.
- `HookEnvelope` + `redaction_patterns` moving into the plugin tree
  inverts the previous "server owns, plugin imports" arrangement. The
  rationale: the plugin is the *writer* of the wire format (it produces
  envelopes; server consumes); colocating the type definition with the
  writer is the cleaner invariant. The byte-checkable shape test
  (AC.6) catches drift.
- This FR is the natural close of a class of bugs we'd otherwise inherit
  from dev-process-toolkit (STE-288 / STE-289 / STE-290 / STE-291). Quack
  mechanically already had the right shape on three of four; this FR
  bakes the fourth (defensive contract test) in and removes the install-
  side friction that STE-289 also hit upstream.

## Implementation notes

- `plugins/quack/hooks/*.sh` shebang `#!/usr/bin/env sh` vs `bash "<shim>"` invoker in `hooks.json` — cosmetic mismatch carried over from M4 (FR-ZSN2GG). Scripts are POSIX-sh compatible (validated by `sh -n` in `plugin-hooks-syntax.test.ts`), so the bash invoker runs them without issue. Not introduced by M6; flagged here so a future cleanup pass can either change `hooks.json` to `sh "<shim>"` for consistency, or rewrite the shebangs to `bash` to match the actual interpreter. — Cosmetic; no functional bug.
- Full-project `bun run test` exit code 1 at the time of merge was environmental: stale `neo4j:5-community` containers from prior test runs were starving Docker Desktop and causing the `docker-run` / `m2-smoke` / `graph/adapter` / `extract/pipeline` `beforeEach` hooks to time out. None of M6's code touches the Docker stack. The Phase 1 baseline run on the same code (with a clean container set) reported 407 pass / 1 skip / 0 fail; the FR-scoped run at Phase 4 reported 140 pass / 1 skip / 0 fail. The fix is `docker rm -f $(docker ps -q --filter ancestor=neo4j:5-community)` outside the agent session.
