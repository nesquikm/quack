// MemoryItem DTO + per-kind serialization rules for the `<memory>...</memory>`
// wrap (AC-DPY5GQ.5/6/11). The wrap is the prompt-injection-laundering boundary —
// recalled content is treated as untrusted text by the caller, not as system
// context.

export type NodeKind = "Entity" | "Decision" | "File" | "Symbol" | "Feedback";

export interface MemoryItemBase {
  kind: NodeKind;
  id: string;
  project_id: number;
  _memory_wrapped: string;
}

export interface EntityItem extends MemoryItemBase {
  kind: "Entity";
  name: string;
  entity_kind?: string;
  aliases?: string[];
  created_at?: string;
}

export interface DecisionItem extends MemoryItemBase {
  kind: "Decision";
  summary: string;
  decided_at?: string;
  source_excerpt?: string;
}

export interface FileItem extends MemoryItemBase {
  kind: "File";
  path: string;
  repo_root?: string;
  created_at?: string;
}

export interface SymbolItem extends MemoryItemBase {
  kind: "Symbol";
  name: string;
  file_id?: string;
  symbol_kind?: string;
  created_at?: string;
}

export interface FeedbackItem extends MemoryItemBase {
  kind: "Feedback";
  body: string;
  sentiment?: "positive" | "negative" | "neutral";
  observed_at?: string;
}

export type MemoryItem = EntityItem | DecisionItem | FileItem | SymbolItem | FeedbackItem;

// Per-kind user-visible fields excluded from internal-id / index-only data.
const USER_VISIBLE: Record<NodeKind, readonly string[]> = {
  Entity: ["name", "entity_kind", "aliases", "created_at"],
  Decision: ["summary", "decided_at", "source_excerpt"],
  File: ["path", "repo_root", "created_at"],
  Symbol: ["name", "symbol_kind", "created_at"],
  Feedback: ["body", "sentiment", "observed_at"],
};

function safeText(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return String(v);
}

export function buildMemoryWrap(kind: NodeKind, fields: Record<string, unknown>): string {
  const keys = USER_VISIBLE[kind];
  const lines: string[] = [];
  for (const k of keys) {
    const v = fields[k];
    if (v === undefined || v === null || v === "") continue;
    lines.push(`${k}: ${safeText(v)}`);
  }
  return `<memory kind="${kind}">\n${lines.join("\n")}\n</memory>`;
}

// Maps a Neo4j-record-style object (label + properties) into a MemoryItem.
// `label` is the Neo4j node label; `props` is the property map. We do NOT
// trust `project_id` in props — callers must scope it via the adapter.
export function nodeToMemoryItem(label: NodeKind, props: Record<string, unknown>): MemoryItem {
  const idValue = props["id"];
  const projectIdValue = props["project_id"];
  const id = typeof idValue === "string" ? idValue : String(idValue ?? "");
  const project_id = typeof projectIdValue === "number" ? projectIdValue : Number(projectIdValue ?? 0);
  const base = { kind: label, id, project_id };

  switch (label) {
    case "Entity": {
      const fields = {
        name: props["name"] ?? "",
        entity_kind: props["kind"],
        aliases: props["aliases"],
        created_at: props["created_at"],
      };
      return {
        ...base,
        kind: "Entity",
        name: String(fields.name),
        entity_kind: fields.entity_kind == null ? undefined : String(fields.entity_kind),
        aliases: Array.isArray(fields.aliases) ? (fields.aliases as string[]) : undefined,
        created_at: fields.created_at == null ? undefined : String(fields.created_at),
        _memory_wrapped: buildMemoryWrap("Entity", fields as Record<string, unknown>),
      };
    }
    case "Decision": {
      const fields = {
        summary: props["summary"] ?? "",
        decided_at: props["decided_at"],
        source_excerpt: props["source_excerpt"],
      };
      return {
        ...base,
        kind: "Decision",
        summary: String(fields.summary),
        decided_at: fields.decided_at == null ? undefined : String(fields.decided_at),
        source_excerpt: fields.source_excerpt == null ? undefined : String(fields.source_excerpt),
        _memory_wrapped: buildMemoryWrap("Decision", fields as Record<string, unknown>),
      };
    }
    case "File": {
      const fields = {
        path: props["path"] ?? "",
        repo_root: props["repo_root"],
        created_at: props["created_at"],
      };
      return {
        ...base,
        kind: "File",
        path: String(fields.path),
        repo_root: fields.repo_root == null ? undefined : String(fields.repo_root),
        created_at: fields.created_at == null ? undefined : String(fields.created_at),
        _memory_wrapped: buildMemoryWrap("File", fields as Record<string, unknown>),
      };
    }
    case "Symbol": {
      const fields = {
        name: props["name"] ?? "",
        symbol_kind: props["kind"],
        created_at: props["created_at"],
      };
      return {
        ...base,
        kind: "Symbol",
        name: String(fields.name),
        symbol_kind: fields.symbol_kind == null ? undefined : String(fields.symbol_kind),
        file_id: props["file_id"] == null ? undefined : String(props["file_id"]),
        created_at: fields.created_at == null ? undefined : String(fields.created_at),
        _memory_wrapped: buildMemoryWrap("Symbol", fields as Record<string, unknown>),
      };
    }
    case "Feedback": {
      const fields = {
        body: props["body"] ?? "",
        sentiment: props["sentiment"],
        observed_at: props["observed_at"],
      };
      const sentRaw = fields.sentiment;
      const sentiment: "positive" | "negative" | "neutral" | undefined =
        sentRaw === "positive" || sentRaw === "negative" || sentRaw === "neutral" ? sentRaw : undefined;
      return {
        ...base,
        kind: "Feedback",
        body: String(fields.body),
        sentiment,
        observed_at: fields.observed_at == null ? undefined : String(fields.observed_at),
        _memory_wrapped: buildMemoryWrap("Feedback", fields as Record<string, unknown>),
      };
    }
  }
}

// Round-trip-style extractor used by the caller (Claude Code) to pluck the
// payload back out for display. Returns the body between the open/close tags.
const WRAP_RE = /^<memory kind="([A-Za-z]+)">\n([\s\S]*?)\n<\/memory>$/;

export function extractMemoryWrap(text: string): { kind: string; body: string } | null {
  const m = WRAP_RE.exec(text);
  if (!m) return null;
  return { kind: m[1]!, body: m[2]! };
}
