import { useId, useRef, useState, type FocusEvent } from "react";
import {
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  tokens,
  type PositioningImperativeRef,
} from "@fluentui/react-components";
import { agentKindLabels, type AgentKind, type SessionUsage } from "@fleet/protocol";

const useStyles = makeStyles({
  trigger: {
    flexShrink: 0,
    minWidth: "28px",
    width: "28px",
    height: "28px",
    padding: 0,
    color: tokens.colorNeutralForeground3,
  },
  track: { stroke: tokens.colorNeutralStroke2 },
  progress: { stroke: tokens.colorBrandForeground1 },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "12px",
    width: "min(300px, calc(100vw - 24px))",
    maxHeight: "min(420px, calc(100vh - 24px))",
    boxSizing: "border-box",
    overflowY: "auto",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontVariantNumeric: "tabular-nums",
  },
  heading: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  details: {
    display: "grid",
    flexShrink: 0,
    gap: "4px",
    overflowWrap: "anywhere",
  },
  detail: {
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
  },
  reporting: {
    minHeight: 0,
    overflowY: "auto",
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
  },
  summary: {
    cursor: "pointer",
    ":focus-visible": {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: "-2px",
    },
  },
  reportingBody: {
    display: "grid",
    gap: "8px",
    paddingTop: "8px",
    overflowWrap: "anywhere",
  },
  compact: {
    display: "flex",
    flexShrink: 0,
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "4px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "8px",
  },
  metric: {
    display: "flex",
    flexShrink: 0,
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
  },
});

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const exactCredits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 9 });

export function SessionUsageBar({
  agentKind = "copilot",
  usage,
  canCompact,
  compactAvailable,
  onCompact,
}: {
  agentKind?: AgentKind;
  usage: SessionUsage | undefined;
  canCompact: boolean;
  compactAvailable: boolean;
  onCompact: () => void;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const restoringFocus = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLButtonElement>(null);
  const positioningRef = useRef<PositioningImperativeRef>(null);
  const explanationId = useId();
  const credits = usage?.aiCredits;
  const context = usage?.context;
  const fromAcp = context?.source === "acp";
  const used = usage?.contextTokens;
  const size = usage?.contextWindow;
  const hasUsed = used != null && Number.isFinite(used) && used >= 0;
  const hasSize = size != null && Number.isFinite(size) && size > 0;
  const percentage =
    context && Number.isFinite(context.percentage) && context.percentage >= 0
      ? context.percentage
      : undefined;
  const estimate = context?.estimated ? "~" : "";
  const creditLabel =
    credits == null
      ? "?"
      : credits > 0 && credits < 0.01
        ? "<0.01"
        : number.format(credits);
  const compactExplanation = !compactAvailable
    ? "This agent has not offered /compact."
    : !canCompact
      ? "Wait for the session to be idle before compacting."
      : "Summarize older turns. Your saved transcript and draft are kept.";
  const focusWithin = (target: EventTarget | null) =>
    target instanceof Node &&
    (triggerRef.current?.contains(target) || panelRef.current?.contains(target));
  const closeOnBlur = (event: FocusEvent<HTMLElement>) => {
    if (focusWithin(event.relatedTarget)) return;
    pinned.current = false;
    setOpen(false);
  };

  return (
    <Popover
      positioning={{
        position: "above",
        align: "end",
        autoSize: "height",
        positioningRef,
      }}
      openOnHover
      open={open}
      unstable_disableAutoFocus
      onOpenChange={(event, data) => {
        // Focus/hover previews must not make the first click close the panel.
        if (
          event.type === "click" &&
          triggerRef.current?.contains(event.target as Node)
        ) {
          pinned.current = !pinned.current;
          setOpen(pinned.current);
          return;
        }
        if (
          event.type === "mouseleave" &&
          (pinned.current ||
            focusWithin(triggerRef.current?.ownerDocument.activeElement ?? null))
        )
          return;
        if (!data.open) {
          pinned.current = false;
          if (
            event.type === "keydown" &&
            panelRef.current?.contains(event.target as Node)
          ) {
            restoringFocus.current = true;
            triggerRef.current?.focus();
            restoringFocus.current = false;
          }
        }
        setOpen(data.open);
      }}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          ref={(element) => {
            triggerRef.current = element;
          }}
          className={styles.trigger}
          appearance="subtle"
          shape="circular"
          type="button"
          aria-label={
            percentage === undefined
              ? "Session usage unavailable"
              : `Session context usage: ${context?.estimated ? "approximately " : ""}${number.format(percentage)}% used`
          }
          onFocus={() => {
            if (!restoringFocus.current) setOpen(true);
          }}
          onBlur={closeOnBlur}
          onKeyDown={(event) => {
            if (
              event.key === "ArrowDown" ||
              (event.key === "Tab" && !event.shiftKey && open)
            ) {
              const target = compactRef.current?.disabled
                ? panelRef.current
                : compactRef.current;
              if (target) {
                event.preventDefault();
                target.focus();
              }
            }
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle
              className={styles.track}
              cx="10"
              cy="10"
              r="7"
              fill="none"
              strokeWidth="2"
            />
            {percentage !== undefined ? (
              <circle
                className={styles.progress}
                cx="10"
                cy="10"
                r="7"
                fill="none"
                strokeWidth="2"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - Math.min(100, percentage)}
                transform="rotate(-90 10 10)"
              />
            ) : (
              <text
                x="10"
                y="10"
                dy=".35em"
                textAnchor="middle"
                fill="currentColor"
                fontSize="9"
              >
                ?
              </text>
            )}
          </svg>
        </Button>
      </PopoverTrigger>
      <PopoverSurface
        ref={(element) => {
          panelRef.current = element;
        }}
        className={styles.panel}
        aria-label="Session usage"
        tabIndex={-1}
        onBlur={closeOnBlur}
      >
        <span className={styles.heading}>Session usage</span>
        <div className={styles.metric}>
          <span>Agent</span>
          <strong>{agentKindLabels[agentKind]}</strong>
        </div>
        <div className={styles.metric}>
          <span>AI credits</span>
          <strong
            title={
              credits == null
                ? "Billed AI credits have not been reported for this session."
                : `${exactCredits.format(credits)} AI credits used in this session.`
            }
          >
            {creditLabel}
          </strong>
        </div>
        <div className={styles.details}>
          <div className={styles.metric}>
            <span>Context window</span>
            <strong>
              {percentage === undefined
                ? "? (Usage unavailable)"
                : `${estimate}${number.format(percentage)}% used`}
            </strong>
          </div>
          {context ? (
            <>
              <span>
                {estimate}
                {number.format(context.usedTokens)} / {estimate}
                {number.format(context.tokenLimit)} tokens
              </span>
              {context.model && (
                <span className={styles.detail}>Model: {context.model}</span>
              )}
              <span className={styles.detail}>
                {fromAcp ? `${agentKindLabels[agentKind]} ACP` : "CLI /context"} · Updated
                (local):{" "}
                <time dateTime={context.updatedAt} title={context.updatedAt}>
                  {new Date(context.updatedAt).toLocaleString()}
                </time>
              </span>
            </>
          ) : (
            <span className={styles.detail}>
              {agentKind === "copilot"
                ? "No /context snapshot yet."
                : "No context usage reported yet."}
            </span>
          )}
        </div>
        <details
          className={styles.reporting}
          onToggle={() => positioningRef.current?.updatePosition()}
        >
          <summary className={styles.summary}>Reporting details</summary>
          <div className={styles.reportingBody}>
            <span>
              {fromAcp
                ? "Estimated context pressure reported by the agent over ACP."
                : agentKind !== "copilot"
                  ? "Usage is shown only when the agent reports it. Unreported metrics stay unknown."
                  : context
                    ? context.estimated
                      ? "Estimated from CLI's rounded /context report. Refreshed after turns."
                      : "Last /context snapshot. Refreshed after turns."
                    : "The requested context tier does not confirm the actual window."}
            </span>
            {hasUsed || hasSize ? (
              <div className={styles.details}>
                <span>
                  {agentKind === "copilot"
                    ? "Last ACP input tokens / input budget"
                    : "Last ACP context tokens / context window"}
                </span>
                <span>
                  {hasUsed ? number.format(used) : "?"} /{" "}
                  {hasSize ? number.format(size) : "?"} tokens
                </span>
                <span>
                  {agentKind === "copilot"
                    ? "Not the full context window. Reported separately from /context; timing may differ. ACP timestamp unavailable."
                    : "Agent-reported values, not measured or inferred by Fleet."}
                </span>
              </div>
            ) : null}
          </div>
        </details>
        <div className={styles.compact}>
          <Button
            ref={(element) => {
              compactRef.current = element;
            }}
            appearance="subtle"
            size="small"
            type="button"
            aria-label="Compact context"
            aria-describedby={explanationId}
            title={compactExplanation}
            disabled={!canCompact || !compactAvailable}
            onClick={onCompact}
          >
            Compact
          </Button>
          <span
            id={explanationId}
            className={styles.detail}
            hidden={canCompact && compactAvailable}
          >
            {compactExplanation}
          </span>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
