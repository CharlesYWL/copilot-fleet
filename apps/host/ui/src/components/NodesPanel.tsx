import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowSync20Regular,
  Checkmark20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Rename20Regular,
} from "@fluentui/react-icons";
import {
  nodeUpdateState,
  type FleetNode,
  type FleetSession,
  type NodeUpdateStage,
  type NodeUpdateState,
} from "@fleet/protocol";
import { useCatalog } from "../hooks/useCatalog";
import type { NodeUpdateProgress } from "../hooks/useFleet";
import { sessionLabel } from "../lib/session-label";
import { ConnectNodeCard } from "./ConnectNodeCard";
import { StatusDot } from "./StatusDot";

const useStyles = makeStyles({
  dialogBody: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  sessionList: {
    margin: 0,
    paddingLeft: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
  },
  head: {
    marginBottom: "20px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  surface: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflowX: "auto",
    background: tokens.colorNeutralBackground1,
  },
  table: {
    tableLayout: "fixed",
    width: "100%",
    minWidth: "720px",
  },
  statusCell: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "12px",
  },
  nameText: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  nameEdit: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  },
  nameInput: {
    minWidth: 0,
    flexGrow: 1,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "2px",
    flexShrink: 0,
  },
  colStatus: { width: "110px" },
  colName: { width: "20%" },
  colPlatform: { width: "14%" },
  colCapacity: { width: "90px" },
  colVersion: { width: "170px" },
  colSeen: { width: "16%" },
  colActions: { width: "128px" },
  versionCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "2px",
  },
  updateAll: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    margin: "0 0 16px",
    padding: "10px 14px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
  },
});

type NodesPanelProps = {
  nodes: FleetNode[];
  hostRevision: string;
  nodeUpdates: NodeUpdateProgress;
};

/** What the Version cell says, and whether its Update button does anything. */
const updateLabels: Record<NodeUpdateState, { text: string; hint: string }> = {
  current: { text: "Up to date", hint: "Running the same commit as the Host" },
  stale: { text: "Update available", hint: "Behind the Host's commit" },
  unknown: {
    text: "Unknown",
    hint: "Not a git checkout on the Host or the Node, so there is nothing to compare",
  },
  unsupported: {
    text: "Manual update",
    hint: "This build predates remote updates; update it by hand once to enable them",
  },
};

const stageLabels: Record<NodeUpdateStage, string> = {
  checking: "Checking…",
  pulling: "Pulling…",
  installing: "Installing…",
  building: "Building…",
  restarting: "Restarting…",
  up_to_date: "Already up to date",
  failed: "Update failed",
};

/** Stages during which the Node is still working, so the row shows a spinner. */
const busyStages = new Set<NodeUpdateStage>([
  "checking",
  "pulling",
  "installing",
  "building",
  "restarting",
]);

export const NodesPanel = ({ nodes, hostRevision, nodeUpdates }: NodesPanelProps) => {
  const styles = useStyles();
  const { renameNode, deleteNode, updateNode, updateAllNodes } = useCatalog();
  /** The node whose update is waiting on a decision about its live sessions. */
  const [blocked, setBlocked] = useState<{
    node: FleetNode;
    sessions: FleetSession[];
  }>();
  const [stopping, setStopping] = useState(false);
  const stale = nodes.filter((node) => nodeUpdateState(node, hostRevision) === "stale");

  const startUpdate = async (node: FleetNode) => {
    const refusal = await updateNode(node.id);
    // Only a refusal that names sessions is worth asking about; anything else
    // has already been reported.
    if (refusal && refusal.blockedBy.length > 0) {
      setBlocked({ node, sessions: refusal.blockedBy });
    }
  };

  const stopAndUpdate = async () => {
    if (!blocked) return;
    setStopping(true);
    const refusal = await updateNode(blocked.node.id, { stopSessions: true });
    setStopping(false);
    if (!refusal) setBlocked(undefined);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Title3 as="h1">Nodes</Title3>
        <br />
        <Text className={styles.caption}>
          Connected machines and available session capacity.
          {hostRevision ? ` Host is on ${hostRevision}.` : ""}
        </Text>
      </div>
      <ConnectNodeCard />
      {stale.length > 0 && (
        <div className={styles.updateAll}>
          <Text>
            {stale.length} node{stale.length === 1 ? " is" : "s are"} behind the Host.
          </Text>
          <Button
            appearance="primary"
            size="small"
            icon={<ArrowSync20Regular />}
            onClick={() => void updateAllNodes()}
          >
            Update all
          </Button>
        </div>
      )}
      <div className={styles.surface}>
        <Table className={styles.table} aria-label="Registered nodes">
          <TableHeader>
            <TableRow>
              <TableHeaderCell className={styles.colStatus}>Status</TableHeaderCell>
              <TableHeaderCell className={styles.colName}>Name</TableHeaderCell>
              <TableHeaderCell className={styles.colPlatform}>Platform</TableHeaderCell>
              <TableHeaderCell className={styles.colCapacity}>Capacity</TableHeaderCell>
              <TableHeaderCell className={styles.colVersion}>Version</TableHeaderCell>
              <TableHeaderCell className={styles.colSeen}>Last seen</TableHeaderCell>
              <TableHeaderCell className={styles.colActions}>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                hostRevision={hostRevision}
                progress={nodeUpdates[node.id]}
                onRename={renameNode}
                onDelete={deleteNode}
                onUpdate={startUpdate}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={Boolean(blocked)}
        onOpenChange={(_event, data) => {
          if (!data.open) setBlocked(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              Stop {blocked?.sessions.length} session(s) to update?
            </DialogTitle>
            <DialogContent className={styles.dialogBody}>
              <Text>
                Updating {blocked?.node.name} restarts it, and the agents it is hosting
                stop with it. These sessions are running there now:
              </Text>
              <ul className={styles.sessionList}>
                {blocked?.sessions.map((session) => (
                  <li key={session.id}>
                    <Text weight="semibold">{sessionLabel(session)}</Text>
                    <Text className={styles.caption}>
                      {" "}
                      · {session.workspaceName} · {session.state}
                    </Text>
                  </li>
                ))}
              </ul>
              <Text className={styles.caption}>
                Each one keeps its transcript and can be resumed afterwards.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setBlocked(undefined)}
                disabled={stopping}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => void stopAndUpdate()}
                disabled={stopping}
              >
                {stopping ? "Stopping…" : "Stop and update"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
};

type NodeRowProps = {
  node: FleetNode;
  hostRevision: string;
  progress?: { stage: NodeUpdateStage; detail: string } | undefined;
  onRename: (nodeId: string, name: string) => Promise<boolean>;
  onDelete: (nodeId: string) => Promise<boolean>;
  onUpdate: (node: FleetNode) => Promise<void>;
};

const NodeRow = ({
  node,
  hostRevision,
  progress,
  onRename,
  onDelete,
  onUpdate,
}: NodeRowProps) => {
  const styles = useStyles();
  const [draft, setDraft] = useState<string>();
  const state = nodeUpdateState(node, hostRevision);
  const label = updateLabels[state];
  // A restart takes the socket with it, so the node goes offline mid-update;
  // treating that as "no longer busy" would flicker the spinner away and back.
  const busy = progress ? busyStages.has(progress.stage) : false;

  const handleCommit = async () => {
    if (draft === undefined) return;
    const name = draft.trim();
    if (name && name !== node.name && !(await onRename(node.id, name))) return;
    setDraft(undefined);
  };

  return (
    <TableRow>
      <TableCell className={styles.colStatus}>
        <span className={styles.statusCell}>
          <StatusDot state={node.online ? "running" : "offline"} />
          {node.online ? "Online" : "Offline"}
        </span>
      </TableCell>
      <TableCell className={styles.colName}>
        {draft === undefined ? (
          <Text weight="semibold" className={styles.nameText} title={node.name}>
            {node.name}
          </Text>
        ) : (
          <span className={styles.nameEdit}>
            <Input
              className={styles.nameInput}
              value={draft}
              size="small"
              autoFocus
              aria-label={`Rename ${node.name}`}
              onChange={(_event, data) => setDraft(data.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCommit();
                if (event.key === "Escape") setDraft(undefined);
              }}
            />
            <Button
              appearance="subtle"
              size="small"
              icon={<Checkmark20Regular />}
              aria-label="Save name"
              onClick={() => void handleCommit()}
            />
            <Button
              appearance="subtle"
              size="small"
              icon={<Dismiss20Regular />}
              aria-label="Cancel rename"
              onClick={() => setDraft(undefined)}
            />
          </span>
        )}
      </TableCell>
      <TableCell className={styles.colPlatform}>
        {node.os} / {node.arch}
      </TableCell>
      <TableCell className={styles.colCapacity}>
        {node.activeSessions} / {node.maxSessions}
      </TableCell>
      <TableCell className={styles.colVersion}>
        <span className={styles.versionCell} title={progress?.detail || label.hint}>
          <Badge
            appearance="tint"
            size="small"
            color={
              state === "current"
                ? "success"
                : state === "stale"
                  ? "warning"
                  : "informative"
            }
          >
            {progress && busy ? stageLabels[progress.stage] : label.text}
          </Badge>
          <Text className={styles.mono}>{node.revision || node.version}</Text>
        </span>
      </TableCell>
      <TableCell className={mergeClasses(styles.colSeen, styles.mono)}>
        {new Date(node.lastHeartbeat).toLocaleString()}
      </TableCell>
      <TableCell className={styles.colActions}>
        <span className={styles.actions}>
          {busy ? (
            <Spinner size="tiny" aria-label={`Updating ${node.name}`} />
          ) : (
            state === "stale" && (
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowSync20Regular />}
                aria-label={`Update ${node.name}`}
                title="Pull, rebuild and restart this node"
                onClick={() => void onUpdate(node)}
              />
            )
          )}
          {draft === undefined && (
            <Button
              appearance="subtle"
              size="small"
              icon={<Rename20Regular />}
              aria-label={`Rename ${node.name}`}
              title="Rename"
              onClick={() => setDraft(node.name)}
            />
          )}
          <Button
            appearance="subtle"
            size="small"
            icon={<Delete20Regular />}
            aria-label={`Delete ${node.name}`}
            title="Delete"
            onClick={() => {
              if (
                !window.confirm(
                  `Delete node "${node.name}"? Its placements and finished sessions will be removed.`,
                )
              ) {
                return;
              }
              void onDelete(node.id);
            }}
          />
        </span>
      </TableCell>
    </TableRow>
  );
};
