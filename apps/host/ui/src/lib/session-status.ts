import {
  isResumableSession,
  terminalSessionStates,
  type FleetSession,
} from "@fleet/protocol";
import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  CircleRegular,
  ErrorCircleRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import type { ComponentType } from "react";
import { semanticColors, stateAccent, statusVisuals, terminal } from "../theme";

/**
 * Amber for a session that ended but can be picked back up.
 *
 * The state underneath is usually `failed`, which is drawn in the same red as a
 * session that is genuinely gone. After a reboot that colours every recoverable
 * transcript as a casualty, which is exactly the reading that makes an operator
 * reach for "Clear ended".
 */
export const RESUMABLE_ACCENT = semanticColors.permission;

/**
 * What a session looks like to a person, as opposed to what state it is in.
 *
 * The protocol has nine session states; a screen needs five distinctions, and
 * the one that matters most — "this is waiting on you" — is not a session state
 * at all but a pending permission event. Deriving it in one place is what keeps
 * the sidebar, the tiles, the terminal header and the run views from each
 * inventing their own answer, which is how "running" ended up three colours.
 */
export type SessionVisualState =
  "running" | "idle" | "waiting-for-permission" | "failed" | "done";

export type SessionStatusDescriptor = {
  state: SessionVisualState;
  /** The full word, for a header or a tooltip. */
  label: string;
  /** The compact word, for a tile or a tree row. */
  shortLabel: string;
  icon: ComponentType<{ className?: string }>;
  tone: keyof typeof statusVisuals;
  /** Higher sorts first. Attention outranks work, work outranks rest. */
  priority: number;
  /** The accent this state draws with; also available via `tone`. */
  color: string;
};

const DESCRIPTORS: Record<SessionVisualState, Omit<SessionStatusDescriptor, "state">> = {
  "waiting-for-permission": {
    label: "Waiting for you",
    shortLabel: "needs you",
    icon: WarningRegular,
    tone: "attention",
    priority: 40,
    color: statusVisuals.attention.foreground,
  },
  running: {
    label: "Running",
    shortLabel: "running",
    icon: ArrowClockwiseRegular,
    tone: "success",
    priority: 30,
    color: statusVisuals.success.foreground,
  },
  failed: {
    label: "Failed",
    shortLabel: "failed",
    icon: ErrorCircleRegular,
    tone: "danger",
    priority: 20,
    color: statusVisuals.danger.foreground,
  },
  idle: {
    label: "Ready for follow-up",
    shortLabel: "idle",
    icon: CircleRegular,
    tone: "info",
    priority: 10,
    color: statusVisuals.info.foreground,
  },
  done: {
    label: "Finished",
    shortLabel: "done",
    icon: CheckmarkCircleRegular,
    tone: "neutral",
    priority: 0,
    color: statusVisuals.neutral.foreground,
  },
};

/**
 * How one session should be shown.
 *
 * `awaitingPermission` is passed in rather than read from the session because
 * it lives in the event log: a session blocked on a decision is still `running`
 * as far as its own state machine is concerned.
 */
export function sessionStatusDescriptor(
  session: FleetSession,
  awaitingPermission = false,
): SessionStatusDescriptor {
  const state = visualState(session, awaitingPermission);
  const base = DESCRIPTORS[state];
  // A dormant session is `failed` underneath but recoverable, so it keeps the
  // attention colour it has always had rather than reading as a casualty.
  if (state === "failed" && isDormantSession(session)) {
    return {
      ...base,
      state,
      label: "Resumable",
      shortLabel: "resumable",
      tone: "attention",
      color: RESUMABLE_ACCENT,
    };
  }
  return { ...base, state };
}

function visualState(
  session: FleetSession,
  awaitingPermission: boolean,
): SessionVisualState {
  if (awaitingPermission) return "waiting-for-permission";
  if (session.state === "failed" || session.state === "offline") return "failed";
  if (session.state === "completed" || session.state === "stopped") {
    return isDormantSession(session) ? "failed" : "done";
  }
  if (session.state === "running" || session.state === "starting") return "running";
  if (session.state === "queued" || session.state === "cancelling") return "running";
  return "idle";
}

/** Orders a list so whatever needs a person is at the top of it. */
export function byAttention(
  descriptorOf: (session: FleetSession) => SessionStatusDescriptor,
) {
  return (a: FleetSession, b: FleetSession) =>
    descriptorOf(b).priority - descriptorOf(a).priority;
}

/**
 * Ended, but Resume re-attaches it.
 *
 * Narrower than the protocol's predicate, which also covers `offline`: an
 * offline session is usually a Node that will be back in seconds and reclaim it
 * on its own, so it keeps its own status rather than being relabelled as
 * something the operator has to act on.
 */
export function isDormantSession(session: FleetSession): boolean {
  return isResumableSession(session) && terminalSessionStates.has(session.state);
}

/** The word shown where the session state goes. */
export function sessionStatusLabel(session: FleetSession): string {
  return isDormantSession(session) ? "resumable" : session.state;
}

export function sessionAccent(session: FleetSession): string {
  if (isDormantSession(session)) return RESUMABLE_ACCENT;
  return stateAccent[session.state] ?? terminal.dim;
}

/**
 * Sessions the sidebar, the monitor wall, and the automatic selection show.
 *
 * Anything live, anything still resumable, and whatever is selected — so a
 * session that ends while being watched does not yank its own transcript away.
 *
 * The orchestrator is excluded unless it was opened deliberately: it is the
 * fleet's own surface, and it has a view of its own. Its workers are shown,
 * because they are ordinary sessions on a real node doing visible work, and
 * this list has to agree with the tree — when the two disagreed, an operator
 * saw "No sessions" beside a worker's transcript offering **Resume**, which
 * would have restarted it outside the run's accounting.
 */
export function filterVisibleSessions(
  sessions: FleetSession[],
  selectedSessionId: string | undefined,
): FleetSession[] {
  return sessions.filter(
    (session) =>
      (session.runRole !== "lead" || session.id === selectedSessionId) &&
      (!terminalSessionStates.has(session.state) ||
        isResumableSession(session) ||
        session.id === selectedSessionId),
  );
}

/** Ended with nothing left to recover: what "Clear ended" actually removes. */
export function isDisposableSession(session: FleetSession): boolean {
  return terminalSessionStates.has(session.state) && !isResumableSession(session);
}
