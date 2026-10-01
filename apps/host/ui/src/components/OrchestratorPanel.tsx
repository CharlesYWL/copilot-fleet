import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  AgentKindSchema,
  AgentParamsSchema,
  DEFAULT_HERMES_PROFILE,
  DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE,
  HermesProfileSchema,
  agentKindLabels,
  heartbeatScheduleProblem,
  normalizeHeartbeatSchedule,
  supportsAgentKind,
  type AgentParams,
  type FleetNode,
} from "@fleet/protocol";
import { api } from "../hooks/useFleet";
import { useMessageNotification } from "../hooks/useAppNotifications";
import { terminal } from "../theme";
import { CopyButton } from "./CopyButton";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    "@media (max-width: 600px)": { padding: "20px 16px" },
  },
  caption: { color: tokens.colorNeutralForeground3 },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    minWidth: 0,
  },
  dropdown: { width: "280px", maxWidth: "100%", minWidth: 0 },
  actions: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" },
  code: {
    fontFamily: terminal.font,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    margin: 0,
    fontSize: tokens.fontSizeBase200,
  },
});

type Defaults = {
  orchestratorAgent?: AgentParams | null;
  orchestratorHeartbeatSchedule?: string;
  orchestratorHeartbeatTimeZone?: string;
  orchestratorHeartbeatUpcoming?: string[];
};

export function OrchestratorPanel({ nodes }: { nodes: readonly FleetNode[] }) {
  const styles = useStyles();
  const [defaults, setDefaults] = useState<Defaults>();
  const [draft, setDraft] = useState<AgentParams | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useMessageNotification(error);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const loaded = await api<Defaults>("/api/defaults");
      setDefaults(loaded);
      setDraft(loaded.orchestratorAgent ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const update = async (patch: Defaults) => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api<Defaults>("/api/defaults", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      setDefaults(saved);
      if ("orchestratorAgent" in patch) setDraft(saved.orchestratorAgent ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!defaults)
    return (
      <div className={styles.panel}>
        {error ? (
          <>
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
            <Button onClick={() => void load()}>Retry</Button>
          </>
        ) : (
          <Spinner label="Loading orchestrator settings..." />
        )}
      </div>
    );

  const selected = draft?.kind ?? "auto";
  const available = nodes.filter(
    (node) => node.online && supportsAgentKind(node, draft?.kind ?? "copilot"),
  );
  const choices = AgentKindSchema.options.filter(
    (kind) =>
      kind === "copilot" ||
      kind === draft?.kind ||
      kind === defaults.orchestratorAgent?.kind ||
      nodes.some((node) => supportsAgentKind(node, kind)),
  );
  const parsed = AgentParamsSchema.nullable().safeParse(draft);
  const changed =
    parsed.success &&
    JSON.stringify(parsed.data) !== JSON.stringify(defaults.orchestratorAgent ?? null);
  const profile =
    draft?.kind === "hermes" ? HermesProfileSchema.safeParse(draft.profile) : undefined;
  const setup = profile?.success
    ? [
        `hermes profile create ${profile.data} --no-alias`,
        `hermes -p ${profile.data} acp --setup`,
        `hermes -p ${profile.data} acp --check`,
      ].join("\n")
    : undefined;

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Orchestrator</Title3>
        <br />
        <Text className={styles.caption}>
          Choose the agent that coordinates your tasks and when it checks on them. Workers
          continue using Copilot.
        </Text>
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <section className={styles.card} aria-label="Orchestrator agent">
        <Field label="Preferred agent">
          <Dropdown
            className={styles.dropdown}
            aria-label="Preferred agent"
            disabled={busy}
            value={draft ? agentKindLabels[draft.kind] : "Auto (Copilot)"}
            selectedOptions={[selected]}
            onOptionSelect={(_event, data) => {
              if (data.optionValue === "auto") setDraft(null);
              else if (data.optionValue === "copilot") setDraft({ kind: "copilot" });
              else if (data.optionValue === "hermes")
                setDraft({
                  kind: "hermes",
                  profile:
                    defaults.orchestratorAgent?.kind === "hermes"
                      ? defaults.orchestratorAgent.profile
                      : DEFAULT_HERMES_PROFILE,
                });
            }}
          >
            <Option value="auto">Auto (Copilot)</Option>
            {choices.map((kind) => (
              <Option key={kind} value={kind}>
                {agentKindLabels[kind]}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Text className={styles.caption}>
          {available.length
            ? `Detected on online Nodes: ${available.map((node) => node.name).join(", ")}.`
            : "No online Node reports this agent."}{" "}
          Detection confirms installation, not profile setup or sign-in.
        </Text>
        {draft?.kind === "hermes" && (
          <>
            <Field
              label="Hermes profile"
              validationState={profile?.success ? "none" : "error"}
              validationMessage={
                profile && !profile.success
                  ? (profile.error.issues[0]?.message ?? null)
                  : null
              }
              hint="One active Hermes orchestrator per profile per Node. Memory and skills stay with that profile on that Node."
            >
              <Input
                aria-label="Hermes profile"
                value={draft.profile}
                disabled={busy}
                maxLength={64}
                onChange={(_event, data) =>
                  setDraft({ kind: "hermes", profile: data.value })
                }
              />
            </Field>
            {setup && (
              <div>
                <div className={styles.actions}>
                  <Text weight="semibold">Set up once on each Node</Text>
                  <CopyButton text={setup} label="Copy Hermes setup commands" />
                </div>
                <pre className={styles.code}>{setup}</pre>
                <Text className={styles.caption}>
                  Skip creation if the profile already exists. Setup is interactive; the
                  check verifies ACP dependencies, not a model request. Fleet does not
                  create profiles, copy credentials, or synchronize memory. Do not use
                  this profile in another Hermes process while Fleet runs it.
                </Text>
              </div>
            )}
          </>
        )}
        <Text className={styles.caption}>
          Applies to new orchestrators. Existing ones keep their agent and profile,
          including after restart. Auto always means Copilot.
        </Text>
        <Text className={styles.caption}>
          New orchestrators fall back to Copilot, with a transcript notice, when no online
          Node holding the workspace has the preferred agent. Profile, authentication, and
          startup errors are reported instead of switching agents. Hermes uses its
          profile&apos;s model settings; General defaults apply to Copilot.
        </Text>
        <div className={styles.actions}>
          <Button
            appearance="primary"
            disabled={busy || !changed}
            onClick={() => {
              if (parsed.success) void update({ orchestratorAgent: parsed.data });
            }}
          >
            Save agent
          </Button>
        </div>
      </section>
      <HeartbeatScheduleCard
        schedule={
          defaults.orchestratorHeartbeatSchedule ??
          DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE
        }
        timeZone={defaults.orchestratorHeartbeatTimeZone}
        upcoming={defaults.orchestratorHeartbeatUpcoming ?? []}
        busy={busy}
        onSave={(schedule) => void update({ orchestratorHeartbeatSchedule: schedule })}
      />
      <Text className={styles.caption}>
        Hermes conversation history stays in its profile. Fleet&apos;s automatic
        native-session retention currently applies only to Copilot.
      </Text>
    </div>
  );
}

const heartbeatTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

function HeartbeatScheduleCard({
  schedule,
  timeZone,
  upcoming,
  busy,
  onSave,
}: {
  schedule: string;
  timeZone: string | undefined;
  upcoming: readonly string[];
  busy: boolean;
  onSave: (schedule: string) => void;
}) {
  const styles = useStyles();
  const [draft, setDraft] = useState(schedule);
  const [shown, setShown] = useState(schedule);
  if (shown !== schedule) {
    setShown(schedule);
    setDraft(schedule);
  }
  const problem = heartbeatScheduleProblem(draft);
  const changed = normalizeHeartbeatSchedule(draft) !== schedule;
  const hint = problem
    ? null
    : changed
      ? "Not saved yet."
      : upcoming.length
        ? `Next: ${upcoming.map(heartbeatTime).join(" \u00b7 ")}`
        : null;
  return (
    <section className={styles.card} aria-label="Orchestrator heartbeat">
      <div>
        <Text weight="semibold">Orchestrator heartbeat</Text>
        <br />
        <Text className={styles.caption}>
          When an idle orchestrator reviews its open tasks and maintained PRs. Cron times
          (minute, hour, day of month, month, weekday) use the Host&apos;s time zone
          {timeZone ? ` (${timeZone})` : ""}; separate expressions with <code>;</code>. An
          orchestrator active in the previous half hour skips the heartbeat. PRs are not
          read while their worker is still repairing them.
        </Text>
      </div>
      <Field
        label="Schedule"
        validationState={problem ? "error" : "none"}
        validationMessage={problem ?? null}
        hint={hint}
      >
        <Input
          aria-label="Heartbeat schedule"
          value={draft}
          disabled={busy}
          onChange={(_event, data) => setDraft(data.value)}
        />
      </Field>
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={busy || Boolean(problem) || !changed}
          onClick={() => onSave(draft)}
        >
          Save schedule
        </Button>
        <Button
          appearance="secondary"
          disabled={busy || draft === DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE}
          onClick={() => setDraft(DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE)}
        >
          Use default
        </Button>
      </div>
      <Text className={styles.caption}>
        The default, <code>{DEFAULT_ORCHESTRATOR_HEARTBEAT_SCHEDULE}</code>, is hourly
        from 09:00 to 18:00 on weekdays and every two hours otherwise.
      </Text>
    </section>
  );
}
