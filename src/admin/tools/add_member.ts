import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { generateToken, hashToken } from "../../auth/tokens";
import { AdminToolError } from "../errors";

export const addMemberSchema = z.object({
  username: z.string().min(1),
  project_slug: z.string().min(1),
  role: z.enum(["admin", "member"]),
});

export type AddMemberArgs = z.infer<typeof addMemberSchema>;

export interface AddMemberResult {
  membership: { user_id: number; project_id: number; role: "admin" | "member" };
  token: string;
}

export function addMember(
  args: AddMemberArgs,
  _ctx: AuthContext,
  db: Database,
): AddMemberResult {
  const user = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(args.username);
  if (!user) throw new AdminToolError("not_found");
  const project = db
    .query<{ id: number }, [string]>("SELECT id FROM projects WHERE slug = ?")
    .get(args.project_slug);
  if (!project) throw new AdminToolError("not_found");

  const existing = db
    .query<{ user_id: number }, [number, number]>(
      "SELECT user_id FROM project_members WHERE user_id = ? AND project_id = ?",
    )
    .get(user.id, project.id);
  if (existing) throw new AdminToolError("already_member");

  const plaintext = generateToken();
  const tokenHash = hashToken(plaintext);

  db.transaction(() => {
    db.run(
      "INSERT INTO project_members(user_id, project_id, role) VALUES (?, ?, ?)",
      [user.id, project.id, args.role],
    );
    db.run(
      "INSERT INTO tokens(token_hash, user_id, project_id) VALUES (?, ?, ?)",
      [tokenHash, user.id, project.id],
    );
  })();

  return {
    membership: { user_id: user.id, project_id: project.id, role: args.role },
    token: plaintext,
  };
}
