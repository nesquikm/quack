import type { GraphAdapter } from "../graph/adapter";
import type { AuthContext } from "../auth/middleware";
import type { ExtractionResult } from "./client";
import { canonicalizeName, dedupeAliases } from "./canonicalize";
import { SLUG_RE } from "../shared/slug";

// Writes an ExtractionResult to the graph in dependency order:
//  1) Entities (so MENTIONS/RELATED_TO endpoints exist)
//  2) Files
//  3) Symbols (need file_id)
//  4) Decisions
//  5) Feedbacks
//  6) Relations (need all endpoint nodes resolved)
//
// Each MERGE call binds project_id from ctx (defense-in-depth — the adapter
// overrides any model-supplied project_id key in the params).

interface UpsertedNode {
  id: string;
  name?: string;
  path?: string;
  summary?: string;
  body?: string;
}

interface EndpointKey {
  kind: string;
  name: string;
}

// The trusted-input fragment of the ingest envelope the writer cares about.
// `sub_project` is a distinct trusted-input field — NOT routed through the
// model-supplied-project_id override path.
interface WriteEnvelope {
  sub_project?: string;
  // AC-Z1W6ED.4 — the originating envelope `kind` (session_start | stop |
  // post_tool_use | explicit_add), folded into the node `source` provenance set.
  kind?: string;
}

// AC-Z1W6ED.4 — valid originating envelope kinds. Re-validated (defense-in-depth)
// before being recorded as provenance so a malformed/absent kind is dropped.
// NOTE: must stay in sync with `HookKindSchema` in
// plugins/quack/hooks/_lib/shared/envelope.ts — the canonical kind union. The
// server-side writer deliberately does not import from the plugin tree, so a new
// hook kind added there must be mirrored here or its provenance is silently dropped.
const VALID_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  "session_start",
  "stop",
  "post_tool_use",
  "explicit_add",
]);

// Resolves the envelope to the node `$source` provenance SET: the originating
// envelope `kind` first (AC-Z1W6ED.4), then the validated sub-project
// (AC-A9BN0M.4) when present. Both are re-validated here (defense-in-depth).
// Folding the kind into `source` is filter-safe — the sub_projects recall
// predicate only matches real sub-project slugs, which an envelope kind never is.
function resolveSource(envelope?: WriteEnvelope): string[] {
  const out: string[] = [];
  const k = envelope?.kind;
  if (typeof k === "string" && VALID_ORIGIN_KINDS.has(k)) out.push(k);
  const sp = envelope?.sub_project;
  if (typeof sp === "string" && SLUG_RE.test(sp)) out.push(sp);
  return out;
}

function endpointKeyOf(kind: string, name: string): string {
  return `${kind}::${name}`;
}

export async function writeExtraction(
  adapter: GraphAdapter,
  ctx: AuthContext,
  result: ExtractionResult,
  now: string = new Date().toISOString(),
  envelope?: WriteEnvelope,
): Promise<{
  entities: number;
  decisions: number;
  files: number;
  symbols: number;
  feedbacks: number;
  relations: number;
}> {
  const endpointId = new Map<string, string>();
  const source = resolveSource(envelope);

  // 1) Entities
  let entityCount = 0;
  for (const e of result.entities) {
    const name = canonicalizeName(e.name);
    if (!name) continue;
    const aliases = dedupeAliases(name, e.aliases ?? []);
    const out = await adapter.run<
      { name: string; kind: string; aliases: string[]; source: string[]; now: string },
      UpsertedNode
    >("extract.upsert_entity", { name, kind: e.kind, aliases, source, now }, ctx);
    const row = out.rows[0];
    if (row?.id) {
      endpointId.set(endpointKeyOf("Entity", e.name), row.id);
      endpointId.set(endpointKeyOf("Entity", name), row.id);
      entityCount += 1;
    }
  }

  // 2) Files
  let fileCount = 0;
  const filePathToId = new Map<string, string>();
  for (const f of result.files) {
    const out = await adapter.run<
      { path: string; repo_root: string | null; source: string[]; now: string },
      UpsertedNode
    >("extract.upsert_file", { path: f.path, repo_root: f.repo_root ?? null, source, now }, ctx);
    const row = out.rows[0];
    if (row?.id) {
      endpointId.set(endpointKeyOf("File", f.path), row.id);
      filePathToId.set(f.path, row.id);
      fileCount += 1;
    }
  }

  // 3) Symbols (need file_id resolved)
  let symbolCount = 0;
  for (const s of result.symbols) {
    let fileId = filePathToId.get(s.file_path);
    if (!fileId) {
      // Symbol references a file the model didn't list as a separate File row.
      // Materialize it on the fly.
      const out = await adapter.run<
        { path: string; repo_root: string | null; source: string[]; now: string },
        UpsertedNode
      >("extract.upsert_file", { path: s.file_path, repo_root: null, source, now }, ctx);
      fileId = out.rows[0]?.id;
      if (fileId) {
        filePathToId.set(s.file_path, fileId);
        endpointId.set(endpointKeyOf("File", s.file_path), fileId);
        fileCount += 1;
      }
    }
    if (!fileId) continue;
    const out = await adapter.run<
      { name: string; file_id: string; kind: string; source: string[]; now: string },
      UpsertedNode
    >("extract.upsert_symbol", { name: s.name, file_id: fileId, kind: s.kind, source, now }, ctx);
    const row = out.rows[0];
    if (row?.id) {
      endpointId.set(endpointKeyOf("Symbol", s.name), row.id);
      symbolCount += 1;
    }
  }

  // 4) Decisions
  let decisionCount = 0;
  for (const d of result.decisions) {
    const out = await adapter.run<
      { summary: string; decided_at: string | null; source_excerpt: string; source: string[]; now: string },
      UpsertedNode
    >(
      "extract.upsert_decision",
      { summary: d.summary, decided_at: d.decided_at ?? null, source_excerpt: d.source_excerpt ?? "", source, now },
      ctx,
    );
    const row = out.rows[0];
    if (row?.id) {
      endpointId.set(endpointKeyOf("Decision", d.summary), row.id);
      decisionCount += 1;
    }
  }

  // 5) Feedbacks
  let feedbackCount = 0;
  for (const fb of result.feedbacks) {
    const out = await adapter.run<
      { body: string; sentiment: string | null; source: string[]; now: string },
      UpsertedNode
    >("extract.upsert_feedback", { body: fb.body, sentiment: fb.sentiment ?? null, source, now }, ctx);
    const row = out.rows[0];
    if (row?.id) {
      endpointId.set(endpointKeyOf("Feedback", fb.body), row.id);
      feedbackCount += 1;
    }
  }

  // 6) Relations — resolve endpoints via the upserted node ids.
  let relationCount = 0;
  for (const rel of result.relations) {
    const fromId = resolveEndpoint(endpointId, rel.from);
    const toId = resolveEndpoint(endpointId, rel.to);
    if (!fromId || !toId) continue;
    await adapter.run<
      { type: typeof rel.type; from_id: string; to_id: string; source_excerpt: string; now: string },
      { rel_type: string }
    >(
      "extract.upsert_relation",
      {
        type: rel.type,
        from_id: fromId,
        to_id: toId,
        source_excerpt: rel.source_excerpt ?? "",
        now,
      },
      ctx,
    );
    relationCount += 1;
  }

  return {
    entities: entityCount,
    decisions: decisionCount,
    files: fileCount,
    symbols: symbolCount,
    feedbacks: feedbackCount,
    relations: relationCount,
  };
}

function resolveEndpoint(map: Map<string, string>, ep: EndpointKey): string | undefined {
  // Try literal first, then canonicalized name (entity-style normalization).
  const literal = map.get(endpointKeyOf(ep.kind, ep.name));
  if (literal) return literal;
  return map.get(endpointKeyOf(ep.kind, canonicalizeName(ep.name)));
}
