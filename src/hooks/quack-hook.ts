#!/usr/bin/env bun
// Single-binary Claude Code hook handler. Built via `bun build --compile`:
//   bun build src/hooks/quack-hook.ts --compile --outfile dist/quack-hook
//
// Exits 0 on every code path that isn't a CLI usage error — the Claude Code
// session must never be broken by a hook server issue.

import { dispatchHook } from "./dispatch";
import { initSubcommand } from "./init";

async function readStdin(): Promise<unknown> {
  try {
    // Bun.stdin streams via Bun.readableStreamToText.
    const text = await Bun.readableStreamToText(Bun.stdin.stream());
    if (!text || text.trim() === "") return null;
    return JSON.parse(text);
  } catch (err) {
    console.error(`[quack-hook] stdin parse: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub) {
    // No-op silently — empty invocation is a no-op (forward-compat).
    return 0;
  }
  if (sub === "init") {
    const slug = argv[1];
    if (!slug) {
      process.stderr.write("[quack-hook] init: missing <slug> argument\n");
      return 2;
    }
    const res = initSubcommand(slug);
    return res.exitCode;
  }
  const payload = await readStdin();
  if (payload === null) return 0;
  await dispatchHook({ kind: sub, payload });
  return 0;
}

// Direct invocation. Bun runs the script directly; under --compile this is
// the binary entry point.
if (import.meta.main) {
  main(Bun.argv.slice(2)).then((code) => process.exit(code));
}
