import { useState } from "react";
import {
  Button,
  Input,
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
  Checkmark20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Rename20Regular,
} from "@fluentui/react-icons";
import type { FleetNode } from "@fleet/protocol";
import { ConnectNodeCard } from "./ConnectNodeCard";
import { StatusDot } from "./StatusDot";

const useStyles = makeStyles({
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
  colName: { width: "22%" },
  colPlatform: { width: "16%" },
  colCapacity: { width: "100px" },
  colVersion: { width: "80px" },
  colSeen: { width: "18%" },
  colActions: { width: "96px" },
});

type NodesPanelProps = {
  nodes: FleetNode[];
  onRenameNode: (nodeId: string, name: string) => Promise<boolean>;
  onDeleteNode: (nodeId: string) => Promise<boolean>;
};

export const NodesPanel = ({ nodes, onRenameNode, onDeleteNode }: NodesPanelProps) => {
  const styles = useStyles();
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Title3 as="h1">Nodes</Title3>
        <br />
        <Text className={styles.caption}>Connected machines and available session capacity.</Text>
      </div>
      <ConnectNodeCard />
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
                onRename={onRenameNode}
                onDelete={onDeleteNode}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

type NodeRowProps = {
  node: FleetNode;
  onRename: (nodeId: string, name: string) => Promise<boolean>;
  onDelete: (nodeId: string) => Promise<boolean>;
};

const NodeRow = ({ node, onRename, onDelete }: NodeRowProps) => {
  const styles = useStyles();
  const [draft, setDraft] = useState<string>();

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
      <TableCell className={styles.colVersion}>{node.version}</TableCell>
      <TableCell className={mergeClasses(styles.colSeen, styles.mono)}>
        {new Date(node.lastHeartbeat).toLocaleString()}
      </TableCell>
      <TableCell className={styles.colActions}>
        <span className={styles.actions}>
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
