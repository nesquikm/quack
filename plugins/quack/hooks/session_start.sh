#!/usr/bin/env sh
# Thin shell wrapper around the `quack-hook` binary built by the Quack repo
# (`bun run build:hook`). When the binary is absent we exit 0 silently so a
# broken install never breaks a Claude Code session — the user only sees one
# stderr line pointing them at the install step.
if ! command -v quack-hook >/dev/null 2>&1; then
  echo "[quack-hook plugin] binary not found; run \`bun run build:hook\` in the Quack repo and add dist/quack-hook to PATH" >&2
  exit 0
fi
exec quack-hook session_start "$@"
