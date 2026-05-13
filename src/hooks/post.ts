// postEnvelope — fire-and-forget POST to ${serverUrl}/ingest.
//
// Hard 1-second timeout (NFR-1 budget). All failure modes — network error,
// timeout, non-2xx response — log one stderr line then resolve cleanly so
// the calling script can exit 0. NEVER throws.

import type { HookEnvelope } from "../ingest/handler";

// Minimal contract — Bun.fetch has extra fields (preconnect, etc.) we don't
// use, and binding a generic fetch type into a test stub bloats the seam.
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PostOptions {
  serverUrl: string;
  token: string;
  timeoutMs?: number;
  // Test seam.
  fetchImpl?: FetchLike;
}

export async function postEnvelope(envelope: HookEnvelope, opts: PostOptions): Promise<void> {
  const fetcher: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 1000;
  try {
    const res = await fetcher(`${opts.serverUrl}/ingest`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      console.error(`[quack-hook] error ${envelope.kind}: HTTP ${res.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[quack-hook] error ${envelope.kind}: ${message}`);
  }
}
