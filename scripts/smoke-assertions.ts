// Pure decision logic for the comprehensive full-stack smoke driver
// (FR-D17E0R). These helpers contain *all* the tolerant matching / discovery /
// aggregation logic the live driver needs, factored out so they are unit-
// testable against fixture JSON with no network, Docker, or model (see
// `scripts/smoke-assertions.test.ts`). The orchestration (HTTP/MCP I/O, polling,
// stack lifecycle) is a thin wrapper around these — kept separate on purpose.
//
// Wire shapes mirrored here:
//   - MCP result:    { content: [{ type: "text", text: <JSON string> }], isError? }
//                    (src/mcp/server.ts ok()/errResult())
//   - JSON-RPC:      { jsonrpc, id, result }
//   - MemoryEnvelope<T>: { results: T[], meta: { mode_used, coverage, warnings } }
//                    (src/mcp/memory/coverage.ts)
//   - HookEnvelope:  { kind, payload, sub_project?, ts? }
//                    (plugins/quack/hooks/_lib/shared/envelope.ts)
//   - META_TOOLS mirrors plugins/quack/hooks/_lib/shared/meta_tools.ts.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- shared structural helpers -------------------------------------------
// Envelope-consuming helpers accept `unknown` and narrow internally: they
// parse wire data whose static shape isn't known (parseMcpText returns a bare
// Record), so a lenient `unknown` boundary is the honest contract.

/** META_TOOLS — mirror of plugins/quack/hooks/_lib/shared/meta_tools.ts. */
export const META_TOOLS: ReadonlySet<string> = new Set<string>(["ToolSearch"]);

// ---- small internal utilities --------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function warningsOf(env: unknown): string[] {
  const w = asObject(asObject(env)?.meta)?.warnings;
  return Array.isArray(w) ? w.map((x) => String(x)) : [];
}

function resultsOf(env: unknown): unknown[] {
  return asArray(asObject(env)?.results);
}

/** True when some object in `list` has `[field] === value`. */
function listContainsField(list: unknown, field: string, value: string): boolean {
  return asArray(list).some((item) => asObject(item)?.[field] === value);
}

// ---- parseMcpText --------------------------------------------------------

/**
 * Unwrap a JSON-RPC response (object or its JSON string) into the parsed
 * payload carried in `result.content[0].text` (itself a JSON string). When the
 * MCP result has `isError: true`, the returned object carries an `isError: true`
 * marker alongside the decoded error body so callers can branch on it.
 */
export function parseMcpText(rpcJson: unknown): Record<string, unknown> {
  const rpc = typeof rpcJson === "string" ? safeParse(rpcJson) : rpcJson;
  const rpcObj = asObject(rpc);
  // Allow both a full JSON-RPC envelope ({ result }) and a bare MCP result.
  const result =
    rpcObj && "result" in rpcObj ? asObject(rpcObj.result) : asObject(rpc);
  if (!result) return {};

  const content = asArray(result.content);
  const first = asObject(content[0]);
  const text = first && typeof first.text === "string" ? first.text : undefined;

  const parsed = text !== undefined ? asObject(safeParse(text)) : null;
  const body: Record<string, unknown> = parsed ? { ...parsed } : {};

  if (result.isError === true) body.isError = true;
  return body;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- discoverNodeId ------------------------------------------------------

/** First `results[].id` string from a search envelope, or null when empty. */
export function discoverNodeId(searchEnvelope: unknown): string | null {
  for (const item of resultsOf(searchEnvelope)) {
    const obj = asObject(item);
    if (obj && typeof obj.id === "string") return obj.id;
  }
  return null;
}

// ---- hasNeighbor ---------------------------------------------------------

/** True when a get_neighbors envelope returned ≥ 1 result. */
export function hasNeighbor(neighborsEnvelope: unknown): boolean {
  return resultsOf(neighborsEnvelope).length >= 1;
}

// ---- pathFound -----------------------------------------------------------

/**
 * True when a path_between envelope returned ≥ 1 result AND did not flag the
 * `no_path_found` sentinel warning.
 */
export function pathFound(pathEnvelope: unknown): boolean {
  if (warningsOf(pathEnvelope).includes("no_path_found")) return false;
  return resultsOf(pathEnvelope).length >= 1;
}

// ---- decisionPresent -----------------------------------------------------

/** True when some Decision result's `summary` contains needle (case-insensitive). */
export function decisionPresent(
  decisionsEnvelope: unknown,
  needle: string,
): boolean {
  for (const item of resultsOf(decisionsEnvelope)) {
    const obj = asObject(item);
    if (!obj || obj.kind !== "Decision") continue;
    if (typeof obj.summary === "string" && includesCI(obj.summary, needle)) {
      return true;
    }
  }
  return false;
}

// ---- isGroundedAnswer ----------------------------------------------------

/**
 * True when an ask_memory envelope is a grounded answer: planned mode, a
 * `<memory`-wrapped answer, and the needle present (case-insensitive).
 */
export function isGroundedAnswer(askEnvelope: unknown, needle: string): boolean {
  const obj = asObject(askEnvelope);
  if (asObject(obj?.meta)?.mode_used !== "planned") return false;
  const answer = typeof obj?.answer === "string" ? obj.answer : "";
  if (!answer.includes("<memory")) return false;
  return includesCI(answer, needle);
}

// ---- contentSurfaced -----------------------------------------------------

/**
 * True when needle (case-insensitive) appears anywhere in the serialized
 * results — entity name, decision summary, or the full serialized item.
 */
export function contentSurfaced(searchEnvelope: unknown, needle: string): boolean {
  return includesCI(JSON.stringify(resultsOf(searchEnvelope)), needle);
}

// ---- userListed / projectListed -----------------------------------------

/** True when username appears in a list_users envelope's `users[].username`. */
export function userListed(listUsersEnvelope: unknown, username: string): boolean {
  return listContainsField(asObject(listUsersEnvelope)?.users, "username", username);
}

/** True when slug appears in a list_projects envelope's `projects[].slug`. */
export function projectListed(listProjectsEnvelope: unknown, slug: string): boolean {
  return listContainsField(asObject(listProjectsEnvelope)?.projects, "slug", slug);
}

// ---- countsReflect -------------------------------------------------------

interface CountMins {
  minUsers?: number;
  minProjects?: number;
}

/**
 * True when a server_status envelope's counts meet the supplied minimums.
 * Absent mins are treated as 0.
 */
export function countsReflect(serverStatusEnvelope: unknown, mins: CountMins): boolean {
  const counts = asObject(asObject(serverStatusEnvelope)?.counts);
  const users = Number(counts?.users ?? 0);
  const projects = Number(counts?.projects ?? 0);
  return users >= (mins.minUsers ?? 0) && projects >= (mins.minProjects ?? 0);
}

// ---- tokenRejected -------------------------------------------------------

/**
 * True when a response indicates auth rejection: an `isError` flag, a
 * `forbidden`/`unauthorized` error body, or an HTTP 401/403 status.
 */
export function tokenRejected(responseOrEnvelope: unknown): boolean {
  const obj = asObject(responseOrEnvelope);
  if (!obj) return false;

  if (obj.isError === true) return true;

  const status = Number(obj.status);
  if (status === 401 || status === 403) return true;

  const error = typeof obj.error === "string" ? obj.error.toLowerCase() : "";
  if (error.includes("forbidden") || error.includes("unauthorized")) return true;

  return false;
}

// ---- projectGone ---------------------------------------------------------

/** True when slug is NOT present in a list_projects envelope's `projects[].slug`. */
export function projectGone(listProjectsEnvelope: unknown, slug: string): boolean {
  return !projectListed(listProjectsEnvelope, slug);
}

// ---- buildHookEnvelope ---------------------------------------------------

type HookKind = "session_start" | "post_tool_use" | "stop";

interface HookEnvelope {
  kind: HookKind;
  payload: Record<string, unknown>;
  sub_project?: string;
  ts?: string;
}

/**
 * Build a HookEnvelope placing `knownText` in the kind-appropriate text-bearing
 * payload field so it flows through the real extractor:
 *   - post_tool_use → payload.tool_output (with a payload.tool_name)
 *   - stop          → payload.transcript
 *   - session_start → payload.context (a free-text field)
 */
export function buildHookEnvelope(kind: HookKind, knownText: string): HookEnvelope {
  const ts = new Date().toISOString();
  let payload: Record<string, unknown>;

  switch (kind) {
    case "post_tool_use":
      payload = { tool_name: "Edit", tool_output: knownText };
      break;
    case "stop":
      payload = { transcript: knownText };
      break;
    case "session_start":
      payload = { session_id: "smoke", context: knownText };
      break;
  }

  return { kind, payload, ts };
}

// ---- isMetaToolEnvelope --------------------------------------------------

/**
 * Denoise predicate (mirrors the M10 / FR-Z1W6ED drop): true only for a
 * `post_tool_use` envelope whose `payload.tool_name` is a META_TOOL.
 */
export function isMetaToolEnvelope(env: unknown): boolean {
  const obj = asObject(env);
  if (!obj || obj.kind !== "post_tool_use") return false;
  const payload = asObject(obj.payload);
  const toolName = payload?.tool_name;
  return typeof toolName === "string" && META_TOOLS.has(toolName);
}

// ---- summarize -----------------------------------------------------------

interface AssertionResult {
  name: string;
  ok: boolean;
}

interface RunSummary {
  exitCode: number;
  passed: number;
  failed: number;
}

/**
 * Aggregate per-assertion results into a run summary: exit 0 when every
 * assertion passed (and on empty input), exit 1 when any failed.
 */
export function summarize(results: AssertionResult[]): RunSummary {
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.ok) passed += 1;
    else failed += 1;
  }
  return { exitCode: failed > 0 ? 1 : 0, passed, failed };
}

// ===========================================================================
// Live-stack orchestration (NOT unit-tested — exercised by the real smoke run
// via `bash scripts/smoke-test.sh`). Every assertion's *decision* is delegated
// to a pure helper above; this block is the thin HTTP/MCP/subprocess I/O
// wrapper around them. Guarded by `import.meta.main`, so importing the helpers
// (e.g. from scripts/smoke-assertions.test.ts) never opens a socket or spawns
// a process. Tolerant matchers + bounded polling absorb model non-determinism.
// ===========================================================================

const CONTENT_TYPE = "application/json";
const MCP_ACCEPT = "application/json, text/event-stream";

/** Pull the JSON-RPC body out of either a plain-JSON or an SSE `data:` response. */
function extractRpcJson(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  for (const line of text.split("\n")) {
    const l = line.trimStart();
    if (l.startsWith("data:")) return l.slice("data:".length).trim();
  }
  return text;
}

/** server_status → queue.accepted_total, or NaN when the metric is unavailable. */
function acceptedTotal(statusEnv: Record<string, unknown>): number {
  const queue = statusEnv.queue;
  if (typeof queue === "object" && queue !== null) {
    const v = (queue as Record<string, unknown>).accepted_total;
    if (typeof v === "number") return v;
  }
  return NaN;
}

/** First `results[].id` that differs from `notId` (for a distinct path endpoint). */
function discoverOtherNodeId(env: unknown, notId: string): string | null {
  for (const item of resultsOf(env)) {
    const obj = asObject(item);
    if (obj && typeof obj.id === "string" && obj.id !== notId) return obj.id;
  }
  return null;
}

async function runLiveSmoke(argv: string[]): Promise<number> {
  const [url, adminToken, memberToken, slug] = argv;
  if (!url || !adminToken || !memberToken || !slug) {
    console.error(
      "usage: bun scripts/smoke-assertions.ts <url> <admin-token> <member-token> <slug>",
    );
    return 2;
  }

  const results: AssertionResult[] = [];
  const record = (name: string, ok: boolean): boolean => {
    results.push({ name, ok });
    console.log(`  ${ok ? "✅" : "❌"} ${name}`);
    return ok;
  };
  const skip = (name: string): void => console.log(`  ⏭️  ${name}`);

  /** Call an MCP tool; returns the parsed envelope (or an isError marker). */
  async function mcp(
    token: string,
    name: string,
    args: Record<string, unknown>,
    sub?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": CONTENT_TYPE,
      accept: MCP_ACCEPT,
    };
    if (sub) headers["x-quack-sub-project"] = sub;
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await res.text();
      // Auth rejection (revoked/invalid token) is an HTTP 401/403 from the
      // middleware, before MCP — surface the status so tokenRejected() sees it.
      if (!res.ok) return { isError: true, status: res.status, error: text.slice(0, 200) };
      return parseMcpText(extractRpcJson(text));
    } catch (err) {
      return { isError: true, error: String(err) };
    }
  }

  /** Fire-and-forget POST of a hook envelope straight to /ingest. */
  async function ingest(token: string, envelope: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${url}/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": CONTENT_TYPE },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Poll an async predicate until true or the bounded budget is exhausted. */
  async function poll(fn: () => Promise<boolean>, tries = 20, delayMs = 3_000): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      try {
        if (await fn()) return true;
      } catch {
        /* tolerate transient errors during extraction warm-up */
      }
      await Bun.sleep(delayMs);
    }
    return false;
  }

  // A throwaway client dir holding the same `.mcp.json` /quack:install writes —
  // lets us fire the REAL hook entries (which resolve config by walking up for
  // `.mcp.json`) so the client-side META_TOOLS denoise is exercised end-to-end.
  const clientDir = mkdtempSync(join(tmpdir(), "quack-smoke-"));
  writeFileSync(
    join(clientDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        quack: {
          type: "http",
          url: `${url}/mcp`,
          headers: { Authorization: `Bearer ${memberToken}`, "X-Quack-Sub-Project": slug },
        },
      },
    }),
  );

  /** Spawn a real hook entry with the inner payload on stdin. */
  async function fireHookEntry(kind: string, payload: Record<string, unknown>): Promise<void> {
    const entry = join(
      import.meta.dir,
      "..",
      "plugins",
      "quack",
      "hooks",
      "_lib",
      "entry",
      `${kind}.ts`,
    );
    const proc = Bun.spawn({
      cmd: ["bun", entry],
      cwd: clientDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: clientDir },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "ignore",
      stderr: "ignore",
    });
    // Hook entries are fire-and-forget with a 1s POST budget and exit 0 promptly;
    // kill a stuck spawn so a broken hook never hangs the whole smoke.
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    // ---- AC-D17E0R.2 — memory read round-trip (discover → traverse) --------
    console.log("== memory read round-trip (member token) ==");
    const seed =
      "We decided to use PostgreSQL for the billing service because of its " +
      "strong transactional guarantees. Bob owns the billing module and " +
      "collaborates with Alice on the billing service.";
    const added = await mcp(memberToken, "add_memory", { content: seed }, slug);
    record("add_memory accepted", added.accepted === true);

    let searchEnv: Record<string, unknown> = {};
    const searched = await poll(async () => {
      searchEnv = await mcp(memberToken, "search_memory", { entities: ["PostgreSQL", "billing", "Bob"] }, slug);
      return contentSurfaced(searchEnv, "billing");
    });
    record("search_memory surfaces seeded entities (real-model extraction)", searched);

    const nodeA = discoverNodeId(searchEnv);
    let neighborsEnv: Record<string, unknown> = {};
    if (nodeA) {
      neighborsEnv = await mcp(memberToken, "get_neighbors", { node_id: nodeA }, slug);
    }
    record("get_neighbors returns ≥1 related node", nodeA !== null && hasNeighbor(neighborsEnv));

    const nodeB = nodeA ? discoverOtherNodeId(neighborsEnv, nodeA) : null;
    let pathEnv: Record<string, unknown> = {};
    if (nodeA && nodeB) {
      pathEnv = await mcp(memberToken, "path_between", { node_a: nodeA, node_b: nodeB }, slug);
    }
    record("path_between two connected nodes returns a path", nodeA !== null && nodeB !== null && pathFound(pathEnv));

    const decisionsEnv = await mcp(memberToken, "recent_decisions", { time_window: "7d" }, slug);
    record("recent_decisions returns the seeded decision", decisionPresent(decisionsEnv, "billing") || decisionPresent(decisionsEnv, "postgres"));

    const askEnv = await mcp(
      memberToken,
      "ask_memory",
      { question: "Which database does the billing service use and why, and who owns it?" },
      slug,
    );
    record("ask_memory returns a grounded <memory>-wrapped answer", isGroundedAnswer(askEnv, "postgres"));

    // ---- AC-D17E0R.3 — hook round-trip by content + denoise negative -------
    console.log("== hook round-trips by content ==");
    const hooks: { kind: "session_start" | "post_tool_use" | "stop"; text: string; needle: string }[] = [
      { kind: "session_start", text: "Project Falcon launched the authentication redesign initiative.", needle: "Falcon" },
      { kind: "post_tool_use", text: "The deployment pipeline runs on Kubernetes for the checkout service.", needle: "Kubernetes" },
      { kind: "stop", text: "We adopted Redis for session caching in the API gateway.", needle: "Redis" },
    ];
    for (const h of hooks) {
      const env = { ...buildHookEnvelope(h.kind, h.text), sub_project: slug } as Record<string, unknown>;
      await ingest(memberToken, env);
    }
    for (const h of hooks) {
      const ok = await poll(async () =>
        contentSurfaced(await mcp(memberToken, "search_memory", { entities: [h.needle] }, slug), h.needle),
      );
      record(`hook ${h.kind} content surfaced (${h.needle})`, ok);
    }

    // META_TOOLS denoise: fire the REAL post_tool_use entry with a meta tool —
    // the client-side dispatch drops it before /ingest, so accepted_total must
    // NOT advance (the end-to-end proof that meta chatter never becomes a node).
    const before = acceptedTotal(await mcp(adminToken, "server_status", {}));
    await fireHookEntry("post_tool_use", {
      tool_name: "ToolSearch",
      tool_output: "ToolSearch introspection chatter about MagicWidget must never persist.",
    });
    await Bun.sleep(4_000);
    const after = acceptedTotal(await mcp(adminToken, "server_status", {}));
    let denoiseOk: boolean;
    if (Number.isFinite(before) && Number.isFinite(after)) {
      denoiseOk = after === before;
    } else {
      // Fallback when the counter is unavailable: prove the phrase never landed.
      denoiseOk = !contentSurfaced(
        await mcp(memberToken, "search_memory", { entities: ["MagicWidget"] }, slug),
        "MagicWidget",
      );
    }
    record("META_TOOLS post_tool_use denoised (no ingest, no Decision)", denoiseOk);

    // ---- AC-D17E0R.4 — admin data-effect + destructive lifecycle LAST ------
    // smoke-test.sh registers the seed user with username === slug, so `slug`
    // doubles as the expected username in list_users.
    console.log("== admin plane (data effect) ==");
    record("list_users contains the seeded user", userListed(await mcp(adminToken, "list_users", {}), slug));
    record("list_projects contains the seeded project", projectListed(await mcp(adminToken, "list_projects", {}), slug));
    record("server_status counts reflect seeded activity", countsReflect(await mcp(adminToken, "server_status", {}), { minUsers: 1, minProjects: 1 }));
    record("admin gate blocks member token", tokenRejected(await mcp(memberToken, "list_users", {}, slug)));

    console.log("== destructive lifecycle (last) ==");
    const tokenId = process.env.QUACK_SMOKE_MEMBER_TOKEN_ID;
    let tokenAlreadyRevoked = false;
    if (tokenId && /^\d+$/.test(tokenId)) {
      await mcp(adminToken, "revoke_token", { token_id: Number(tokenId) });
      record(
        "revoke_token → member token subsequently rejected",
        tokenRejected(await mcp(memberToken, "search_memory", { entities: ["billing"] }, slug)),
      );
      tokenAlreadyRevoked = true;
    } else {
      skip("revoke_token skipped (QUACK_SMOKE_MEMBER_TOKEN_ID unset — run via smoke-test.sh for the positive check)");
    }
    // Assert remove_member's OWN data effect (removed:true) — non-vacuous even
    // when revoke_token already killed the token just above. Only re-check the
    // token-rejection effect here when revoke_token did NOT run (else it's a
    // tautology: the token is already dead).
    const removed = await mcp(adminToken, "remove_member", { username: slug, project_slug: slug });
    record("remove_member removed the membership", removed.removed === true);
    if (!tokenAlreadyRevoked) {
      record(
        "remove_member → member token subsequently rejected",
        tokenRejected(await mcp(memberToken, "search_memory", { entities: ["billing"] }, slug)),
      );
    }
    const deleted = await mcp(adminToken, "delete_project", { slug });
    record("delete_project reported success", deleted.deleted === true);
    record("delete_project → project gone", projectGone(await mcp(adminToken, "list_projects", {}), slug));
  } finally {
    rmSync(clientDir, { recursive: true, force: true });
  }

  const { exitCode, passed, failed } = summarize(results);
  console.log("");
  console.log(`==== SMOKE ASSERTIONS: ${passed} passed, ${failed} failed ====`);
  return exitCode;
}

if (import.meta.main) {
  runLiveSmoke(process.argv.slice(2)).then((code) => process.exit(code));
}
