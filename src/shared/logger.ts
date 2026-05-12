export interface LogRecord {
  level: "info" | "warn" | "error";
  msg: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  redactValues?: Array<string | undefined>;
  sink?: (line: string) => void;
}

function stripAuthorization(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripAuthorization);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase() === "authorization") {
        out[k] = "[REDACTED]";
      } else {
        out[k] = stripAuthorization(v);
      }
    }
    return out;
  }
  return value;
}

function redactSecretValues(line: string, secrets: string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (!secret) continue;
    while (out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

export class Logger {
  private secrets: string[];
  private sink: (line: string) => void;
  private buffer: string[] = [];

  constructor(options: LoggerOptions = {}) {
    this.secrets = (options.redactValues ?? []).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    this.sink = options.sink ?? ((line) => console.log(line));
  }

  log(record: LogRecord): void {
    const sanitized = stripAuthorization(record) as LogRecord;
    let line = JSON.stringify(sanitized);
    line = redactSecretValues(line, this.secrets);
    this.buffer.push(line);
    this.sink(line);
  }

  info(msg: string, extra: Record<string, unknown> = {}): void {
    this.log({ level: "info", msg, ...extra });
  }

  warn(msg: string, extra: Record<string, unknown> = {}): void {
    this.log({ level: "warn", msg, ...extra });
  }

  error(msg: string, extra: Record<string, unknown> = {}): void {
    this.log({ level: "error", msg, ...extra });
  }

  getBuffer(): string[] {
    return [...this.buffer];
  }
}

export function createBufferLogger(redactValues: Array<string | undefined> = []): {
  logger: Logger;
  buffer: string[];
} {
  const buffer: string[] = [];
  const logger = new Logger({
    redactValues,
    sink: (line) => buffer.push(line),
  });
  return { logger, buffer };
}
