export interface UserRow {
  id: number;
  username: string;
  role: "admin" | "member";
  created_at: string;
}

export interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  created_at: string;
}

export interface MembershipRow {
  user_id: number;
  project_id: number;
  role: "admin" | "member";
}

export interface TokenRow {
  id: number;
  user_id: number;
  project_id: number;
  created_at: string;
  revoked_at: string | null;
}

export interface UserDto {
  id: number;
  username: string;
  role: "admin" | "member";
  created_at: string;
}

export interface ProjectDto {
  id: number;
  slug: string;
  display_name: string;
  created_at: string;
}

export interface MembershipDto {
  user_id: number;
  project_id: number;
  role: "admin" | "member";
}

export interface TokenDto {
  id: number;
  user_id: number;
  project_id: number;
  created_at: string;
  revoked: boolean;
}

export function userToDto(row: UserRow): UserDto {
  return { id: row.id, username: row.username, role: row.role, created_at: row.created_at };
}

export function projectToDto(row: ProjectRow): ProjectDto {
  return { id: row.id, slug: row.slug, display_name: row.display_name, created_at: row.created_at };
}

export function membershipToDto(row: MembershipRow): MembershipDto {
  return { user_id: row.user_id, project_id: row.project_id, role: row.role };
}

export function tokenToDto(row: TokenRow): TokenDto {
  return {
    id: row.id,
    user_id: row.user_id,
    project_id: row.project_id,
    created_at: row.created_at,
    revoked: row.revoked_at !== null,
  };
}
