import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// AC-44QGKH.9 / .12 / .13 — cleanup invariants after the move.
//
// .9  : src/hooks/, tests/hook-binary.test.ts, src/shared/redaction_patterns.ts
//       are deleted; package.json's `build:hook` script is removed;
//       .dockerignore's `dist/quack-hook` reference is removed.
// .12 : plugins/quack/README.md and the repo-root README install flows
//       drop the `bun run build:hook` + PATH steps and name Bun
//       (https://bun.sh) as the only host prerequisite.
// .13 : specs/requirements.md traceability — no AC-S2D0Z5 rows; all
//       AC-44QGKH.1..13 rows present, and every implementation file
//       referenced by the AC-44QGKH rows actually exists on disk.

const REPO_ROOT = join(import.meta.dir, "..");

describe("AC-44QGKH.9 — src/hooks/ and the binary build chain are deleted", () => {
  test("src/hooks/ directory does not exist", () => {
    expect(existsSync(join(REPO_ROOT, "src/hooks"))).toBe(false);
  });

  test.each([
    "src/hooks/quack-hook.ts",
    "src/hooks/dispatch.ts",
    "src/hooks/redact.ts",
    "src/hooks/post.ts",
    "src/hooks/config.ts",
    "src/hooks/init.ts",
    "src/hooks/dispatch.test.ts",
    "src/hooks/redact.test.ts",
    "src/hooks/post.test.ts",
    "src/hooks/config.test.ts",
    "src/hooks/init.test.ts",
    "src/hooks/quack-hook.test.ts",
  ])("%s is deleted", (rel) => {
    expect(existsSync(join(REPO_ROOT, rel)), `expected ${rel} to be deleted`).toBe(false);
  });

  test("tests/hook-binary.test.ts is deleted (binary no longer exists)", () => {
    expect(existsSync(join(REPO_ROOT, "tests/hook-binary.test.ts"))).toBe(false);
  });

  test("src/shared/redaction_patterns.ts is deleted (moved into plugin)", () => {
    expect(existsSync(join(REPO_ROOT, "src/shared/redaction_patterns.ts"))).toBe(false);
  });

  test("package.json no longer declares a build:hook script", () => {
    const raw = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    expect(pkg.scripts ?? {}).not.toHaveProperty("build:hook");
    // The substring check is a belt-and-suspenders guard against the script
    // being moved into a sub-object or commented back in.
    expect(raw).not.toContain("build:hook");
  });

  test(".dockerignore no longer mentions dist/quack-hook (still excludes dist/ blanket)", () => {
    const body = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    expect(body).not.toContain("dist/quack-hook");
    // The blanket dist/ exclusion must remain — both the build artifact
    // exclusion AND the hermeticity invariant depend on it.
    const lines = body.split("\n").map((s) => s.trim());
    expect(lines).toContain("dist/");
  });
});

describe("AC-44QGKH.12 — install-flow docs drop the binary + PATH steps", () => {
  test("plugins/quack/README.md removes `bun run build:hook` references", () => {
    const body = readFileSync(join(REPO_ROOT, "plugins/quack/README.md"), "utf8");
    expect(body).not.toContain("bun run build:hook");
    // The old `install -m 755 dist/quack-hook ...` step is dead.
    expect(body).not.toContain("install -m 755 dist/quack-hook");
  });

  test("plugins/quack/README.md names Bun (https://bun.sh) as a host prerequisite", () => {
    const body = readFileSync(join(REPO_ROOT, "plugins/quack/README.md"), "utf8");
    expect(body).toContain("https://bun.sh");
  });

  test("repo-root README.md removes the `bun run build:hook` step from the install flow", () => {
    const body = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(body).not.toContain("bun run build:hook");
    expect(body).not.toContain("install -m 755 dist/quack-hook");
  });

  test("repo-root README.md install flow keeps the marketplace + /quack:install steps", () => {
    const body = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(body).toContain("claude plugin marketplace add");
    expect(body).toContain("/quack:install");
  });
});

describe("AC-44QGKH.13 — specs/requirements.md traceability is refreshed", () => {
  test("no AC-S2D0Z5 rows remain (binary they reference no longer exists)", () => {
    const body = readFileSync(join(REPO_ROOT, "specs/requirements.md"), "utf8");
    expect(body).not.toContain("AC-S2D0Z5");
  });

  test("all 13 AC-44QGKH rows are present in the traceability matrix", () => {
    const body = readFileSync(join(REPO_ROOT, "specs/requirements.md"), "utf8");
    // Collect every AC-44QGKH reference, accepting both literal `.N` and
    // grouped ranges `.M–N` / `.M-N` so the matrix can stay terse without
    // dropping coverage.
    const literalSet = new Set<number>();
    for (const m of body.matchAll(/AC-44QGKH\.(\d+)/g)) {
      literalSet.add(Number(m[1]));
    }
    // Range form: `AC-44QGKH.M[-–]N` (hyphen or en-dash). Expand to all
    // integers in [M, N].
    for (const m of body.matchAll(/AC-44QGKH\.(\d+)[-–](\d+)/g)) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      for (let n = lo; n <= hi; n += 1) literalSet.add(n);
    }
    for (let n = 1; n <= 13; n += 1) {
      expect(literalSet.has(n), `AC-44QGKH.${n} missing from traceability matrix`).toBe(true);
    }
  });

  test("every plugin-tree path named by the AC-44QGKH traceability rows actually exists", () => {
    // The matrix rows point at concrete files. They lie if the files
    // aren't there — and the file move is the implementation of this FR.
    const required = [
      "plugins/quack/hooks/_lib/dispatch.ts",
      "plugins/quack/hooks/_lib/redact.ts",
      "plugins/quack/hooks/_lib/post.ts",
      "plugins/quack/hooks/_lib/config.ts",
      "plugins/quack/hooks/_lib/payload.ts",
      "plugins/quack/hooks/_lib/shared/envelope.ts",
      "plugins/quack/hooks/_lib/shared/redaction_patterns.ts",
      "plugins/quack/hooks/_lib/entry/session_start.ts",
      "plugins/quack/hooks/_lib/entry/stop.ts",
      "plugins/quack/hooks/_lib/entry/post_tool_use.ts",
    ];
    for (const rel of required) {
      expect(existsSync(join(REPO_ROOT, rel)), `traceability row references missing file: ${rel}`).toBe(true);
    }
  });
});
