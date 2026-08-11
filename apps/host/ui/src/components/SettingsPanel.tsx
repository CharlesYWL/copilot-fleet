import { useState } from "react";
import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import type { FleetNode, Placement, Workspace } from "@fleet/protocol";
import type { NodeUpdateProgress } from "../hooks/useFleet";
import { NodesPanel } from "./NodesPanel";
import { GeneralPanel } from "./GeneralPanel";
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

type SettingsTab = "general" | "tunnel" | "nodes" | "workspaces";

type SettingsPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
  hostRevision: string;
  nodeUpdates: NodeUpdateProgress;
};

/**
 * The Settings screens read what they render from props and reach for their own
 * write operations through {@link useCatalog}, so this stays a tab strip rather
 * than a relay for a dozen callbacks it never calls itself.
 */
export const SettingsPanel = (props: SettingsPanelProps) => {
  const styles = useStyles();
  const [tab, setTab] = useState<SettingsTab>("general");

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
        </TabList>
      </div>
      <div className={styles.body}>
        {tab === "general" && <GeneralPanel />}
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
