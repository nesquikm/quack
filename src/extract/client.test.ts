import { describe, test, expect, beforeEach } from "bun:test";
import { createExtractionClient, resetStrictModeCacheForTests } from "./client";

beforeEach(() => resetStrictModeCacheForTests());

interface ChatCallShape {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string; json_schema?: unknown };
}

function buildOk(json: string) {
  return {
    chat: {
      completions: {
        async create(req: ChatCallShape) {
          buildOk.lastReq = req;
          return { choices: [{ message: { content: json } }] };
        },
      },
    },
  };
}
buildOk.lastReq = null as unknown as ChatCallShape;

const VALID_RESPONSE = JSON.stringify({
  entities: [{ name: "auth", kind: "library" }],
  decisions: [],
  files: [],
  symbols: [],
  feedbacks: [],
  relations: [],
});

describe("createExtractionClient — strict mode happy path", () => {
  test("first call uses json_schema strict, caches success", async () => {
    const fakeOpenAi = function () {
      return buildOk(VALID_RESPONSE);
    } as unknown as typeof import("openai").default;
    const c = createExtractionClient({
      baseURL: "https://x.test/v1",
      apiKey: "k",
      modelName: "gpt-4o-mini",
      openaiCtor: fakeOpenAi,
    });
    const out = await c.extract({ kind: "stop", payload: {} });
    expect(out.entities[0]?.name).toBe("auth");
    expect(buildOk.lastReq.response_format?.type).toBe("json_schema");
  });
});

describe("createExtractionClient — fallback to json_object", () => {
  test("400 unsupported_response_format triggers fallback + per-baseURL cache", async () => {
    let firstCall = true;
    let fallbackCount = 0;
    const fakeOpenAi = function () {
      return {
        chat: {
          completions: {
            async create(req: ChatCallShape) {
              if (firstCall) {
                firstCall = false;
                const err = new Error("unsupported_response_format: provider X does not support json_schema");
                (err as { status?: number }).status = 400;
                throw err;
              }
              fallbackCount += 1;
              expect(req.response_format?.type).toBe("json_object");
              return { choices: [{ message: { content: VALID_RESPONSE } }] };
            },
          },
        },
      };
    } as unknown as typeof import("openai").default;

    const c = createExtractionClient({
      baseURL: "https://fallback.test/v1",
      apiKey: "k",
      modelName: "x",
      openaiCtor: fakeOpenAi,
    });
    await c.extract({ kind: "stop", payload: {} });
    expect(fallbackCount).toBe(1);
    // Second call uses cached fallback decision — no strict probe.
    await c.extract({ kind: "stop", payload: {} });
    expect(fallbackCount).toBe(2);
  });
});

describe("createExtractionClient — Zod refusal on malformed response", () => {
  test("invented relation type fails ExtractionResult parse", async () => {
    const bad = JSON.stringify({
      entities: [],
      decisions: [],
      files: [],
      symbols: [],
      feedbacks: [],
      relations: [{ type: "MADE_UP", from: { kind: "Entity", name: "a" }, to: { kind: "Entity", name: "b" } }],
    });
    const fakeOpenAi = function () {
      return buildOk(bad);
    } as unknown as typeof import("openai").default;
    const c = createExtractionClient({
      baseURL: "https://zod.test/v1",
      apiKey: "k",
      modelName: "x",
      openaiCtor: fakeOpenAi,
    });
    await expect(c.extract({})).rejects.toBeDefined();
  });
});
