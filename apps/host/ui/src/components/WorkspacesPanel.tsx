import { useState, type FormEvent } from "react";
import {
  Button,
  Field,
  Input,
  Select,
  Text,
  Textarea,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { FleetNode, Placement, Workspace } from "@fleet/protocol";

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
  columns: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "16px",
    "@media (max-width: 1000px)": {
      gridTemplateColumns: "1fr",
    },
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "20px",
  },
  cardTitle: {
    display: "block",
    marginBottom: "14px",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  submit: {
    alignSelf: "flex-end",
  },
  list: {
    display: "grid",
    gap: "12px",
    marginTop: "20px",
  },
  workspaceCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "18px 20px",
    display: "flex",
    justifyContent: "space-between",
    gap: "24px",
    "@media (max-width: 1000px)": {
      flexDirection: "column",
    },
  },
  placements: {
    minWidth: "55%",
    display: "grid",
    gap: "6px",
    alignContent: "start",
  },
  placementRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    background: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px 11px",
    fontSize: "12px",
  },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    color: tokens.colorNeutralForeground2,
  },
});

type WorkspacesPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
  onCreateWorkspace: (name: string, description: string) => Promise<boolean>;
  onCreatePlacement: (
    workspaceId: string,
    nodeId: string,
    localPath: string,
  ) => Promise<boolean>;
};

export const WorkspacesPanel = ({
  workspaces,
  placements,
  nodes,
  onCreateWorkspace,
  onCreatePlacement,
}: WorkspacesPanelProps) => {
  const styles = useStyles();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [localPath, setLocalPath] = useState("");

  const handleCreateWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const created = await onCreateWorkspace(name.trim(), description.trim());
    if (!created) return;
    setName("");
    setDescription("");
  };

  const handleCreatePlacement = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !nodeId || !localPath.trim()) return;
    const created = await onCreatePlacement(workspaceId, nodeId, localPath.trim());
    if (!created) return;
    setLocalPath("");
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Title3 as="h1">Workspaces &amp; placements</Title3>
        <br />
        <Text className={styles.caption}>
          Map each logical project to its machine-local absolute path.
        </Text>
      </div>

      <div className={styles.columns}>
        <section className={styles.card}>
          <Text weight="semibold" className={styles.cardTitle}>
            Create workspace
          </Text>
          <form className={styles.form} onSubmit={handleCreateWorkspace}>
            <Field label="Name" required>
              <Input
                value={name}
                onChange={(_event, data) => setName(data.value)}
                placeholder="checkout-service"
              />
            </Field>
            <Field label="Description">
              <Textarea
                value={description}
                onChange={(_event, data) => setDescription(data.value)}
                resize="vertical"
              />
            </Field>
            <Button
              appearance="primary"
              type="submit"
              className={styles.submit}
              disabled={name.trim().length === 0}
            >
              Create
            </Button>
          </form>
        </section>

        <section className={styles.card}>
          <Text weight="semibold" className={styles.cardTitle}>
            Add placement
          </Text>
          <form className={styles.form} onSubmit={handleCreatePlacement}>
            <Field label="Workspace" required>
              <Select
                value={workspaceId}
                onChange={(_event, data) => setWorkspaceId(data.value)}
              >
                <option value="">Select a workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Node" required>
              <Select value={nodeId} onChange={(_event, data) => setNodeId(data.value)}>
                <option value="">Select a node</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Absolute local path" required>
              <Input
                value={localPath}
                onChange={(_event, data) => setLocalPath(data.value)}
                placeholder="C:\code\project or /srv/project"
              />
            </Field>
            <Button
              appearance="primary"
              type="submit"
              className={styles.submit}
              disabled={!workspaceId || !nodeId || localPath.trim().length === 0}
            >
              Add placement
            </Button>
          </form>
        </section>
      </div>

      <div className={styles.list}>
        {workspaces.map((workspace) => (
          <article className={styles.workspaceCard} key={workspace.id}>
            <div>
              <Text weight="semibold">{workspace.name}</Text>
              <br />
              <Text className={styles.caption}>
                {workspace.description || "No description"}
              </Text>
            </div>
            <div className={styles.placements}>
              {placements
                .filter((placement) => placement.workspaceId === workspace.id)
                .map((placement) => (
                  <div className={styles.placementRow} key={placement.id}>
                    <Text weight="semibold">{placement.nodeName}</Text>
                    <code className={styles.mono}>{placement.localPath}</code>
                  </div>
                ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};
