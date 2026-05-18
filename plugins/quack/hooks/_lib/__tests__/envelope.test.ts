import { describe, test, expect } from "bun:test";
import { HookEnvelopeSchema } from "../shared/envelope";

// AC-A9BN0M.1 / AC-A9BN0M.9 — HookEnvelope gains an optional `sub_project`
// field, Zod-validated against the project-slug regex
// `^[a-z0-9][a-z0-9_-]{0,62}$`. Absent is valid; present-but-malformed fails
// the parse (the ingest handler turns that into a 400 — see handler.test.ts).

describe("AC-A9BN0M.1 — HookEnvelope.sub_project", () => {
  test("absent sub_project is valid (M3/M4-era hook clients)", () => {
    const parsed = HookEnvelopeSchema.safeParse({ kind: "stop", payload: {} });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sub_project).toBeUndefined();
    }
  });

  test("slug-shaped sub_project is accepted and survives the parse", () => {
    const parsed = HookEnvelopeSchema.safeParse({
      kind: "stop",
      payload: {},
      sub_project: "backend-api",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sub_project).toBe("backend-api");
    }
  });

  test("single-char and underscore/digit slug forms are accepted", () => {
    for (const slug of ["a", "0", "x_y", "a1-b2_c3", "z".repeat(63)]) {
      const parsed = HookEnvelopeSchema.safeParse({
        kind: "stop",
        payload: {},
        sub_project: slug,
      });
      expect(parsed.success, `slug "${slug}" should be accepted`).toBe(true);
    }
  });

  test("malformed sub_project is rejected with issue path ['sub_project']", () => {
    // Uppercase, leading hyphen, dot, space, empty, and over-length all fail.
    for (const bad of ["", "Backend", "-leading", "has space", "dot.dot", "z".repeat(64)]) {
      const parsed = HookEnvelopeSchema.safeParse({
        kind: "stop",
        payload: {},
        sub_project: bad,
      });
      expect(parsed.success, `slug "${bad}" should be rejected`).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path).toContain("sub_project");
      }
    }
  });

  test("the full envelope shape is { kind, payload, project_slug?, sub_project?, ts? }", () => {
    const parsed = HookEnvelopeSchema.safeParse({
      kind: "session_start",
      payload: { x: 1 },
      project_slug: "my-project",
      sub_project: "frontend",
      ts: "2026-05-18T00:00:00Z",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sub_project).toBe("frontend");
      expect(parsed.data.project_slug).toBe("my-project");
    }
  });
});
