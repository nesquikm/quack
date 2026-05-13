import neo4j, { type Driver } from "neo4j-driver";
import { incrementError } from "../metrics/counters";
import type { AuthContext } from "../auth/middleware";
import { TEMPLATE_REGISTRY } from "./templates/index";
import { UnknownTemplateError } from "./errors";
import type { CypherTemplate, QueryResult, TemplateRegistry } from "./types";

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
    const finalParams: Record<string, unknown> = { ...parsedParams, project_id: ctx.project_id };

    const accessMode = tpl.accessMode === "READ" ? neo4j.session.READ : neo4j.session.WRITE;
    const session = this.driver.session({ database: "neo4j", defaultAccessMode: accessMode });
    try {
      const result = await session.run(tpl.cypher, finalParams);
      const rows = result.records.map((r) => {
        const obj = neo4jRowToObject(r);
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
