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
    return {
      errors: { since_boot_total: total, by_category },
      queue: {
        depth: null,
        oldest_pending_age_seconds: null,
        accepted_total: null,
        dropped_full_total: null,
      },
    };
  }

  resetForTests(): void {
    this.errors.clear();
    this.startedAt = Date.now();
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
