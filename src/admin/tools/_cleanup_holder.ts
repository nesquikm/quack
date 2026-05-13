import type { Sweeper } from "../../extract/cleanup_sweeper";

// Process-local sweeper reference. startServer registers the sweeper here
// so run_cleanup_now and cleanup_status can reach it without threading a
// dependency through every tool's signature.
let current: Sweeper | null = null;

export function setSweeper(s: Sweeper | null): void {
  current = s;
}

export function getSweeper(): Sweeper | null {
  return current;
}

export function resetSweeperForTests(): void {
  current = null;
}
