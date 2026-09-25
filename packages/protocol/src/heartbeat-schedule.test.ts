import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE,
  HeartbeatScheduleSchema,
  heartbeatIntervalLabel,
  heartbeatSchedule,
  heartbeatScheduleProblem,
  nextHeartbeat,
  parseHeartbeatSchedule,
  upcomingHeartbeats,
} from "./heartbeat-schedule.js";

/** Local wall-clock time, so the tests hold in any time zone. */
const local = (day: number, hour: number, minute = 0, month = 8, year = 2026) =>
  new Date(year, month, day, hour, minute).getTime();
// September 2026: the 23rd is a Wednesday, the 26th a Saturday.
const WEDNESDAY = 23;
const SATURDAY = 26;

describe("heartbeat schedule", () => {
  const schedule = parseHeartbeatSchedule(DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE);

  it("runs hourly through weekday working hours and every two hours otherwise", () => {
    expect(schedule.next(local(WEDNESDAY, 7, 59))).toBe(local(WEDNESDAY, 8));
    expect(schedule.next(local(WEDNESDAY, 8))).toBe(local(WEDNESDAY, 9));
    expect(schedule.next(local(WEDNESDAY, 9, 30))).toBe(local(WEDNESDAY, 10));
    expect(schedule.next(local(WEDNESDAY, 17))).toBe(local(WEDNESDAY, 18));
    expect(schedule.next(local(WEDNESDAY, 18))).toBe(local(WEDNESDAY, 20));
    expect(schedule.next(local(WEDNESDAY, 22))).toBe(local(WEDNESDAY + 1, 0));
    expect(schedule.next(local(SATURDAY, 10, 30))).toBe(local(SATURDAY, 12));
    expect(upcomingHeartbeats(schedule, local(WEDNESDAY, 16, 10), 4)).toEqual([
      local(WEDNESDAY, 17),
      local(WEDNESDAY, 18),
      local(WEDNESDAY, 20),
      local(WEDNESDAY, 22),
    ]);
  });

  it("is strictly after the given time, on whole minutes", () => {
    expect(schedule.next(local(WEDNESDAY, 10) - 1)).toBe(local(WEDNESDAY, 10));
    expect(schedule.next(local(WEDNESDAY, 10))).toBe(local(WEDNESDAY, 11));
    expect(schedule.next(local(WEDNESDAY, 10) + 1)).toBe(local(WEDNESDAY, 11));
    expect(schedule.next(Number.NaN)).toBeUndefined();
  });

  it("skips a heartbeat that falls right after recent activity", () => {
    // 35 minutes of quiet is enough; 20 is not, so the next hour is used.
    expect(nextHeartbeat(schedule, local(WEDNESDAY, 9, 25))).toBe(local(WEDNESDAY, 10));
    expect(nextHeartbeat(schedule, local(WEDNESDAY, 9, 40))).toBe(local(WEDNESDAY, 11));
    // A heartbeat's own short turn does not push the next hourly one out.
    expect(nextHeartbeat(schedule, local(WEDNESDAY, 10, 3))).toBe(local(WEDNESDAY, 11));
    expect(nextHeartbeat(schedule, local(WEDNESDAY, 21, 45))).toBe(
      local(WEDNESDAY + 1, 0),
    );
    expect(nextHeartbeat(schedule, local(WEDNESDAY, 22, 2))).toBe(
      local(WEDNESDAY + 1, 0),
    );
  });

  it("shrinks the quiet window for frequent schedules without prompting every turn", () => {
    const tenMinutes = parseHeartbeatSchedule("*/10 * * * *");
    expect(nextHeartbeat(tenMinutes, local(WEDNESDAY, 10, 2))).toBe(
      local(WEDNESDAY, 10, 10),
    );
    expect(nextHeartbeat(tenMinutes, local(WEDNESDAY, 10, 7))).toBe(
      local(WEDNESDAY, 10, 20),
    );
    const everyMinute = parseHeartbeatSchedule("* * * * *");
    expect(nextHeartbeat(everyMinute, local(WEDNESDAY, 10) + 30_000)).toBe(
      local(WEDNESDAY, 10, 6),
    );
  });

  it("accepts names, lists, steps, Sunday as 7 and common macros", () => {
    const named = parseHeartbeatSchedule("30 9 * jan,sep MON-fri");
    expect(named.next(local(SATURDAY, 12))).toBe(local(SATURDAY + 2, 9, 30));
    const sunday = parseHeartbeatSchedule("0 12 * * 7");
    expect(sunday.next(local(SATURDAY, 12))).toBe(local(SATURDAY + 1, 12));
    const offset = parseHeartbeatSchedule("5/20 10 * * *");
    expect(upcomingHeartbeats(offset, local(WEDNESDAY, 9), 3)).toEqual([
      local(WEDNESDAY, 10, 5),
      local(WEDNESDAY, 10, 25),
      local(WEDNESDAY, 10, 45),
    ]);
    const evenDays = parseHeartbeatSchedule("0 0 * * */2");
    // Saturday is 6; Sunday (0) follows it.
    expect(evenDays.next(local(SATURDAY, 1))).toBe(local(SATURDAY + 1, 0));
    expect(parseHeartbeatSchedule("@hourly").next(local(WEDNESDAY, 10, 1))).toBe(
      local(WEDNESDAY, 11),
    );
    expect(parseHeartbeatSchedule("@daily").next(local(WEDNESDAY, 10))).toBe(
      local(WEDNESDAY + 1, 0),
    );
  });

  it("matches either day field when both are restricted, as cron does", () => {
    // The 1st of the month, or any Monday.
    const either = parseHeartbeatSchedule("0 12 1 * mon");
    expect(either.next(local(SATURDAY, 13))).toBe(local(SATURDAY + 2, 12));
    expect(either.next(local(SATURDAY + 2, 13))).toBe(local(1, 12, 0, 9));
    // A starred day of month restricts by weekday alone.
    const weekdays = parseHeartbeatSchedule("0 12 */1 * mon");
    expect(weekdays.next(local(SATURDAY, 13))).toBe(local(SATURDAY + 2, 12));
  });

  it("normalizes spacing and separators, and combines expressions by union", () => {
    expect(HeartbeatScheduleSchema.parse("  0  9-18 * * 1-5 ;\n0 */2 * * *\n")).toBe(
      DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE,
    );
    expect(parseHeartbeatSchedule("0 9 * * *\n30 9 * * *").source).toBe(
      "0 9 * * *; 30 9 * * *",
    );
  });

  it.each([
    ["", /at least one/],
    ["0 9 * *", /five fields/],
    ["60 * * * *", /minute/],
    ["0 24 * * *", /hour/],
    ["0 0 0 * *", /day of month/],
    ["0 0 * 13 *", /month/],
    ["0 0 * * 8", /day of week/],
    ["*/0 * * * *", /step/],
    ["0 22-2 * * *", /low to high/],
    ["0 9 * * mon#1", /day of week/],
    ["0 9 L * *", /day of month/],
    ["0 0 30 2 *", /never runs/],
    [Array.from({ length: 13 }, () => "0 9 * * *").join(";"), /at most 12/],
    ["0 ".repeat(260), /at most 500/],
  ])("explains why %j cannot be saved", (text, message) => {
    expect(heartbeatScheduleProblem(text, local(WEDNESDAY, 10))).toMatch(message);
    expect(HeartbeatScheduleSchema.safeParse(text).success).toBe(false);
  });

  it("falls back to the default for a missing or unreadable stored value", () => {
    expect(heartbeatSchedule(undefined).source).toBe(
      DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE,
    );
    expect(heartbeatSchedule("  ").source).toBe(DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE);
    expect(heartbeatSchedule("not cron").source).toBe(
      DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE,
    );
    expect(heartbeatSchedule("*/15 * * * *").source).toBe("*/15 * * * *");
    expect(heartbeatSchedule("*/15 * * * *")).toBe(heartbeatSchedule("*/15 * * * *"));
  });

  it.each([DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE, "15,45 */3 * * *", "30 1,2,3 * * *"])(
    "only ever moves forward to matching local minutes through a year of %j",
    (text) => {
      const parsed = parseHeartbeatSchedule(text);
      let at = local(1, 0, 0, 0);
      const end = local(1, 0, 0, 0, 2027);
      let count = 0;
      while (at < end) {
        const next = parsed.next(at)!;
        expect(next).toBeGreaterThan(at);
        expect(next % 60_000).toBe(0);
        at = next;
        count++;
      }
      expect(count).toBeGreaterThan(300);
    },
  );

  it("labels the gap between heartbeats", () => {
    expect(heartbeatIntervalLabel(30 * 60_000)).toBe("30m");
    expect(heartbeatIntervalLabel(60 * 60_000 - 7_000)).toBe("1h");
    expect(heartbeatIntervalLabel(90 * 60_000)).toBe("1h30m");
    expect(heartbeatIntervalLabel(2 * 60 * 60_000)).toBe("2h");
    expect(heartbeatIntervalLabel(0)).toBe("1m");
  });
});
