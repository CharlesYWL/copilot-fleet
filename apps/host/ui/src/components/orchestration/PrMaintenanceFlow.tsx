import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import {
  prMaintenancePhaseLabels,
  type PrMaintenancePhase,
  type PrMaintenanceStatus,
} from "@fleet/protocol";
import { semanticColors } from "../../theme";

const useStyles = makeStyles({
  flow: {
    listStyleType: "none",
    margin: "8px 0",
    padding: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
  },
  step: {
    padding: "4px 10px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "999px",
    color: tokens.colorNeutralForeground2,
  },
  current: {
    ...shorthands.borderColor(semanticColors.interaction),
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  waiting: {
    ...shorthands.borderColor(semanticColors.permission),
    color: tokens.colorNeutralForeground1,
  },
  arrow: { color: tokens.colorNeutralForeground3 },
  item: { display: "contents" },
  hold: {
    margin: "0 0 8px",
    paddingLeft: "10px",
    borderLeft: `3px solid ${semanticColors.permission}`,
  },
});

/** The order a person reads the loop in; the exceptional states follow it. */
const flow: readonly PrMaintenancePhase[] = [
  "reviewing",
  "working",
  "idle",
  "waiting_for_decision",
];

export type PrMaintenanceFlowProps = { status: PrMaintenanceStatus };

/**
 * The simplified maintenance loop with the current phase marked.
 *
 * Reviewing and Working alternate until there is nothing to do (Idle) or a
 * genuine design question (Waiting for Design Decision). A hold is shown
 * beside the phase, because a hold pauses the loop where it stands.
 */
export const PrMaintenanceFlow = ({ status }: PrMaintenanceFlowProps) => {
  const styles = useStyles();
  const terminal = ["merged", "closed", "released"].includes(status.phase);
  const steps: PrMaintenancePhase[] = terminal ? [...flow, status.phase] : [...flow];
  return (
    <>
      <ol className={styles.flow} aria-label="PR maintenance phases">
        {steps.map((phase, index) => (
          <li key={phase} className={styles.item}>
            {index > 0 ? (
              <span className={styles.arrow} aria-hidden>
                {phase === "working" ? "⇄" : "→"}
              </span>
            ) : null}
            <span
              aria-current={phase === status.phase ? "step" : undefined}
              className={mergeClasses(
                styles.step,
                phase === status.phase && styles.current,
                phase === status.phase &&
                  phase === "waiting_for_decision" &&
                  styles.waiting,
              )}
            >
              {prMaintenancePhaseLabels[phase]}
            </span>
          </li>
        ))}
      </ol>
      {status.hold ? (
        <p className={styles.hold} role="status">
          <strong>On hold: </strong>
          {status.reason}
        </p>
      ) : null}
    </>
  );
};
