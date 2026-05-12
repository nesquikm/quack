import { describe, test, expect, beforeEach } from "bun:test";
import {
  incrementError,
  getSnapshot,
  getStartedAt,
  resetCountersForTests,
} from "./counters";

describe("counters", () => {
  beforeEach(() => resetCountersForTests());

  test("fresh instance starts at zero", () => {
    const snap = getSnapshot();
    expect(snap.errors.since_boot_total).toBe(0);
    expect(snap.errors.by_category).toEqual({});
  });

  test("increment increments per category", () => {
    incrementError("auth_401");
    incrementError("auth_401");
    incrementError("admin_403");
    const snap = getSnapshot();
    expect(snap.errors.by_category).toEqual({ auth_401: 2, admin_403: 1 });
  });

  test("since_boot_total equals sum of by_category", () => {
    incrementError("a");
    incrementError("a");
    incrementError("b");
    incrementError("c");
    const snap = getSnapshot();
    const sum = Object.values(snap.errors.by_category).reduce((s, n) => s + n, 0);
    expect(snap.errors.since_boot_total).toBe(sum);
    expect(snap.errors.since_boot_total).toBe(4);
  });

  test("queue fields all null in M2", () => {
    const snap = getSnapshot();
    expect(snap.queue).toEqual({
      depth: null,
      oldest_pending_age_seconds: null,
      accepted_total: null,
      dropped_full_total: null,
    });
  });

  test("getStartedAt returns a number", () => {
    expect(typeof getStartedAt()).toBe("number");
  });
});
