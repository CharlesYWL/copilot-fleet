/* global process */
import {
  COMMAND_LIMITS,
  COMMAND_OBSERVATION_CLOCK_ENV,
  CommandObservationClockSchema,
} from "@fleet/protocol";

const invalid = () =>
  Object.assign(
    new Error("Missing, inconsistent or discontinuous approved command clock."),
    { code: "clock_unverified" },
  );

// Standalone discovery uses a local deadline. Bound Fleet commands inject their
// approved clock; stdin and PR content never supply an offset or a replacement.
export function observationClock(input, now, monotonic = () => process.hrtime.bigint()) {
  if (input?.clock !== undefined || input?.clockOffsetMs !== undefined) throw invalid();
  const encoded = process.env[COMMAND_OBSERVATION_CLOCK_ENV];
  if (!encoded) return { now, deadline: Date.parse(input.budget.deadlineAt) };
  if (encoded.length > 4_096) throw invalid();
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw invalid();
  }
  const parsed = CommandObservationClockSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const clock = parsed.data;
  if (
    input.generation !== clock.claim.generation ||
    input.budget.deadlineAt !== clock.budget.deadlineAt ||
    input.budget.maxRequests > clock.budget.requests
  )
    throw invalid();
  const sample = Date.parse(clock.nodeTime);
  const anchor = BigInt(clock.monotonicNs);
  const checkedNow = () => {
    const elapsed = Number(monotonic() - anchor) / 1_000_000;
    const wall = now();
    if (elapsed < 0 || Math.abs(wall - sample - elapsed) > COMMAND_LIMITS.clockDriftMs)
      throw invalid();
    return Math.max(wall, sample + elapsed);
  };
  return {
    now: checkedNow,
    // hostClockOffsetMs maps Node receive time to Host SEND time (a lower
    // bound), so subtract uncertainty and permitted drift, never add them.
    deadline:
      Date.parse(clock.budget.deadlineAt) -
      clock.hostClockOffsetMs -
      clock.clockUncertaintyMs -
      COMMAND_LIMITS.clockDriftMs,
  };
}
