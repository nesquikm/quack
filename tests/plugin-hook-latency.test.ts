import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// AC-44QGKH.7 — cold-start latency probe.
//
// Spawns each of the three plugin hook shims 10× with a representative
// fixture stdin payload (sourced from tests/fixtures/hook-payloads/) and
// asserts p95 < 500 ms. Skips when `bunx` is not on PATH.
//
// Latency cap rationale (also documented in specs/frs/44QGKH.md §Notes):
// requirements.md NFR-1 sets < 200 ms for the fire-and-forget enqueue path,
// but that governs the *warm* path. Cold-start `bunx --bun` legitimately
// adds 80–150 ms on macOS / ~40 ms on Linux on the first fire of a session.
// The 500 ms cap absorbs that without weakening the warm-path NFR. If this
// cap fires regularly in practice, the brainstorm's option 4 (precompiled
// binary fallback) is the documented exit ramp.

const REPO_ROOT = join(import.meta.dir, "..");
const HOOKS_DIR = join(REPO_ROOT, "plugins/quack/hooks");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/hook-payloads");
const BUNX_ON_PATH = Bun.which("bunx") !== null;

const HOOKS: ReadonlyArray<[string, string]> = [
  ["session_start.sh", "session_start.json"],
  ["stop.sh", "stop.json"],
  ["post_tool_use.sh", "post_tool_use.json"],
];

const SPAWN_COUNT = 10;
const P95_BUDGET_MS = 500;

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank p95: index ceil(0.95 * n) - 1, clamped to [0, n-1].
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx]!;
}

describe("AC-44QGKH.7 — plugin hook cold-start latency", () => {
  test("fixtures exist for each hook kind", () => {
    for (const [, fixture] of HOOKS) {
      const path = join(FIXTURES_DIR, fixture);
      expect(existsSync(path), `missing fixture: ${path}`).toBe(true);
    }
  });

  for (const [shim, fixture] of HOOKS) {
    test.skipIf(!BUNX_ON_PATH)(
      `${shim} cold-start p95 < ${P95_BUDGET_MS} ms over ${SPAWN_COUNT} spawns`,
      async () => {
        const shimPath = join(HOOKS_DIR, shim);
        const payload = readFileSync(join(FIXTURES_DIR, fixture), "utf8");
        // Preamble: the latency probe is only meaningful if the shim
        // actually exec's `bunx --bun ${CLAUDE_PLUGIN_ROOT}/...`. If the
        // shim still wraps the deleted `quack-hook` binary, every spawn
        // hits silent-disable and the cold-start budget is trivially
        // satisfied — that would be a fake PASS.
        const shimBody = readFileSync(shimPath, "utf8");
        expect(
          shimBody.includes("bunx --bun"),
          `${shim} must exec 'bunx --bun ...' for the latency probe to measure the real cold-start path`,
        ).toBe(true);
        const samples: number[] = [];
        // Track stderr across the run so we can assert the bunx path was
        // *actually exercised* — silent-disable + exit-0 would pass the
        // latency budget trivially but defeat the purpose of the probe.
        const stderrSamples: string[] = [];

        for (let i = 0; i < SPAWN_COUNT; i += 1) {
          const t0 = performance.now();
          // The shim must exit 0 even without QUACK_TOKEN — silent-disable
          // is the contract. We are timing process spawn + bunx warm-up +
          // entry file load + silent-exit; we are NOT timing a real
          // network POST. Hence no QUACK_TOKEN here.
          const proc = Bun.spawn(["bash", shimPath], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            // Strip QUACK_TOKEN from the env so the entry file hits the
            // silent-disable path deterministically — independent of the
            // developer's shell setup.
            env: {
              ...Bun.env,
              QUACK_TOKEN: "",
              QUACK_PROJECT_SLUG: "",
            },
          });
          proc.stdin?.write(payload);
          await proc.stdin?.end();
          const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
          const elapsed = performance.now() - t0;
          // Silent-disable invariant — exit must be 0 even with no token.
          expect(code, `${shim} exited non-zero on spawn ${i}`).toBe(0);
          samples.push(elapsed);
          stderrSamples.push(stderr);
        }

        // Cold-start budget.
        const observed = p95(samples);
        expect(
          observed,
          `${shim} cold-start p95 = ${observed.toFixed(1)} ms exceeds budget ${P95_BUDGET_MS} ms (samples: ${samples
            .map((s) => s.toFixed(0))
            .join(", ")})`,
        ).toBeLessThan(P95_BUDGET_MS);

        // The probe must exercise the bunx path — NOT the silent-disable
        // branch. If every spawn printed "bunx not found" we'd be timing a
        // shell-level no-op, which would still come in under 500 ms and
        // fake a PASS. Detect that and fail explicitly.
        const silentDisableRuns = stderrSamples.filter((s) =>
          s.includes("[quack-hook plugin] bunx not found"),
        ).length;
        expect(
          silentDisableRuns,
          `${shim} hit the silent-disable branch on ${silentDisableRuns}/${SPAWN_COUNT} spawns — the latency probe must exercise the real bunx path`,
        ).toBe(0);
      },
      120_000,
    );
  }
});
