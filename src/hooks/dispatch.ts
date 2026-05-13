import { buildHookRedactor } from "./redact";
import { resolveConfig } from "./config";
import { postEnvelope, type FetchLike } from "./post";
import type { HookEnvelope } from "../ingest/handler";

const KNOWN_KINDS = new Set(["session_start", "stop", "post_tool_use"]);

export interface DispatchOptions {
  // Hook kind (CLI arg).
  kind: string;
  // The JSON-parsed payload read from stdin.
  payload: unknown;
  // Test seams.
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export async function dispatchHook(opts: DispatchOptions): Promise<{ posted: boolean; reason?: string }> {
  if (!KNOWN_KINDS.has(opts.kind)) {
    return { posted: false, reason: "unknown_kind" };
  }
  const cfg = resolveConfig(opts.env as Parameters<typeof resolveConfig>[0]);
  if (!cfg) {
    return { posted: false, reason: "no_token" };
  }
  if (opts.payload === undefined || opts.payload === null) {
    return { posted: false, reason: "no_payload" };
  }
  const redactor = buildHookRedactor(opts.env ?? Bun.env);
  const { value: redactedPayload } = redactor.redact(opts.payload as Record<string, unknown>);
  const envelope: HookEnvelope = {
    kind: opts.kind as HookEnvelope["kind"],
    payload: redactedPayload as Record<string, unknown>,
    ...(cfg.projectSlug ? { project_slug: cfg.projectSlug } : {}),
    ts: (opts.now ?? (() => new Date()))().toISOString(),
  };
  await postEnvelope(envelope, {
    serverUrl: cfg.serverUrl,
    token: cfg.token,
    fetchImpl: opts.fetchImpl,
  });
  return { posted: true };
}
