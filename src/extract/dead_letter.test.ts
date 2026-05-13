import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeadLetterWriter } from "./dead_letter";

function makeWriter(maxBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "quack-dl-"));
  const path = join(dir, "dead-letters.jsonl");
  return { writer: createDeadLetterWriter(path, maxBytes), dir, path };
}

describe("createDeadLetterWriter", () => {
  test("appends one JSONL line per entry", () => {
    const { writer, path } = makeWriter(1024 * 1024);
    writer.append({ ts: "2026-05-13T10:00:00Z", hook_kind: "stop", project_id: 1, error: { kind: "zod", message: "x" } });
    writer.append({ ts: "2026-05-13T10:00:01Z", hook_kind: "stop", project_id: 1, error: { kind: "zod", message: "y" } });
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).error.message).toBe("x");
  });

  test("rotates when size exceeds maxBytes", () => {
    const { writer, dir, path } = makeWriter(200);
    // Two entries to push past the small cap.
    for (let i = 0; i < 5; i++) {
      writer.append({
        ts: `2026-05-13T10:00:0${i}Z`,
        hook_kind: "stop",
        project_id: 1,
        error: { kind: "zod", message: "x".repeat(40) },
      });
    }
    const files = readdirSync(dir).filter((f) => f.startsWith("dead-letters"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    // Active file is the named one (re-opens).
    expect(statSync(path).size).toBeGreaterThan(0);
  });
});
