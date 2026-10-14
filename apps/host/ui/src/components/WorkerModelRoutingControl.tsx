import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Tab,
  TabList,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDown16Regular,
  ArrowUp16Regular,
  Dismiss16Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import {
  DecisionProviderDraftSchema,
  UpdateWorkerRoutingSchema,
  WORKER_CATEGORIES,
  errorMessage,
  type DecisionConnectionTest,
  type DecisionProviderDraft,
  type UpdateWorkerRouting,
  type WorkerExecutionProfile,
  type WorkerRoutingSettings,
} from "@fleet/protocol";
import { api, ApiError } from "../hooks/useFleet";
import { useSettingsActive } from "../hooks/useSettingsActivity";
import {
  confirmIdentityInNewTab,
  forgetCsrfToken,
  onIdentityConfirmed,
} from "../lib/auth";
import { observedChoices } from "../lib/session-config";
import { terminal } from "../theme";
import type { ModelDefaultsCardProps } from "./ModelDefaultsCard";

const useStyles = makeStyles({
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
  },
  control: {
    display: "grid",
    gap: "8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "14px",
  },
  label: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  mono: {
    fontFamily: terminal.font,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  dialog: {
    width: "min(900px, calc(100vw - 32px))",
    maxWidth: "900px",
    maxHeight: "calc(100dvh - 32px)",
    display: "flex",
  },
  body: {
    width: "100%",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  content: {
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    overflowY: "auto",
    paddingRight: "4px",
    "& > *": { flexShrink: 0 },
  },
  message: {
    flexShrink: 0,
    gridTemplateRows: "auto",
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  tabs: { flexWrap: "wrap", flexShrink: 0 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "12px",
    "@media (max-width: 600px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  limits: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "12px",
    "@media (max-width: 600px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  list: { display: "grid", gap: "12px", padding: 0, margin: 0, listStyleType: "none" },
  addAction: { justifySelf: "start" },
  editor: {
    minWidth: 0,
    margin: 0,
    padding: "16px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    display: "grid",
    gap: "14px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    justifyContent: "space-between",
    flexWrap: "wrap",
  },
  actions: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" },
  dropdown: { width: "100%", minWidth: 0 },
  checkboxGroup: { display: "flex", flexWrap: "wrap", gap: "4px" },
  summary: {
    cursor: "pointer",
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: "anywhere",
  },
  profileContent: { display: "grid", gap: "12px", paddingTop: "14px" },
  diff: {
    margin: 0,
    padding: "12px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: terminal.font,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: "260px",
    overflowY: "auto",
  },
});

type ProviderForm = DecisionProviderDraft & {
  keyConfigured: boolean;
  ready: boolean;
  result?: DecisionConnectionTest | undefined;
};
type Draft = Omit<UpdateWorkerRouting, "providers" | "minProbability" | "timeoutMs"> & {
  providers: ProviderForm[];
  minProbability: string;
  timeoutSeconds: string;
};

const modes = { off: "Off", shadow: "Shadow", route: "Route new workers" } as const;
const providerNames = { foundry: "Azure AI Foundry", typesafe: "TypeSafe" } as const;
const fromSettings = (settings: WorkerRoutingSettings): Draft => ({
  expectedRevision: settings.revision,
  mode: settings.mode,
  minProbability: String(settings.minProbability),
  timeoutSeconds: String(settings.timeoutMs / 1000),
  profiles: settings.profiles.map((profile) => ({
    ...profile,
    categories: [...profile.categories],
  })),
  providers: settings.providers.map((provider) => ({
    provider: {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      endpoint: provider.endpoint,
      model: provider.model,
    },
    keyAction: "keep",
    keyConfigured: provider.keyConfigured,
    ready: provider.ready,
  })),
});
const requestFor = (draft: Draft): UpdateWorkerRouting => ({
  expectedRevision: draft.expectedRevision,
  mode: draft.mode,
  profiles: draft.profiles,
  minProbability: draft.minProbability.trim() ? Number(draft.minProbability) : NaN,
  timeoutMs: draft.timeoutSeconds.trim() ? Number(draft.timeoutSeconds) * 1000 : NaN,
  providers: draft.providers.map(({ provider, keyAction, key, testToken }) => ({
    provider,
    keyAction,
    ...(key ? { key } : {}),
    ...(testToken ? { testToken } : {}),
  })),
});

export function WorkerModelRoutingControl({
  sessions,
}: Pick<ModelDefaultsCardProps, "sessions">) {
  const styles = useStyles();
  const active = useSettingsActive();
  const [settings, setSettings] = useState<WorkerRoutingSettings>();
  const [draft, setDraft] = useState<Draft>();
  const [tab, setTab] = useState("providers");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [reauth, setReauth] = useState(false);
  const [exactIds, setExactIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const value = await api<WorkerRoutingSettings>("/api/worker-model-routing");
      setSettings(value);
      setError(undefined);
      return value;
    } catch (reason) {
      setError(errorMessage(reason, "Could not load worker routing settings."));
      return undefined;
    }
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  useEffect(() => {
    if (!reauth) return;
    return onIdentityConfirmed(() => {
      forgetCsrfToken();
      setReauth(false);
      setError("Identity confirmed. Save the settings again.");
      return true;
    });
  }, [reauth]);

  const open = async () => {
    const value = await load();
    if (value) {
      setDraft(fromSettings(value));
      setTab("providers");
      setExactIds(new Set());
      setSuccess(undefined);
    }
  };
  const close = () => {
    setDraft(undefined);
    setError(undefined);
    setReauth(false);
    setSuccess(undefined);
  };
  const changeProvider = (id: string, change: (form: ProviderForm) => ProviderForm) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            providers: current.providers.map((form) =>
              form.provider.id === id ? change(form) : form,
            ),
          }
        : current,
    );
  const editConnection = (
    form: ProviderForm,
    patch: Partial<ProviderForm["provider"]>,
  ): ProviderForm => ({
    ...form,
    provider: { ...form.provider, ...patch },
    ...(patch.kind !== undefined ||
    patch.endpoint !== undefined ||
    patch.model !== undefined
      ? { ready: false, result: undefined, testToken: undefined }
      : {}),
    ...(patch.kind !== undefined || patch.endpoint !== undefined
      ? { keyAction: "replace", key: undefined }
      : {}),
  });
  const changeProfile = (index: number, patch: Partial<WorkerExecutionProfile>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((profile, at) =>
              at === index ? { ...profile, ...patch } : profile,
            ),
          }
        : current,
    );

  const test = async (form: ProviderForm) => {
    const parsed = DecisionProviderDraftSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setBusy(`test:${form.provider.id}`);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await api<DecisionConnectionTest>("/api/worker-model-routing/test", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      changeProvider(form.provider.id, (current) => ({
        ...current,
        key: undefined,
        ready: result.success,
        testToken: result.testToken,
        result,
      }));
    } catch (reason) {
      changeProvider(form.provider.id, (current) => ({ ...current, key: undefined }));
      setError(errorMessage(reason, "Could not test this connection."));
    } finally {
      setBusy(undefined);
    }
  };

  const save = async () => {
    if (!draft) return;
    const parsed = UpdateWorkerRoutingSchema.safeParse(requestFor(draft));
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" "),
      );
      return;
    }
    setBusy("save");
    setError(undefined);
    setSuccess(undefined);
    try {
      const next = await api<WorkerRoutingSettings>("/api/worker-model-routing", {
        method: "PUT",
        body: JSON.stringify(parsed.data),
      });
      setSettings(next);
      setDraft(fromSettings(next));
      setReauth(false);
      setSuccess("Worker routing settings saved.");
    } catch (reason) {
      setReauth(reason instanceof ApiError && reason.body.reauthRequired === true);
      setError(errorMessage(reason, "Could not save worker routing settings."));
    } finally {
      setBusy(undefined);
    }
  };

  const review = async (id: string, action: "apply" | "reject") => {
    if (!settings) return;
    setBusy("review");
    setError(undefined);
    setSuccess(undefined);
    try {
      const next = await api<WorkerRoutingSettings>(
        `/api/worker-model-routing/proposals/${id}`,
        {
          method: "POST",
          body: JSON.stringify({ action, expectedRevision: settings.revision }),
        },
      );
      setSettings(next);
      setDraft(fromSettings(next));
      setSuccess(
        action === "apply"
          ? "Worker routing proposal applied."
          : "Worker routing proposal rejected.",
      );
    } catch (reason) {
      setError(errorMessage(reason, "Could not review the proposal."));
    } finally {
      setBusy(undefined);
    }
  };
  const copilotSessions = sessions.filter(
    (session) => (session.agentParams?.kind ?? "copilot") === "copilot",
  );
  const models = observedChoices(copilotSessions, "model");
  const allEfforts = observedChoices(copilotSessions, "reasoning_effort");
  const dirty = Boolean(
    draft &&
    settings &&
    JSON.stringify(requestFor(draft)) !==
      JSON.stringify(requestFor(fromSettings(settings))),
  );
  const move = (index: number, offset: number) =>
    setDraft((current) => {
      if (!current) return current;
      const providers = [...current.providers];
      const moved = providers.splice(index, 1)[0]!;
      providers.splice(index + offset, 0, moved);
      return { ...current, providers };
    });
  const addProfile = () =>
    setDraft((current) => {
      if (!current) return current;
      let index = current.profiles.length + 1;
      while (current.profiles.some((profile) => profile.id === `profile-${index}`))
        index++;
      return {
        ...current,
        profiles: [
          ...current.profiles,
          {
            id: `profile-${index}`,
            name: `Profile ${index}`,
            description: "",
            categories: ["implement"],
            model: "",
            reasoningEffort: null,
          },
        ],
      };
    });

  return (
    <div className={styles.control}>
      <div className={styles.row}>
        <div className={styles.label}>
          <Text weight="semibold">Worker model routing</Text>
          <Badge appearance="outline" size="small">
            Experimental
          </Badge>
          <Badge
            appearance="tint"
            color={settings?.mode === "route" ? "success" : "informative"}
          >
            {modes[settings?.mode ?? "off"]}
          </Badge>
        </div>
        <Button icon={<Settings20Regular />} onClick={() => void open()}>
          Decision settings
        </Button>
      </div>
      <Text className={styles.caption}>
        Choose models for new orchestrated workers. Existing workers and ordinary Chats
        are not routed.
      </Text>
      {error && !draft ? <Text role="alert">{error}</Text> : null}
      <Dialog
        open={active && Boolean(draft)}
        onOpenChange={(_event, data) => {
          if (!data.open && !busy) close();
        }}
      >
        <DialogSurface className={styles.dialog}>
          <DialogBody className={styles.body}>
            <DialogTitle>Worker model routing</DialogTitle>
            <DialogContent className={styles.content}>
              {draft ? (
                <>
                  <MessageBar
                    className={styles.message}
                    layout="multiline"
                    intent="warning"
                  >
                    <MessageBarBody>
                      Shadow and Route send the worker&apos;s title, deliverable, scope,
                      and verification brief to your tested decision providers. Calls can
                      incur charges. Context, transcripts, files, and worker credentials
                      are not sent.
                    </MessageBarBody>
                  </MessageBar>
                  {settings?.suspended ? (
                    <MessageBar
                      className={styles.message}
                      layout="multiline"
                      intent="warning"
                    >
                      <MessageBarBody>
                        Routing is off after a Host restore. Enter local API keys, test
                        the connections, and opt in again.
                      </MessageBarBody>
                    </MessageBar>
                  ) : null}
                  {settings?.credentialError ? (
                    <MessageBar
                      className={styles.message}
                      layout="multiline"
                      intent="error"
                    >
                      <MessageBarBody>{settings.credentialError}</MessageBarBody>
                    </MessageBar>
                  ) : null}
                  {error ? (
                    <MessageBar
                      className={styles.message}
                      layout="multiline"
                      intent="error"
                    >
                      <MessageBarBody>{error}</MessageBarBody>
                    </MessageBar>
                  ) : null}
                  {success ? (
                    <MessageBar
                      className={styles.message}
                      layout="multiline"
                      intent="success"
                    >
                      <MessageBarBody>{success}</MessageBarBody>
                    </MessageBar>
                  ) : null}
                  {reauth ? (
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() => {
                        void confirmIdentityInNewTab().catch((reason: unknown) =>
                          setError(
                            errorMessage(reason, "Could not start Microsoft sign-in."),
                          ),
                        );
                      }}
                    >
                      Confirm identity with Microsoft
                    </Button>
                  ) : null}
                  <div className={styles.limits}>
                    <Field label="Routing mode">
                      <Dropdown
                        className={styles.dropdown}
                        aria-label="Routing mode"
                        disabled={Boolean(busy)}
                        value={modes[draft.mode]}
                        selectedOptions={[draft.mode]}
                        onOptionSelect={(_event, data) => {
                          const mode = data.optionValue;
                          if (mode === "off" || mode === "shadow" || mode === "route")
                            setDraft({ ...draft, mode });
                        }}
                      >
                        <Option value="off">Off</Option>
                        <Option value="shadow">Shadow</Option>
                        <Option
                          value="route"
                          disabled={!draft.providers.some((form) => form.ready)}
                        >
                          Route new workers
                        </Option>
                      </Dropdown>
                    </Field>
                    <Field
                      label="Minimum probability"
                      hint="Below this value, try the next decision model."
                    >
                      <Input
                        type="number"
                        aria-label="Minimum probability"
                        value={draft.minProbability}
                        min={0}
                        max={1}
                        step={0.05}
                        disabled={Boolean(busy)}
                        onChange={(_event, data) =>
                          setDraft({ ...draft, minProbability: data.value })
                        }
                      />
                    </Field>
                    <Field
                      label="Total deadline (seconds)"
                      hint="Shared by the entire fallback chain; maximum 10."
                    >
                      <Input
                        type="number"
                        aria-label="Total deadline (seconds)"
                        value={draft.timeoutSeconds}
                        min={0.5}
                        max={10}
                        step={0.5}
                        disabled={Boolean(busy)}
                        onChange={(_event, data) =>
                          setDraft({ ...draft, timeoutSeconds: data.value })
                        }
                      />
                    </Field>
                  </div>
                  <Text className={styles.caption}>
                    Shadow records predictions but uses default workers. Explicit profiles
                    apply in Shadow and Route. If no decision is usable, Fleet uses the
                    defaults above. The probability threshold is not a guarantee of worker
                    quality.
                  </Text>
                  <TabList
                    className={styles.tabs}
                    aria-label="Routing settings sections"
                    selectedValue={tab}
                    onTabSelect={(_event, data) => setTab(String(data.value))}
                  >
                    <Tab value="providers">Decision models</Tab>
                    <Tab value="profiles">Worker profiles</Tab>
                    <Tab value="proposals">
                      Proposals ({settings?.proposals.length ?? 0})
                    </Tab>
                  </TabList>
                  {tab === "providers" ? (
                    <div className={styles.list}>
                      <Text>
                        Try tested models in this order. Add a row for each deployment or
                        model, including models on the same provider. A slow primary
                        cannot use the whole deadline.
                      </Text>
                      <ol className={styles.list}>
                        {draft.providers.map((form, index) => {
                          const original = settings?.providers.find(
                            (provider) => provider.id === form.provider.id,
                          );
                          const normalized = DecisionProviderDraftSchema.safeParse(form);
                          const canKeep = Boolean(
                            original?.keyConfigured &&
                            normalized.success &&
                            original.kind === normalized.data.provider.kind &&
                            original.endpoint === normalized.data.provider.endpoint,
                          );
                          return (
                            <li key={form.provider.id}>
                              <fieldset
                                className={styles.editor}
                                aria-label={`Decision model ${index + 1}`}
                              >
                                <legend>
                                  {index + 1}. {form.provider.name || "Decision model"}
                                  {index === 0 ? " - primary" : " - fallback"}
                                </legend>
                                <div className={styles.header}>
                                  <Badge
                                    appearance="tint"
                                    color={form.ready ? "success" : "informative"}
                                  >
                                    {form.ready
                                      ? "Tested"
                                      : form.keyConfigured
                                        ? "Test required"
                                        : "Key required"}
                                  </Badge>
                                  <div className={styles.actions}>
                                    <Button
                                      size="small"
                                      appearance="subtle"
                                      icon={<ArrowUp16Regular />}
                                      aria-label={`Move decision model ${index + 1} earlier`}
                                      disabled={Boolean(busy) || index === 0}
                                      onClick={() => move(index, -1)}
                                    />
                                    <Button
                                      size="small"
                                      appearance="subtle"
                                      icon={<ArrowDown16Regular />}
                                      aria-label={`Move decision model ${index + 1} later`}
                                      disabled={
                                        Boolean(busy) ||
                                        index === draft.providers.length - 1
                                      }
                                      onClick={() => move(index, 1)}
                                    />
                                    <Button
                                      size="small"
                                      appearance="subtle"
                                      icon={<Dismiss16Regular />}
                                      aria-label={`Remove decision model ${index + 1}`}
                                      disabled={Boolean(busy)}
                                      onClick={() =>
                                        setDraft({
                                          ...draft,
                                          providers: draft.providers.filter(
                                            (entry) =>
                                              entry.provider.id !== form.provider.id,
                                          ),
                                        })
                                      }
                                    />
                                  </div>
                                </div>
                                <div className={styles.grid}>
                                  <Field label="Name">
                                    <Input
                                      aria-label="Decision model name"
                                      value={form.provider.name}
                                      maxLength={80}
                                      disabled={Boolean(busy)}
                                      onChange={(_event, data) =>
                                        changeProvider(form.provider.id, (current) =>
                                          editConnection(current, { name: data.value }),
                                        )
                                      }
                                    />
                                  </Field>
                                  <Field label="Provider">
                                    <Dropdown
                                      className={styles.dropdown}
                                      aria-label="Decision provider"
                                      value={providerNames[form.provider.kind]}
                                      selectedOptions={[form.provider.kind]}
                                      disabled={Boolean(busy)}
                                      onOptionSelect={(_event, data) => {
                                        const kind = data.optionValue;
                                        if (kind === "foundry" || kind === "typesafe")
                                          changeProvider(form.provider.id, (current) =>
                                            editConnection(current, {
                                              kind,
                                              endpoint:
                                                kind === "typesafe"
                                                  ? "https://api.typesafe.ai/v1/systemone"
                                                  : "",
                                              model: "",
                                            }),
                                          );
                                      }}
                                    >
                                      <Option value="foundry">Azure AI Foundry</Option>
                                      <Option value="typesafe">TypeSafe</Option>
                                    </Dropdown>
                                  </Field>
                                  <Field
                                    label="Endpoint"
                                    hint={
                                      form.provider.kind === "foundry"
                                        ? "The resource URL or full Microsoft decision URL."
                                        : "The direct TypeSafe decision endpoint."
                                    }
                                  >
                                    <Input
                                      aria-label="Decision endpoint"
                                      type="url"
                                      value={form.provider.endpoint}
                                      placeholder={
                                        form.provider.kind === "foundry"
                                          ? "https://resource.services.ai.azure.com"
                                          : "https://api.typesafe.ai/v1/systemone"
                                      }
                                      disabled={Boolean(busy)}
                                      onChange={(_event, data) =>
                                        changeProvider(form.provider.id, (current) =>
                                          editConnection(current, {
                                            endpoint: data.value,
                                          }),
                                        )
                                      }
                                    />
                                  </Field>
                                  <Field
                                    label={
                                      form.provider.kind === "foundry"
                                        ? "Deployment name"
                                        : "Decision model ID"
                                    }
                                  >
                                    <Input
                                      aria-label="Decision deployment or model"
                                      value={form.provider.model}
                                      placeholder={
                                        form.provider.kind === "foundry"
                                          ? "Your deployment name"
                                          : "jev-latest"
                                      }
                                      maxLength={200}
                                      disabled={Boolean(busy)}
                                      onChange={(_event, data) =>
                                        changeProvider(form.provider.id, (current) =>
                                          editConnection(current, { model: data.value }),
                                        )
                                      }
                                    />
                                  </Field>
                                  <Field label="API key action">
                                    <Dropdown
                                      className={styles.dropdown}
                                      aria-label="API key action"
                                      value={
                                        form.keyAction === "keep"
                                          ? "Keep existing key"
                                          : form.keyAction === "replace"
                                            ? "Replace key"
                                            : "Clear key"
                                      }
                                      selectedOptions={[form.keyAction]}
                                      disabled={Boolean(busy)}
                                      onOptionSelect={(_event, data) => {
                                        const keyAction = data.optionValue;
                                        if (
                                          keyAction === "keep" ||
                                          keyAction === "replace" ||
                                          keyAction === "clear"
                                        )
                                          changeProvider(form.provider.id, (current) => ({
                                            ...current,
                                            keyAction,
                                            key: undefined,
                                            testToken: undefined,
                                            result: undefined,
                                            ready:
                                              keyAction === "keep" &&
                                              canKeep &&
                                              Boolean(original?.ready) &&
                                              normalized.success &&
                                              normalized.data.provider.model ===
                                                original?.model,
                                          }));
                                      }}
                                    >
                                      <Option value="keep" disabled={!canKeep}>
                                        Keep existing key
                                      </Option>
                                      <Option value="replace">Replace key</Option>
                                      <Option value="clear">Clear key</Option>
                                    </Dropdown>
                                  </Field>
                                  {form.keyAction === "replace" ? (
                                    <Field
                                      label="API key"
                                      hint={
                                        form.testToken
                                          ? "Tested key is held privately by the Host until you save."
                                          : "Write-only. Never returned or included in backups."
                                      }
                                    >
                                      <Input
                                        aria-label="Decision API key"
                                        type="password"
                                        autoComplete="new-password"
                                        value={form.key ?? ""}
                                        disabled={Boolean(busy)}
                                        placeholder={
                                          form.testToken
                                            ? "Tested key ready to save"
                                            : "Enter API key"
                                        }
                                        onChange={(_event, data) =>
                                          changeProvider(form.provider.id, (current) => ({
                                            ...current,
                                            key: data.value,
                                            ready: false,
                                            testToken: undefined,
                                            result: undefined,
                                          }))
                                        }
                                      />
                                    </Field>
                                  ) : null}
                                </div>
                                <div className={styles.actions}>
                                  <Button
                                    disabled={Boolean(busy) || form.keyAction === "clear"}
                                    onClick={() => void test(form)}
                                  >
                                    Test connection
                                  </Button>
                                  {busy === `test:${form.provider.id}` ? (
                                    <Spinner size="tiny" label="Testing connection" />
                                  ) : null}
                                </div>
                                {form.result ? (
                                  <MessageBar
                                    className={styles.message}
                                    layout="multiline"
                                    intent={form.result.success ? "success" : "error"}
                                  >
                                    <MessageBarBody>
                                      {form.result.message} (
                                      {Math.round(form.result.durationMs)} ms)
                                      {form.result.returnedModel
                                        ? ` Model: ${form.result.returnedModel}.`
                                        : ""}
                                      {form.result.usage
                                        ? ` Tokens: ${form.result.usage.inputTokens} in / ${form.result.usage.outputTokens} out.`
                                        : " Usage not reported."}
                                      {form.result.success
                                        ? " Save settings to retain this test."
                                        : ""}
                                    </MessageBarBody>
                                  </MessageBar>
                                ) : null}
                              </fieldset>
                            </li>
                          );
                        })}
                      </ol>
                      {draft.providers.length === 0 ? (
                        <Text>
                          No decision models yet. Add a provider connection and test it
                          with a paid, sanitized sample. No worker will start.
                        </Text>
                      ) : null}
                      <Button
                        appearance="primary"
                        className={styles.addAction}
                        disabled={Boolean(busy) || draft.providers.length >= 8}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            providers: [
                              ...draft.providers,
                              {
                                provider: {
                                  id: crypto.randomUUID(),
                                  name: `Decision model ${draft.providers.length + 1}`,
                                  kind: "foundry",
                                  endpoint: "",
                                  model: "",
                                },
                                keyAction: "replace",
                                keyConfigured: false,
                                ready: false,
                              },
                            ],
                          })
                        }
                      >
                        Add decision model
                      </Button>
                    </div>
                  ) : null}
                  {tab === "profiles" ? (
                    <div className={styles.list}>
                      <Text>
                        A profile fixes the worker&apos;s Copilot model and effort.
                        Automatic routing uses the checked categories; an explicit profile
                        can be used for any category without changing permissions.
                      </Text>
                      {models.length === 0 ? (
                        <Text className={styles.caption}>
                          Start a Copilot session to load models, or enter an exact ID
                          marked Unverified.
                        </Text>
                      ) : null}
                      <div className={styles.list}>
                        {draft.profiles.map((profile, index) => {
                          const matching = copilotSessions.filter((session) =>
                            session.configOptions.some(
                              (option) =>
                                option.id === "model" &&
                                option.currentValue === profile.model,
                            ),
                          );
                          const observedEfforts = observedChoices(
                            matching,
                            "reasoning_effort",
                          );
                          const efforts = observedEfforts.length
                            ? observedEfforts
                            : allEfforts;
                          const modelLabel =
                            models.find((choice) => choice.value === profile.model)
                              ?.name ??
                            (profile.model
                              ? `${profile.model} (Unverified)`
                              : "Choose a worker model");
                          return (
                            <details key={index} className={styles.editor} open>
                              <summary className={styles.summary}>
                                {profile.name || profile.id}
                              </summary>
                              <div className={styles.profileContent}>
                                <div className={styles.row}>
                                  <Text className={styles.mono}>{profile.id}</Text>
                                  <Button
                                    size="small"
                                    disabled={Boolean(busy)}
                                    onClick={() =>
                                      setDraft({
                                        ...draft,
                                        profiles: draft.profiles.filter(
                                          (_entry, at) => at !== index,
                                        ),
                                      })
                                    }
                                  >
                                    Remove profile
                                  </Button>
                                </div>
                                <div className={styles.grid}>
                                  <Field label="Stable profile ID">
                                    <Input
                                      aria-label={`Profile ${index + 1} ID`}
                                      value={profile.id}
                                      maxLength={40}
                                      disabled={Boolean(busy)}
                                      onChange={(_event, data) =>
                                        changeProfile(index, { id: data.value })
                                      }
                                    />
                                  </Field>
                                  <Field label="Display name">
                                    <Input
                                      aria-label={`Profile ${index + 1} name`}
                                      value={profile.name}
                                      maxLength={80}
                                      disabled={Boolean(busy)}
                                      onChange={(_event, data) =>
                                        changeProfile(index, { name: data.value })
                                      }
                                    />
                                  </Field>
                                </div>
                                <Field label="When to use this profile">
                                  <Textarea
                                    aria-label={`Profile ${index + 1} description`}
                                    value={profile.description}
                                    maxLength={400}
                                    resize="vertical"
                                    disabled={Boolean(busy)}
                                    onChange={(_event, data) =>
                                      changeProfile(index, { description: data.value })
                                    }
                                  />
                                </Field>
                                <Field label="Automatically consider for">
                                  <div className={styles.checkboxGroup}>
                                    {WORKER_CATEGORIES.map((category) => (
                                      <Checkbox
                                        key={category}
                                        label={category}
                                        checked={profile.categories.includes(category)}
                                        disabled={Boolean(busy)}
                                        onChange={(_event, data) =>
                                          changeProfile(index, {
                                            categories: data.checked
                                              ? [...profile.categories, category]
                                              : profile.categories.filter(
                                                  (value) => value !== category,
                                                ),
                                          })
                                        }
                                      />
                                    ))}
                                  </div>
                                </Field>
                                <div className={styles.grid}>
                                  <Field
                                    label="Worker model"
                                    hint="Exact Copilot ACP values; catalogs can differ between nodes."
                                  >
                                    {exactIds.has(profile.id) ? (
                                      <Input
                                        aria-label={`Profile ${index + 1} exact model ID`}
                                        value={profile.model}
                                        maxLength={200}
                                        disabled={Boolean(busy)}
                                        onChange={(_event, data) =>
                                          changeProfile(index, {
                                            model: data.value,
                                            reasoningEffort: null,
                                          })
                                        }
                                      />
                                    ) : (
                                      <Dropdown
                                        className={styles.dropdown}
                                        aria-label={`Profile ${index + 1} worker model`}
                                        value={modelLabel}
                                        selectedOptions={[profile.model]}
                                        disabled={Boolean(busy)}
                                        onOptionSelect={(_event, data) =>
                                          changeProfile(index, {
                                            model: String(data.optionValue ?? ""),
                                            reasoningEffort: null,
                                          })
                                        }
                                      >
                                        {profile.model &&
                                        !models.some(
                                          (choice) => choice.value === profile.model,
                                        ) ? (
                                          <Option
                                            value={profile.model}
                                          >{`${profile.model} (Unverified)`}</Option>
                                        ) : null}
                                        {models.map((choice) => (
                                          <Option
                                            key={choice.value}
                                            value={choice.value}
                                            title={choice.value}
                                          >
                                            {choice.name}
                                          </Option>
                                        ))}
                                      </Dropdown>
                                    )}
                                    <div className={styles.row}>
                                      <Text className={styles.mono} title={profile.model}>
                                        {profile.model || "No model selected"}
                                      </Text>
                                      {profile.model &&
                                      !models.some(
                                        (choice) => choice.value === profile.model,
                                      ) ? (
                                        <Badge appearance="tint">Unverified</Badge>
                                      ) : null}
                                      <Button
                                        size="small"
                                        appearance="subtle"
                                        disabled={Boolean(busy)}
                                        onClick={() =>
                                          setExactIds((current) => {
                                            const next = new Set(current);
                                            if (next.has(profile.id))
                                              next.delete(profile.id);
                                            else next.add(profile.id);
                                            return next;
                                          })
                                        }
                                      >
                                        {exactIds.has(profile.id)
                                          ? "Use observed models"
                                          : "Enter exact ID"}
                                      </Button>
                                    </div>
                                  </Field>
                                  <Field
                                    label="Reasoning effort"
                                    hint={
                                      observedEfforts.length
                                        ? "Observed for this model."
                                        : "Other values are not yet observed for this model."
                                    }
                                  >
                                    <Dropdown
                                      className={styles.dropdown}
                                      aria-label={`Profile ${index + 1} reasoning effort`}
                                      value={
                                        efforts.find(
                                          (choice) =>
                                            choice.value === profile.reasoningEffort,
                                        )?.name ??
                                        profile.reasoningEffort ??
                                        "No effort override"
                                      }
                                      selectedOptions={[profile.reasoningEffort ?? ""]}
                                      disabled={Boolean(busy)}
                                      onOptionSelect={(_event, data) =>
                                        changeProfile(index, {
                                          reasoningEffort: data.optionValue || null,
                                        })
                                      }
                                    >
                                      <Option value="">No effort override</Option>
                                      {profile.reasoningEffort &&
                                      !efforts.some(
                                        (choice) =>
                                          choice.value === profile.reasoningEffort,
                                      ) ? (
                                        <Option value={profile.reasoningEffort}>
                                          {profile.reasoningEffort}
                                        </Option>
                                      ) : null}
                                      {efforts.map((choice) => (
                                        <Option key={choice.value} value={choice.value}>
                                          {choice.name}
                                        </Option>
                                      ))}
                                    </Dropdown>
                                  </Field>
                                </div>
                              </div>
                            </details>
                          );
                        })}
                      </div>
                      {draft.profiles.length === 0 ? (
                        <Text>
                          No profiles yet. Workers use defaults until you configure
                          profiles.
                        </Text>
                      ) : null}
                      <Button
                        appearance="primary"
                        className={styles.addAction}
                        disabled={Boolean(busy) || draft.profiles.length >= 20}
                        onClick={addProfile}
                      >
                        Add worker profile
                      </Button>
                    </div>
                  ) : null}
                  {tab === "proposals" ? (
                    <div className={styles.list}>
                      <Text>
                        Operators approve Host-wide profile edits. They affect future
                        workers from every lead, never existing workers.
                      </Text>
                      {dirty ? (
                        <Text>
                          Save or discard your edits before reviewing proposals.
                        </Text>
                      ) : null}
                      {!settings?.proposals.length ? (
                        <Text>No policy proposals are awaiting review.</Text>
                      ) : null}
                      {settings?.proposals.map((proposal) => (
                        <section
                          key={proposal.id}
                          className={styles.editor}
                          aria-label={`Proposal from ${proposal.leadName}`}
                        >
                          <Text weight="semibold">
                            {proposal.leadName || "Orchestrator"} - revision{" "}
                            {proposal.expectedRevision}
                          </Text>
                          <Text>{proposal.reason}</Text>
                          <div className={styles.grid}>
                            <div>
                              <Text weight="semibold">Current profiles</Text>
                              <pre className={styles.diff}>
                                {JSON.stringify(settings.profiles, null, 2)}
                              </pre>
                            </div>
                            <div>
                              <Text weight="semibold">Proposed profiles</Text>
                              <pre className={styles.diff}>
                                {JSON.stringify(proposal.profiles, null, 2)}
                              </pre>
                            </div>
                          </div>
                          {proposal.expectedRevision !== settings.revision ? (
                            <Text>
                              This proposal is stale. Ask the lead to use the current
                              revision.
                            </Text>
                          ) : null}
                          <div className={styles.actions}>
                            <Button
                              disabled={
                                Boolean(busy) ||
                                dirty ||
                                proposal.expectedRevision !== settings.revision
                              }
                              onClick={() => void review(proposal.id, "apply")}
                            >
                              Apply proposal
                            </Button>
                            <Button
                              disabled={Boolean(busy) || dirty}
                              onClick={() => void review(proposal.id, "reject")}
                            >
                              Reject proposal
                            </Button>
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button disabled={Boolean(busy)} onClick={close}>
                Close
              </Button>
              <Button
                disabled={Boolean(busy)}
                onClick={async () => {
                  const value = await load();
                  if (value) setDraft(fromSettings(value));
                }}
              >
                Discard edits and refresh
              </Button>
              <Button
                appearance="primary"
                disabled={Boolean(busy) || !draft}
                onClick={() => void save()}
              >
                {busy === "save" ? "Saving..." : "Save settings"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
