import { describe, test, expect } from "bun:test";
import { askMemory, askMemorySchema } from "./ask_memory";
import { MemoryToolError } from "../../errors";
import { listTools, buildMcpServer } from "../../server";
import { ADMIN_TOOLS } from "../../../admin/index";
import type { AskClient, AskCompletion } from "./ask_loop";
import type { GraphAdapter } from "../../../graph/adapter";
import type { AuthContext } from "../../../auth/middleware";
import { extractMemoryWrap } from "../../memory/dto";

const ctx: AuthContext = { user_id: 1, project_id: 10, role: "member" };

function scriptedClient(turns: AskCompletion[]): AskClient {
  const queue = [...turns];
  return {
    async complete(): Promise<AskCompletion> {
      const t = queue.shift();
      if (!t) throw new Error("scripted client exhausted");
      return t;
    },
  };
}
const toolCall = (name: string, args: unknown): AskCompletion => ({ content: null, toolCalls: [{ id: "c1", name, args }] });
const answer = (text: string): AskCompletion => ({ content: text, toolCalls: [] });

function mockAdapter(rowsByTemplate: Record<string, unknown[]> = {}): GraphAdapter & { calls: string[] } {
  const calls: string[] = [];
  const adapter = {
    calls,
    async run(templateId: string) {
      calls.push(templateId);
      return { rows: rowsByTemplate[templateId] ?? [] };
    },
  };
  return adapter as unknown as GraphAdapter & { calls: string[] };
}

describe("askMemory schema (AC-WB3N9H.1)", () => {
  test("rejects empty question with a question-path issue", () => {
    const parsed = askMemorySchema.safeParse({ question: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toContain("question");
    }
  });

  test("rejects a malformed sub_projects element (reuses subProjectsSchema)", () => {
    const parsed = askMemorySchema.safeParse({ question: "ok", sub_projects: ["Bad Slug!"] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toContain("sub_projects");
    }
  });

  test("accepts a non-empty question with absent and slug-shaped sub_projects", () => {
    expect(askMemorySchema.safeParse({ question: "what is auth?" }).success).toBe(true);
    expect(askMemorySchema.safeParse({ question: "what is auth?", sub_projects: ["backend"] }).success).toBe(true);
  });
});

describe("askMemory handler", () => {
  // AC-WB3N9H.2 — no client configured ⇒ model_unavailable, distinct from
  // invalid_args, and no graph call is made.
  test("AC-WB3N9H.2: model_unavailable when no client configured; no graph call", async () => {
    const adapter = mockAdapter();
    let thrown: unknown;
    try {
      await askMemory({ question: "what is auth?" }, ctx, adapter, { client: undefined });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MemoryToolError);
    expect((thrown as MemoryToolError).code).toBe("model_unavailable");
    expect((thrown as MemoryToolError).code).not.toBe("invalid_args");
    expect((thrown as MemoryToolError).message.toUpperCase()).toContain("QUACK_MODEL");
    expect(adapter.calls.length).toBe(0);
  });

  // AC-WB3N9H.5 — successful call returns { answer, results, meta }; answer is
  // <memory>-wrapped; results carry _memory_wrapped; meta is the planned envelope.
  test("AC-WB3N9H.5 / AC-WB3N9H.8: answer is <memory>-wrapped; results carry _memory_wrapped", async () => {
    const adapter = mockAdapter({
      "memory.search": [{ label: "Entity", props: { id: "e1", project_id: 10, name: "auth" }, score: 1, neighbor: false }],
    });
    const client = scriptedClient([
      toolCall("search_memory", { entities: ["auth"] }),
      answer("auth is a library"),
    ]);

    const out = await askMemory({ question: "what is auth?" }, ctx, adapter, { client });

    // answer is <memory>-wrapped untrusted text.
    const unwrapped = extractMemoryWrap(out.answer);
    expect(unwrapped).not.toBeNull();
    expect(unwrapped!.body).toContain("auth is a library");

    // results carry the per-item wrap.
    expect(out.results.length).toBe(1);
    expect(out.results[0]!._memory_wrapped).toContain("<memory kind=\"Entity\">");

    // canonical planned envelope.
    expect(out.meta.mode_used).toBe("planned");
    expect(Array.isArray(out.meta.explain.tool_calls)).toBe(true);
  });

  // AC-WB3N9H.6 — empty retrieval path surfaced through the handler.
  test("AC-WB3N9H.6: empty retrieval → results [], no_full_text_match warning, answer still <memory>-wrapped", async () => {
    const adapter = mockAdapter({ "memory.search": [] });
    const client = scriptedClient([
      toolCall("search_memory", { entities: ["nope"] }),
      answer("No relevant memory was found."),
    ]);

    const out = await askMemory({ question: "anything?" }, ctx, adapter, { client });

    expect(out.results).toEqual([]);
    expect(out.meta.warnings).toContain("no_full_text_match");
    expect(extractMemoryWrap(out.answer)).not.toBeNull();
  });
});

describe("ask_memory registration (AC-WB3N9H.1 / AC-WB3N9H.11)", () => {
  // AC-WB3N9H.1 — registered on /mcp, NOT admin-gated.
  test("AC-WB3N9H.1: ask_memory is in the tool list and NOT in ADMIN_TOOLS", () => {
    expect(listTools()).toContain("ask_memory");
    expect(ADMIN_TOOLS.has("ask_memory")).toBe(false);
  });

  // AC-WB3N9H.11 — manifest contract phrasing distinguishing it from search_memory.
  test("AC-WB3N9H.11: manifest description states planning, <memory> untrusted, current-state-only, QUACK_MODEL_*", () => {
    const mcp = buildMcpServer();
    const tools = (mcp as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    const desc = tools["ask_memory"]?.description ?? "";
    expect(desc.length).toBeGreaterThan(0);
    const lower = desc.toLowerCase();
    expect(lower).toContain("plan");
    expect(desc).toContain("<memory>");
    expect(lower).toContain("untrusted");
    expect(lower).toContain("quack_model");
    // current-state only / no streaming-history framing.
    expect(lower).toMatch(/current state|no streaming|no history/);
  });
});
