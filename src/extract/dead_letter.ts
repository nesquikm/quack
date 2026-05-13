import { existsSync, statSync, appendFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Append-only JSONL writer with size-based rotation. Failed extractions
// dead-letter here; a follow-up FR could ship a replay tool, but v1's
// purpose is operator-visible debugging surface only.

export interface DeadLetterEntry {
  ts: string;
  hook_kind: string;
  project_id: number;
  error: { kind: string; message: string; model_response?: string };
}

export interface DeadLetterWriter {
  append(entry: DeadLetterEntry): void;
}

export function createDeadLetterWriter(filePath: string, maxBytes: number): DeadLetterWriter {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    append(entry: DeadLetterEntry): void {
      const line = JSON.stringify(entry) + "\n";
      const buf = Buffer.from(line, "utf8");
      // Rotate before write so the new line never causes a half-rotation.
      if (existsSync(filePath)) {
        const size = statSync(filePath).size;
        if (size + buf.byteLength > maxBytes) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const rotated = join(dirname(filePath), `dead-letters.${ts}.jsonl`);
          renameSync(filePath, rotated);
        }
      }
      appendFileSync(filePath, buf);
    },
  };
}
