import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { userToDto, type UserDto, type UserRow } from "../dto";

export const listUsersSchema = z.object({}).strict();

export function listUsers(
  _args: unknown,
  _ctx: AuthContext,
  db: Database,
): { users: UserDto[] } {
  const rows = db
    .query<UserRow, []>("SELECT id, username, role, created_at FROM users ORDER BY id")
    .all();
  return { users: rows.map(userToDto) };
}
