export interface MetricsSnapshot {
  errors: {
    since_boot_total: number;
    by_category: Record<string, number>;
  };
  queue: {
    depth: number | null;
    oldest_pending_age_seconds: number | null;
    accepted_total: number | null;
    dropped_full_total: number | null;
  };
}

// Queue counters — set to numeric (not null) once the extractor wires up.
// `setQueueDepthSource` lets the consumer/queue register a live gauge for
// `depth`. `queueIncrement` accumulates the counters.
let depthGauge: (() => number) | null = null;
let acceptedTotal = 0;
let droppedFullTotal = 0;

class CounterStore {
  startedAt = Date.now();
  private errors = new Map<string, number>();

  incrementError(category: string): void {
    this.errors.set(category, (this.errors.get(category) ?? 0) + 1);
  }

  getSnapshot(): MetricsSnapshot {
    const by_category: Record<string, number> = {};
    let total = 0;
    for (const [cat, count] of this.errors) {
      by_category[cat] = count;
      total += count;
    }
    const queueDepth = depthGauge ? depthGauge() : null;
    const queueAccepted = depthGauge ? acceptedTotal : null;
    const queueDropped = depthGauge ? droppedFullTotal : null;
    return {
      errors: { since_boot_total: total, by_category },
      queue: {
        depth: queueDepth,
        oldest_pending_age_seconds: null,
        accepted_total: queueAccepted,
        dropped_full_total: queueDropped,
      },
    };
  }

  resetForTests(): void {
    this.errors.clear();
    this.startedAt = Date.now();
    depthGauge = null;
    acceptedTotal = 0;
    droppedFullTotal = 0;
  }
}

const store = new CounterStore();

export function incrementError(category: string): void {
  store.incrementError(category);
}

export function getSnapshot(): MetricsSnapshot {
  return store.getSnapshot();
}

export function getStartedAt(): number {
  return store.startedAt;
}

export function resetCountersForTests(): void {
  store.resetForTests();
}

// Wire a live queue-depth gauge. Calling with null disables the queue block
// (server_status reports null again).
export function setQueueDepthSource(fn: (() => number) | null): void {
  depthGauge = fn;
}

export function queueIncrement(field: "accepted_total" | "dropped_full_total"): void {
  if (field === "accepted_total") acceptedTotal += 1;
  else if (field === "dropped_full_total") droppedFullTotal += 1;
}
