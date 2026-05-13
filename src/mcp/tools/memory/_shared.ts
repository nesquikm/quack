import { z } from "zod";
import type { GraphAdapter } from "../../../graph/adapter";
import type { AuthContext } from "../../../auth/middleware";
import { MemoryToolError, ERR_NOT_IMPLEMENTED_YET, ERR_NO_GRAPH_ADAPTER } from "../../errors";
import { buildEnvelope, type MemoryEnvelope } from "../../memory/coverage";

// Shared bits across the four memory tools:
//  - mode field (templates | planned; v1 rejects planned with not_implemented_yet)
//  - assertGraph helper
//  - envelope-building convenience

export const modeSchema = z.enum(["templates", "planned"]).optional().default("templates");

export function assertGraph(graph: GraphAdapter | undefined): asserts graph is GraphAdapter {
  if (!graph) {
    throw new MemoryToolError(
      ERR_NO_GRAPH_ADAPTER,
      "memory plane unavailable — server started with skipGraph",
    );
  }
}

export function checkMode(mode: "templates" | "planned"): void {
  if (mode === "planned") {
    throw new MemoryToolError(
      ERR_NOT_IMPLEMENTED_YET,
      "planner mode is a future security milestone — see FR-DPY5GQ Notes",
    );
  }
}

export type { AuthContext, MemoryEnvelope };
export { buildEnvelope };
