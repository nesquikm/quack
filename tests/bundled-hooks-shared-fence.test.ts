import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// AC-44QGKH.10 — HookEnvelope type + redaction_patterns constant move into
// plugins/quack/hooks/_lib/shared/. Server-side handlers import the wire
// shape from the plugin (the writer owns the format), not the other way
// around. This is a deliberate inversion of the previous "server owns,
// plugin imports" arrangement.

const REPO_ROOT = join(import.meta.dir, "..");
const SHARED_DIR = join(REPO_ROOT, "plugins/quack/hooks/_lib/shared");

describe("AC-44QGKH.10 — shared envelope + redaction_patterns live in the plugin tree", () => {
  test("plugins/quack/hooks/_lib/shared/envelope.ts exists", () => {
    expect(existsSync(join(SHARED_DIR, "envelope.ts"))).toBe(true);
  });

  test("plugins/quack/hooks/_lib/shared/redaction_patterns.ts exists", () => {
    expect(existsSync(join(SHARED_DIR, "redaction_patterns.ts"))).toBe(true);
  });

  test("envelope.ts exports the HookEnvelope type (canonical wire shape)", async () => {
    const mod = (await import(join(SHARED_DIR, "envelope.ts"))) as Record<string, unknown>;
    // Either a runtime value (Zod schema) or a re-export of the schema —
    // at minimum HookEnvelopeSchema must be present so the server can
    // validate envelopes against the plugin-owned shape.
    const hasSchema =
      Object.prototype.hasOwnProperty.call(mod, "HookEnvelopeSchema") ||
      Object.prototype.hasOwnProperty.call(mod, "HookKindSchema");
    expect(hasSchema, `envelope.ts must export HookEnvelopeSchema / HookKindSchema; got keys: ${Object.keys(mod).join(", ")}`).toBe(true);
  });

  test("redaction_patterns.ts exports DEFAULT_REDACTION_PATTERNS + helpers", async () => {
    const mod = (await import(join(SHARED_DIR, "redaction_patterns.ts"))) as Record<string, unknown>;
    expect(mod["DEFAULT_REDACTION_PATTERNS"]).toBeDefined();
    expect(mod["REDACTION_REPLACEMENT"]).toBe("«REDACTED»");
    expect(typeof mod["compilePatterns"]).toBe("function");
    expect(typeof mod["parseExtraPatternsFromEnv"]).toBe("function");
  });

  test("server-side src/ingest/handler.ts imports HookEnvelope from the plugin", () => {
    const body = readFileSync(join(REPO_ROOT, "src/ingest/handler.ts"), "utf8");
    // The canonical wire shape now lives where the writer lives. The
    // handler imports from a path inside plugins/quack/hooks/_lib/shared/.
    expect(body).toMatch(/plugins\/quack\/hooks\/_lib\/shared\/envelope/);
  });

  test("server-side src/extract/redact.ts imports redaction_patterns from the plugin", () => {
    const body = readFileSync(join(REPO_ROOT, "src/extract/redact.ts"), "utf8");
    expect(body).toMatch(/plugins\/quack\/hooks\/_lib\/shared\/redaction_patterns/);
  });

  test("the old src/shared/redaction_patterns.ts is gone (no duplicate source of truth)", () => {
    expect(existsSync(join(REPO_ROOT, "src/shared/redaction_patterns.ts"))).toBe(false);
  });
});
