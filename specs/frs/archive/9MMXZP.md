---
title: Pin plugin metadata version parity with server release
milestone: M7
status: archived
archived_at: 2026-05-15T16:11:03Z
id: fr_01KRNWYJ5KN4CPTRTHKM9MMXZP
created_at: 2026-05-15T13:30:00Z
---

## Requirement

Quack ships as both a self-hosted server (Docker Compose) and a Claude Code marketplace plugin (`plugins/quack/`). The plugin metadata carries its own `version` field in `plugins/quack/.claude-plugin/plugin.json` and is mirrored in `.claude-plugin/marketplace.json`'s quack entry — those two strings are what Claude Code's `/plugin` resolver reads when deciding whether an update is available.

The M6 release (`chore(release): v0.4.0`, commit `c20b198`) bumped `package.json` to `0.4.0` but left both plugin-metadata files at `0.2.0`. Claude Code's resolver kept advertising "latest = 0.2.0", refused to refetch, and installed clients never received the FR-44QGKH `plugins/quack/hooks/_lib/` tree — the new shims silent-disable because their `bunx → _lib/entry/*.ts` chain doesn't exist at the cache path.

The existing `tests/plugin-version-sync.test.ts` only pinned `plugin.json ↔ marketplace.json` parity. Both can drift in lockstep below `package.json` (exactly what M6 did) and the gate stays green.

Forward-only fix: extend the parity contract to be three-way, bump the plugin metadata to `0.4.1`, and extend `CLAUDE.md ## Release Files` so `/ship-milestone` bumps the plugin metadata automatically on every future release.

## Acceptance Criteria

- AC-9MMXZP.1: `plugins/quack/.claude-plugin/plugin.json.version` and `.claude-plugin/marketplace.json.plugins[?(name=='quack')].version` both equal `0.4.1` after the M7 release commit lands. `package.json.version` also equals `0.4.1` (via the existing `## Release Files` entry).
- AC-9MMXZP.2: `tests/plugin-version-sync.test.ts` asserts byte-equality across all three version strings (`pkg.version === plugin.version === marketplace.plugins[?(name==quack)].version`). Test fails the gate when any pair drifts. The pre-fix shape of the repo (0.4.0 / 0.2.0 / 0.2.0) causes the extended test to fail; the post-fix shape (0.4.1 / 0.4.1 / 0.4.1) passes.
- AC-9MMXZP.3: `CLAUDE.md ## Release Files` block carries two new entries that `/ship-milestone`'s `parseReleaseFiles` accepts: `kind: json, path: plugins/quack/.claude-plugin/plugin.json, field: version` and `kind: regex, path: .claude-plugin/marketplace.json, pattern: '"name": "quack",\s*"version": "(?<version>\d+\.\d+\.\d+)"', replace: '"name": "quack",\n      "version": "{version}"'`. On a hypothetical v0.4.2 ship, `/ship-milestone` rewrites all four files (`package.json`, `plugin.json`, `marketplace.json`, `CHANGELOG.md`) without operator intervention.
- AC-9MMXZP.4: A `chore(release): v0.4.1` commit on `main` bumps `package.json`, `plugins/quack/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `CHANGELOG.md` together. CHANGELOG section header: `## [0.4.1] — <YYYY-MM-DD> — "Lockstep"`.
- AC-9MMXZP.5: After v0.4.1 ships and the operator runs `/plugin update quack`, `claude plugin list --json | jq '.[] | select(.id == "quack@quack") | .version'` returns `"0.4.1"`, AND `~/.claude/plugins/cache/quack/quack/0.4.1/hooks/_lib/dispatch.ts` exists on disk (the M6 invariant the original ship missed).

## Technical Design

### Files modified

- `tests/plugin-version-sync.test.ts` — extend the existing single test to also load `package.json` and assert three-way `pkg.version === plugin.version === marketplaceQuackEntry.version`. Keep the existing two-way assertion as a sub-case for sharper diagnostics on which pair is drifting.
- `plugins/quack/.claude-plugin/plugin.json` — `version: 0.2.0 → 0.4.1`.
- `.claude-plugin/marketplace.json` — quack plugin entry's `version: 0.2.0 → 0.4.1`.
- `CLAUDE.md` — `## Release Files` block gains two entries (`json` for `plugin.json`, `regex` for `marketplace.json`) so `/ship-milestone` bumps them on subsequent releases.
- `package.json` — `0.4.0 → 0.4.1` (handled by the existing `## Release Files` json entry).
- `CHANGELOG.md` — new `## [0.4.1] — <YYYY-MM-DD> — "Lockstep"` section explaining the version-sync fix.

### Out of scope

- A new `/ship-milestone` pre-flight probe checking metadata parity. The extended `plugin-version-sync.test.ts` is a gate-side guard that fires on the same code path; a probe would be belt-and-suspenders.
- A new `/gate-check` conformance probe duplicating the parity assertion.
- Schema validation for `marketplace.json` beyond the version string regex.
- Cache invalidation for clients still on `0.2.0` (outside Quack's surface — `/plugin update` is the operator's responsibility).

## Testing

- `tests/plugin-version-sync.test.ts` — extended; runs always (no skip). The extended assertion fails on the current `0.4.0 / 0.2.0 / 0.2.0` drift, then passes once the M7 release commit lands.
- Manual: in a Claude Code session pointed at the local marketplace, run `/plugin update quack`, then assert `/plugin` shows `v0.4.1` and the cache at `~/.claude/plugins/cache/quack/quack/0.4.1/hooks/_lib/` contains the M6 files.

## Notes

- This FR is the natural close of the M6 e2e finding (post-release smoke caught `quack is already at the latest version (0.2.0)` from `/plugin`). The cause was strictly a release-time process gap — `## Release Files` didn't list the plugin metadata, and the existing parity test only compared the two plugin files to each other.
- Codename for v0.4.1: `Lockstep` — matches the parity invariant the FR introduces.
- v0.4.1 is the canonical SemVer patch bump on top of v0.4.0; no API or behavior change beyond metadata + test surface.
- Adding the `regex` entry for `marketplace.json` (rather than a `kind: json` with a nested field path) is the safe path: `parseReleaseFiles` supports json with dot-paths but the test-suite's evidence base for nested paths against an array of objects is thin, and the regex anchored on `"name": "quack"` is unambiguous because quack is the only plugin in the marketplace.

## Implementation notes

- AC-9MMXZP.1 test hard-pins literal `"0.4.1"` (`tests/plugin-version-sync.test.ts:97`) — AC text mandates this exact value; future releases must update the pin alongside the other release-file bumps. The parity test (AC.2) is the durable drift guard.
- marketplace.json regex pattern uses literal `"name": "quack"` with a literal space after the colon (`CLAUDE.md:139`) — AC-9MMXZP.3 specifies this exact pattern verbatim. A compact JSON serialiser (no space after `:`) would not match, but the marketplace.json file is always pretty-printed.
