import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { AdminToolError } from "../errors";
import { CONTROL_PROJECT_SLUG } from "../index";

export const removeMemberSchema = z.object({
  username: z.string().min(1),
  project_slug: z.string().min(1),
});

export type RemoveMemberArgs = z.infer<typeof removeMemberSchema>;

export interface RemoveMemberResult {
  removed: true;
  tokens_revoked: number;
}

export function removeMember(
  args: RemoveMemberArgs,
  _ctx: AuthContext,
  db: Database,
): RemoveMemberResult {
  const user = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(args.username);
  if (!user) throw new AdminToolError("not_found");
  const project = db
    .query<{ id: number }, [string]>("SELECT id FROM projects WHERE slug = ?")
    .get(args.project_slug);
  if (!project) throw new AdminToolError("not_found");

  const membership = db
    .query<{ role: string }, [number, number]>(
      "SELECT role FROM project_members WHERE user_id = ? AND project_id = ?",
    )
    .get(user.id, project.id);
  if (!membership) throw new AdminToolError("not_found");

  if (args.project_slug === CONTROL_PROJECT_SLUG && membership.role === "admin") {
    const controlAdmins = db
      .query<{ c: number }, [number]>(
        "SELECT COUNT(*) as c FROM project_members WHERE project_id = ? AND role = 'admin'",
      )
      .get(project.id);
    if ((controlAdmins?.c ?? 0) <= 1) {
      throw new AdminToolError("cannot_remove_last_control_admin");
    }
  }

  let revoked = 0;
  db.transaction(() => {
    const update = db.run(
      "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND project_id = ? AND revoked_at IS NULL",
      [user.id, project.id],
    );
    revoked = update.changes;
    db.run(
      "DELETE FROM project_members WHERE user_id = ? AND project_id = ?",
      [user.id, project.id],
    );
  })();

  return { removed: true, tokens_revoked: revoked };
}
