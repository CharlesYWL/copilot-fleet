import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { FleetNode } from "@fleet/protocol";
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
    overflow: "hidden",
    background: tokens.colorNeutralBackground1,
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
});

export const NodesPanel = ({ nodes }: { nodes: FleetNode[] }) => {
  const styles = useStyles();
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Title3 as="h1">Nodes</Title3>
        <br />
        <Text className={styles.caption}>Connected machines and available session capacity.</Text>
      </div>
      <div className={styles.surface}>
        <Table aria-label="Registered nodes">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Platform</TableHeaderCell>
              <TableHeaderCell>Capacity</TableHeaderCell>
              <TableHeaderCell>Version</TableHeaderCell>
              <TableHeaderCell>Last seen</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((node) => (
              <TableRow key={node.id}>
                <TableCell>
                  <span className={styles.statusCell}>
                    <StatusDot state={node.online ? "running" : "offline"} />
                    {node.online ? "Online" : "Offline"}
                  </span>
                </TableCell>
                <TableCell>
                  <Text weight="semibold">{node.name}</Text>
                </TableCell>
                <TableCell>
                  {node.os} / {node.arch}
                </TableCell>
                <TableCell>
                  {node.activeSessions} / {node.maxSessions}
                </TableCell>
                <TableCell>{node.version}</TableCell>
                <TableCell className={styles.mono}>
                  {new Date(node.lastHeartbeat).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
