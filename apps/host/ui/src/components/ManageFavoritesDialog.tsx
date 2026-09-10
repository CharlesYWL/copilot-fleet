import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronDown20Regular,
  ChevronRight20Regular,
  Search16Regular,
} from "@fluentui/react-icons";
import type { FleetSession } from "@fleet/protocol";
import { sessionLabel } from "../lib/session-label";

const useStyles = makeStyles({
  surface: { width: "min(520px, calc(100vw - 32px))" },
  intro: {
    marginTop: 0,
    color: tokens.colorNeutralForeground3,
  },
  search: { width: "100%", marginBottom: "12px" },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    maxHeight: "55vh",
    overflowY: "auto",
  },
  group: { display: "flex", flexDirection: "column", gap: "2px" },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    width: "100%",
    padding: "5px 4px",
    border: 0,
    color: tokens.colorNeutralForeground2,
    background: "transparent",
    font: "inherit",
    fontWeight: tokens.fontWeightSemibold,
    textAlign: "left",
    cursor: "pointer",
    ":hover": { background: tokens.colorNeutralBackground2 },
  },
  groupName: {
    padding: "4px 8px 2px 28px",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  item: {
    padding: "5px 8px",
    borderRadius: tokens.borderRadiusMedium,
    ":hover": { background: tokens.colorNeutralBackground2 },
  },
  empty: {
    margin: "8px",
    color: tokens.colorNeutralForeground3,
  },
});

export type ManageFavoritesDialogProps = {
  open: boolean;
  sessions: readonly FleetSession[];
  onClose: () => void;
  onSave: (sessionIds: string[]) => Promise<boolean>;
};

export const ManageFavoritesDialog = ({
  open,
  sessions,
  onClose,
  onSave,
}: ManageFavoritesDialogProps) => {
  const styles = useStyles();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const eligibleSessions = useMemo(
    () =>
      sessions.filter((session) => session.runRole === "" || session.runRole === "lead"),
    [sessions],
  );
  const visibleSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return eligibleSessions;
    return eligibleSessions.filter((session) =>
      sessionLabel(session).toLocaleLowerCase().includes(query),
    );
  }, [eligibleSessions, search]);
  const orchestrators = visibleSessions.filter((session) => session.runRole === "lead");
  const chatGroups = useMemo(() => {
    const grouped = new Map<string, FleetSession[]>();
    for (const session of visibleSessions) {
      if (session.runRole !== "") continue;
      grouped.set(session.workspaceName, [
        ...(grouped.get(session.workspaceName) ?? []),
        session,
      ]);
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [visibleSessions]);

  useEffect(() => {
    if (!open) return;
    setSelected(
      new Set(
        eligibleSessions
          .filter((session) => session.favorite)
          .map((session) => session.id),
      ),
    );
    setSaving(false);
    setSearch("");
    setClosed(new Set());
  }, [eligibleSessions, open]);

  const toggle = (sessionId: string, favorite: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (favorite) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };
  const toggleGroup = (group: string) => {
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(_event, data) => !data.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Manage favorites</DialogTitle>
          <DialogContent>
            <p className={styles.intro}>
              Choose the chats and orchestrator conversations shown in Favorites.
              Orchestration dependency agents are hidden.
            </p>
            <Input
              className={styles.search}
              value={search}
              contentBefore={<Search16Regular />}
              placeholder="Filter by name"
              aria-label="Filter favorites by name"
              onChange={(_event, data) => setSearch(data.value)}
            />
            <div className={styles.list}>
              {orchestrators.length > 0 && (
                <section className={styles.group}>
                  <button
                    type="button"
                    className={styles.groupHeader}
                    aria-expanded={!closed.has("Orchestrators")}
                    onClick={() => toggleGroup("Orchestrators")}
                  >
                    {closed.has("Orchestrators") ? (
                      <ChevronRight20Regular />
                    ) : (
                      <ChevronDown20Regular />
                    )}
                    Orchestrators ({orchestrators.length})
                  </button>
                  {!closed.has("Orchestrators") &&
                    orchestrators.map((session) => (
                      <Checkbox
                        className={styles.item}
                        key={session.id}
                        checked={selected.has(session.id)}
                        label={sessionLabel(session)}
                        onChange={(_event, data) =>
                          toggle(session.id, data.checked === true)
                        }
                      />
                    ))}
                </section>
              )}
              {chatGroups.length > 0 && (
                <section className={styles.group}>
                  <button
                    type="button"
                    className={styles.groupHeader}
                    aria-expanded={!closed.has("Chats")}
                    onClick={() => toggleGroup("Chats")}
                  >
                    {closed.has("Chats") ? (
                      <ChevronRight20Regular />
                    ) : (
                      <ChevronDown20Regular />
                    )}
                    Chats (
                    {chatGroups.reduce((count, [, entries]) => count + entries.length, 0)}
                    )
                  </button>
                  {!closed.has("Chats") &&
                    chatGroups.map(([workspace, entries]) => (
                      <div className={styles.group} key={workspace}>
                        <span className={styles.groupName}>{workspace}</span>
                        {entries.map((session) => (
                          <Checkbox
                            className={styles.item}
                            key={session.id}
                            checked={selected.has(session.id)}
                            label={sessionLabel(session)}
                            onChange={(_event, data) =>
                              toggle(session.id, data.checked === true)
                            }
                          />
                        ))}
                      </div>
                    ))}
                </section>
              )}
              {orchestrators.length === 0 && chatGroups.length === 0 && (
                <p className={styles.empty}>No matching chats.</p>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onSave([...selected]).then((ok) => {
                  setSaving(false);
                  if (ok) onClose();
                });
              }}
            >
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
