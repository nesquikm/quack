import { describe, test, expect } from "bun:test";
import { dispatchHook } from "../dispatch";

const ENV_WITH_TOKEN = { QUACK_TOKEN: "tk", QUACK_SERVER_URL: "http://test", QUACK_PROJECT_SLUG: "proj" };

describe("dispatchHook", () => {
  test("happy path: redacts + posts an envelope with the correct shape", async () => {
    let bodyJson: unknown = null;
    const fakeFetch: import("../post").FetchLike = async (_url, init) => {
      bodyJson = JSON.parse(String(init?.body));
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: { transcript: "secret token sk-abcdefghijklmnopqrstuvwx" },
      env: ENV_WITH_TOKEN,
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(true);
    const env = bodyJson as { kind: string; payload: { transcript: string }; project_slug?: string };
    expect(env.kind).toBe("stop");
    expect(env.payload.transcript).toContain("«REDACTED»");
    expect(env.project_slug).toBe("proj");
  });

  test("unknown kind ⇒ no fetch", async () => {
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "garbage",
      payload: {},
      env: ENV_WITH_TOKEN,
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(out.reason).toBe("unknown_kind");
    expect(called).toBe(0);
  });

  test("missing token ⇒ no fetch (silent disable)", async () => {
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: {},
      env: {},
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(out.reason).toBe("no_token");
    expect(called).toBe(0);
  });

  test("missing payload ⇒ no fetch", async () => {
    let called = 0;
    const fakeFetch: import("../post").FetchLike = async () => {
      called += 1;
      return new Response(null, { status: 202 });
    };
    const out = await dispatchHook({
      kind: "stop",
      payload: null,
      env: ENV_WITH_TOKEN,
      fetchImpl: fakeFetch,
    });
    expect(out.posted).toBe(false);
    expect(called).toBe(0);
  });
});
