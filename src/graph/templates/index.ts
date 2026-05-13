import type { CypherTemplate, TemplateRegistry } from "../types";
import { TemplateRegistryError } from "../errors";

// Templates are registered here. Subsequent FRs (DPY5GQ, 4NY6S1, EDXH3X) add their templates.
// Order: identity object; values are individual `CypherTemplate` records.
export const TEMPLATE_REGISTRY: TemplateRegistry = {};

export function registerTemplate(template: CypherTemplate): void {
  if (TEMPLATE_REGISTRY[template.id]) {
    throw new TemplateRegistryError(template.id, "duplicate template id");
  }
  TEMPLATE_REGISTRY[template.id] = template;
}

// Validates that every registered template either contains the substring
// "$project_id" in its cypher source OR is explicitly marked tenancyExempt.
// Exempt templates emit an audit line so operators can grep for them.
export function validateTemplateRegistry(
  registry: TemplateRegistry = TEMPLATE_REGISTRY,
  audit: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
): void {
  for (const tpl of Object.values(registry)) {
    if (tpl.tenancyExempt) {
      audit(`graph.template.tenancyExempt id=${tpl.id}`);
      continue;
    }
    if (!tpl.cypher.includes("$project_id")) {
      throw new TemplateRegistryError(
        tpl.id,
        "cypher must reference $project_id or template must set tenancyExempt: true",
      );
    }
  }
}
