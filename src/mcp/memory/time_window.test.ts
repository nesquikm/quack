import { describe, test, expect } from "bun:test";
import { parseTimeWindow, TimeWindowError } from "./time_window";

const NOW = new Date("2026-05-13T12:00:00Z");

describe("parseTimeWindow", () => {
  test("shorthand: 7d", () => {
    const w = parseTimeWindow("7d", NOW);
    expect(w.to).toBe(NOW.toISOString());
    expect(new Date(w.from).getTime()).toBe(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  test("shorthand: 1h", () => {
    const w = parseTimeWindow("1h", NOW);
    expect(new Date(w.from).getTime()).toBe(NOW.getTime() - 60 * 60 * 1000);
  });

  test("shorthand: 30m", () => {
    const w = parseTimeWindow("30m", NOW);
    expect(new Date(w.from).getTime()).toBe(NOW.getTime() - 30 * 60 * 1000);
  });

  test("shorthand: 2w", () => {
    const w = parseTimeWindow("2w", NOW);
    expect(new Date(w.from).getTime()).toBe(NOW.getTime() - 14 * 24 * 60 * 60 * 1000);
  });

  test("shorthand rejects unknown unit", () => {
    expect(() => parseTimeWindow("5x", NOW)).toThrow(TimeWindowError);
  });

  test("shorthand rejects non-positive", () => {
    expect(() => parseTimeWindow("0d", NOW)).toThrow(TimeWindowError);
  });

  test("ISO pair with both ends", () => {
    const w = parseTimeWindow({ from: "2026-05-01T00:00:00Z", to: "2026-05-10T00:00:00Z" }, NOW);
    expect(w.from).toBe("2026-05-01T00:00:00Z");
    expect(w.to).toBe("2026-05-10T00:00:00Z");
  });

  test("ISO pair with implicit to=now", () => {
    const w = parseTimeWindow({ from: "2026-05-01T00:00:00Z" }, NOW);
    expect(w.from).toBe("2026-05-01T00:00:00Z");
    expect(w.to).toBe(NOW.toISOString());
  });

  test("ISO pair rejects bad from", () => {
    expect(() => parseTimeWindow({ from: "yesterday" }, NOW)).toThrow(TimeWindowError);
  });

  test("ISO pair rejects bad to", () => {
    expect(() => parseTimeWindow({ from: "2026-05-01T00:00:00Z", to: "tomorrow" }, NOW)).toThrow(TimeWindowError);
  });
});
