import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SUB_PROJECT_RE } from "./shared/envelope";

// Configuration resolution.
//
// AC-55S220.5: the plugin hooks read configuration from a project-scoped
// `.mcp.json` — INSTEAD OF `process.env`. `resolveConfig({ startDir })` walks
// up from `startDir` to the filesystem root looking for a `.mcp.json`, parses
// it, and extracts the `mcpServers.quack` entry:
//   - serverUrl  ← `url` with a trailing `/mcp` stripped (the ingest base URL)
//   - token      ← `headers.Authorization` minus the `Bearer ` prefix
//   - subProject ← `headers["X-Quack-Sub-Project"]`
// When `.mcp.json` is absent, has no `quack` entry, or is malformed JSON the
// reader silently returns null (the silent-disable invariant). It never
// surfaces `project_slug` — the server resolves the project from the token.

export interface HookConfig {
  serverUrl: string;
  token: string;
  subProject?: string;
  // Index signature: lets callers/tests treat a resolved config as a plain
  // record (e.g. to assert that `projectSlug` is absent — AC-55S220.5).
  [key: string]: unknown;
}

export interface ConfigDir {
  // Directory to begin the walk-up search for `.mcp.json` from.
  startDir: string;
}

const DEFAULT_SERVER_URL = "http://127.0.0.1:7474";

// Walk up from `startDir` to the filesystem root, returning the first
// `.mcp.json` path that exists, or null if none is found.
export function findMcpJson(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".mcp.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface McpQuackEntry {
  url?: unknown;
  headers?: Record<string, unknown>;
}

// Resolve config from a project-scoped `.mcp.json`. Returns null on any
// failure (absent / no `quack` entry / malformed JSON / missing fields).
export function resolveFromMcpJson(startDir: string): HookConfig | null {
  const file = findMcpJson(startDir);
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // malformed JSON / read failure ⇒ silent disable.
  }
  const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
  const quack = servers?.["quack"] as McpQuackEntry | undefined;
  if (!quack || typeof quack !== "object") return null;

  const url = typeof quack.url === "string" ? quack.url : undefined;
  const headers = quack.headers ?? {};
  const auth = typeof headers["Authorization"] === "string" ? (headers["Authorization"] as string) : undefined;
  if (!url || !auth) return null;

  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
  if (!token) return null;
  const serverUrl = url.endsWith("/mcp") ? url.slice(0, -"/mcp".length) : url;
  // Defense-in-depth: a hand-edited `.mcp.json` carrying a malformed
  // sub-project slug would otherwise be stamped onto every envelope and
  // 400-rejected by the server on every hook invocation. Drop a
  // non-conforming value (treat as absent) — symmetric with the server-side
  // add_memory `X-Quack-Sub-Project` header path (AC-A9BN0M.7).
  const subProjectRaw = headers["X-Quack-Sub-Project"];
  const subProject =
    typeof subProjectRaw === "string" && SUB_PROJECT_RE.test(subProjectRaw)
      ? subProjectRaw
      : undefined;

  return {
    serverUrl: serverUrl || DEFAULT_SERVER_URL,
    token,
    ...(subProject ? { subProject } : {}),
  };
}

// Resolve the hook configuration from a project-scoped `.mcp.json`, walking up
// from `startDir`. Returns null when no usable `quack` entry is found.
export function resolveConfig({ startDir }: ConfigDir): HookConfig | null {
  return resolveFromMcpJson(startDir);
}
