import { z } from "zod";

/**
 * When the Host reminds an idle orchestrator to review its open work, and when
 * a maintained PR is next due for a routine check.
 *
 * Standard five-field cron (minute hour day-of-month month day-of-week) in the
 * Host's local time. Several expressions separated by `;` or new lines fire at
 * the union of their times, which is what "hourly through the working day,
 * every two hours otherwise" needs: no single expression can tell weekdays'
 * working hours from everything else.
 */
export const DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE = "0 9-18 * * 1-5; 0 */2 * * *";

/**
 * A scheduled heartbeat skips an orchestrator that was active this recently,
 * because it has only just looked. Frequent schedules shrink the window to half
 * the gap to the following heartbeat, so skipping never costs a whole interval
 * of a short schedule, but never below {@link HEARTBEAT_MIN_QUIET_MS}.
 */
export const HEARTBEAT_QUIET_MS = 30 * 60_000;
/** The floor that keeps an every-minute schedule from prompting after every turn. */
export const HEARTBEAT_MIN_QUIET_MS = 5 * 60_000;
export const HEARTBEAT_SCHEDULE_MAX_LENGTH = 500;
const MAX_EXPRESSIONS = 12;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A schedule must fire within a year of being saved. */
const VALIDATION_HORIZON_MS = 366 * DAY_MS;
/** Wide enough for a leap-day-only expression saved the year before one. */
const SEARCH_HORIZON_MS = 5 * 366 * DAY_MS;

export interface HeartbeatSchedule {
  /** The normalized text: single-spaced fields, expressions joined by `; `. */
  readonly source: string;
  /** The first scheduled minute strictly after `afterMs`, if one exists. */
  next(afterMs: number): number | undefined;
}

type Expression = {
  minutes: boolean[];
  hours: boolean[];
  days: boolean[];
  months: boolean[];
  weekdays: boolean[];
  /** Vixie cron: when both day fields are restricted, a day matches either. */
  eitherDay: boolean;
};

type FieldSpec = {
  label: string;
  min: number;
  max: number;
  /** Where `*` and `n/step` stop; below `max` only for weekday's Sunday alias. */
  rangeMax: number;
  names?: readonly string[];
  nameBase?: number;
};

const FIELDS: readonly FieldSpec[] = [
  { label: "minute", min: 0, max: 59, rangeMax: 59 },
  { label: "hour", min: 0, max: 23, rangeMax: 23 },
  { label: "day of month", min: 1, max: 31, rangeMax: 31 },
  {
    label: "month",
    min: 1,
    max: 12,
    rangeMax: 12,
    names: "jan feb mar apr may jun jul aug sep oct nov dec".split(" "),
    nameBase: 1,
  },
  // 7 is Sunday as well as 0, as in every common cron, but `*/2` is 0,2,4,6.
  {
    label: "day of week",
    min: 0,
    max: 7,
    rangeMax: 6,
    names: "sun mon tue wed thu fri sat".split(" "),
    nameBase: 0,
  },
];

const MACROS: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

export class HeartbeatScheduleError extends Error {}

function fail(message: string): never {
  throw new HeartbeatScheduleError(message);
}

function fieldValue(token: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(token.toLowerCase()) ?? -1;
  const value =
    named >= 0 ? named + (spec.nameBase ?? 0) : /^\d+$/.test(token) ? Number(token) : NaN;
  if (!Number.isInteger(value) || value < spec.min || value > spec.max)
    fail(`"${token}" is not a valid ${spec.label} (${spec.min}-${spec.max}).`);
  return value;
}

function parseField(text: string, spec: FieldSpec): boolean[] {
  const allowed = Array.from({ length: spec.max + 1 }, () => false);
  for (const part of text.split(",")) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part);
    if (!match) fail(`"${part}" is not a valid ${spec.label} entry.`);
    const [, range = "", stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) fail(`The ${spec.label} step must be at least 1.`);
    let low = spec.min;
    let high = spec.rangeMax;
    if (range !== "*") {
      const [start = "", end] = range.split("-");
      low = fieldValue(start, spec);
      // `5/15` reads as "from 5, every 15", as cronie and most parsers accept.
      high = end !== undefined ? fieldValue(end, spec) : stepText ? spec.rangeMax : low;
    }
    if (low > high)
      fail(
        `The ${spec.label} range "${range}" must run from low to high; split a wrap-around into two ranges.`,
      );
    for (let value = low; value <= high; value += step) allowed[value] = true;
  }
  return allowed;
}

function parseExpression(text: string): Expression {
  const fields = (MACROS[text.toLowerCase()] ?? text).split(" ");
  if (fields.length !== 5)
    fail(
      `"${text}" needs five fields: minute, hour, day of month, month and day of week.`,
    );
  const [minutes, hours, days, months, weekdays] = fields.map((field, index) =>
    parseField(field, FIELDS[index]!),
  ) as [boolean[], boolean[], boolean[], boolean[], boolean[]];
  if (weekdays[7]) weekdays[0] = true;
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    eitherDay: !fields[2]!.startsWith("*") && !fields[4]!.startsWith("*"),
  };
}

function dayMatches(expression: Expression, date: Date): boolean {
  const day = expression.days[date.getDate()]!;
  const weekday = expression.weekdays[date.getDay()]!;
  return expression.eitherDay ? day || weekday : day && weekday;
}

/** Local-time arithmetic, so daylight saving shifts are the platform's to resolve. */
function nextMatch(expression: Expression, afterMs: number, limitMs: number) {
  let at = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  // Every step moves forward by at least a minute; this only bounds a bug.
  for (let guard = 0; at <= limitMs && guard < 1_000_000; guard++) {
    const date = new Date(at);
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const hour = date.getHours();
    let candidate: number;
    if (!expression.months[month + 1]) {
      candidate = new Date(year, month + 1, 1).getTime();
    } else if (!dayMatches(expression, date)) {
      candidate = new Date(year, month, day + 1).getTime();
    } else if (!expression.hours[hour]) {
      candidate = new Date(year, month, day, hour + 1).getTime();
    } else if (!expression.minutes[date.getMinutes()]) {
      const minute = expression.minutes.indexOf(true, date.getMinutes() + 1);
      candidate =
        minute === -1
          ? new Date(year, month, day, hour + 1).getTime()
          : at + (minute - date.getMinutes()) * MINUTE_MS;
    } else {
      return at;
    }
    at = candidate > at ? candidate : at + MINUTE_MS;
  }
  return undefined;
}

function expressionSources(text: string): string[] {
  return text
    .split(/[;\r\n]+/)
    .map((part) => part.trim().split(/\s+/).join(" "))
    .filter(Boolean);
}

/** Single-spaced fields, expressions joined by `; `; does not validate. */
export function normalizeHeartbeatSchedule(text: string): string {
  return expressionSources(text).join("; ");
}

/** Splits, normalizes and checks a schedule; throws {@link HeartbeatScheduleError}. */
export function parseHeartbeatSchedule(text: string): HeartbeatSchedule {
  if (text.length > HEARTBEAT_SCHEDULE_MAX_LENGTH)
    fail(`A schedule can be at most ${HEARTBEAT_SCHEDULE_MAX_LENGTH} characters.`);
  const sources = expressionSources(text);
  if (!sources.length) fail("Enter at least one cron expression.");
  if (sources.length > MAX_EXPRESSIONS)
    fail(`A schedule can combine at most ${MAX_EXPRESSIONS} expressions.`);
  const expressions = sources.map(parseExpression);
  return {
    source: sources.join("; "),
    next(afterMs) {
      if (!Number.isFinite(afterMs)) return undefined;
      let earliest: number | undefined;
      for (const expression of expressions) {
        const limit = Math.min(earliest ?? Infinity, afterMs + SEARCH_HORIZON_MS);
        const match = nextMatch(expression, afterMs, limit);
        if (match !== undefined && (earliest === undefined || match < earliest))
          earliest = match;
      }
      return earliest;
    },
  };
}

/** Why `text` cannot be saved as a schedule, or `undefined` when it can. */
export function heartbeatScheduleProblem(
  text: string,
  nowMs = Date.now(),
): string | undefined {
  try {
    const next = parseHeartbeatSchedule(text).next(nowMs);
    return next === undefined || next - nowMs > VALIDATION_HORIZON_MS
      ? "The schedule never runs within the next year."
      : undefined;
  } catch (error) {
    if (error instanceof HeartbeatScheduleError) return error.message;
    throw error;
  }
}

/** A schedule as an operator may save it; parses to its normalized text. */
export const HeartbeatScheduleSchema = z
  .string()
  .max(HEARTBEAT_SCHEDULE_MAX_LENGTH)
  .superRefine((value, context) => {
    const problem = heartbeatScheduleProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  })
  .transform(normalizeHeartbeatSchedule);

let cachedText: string | undefined;
let cachedSchedule: HeartbeatSchedule | undefined;

/**
 * The schedule a stored setting describes, or the default when the value is
 * missing or no longer parses. Cached, because the deadline sweep asks on
 * every pass.
 */
export function heartbeatSchedule(text: string | undefined): HeartbeatSchedule {
  if (cachedSchedule && cachedText === text) return cachedSchedule;
  let schedule: HeartbeatSchedule;
  try {
    schedule = parseHeartbeatSchedule(
      text?.trim() || DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE,
    );
  } catch {
    schedule = parseHeartbeatSchedule(DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE);
  }
  cachedText = text;
  cachedSchedule = schedule;
  return schedule;
}

/**
 * The first heartbeat that counts as a fresh look for something last handled
 * at `sinceMs`: the next scheduled time, unless that falls inside the quiet
 * window, in which case the first one after it that does not.
 */
export function nextHeartbeat(
  schedule: HeartbeatSchedule,
  sinceMs: number,
): number | undefined {
  let slot = schedule.next(sinceMs);
  for (let guard = 0; slot !== undefined && guard < 10_000; guard++) {
    const following = schedule.next(slot);
    const quiet =
      following === undefined
        ? HEARTBEAT_QUIET_MS
        : Math.min(
            HEARTBEAT_QUIET_MS,
            Math.max(HEARTBEAT_MIN_QUIET_MS, (following - slot) / 2),
          );
    if (slot - sinceMs >= quiet) return slot;
    slot = following;
  }
  return undefined;
}

/** The next `count` scheduled times after `fromMs`, for a preview. */
export function upcomingHeartbeats(
  schedule: HeartbeatSchedule,
  fromMs: number,
  count = 3,
): number[] {
  const times: number[] = [];
  for (let at = schedule.next(fromMs); at !== undefined && times.length < count;) {
    times.push(at);
    at = schedule.next(at);
  }
  return times;
}

/** `30m`, `1h`, `1h30m` — a gap between heartbeats, to the nearest minute. */
export function heartbeatIntervalLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}
