import { buildHookRedactor } from "./redact";
import { resolveConfig } from "./config";
import { postEnvelope, type FetchLike } from "./post";
import type { HookEnvelope } from "./shared/envelope";
import { isMetaTool } from "./shared/meta_tools";

const KNOWN_KINDS = new Set(["session_start", "stop", "post_tool_use"]);

export interface DispatchOptions {
  // Hook kind (CLI arg).
  kind: string;
  // The JSON-parsed payload read from stdin.
  payload: unknown;
  // Test seam — directory to begin the `.mcp.json` walk-up from. The
  // production path passes no `dir`, so the runtime walk starts at
  // `CLAUDE_PROJECT_DIR` (falling back to cwd).
  dir?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export async function dispatchHook(opts: DispatchOptions): Promise<{ posted: boolean; reason?: string }> {
  if (!KNOWN_KINDS.has(opts.kind)) {
    return { posted: false, reason: "unknown_kind" };
  }
  const startDir = opts.dir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const cfg = resolveConfig({ startDir });
  if (!cfg) {
    return { posted: false, reason: "no_token" };
  }
  if (opts.payload === undefined || opts.payload === null) {
    return { posted: false, reason: "no_payload" };
  }
  // AC-Z1W6ED.1 — drop the agent's own meta/tool-search activity (a PostToolUse
  // for a META_TOOLS tool) before egress, so introspection chatter never reaches
  // /ingest or the cheap model. Fire-and-forget: no POST, clean exit.
  // SessionStart / Stop / non-meta PostToolUse are unaffected.
  if (
    opts.kind === "post_tool_use" &&
    typeof opts.payload === "object" &&
    isMetaTool((opts.payload as { tool_name?: unknown }).tool_name)
  ) {
    return { posted: false, reason: "meta_tool" };
  }
  const redactor = buildHookRedactor(Bun.env);
  const { value: redactedPayload } = redactor.redact(opts.payload as Record<string, unknown>);
  const envelope: HookEnvelope = {
    kind: opts.kind as HookEnvelope["kind"],
    payload: redactedPayload as Record<string, unknown>,
    ...(cfg.subProject ? { sub_project: cfg.subProject as string } : {}),
    ts: (opts.now ?? (() => new Date()))().toISOString(),
  };
  await postEnvelope(envelope, {
    serverUrl: cfg.serverUrl,
    token: cfg.token,
    fetchImpl: opts.fetchImpl,
  });
  return { posted: true };
}
