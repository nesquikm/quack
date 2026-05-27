// Production AskClient (FR-WB3N9H AC-3) — adapts an OpenAI-compatible chat
// endpoint to the AskClient.next() interface the planned ask loop drives. Each
// turn, the loop's input (the question plus the cumulative redacted
// observations) is serialized into a user message; the model replies with a
// single JSON object describing either the next tool calls or a final answer.
//
// Mirrors the injection seam in src/extract/client.ts (openaiCtor?) so the loop
// can be exercised with a scripted fake in tests without a network round-trip.

import { z } from "zod";
import OpenAI from "openai";
import { ASK_SYSTEM_PROMPT } from "./ask_prompt";
import { MemoryToolError } from "../errors";
import type { AskClient, AskTurn } from "../tools/memory/ask_loop";

// The model is instructed (in the system prompt suffix below) to emit exactly
// this JSON shape. `args` is optional and defaults to {} so a parameterless
// tool call is tolerated.
const askTurnSchema = z.union([
  z.object({
    type: z.literal("tool_calls"),
    calls: z.array(z.object({ tool: z.string().min(1), args: z.unknown().optional() })),
  }),
  z.object({ type: z.literal("answer"), text: z.string() }),
]);

const PROTOCOL = `\n\nRespond with a SINGLE JSON object and nothing else.
To call tools: {"type":"tool_calls","calls":[{"tool":"<one of the four tools>","args":{ ... }}]}
To give your final answer: {"type":"answer","text":"<your answer>"}`;

// Parses a model turn (raw JSON string) into an AskTurn. Unknown tool names are
// left intact — the loop skips and warns on them (AC-10) rather than the client
// silently dropping them.
export function parseAskTurn(raw: string): AskTurn {
  const parsed = askTurnSchema.parse(JSON.parse(raw));
  if (parsed.type === "answer") return { type: "answer", text: parsed.text };
  return {
    type: "tool_calls",
    calls: parsed.calls.map((c) => ({ tool: c.tool, args: c.args ?? {} })),
  };
}

export interface AskClientOptions {
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

export function createAskClient(opts: AskClientOptions): AskClient {
  const Ctor = opts.openaiCtor ?? OpenAI;
  const client = new Ctor({ baseURL: opts.baseURL, apiKey: opts.apiKey }) as unknown as ChatLike;

  return {
    async next(input: unknown): Promise<AskTurn> {
      const res = await client.chat.completions.create({
        model: opts.modelName,
        messages: [
          { role: "system", content: ASK_SYSTEM_PROMPT + PROTOCOL },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_object" },
      });
      const content = res.choices[0]?.message?.content ?? "";
      // A malformed / empty / non-JSON model reply must surface as a graceful
      // MemoryToolError (caught by wrapAsk) rather than a raw SyntaxError /
      // ZodError that would escape as a 500-class internal error.
      try {
        return parseAskTurn(content);
      } catch {
        throw new MemoryToolError(
          "model_protocol_error",
          "the model returned a response that did not match the expected ask protocol",
        );
      }
    },
  };
}
