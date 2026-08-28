import type { OrchestratorEngine } from "./engine.js";

/** An idle Lead reviews its assigned active tasks at most twice an hour. */
export const ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How often the deadline sweep runs; never longer than the shortest deadline
 * it has to enforce.
 */
export function runSweepInterval(shortestDeadlineMs: number): number {
  return Math.max(5_000, Math.min(30_000, shortestDeadlineMs));
}

/**
 * Gives the engine a reason to tick when nothing has happened.
 *
 * Every other tick is caused by an event — a turn completing, a node
 * connecting, an operator clicking. A timeout is the absence of events, so
 * without a clock `stepTimeoutMs` and the dispatch deadline are unreachable
 * code and one Node losing power strands a step in `running` forever.
 *
 * This is not the busy-wait the design rules out. That rule is about a Lead
 * burning tokens to stay awake; a Host owning a timer is how it notices
 * silence, and the fleet already sweeps for stale heartbeats the same way.
 *
 * Deadlines are recomputed from stored timestamps on every pass, so a Host
 * restart picks up overdue work without persisting any timers.
 */
export function startRunDeadlineMonitor(
  engine: OrchestratorEngine,
  intervalMs = 15_000,
): NodeJS.Timeout {
  const timer = setInterval(() => engine.tick(), runSweepInterval(intervalMs));
  // Never the reason the process stays alive.
  timer.unref();
  return timer;
}
