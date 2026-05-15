import { describe, test, expect } from "bun:test";
import { postEnvelope } from "../post";
import type { HookEnvelope } from "../shared/envelope";

const env: HookEnvelope = { kind: "stop", payload: { x: 1 } };

describe("postEnvelope", () => {
  test("happy path: 202 sends correct headers + body shape", async () => {
    let received: { url: string; init: RequestInit } | null = null;
    const fakeFetch: import("../post").FetchLike = async (input, init) => {
      received = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };
    await postEnvelope(env, { serverUrl: "http://x.test", token: "tk", fetchImpl: fakeFetch });
    expect(received).not.toBeNull();
    expect(received!.url).toBe("http://x.test/ingest");
    const headers = received!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tk");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(received!.init.body)) as HookEnvelope;
    expect(body.kind).toBe("stop");
  });

  test("5xx is logged but does NOT throw", async () => {
    const fakeFetch: import("../post").FetchLike = async () => new Response("oops", { status: 500 });
    await expect(postEnvelope(env, { serverUrl: "http://x.test", token: "tk", fetchImpl: fakeFetch })).resolves.toBeUndefined();
  });

  test("network error is logged but does NOT throw", async () => {
    const fakeFetch: import("../post").FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(postEnvelope(env, { serverUrl: "http://x.test", token: "tk", fetchImpl: fakeFetch })).resolves.toBeUndefined();
  });

  test("timeout: AbortSignal.timeout fires; logged but does NOT throw", async () => {
    const slowFetch: import("../post").FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      postEnvelope(env, { serverUrl: "http://x.test", token: "tk", fetchImpl: slowFetch, timeoutMs: 50 }),
    ).resolves.toBeUndefined();
  });
});
