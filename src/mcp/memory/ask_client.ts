// Production AskClient (FR-WB3N9H AC-3) — adapts an OpenAI-compatible chat
// endpoint to the AskClient.complete() interface using NATIVE tool-calling. The
// loop hands us the running conversation + the tool manifest; we forward both to
// the chat-completions endpoint with `tools` + `tool_choice: auto` and return
// the assistant's content and/or structured tool_calls. No JSON-in-content
// protocol — the model gets each tool's real argument schema and the transport
// parses tool_calls structurally.
//
// Mirrors the injection seam in src/extract/client.ts (openaiCtor?) so the loop
// can be exercised with a scripted fake in tests without a network round-trip.

import OpenAI from "openai";
import type { AskClient, AskCompletion, AskMessage, AskToolSpec } from "../tools/memory/ask_loop";

export interface AskClientOptions {
  baseURL: string;
  apiKey: string;
  modelName: string;
  // Injection seam for tests; if provided, replaces the real OpenAI client.
  openaiCtor?: typeof OpenAI;
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface ChatLike {
  chat: {
    completions: {
      create(req: Record<string, unknown>): Promise<{
        choices: Array<{ message: { content: string | null; tool_calls?: RawToolCall[] } }>;
      }>;
    };
  };
}

// Parse one OpenAI tool_call into an AskToolCall. A malformed `arguments` JSON
// string degrades to {} — the loop's per-tool Zod validation then rejects it as
// invalid_tool_args rather than the whole turn failing.
function parseRawToolCall(raw: RawToolCall, idx: number): { id: string; name: string; args: unknown } {
  let args: unknown = {};
  const argStr = raw.function?.arguments;
  if (typeof argStr === "string" && argStr.trim().length > 0) {
    try {
      args = JSON.parse(argStr);
    } catch {
      args = {};
    }
  }
  return { id: raw.id ?? `call_${idx}`, name: raw.function?.name ?? "", args };
}

export function createAskClient(opts: AskClientOptions): AskClient {
  const Ctor = opts.openaiCtor ?? OpenAI;
  const client = new Ctor({ baseURL: opts.baseURL, apiKey: opts.apiKey }) as unknown as ChatLike;

  return {
    async complete(messages: AskMessage[], tools: AskToolSpec[]): Promise<AskCompletion> {
      const req: Record<string, unknown> = { model: opts.modelName, messages };
      if (tools.length > 0) {
        req["tools"] = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        req["tool_choice"] = "auto";
      }
      const res = await client.chat.completions.create(req);
      const msg = res.choices[0]?.message;
      const toolCalls = (msg?.tool_calls ?? []).map((tc, i) => parseRawToolCall(tc, i));
      // Replay the assistant message VERBATIM on the next turn so provider fields
      // (e.g. Gemini's extra_content.google.thought_signature) round-trip — a
      // reconstructed message drops them and the follow-up request 400s.
      return { content: msg?.content ?? null, toolCalls, raw: msg as unknown as AskMessage };
    },
  };
}
