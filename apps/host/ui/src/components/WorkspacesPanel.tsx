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
import {
  Checkmark20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Rename20Regular,
} from "@fluentui/react-icons";
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
  workspaceMeta: {
    minWidth: "220px",
    display: "grid",
    gap: "8px",
    alignContent: "start",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: 0,
  },
  titleText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  editFields: {
    display: "grid",
    gap: "8px",
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
    alignItems: "center",
    gap: "12px",
    background: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px 11px",
    fontSize: "12px",
  },
  placementInfo: {
    display: "grid",
    gap: "2px",
    minWidth: 0,
    flexGrow: 1,
  },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    color: tokens.colorNeutralForeground2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    flexShrink: 0,
  },
  pathInput: {
    minWidth: "180px",
    width: "100%",
  },
});

type WorkspacesPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
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

export const WorkspacesPanel = ({
  workspaces,
  placements,
  nodes,
  onCreateWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onCreatePlacement,
  onUpdatePlacement,
  onDeletePlacement,
}: WorkspacesPanelProps) => {
  const styles = useStyles();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [localPath, setLocalPath] = useState("");

  const handleSelectNode = (nextNodeId: string) => {
    setNodeId(nextNodeId);
    const home = nodes.find((node) => node.id === nextNodeId)?.homeDir;
    if (home && localPath.trim().length === 0) setLocalPath(home);
  };

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
              <Select
                value={nodeId}
                onChange={(_event, data) => handleSelectNode(data.value)}
              >
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
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            placements={placements.filter(
              (placement) => placement.workspaceId === workspace.id,
            )}
            onUpdateWorkspace={onUpdateWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            onUpdatePlacement={onUpdatePlacement}
            onDeletePlacement={onDeletePlacement}
          />
        ))}
      </div>
    </div>
  );
};

type WorkspaceCardProps = {
  workspace: Workspace;
  placements: Placement[];
  onUpdateWorkspace: (
    workspaceId: string,
    name: string,
    description: string,
  ) => Promise<boolean>;
  onDeleteWorkspace: (workspaceId: string) => Promise<boolean>;
  onUpdatePlacement: (placementId: string, localPath: string) => Promise<boolean>;
  onDeletePlacement: (placementId: string) => Promise<boolean>;
};

const WorkspaceCard = ({
  workspace,
  placements,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onUpdatePlacement,
  onDeletePlacement,
}: WorkspaceCardProps) => {
  const styles = useStyles();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(workspace.name);
  const [draftDescription, setDraftDescription] = useState(workspace.description);

  const handleStartEdit = () => {
    setDraftName(workspace.name);
    setDraftDescription(workspace.description);
    setEditing(true);
  };

  const handleSave = async () => {
    const name = draftName.trim();
    if (!name) return;
    if (
      name === workspace.name &&
      draftDescription === workspace.description
    ) {
      setEditing(false);
      return;
    }
    if (await onUpdateWorkspace(workspace.id, name, draftDescription)) {
      setEditing(false);
    }
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete workspace "${workspace.name}"? Its placements and finished sessions will be removed.`,
      )
    ) {
      return;
    }
    void onDeleteWorkspace(workspace.id);
  };

  return (
    <article className={styles.workspaceCard}>
      <div className={styles.workspaceMeta}>
        {editing ? (
          <div className={styles.editFields}>
            <Input
              value={draftName}
              aria-label="Workspace name"
              onChange={(_event, data) => setDraftName(data.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSave();
                if (event.key === "Escape") setEditing(false);
              }}
            />
            <Textarea
              value={draftDescription}
              aria-label="Workspace description"
              resize="vertical"
              onChange={(_event, data) => setDraftDescription(data.value)}
            />
            <span className={styles.actions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<Checkmark20Regular />}
                aria-label="Save workspace"
                onClick={() => void handleSave()}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<Dismiss20Regular />}
                aria-label="Cancel edit"
                onClick={() => setEditing(false)}
              />
            </span>
          </div>
        ) : (
          <>
            <span className={styles.titleRow}>
              <Text weight="semibold" className={styles.titleText}>
                {workspace.name}
              </Text>
              <Button
                appearance="subtle"
                size="small"
                icon={<Rename20Regular />}
                aria-label="Edit workspace"
                title="Edit workspace"
                onClick={handleStartEdit}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<Delete20Regular />}
                aria-label="Delete workspace"
                title="Delete workspace"
                onClick={handleDelete}
              />
            </span>
            <Text className={styles.caption}>
              {workspace.description || "No description"}
            </Text>
          </>
        )}
      </div>
      <div className={styles.placements}>
        {placements.length === 0 ? (
          <Text className={styles.caption}>No placements yet</Text>
        ) : (
          placements.map((placement) => (
            <PlacementRow
              key={placement.id}
              placement={placement}
              onUpdate={onUpdatePlacement}
              onDelete={onDeletePlacement}
            />
          ))
        )}
      </div>
    </article>
  );
};

type PlacementRowProps = {
  placement: Placement;
  onUpdate: (placementId: string, localPath: string) => Promise<boolean>;
  onDelete: (placementId: string) => Promise<boolean>;
};

const PlacementRow = ({ placement, onUpdate, onDelete }: PlacementRowProps) => {
  const styles = useStyles();
  const [draft, setDraft] = useState<string>();

  if (draft === undefined) {
    return (
      <div className={styles.placementRow}>
        <div className={styles.placementInfo}>
          <Text weight="semibold">{placement.nodeName}</Text>
          <code className={styles.mono}>{placement.localPath}</code>
        </div>
        <span className={styles.actions}>
          <Button
            appearance="subtle"
            size="small"
            icon={<Rename20Regular />}
            aria-label="Edit path"
            title="Edit path"
            onClick={() => setDraft(placement.localPath)}
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<Delete20Regular />}
            aria-label="Delete placement"
            title="Delete placement"
            onClick={() => {
              if (
                !window.confirm(
                  `Remove placement on ${placement.nodeName}? Finished sessions for it will be deleted.`,
                )
              ) {
                return;
              }
              void onDelete(placement.id);
            }}
          />
        </span>
      </div>
    );
  }

  const commit = async () => {
    const localPath = draft.trim();
    if (!localPath) return;
    if (localPath !== placement.localPath && !(await onUpdate(placement.id, localPath))) {
      return;
    }
    setDraft(undefined);
  };

  return (
    <div className={styles.placementRow}>
      <div className={styles.placementInfo}>
        <Text weight="semibold">{placement.nodeName}</Text>
        <Input
          className={styles.pathInput}
          size="small"
          value={draft}
          autoFocus
          aria-label={`Path for ${placement.nodeName}`}
          onChange={(_event, data) => setDraft(data.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            if (event.key === "Escape") setDraft(undefined);
          }}
        />
      </div>
      <span className={styles.actions}>
        <Button
          appearance="subtle"
          size="small"
          icon={<Checkmark20Regular />}
          aria-label="Save path"
          onClick={() => void commit()}
        />
        <Button
          appearance="subtle"
          size="small"
          icon={<Dismiss20Regular />}
          aria-label="Cancel path edit"
          onClick={() => setDraft(undefined)}
        />
      </span>
    </div>
  );
};
