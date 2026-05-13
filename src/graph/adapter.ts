import neo4j, { type Driver, type Integer } from "neo4j-driver";
import { incrementError } from "../metrics/counters";
import type { AuthContext } from "../auth/middleware";
import { TEMPLATE_REGISTRY } from "./templates/index";
import { UnknownTemplateError } from "./errors";
import type { CypherTemplate, QueryResult, TemplateRegistry } from "./types";

// Coerce whole-number JS numbers to Neo4j Integer values. Cypher expects
// INTEGER for LIMIT / range params; raw JS floats trigger
// "Expected ... INTEGER ... found 20.0". Walk the param tree once at the
// adapter boundary so individual templates don't repeat the wrapping.
function toCypherParam(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isInteger(value) ? neo4j.int(value) : value;
  }
  if (Array.isArray(value)) return value.map(toCypherParam);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toCypherParam(v);
    return out;
  }
  return value;
}

// Reverse: unwrap Neo4j Integer back to plain JS number when safe. Used by
// the row mapper so callers don't have to know about Integer.
function fromCypherValue(value: unknown): unknown {
  if (value && typeof value === "object" && "low" in value && "high" in value) {
    const asInt = value as Integer;
    if (asInt.high === 0 || asInt.high === -1) return asInt.toNumber();
    // Large numbers stay as Integer to avoid silent precision loss.
    return asInt.toString();
  }
  if (Array.isArray(value)) return value.map(fromCypherValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fromCypherValue(v);
    return out;
  }
  return value;
}

export interface GraphAdapter {
  run<TParams, TResult>(
    templateId: string,
    params: TParams,
    ctx: AuthContext,
  ): Promise<QueryResult<TResult>>;
}

function neo4jRowToObject(record: { toObject(): Record<string, unknown> }): Record<string, unknown> {
  return record.toObject();
}

export class Neo4jGraphAdapter implements GraphAdapter {
  constructor(
    private readonly driver: Driver,
    private readonly registry: TemplateRegistry = TEMPLATE_REGISTRY,
  ) {}

  async run<TParams, TResult>(
    templateId: string,
    params: TParams,
    ctx: AuthContext,
  ): Promise<QueryResult<TResult>> {
    const tpl = this.registry[templateId] as CypherTemplate<TParams, TResult> | undefined;
    if (!tpl) throw new UnknownTemplateError(templateId);
    // Validate params via the template's Zod schema. We override project_id below
    // regardless — caller-supplied project_id is silently replaced by ctx.project_id
    // for defense-in-depth (AC-SFQDXR.4).
    const parsedParams = tpl.paramSchema.parse(params) as Record<string, unknown>;
    const finalParams: Record<string, unknown> = toCypherParam({
      ...parsedParams,
      project_id: ctx.project_id,
    }) as Record<string, unknown>;

    const accessMode = tpl.accessMode === "READ" ? neo4j.session.READ : neo4j.session.WRITE;
    const session = this.driver.session({ database: "neo4j", defaultAccessMode: accessMode });
    try {
      const result = await session.run(tpl.cypher, finalParams);
      const rows = result.records.map((r) => {
        const raw = neo4jRowToObject(r);
        const obj = fromCypherValue(raw) as Record<string, unknown>;
        return (tpl.mapRow ? tpl.mapRow(obj) : (obj as unknown as TResult));
      });
      return { rows };
    } catch (err) {
      incrementError("db_error");
      throw err;
    } finally {
      await session.close();
    }
  }
}
