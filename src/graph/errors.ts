export class UnknownTemplateError extends Error {
  constructor(templateId: string) {
    super(`Unknown template id: ${templateId}`);
    this.name = "UnknownTemplateError";
  }
}

export class TemplateRegistryError extends Error {
  readonly templateId: string;
  constructor(templateId: string, message: string) {
    super(`Template ${templateId}: ${message}`);
    this.name = "TemplateRegistryError";
    this.templateId = templateId;
  }
}

export class GraphConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GraphConnectionError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
