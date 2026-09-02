import { useState } from "react";
import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import type { NodeUpdateProgress } from "../hooks/useFleet";
import { NodesPanel } from "./NodesPanel";
import { GeneralPanel } from "./GeneralPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
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
  },
  tabs: {
    flexShrink: 0,
    padding: "12px 24px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: {
    flexGrow: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
});

export type SettingsTab = "general" | "tunnel" | "nodes" | "workspaces" | "diagnostics";

type SettingsPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
  /** Read only to learn which models this fleet's Copilot offers. */
  sessions: FleetSession[];
  hostRevision: string;
  nodeUpdates: NodeUpdateProgress;
  selectedTab?: SettingsTab;
  onSelectedTabChange?: (tab: SettingsTab) => void;
};

/**
 * The Settings screens read what they render from props and reach for their own
 * write operations through {@link useCatalog}, so this stays a tab strip rather
 * than a relay for a dozen callbacks it never calls itself.
 */
export const SettingsPanel = (props: SettingsPanelProps) => {
  const styles = useStyles();
  const [internalTab, setInternalTab] = useState<SettingsTab>("general");
  const tab = props.selectedTab ?? internalTab;
  const setTab = (next: SettingsTab) => {
    setInternalTab(next);
    props.onSelectedTabChange?.(next);
  };

  return (
    <div className={styles.root}>
      <div className={styles.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_event, data) => setTab(data.value as SettingsTab)}
          aria-label="Settings sections"
        >
          <Tab value="general">General</Tab>
          <Tab value="tunnel">Tunnel</Tab>
          <Tab value="nodes">Nodes</Tab>
          <Tab value="workspaces">Workspaces</Tab>
          <Tab value="diagnostics">Diagnostics</Tab>
        </TabList>
      </div>
      <div className={styles.body}>
        {tab === "general" && <GeneralPanel sessions={props.sessions} />}
        {tab === "diagnostics" && <DiagnosticsPanel />}
        {tab === "tunnel" && <TunnelPanel />}
        {tab === "nodes" && (
          <NodesPanel
            nodes={props.nodes}
            hostRevision={props.hostRevision}
            nodeUpdates={props.nodeUpdates}
          />
        )}
        {tab === "workspaces" && (
          <WorkspacesPanel
            workspaces={props.workspaces}
            placements={props.placements}
            nodes={props.nodes}
          />
        )}
      </div>
    </div>
  );
};
