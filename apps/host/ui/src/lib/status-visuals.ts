import {
  ArrowClockwiseRegular,
  ArrowForwardRegular,
  CheckmarkCircleRegular,
  ClockRegular,
  ErrorCircleRegular,
  PauseCircleRegular,
  PlugConnectedRegular,
  PlugDisconnectedRegular,
  SpinnerIosRegular,
  StopRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import { statusVisuals, type StatusTone } from "../theme";

const visuals = {
  running: { label: "Running", icon: SpinnerIosRegular, tone: "info", priority: 30 },
  stopping: {
    label: "Stopping",
    icon: SpinnerIosRegular,
    tone: "attention",
    priority: 35,
  },
  idle: { label: "Idle", icon: PauseCircleRegular, tone: "neutral", priority: 10 },
  queued: { label: "Queued", icon: ClockRegular, tone: "neutral", priority: 10 },
  "waiting-for-permission": {
    label: "Waiting for you",
    icon: WarningRegular,
    tone: "attention",
    priority: 40,
  },
  offline: {
    label: "Offline",
    icon: PlugDisconnectedRegular,
    tone: "danger",
    priority: 20,
  },
  failed: { label: "Failed", icon: ErrorCircleRegular, tone: "danger", priority: 20 },
  resumable: {
    label: "Resumable",
    icon: ArrowClockwiseRegular,
    tone: "attention",
    priority: 20,
  },
  done: { label: "Done", icon: CheckmarkCircleRegular, tone: "success", priority: 0 },
  stopped: { label: "Stopped", icon: StopRegular, tone: "neutral", priority: 0 },
  skipped: { label: "Skipped", icon: ArrowForwardRegular, tone: "neutral", priority: 0 },
  online: {
    label: "Online",
    icon: PlugConnectedRegular,
    tone: "success",
    priority: 0,
  },
} satisfies Record<
  string,
  { label: string; icon: typeof WarningRegular; tone: StatusTone; priority: number }
>;

export type StatusState = keyof typeof visuals;

export type StatusDescriptor = {
  state: StatusState;
  label: string;
  shortLabel: string;
  icon: typeof WarningRegular;
  tone: StatusTone;
  priority: number;
  color: string;
  motion: "spin" | "pulse" | undefined;
};

/** Shared by sessions, dispatched steps, task summaries, and node connectivity. */
export function statusDescriptor(state: StatusState): StatusDescriptor {
  const visual = visuals[state];
  return {
    ...visual,
    state,
    label: state === "idle" ? "Idle - ready for follow-up" : visual.label,
    shortLabel:
      state === "waiting-for-permission" ? "needs you" : visual.label.toLowerCase(),
    color: statusVisuals[visual.tone].foreground,
    motion:
      state === "running" || state === "stopping"
        ? "spin"
        : state === "waiting-for-permission"
          ? "pulse"
          : undefined,
  };
}
