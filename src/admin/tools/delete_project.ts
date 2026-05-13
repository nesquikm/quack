import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { AdminToolError } from "../errors";
import { CONTROL_PROJECT_SLUG } from "../index";

export const deleteProjectSchema = z.object({
  slug: z.string().min(1),
});

export type DeleteProjectArgs = z.infer<typeof deleteProjectSchema>;

export interface DeleteProjectResult {
  deleted: true;
  cleanup_queued: number;
}

export function deleteProject(
  args: DeleteProjectArgs,
  _ctx: AuthContext,
  db: Database,
): DeleteProjectResult {
  if (args.slug === CONTROL_PROJECT_SLUG) {
    throw new AdminToolError("reserved_project");
  }
  const project = db
    .query<{ id: number }, [string]>("SELECT id FROM projects WHERE slug = ?")
    .get(args.slug);
  if (!project) throw new AdminToolError("not_found");

  let cleanupId = 0;
  db.transaction(() => {
    db.run("DELETE FROM projects WHERE id = ?", [project.id]);
    // FR-EDXH3X AC.1: pending_cleanup.ref carries the integer project_id as
    // a string. The slug can't be looked up after the FK cascade above
    // deletes the row; the integer is the only stable handle to the
    // orphaned graph partition.
    const insert = db.run(
      "INSERT INTO pending_cleanup(kind, ref) VALUES ('project_graph_partition', ?)",
      [String(project.id)],
    );
    cleanupId = Number(insert.lastInsertRowid);
  })();

  return { deleted: true, cleanup_queued: cleanupId };
}
