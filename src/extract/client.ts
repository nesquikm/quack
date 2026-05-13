import { z } from "zod";
import OpenAI from "openai";
import { SYSTEM_PROMPT, EXTRACTION_JSON_SCHEMA, buildUserPrompt, NODE_KINDS, RELATION_TYPES, SYMBOL_KINDS, SENTIMENTS } from "./prompt";

// Server-side Zod schema mirrors EXTRACTION_JSON_SCHEMA. Used to validate the
// model's response BEFORE the graph write — parse failure ⇒ dead-letter +
// extraction_failed counter.

const nodeKindSchema = z.enum([...NODE_KINDS]);
const relationTypeSchema = z.enum([...RELATION_TYPES]);

export const ExtractionResultSchema = z.object({
  entities: z.array(z.object({
    name: z.string().min(1),
    kind: z.string().min(1),
    aliases: z.array(z.string()).optional(),
  })),
  decisions: z.array(z.object({
    summary: z.string().min(1),
    decided_at: z.string().optional(),
    source_excerpt: z.string(),
  })),
  files: z.array(z.object({
    path: z.string().min(1),
    repo_root: z.string().optional(),
  })),
  symbols: z.array(z.object({
    name: z.string().min(1),
    file_path: z.string().min(1),
    kind: z.enum([...SYMBOL_KINDS]),
  })),
  feedbacks: z.array(z.object({
    body: z.string().min(1),
    sentiment: z.enum([...SENTIMENTS]).optional(),
  })),
  relations: z.array(z.object({
    type: relationTypeSchema,
    from: z.object({ kind: nodeKindSchema, name: z.string().min(1) }),
    to: z.object({ kind: nodeKindSchema, name: z.string().min(1) }),
    source_excerpt: z.string().optional(),
  })),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// Per-baseURL capability cache. The OpenAI/Azure strict-mode probe is run
// once per baseURL; subsequent calls reuse the result.
const STRICT_MODE_CACHE = new Map<string, boolean>();

export function resetStrictModeCacheForTests(): void {
  STRICT_MODE_CACHE.clear();
}

export interface ExtractionClient {
  extract(payload: unknown): Promise<ExtractionResult>;
}

export interface ExtractionClientOptions {
  baseURL: string;
  apiKey: string;
  modelName: string;
  // Injection seam for tests; if provided, replaces the real OpenAI client.
  openaiCtor?: typeof OpenAI;
}

interface ChatLike {
  chat: {
    completions: {
      create(req: Record<string, unknown>): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

export function createExtractionClient(opts: ExtractionClientOptions): ExtractionClient {
  const Ctor = opts.openaiCtor ?? OpenAI;
  const client = new Ctor({ baseURL: opts.baseURL, apiKey: opts.apiKey }) as unknown as ChatLike;

  async function callStrict(payload: unknown): Promise<string> {
    const res = await client.chat.completions.create({
      model: opts.modelName,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(payload) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "ExtractionResult", schema: EXTRACTION_JSON_SCHEMA, strict: true },
      },
    });
    return res.choices[0]?.message?.content ?? "";
  }

  async function callJsonObject(payload: unknown): Promise<string> {
    const res = await client.chat.completions.create({
      model: opts.modelName,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(payload) },
      ],
      response_format: { type: "json_object" },
    });
    return res.choices[0]?.message?.content ?? "";
  }

  return {
    async extract(payload: unknown): Promise<ExtractionResult> {
      const cached = STRICT_MODE_CACHE.get(opts.baseURL);
      let raw: string;
      if (cached === false) {
        raw = await callJsonObject(payload);
      } else {
        try {
          raw = await callStrict(payload);
          if (cached === undefined) STRICT_MODE_CACHE.set(opts.baseURL, true);
        } catch (err) {
          if (isUnsupportedResponseFormat(err)) {
            STRICT_MODE_CACHE.set(opts.baseURL, false);
            raw = await callJsonObject(payload);
          } else {
            throw err;
          }
        }
      }
      const parsed = JSON.parse(raw) as unknown;
      return ExtractionResultSchema.parse(parsed);
    },
  };
}

function isUnsupportedResponseFormat(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; message?: string; code?: string };
  if (e.status === 400 && typeof e.message === "string" && /unsupported_response_format|response_format/i.test(e.message)) {
    return true;
  }
  if (e.code === "unsupported_response_format") return true;
  return false;
}
