import { describe, test, expect } from "bun:test";
import { createAskClient } from "./ask_client";
import { ASK_TOOL_SPECS, type AskMessage } from "../tools/memory/ask_loop";

// Minimal OpenAI-compatible constructor stand-in: records each create() request
// and returns scripted assistant messages (content and/or tool_calls).
function fakeOpenAI(messages: Array<{ content: string | null; tool_calls?: unknown[] }>) {
  const requests: Array<Record<string, unknown>> = [];
  const queue = [...messages];
  class FakeOpenAI {
    chat = {
      completions: {
        create: async (req: Record<string, unknown>) => {
          requests.push(req);
          const msg = queue.shift() ?? { content: "" };
          return { choices: [{ message: msg }] };
        },
      },
    };
  }
  return { Ctor: FakeOpenAI as unknown as typeof import("openai").default, requests };
}

const sysUser: AskMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "what is auth?" },
];

describe("createAskClient.complete (native tool-calling)", () => {
  test("forwards tools[] + tool_choice and parses structured tool_calls", async () => {
    const { Ctor, requests } = fakeOpenAI([
      { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_memory", arguments: '{"entities":["auth"]}' } }] },
    ]);
    const client = createAskClient({ baseURL: "http://x", apiKey: "k", modelName: "m", openaiCtor: Ctor });

    const out = await client.complete(sysUser, ASK_TOOL_SPECS);

    expect(out.content).toBeNull();
    expect(out.toolCalls).toEqual([{ id: "call_1", name: "search_memory", args: { entities: ["auth"] } }]);
    // request carried the tool manifest + auto choice + model
    expect(requests[0]!["model"]).toBe("m");
    expect(requests[0]!["tool_choice"]).toBe("auto");
    expect(Array.isArray(requests[0]!["tools"])).toBe(true);
    expect(JSON.stringify(requests[0]!["tools"])).toContain("search_memory");
  });

  test("returns content (no tool_calls) on a final answer", async () => {
    const { Ctor } = fakeOpenAI([{ content: "auth is a library" }]);
    const client = createAskClient({ baseURL: "http://x", apiKey: "k", modelName: "m", openaiCtor: Ctor });
    const out = await client.complete(sysUser, ASK_TOOL_SPECS);
    expect(out.content).toBe("auth is a library");
    expect(out.toolCalls).toEqual([]);
  });

  test("omits tools[] when the manifest is empty (forced-synthesis turn)", async () => {
    const { Ctor, requests } = fakeOpenAI([{ content: "final" }]);
    const client = createAskClient({ baseURL: "http://x", apiKey: "k", modelName: "m", openaiCtor: Ctor });
    await client.complete(sysUser, []);
    expect(requests[0]!["tools"]).toBeUndefined();
    expect(requests[0]!["tool_choice"]).toBeUndefined();
  });

  test("degrades a malformed tool_call arguments string to {} (loop's Zod gate rejects it)", async () => {
    const { Ctor } = fakeOpenAI([
      { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_memory", arguments: "not json" } }] },
    ]);
    const client = createAskClient({ baseURL: "http://x", apiKey: "k", modelName: "m", openaiCtor: Ctor });
    const out = await client.complete(sysUser, ASK_TOOL_SPECS);
    expect(out.toolCalls).toEqual([{ id: "c1", name: "search_memory", args: {} }]);
  });
});
