import { Dropdown, Option, Text, makeStyles, tokens } from "@fluentui/react-components";
import {
  agentKindLabels,
  type AgentKind,
  type AgentParams,
  type SessionConfigChoice,
  type SessionConfigOption,
} from "@fleet/protocol";
import { observedChoices } from "../lib/session-config";

const useStyles = makeStyles({
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
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    "@media (max-width: 600px)": { flexWrap: "wrap" },
  },
  caption: { color: tokens.colorNeutralForeground3 },
  dropdown: { flexShrink: 0, minWidth: 0, width: "250px", maxWidth: "100%" },
});

export type ModelDefaultsCardProps = {
  sessions: readonly {
    configOptions: SessionConfigOption[];
    agentParams?: AgentParams | undefined;
  }[];
  kind?: AgentKind;
  model: string;
  reasoningEffort?: string | undefined;
  description: string;
  busy: boolean;
  onChange: (patch: { model?: string; reasoningEffort?: string }) => void;
};

const labelFor = (
  choices: readonly SessionConfigChoice[],
  value: string,
  fallback: string,
): string =>
  value === ""
    ? fallback
    : (choices.find((choice) => choice.value === value)?.name ?? value);

export function ModelDefaultsCard({
  sessions,
  kind = "copilot",
  model,
  reasoningEffort,
  description,
  busy,
  onChange,
}: ModelDefaultsCardProps) {
  const styles = useStyles();
  const label = agentKindLabels[kind];
  const fallback = kind === "hermes" ? "Hermes profile's choice" : `${label}'s choice`;
  const agentSessions = sessions.filter(
    (session) => (session.agentParams?.kind ?? "copilot") === kind,
  );
  const modelChoices = observedChoices(agentSessions, "model");
  const effortChoices = observedChoices(agentSessions, "reasoning_effort");

  return (
    <section className={styles.card} aria-label={`${label} model defaults`}>
      <div className={styles.row}>
        <div>
          <Text weight="semibold">{label} model</Text>
          <br />
          <Text className={styles.caption}>
            {description} A machine that does not offer the model says so and keeps its
            own.
          </Text>
        </div>
        <Dropdown
          className={styles.dropdown}
          disabled={busy || (modelChoices.length === 0 && model === "")}
          value={labelFor(modelChoices, model, fallback)}
          selectedOptions={[model]}
          onOptionSelect={(_event, data) =>
            onChange({ model: String(data.optionValue ?? "") })
          }
          aria-label={`Default ${label} model`}
        >
          <Option value="">{fallback}</Option>
          {modelChoices.map((choice) => (
            <Option key={choice.value} value={choice.value} title={choice.value}>
              {choice.name}
            </Option>
          ))}
        </Dropdown>
      </div>
      {reasoningEffort !== undefined && (
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
            disabled={busy || (effortChoices.length === 0 && reasoningEffort === "")}
            value={labelFor(effortChoices, reasoningEffort, fallback)}
            selectedOptions={[reasoningEffort]}
            onOptionSelect={(_event, data) =>
              onChange({ reasoningEffort: String(data.optionValue ?? "") })
            }
            aria-label={`Default ${label} reasoning effort`}
          >
            <Option value="">{fallback}</Option>
            {effortChoices.map((choice) => (
              <Option key={choice.value} value={choice.value}>
                {choice.name}
              </Option>
            ))}
          </Dropdown>
        </div>
      )}
      {kind === "hermes" && (
        <Text className={styles.caption}>
          Reasoning effort stays in the Hermes profile; its ACP interface does not offer a
          reasoning picker. This model default does not rewrite the profile.
        </Text>
      )}
      {modelChoices.length === 0 && (
        <Text className={styles.caption}>
          Nothing to choose from yet — the fleet learns which models exist from the{" "}
          {label} sessions it runs. Start one and come back.
        </Text>
      )}
    </section>
  );
}
