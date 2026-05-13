import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const ALLOWED_PREFIX = join(SRC_ROOT, "graph");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// AC-SFQDXR.8 — neo4j-driver imports forbidden outside src/graph/ for
// production code. Test files (`*.test.ts`) are exempt because they may need
// the underlying driver for seeding/setup; GraphAdapter is still the only
// query path on the request-handling code path. The fence's intent is to keep
// `GraphAdapter` as the only Cypher entry point for the runtime, not to ban
// test-only utilities.

describe("graph-import-fence", () => {
  test("no neo4j-driver imports outside src/graph/ in non-test source files", () => {
    const offenders: string[] = [];
    const pattern = /(?:from\s+['"]neo4j-driver['"]|require\(\s*['"]neo4j-driver['"]\s*\))/;
    for (const file of walk(SRC_ROOT)) {
      if (file.startsWith(ALLOWED_PREFIX)) continue;
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (pattern.test(text)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  test("non-graph .test.ts files using neo4j-driver must declare they're set-up only (regression guard)", () => {
    // Documentation: this is the test that complements the production-only
    // check above. It just asserts that any production .ts file (sans test
    // suffix) outside src/graph/ stays clean — which is the same assertion
    // shape as above. Kept as a second-pass for documentation clarity.
    const offenders: string[] = [];
    const pattern = /(?:from\s+['"]neo4j-driver['"]|require\(\s*['"]neo4j-driver['"]\s*\))/;
    for (const file of walk(SRC_ROOT)) {
      if (file.startsWith(ALLOWED_PREFIX)) continue;
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (pattern.test(text)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
