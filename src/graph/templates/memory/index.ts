import { registerTemplate } from "../index";
import { searchMemoryTemplate, searchMemoryExpandTemplate } from "./search";
import { neighborsTemplate } from "./neighbors";
import { pathBetweenTemplate } from "./path";
import { recentDecisionsTemplate } from "./recent_decisions";

// Idempotent registration — safe to call from multiple bootstrap paths
// (test setup + production startup). registerTemplate throws on duplicate id,
// so guard with the registry-lookup before registering.
let registered = false;

export function registerMemoryTemplates(): void {
  if (registered) return;
  registerTemplate(searchMemoryTemplate);
  registerTemplate(searchMemoryExpandTemplate);
  registerTemplate(neighborsTemplate);
  registerTemplate(pathBetweenTemplate);
  registerTemplate(recentDecisionsTemplate);
  registered = true;
}
