import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Switch,
  Text,
  Title3,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  type AgentParams,
  type ContextTier,
  type HostUpdateStatus,
  type ManagedWorktreePolicy,
  type SessionConfigChoice,
  type SessionConfigOption,
} from "@fleet/protocol";
import { BookOpen20Regular } from "@fluentui/react-icons";
import { observedChoices } from "../lib/session-config";
import { api } from "../hooks/useFleet";
import { useMessageNotification } from "../hooks/useAppNotifications";
import { useSettingsActive } from "../hooks/useSettingsActivity";
import { HostUpdateCard } from "./HostUpdateCard";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    "@media (max-width: 600px)": { flexWrap: "wrap" },
  },
  settingTitle: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
  },
  staffBadge: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground2,
    ...shorthands.border("1px", "solid", "transparent"),
    backgroundImage: `linear-gradient(${tokens.colorNeutralBackground1}, ${tokens.colorNeutralBackground1}), linear-gradient(120deg, ${tokens.colorPaletteDarkOrangeBorderActive}, ${tokens.colorPaletteGreenBorderActive}, ${tokens.colorPaletteBlueBorderActive}, ${tokens.colorPalettePurpleBorderActive})`,
    backgroundOrigin: "border-box",
    backgroundClip: "padding-box, border-box",
    "@media (forced-colors: active)": {
      ...shorthands.borderColor("CanvasText"),
      backgroundImage: "none",
    },
  },
  dropdown: { minWidth: 0, width: "250px", maxWidth: "100%" },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  },
  warning: {
    flexShrink: 0,
    gridTemplateRows: "auto",
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  hidden: {
    display: "none",
  },
});

type Defaults = {
  managedWorktreesEnabled: boolean;
  managedWorktreesRevision: number;
  managedWorktreePolicy: ManagedWorktreePolicy;
  yolo: boolean;
  contextTier: ContextTier;
  agencyMode: boolean;
  agencyModeAvailable: boolean;
  autoResume: boolean;
  notificationLifecycleEnabled: boolean;
  model: string;
  reasoningEffort: string;
};

/** What to show on a closed dropdown, including for a value no longer offered. */
const labelFor = (choices: readonly SessionConfigChoice[], value: string): string => {
  if (value === "") return "Copilot's choice";
  return choices.find((choice) => choice.value === value)?.name ?? value;
};

const downloadJson = (value: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export type GeneralPanelProps = {
  /** Live sessions, read only to learn which models this fleet's Copilot offers. */
  sessions: readonly {
    configOptions: SessionConfigOption[];
    agentParams?: AgentParams | undefined;
  }[];
  onStartTour?: (() => void) | undefined;
  /** The Host's own update; the card is left out when the Host sends none. */
  hostUpdate?: HostUpdateStatus | undefined;
  hostRevision?: string | undefined;
};

const YOLO_WARNING =
  "New sessions will execute commands on their node without approval. You can still turn this off for an individual session when starting it.";

export const GeneralPanel = ({
  sessions,
  onStartTour,
  hostUpdate,
  hostRevision = "",
}: GeneralPanelProps) => {
  const styles = useStyles();
  const active = useSettingsActive();
  const [defaults, setDefaults] = useState<Defaults>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<unknown>();
  const fileInput = useRef<HTMLInputElement>(null);
  useMessageNotification(error);

  const refresh = useCallback(async () => {
    try {
      setDefaults(await api<Defaults>("/api/defaults"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = async (patch: Partial<Defaults>) => {
    setBusy(true);
    setError(undefined);
    try {
      setDefaults(
        await api<Defaults>("/api/defaults", {
          method: "POST",
          body: JSON.stringify({
            ...patch,
            ...(patch.managedWorktreesEnabled !== undefined ||
            patch.managedWorktreePolicy !== undefined
              ? {
                  operationId: crypto.randomUUID(),
                  expectedRevision: defaults?.managedWorktreesRevision ?? 0,
                }
              : {}),
          }),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const backup = await api<unknown>("/api/backup");
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(backup, `copilot-fleet-host-${stamp}.json`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handlePickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setPendingArchive(parsed);
      setConfirmOpen(true);
    } catch {
      setError("That file is not valid JSON.");
    }
  };

  const handleImport = async () => {
    if (pendingArchive === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/backup", {
        method: "POST",
        body: JSON.stringify(pendingArchive),
      });
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      setConfirmOpen(false);
      setPendingArchive(undefined);
    }
  };

  if (!defaults) {
    return (
      <div className={styles.panel}>
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        ) : (
          <Spinner label="Loading defaults…" />
        )}
      </div>
    );
  }

  const {
    managedWorktreesEnabled = false,
    yolo,
    contextTier = "long_context",
    agencyMode = false,
    agencyModeAvailable = false,
    autoResume,
    notificationLifecycleEnabled,
    model,
    reasoningEffort,
  } = defaults;
  const copilotSessions = sessions.filter(
    (session) => (session.agentParams?.kind ?? "copilot") === "copilot",
  );
  const modelChoices = observedChoices(copilotSessions, "model");
  const effortChoices = observedChoices(copilotSessions, "reasoning_effort");

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Session defaults</Title3>
        <br />
        <Text className={styles.caption}>
          Defaults for new sessions and fleet-wide launch behavior. Changing these
          settings never interrupts a running agent.
        </Text>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <section className={styles.card} aria-label="Managed worktree isolation">
        <div className={styles.row}>
          <div>
            <Text weight="semibold">Managed worktree isolation</Text>
            <br />
            <Text className={styles.caption}>
              Auto creates one isolated Git worktree per new repository task when enabled.
              Implementation, review, testing and fix-up share that task’s checkout and
              still allow only one shell-capable writer at a time. Different tasks can
              write concurrently; this is not a sandbox or a worktree per agent.
            </Text>
          </div>
          <Switch
            aria-label="Managed worktree isolation"
            checked={managedWorktreesEnabled}
            disabled={busy}
            label={managedWorktreesEnabled ? "On" : "Off"}
            onChange={(_, data) => void update({ managedWorktreesEnabled: data.checked })}
          />
        </div>
        <Text className={styles.caption}>
          Only new Auto tasks use this default. Explicit Legacy/Managed choices override
          it; existing tasks and live sessions never migrate. Managed tasks require an
          upgraded Node and an eligible committed Git repository. Approval does not merge,
          push or delete a checkout.
        </Text>
        {defaults.managedWorktreePolicy && (
          <details>
            <summary>Managed retention and quotas</summary>
            <ManagedQuotaEditor
              policy={defaults.managedWorktreePolicy}
              busy={busy}
              onSave={(policy) => void update({ managedWorktreePolicy: policy })}
            />
          </details>
        )}
      </section>

      {onStartTour && (
        <section className={styles.card} aria-label="Getting started">
          <Text weight="semibold" data-tour="tour-help">
            Getting started
          </Text>
          <Text className={styles.caption}>
            Walk from connecting a machine to your first session and Orchestrator task.
            The guide points out the controls without changing settings or starting agents
            for you.
          </Text>
          <div className={styles.actions}>
            <Button
              appearance="secondary"
              icon={<BookOpen20Regular />}
              onClick={onStartTour}
            >
              Take the tour
            </Button>
          </div>
        </section>
      )}

      <section className={styles.card} aria-label="Default context window">
        <div className={styles.row}>
          <div>
            <Text weight="semibold">Long context by default</Text>
            <br />
            <Text className={styles.caption}>
              Request --context long_context for new Copilot sessions, including Chats,
              Copilot orchestrators, and workers. Extended context can cost more; the
              window size depends on the model. Each chat can override this setting.
            </Text>
          </div>
          <Switch
            aria-label="Long context by default"
            checked={contextTier === "long_context"}
            disabled={busy}
            label={contextTier === "long_context" ? "On" : "Off"}
            onChange={(_event, data) =>
              void update({ contextTier: data.checked ? "long_context" : "default" })
            }
          />
        </div>
        <Text className={styles.caption}>
          Existing sessions keep their requested context tier when resumed. Changing this
          default does not restart running sessions. Some Copilot ACP versions ignore tier
          requests; check the reported window in the session usage popover.
        </Text>
      </section>

      <section className={styles.card}>
        <div className={styles.row}>
          <div>
            <Text weight="semibold" data-tour="session-defaults">
              YOLO mode
            </Text>
            <br />
            <Text className={styles.caption}>
              Starts Copilot with --allow-all so it runs tools, reads paths, and fetches
              URLs without asking.
            </Text>
          </div>
          <Switch
            aria-label="YOLO mode"
            checked={yolo}
            disabled={busy}
            label={yolo ? "On" : "Off"}
            onChange={(_event, data) => void update({ yolo: data.checked })}
          />
        </div>
      </section>

      {yolo && (
        <MessageBar className={styles.warning} intent="warning" layout="multiline">
          <MessageBarBody>{YOLO_WARNING}</MessageBarBody>
        </MessageBar>
      )}

      {agencyModeAvailable && (
        <section className={styles.card} aria-label="Agency mode">
          <div className={styles.row}>
            <div>
              <div className={styles.settingTitle}>
                <Text weight="semibold">Agency mode</Text>
                <Badge
                  className={styles.staffBadge}
                  appearance="outline"
                  size="medium"
                  title="Internal feature for Microsoft corporate accounts"
                >
                  Staff
                </Badge>
              </div>
              <Text className={styles.caption}>
                Use Agency Copilot for new and resumed Copilot sessions, including Chats,
                Copilot orchestrators, and workers. Each node uses its own Agency
                configuration and MCP servers. Nodes without Agency on PATH fall back to
                standard Copilot and report it in the session log.
              </Text>
            </div>
            <Switch
              aria-label="Agency mode"
              checked={agencyMode}
              disabled={busy}
              label={agencyMode ? "On" : "Off"}
              onChange={(_event, data) => void update({ agencyMode: data.checked })}
            />
          </div>
          <Text className={styles.caption}>
            Running sessions are not interrupted. Stop and resume them to change
            launchers. Install and sign in to Agency on each node before enabling this;
            authentication or startup errors are reported, not silently downgraded.
          </Text>
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.row}>
          <div>
            <Text weight="semibold">Reconnect sessions automatically</Text>
            <br />
            <Text className={styles.caption}>
              After a Host or node restart, re-attaches the sessions the node came back
              without, up to its capacity. Re-attaching reopens the conversation and waits
              — it sends no prompt, so nothing runs until you say so.
            </Text>
          </div>
          <Switch
            checked={autoResume}
            disabled={busy}
            label={autoResume ? "On" : "Off"}
            onChange={(_event, data) => void update({ autoResume: data.checked })}
          />
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.row}>
          <div>
            <Text weight="semibold">Lifecycle notifications</Text>
            <br />
            <Text className={styles.caption}>
              Application fallback for top-level and standalone agents. Dependency workers
              and reviewers remain Off by default unless you explicitly enable them for
              that agent.
            </Text>
          </div>
          <Switch
            checked={notificationLifecycleEnabled}
            disabled={busy}
            label={notificationLifecycleEnabled ? "On" : "Off"}
            aria-label="Lifecycle notifications for top-level agents"
            onChange={(_event, data) =>
              void update({ notificationLifecycleEnabled: data.checked })
            }
          />
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.row}>
          <div>
            <Text weight="semibold">Model</Text>
            <br />
            <Text className={styles.caption}>
              What new Copilot sessions start on, including Copilot orchestrators and
              workers. Other orchestrator agents use their own profile settings. A machine
              that does not offer the model says so and keeps its own.
            </Text>
          </div>
          <Dropdown
            className={styles.dropdown}
            disabled={busy || modelChoices.length === 0}
            value={labelFor(modelChoices, model)}
            selectedOptions={[model]}
            onOptionSelect={(_event, data) =>
              void update({ model: String(data.optionValue ?? "") })
            }
            aria-label="Default model"
          >
            <Option value="">Copilot's choice</Option>
            {modelChoices.map((choice) => (
              <Option key={choice.value} value={choice.value}>
                {choice.name}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={styles.row}>
          <div>
            <Text weight="semibold">Reasoning effort</Text>
            <br />
            <Text className={styles.caption}>
              How hard the model thinks before answering. Only some models offer it.
            </Text>
          </div>
          <Dropdown
            className={styles.dropdown}
            disabled={busy || effortChoices.length === 0}
            value={labelFor(effortChoices, reasoningEffort)}
            selectedOptions={[reasoningEffort]}
            onOptionSelect={(_event, data) =>
              void update({ reasoningEffort: String(data.optionValue ?? "") })
            }
            aria-label="Default reasoning effort"
          >
            <Option value="">Copilot's choice</Option>
            {effortChoices.map((choice) => (
              <Option key={choice.value} value={choice.value}>
                {choice.name}
              </Option>
            ))}
          </Dropdown>
        </div>
        {modelChoices.length === 0 && (
          <Text className={styles.caption}>
            {/*
             * Honest rather than empty: the list comes from what sessions have
             * reported, so before the first one the Host genuinely does not
             * know what this fleet's Copilot offers.
             */}
            Nothing to choose from yet — the fleet learns which models exist from the
            sessions it runs. Start one and come back.
          </Text>
        )}
      </section>

      {hostUpdate && <HostUpdateCard status={hostUpdate} revision={hostRevision} />}

      <section className={styles.card} aria-label="Fleet data archive">
        <div>
          <Text weight="semibold">Export fleet data</Text>
          <br />
          <Text className={styles.caption}>
            Downloads workspaces, nodes, sessions, transcripts and session settings.
            Importing on another machine replaces all of that there. This file{" "}
            <strong>does not carry</strong> who may administer this Host: the
            administrator list, the Microsoft registration, this Host&apos;s signing key
            and its Node credentials stay behind, and importing deliberately leaves the
            receiving machine&apos;s own security settings intact. To move a Host itself,
            use the portable backup in <strong>Settings → Security</strong>. Quick-tunnel
            URLs are left out; a named hostname is kept. Copilot conversations still live
            on the machines that ran them.
          </Text>
        </div>
        <div className={styles.actions}>
          <Button
            appearance="primary"
            disabled={busy}
            onClick={() => void handleExport()}
          >
            Export fleet data
          </Button>
          <Button
            appearance="secondary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Import fleet data…
          </Button>
        </div>
        <input
          ref={fileInput}
          className={styles.hidden}
          type="file"
          accept="application/json,.json"
          aria-label="Choose a Host archive to import"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handlePickFile(file);
          }}
        />
      </section>

      <Dialog
        open={active && confirmOpen}
        onOpenChange={(_event, data) => {
          if (!data.open) {
            setConfirmOpen(false);
            setPendingArchive(undefined);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Replace this fleet&apos;s data?</DialogTitle>
            <DialogContent>
              <Text>
                Importing wipes workspaces, nodes, sessions and session settings on this
                machine and restores the archive. Who may administer this Host is left
                exactly as it is. Connected nodes will drop and reconnect if their
                credentials still match.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirmOpen(false);
                  setPendingArchive(undefined);
                }}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => void handleImport()}
              >
                {busy ? "Importing…" : "Replace and import"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
};

function ManagedQuotaEditor({
  policy,
  busy,
  onSave,
}: {
  policy: ManagedWorktreePolicy;
  busy: boolean;
  onSave: (policy: ManagedWorktreePolicy) => void;
}) {
  const [draft, setDraft] = useState(policy);
  const fields = [
    ["retentionDays", "Clean integrated retention (days)", 1],
    ["maxPerRepository", "Maximum worktrees per repository", 1],
    ["maxPerNode", "Maximum worktrees per Node", 1],
    ["freeSpaceFloorBytes", "Free-space floor (bytes)", 0],
    ["byteBudget", "Approximate Node worktree budget (bytes)", 1],
  ] as const;
  return (
    <div>
      <p>
        Only clean, integrated, inactive checkouts may expire. Dirty or unknown work is
        never evicted.
      </p>
      {fields.map(([key, label, min]) => (
        <label key={key} style={{ display: "block", marginBottom: 8 }}>
          {label}{" "}
          <input
            type="number"
            min={min}
            aria-label={label}
            value={draft[key]}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, [key]: Number(event.target.value) })
            }
          />
        </label>
      ))}
      <Button disabled={busy} onClick={() => onSave(draft)}>
        Save managed quotas
      </Button>
    </div>
  );
}
