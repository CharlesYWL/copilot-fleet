import { useCallback, useEffect, useRef, useState } from "react";
import {
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
  tokens,
} from "@fluentui/react-components";
import type { SessionConfigChoice, SessionConfigOption } from "@fleet/protocol";
import { observedChoices } from "../lib/session-config";
import { api } from "../hooks/useFleet";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    maxWidth: "720px",
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
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  },
  hidden: {
    display: "none",
  },
});

type Defaults = {
  yolo: boolean;
  autoResume: boolean;
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
  sessions: readonly { configOptions: SessionConfigOption[] }[];
};

export const GeneralPanel = ({ sessions }: GeneralPanelProps) => {
  const styles = useStyles();
  const [defaults, setDefaults] = useState<Defaults>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<unknown>();
  const fileInput = useRef<HTMLInputElement>(null);

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
          body: JSON.stringify(patch),
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
        <Spinner label="Loading defaults…" />
      </div>
    );
  }

  const { yolo, autoResume, model, reasoningEffort } = defaults;
  const modelChoices = observedChoices(sessions, "model");
  const effortChoices = observedChoices(sessions, "reasoning_effort");

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Session defaults</Title3>
        <br />
        <Text className={styles.caption}>
          Applied when you open the new-session dialog. Each session keeps the value it
          was created with, so changing this never affects a running agent.
        </Text>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <section className={styles.card}>
        <div className={styles.row}>
          <div>
            <Text weight="semibold">YOLO mode</Text>
            <br />
            <Text className={styles.caption}>
              Starts Copilot with --allow-all so it runs tools, reads paths, and fetches
              URLs without asking.
            </Text>
          </div>
          <Switch
            checked={yolo}
            disabled={busy}
            label={yolo ? "On" : "Off"}
            onChange={(_event, data) => void update({ yolo: data.checked })}
          />
        </div>
      </section>

      {yolo && (
        <MessageBar intent="warning">
          <MessageBarBody>
            New sessions will execute commands on their node without approval. You can
            still turn this off for an individual session when starting it.
          </MessageBarBody>
        </MessageBar>
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
            <Text weight="semibold">Model</Text>
            <br />
            <Text className={styles.caption}>
              What every new session starts on, including orchestrators and the workers
              they dispatch. Set before the first prompt, so it governs the opening turn.
              A machine that does not offer the model says so and keeps its own.
            </Text>
          </div>
          <Dropdown
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

      <section className={styles.card}>
        <div>
          <Text weight="semibold">Move this Host</Text>
          <br />
          <Text className={styles.caption}>
            Download a file with workspaces, nodes, sessions, transcripts, and settings.
            Importing on another machine replaces everything there. The file includes the
            enrollment token — treat it like a secret. Quick-tunnel URLs are left out; a
            named hostname is kept. Node identities stay valid so existing machines can
            reconnect, but Copilot conversations still live on those machines.
          </Text>
        </div>
        <div className={styles.actions}>
          <Button
            appearance="primary"
            disabled={busy}
            onClick={() => void handleExport()}
          >
            Export fleet
          </Button>
          <Button
            appearance="secondary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Import fleet…
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
        open={confirmOpen}
        onOpenChange={(_event, data) => {
          if (!data.open) {
            setConfirmOpen(false);
            setPendingArchive(undefined);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Replace this Host?</DialogTitle>
            <DialogContent>
              <Text>
                Importing wipes workspaces, nodes, sessions, and settings on this machine
                and restores the archive. Connected nodes will drop and reconnect if their
                secrets still match.
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
