import { registerUserSchema, registerUser } from "../admin/tools/register_user";
import { removeUserSchema, removeUser } from "../admin/tools/remove_user";
import { createProjectSchema, createProject } from "../admin/tools/create_project";
import { deleteProjectSchema, deleteProject } from "../admin/tools/delete_project";
import { addMemberSchema, addMember } from "../admin/tools/add_member";
import { removeMemberSchema, removeMember } from "../admin/tools/remove_member";
import { revokeTokenSchema, revokeToken } from "../admin/tools/revoke_token";
import { listProjectsSchema, listProjects } from "../admin/tools/list_projects";
import { listUsersSchema, listUsers } from "../admin/tools/list_users";
import { serverStatusSchema, serverStatus } from "../admin/tools/server_status";
import type { ToolDef } from "./dispatch";

export function buildToolRegistry(): Map<string, ToolDef> {
  const m = new Map<string, ToolDef>();
  m.set("register_user", { name: "register_user", schema: registerUserSchema, handler: registerUser as ToolDef["handler"] });
  m.set("remove_user", { name: "remove_user", schema: removeUserSchema, handler: removeUser as ToolDef["handler"] });
  m.set("create_project", { name: "create_project", schema: createProjectSchema, handler: createProject as ToolDef["handler"] });
  m.set("delete_project", { name: "delete_project", schema: deleteProjectSchema, handler: deleteProject as ToolDef["handler"] });
  m.set("add_member", { name: "add_member", schema: addMemberSchema, handler: addMember as ToolDef["handler"] });
  m.set("remove_member", { name: "remove_member", schema: removeMemberSchema, handler: removeMember as ToolDef["handler"] });
  m.set("revoke_token", { name: "revoke_token", schema: revokeTokenSchema, handler: revokeToken as ToolDef["handler"] });
  m.set("list_projects", { name: "list_projects", schema: listProjectsSchema, handler: listProjects as ToolDef["handler"] });
  m.set("list_users", { name: "list_users", schema: listUsersSchema, handler: listUsers as ToolDef["handler"] });
  m.set("server_status", { name: "server_status", schema: serverStatusSchema, handler: serverStatus as ToolDef["handler"] });
  return m;
}
