import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { getSnapshot, getStartedAt } from "../../metrics/counters";
import packageJson from "../../../package.json" with { type: "json" };

const SERVER_VERSION = (packageJson as { version: string }).version;

export const serverStatusSchema = z.object({}).strict();

export interface ServerStatusResponse {
  version: "v1";
  uptime_seconds: number;
  queue: {
    depth: number | null;
    oldest_pending_age_seconds: number | null;
    accepted_total: number | null;
    dropped_full_total: number | null;
  };
  errors: {
    since_boot_total: number;
    by_category: Record<string, number>;
  };
  counts: {
    users: number;
    projects: number;
    tokens_active: number;
    server_version: string;
  };
}

export function serverStatus(
  _args: unknown,
  _ctx: AuthContext,
  db: Database,
): ServerStatusResponse {
  const snapshot = getSnapshot();
  const users = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM users").get();
  const projects = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM projects").get();
  const tokensActive = db
    .query<{ c: number }, []>("SELECT COUNT(*) as c FROM tokens WHERE revoked_at IS NULL")
    .get();

  return {
    version: "v1",
    uptime_seconds: Math.floor((Date.now() - getStartedAt()) / 1000),
    queue: snapshot.queue,
    errors: snapshot.errors,
    counts: {
      users: users?.c ?? 0,
      projects: projects?.c ?? 0,
      tokens_active: tokensActive?.c ?? 0,
      server_version: SERVER_VERSION,
    },
  };
}
