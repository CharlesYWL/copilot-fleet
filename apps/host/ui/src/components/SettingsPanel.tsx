import { useState } from "react";
import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import type { FleetNode, Placement, Workspace } from "@fleet/protocol";
import { NodesPanel } from "./NodesPanel";
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

type SettingsTab = "tunnel" | "nodes" | "workspaces";

type SettingsPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
  onRenameNode: (nodeId: string, name: string) => Promise<boolean>;
  onDeleteNode: (nodeId: string) => Promise<boolean>;
  onCreateWorkspace: (name: string, description: string) => Promise<boolean>;
  onUpdateWorkspace: (
    workspaceId: string,
    name: string,
    description: string,
  ) => Promise<boolean>;
  onDeleteWorkspace: (workspaceId: string) => Promise<boolean>;
  onCreatePlacement: (
    workspaceId: string,
    nodeId: string,
    localPath: string,
  ) => Promise<boolean>;
  onUpdatePlacement: (placementId: string, localPath: string) => Promise<boolean>;
  onDeletePlacement: (placementId: string) => Promise<boolean>;
};

export const SettingsPanel = (props: SettingsPanelProps) => {
  const styles = useStyles();
  const [tab, setTab] = useState<SettingsTab>("tunnel");

  return (
    <div className={styles.root}>
      <div className={styles.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_event, data) => setTab(data.value as SettingsTab)}
          aria-label="Settings sections"
        >
          <Tab value="tunnel">Tunnel</Tab>
          <Tab value="nodes">Nodes</Tab>
          <Tab value="workspaces">Workspaces</Tab>
        </TabList>
      </div>
      <div className={styles.body}>
        {tab === "tunnel" && <TunnelPanel />}
        {tab === "nodes" && (
          <NodesPanel
            nodes={props.nodes}
            onRenameNode={props.onRenameNode}
            onDeleteNode={props.onDeleteNode}
          />
        )}
        {tab === "workspaces" && (
          <WorkspacesPanel
            workspaces={props.workspaces}
            placements={props.placements}
            nodes={props.nodes}
            onCreateWorkspace={props.onCreateWorkspace}
            onUpdateWorkspace={props.onUpdateWorkspace}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onCreatePlacement={props.onCreatePlacement}
            onUpdatePlacement={props.onUpdatePlacement}
            onDeletePlacement={props.onDeletePlacement}
          />
        )}
      </div>
    </div>
  );
};
