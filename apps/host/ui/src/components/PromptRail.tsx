import { useLayoutEffect, useRef, useState } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { promptTimeLabel, type PromptMark } from "../lib/prompt-marks";

const useStyles = makeStyles({
  rail: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "34px",
    // The strip, not the marks, is the hover target: a pointer heading for the
    // edge should widen the marks before it arrives, the way the scrollbar it
    // replaces used to appear on approach.
    zIndex: 1,
  },
  mark: {
    position: "absolute",
    right: "10px",
    height: "3px",
    padding: 0,
    border: "none",
    borderRadius: "2px",
    background: tokens.colorNeutralForeground4,
    cursor: "pointer",
    transitionProperty: "width, background-color, opacity",
    transitionDuration: "90ms",
    transitionTimingFunction: "ease-out",
    ":hover": {
      background: tokens.colorNeutralForegroundOnBrand,
    },
  },
  /** The turn the reader is looking at, so the rail says where they are. */
  active: {
    background: tokens.colorNeutralForeground1,
  },
  tooltip: {
    position: "absolute",
    right: "34px",
    width: "max-content",
    maxWidth: "300px",
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    pointerEvents: "none",
  },
  tooltipLabel: {
    display: "block",
    fontSize: "13px",
    lineHeight: "1.35",
    color: tokens.colorNeutralForeground1,
    wordBreak: "break-word",
  },
  tooltipTime: {
    display: "block",
    marginTop: "3px",
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
  },
});

/** A mark is a hairline; its length is what carries the interaction. */
const MARK_HEIGHT = 3;
const MIN_GAP = 5;
const MAX_GAP = 18;
const RESTING_WIDTH = 13;
const PEAK_WIDTH = 30;
/** How near the pointer has to be, vertically, before a mark grows at all. */
const MAGNIFY_RANGE = 72;

type PromptRailProps = {
  marks: PromptMark[];
  activeKey?: string | undefined;
  onSelect: (key: string) => void;
};

/**
 * The right-hand rail of prompts, in place of a scrollbar.
 *
 * A scrollbar answers "how far down am I", which is the least interesting
 * question about a session that has run for an hour. Each mark here is one
 * thing the operator asked for: the pointer nearing the edge lengthens them,
 * resting on one names it, and clicking jumps back to that turn. The mark for
 * the turn currently on screen stays lit, so the rail doubles as the position
 * indicator the scrollbar used to be.
 */
export const PromptRail = ({ marks, activeKey, onSelect }: PromptRailProps) => {
  const styles = useStyles();
  const railRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [pointerY, setPointerY] = useState<number>();
  const [hoveredKey, setHoveredKey] = useState<string>();

  useLayoutEffect(() => {
    const node = railRef.current;
    if (!node) return;
    const measure = () => setHeight(node.getBoundingClientRect().height);
    measure();
    // Absent under jsdom, and the fallback geometry below is enough there.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { step, top } = railLayout(marks.length, height);
  const hovered = marks.findIndex((mark) => mark.key === hoveredKey);

  return (
    <div
      className={styles.rail}
      ref={railRef}
      onPointerMove={(event) =>
        setPointerY(event.clientY - event.currentTarget.getBoundingClientRect().top)
      }
      onPointerLeave={() => {
        setPointerY(undefined);
        setHoveredKey(undefined);
      }}
    >
      {marks.map((mark, index) => {
        const center = top + index * step + MARK_HEIGHT / 2;
        return (
          <button
            key={mark.key}
            type="button"
            className={mergeClasses(styles.mark, mark.key === activeKey && styles.active)}
            style={{
              top: `${center - MARK_HEIGHT / 2}px`,
              width: `${markWidth(center, pointerY)}px`,
            }}
            aria-label={`Jump to prompt: ${mark.label}`}
            onPointerEnter={() => setHoveredKey(mark.key)}
            onFocus={() => setHoveredKey(mark.key)}
            onBlur={() => setHoveredKey(undefined)}
            onClick={() => onSelect(mark.key)}
          />
        );
      })}
      {hovered >= 0 && marks[hovered] ? (
        <div
          className={styles.tooltip}
          style={{ top: `${tooltipTop(top + hovered * step, height)}px` }}
          role="tooltip"
        >
          <span className={styles.tooltipLabel}>{marks[hovered].label}</span>
          <span className={styles.tooltipTime}>
            {promptTimeLabel(marks[hovered].createdAt)}
          </span>
        </div>
      ) : null}
    </div>
  );
};

/**
 * Where the marks sit: evenly spaced and centred as a group.
 *
 * The spacing closes up rather than the group running off the edge, because a
 * session with sixty prompts still has to show all sixty — a rail that only
 * draws the first twenty is worse than the scrollbar it replaced.
 */
function railLayout(count: number, height: number): { step: number; top: number } {
  const usable = height > 0 ? height - 24 : count * (MARK_HEIGHT + MAX_GAP);
  const spread = count > 1 ? (usable - count * MARK_HEIGHT) / (count - 1) : MAX_GAP;
  const gap = Math.max(MIN_GAP, Math.min(MAX_GAP, spread));
  const step = MARK_HEIGHT + gap;
  const groupHeight = count * MARK_HEIGHT + Math.max(0, count - 1) * gap;
  return { step, top: Math.max(12, (height - groupHeight) / 2) };
}

/** Dock-style magnification: nearest to the pointer is longest. */
function markWidth(center: number, pointerY: number | undefined): number {
  if (pointerY === undefined) return RESTING_WIDTH;
  const distance = Math.abs(pointerY - center);
  if (distance >= MAGNIFY_RANGE) return RESTING_WIDTH;
  const falloff = 0.5 * (1 + Math.cos((Math.PI * distance) / MAGNIFY_RANGE));
  return RESTING_WIDTH + (PEAK_WIDTH - RESTING_WIDTH) * falloff;
}

/** Keeps the card beside its mark without letting it hang off either end. */
function tooltipTop(markTop: number, height: number): number {
  const preferred = markTop - 22;
  if (height <= 0) return Math.max(8, preferred);
  return Math.max(8, Math.min(preferred, height - 72));
}
