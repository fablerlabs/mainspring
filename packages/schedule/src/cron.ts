/**
 * A deliberately small cron subset, matched against the UTC components of an
 * epoch-millisecond instant. Enough for the cadences a long-lived agent
 * actually needs ("every day at 14:00", "top of every hour", "Mondays"),
 * without the ambiguity of the full Vixie grammar.
 *
 * Expression: five space-separated fields — `minute hour dom month dow`:
 *   minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6 (0 = Sunday).
 *
 * Each field is a comma-separated list of terms; a field matches if ANY term
 * matches. A term is one of:
 *   *        every value in the field's range
 *   n        the single value n
 *   a-b      the inclusive range a..b
 *   a/step   from a to the field max, every `step`th value (a may be `*`, = min)
 *   a-b/step from a to b, every `step`th value
 *
 * Deliberately UNsupported (throws on parse): named months/days (JAN, MON),
 * `?`, `L`, `W`, `#`, and 6/7-field expressions with seconds or year.
 *
 * Subset choice: unlike Vixie cron, when both `dom` and `dow` are restricted
 * they are ANDed (both must match), not ORed — simpler to reason about, and
 * documented here so it is never a surprise.
 */

interface FieldRange {
  min: number;
  max: number;
}

const RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
];

/** Thrown when an expression is malformed or uses an unsupported feature. */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

/** A compiled field: the set of integers it matches within its range. */
type FieldMatcher = Set<number>;

function parseInt10(token: string, what: string): number {
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(`expected a number for ${what}, got "${token}"`);
  }
  return Number.parseInt(token, 10);
}

function parseField(field: string, range: FieldRange): FieldMatcher {
  const matches = new Set<number>();
  for (const term of field.split(",")) {
    if (term === "") {
      throw new CronParseError(`empty term in field "${field}"`);
    }

    // Split off an optional /step suffix.
    const [rangePart, stepPart, ...rest] = term.split("/");
    if (rest.length > 0) {
      throw new CronParseError(`too many "/" in term "${term}"`);
    }
    let step = 1;
    if (stepPart !== undefined) {
      step = parseInt10(stepPart, "step");
      if (step < 1) throw new CronParseError(`step must be >= 1 in "${term}"`);
    }

    // Resolve the low..high bounds the step iterates over.
    let low: number;
    let high: number;
    if (rangePart === "*") {
      low = range.min;
      high = range.max;
    } else if (rangePart.includes("-")) {
      const [a, b, ...extra] = rangePart.split("-");
      if (extra.length > 0) throw new CronParseError(`malformed range "${rangePart}"`);
      low = parseInt10(a, "range start");
      high = parseInt10(b, "range end");
    } else {
      low = parseInt10(rangePart, "value");
      // A bare number with a step (e.g. "5/10") means "from 5 to the max".
      high = stepPart !== undefined ? range.max : low;
    }

    if (low < range.min || high > range.max || low > high) {
      throw new CronParseError(
        `value ${low}-${high} out of range ${range.min}-${range.max} in "${term}"`,
      );
    }
    for (let v = low; v <= high; v += step) matches.add(v);
  }
  return matches;
}

/** A parsed 5-field expression, one matcher per field. */
export interface CronSchedule {
  minute: FieldMatcher;
  hour: FieldMatcher;
  dayOfMonth: FieldMatcher;
  month: FieldMatcher;
  dayOfWeek: FieldMatcher;
  /** True when the field was a literal `*`, needed for the dom/dow AND rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parses a cron expression, throwing {@link CronParseError} on any problem. */
export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `expected 5 fields (min hour dom month dow), got ${fields.length}: "${expr}"`,
    );
  }
  return {
    minute: parseField(fields[0], RANGES[0]),
    hour: parseField(fields[1], RANGES[1]),
    dayOfMonth: parseField(fields[2], RANGES[2]),
    month: parseField(fields[3], RANGES[3]),
    dayOfWeek: parseField(fields[4], RANGES[4]),
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

/**
 * True if the UTC wall-clock at `now` (epoch ms) satisfies the expression.
 * Throws {@link CronParseError} if `expr` is invalid.
 */
export function matchesCron(expr: string, now: number): boolean {
  const c = parseCron(expr);
  const d = new Date(now);
  return (
    c.minute.has(d.getUTCMinutes()) &&
    c.hour.has(d.getUTCHours()) &&
    c.month.has(d.getUTCMonth() + 1) &&
    c.dayOfMonth.has(d.getUTCDate()) &&
    c.dayOfWeek.has(d.getUTCDay())
  );
}
