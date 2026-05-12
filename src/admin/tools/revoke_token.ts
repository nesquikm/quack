import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { AdminToolError } from "../errors";

export const revokeTokenSchema = z.object({
  token_id: z.number().int().positive(),
});

export type RevokeTokenArgs = z.infer<typeof revokeTokenSchema>;

export function revokeToken(
  args: RevokeTokenArgs,
  _ctx: AuthContext,
  db: Database,
): { revoked: true } {
  const result = db.run(
    "UPDATE tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
    [args.token_id],
  );
  if (result.changes === 0) throw new AdminToolError("not_found");
  return { revoked: true };
}
