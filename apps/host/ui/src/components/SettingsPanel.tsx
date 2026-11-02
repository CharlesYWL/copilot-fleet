import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import type {
  FleetNode,
  FleetSession,
  HostUpdateStatus,
  Placement,
  Workspace,
} from "@fleet/protocol";
import type { NodeUpdateProgress } from "../hooks/useFleet";
import { useNotify } from "../hooks/useAppNotifications";
import { SettingsActivityContext } from "../hooks/useSettingsActivity";
import { SETTING_HIGHLIGHT_ATTRIBUTE, revealSetting } from "../lib/reveal-setting";
import {
  SETTINGS_PAGE_ATTRIBUTE,
  buildSettingsIndex,
  isSettingAvailable,
  settingsSections,
  type SettingsSearchEntry,
  type SettingsTab,
} from "../lib/settings-search";
import { NodesPanel } from "./NodesPanel";
import { GeneralPanel } from "./GeneralPanel";
import { OrchestratorPanel } from "./OrchestratorPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { SecurityPanel } from "./SecurityPanel";
import { SettingsSearch } from "./SettingsSearch";
import { TunnelPanel } from "./TunnelPanel";
import { WorkspacesPanel } from "./WorkspacesPanel";

export type { SettingsTab } from "../lib/settings-search";

const useStyles = makeStyles({
  root: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: tokens.colorNeutralBackground1,
    "&[hidden]": { display: "none" },
  },
  header: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "16px 24px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    "@media (max-width: 600px)": { padding: "12px 12px 0" },
  },
  /** Wide enough for "Section › Setting" rows, but not the whole of a big screen. */
  search: {
    width: "min(720px, 100%)",
  },
  tabs: {
    overflowX: "auto",
  },
  body: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    "&[hidden]": { display: "none" },
    /*
     * Where a search result lands: an outline that fades, so the eye finds the
     * setting without it staying marked. Outlines do not move the layout, and
     * forced-colors mode draws them in the system highlight.
     */
    "& [data-setting-id]": {
      // Room above a revealed setting, so its outline is not cut off by the
      // top of the scrolling page.
      scrollMarginTop: "16px",
    },
    [`& [${SETTING_HIGHLIGHT_ATTRIBUTE}]`]: {
      outlineStyle: "solid",
      outlineWidth: "2px",
      outlineOffset: "4px",
      borderRadius: tokens.borderRadiusLarge,
      animationName: {
        "0%": { outlineColor: tokens.colorBrandStroke1 },
        "70%": { outlineColor: tokens.colorBrandStroke1 },
        "100%": { outlineColor: "transparent" },
      },
      animationDuration: "2s",
      animationFillMode: "forwards",
      "@media (prefers-reduced-motion: reduce)": {
        animationName: "none",
        outlineColor: tokens.colorBrandStroke1,
      },
    },
    /* A setting can be focused by the search; the outline above already says so. */
    "& [data-setting-id]:focus": { outlineStyle: "none" },
    [`& [data-setting-id][${SETTING_HIGHLIGHT_ATTRIBUTE}]:focus`]: {
      outlineStyle: "solid",
    },
    "& [data-setting-id]:focus-visible": {
      outlineStyle: "solid",
      outlineWidth: "2px",
      outlineColor: tokens.colorStrokeFocus2,
    },
  },
});

type SettingsPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
  /** Read only to learn which models this fleet's Copilot offers. */
  sessions: FleetSession[];
  hostRevision: string;
  /** The Host's own update, absent from a Host that predates it. */
  hostUpdate?: HostUpdateStatus | undefined;
  nodeUpdates: NodeUpdateProgress;
  active?: boolean;
  selectedTab?: SettingsTab;
  onSelectedTabChange?: (tab: SettingsTab) => void;
  onStartTour?: (() => void) | undefined;
};

/**
 * The Settings screens read what they render from props and reach for their own
 * write operations through {@link useCatalog}, so this stays a tab strip rather
 * than a relay for a dozen callbacks it never calls itself.
 */
export const SettingsPanel = (props: SettingsPanelProps) => {
  const styles = useStyles();
  const id = useId();
  const notify = useNotify();
  const active = props.active ?? true;
  const [internalTab, setInternalTab] = useState<SettingsTab>("general");
  const [visitedTabs, setVisitedTabs] = useState<SettingsTab[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The reveal in flight, abandoned by the next one or by leaving Settings. */
  const revealing = useRef<AbortController | undefined>(undefined);
  const tab = props.selectedTab ?? internalTab;
  // Retain only visited sections, including when navigation selects a tab externally.
  if (active && !visitedTabs.includes(tab)) {
    setVisitedTabs([...visitedTabs, tab]);
  }
  const setTab = (next: SettingsTab) => {
    setInternalTab(next);
    props.onSelectedTabChange?.(next);
  };

  const searchIndex = useMemo(
    () => buildSettingsIndex({ nodes: props.nodes, workspaces: props.workspaces }),
    [props.nodes, props.workspaces],
  );

  useEffect(() => {
    if (!active) revealing.current?.abort();
  }, [active]);
  useEffect(() => () => revealing.current?.abort(), []);

  const isAvailable = useCallback(
    (entry: SettingsSearchEntry) =>
      !bodyRef.current || isSettingAvailable(bodyRef.current, entry),
    [],
  );

  /**
   * Opens the result's page and brings the result into view once it is drawn.
   *
   * A page is built the first time it is opened and fills in from the Host
   * after that, so the reveal waits for the element rather than assuming it.
   * One that never appears is reported rather than leaving the operator at the
   * top of a page wondering where to look.
   */
  const handleSelectResult = (entry: SettingsSearchEntry) => {
    revealing.current?.abort();
    const controller = new AbortController();
    revealing.current = controller;
    setTab(entry.tab);
    const root = bodyRef.current;
    if (!root) return;
    void revealSetting(root, entry.id, { signal: controller.signal }).then((target) => {
      if (target || controller.signal.aborted) return;
      notify(`“${entry.title}” is not available on this Host right now.`, "info");
    });
  };

  const panels: Record<SettingsTab, ReactNode> = {
    orchestrator: <OrchestratorPanel nodes={props.nodes} sessions={props.sessions} />,
    general: (
      <GeneralPanel
        sessions={props.sessions}
        onStartTour={props.onStartTour}
        hostUpdate={props.hostUpdate}
        hostRevision={props.hostRevision}
      />
    ),
    security: <SecurityPanel />,
    diagnostics: <DiagnosticsPanel />,
    tunnel: <TunnelPanel />,
    nodes: (
      <NodesPanel
        nodes={props.nodes}
        hostRevision={props.hostRevision}
        nodeUpdates={props.nodeUpdates}
      />
    ),
    workspaces: (
      <WorkspacesPanel
        workspaces={props.workspaces}
        placements={props.placements}
        nodes={props.nodes}
      />
    ),
  };

  return (
    <div className={styles.root} hidden={!active}>
      <div className={styles.header}>
        <div className={styles.search}>
          <SettingsSearch
            entries={searchIndex}
            onSelect={handleSelectResult}
            isAvailable={isAvailable}
          />
        </div>
        <div className={styles.tabs}>
          <TabList
            selectedValue={tab}
            onTabSelect={(_event, data) => setTab(data.value as SettingsTab)}
            aria-label="Settings sections"
          >
            {settingsSections.map(({ value, label }) => (
              <Tab
                key={value}
                value={value}
                id={`${id}-${value}-tab`}
                aria-controls={`${id}-${value}-panel`}
                data-tour={`settings-${value}`}
              >
                {label}
              </Tab>
            ))}
          </TabList>
        </div>
      </div>
      <div className={styles.body} ref={bodyRef}>
        {visitedTabs.map((value) => (
          <div
            key={value}
            id={`${id}-${value}-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-${value}-tab`}
            className={styles.body}
            hidden={!active || tab !== value}
            {...{ [SETTINGS_PAGE_ATTRIBUTE]: value }}
          >
            <SettingsActivityContext.Provider value={active && tab === value}>
              {panels[value]}
            </SettingsActivityContext.Provider>
          </div>
        ))}
      </div>
    </div>
  );
};
