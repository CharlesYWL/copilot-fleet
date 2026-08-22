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

/**
 * What a colour means, rather than where it is used.
 *
 * Named for the state it signals so that a session tile, a run card and a
 * transcript block cannot drift into three shades of "roughly running". Colour
 * is never the only channel — every consumer pairs one of these with an icon
 * or a word — but when it is used it should be the same colour everywhere.
 *
 * Amber is reserved. It means a person is being waited on and nothing else, so
 * that a screen with amber on it always has something to do.
 */
export const semanticColors = {
  /** Selection, the current mode, and anything clickable that is chosen. */
  interaction: "#6c8cff",
  /** A person is blocked. The only interrupt colour. */
  permission: "#f7bf61",
  running: "#4ad6a7",
  idle: "#6c8cff",
  failed: "#ff6b7a",
  completed: "#4ad6a7",
  neutral: "#8994ab",
  dim: "#4d576d",
} as const;

export type StatusTone = "success" | "info" | "attention" | "danger" | "neutral";

/** The colour and surface each tone draws itself with. */
export const statusVisuals: Record<
  StatusTone,
  { foreground: string; surface: string; border: string }
> = {
  success: {
    foreground: semanticColors.running,
    surface: "rgba(74, 214, 167, 0.10)",
    border: "rgba(74, 214, 167, 0.45)",
  },
  info: {
    foreground: semanticColors.idle,
    surface: "rgba(108, 140, 255, 0.10)",
    border: "rgba(108, 140, 255, 0.45)",
  },
  attention: {
    foreground: semanticColors.permission,
    surface: "rgba(247, 191, 97, 0.12)",
    border: "rgba(247, 191, 97, 0.60)",
  },
  danger: {
    foreground: semanticColors.failed,
    surface: "rgba(255, 107, 122, 0.10)",
    border: "rgba(255, 107, 122, 0.45)",
  },
  neutral: {
    foreground: semanticColors.neutral,
    surface: "rgba(137, 148, 171, 0.08)",
    border: "rgba(137, 148, 171, 0.35)",
  },
};

export const blockColor: Record<TerminalBlockKind, string> = {
  user: terminal.user,
  agent: terminal.agent,
  thought: terminal.thought,
  tool: semanticColors.running,
  permission: semanticColors.permission,
  permission_result: terminal.dim,
  turn: terminal.dim,
  state: terminal.dim,
  error: semanticColors.failed,
  system: terminal.dim,
};

export const stateAccent: Record<string, string> = {
  queued: semanticColors.neutral,
  starting: semanticColors.permission,
  running: semanticColors.running,
  idle: semanticColors.idle,
  cancelling: semanticColors.permission,
  offline: semanticColors.failed,
  stopped: semanticColors.failed,
  completed: semanticColors.completed,
  failed: semanticColors.failed,
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
