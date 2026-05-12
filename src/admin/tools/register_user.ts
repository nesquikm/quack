import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { generateToken, hashToken } from "../../auth/tokens";
import { AdminToolError } from "../errors";
import { CONTROL_PROJECT_SLUG } from "../index";
import { userToDto, type UserRow } from "../dto";

export const registerUserSchema = z.object({
  username: z.string().min(1).max(64),
});

export type RegisterUserArgs = z.infer<typeof registerUserSchema>;

export interface RegisterUserResult {
  user: { id: number; username: string; role: "admin" | "member" };
  token: string;
}

export function registerUser(
  args: RegisterUserArgs,
  _ctx: AuthContext,
  db: Database,
): RegisterUserResult {
  const existing = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(args.username);
  if (existing) throw new AdminToolError("user_exists");

  const controlProject = db
    .query<{ id: number }, [string]>("SELECT id FROM projects WHERE slug = ?")
    .get(CONTROL_PROJECT_SLUG);
  if (!controlProject) throw new AdminToolError("control_project_missing");

  const plaintext = generateToken();
  const tokenHash = hashToken(plaintext);

  let userId = 0;
  db.transaction(() => {
    const userInsert = db.run(
      "INSERT INTO users(username, role) VALUES (?, 'member')",
      [args.username],
    );
    userId = Number(userInsert.lastInsertRowid);
    db.run(
      "INSERT INTO project_members(user_id, project_id, role) VALUES (?, ?, 'member')",
      [userId, controlProject.id],
    );
    db.run(
      "INSERT INTO tokens(token_hash, user_id, project_id) VALUES (?, ?, ?)",
      [tokenHash, userId, controlProject.id],
    );
  })();

  const userRow = db
    .query<UserRow, [number]>("SELECT id, username, role, created_at FROM users WHERE id = ?")
    .get(userId)!;
  const dto = userToDto(userRow);
  return {
    user: { id: dto.id, username: dto.username, role: dto.role },
    token: plaintext,
  };
}
