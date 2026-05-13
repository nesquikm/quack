import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { validateTemplateRegistry } from "./index";
import { TemplateRegistryError } from "../errors";
import type { CypherTemplate, TemplateRegistry } from "../types";

function mkTpl(overrides: Partial<CypherTemplate> & { id: string; cypher: string }): CypherTemplate {
  return {
    paramSchema: z.object({}).loose(),
    accessMode: "READ",
    ...overrides,
  } as CypherTemplate;
}

describe("validateTemplateRegistry", () => {
  test("accepts a compliant template that references $project_id", () => {
    const reg: TemplateRegistry = {
      "memory.search": mkTpl({
        id: "memory.search",
        cypher: "MATCH (e:Entity {project_id: $project_id}) RETURN e",
      }),
    };
    const lines: string[] = [];
    expect(() => validateTemplateRegistry(reg, (m) => lines.push(m))).not.toThrow();
    expect(lines).toEqual([]);
  });

  test("rejects a template without $project_id and no tenancyExempt — names the id", () => {
    const reg: TemplateRegistry = {
      "memory.bad": mkTpl({ id: "memory.bad", cypher: "MATCH (e:Entity) RETURN e" }),
    };
    let err: unknown;
    try {
      validateTemplateRegistry(reg);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TemplateRegistryError);
    expect((err as TemplateRegistryError).templateId).toBe("memory.bad");
    expect(String((err as Error).message)).toContain("memory.bad");
  });

  test("accepts a tenancyExempt template even without $project_id; emits audit", () => {
    const reg: TemplateRegistry = {
      "ddl.create_index": mkTpl({
        id: "ddl.create_index",
        cypher: "CREATE INDEX entity_project_id IF NOT EXISTS FOR (n:Entity) ON (n.project_id)",
        tenancyExempt: true,
      }),
    };
    const lines: string[] = [];
    expect(() => validateTemplateRegistry(reg, (m) => lines.push(m))).not.toThrow();
    expect(lines.some((l) => l.includes("tenancyExempt") && l.includes("ddl.create_index"))).toBe(true);
  });

  test("empty registry is accepted (no templates to validate)", () => {
    expect(() => validateTemplateRegistry({})).not.toThrow();
  });
});
