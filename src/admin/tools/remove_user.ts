import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { AdminToolError } from "../errors";

export const removeUserSchema = z.object({
  username: z.string().min(1),
});

export type RemoveUserArgs = z.infer<typeof removeUserSchema>;

export interface RemoveUserResult {
  deleted: true;
}

export function removeUser(
  args: RemoveUserArgs,
  ctx: AuthContext,
  db: Database,
): RemoveUserResult {
  const user = db
    .query<{ id: number; role: string }, [string]>("SELECT id, role FROM users WHERE username = ?")
    .get(args.username);
  if (!user) throw new AdminToolError("not_found");
  if (user.id === ctx.user_id) throw new AdminToolError("cannot_remove_self");

  if (user.role === "admin") {
    const admins = db
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM users WHERE role = 'admin'")
      .get();
    if ((admins?.c ?? 0) <= 1) throw new AdminToolError("cannot_remove_last_admin");
  }

  db.run("DELETE FROM users WHERE id = ?", [user.id]);
  return { deleted: true };
}
