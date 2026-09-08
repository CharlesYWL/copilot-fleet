import { useId, useState, type ReactNode } from "react";
import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import type { NodeUpdateProgress } from "../hooks/useFleet";
import { SettingsActivityContext } from "../hooks/useSettingsActivity";
import { NodesPanel } from "./NodesPanel";
import { GeneralPanel } from "./GeneralPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { SecurityPanel } from "./SecurityPanel";
import { TunnelPanel } from "./TunnelPanel";
import { WorkspacesPanel } from "./WorkspacesPanel";

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
  tabs: {
    flexShrink: 0,
    overflowX: "auto",
    padding: "12px 24px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    "&[hidden]": { display: "none" },
  },
});

export type SettingsTab =
  "general" | "security" | "tunnel" | "nodes" | "workspaces" | "diagnostics";

const sections: readonly { value: SettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "security", label: "Security" },
  { value: "tunnel", label: "Tunnel" },
  { value: "nodes", label: "Nodes" },
  { value: "workspaces", label: "Workspaces" },
  { value: "diagnostics", label: "Diagnostics" },
];

type SettingsPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
  /** Read only to learn which models this fleet's Copilot offers. */
  sessions: FleetSession[];
  hostRevision: string;
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
  const active = props.active ?? true;
  const [internalTab, setInternalTab] = useState<SettingsTab>("general");
  const [visitedTabs, setVisitedTabs] = useState<SettingsTab[]>([]);
  const tab = props.selectedTab ?? internalTab;
  // Retain only visited sections, including when navigation selects a tab externally.
  if (active && !visitedTabs.includes(tab)) {
    setVisitedTabs([...visitedTabs, tab]);
  }
  const setTab = (next: SettingsTab) => {
    setInternalTab(next);
    props.onSelectedTabChange?.(next);
  };

  const panels: Record<SettingsTab, ReactNode> = {
    general: <GeneralPanel sessions={props.sessions} onStartTour={props.onStartTour} />,
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
      <div className={styles.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_event, data) => setTab(data.value as SettingsTab)}
          aria-label="Settings sections"
        >
          {sections.map(({ value, label }) => (
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
      <div className={styles.body}>
        {visitedTabs.map((value) => (
          <div
            key={value}
            id={`${id}-${value}-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-${value}-tab`}
            className={styles.body}
            hidden={!active || tab !== value}
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
