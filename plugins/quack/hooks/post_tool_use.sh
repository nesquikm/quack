#!/usr/bin/env sh
# Thin bunx wrapper for the PostToolUse hook entry under _lib/entry/.
# When bunx is missing we exit 0 silently — a broken install must never
# break a Claude Code session; the user only sees one stderr line.
if ! command -v bunx >/dev/null 2>&1; then
  echo "[quack-hook plugin] bunx not found; install Bun (https://bun.sh) so per-workspace memory hooks can fire" >&2
  exit 0
fi
: "${CLAUDE_PLUGIN_ROOT:=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
exec bunx --bun bun "${CLAUDE_PLUGIN_ROOT}/hooks/_lib/entry/post_tool_use.ts" "$@"
