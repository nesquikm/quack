import { Database } from "bun:sqlite";
import { hashToken } from "./tokens";

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface BootstrapEnv {
  QUACK_BOOTSTRAP_TOKEN?: string;
}

export const CONTROL_PROJECT_SLUG = "_control_";
export const CONTROL_PROJECT_DISPLAY_NAME = "Control Plane";

export function bootstrapAdmin(db: Database, env: BootstrapEnv): void {
  const row = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM users").get();
  if ((row?.c ?? 0) > 0) return;
  if (!env.QUACK_BOOTSTRAP_TOKEN) {
    throw new BootstrapError(
      "QUACK_BOOTSTRAP_TOKEN is required on first boot (users table is empty)",
    );
  }
  const tokenHash = hashToken(env.QUACK_BOOTSTRAP_TOKEN);
  db.transaction(() => {
    const userInsert = db.run("INSERT INTO users(username, role) VALUES ('admin', 'admin')");
    const userId = Number(userInsert.lastInsertRowid);
    const projectInsert = db.run(
      "INSERT INTO projects(slug, display_name) VALUES (?, ?)",
      [CONTROL_PROJECT_SLUG, CONTROL_PROJECT_DISPLAY_NAME],
    );
    const projectId = Number(projectInsert.lastInsertRowid);
    db.run(
      "INSERT INTO project_members(user_id, project_id, role) VALUES (?, ?, 'admin')",
      [userId, projectId],
    );
    db.run(
      "INSERT INTO tokens(token_hash, user_id, project_id) VALUES (?, ?, ?)",
      [tokenHash, userId, projectId],
    );
  })();
}
