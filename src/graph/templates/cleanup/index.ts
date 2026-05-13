import { registerTemplate } from "../index";
import { dropProjectBatchTemplate } from "./drop_project_batch";

let registered = false;
export function registerCleanupTemplates(): void {
  if (registered) return;
  registerTemplate(dropProjectBatchTemplate);
  registered = true;
}
