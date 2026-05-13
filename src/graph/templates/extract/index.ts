import { registerTemplate } from "../index";
import { upsertEntityTemplate } from "./upsert_entity";
import { upsertDecisionTemplate } from "./upsert_decision";
import { upsertFileTemplate } from "./upsert_file";
import { upsertSymbolTemplate } from "./upsert_symbol";
import { upsertFeedbackTemplate } from "./upsert_feedback";
import { upsertRelationTemplate } from "./upsert_relation";

let registered = false;

export function registerExtractTemplates(): void {
  if (registered) return;
  registerTemplate(upsertEntityTemplate);
  registerTemplate(upsertDecisionTemplate);
  registerTemplate(upsertFileTemplate);
  registerTemplate(upsertSymbolTemplate);
  registerTemplate(upsertFeedbackTemplate);
  registerTemplate(upsertRelationTemplate);
  registered = true;
}
