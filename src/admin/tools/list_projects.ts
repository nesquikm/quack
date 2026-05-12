import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { projectToDto, type ProjectDto, type ProjectRow } from "../dto";

export const listProjectsSchema = z.object({}).strict();

export function listProjects(
  _args: unknown,
  ctx: AuthContext,
  db: Database,
): { projects: ProjectDto[] } {
  if (ctx.role === "admin") {
    const rows = db
      .query<ProjectRow, []>("SELECT id, slug, display_name, created_at FROM projects ORDER BY id")
      .all();
    return { projects: rows.map(projectToDto) };
  }
  const rows = db
    .query<ProjectRow, [number]>(
      `SELECT p.id as id, p.slug as slug, p.display_name as display_name, p.created_at as created_at
       FROM projects p
       JOIN project_members m ON m.project_id = p.id
       WHERE m.user_id = ?
       ORDER BY p.id`,
    )
    .all(ctx.user_id);
  return { projects: rows.map(projectToDto) };
}
