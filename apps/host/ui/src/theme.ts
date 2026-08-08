import {
  createDarkTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";
import type { TerminalBlockKind } from "./lib/terminal-blocks";

const fleetBrand: BrandVariants = {
  10: "#020305",
  20: "#101426",
  30: "#172140",
  40: "#1d2c58",
  50: "#233872",
  60: "#29458d",
  70: "#2f52a9",
  80: "#3560c6",
  90: "#3b6ee3",
  100: "#5380f3",
  110: "#6c8cff",
  120: "#839dff",
  130: "#9aaeff",
  140: "#b0bfff",
  150: "#c7d1ff",
  160: "#dde3ff",
};

export const fleetDarkTheme: Theme = {
  ...createDarkTheme(fleetBrand),
  colorNeutralBackground1: "#0b0f1a",
  colorNeutralBackground1Hover: "#141a2b",
  colorNeutralBackground1Pressed: "#101728",
  colorNeutralBackground2: "#080c14",
  colorNeutralBackground3: "#111728",
  colorNeutralBackground4: "#070a12",
  colorNeutralBackground6: "#171e32",
  colorNeutralStroke1: "#252e45",
  colorNeutralStroke2: "#1d2537",
  colorNeutralStroke3: "#161d2c",
  colorNeutralForeground1: "#e9eefb",
  colorNeutralForeground2: "#c3cbdd",
  colorNeutralForeground3: "#8994ab",
  colorNeutralForeground4: "#647087",
};

/** Terminal surface colours kept outside the token set so the stream stays readable. */
export const terminal = {
  background: "#07090f",
  font: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  user: "#7fa0ff",
  agent: "#e6ecfa",
  thought: "#6b7893",
  tool: "#4ad6a7",
  permission: "#f7bf61",
  error: "#ff6b7a",
  dim: "#4d576d",
} as const;

export const blockColor: Record<TerminalBlockKind, string> = {
  user: terminal.user,
  agent: terminal.agent,
  thought: terminal.thought,
  tool: terminal.tool,
  permission: terminal.permission,
  permission_result: terminal.dim,
  turn: terminal.dim,
  state: terminal.dim,
  error: terminal.error,
  system: terminal.dim,
};

export const stateAccent: Record<string, string> = {
  queued: "#8994ab",
  starting: "#f7bf61",
  running: "#4ad6a7",
  idle: "#6c8cff",
  cancelling: "#f7bf61",
  offline: "#ff6b7a",
  stopped: "#ff6b7a",
  completed: "#4ad6a7",
  failed: "#ff6b7a",
};

/**
 * The amber surface the permission prompt is drawn on.
 *
 * A pending permission has to read as "the agent is blocked on you" at a glance,
 * which no neutral token conveys, so it gets its own small palette built around
 * `terminal.permission` — kept here rather than inline in the component so the
 * whole app's colour still has one home.
 */
export const permissionSurface = {
  accent: terminal.permission,
  background: "#241d10",
  border: "#7c653b",
  foreground: "#f2dcae",
  detail: "#e2d3b2",
  onAccent: "#20180a",
} as const;
