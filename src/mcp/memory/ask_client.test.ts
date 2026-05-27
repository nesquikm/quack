import { describe, test, expect } from "bun:test";
import { createAskClient, parseAskTurn } from "./ask_client";
import { ASK_SYSTEM_PROMPT } from "./ask_prompt";
import { MemoryToolError } from "../errors";

// A minimal OpenAI-compatible constructor stand-in: records the create() request
// and returns scripted JSON content as the assistant message.
function fakeOpenAI(contents: string[]) {
  const requests: Array<Record<string, unknown>> = [];
  const queue = [...contents];
  class FakeOpenAI {
    chat = {
      completions: {
        create: async (req: Record<string, unknown>) => {
          requests.push(req);
          const content = queue.shift() ?? "";
          return { choices: [{ message: { content } }] };
        },
      },
    };
  }
  return { Ctor: FakeOpenAI as unknown as typeof import("openai").default, requests };
}

describe("parseAskTurn", () => {
  test("parses a tool_calls turn, defaulting absent args to {}", () => {
    const turn = parseAskTurn('{"type":"tool_calls","calls":[{"tool":"search_memory","args":{"entities":["auth"]}},{"tool":"recent_decisions"}]}');
    expect(turn.type).toBe("tool_calls");
    if (turn.type === "tool_calls") {
      expect(turn.calls[0]!.tool).toBe("search_memory");
      expect(turn.calls[0]!.args).toEqual({ entities: ["auth"] });
      expect(turn.calls[1]!.args).toEqual({});
    }
  });

  test("parses an answer turn", () => {
    const turn = parseAskTurn('{"type":"answer","text":"auth is a library"}');
    expect(turn).toEqual({ type: "answer", text: "auth is a library" });
  });

  test("throws on malformed JSON / shape", () => {
    expect(() => parseAskTurn("not json")).toThrow();
    expect(() => parseAskTurn('{"type":"nope"}')).toThrow();
  });
});

describe("createAskClient", () => {
  test("sends ASK_SYSTEM_PROMPT and returns the parsed tool_calls turn", async () => {
    const { Ctor, requests } = fakeOpenAI([
      '{"type":"tool_calls","calls":[{"tool":"search_memory","args":{"entities":["auth"]}}]}',
    ]);
    const client = createAskClient({ baseURL: "http://x", apiKey: "k", modelName: "m", openaiCtor: Ctor });

    const turn = await client.next({ question: "what is auth?" });

    expect(turn.type).toBe("tool_calls");
    const messages = requests[0]!["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain(ASK_SYSTEM_PROMPT);
    // the loop's input is serialized into the user turn so the model can plan
    expect(JSON.stringify(messages)).toContain("what is auth?");
    expect(requests[0]!["model"]).toBe("m");
  });

  test("surfaces a MemoryToolError (not a raw SyntaxError) on malformed model output", async () => {
    const { Ctor } = fakeOpenAI(["not json at all"]);
    const client = createAskClient({ baseURL: "http://x", apiKey: "k", modelName: "m", openaiCtor: Ctor });
    let thrown: unknown;
    try {
      await client.next({ question: "q" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MemoryToolError);
    expect((thrown as MemoryToolError).code).toBe("model_protocol_error");
  });

  test("returns the parsed answer turn on a final response", async () => {
    const { Ctor } = fakeOpenAI(['{"type":"answer","text":"done"}']);
    const client = createAskClient({ baseURL: "http://x", apiKey: "k", modelName: "m", openaiCtor: Ctor });
    const turn = await client.next({ question: "q", observations: [] });
    expect(turn).toEqual({ type: "answer", text: "done" });
  });
});
