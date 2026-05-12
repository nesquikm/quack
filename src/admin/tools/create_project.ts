import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "../../auth/middleware";
import { AdminToolError } from "../errors";
import { projectToDto, type ProjectDto, type ProjectRow } from "../dto";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const createProjectSchema = z.object({
  slug: z.string().regex(SLUG_RE, "slug must match /^[a-z0-9][a-z0-9_-]{0,62}$/"),
  display_name: z.string().min(1).max(128),
});

export type CreateProjectArgs = z.infer<typeof createProjectSchema>;

export function createProject(
  args: CreateProjectArgs,
  _ctx: AuthContext,
  db: Database,
): { project: ProjectDto } {
  if (args.slug.startsWith("_")) throw new AdminToolError("reserved_slug");

  const exists = db.query<{ id: number }, [string]>("SELECT id FROM projects WHERE slug = ?").get(args.slug);
  if (exists) throw new AdminToolError("project_exists");

  const insert = db.run(
    "INSERT INTO projects(slug, display_name) VALUES (?, ?)",
    [args.slug, args.display_name],
  );
  const row = db
    .query<ProjectRow, [number]>("SELECT id, slug, display_name, created_at FROM projects WHERE id = ?")
    .get(Number(insert.lastInsertRowid))!;
  return { project: projectToDto(row) };
}
