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

// AC-SFQDXR.8 — neo4j-driver imports forbidden outside src/graph/.
// Grep matches both `from "neo4j-driver"` and `from 'neo4j-driver'` plus
// `require("neo4j-driver")`. Test files inside src/graph/ are allowed since
// they're part of the graph module's own tests.

describe("graph-import-fence", () => {
  test("no neo4j-driver imports outside src/graph/", () => {
    const offenders: string[] = [];
    const pattern = /(?:from\s+['"]neo4j-driver['"]|require\(\s*['"]neo4j-driver['"]\s*\))/;
    for (const file of walk(SRC_ROOT)) {
      if (file.startsWith(ALLOWED_PREFIX)) continue;
      const text = readFileSync(file, "utf8");
      if (pattern.test(text)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
