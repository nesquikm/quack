// canonicalizeName — lowercase ASCII; preserve `[a-z0-9 _\-.]`; strip
// everything else; collapse whitespace runs.
//
// Used by the writer before MERGE so the natural key (name) is stable across
// extractor invocations with cosmetic variation.

export function canonicalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 _\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Deduplicate aliases against the canonical name (case-insensitive). The
// resulting list excludes the canonical form and removes case-insensitive
// duplicates among aliases.
export function dedupeAliases(canonical: string, aliases: readonly string[]): string[] {
  const seen = new Set<string>([canonicalizeName(canonical)]);
  const out: string[] = [];
  for (const a of aliases) {
    const c = canonicalizeName(a);
    if (!c) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}
