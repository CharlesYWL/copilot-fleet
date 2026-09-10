import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Stop20Regular } from "@fluentui/react-icons";
import type { FleetSession } from "@fleet/protocol";
import { sessionLabel } from "../lib/session-label";

const useStyles = makeStyles({
  surface: { width: "min(560px, calc(100vw - 32px))" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    paddingBottom: "8px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  count: {
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    maxHeight: "55vh",
    overflowY: "auto",
    paddingTop: "8px",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  groupHeader: {
    padding: "4px 6px",
    fontWeight: tokens.fontWeightSemibold,
  },
  agent: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginLeft: "24px",
    padding: "6px 8px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  agentText: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
  },
  agentName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  agentMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export type AgentBulkStopDialogProps = {
  open: boolean;
  title: string;
  agents: readonly FleetSession[];
  onClose: () => void;
  onStop: (sessionIds: string[]) => Promise<boolean>;
};

export const AgentBulkStopDialog = ({
  open,
  title,
  agents,
  onClose,
  onStop,
}: AgentBulkStopDialogProps) => {
  const styles = useStyles();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const groups = useMemo(() => {
    const grouped = new Map<string, FleetSession[]>();
    for (const agent of agents) {
      const key = agent.workspaceName || "Other";
      grouped.set(key, [...(grouped.get(key) ?? []), agent]);
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [agents]);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(agents.map((agent) => agent.id)));
    setSubmitting(false);
  }, [open, agents]);

  const setMany = (ids: readonly string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const allChecked = agents.length > 0 && selected.size === agents.length;
  const allState = allChecked ? true : selected.size > 0 ? "mixed" : false;

  return (
    <Dialog open={open} onOpenChange={(_event, data) => !data.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <div className={styles.toolbar}>
              <Checkbox
                checked={allState}
                label="Select all agents"
                onChange={(_event, data) =>
                  setMany(
                    agents.map((agent) => agent.id),
                    data.checked === true,
                  )
                }
              />
              <span className={styles.count}>{selected.size} selected</span>
            </div>
            <div className={styles.list}>
              {groups.map(([workspaceName, groupAgents]) => {
                const selectedInGroup = groupAgents.filter((agent) =>
                  selected.has(agent.id),
                ).length;
                const checked =
                  selectedInGroup === groupAgents.length
                    ? true
                    : selectedInGroup > 0
                      ? "mixed"
                      : false;
                return (
                  <section className={styles.group} key={workspaceName}>
                    <Checkbox
                      className={styles.groupHeader}
                      checked={checked}
                      label={`${workspaceName} (${groupAgents.length})`}
                      onChange={(_event, data) =>
                        setMany(
                          groupAgents.map((agent) => agent.id),
                          data.checked === true,
                        )
                      }
                    />
                    {groupAgents.map((agent) => (
                      <div className={styles.agent} key={agent.id}>
                        <Checkbox
                          checked={selected.has(agent.id)}
                          onChange={(_event, data) =>
                            setMany([agent.id], data.checked === true)
                          }
                          aria-label={`Select ${sessionLabel(agent)}`}
                        />
                        <span className={styles.agentText}>
                          <span className={styles.agentName}>{sessionLabel(agent)}</span>
                          <span className={styles.agentMeta}>{agent.nodeName}</span>
                        </span>
                      </div>
                    ))}
                  </section>
                );
              })}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={submitting} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              icon={<Stop20Regular />}
              disabled={selected.size === 0 || submitting}
              onClick={() => {
                setSubmitting(true);
                void onStop([...selected]).then((ok) => {
                  setSubmitting(false);
                  if (ok) onClose();
                });
              }}
            >
              Stop selected ({selected.size})
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
