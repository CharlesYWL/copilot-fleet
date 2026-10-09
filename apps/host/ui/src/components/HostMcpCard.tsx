import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Input,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { errorMessage, type HostMcpSettings } from "@fleet/protocol";
import { api } from "../hooks/useFleet";
import { useNotify } from "../hooks/useAppNotifications";
import { useSettingsActive } from "../hooks/useSettingsActivity";
import { terminal } from "../theme";

const useStyles = makeStyles({
  card: {
    flexShrink: 0,
    minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: "18px 22px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
  },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  summary: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  dialog: {
    width: "min(760px, calc(100vw - 32px))",
    maxWidth: "760px",
    maxHeight: "calc(100dvh - 32px)",
    display: "flex",
  },
  dialogBody: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    width: "100%",
    gap: "12px",
  },
  dialogContent: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    minHeight: 0,
  },
  list: {
    minHeight: 0,
    maxHeight: "min(45vh, 480px)",
    overflowY: "auto",
  },
  actions: { alignSelf: "flex-end" },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: "24px",
    rowGap: "8px",
    padding: "12px 0",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  identity: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minWidth: 0,
    overflowWrap: "anywhere",
    flex: "1 1 200px",
  },
  label: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  mono: { fontFamily: terminal.font, fontSize: tokens.fontSizeBase200 },
});

export const HostMcpCard = ({
  run,
}: {
  run: (
    work: () => Promise<unknown>,
    options?: { refresh?: boolean; resumeAfterReauth?: boolean },
  ) => Promise<void>;
}) => {
  const styles = useStyles();
  const active = useSettingsActive();
  const notify = useNotify();
  const [view, setView] = useState<HostMcpSettings>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setView(await api<HostMcpSettings>("/api/host-mcp/settings"));
      setError(undefined);
    } catch (reason) {
      setError(errorMessage(reason, "Could not read Host MCP forwarding settings."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const change = async (server: HostMcpSettings["servers"][number], enabled: boolean) => {
    if (!view || saving) return;
    const input = {
      name: server.name,
      enabled,
      expectedRevision: view.revision,
      ...(server.sourceDigest ? { sourceDigest: server.sourceDigest } : {}),
    };
    const save = async () => {
      setSaving(server.name);
      setError(undefined);
      try {
        const next = await api<HostMcpSettings>("/api/host-mcp/settings", {
          method: "PUT",
          body: JSON.stringify(input),
        });
        setView(next);
        notify(
          enabled
            ? `${server.name} is shared with all nodes.`
            : `${server.name} forwarding is off.`,
          "success",
        );
      } catch (reason) {
        // SecurityPanel owns error and reauthentication dialogs; never stack modals.
        setChoosing(false);
        throw reason;
      } finally {
        setSaving(undefined);
      }
    };
    await run(save, { refresh: false, resumeAfterReauth: true });
  };

  const enabled = view?.servers.filter((server) => server.enabled) ?? [];
  const enabledNames = enabled
    .map((server) => `${server.name}${server.allNodes ? "" : " (limited scope)"}`)
    .join(", ");
  const visibleServers =
    view?.servers.filter((server) =>
      server.name.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  const suspended = view?.suspended ?? false;

  return (
    <section className={styles.card} aria-label="Host MCP forwarding">
      <div className={styles.header}>
        <Text weight="semibold" size={400}>
          Host MCP forwarding
        </Text>
        <Dialog
          open={active && choosing}
          onOpenChange={(_event, data) => {
            if (!saving) setChoosing(data.open);
          }}
        >
          <DialogTrigger disableButtonEnhancement>
            <Button disabled={Boolean(saving)} onClick={() => setSearch("")}>
              Choose MCPs…
            </Button>
          </DialogTrigger>
          <DialogSurface className={styles.dialog}>
            <DialogBody className={styles.dialogBody}>
              <DialogTitle>Choose MCPs to share</DialogTitle>
              <DialogContent className={styles.dialogContent}>
                <Text>
                  Share selected Host MCPs with all enrolled nodes, including nodes added
                  later. Credentials stay on the Host.
                </Text>
                <MessageBar intent="warning">
                  <MessageBarBody>
                    Shared MCPs can access your data and act with your Host account&apos;s
                    permissions. Only share servers you trust.
                  </MessageBarBody>
                </MessageBar>
                <Text className={styles.caption}>
                  Choices save automatically. New and resumed sessions receive shared
                  MCPs; turning one off revokes access immediately. Existing sessions may
                  need Stop and Resume.
                </Text>
                {error || view?.catalogError ? (
                  <MessageBar intent="error">
                    <MessageBarBody>{error ?? view?.catalogError}</MessageBarBody>
                  </MessageBar>
                ) : null}
                {suspended ? (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      Forwarding is suspended after a Host restore. Review the local
                      configuration and restart the Host before sharing again.
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
                <Input
                  type="search"
                  aria-label="Search Host MCPs"
                  placeholder="Search MCPs"
                  value={search}
                  disabled={Boolean(saving)}
                  onChange={(_event, data) => setSearch(data.value)}
                />
                <Text className={styles.caption} aria-live="polite">
                  {visibleServers.length} of {view?.servers.length ?? 0} MCPs
                </Text>
                <div
                  className={styles.list}
                  role="region"
                  aria-label="Available Host MCPs"
                >
                  {loading && !view ? (
                    <Spinner size="tiny" label="Loading Host MCPs…" />
                  ) : view?.servers.length === 0 ? (
                    <Text>
                      No MCPs are configured on this Host. Add one in Copilot on the Host,
                      then refresh this list.
                    </Text>
                  ) : view && visibleServers.length === 0 ? (
                    <Text>No MCPs match your search.</Text>
                  ) : null}
                  {visibleServers.map((server) => (
                    <div key={server.name} className={styles.row}>
                      <div className={styles.identity}>
                        <div className={styles.label}>
                          <Text weight="semibold">{server.name}</Text>
                          <Badge
                            appearance="tint"
                            color={
                              server.enabled && !suspended ? "success" : "informative"
                            }
                          >
                            {suspended && server.enabled
                              ? "Suspended"
                              : server.enabled
                                ? server.allNodes
                                  ? "All nodes"
                                  : "Limited scope"
                                : "Off"}
                          </Badge>
                          <Text className={styles.caption}>
                            {server.transport.toUpperCase()}
                          </Text>
                        </div>
                        <Text className={styles.mono}>fleet-host-{server.name}</Text>
                        {server.enabled ? (
                          <Text className={styles.caption}>
                            {server.toolCount} tools ·{" "}
                            {server.readOnly
                              ? "Available to read-only sessions"
                              : "Ordinary sessions only"}
                          </Text>
                        ) : null}
                        {server.unavailable ? (
                          <Text className={styles.caption}>{server.unavailable}</Text>
                        ) : null}
                      </div>
                      {saving === server.name ? (
                        <Spinner size="tiny" label={`Saving ${server.name}…`} />
                      ) : null}
                      <RadioGroup
                        aria-label={`${server.name} forwarding`}
                        layout="horizontal"
                        value={
                          server.enabled
                            ? server.allNodes && !suspended
                              ? "all"
                              : ""
                            : "off"
                        }
                        disabled={loading || Boolean(saving)}
                        onChange={(_event, data) =>
                          void change(server, data.value === "all")
                        }
                      >
                        <Radio value="off" label="Off" />
                        <Radio
                          value="all"
                          label="Share with all nodes"
                          disabled={Boolean(
                            server.unavailable || view?.catalogError || suspended,
                          )}
                        />
                      </RadioGroup>
                    </div>
                  ))}
                </div>
              </DialogContent>
              <DialogActions className={styles.actions}>
                <Button disabled={loading || Boolean(saving)} onClick={() => void load()}>
                  Refresh list
                </Button>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="primary" disabled={Boolean(saving)}>
                    Done
                  </Button>
                </DialogTrigger>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
      {loading && !view ? (
        <Spinner size="tiny" label="Loading Host MCPs…" />
      ) : view ? (
        <Text className={styles.summary} aria-live="polite">
          {enabledNames
            ? `${suspended ? "Suspended" : "Shared"}: ${enabledNames}`
            : "No MCPs shared."}
        </Text>
      ) : null}
      {error || view?.catalogError ? (
        <Text className={styles.caption}>{error ?? view?.catalogError}</Text>
      ) : null}
    </section>
  );
};
