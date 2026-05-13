// Coverage signals + warnings on every memory tool response. Lets the caller
// (Claude Code) detect weak retrievals — empty full-text hits, blown caps,
// missing paths — instead of confidently synthesizing junk.

export interface CoverageSignals {
  matched_entities: number;
  traversals: number;
  truncated: boolean;
}

export interface MemoryEnvelope<T> {
  results: T[];
  meta: {
    mode_used: "templates";
    coverage: CoverageSignals;
    warnings: string[];
    explain?: { template_ids: string[]; ranking_factors: Record<string, number> };
  };
}

export type Warning =
  | "depth_3_blowup_likely"
  | "no_full_text_match"
  | "no_path_found";

export function buildEnvelope<T>(
  results: T[],
  coverage: CoverageSignals,
  warnings: string[] = [],
  explain?: { template_ids: string[]; ranking_factors: Record<string, number> },
): MemoryEnvelope<T> {
  return {
    results,
    meta: {
      mode_used: "templates",
      coverage,
      warnings,
      ...(explain ? { explain } : {}),
    },
  };
}
