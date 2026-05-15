// parseHookPayload — owns the stdin-JSON contract for the plugin hook entry
// files. The Claude Code harness streams a JSON object on stdin; the entry
// file reads it, hands the raw text to this lib, and forwards `data` to
// `dispatchHook`. Validation failure NEVER throws — the function returns
// `{ data: null }` so the entry script can silent-exit 0.
//
// `kind` is hoisted from the payload only when the harness happens to surface
// it. The plugin's `hooks.json` pins the kind per shim, so the entry file
// passes a literal kind to `dispatchHook` — the hoisted `kind` is a future-
// proof escape hatch (see FR-44QGKH Notes for the dev-process-toolkit
// retrofit story).

export interface ParsedHookPayload {
  kind?: string;
  data: unknown;
}

export function parseHookPayload(input: string): ParsedHookPayload {
  if (typeof input !== "string") return { data: null };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { data: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { data: null };
  }
  if (parsed === null) return { data: null };
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const out: ParsedHookPayload = { data: obj };
    if (typeof obj["kind"] === "string") {
      out.kind = obj["kind"];
    }
    return out;
  }
  // Non-object root (string, number, boolean, array) — expose untouched but
  // contractually `data` is set; entry files won't dispatch on non-objects.
  return { data: parsed };
}
