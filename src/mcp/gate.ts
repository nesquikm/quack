import { ADMIN_TOOLS } from "../admin/index";
import { incrementError } from "../metrics/counters";
import type { AuthContext } from "../auth/middleware";

export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function applyAdminGate(toolName: string, ctx: AuthContext): void {
  if (ADMIN_TOOLS.has(toolName) && ctx.role !== "admin") {
    incrementError("admin_403");
    throw new ForbiddenError();
  }
}
