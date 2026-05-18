// HookEnvelope — the canonical wire shape POSTed to `${serverUrl}/ingest`.
//
// Per FR-44QGKH AC.10, the type definition lives with the writer (the plugin
// hook tree). The server-side ingest handler (src/ingest/handler.ts) imports
// the schema + type from here (post-AC.10) so there's no duplication.
//
// HookKind is the literal-string union shared by hooks and add_memory:
//   - session_start / stop / post_tool_use — Claude Code hooks (FR-S2D0Z5).
//   - explicit_add — synthetic envelope minted by the add_memory MCP tool
//     (FR-41NXTZ AC.5) so write paths reuse the FR-4NY6S1 extractor pipeline.

import { z } from "zod";

export const HookKindSchema = z.enum([
  "session_start",
  "stop",
  "post_tool_use",
  "explicit_add",
]);

// Project-slug shape, shared with the admin create_project tool
// (src/admin/tools/create_project.ts). A `sub_project` names a logical
// sub-project within a workspace's memory project; M3/M4-era hook clients
// omit it entirely, so the field is optional.
export const SUB_PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const HookEnvelopeSchema = z.object({
  kind: HookKindSchema,
  payload: z.record(z.string(), z.unknown()),
  project_slug: z.string().optional(),
  sub_project: z
    .string()
    .regex(SUB_PROJECT_RE, "sub_project must match /^[a-z0-9][a-z0-9_-]{0,62}$/")
    .optional(),
  ts: z.string().optional(),
});

export type HookKind = z.infer<typeof HookKindSchema>;
export type HookEnvelope = z.infer<typeof HookEnvelopeSchema>;
