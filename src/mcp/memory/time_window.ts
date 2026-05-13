// Accepts two shapes:
//   1) Relative shorthand: "7d" / "1h" / "30m" / "45s" / "2w" — interpreted as
//      "from = now() - duration; to = now()". Common case for "what did we
//      decide recently".
//   2) Explicit ISO-8601 pair: `{ from: ISO, to?: ISO }` — for "what happened
//      during the incident window".

export interface TimeWindowParsed {
  from: string; // ISO-8601
  to: string;   // ISO-8601
}

export type TimeWindowInput =
  | string
  | { from: string; to?: string };

export class TimeWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeWindowError";
  }
}

const SHORTHAND_RE = /^(\d+)([smhdw])$/;
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
};

function isIso8601(s: string): boolean {
  // Trust Date.parse + verify shape — Date.parse accepts many forms; we want
  // a strict reject path so the operator gets a clean error.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip + tolerate offset variants ("Z" vs "+00:00") by date-parity:
  return s.includes("T") || /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseTimeWindow(input: TimeWindowInput, now: Date = new Date()): TimeWindowParsed {
  if (typeof input === "string") {
    const m = SHORTHAND_RE.exec(input);
    if (!m) throw new TimeWindowError(`unrecognized shorthand: ${input}`);
    const n = Number(m[1]);
    const unit = m[2]!;
    if (n <= 0) throw new TimeWindowError(`shorthand value must be positive: ${input}`);
    const secs = n * UNIT_SECONDS[unit]!;
    const to = now;
    const from = new Date(to.getTime() - secs * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  if (!isIso8601(input.from)) throw new TimeWindowError(`invalid from ISO: ${input.from}`);
  const to = input.to ?? now.toISOString();
  if (!isIso8601(to)) throw new TimeWindowError(`invalid to ISO: ${to}`);
  return { from: input.from, to };
}
