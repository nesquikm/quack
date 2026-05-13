// Extraction prompt anchored to the v1 schema in specs/technical-spec.md §2.
// The system prompt tells the model to emit JSON conforming to ExtractionResult
// and explicitly forbids invented labels / relation types.

export const NODE_KINDS = ["Entity", "Decision", "File", "Symbol", "Feedback"] as const;
export const RELATION_TYPES = ["MENTIONS", "DECIDED_BY", "RELATED_TO", "MODIFIES", "FOLLOWS"] as const;
export const SYMBOL_KINDS = ["function", "class", "type", "variable", "const"] as const;
export const SENTIMENTS = ["positive", "negative", "neutral"] as const;

// JSON Schema used for strict structured-output mode (OpenAI / Azure).
// Mirrors the Zod schema in client.ts so both validation paths agree.
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entities", "decisions", "files", "symbols", "feedbacks", "relations"],
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind"],
        properties: {
          name: { type: "string", minLength: 1 },
          kind: { type: "string", minLength: 1 },
          aliases: { type: "array", items: { type: "string" } },
        },
      },
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "source_excerpt"],
        properties: {
          summary: { type: "string", minLength: 1 },
          decided_at: { type: "string" },
          source_excerpt: { type: "string" },
        },
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1 },
          repo_root: { type: "string" },
        },
      },
    },
    symbols: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "file_path", "kind"],
        properties: {
          name: { type: "string", minLength: 1 },
          file_path: { type: "string", minLength: 1 },
          kind: { type: "string", enum: [...SYMBOL_KINDS] },
        },
      },
    },
    feedbacks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: {
          body: { type: "string", minLength: 1 },
          sentiment: { type: "string", enum: [...SENTIMENTS] },
        },
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "from", "to"],
        properties: {
          type: { type: "string", enum: [...RELATION_TYPES] },
          from: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "name"],
            properties: {
              kind: { type: "string", enum: [...NODE_KINDS] },
              name: { type: "string", minLength: 1 },
            },
          },
          to: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "name"],
            properties: {
              kind: { type: "string", enum: [...NODE_KINDS] },
              name: { type: "string", minLength: 1 },
            },
          },
          source_excerpt: { type: "string" },
        },
      },
    },
  },
} as const;

const SCHEMA_FOR_PROMPT = JSON.stringify(EXTRACTION_JSON_SCHEMA);

export const SYSTEM_PROMPT = `You extract structured graph facts from a Claude Code session
hook payload. Emit JSON ONLY, conforming exactly to the schema below.

Schema:
${SCHEMA_FOR_PROMPT}

Rules — non-negotiable:
- Use ONLY the listed node kinds (${NODE_KINDS.join(", ")}) and relation
  types (${RELATION_TYPES.join(", ")}). Do not invent new labels.
- If content does not fit the schema cleanly, OMIT it rather than coerce.
- Empty arrays are valid outputs for sessions with nothing extractable.
- Do not include explanations, prose, or any text outside the JSON object.`;

export function buildUserPrompt(payload: unknown): string {
  // AC-41NXTZ.7 — explicit_add branch frames content as a user-asserted fact.
  // Byte-localized: hook-kind branches fall through to the legacy frame below.
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === "explicit_add"
  ) {
    const inner = (payload as { payload?: { content?: unknown } }).payload?.content;
    return `The user explicitly asserted the following content. Extract entities, decisions, relations, files, symbols, and feedback exactly as the user stated them. Treat this as a user-asserted fact.\n\n${JSON.stringify(inner)}`;
  }
  return `Extract from this hook payload:\n\n${JSON.stringify(payload)}`;
}
